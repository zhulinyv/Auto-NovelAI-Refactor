"""生图队列: 仅用于 NovelAI API 生成相关操作的调度。

设计 (与需求确认一致):
- 单一 FIFO 队列, 所有 NovelAI 生成类操作 (主生图 / 导演工具 / 插件生图) 都提交到这里
- 每配置一个有效 Token 即开启一个执行通道 (worker): N 个 Token 可同时执行 N 个生图任务
- 任意通道空闲即领取队首任务; 任务完成后该通道独立冷却 cool_time 秒, 冷却结束再取下一个任务
- 排队中的任务可取消 / 调整顺序; 运行中的任务通过独立停止信号文件中断
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
    )

    def __init__(self, name: str, fn: Callable, args: tuple, kwargs: dict, label: str | None):
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
                self.queue._wake.wait(0.5)
                self.queue._wake.clear()
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
        set_current_job(task.id)
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

    def submit(self, name: str, fn: Callable, *args, label: str | None = None, **kwargs) -> _Task:
        """把生成任务加入队列, 返回任务对象。"""
        task = _Task(name, fn, args, kwargs, label)
        with self._lock:
            self._tasks[task.id] = task
            self._order.append(task.id)
            pending = len(self._order)
        logger.info(f"任务已加入生图队列: [{task.label}] (排队 {pending} 个)")
        self._publish()
        self._wake.set()
        return task

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
        """通道领取队首任务 (FIFO); 通道号超出期望数量时通知其退出。"""
        with self._lock:
            if worker.idx >= self.desired_workers():
                worker.stop_flag.set()
                return None
            while self._order:
                tid = self._order.pop(0)
                task = self._tasks.get(tid)
                if task and task.status == "pending":
                    task.status = "running"
                    task.started_at = time.time()
                    task.worker = worker.idx
                    self._running[tid] = task
                    return task
        return None

    # ---------------------------------------------------------------- 取消 / 停止 / 排序

    def cancel(self, task_id: str) -> bool:
        """取消排队中的任务。"""
        with self._lock:
            task = self._tasks.get(task_id)
            if not task or task.status != "pending":
                return False
            task.status = "cancelled"
            task.finished_at = time.time()
            if task_id in self._order:
                self._order.remove(task_id)
            self._tasks.pop(task_id, None)
            self._history.append(task)
            label = task.label
        logger.info(f"已取消排队任务: [{label}]")
        self._publish()
        return True

    def stop(self, task_id: str) -> bool:
        """请求停止运行中的任务 (写入该任务独立的停止信号文件)。"""
        with self._lock:
            task = self._running.get(task_id)
            if not task:
                return False
            label = task.label
        write_break_flag(True, task_id)
        logger.warning(f"已向运行中任务发送停止信号: [{label}]")
        return True

    def stop_by_name(self, name: str) -> int:
        """停止所有指定名称的运行中任务 (如 '图片生成')。"""
        with self._lock:
            tasks = [t for t in self._running.values() if t.name == name]
        for t in tasks:
            write_break_flag(True, t.id)
        if tasks:
            logger.warning(f"已向 {len(tasks)} 个 [{name}] 任务发送停止信号")
        return len(tasks)

    def stop_by_prefix(self, prefix: str) -> int:
        """停止所有名称以 prefix 开头的运行中任务 (如 '导演工具:')。"""
        with self._lock:
            tasks = [t for t in self._running.values() if t.name.startswith(prefix)]
        for t in tasks:
            write_break_flag(True, t.id)
        if tasks:
            logger.warning(f"已向 {len(tasks)} 个 [{prefix}*] 任务发送停止信号")
        return len(tasks)

    def stop_all_running(self) -> int:
        """停止全部运行中的队列任务。"""
        with self._lock:
            tasks = list(self._running.values())
        for t in tasks:
            write_break_flag(True, t.id)
        if tasks:
            logger.warning(f"已向 {len(tasks)} 个运行中队列任务发送停止信号")
        return len(tasks)

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


gen_queue = GenerationQueue()
