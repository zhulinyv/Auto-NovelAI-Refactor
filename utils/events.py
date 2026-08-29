"""事件总线: 用于把日志与任务状态实时推送给前端 (SSE)。

实现为线程安全的发布/订阅模型: 后台线程通过 publish() 发布事件,
SSE 端点订阅后持续读取并转发。
"""
from __future__ import annotations

import queue
import threading
import time
from typing import Any

_EVENT_TYPES = ("log", "job:start", "job:event", "job:done", "job:failed", "queue:update")


class EventBroker:
    """线程安全的轻量事件总线。"""

    def __init__(self, history_size: int = 300):
        self._subscribers: list[queue.Queue] = []
        self._lock = threading.Lock()
        self._history: list[dict[str, Any]] = []
        self._history_size = history_size

    def publish(self, event_type: str, data: dict[str, Any]) -> None:
        if event_type not in _EVENT_TYPES:
            raise ValueError(f"unknown event type: {event_type}")
        payload = {"type": event_type, "time": time.time(), **data}
        with self._lock:
            self._history.append(payload)
            if len(self._history) > self._history_size:
                self._history = self._history[-self._history_size:]
            for sub in list(self._subscribers):
                try:
                    sub.put_nowait(payload)
                except queue.Full:
                    pass  # 慢消费者直接丢弃, 不阻塞发布方

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=512)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def history(self, event_type: str | None = None) -> list[dict[str, Any]]:
        if event_type is None:
            return list(self._history)
        return [e for e in self._history if e["type"] == event_type]


broker = EventBroker()