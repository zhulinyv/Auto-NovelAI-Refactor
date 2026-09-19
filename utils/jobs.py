"""后台任务管理: 任务状态推送 + 线程级任务注册表。

- single_job: 装饰器, 保证同一时间只有一个长任务在运行 (兼容保留, 生图类任务已改走队列)
- JobManager: 在后台线程中执行"非 NovelAI"任务 (超分/本地处理等), 并推送 job:start / job:done / job:failed
- 当前任务注册表: 线程 -> 任务 id 映射, 供停止信号 (check_stop) 与实时事件定位当前任务;
  JobManager 与生图队列 (utils.gen_queue) 共用该注册表
- 停止信号文件 (outputs/temp_break_<任务id>.json) 的清理: 任务收尾时删自己的文件,
  另由 sweep_break_files / start_break_cleanup 兜住"进程被杀来不及收尾"留下的孤儿文件
"""

from __future__ import annotations

import atexit
import glob
import os
import threading
import time
import uuid
from functools import wraps
from typing import Any, Callable

from utils.errors import JobAlreadyRunningError
from utils.events import broker
from utils.logger import logger

_job_lock = threading.Lock()

# 停止信号文件 (temp_break_<任务id>.json) 的落盘位置与清理节奏
OUTPUTS_DIR = "./outputs"
BREAK_FILE_PREFIX = "temp_break_"
BREAK_FILE_SUFFIX = ".json"
JANITOR_INTERVAL = 60.0

# 当前线程正在执行的任务 id (用于停止信号定位与任务内推送自定义事件)
_current_job: dict[int, str] = {}
# 任务 id -> 完整任务名 (job:event 实时事件附带, 供前端刷新/切换页面后重建预览容器)
_job_names: dict[str, str] = {}


def set_current_job(job_id: str, name: str = "") -> None:
    """在当前线程注册任务 id (任务开始时调用)。"""
    _current_job[threading.get_ident()] = job_id
    if name:
        _job_names[job_id] = name


def pop_current_job() -> None:
    """移除当前线程的任务注册 (任务结束时调用)。"""
    jid = _current_job.pop(threading.get_ident(), None)
    if jid:
        _job_names.pop(jid, None)


def current_job_id() -> str | None:
    """当前线程正在执行的任务 id (不在任务线程内时返回 None)。"""
    return _current_job.get(threading.get_ident())


def current_job_name() -> str:
    """当前线程正在执行任务的完整名称 (用于 job:event 附带插件定位信息)。"""
    jid = current_job_id()
    return _job_names.get(jid, "") if jid else ""


def break_file_path(job_id: str | None = None) -> str:
    """任务的停止信号文件路径: 每个任务独立, 互不干扰。"""
    jid = job_id or current_job_id()
    if jid:
        return f"{OUTPUTS_DIR}/temp_break_{jid}.json"
    return f"{OUTPUTS_DIR}/temp_break.json"


def write_break_flag(flag: bool, job_id: str | None = None) -> None:
    """写入停止信号文件 (带写入者 pid, 供清理时判断"是否还有进程在用")。"""
    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    import ujson as json

    with open(break_file_path(job_id), "w", encoding="utf-8") as f:
        json.dump({"break": flag, "pid": os.getpid()}, f)


def cleanup_break_file(job_id: str | None = None) -> None:
    """任务结束后清理其停止信号文件。"""
    jid = job_id or current_job_id()
    if not jid:
        return
    try:
        os.remove(break_file_path(jid))
    except OSError:
        pass


# ---------------------------------------------------------------- 孤儿停止信号清理
# 停止信号文件原本只在任务走完 finally 时删除, 于是"进程被杀"就会漏:
# 插件变更会 os.execv 重启后端、关窗/托盘退出、崩溃、被外部 kill —— 这些情况下
# 任务来不及收尾, temp_break_<id>.json 会一直留在 outputs/ 里越积越多 (每个 15 字节)。
# 判定"已经没用了"的两条依据:
#   1. 本进程的任务注册表 (线程级 _current_job + JobManager + 生图队列) 里没有这个 id;
#   2. 文件里记的写入者 pid 已经不是活进程 (同一个 pid 重启说明是本进程的上一轮, 可清)。
# 只要"另一个还活着的实例"可能是它的主人, 就保留 —— 多开时不能删别人的在跑任务。
# 任何清理失败都不影响任务本身, 一律吞掉。

_cleanup_started = False


def current_job_ids() -> set[str]:
    """各线程通过 set_current_job 注册的任务 id。"""
    return {jid for jid in _current_job.values() if jid}


def active_job_ids() -> set[str]:
    """本进程当前正在运行的任务 id。

    三个来源取并集: 线程级注册表 (_current_job) + JobManager + 生图队列 ——
    只要有一处认为它在跑, 它的信号文件就不算"没用", 宁可少删。
    """
    ids = current_job_ids()
    ids.update(jobs.running_job_ids())
    try:
        from utils.gen_queue import gen_queue

        ids.update(gen_queue.running_ids())
    except Exception:
        logger.opt(exception=True).debug("收集运行中任务失败堆栈:")
    return ids


def _pid_alive(pid: int) -> bool:
    """进程是否还活着。

    注意 Windows 上不能用 os.kill(pid, 0) —— 那会走 TerminateProcess 真的把进程杀掉。
    """
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes

            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False  # 打不开 = 进程已退出 / 无权限
            try:
                code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True  # 查不到就当作活着, 宁可少删
                return code.value == STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True  # 判定不了时保守保留
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_break_file(path: str) -> dict:
    """读停止信号文件 (读不出/格式不对都当空 dict)。"""
    import ujson as json

    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _in_use(job_id: str, data: dict, alive: set[str]) -> bool:
    """该停止信号文件是否还被某个活着的任务使用 (本进程按注册表, 别的进程按 pid)。"""
    if job_id and job_id in alive:
        return True
    owner = data.get("pid")
    return isinstance(owner, int) and owner != os.getpid() and _pid_alive(owner)


