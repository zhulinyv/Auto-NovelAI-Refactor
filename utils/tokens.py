"""Token 注册表: 多 Token 支持与线程级 Token 绑定。

- env.tokens 保存全部有效 Token (settings.json), env.token 始终为第一个 (旧插件兼容)
- 生图队列的每个通道 (worker) 执行任务前通过 set_thread_token() 绑定自己的 Token,
  请求头构建 (build_headers) 与剩余点数查询自动使用当前线程绑定的 Token
"""
from __future__ import annotations

import threading

from utils.config import env

_local = threading.local()


def get_tokens() -> list[str]:
    """返回全部有效 Token 列表 (兼容旧单 token 配置)。"""
    tokens = getattr(env, "tokens", None) or []
    tokens = [str(t).strip() for t in tokens if t and str(t).strip()]
    if not tokens:
        single = getattr(env, "token", None)
        if single and str(single).strip():
            tokens = [str(single).strip()]
    return tokens


def worker_count() -> int:
    """执行通道数 = 有效 Token 数 (至少 1)。"""
    return max(1, len(get_tokens()))


def mask_token(token: str | None) -> str | None:
    """打码显示 Token: 只露出开头与结尾。"""
    if not token:
        return None
    token = str(token)
    if len(token) <= 14:
        return token[:4] + "…"
    return token[:8] + "…" + token[-4:]


def set_thread_token(token: str | None) -> None:
    """绑定当前线程使用的 Token (生图队列 worker 调用)。"""
    _local.token = token


def pop_thread_token() -> None:
    """解除当前线程的 Token 绑定。"""
    _local.token = None


def current_token() -> str | None:
    """当前线程应使用的 Token: 优先线程绑定值, 否则回落到第一个 Token。"""
    tok = getattr(_local, "token", None)
    if tok:
        return tok
    tokens = get_tokens()
    return tokens[0] if tokens else getattr(env, "token", None)
