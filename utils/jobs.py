"""后台任务管理: 任务状态推送 + 线程级任务注册表。

- single_job: 装饰器, 保证同一时间只有一个长任务在运行 (兼容保留, 生图类任务已改走队列)
- JobManager: 在后台线程中执行"非 NovelAI"任务 (超分/本地处理等), 并推送 job:start / job:done / job:failed
- 当前任务注册表: 线程 -> 任务 id 映射, 供停止信号 (check_stop) 与实时事件定位当前任务;
  JobManager 与生图队列 (utils.gen_queue) 共用该注册表
"""
from __future__ import annotations

import os
import threading
import uuid
from functools import wraps
from typing import Any, Callable

from utils.errors import JobAlreadyRunningError
from utils.events import broker
from utils.logger import logger

_job_lock = threading.Lock()

# 当前线程正在执行的任务 id (用于停止信号定位与任务内推送自定义事件)
_current_job: dict[int, str] = {}


def set_current_job(job_id: str) -> None:
    """在当前线程注册任务 id (任务开始时调用)。"""
    _current_job[threading.get_ident()] = job_id


def pop_current_job() -> None:
    """移除当前线程的任务注册 (任务结束时调用)。"""
    _current_job.pop(threading.get_ident(), None)


def current_job_id() -> str | None:
    """当前线程正在执行的任务 id (不在任务线程内时返回 None)。"""
    return _current_job.get(threading.get_ident())


def break_file_path(job_id: str | None = None) -> str:
    """任务的停止信号文件路径: 每个任务独立, 互不干扰。"""
    jid = job_id or current_job_id()
    if jid:
        return f"./outputs/temp_break_{jid}.json"
    return "./outputs/temp_break.json"


def write_break_flag(flag: bool, job_id: str | None = None) -> None:
    """写入停止信号文件。"""
    os.makedirs("./outputs", exist_ok=True)
    import ujson as json

    with open(break_file_path(job_id), "w", encoding="utf-8") as f:
        json.dump({"break": flag}, f)


def cleanup_break_file(job_id: str | None = None) -> None:
    """任务结束后清理其停止信号文件。"""
    jid = job_id or current_job_id()
    if not jid:
        return
    try:
        os.remove(f"./outputs/temp_break_{jid}.json")
    except OSError:
        pass


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
            set_current_job(job_id)
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

        threading.Thread(target=_run, name=f"job-{name}", daemon=True).start()
        return job_id

    def emit(self, event_name: str, data: dict[str, Any]) -> None:
        """任务运行中推送自定义事件 (如实时预览), 需在任务线程内调用。"""
        job_id = current_job_id()
        if job_id:
            broker.publish("job:event", {"id": job_id, "name": event_name, **data})


jobs = JobManager()