def sweep_break_files(force: bool = False) -> list[str]:
    """清理已经没有任务使用的停止信号文件, 返回被删掉的文件名。

    force=True 用于进程退出时 (任务随进程一起没了, 不再看注册表)。
    """
    alive: set[str] = set() if force else active_job_ids()
    removed: list[str] = []
    pattern = os.path.join(OUTPUTS_DIR, f"{BREAK_FILE_PREFIX}*{BREAK_FILE_SUFFIX}")
    for path in sorted(glob.glob(pattern)):
        name = os.path.basename(path)
        job_id = name[len(BREAK_FILE_PREFIX) : -len(BREAK_FILE_SUFFIX)]
        if _in_use(job_id, _read_break_file(path), alive):
            continue
        try:
            os.remove(path)
            removed.append(name)
        except OSError:
            pass
    # 无任务线程时读的全局兼容信号: 只有内容是 break=false 才能删 (读不到与读到 false 等价)
    global_path = os.path.join(OUTPUTS_DIR, "temp_break.json")
    if os.path.exists(global_path):
        data = _read_break_file(global_path)
        if not data.get("break") and not _in_use("", data, alive):
            try:
                os.remove(global_path)
                removed.append("temp_break.json")
            except OSError:
                pass
    return removed


def _sweep_at_exit() -> None:
    """退出时兜底清一次 (解释器已在收尾, 出错一律忽略)。"""
    try:
        sweep_break_files(force=True)
    except Exception:
        logger.opt(exception=True).debug("清理停止信号文件失败堆栈:")


def start_break_cleanup(interval: float = JANITOR_INTERVAL) -> list[str]:
    """启动停止信号清理机制 (幂等), 返回启动时清掉的文件名。

    - 启动先清一次: 上一轮被强杀留下的残留 (新进程里没有任务在跑, 全都是孤儿);
    - 注册 atexit: 正常退出 (关窗/托盘退出/Ctrl+C) 时顺手清干净;
    - 起一个 daemon 线程定期清: 覆盖没有新任务时的历史残留与异常收尾。
    """
    global _cleanup_started
    removed = sweep_break_files()
    if _cleanup_started:
        return removed
    _cleanup_started = True
    atexit.register(_sweep_at_exit)

    def _loop():
        while True:
            time.sleep(interval)
            try:
                gone = sweep_break_files()
                if gone:
                    logger.debug(f"已清理无用的停止信号文件: {gone}")
            except Exception as e:
                logger.debug(f"停止信号文件清理失败: {e}")
                logger.opt(exception=True).debug("停止信号文件清理失败堆栈:")

    threading.Thread(target=_loop, daemon=True, name="break-cleanup").start()
    return removed


def single_job(job_name: str, busy_return=None):
    """防止多个长任务共享临时状态: 同时只允许一个任务运行。"""

    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            if not _job_lock.acquire(blocking=False):
                message = f"已有任务正在运行, 请先停止或等待当前任务完成 ({job_name})"
                logger.warning(message)
                if callable(busy_return):
                    return busy_return(message)
                if busy_return is not None:
                    return busy_return
                raise JobAlreadyRunningError(message)
            try:
                return func(*args, **kwargs)
            finally:
                _job_lock.release()

        return wrapper

    return decorator


def normalize_result(result):
    """把任务返回值规范成 {images, message, result} 结构。"""
    if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], str):
        images, message = result
        return {"images": images or [], "message": message}
    if isinstance(result, list):
        return {"images": result, "message": "处理完成!"}
    if isinstance(result, dict):
        return result
    return {"message": str(result) if result else "处理完成!"}


class JobManager:
    """在后台线程中执行任务并推送状态事件 (非 NovelAI 类任务: 多线程并行)。"""

    def __init__(self):
        self._running: dict[str, str] = {}

    @property
    def is_busy(self) -> bool:
        return bool(self._running)

    def running_job_ids(self) -> list[str]:
        """全部运行中任务的 id (全局停止信号用)。"""
        return list(self._running.keys())

    def submit(self, name: str, fn: Callable, *args, **kwargs) -> str:
        job_id = uuid.uuid4().hex[:8]

        def _run():
            set_current_job(job_id, name)
            self._running[job_id] = name
            broker.publish("job:start", {"id": job_id, "name": name})
            try:
                result = fn(*args, **kwargs)
                payload = normalize_result(result)
                broker.publish("job:done", {"id": job_id, "name": name, "ok": True, **payload})
            except Exception as e:
                logger.error(f"任务 [{name}] 执行失败: {e}")
                logger.opt(exception=True).debug("任务失败堆栈:")
                broker.publish(
                    "job:failed",
                    {"id": job_id, "name": name, "ok": False, "error": str(e) or e.__class__.__name__},
                )
            finally:
                self._running.pop(job_id, None)
                pop_current_job()
                cleanup_break_file(job_id)
                sweep_break_files()  # 顺手收掉历史残留 (强杀/异常收尾留下的孤儿信号)

        threading.Thread(target=_run, name=f"job-{name}", daemon=True).start()
        return job_id

    def emit(self, event_name: str, data: dict[str, Any]) -> None:
        """任务运行中推送自定义事件 (如实时预览), 需在任务线程内调用。"""
        job_id = current_job_id()
        if job_id:
            broker.publish(
                "job:event",
                {"id": job_id, "name": event_name, "job_name": current_job_name(), **data},
            )


jobs = JobManager()
