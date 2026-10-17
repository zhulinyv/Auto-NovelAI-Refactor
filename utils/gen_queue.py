"""生图队列: 仅用于 NovelAI API 生成相关操作的调度。

设计 (与需求确认一致):
- 单一 FIFO 队列, 所有 NovelAI 生成类操作 (主生图 / 导演工具 / 插件生图) 都提交到这里
- 每配置一个有效 Token 即开启一个执行通道 (worker): N 个 Token 可同时执行 N 个生图任务
- 任意通道空闲即领取队首任务; 多个空闲通道可用时优先分配给编号最小的通道 (即优先使用第一个 Token, 依次类推); 任务完成后该通道独立冷却 cool_time 秒, 冷却结束再取下一个任务
- 排队中的任务可取消 / 调整顺序; 运行中的任务通过独立停止信号文件中断 (见 utils.helpers.check_stop)
- 通道状态与队列快照通过 queue:update 事件实时推送给前端 (SSE)
- 非 NovelAI 任务 (超分/本地处理等) 不进队列, 由 JobManager 以多线程方式并行执行
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from typing import Any, Callable

from utils.config import env
from utils.events import broker
from utils.jobs import cleanup_break_file, normalize_result, pop_current_job, set_current_job, write_break_flag
from utils.logger import logger
from utils.tokens import get_tokens, mask_token, pop_thread_token, set_thread_token
from utils.usage import tokens_with_no_usage


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


class _Task:
    """队列任务。"""

    __slots__ = (
        "id",
        "name",
        "label",
        "fn",
        "args",
        "kwargs",
        "status",
        "created_at",
        "started_at",
        "finished_at",
        "worker",
        "error",
        "model",
    )

    def __init__(self, name: str, fn: Callable, args: tuple, kwargs: dict, label: str | None, model: str | None = None):
        self.id = _new_id()
        self.name = name
        self.label = label or name
        self.fn = fn
        self.args = args
        self.kwargs = kwargs
        self.status = "pending"  # pending | running | done | failed | cancelled
        self.created_at = time.time()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.worker: int | None = None
        self.error: str | None = None
        # 模型 id (仅图片生成任务提供): NAI5 + 无用量跳过规则需要按模型过滤通道
        self.model = model


class _Worker(threading.Thread):
    """执行通道: 绑定一个 Token, 循环领取队列任务, 任务完成后独立冷却。"""

    def __init__(self, queue: "GenerationQueue", idx: int):
        super().__init__(daemon=True, name=f"genq-worker-{idx}")
        self.queue = queue
        self.idx = idx
        self.stop_flag = threading.Event()
        self.status = "idle"  # idle | running | cooling
        self.task_id: str | None = None
        self.cool_left = 0.0

    def run(self) -> None:
        while not self.stop_flag.is_set():
            task = self.queue._take_next(self)
            if task is None:
                if self.stop_flag.is_set():
                    break
                self.status = "idle"
                # 先 clear 再 wait: 若在 wait() 返回与 clear() 之间有人 submit(),
                # 旧的 "wait 后 clear" 写法会把那次唤醒信号吞掉, 该任务最多白等 0.5s。
                self.queue._wake.clear()
                self.queue._wake.wait(0.5)
                continue
            self._run_task(task)
            self._cooldown()

        # 通道退出 (Token 数减少): 清理注册信息
        with self.queue._lock:
            if self.queue._workers.get(self.idx) is self:
                self.queue._workers.pop(self.idx, None)
        self.queue._publish()

    def _run_task(self, task: _Task) -> None:
        self.status = "running"
        self.task_id = task.id
        tokens = get_tokens()
        set_thread_token(tokens[self.idx] if self.idx < len(tokens) else None)
        set_current_job(task.id, task.name)
        broker.publish("job:start", {"id": task.id, "name": task.name})
        self.queue._publish()
        try:
            result = task.fn(*task.args, **task.kwargs)
            payload = normalize_result(result)
            task.status = "done"
            broker.publish("job:done", {"id": task.id, "name": task.name, "ok": True, **payload})
        except Exception as e:
            task.status = "failed"
            task.error = str(e) or e.__class__.__name__
            logger.error(f"队列任务 [{task.label}] 执行失败: {e}")
            logger.opt(exception=True).debug("队列任务失败堆栈:")
            broker.publish("job:failed", {"id": task.id, "name": task.name, "ok": False, "error": task.error})
        finally:
            task.finished_at = time.time()
            pop_current_job()
            pop_thread_token()
            with self.queue._lock:
                self.queue._running.pop(task.id, None)
                self.queue._history.append(task)
                self.queue._tasks.pop(task.id, None)
            self.task_id = None
            cleanup_break_file(task.id)
            # 不再在这里 sweep_break_files(): 它是全目录 glob + 逐文件 stat, 而 N 个通道同时
            # 收尾就会并发扫 N 次; 孤儿信号文件由 utils.jobs 的 60s 定时清理线程统一负责。
            self.queue._publish()

    def _cooldown(self) -> None:
        """任务完成后的通道独立冷却 (可被通道停止打断)。"""
        if self.stop_flag.is_set():
            return
        try:
            seconds = float(env.cool_time)
        except Exception:
            seconds = 3
        if seconds <= 0:
            return
        self.status = "cooling"
        deadline = time.time() + max(0.0, seconds)
        last_publish = 0.0
        while time.time() < deadline and not self.stop_flag.is_set():
            self.cool_left = deadline - time.time()
            if time.time() - last_publish >= 1.0:
                self.queue._publish()
                last_publish = time.time()
            time.sleep(0.2)
        self.cool_left = 0.0
        self.status = "idle"
        self.queue._publish()


class GenerationQueue:
    """NovelAI 生图任务队列 (全局单例 gen_queue)。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._tasks: dict[str, _Task] = {}  # pending + running
        self._order: list[str] = []  # pending 顺序 (FIFO, 可调整)
        self._running: dict[str, _Task] = {}
        self._history: deque[_Task] = deque(maxlen=30)
        self._workers: dict[int, _Worker] = {}
        self._wake = threading.Event()
        self.ensure_workers()

    # ---------------------------------------------------------------- 提交

    def submit(
        self, name: str, fn: Callable, *args, label: str | None = None, model: str | None = None, **kwargs
    ) -> _Task | None:
        """把生成任务加入队列, 返回任务对象 (model 仅供 NAI5 无用量跳过规则使用)。

        启用 "用量为空时跳过 nai5 任务" 时: NAI5 任务在全部 Token 剩余用量 <= 0 的情况下
        不入队, 直接返回 None (调用方负责提示)。
        """
        if model and env.skip_nai5_no_usage and str(model).startswith("nai-diffusion-5"):
            from utils.usage import has_usable_token

            if get_tokens() and not has_usable_token():
                logger.warning(f"全部 Token 剩余用量已为空, 已跳过 NAI5 任务: [{label or name}]")
                return None
        task = _Task(name, fn, args, kwargs, label, model=model)
        with self._lock:
            self._tasks[task.id] = task
            self._order.append(task.id)
            pending = len(self._order)
        logger.info(f"任务已加入生图队列: [{task.label}] (排队 {pending} 个)")
        self._publish()
        self._wake.set()
        return task

    def running_ids(self) -> list[str]:
        """当前运行中的任务 id (停止信号文件清理时用来判断哪些还在用)。"""
        with self._lock:
            return list(self._running.keys())

    def position(self, task_id: str) -> int:
        """任务在排队序列中的位置 (1 开始; 不在队列返回 0)。"""
        with self._lock:
            try:
                return self._order.index(task_id) + 1
            except ValueError:
                return 0

    # ---------------------------------------------------------------- 通道管理

    def desired_workers(self) -> int:
        """期望通道数 = 有效 Token 数 (至少 1)。"""
        return max(1, len(get_tokens()))

    def ensure_workers(self) -> None:
        """按当前 Token 数补齐执行通道。"""
        with self._lock:
            desired = self.desired_workers()
            for i in range(desired):
                w = self._workers.get(i)
                if w is None or not w.is_alive():
                    w = _Worker(self, i)
                    self._workers[i] = w
                    w.start()
        self._wake.set()

    def reload(self) -> None:
        """Token 配置变化后重建通道 (多余的通道会在当前任务结束后退出)。"""
        self.ensure_workers()
        self._publish()

    def _take_next(self, worker: _Worker) -> _Task | None:
        """通道领取任务 (FIFO); 通道号超出期望数量时通知其退出。

        - 普通任务: 保持原优先级策略, 存在编号更小的空闲通道时让位
        - NAI5 任务 + 启用 "用量为空时跳过 nai5 任务": 剩余用量 <= 0 的 Token 通道
          不可领取 (即使空闲); 任务按序交给第一个有剩余用量的 Token 通道
          (该通道忙碌时任务在队列中等待); 全部 Token 无用量时跳过该任务并提示
        """
        with self._lock:
            desired = self.desired_workers()
            if worker.idx >= desired:
                worker.stop_flag.set()
                return None
            running_idx = {t.worker for t in self._running.values()}
            # 循环外算一次: 原先在逐任务扫描里反复调 get_tokens() / tokens_with_no_usage() /
            # _has_smaller_idle_worker (后者还会每次排序 worker 表), 这些都与具体任务无关。
            tokens = get_tokens()
            empty = set(tokens_with_no_usage()) if tokens else set()
            pos = 0
            while pos < len(self._order):
                tid = self._order[pos]
                task = self._tasks.get(tid)
                if task is None or task.status != "pending":
                    pos += 1
                    continue
                if self._is_nai5_restricted(task) and tokens:
                    eligible = next((i for i, tk in enumerate(tokens) if i < desired and tk not in empty), -1)
                    if eligible < 0:
                        # 全部 Token 无用量: 跳过该任务并提示 (日志 + WebUI 右上角通知)
                        self._order.pop(pos)
                        self._tasks.pop(tid, None)
                        task.status = "cancelled"
                        task.finished_at = time.time()
                        task.error = "全部 Token 剩余用量已为空, 已跳过该 NAI5 任务"
                        self._history.append(task)
                        logger.warning(f"全部 Token 剩余用量已为空, 已跳过 NAI5 任务: [{task.label}]")
                        try:
                            broker.publish(
                                "notice",
                                {
                                    "level": "warning",
                                    "message": f"🪫 全部 Token 剩余用量已为空, 已跳过 NAI5 任务: [{task.label}]",
                                },
                            )
                        except Exception:
                            logger.opt(exception=True).debug("推送队列通知失败堆栈:")
                        self._publish()
                        continue  # 不前进 pos, 继续看下一个任务
                    if worker.idx != eligible:
                        pos += 1
                        continue  # 本通道绑定的 Token 无用量 / 不是首个有用量通道: 不可领取该任务
                elif self._has_smaller_idle_worker(worker.idx, running_idx, desired):
                    # 普通任务让位: 存在编号更小的空闲通道, 任务优先分配给靠前的 Token
                    return None
                # 领取该任务
                self._order.pop(pos)
                task.status = "running"
                task.started_at = time.time()
                task.worker = worker.idx
                self._running[tid] = task
                return task
        return None

    @staticmethod
    def _is_nai5_restricted(task: _Task) -> bool:
        """NAI5 任务且启用 "用量为空时跳过 nai5 任务"。"""
        return bool(env.skip_nai5_no_usage) and str(task.model or "").startswith("nai-diffusion-5")

    def _has_smaller_idle_worker(self, idx: int, running_idx: set, desired: int | None = None) -> bool:
        """是否存在编号更小、可正常领取任务的空闲通道。

        desired 由调用方传入时不再重算 (dispatch 热路径, 见 _take_next)。
        """
        if desired is None:
            desired = self.desired_workers()
        for i in sorted(self._workers):
            if i >= idx:
                break
            w = self._workers[i]
            if not w.is_alive() or w.stop_flag.is_set() or i >= desired:
                continue
            if w.status == "idle" and i not in running_idx:
                return True
        return False

    # ---------------------------------------------------------------- 取消 / 停止 / 排序

    def cancel(self, task_id: str) -> bool:
        """取消排队中的任务。"""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status != "pending":
                return False
            self._cancel_pending_locked(task)
            label = task.label
        logger.info(f"已取消排队任务: [{label}]")
        self._publish()
        return True

    def stop(self, task_id: str) -> bool:
        """请求停止某个任务 (运行中写停止信号; 还在排队则直接取消)。"""
        cancelled_label = None
        with self._lock:
            task = self._running.get(task_id)
            if task is not None:
                label = task.label
            else:
                # 排队中被点了停止: 直接取消, 否则通道领走时它照样开跑
                pending = self._tasks.get(task_id)
                if pending is None or pending.status != "pending":
                    return False
                self._cancel_pending_locked(pending)
                cancelled_label = pending.label
        if cancelled_label is not None:
            logger.info(f"已取消排队任务: [{cancelled_label}]")
            self._publish()
            return True
        write_break_flag(True, task_id)
        logger.warning(f"已向运行中任务发送停止信号: [{label}]")
        return True

    def _match(self, pred) -> tuple[list[_Task], list[_Task]]:
        """按条件挑出 (运行中的, 排队中的) 任务 —— 停止类操作两侧都要覆盖。

        只停"运行中"会留下一个很难察觉的空档: 上一轮任务刚结束、下一轮任务已经排进队列
        但通道还在冷却 (或被唤醒到一半), 这时点停止, 下一个任务照样开跑, 用户看到的就是
        "点了停止还在一直生成"。排队中的任务此时还没开跑, 直接取消即可, 不占用冷却。
        """
        with self._lock:
            running = [t for t in self._running.values() if pred(t)]
            pending = [t for t in self._tasks.values() if t.status == "pending" and pred(t)]
        return running, pending

    def _cancel_pending_locked(self, task: _Task) -> None:
        """把排队中的任务标记为已取消 (调用方需持有 _lock)。"""
        task.status = "cancelled"
        task.finished_at = time.time()
        if task.id in self._order:
            self._order.remove(task.id)
        self._tasks.pop(task.id, None)
        self._history.append(task)

    def _stop_matched(self, pred, desc: str) -> int:
        """向匹配的运行中任务写停止信号, 并取消匹配的排队任务; 返回处理的任务数。"""
        running, pending = self._match(pred)
        for t in running:
            write_break_flag(True, t.id)
        if pending:
            with self._lock:
                for t in pending:
                    if self._tasks.get(t.id) is t and t.status == "pending":  # 期间可能已被领走
                        self._cancel_pending_locked(t)
        total = len(running) + len(pending)
        if total:
            parts = []
            if running:
                parts.append(f"{len(running)} 个运行中")
            if pending:
                parts.append(f"{len(pending)} 个排队中")
            logger.warning(f"已停止 {total} 个 [{desc}] 任务 ({' / '.join(parts)})")
            if pending:
                self._publish()
        return total

    def stop_by_name(self, name: str) -> int:
        """停止所有指定名称的任务 (运行中写停止信号, 排队中直接取消)。"""
        return self._stop_matched(lambda t: t.name == name, name)

    def stop_by_prefix(self, prefix: str) -> int:
        """停止所有名称以 prefix 开头的任务 (如 '导演工具:')。"""
        return self._stop_matched(lambda t: t.name.startswith(prefix), f"{prefix}*")

    def stop_all_running(self) -> int:
        """停止全部队列任务: 运行中写停止信号, 排队中直接取消。"""
        return self._stop_matched(lambda t: True, "全部")

    def reorder(self, task_id: str, direction: str) -> bool:
        """调整排队任务顺序: up / down / top / bottom。"""
        with self._lock:
            if task_id not in self._order:
                return False
            i = self._order.index(task_id)
            last = len(self._order) - 1
            if direction == "up":
                j = max(0, i - 1)
            elif direction == "down":
                j = min(last, i + 1)
            elif direction == "top":
                j = 0
            elif direction == "bottom":
                j = last
            else:
                return False
            if i == j:
                return True
            self._order.insert(j, self._order.pop(i))
        self._publish()
        return True

    def clear_pending(self) -> int:
        """清空全部排队任务 (不影响运行中任务)。"""
        with self._lock:
            ids = list(self._order)
            for tid in ids:
                task = self._tasks.pop(tid, None)
                if task:
                    task.status = "cancelled"
                    task.finished_at = time.time()
                    self._history.append(task)
            self._order.clear()
        if ids:
            logger.info(f"已清空排队任务 (共 {len(ids)} 个)")
        self._publish()
        return len(ids)

    # ---------------------------------------------------------------- 状态快照

    def _task_info(self, t: _Task, now: float) -> dict[str, Any]:
        return {
            "id": t.id,
            "name": t.name,
            "label": t.label,
            "status": t.status,
            "worker": t.worker,
            "error": t.error,
            "created_at": t.created_at,
            "started_at": t.started_at,
            "finished_at": t.finished_at,
            "waited": round(now - t.created_at, 1) if t.status == "pending" else None,
        }

    def snapshot(self) -> dict[str, Any]:
        """当前队列快照 (通道状态 + 排队/运行任务 + 最近历史)。"""
        now = time.time()
        with self._lock:
            tokens = get_tokens()
            workers = []
            for i in sorted(self._workers):
                w = self._workers[i]
                workers.append(
                    {
                        "index": i,
                        "token": mask_token(tokens[i]) if i < len(tokens) else None,
                        "status": w.status,
                        "task_id": w.task_id,
                        "cooldown_left": round(w.cool_left, 1) if w.status == "cooling" else 0,
                    }
                )
            tasks = [
                self._task_info(self._tasks[tid], now)
                for tid in list(self._running) + list(self._order)
                if tid in self._tasks
            ]
            history = [self._task_info(t, now) for t in reversed(self._history)]
        return {
            "workers": workers,
            "tasks": tasks,
            "history": history[:10],
            "worker_count": self.desired_workers(),
            "token_count": len(tokens),
        }

    def _publish(self) -> None:
        """推送队列快照到前端 (queue:update 事件)。"""
        try:
            broker.publish("queue:update", {"queue": self.snapshot()})
        except Exception as e:
            logger.debug(f"推送队列状态失败: {e}")
            logger.opt(exception=True).debug("推送队列状态失败堆栈:")


gen_queue = GenerationQueue()
