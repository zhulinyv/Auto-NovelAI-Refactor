"""事件总线: 用于把日志与任务状态实时推送给前端 (SSE)。

实现为线程安全的发布/订阅模型: 后台线程通过 publish() 发布事件,
SSE 端点订阅后持续读取并转发。
"""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from typing import Any

_EVENT_TYPES = (
    "log",
    "notice",
    "anlas:update",
    "job:start",
    "job:event",
    "job:done",
    "job:failed",
    "queue:update",
    "share:update",  # 共享链接状态变化 (由 utils/tunnel.py 发布)
)


class EventBroker:
    """线程安全的轻量事件总线。"""

    def __init__(self, history_size: int = 300):
        self._subscribers: list[queue.Queue] = []
        self._lock = threading.Lock()
        # deque(maxlen=...): 原先用 list 并在 publish 里 self._history = self._history[-n:],
        # 每发布一条事件就重建整个 300 元素列表 (O(n) 分配)。deque 自动淘汰队首。
        self._history: deque[dict[str, Any]] = deque(maxlen=history_size)
        self._history_size = history_size
        self._seq = 0  # 全局递增序号: 供轮询接口做增量拉取

    def publish(self, event_type: str, data: dict[str, Any]) -> None:
        # 未知类型不再抛异常: 全项目有 20+ 处 publish 调用, 其中不少包在
        # try/except: logger.debug 里 —— 拼错一个字符串就静默丢掉整条事件, 极难发现。
        # 事件总线不该让业务逻辑失败: 记一条警告后照常投递 (前端不认识的类型会忽略)。
        if event_type not in _EVENT_TYPES:
            # 延迟导入: logger 反过来 import 本模块的 broker, 顶层导入会成环
            try:
                from utils.logger import logger as _log

                _log.warning(f"发布未知类型的事件: {event_type} (已照常投递, 请把它补进 _EVENT_TYPES)")
            except Exception:
                pass
        with self._lock:
            self._seq += 1
            payload = {"type": event_type, "seq": self._seq, "time": time.time(), **data}
            self._history.append(payload)
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
        with self._lock:
            if event_type is None:
                return list(self._history)
            return [e for e in self._history if e["type"] == event_type]

    def current_seq(self) -> int:
        with self._lock:
            return self._seq

    def history_after(self, event_type: str, after_seq: int) -> list[dict[str, Any]]:
        """返回 seq 大于 after_seq 的指定类型事件 (供共享链接下的轮询增量拉取)。"""
        with self._lock:
            return [e for e in self._history if e["type"] == event_type and e.get("seq", 0) > after_seq]


broker = EventBroker()
