"""后台任务管理: 全局互斥锁 + 任务状态推送。

- single_job: 装饰器, 保证同一时间只有一个长任务在运行 (与旧版行为一致)
- JobManager: 在后台线程中执行任务, 并通过事件总线推送 job:start / job:done / job:failed
"""
from __future__ import annotations

import threading
import uuid
from functools import wraps
from typing import Any, Callable

from utils.errors import JobAlreadyRunningError
from utils.events import broker
from utils.logger import logger

_job_lock = threading.Lock()

# 当前线程正在执行的任务 id (用于任务内推送自定义事件)
_current_job: dict[int, str] = {}


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


def _normalize_result(result):
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
    """在后台线程中执行任务并推送状态事件。"""

    def __init__(self):
        self._running: dict[str, str] = {}

    @property
    def is_busy(self) -> bool:
        return bool(self._running)

    def submit(self, name: str, fn: Callable, *args, **kwargs) -> str:
        job_id = uuid.uuid4().hex[:8]

        def _run():
            _current_job[threading.get_ident()] = job_id
            self._running[job_id] = name
            broker.publish("job:start", {"id": job_id, "name": name})
            try:
                result = fn(*args, **kwargs)
                payload = _normalize_result(result)
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
                _current_job.pop(threading.get_ident(), None)

        threading.Thread(target=_run, name=f"job-{name}", daemon=True).start()
        return job_id

    def emit(self, event_name: str, data: dict[str, Any]) -> None:
        """任务运行中推送自定义事件 (如实时预览), 需在任务线程内调用。"""
        job_id = _current_job.get(threading.get_ident())
        if job_id:
            broker.publish("job:event", {"id": job_id, "name": event_name, **data})


jobs = JobManager()
