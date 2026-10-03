"""统一的外部 HTTP 请求助手。

此前 "先直连、失败改走系统代理, 并记住哪种方式可用" 的写法被复制了多遍
(server/routes/misc.py 的在线壁纸 / 一言各一份, utils/translate.py 一份),
其中只有 translate.py 的版本会记住上次成功的模式。这里统一为一个实现。

直连优先的原因: 实测多数场景下直连比走系统代理快; 代理仅作兜底。

需要"同一会话内多步请求"的调用方 (Bing 先取页面再 POST token) 用
`browse_session()` 显式拿到一个已配置好的 Session: 它把"直连/代理"的降级
决策暴露给调用方, 因为多步流程必须在同一个 Session 上完成。
"""

from __future__ import annotations

import threading

import requests

# 上次成功的连接方式 (None=未探测, False=直连, True=走系统代理)
_trust_env: bool | None = None
_lock = threading.Lock()

# 通用请求头 (部分免费接口会校验 UA / Referer)
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def preferred_mode() -> bool:
    """上次成功的连接方式; 未探测过时默认直连 (False)。"""
    with _lock:
        return False if _trust_env is None else _trust_env


def mode_order() -> tuple[bool, ...]:
    """探测顺序: 先用上次成功的模式, 未探测过时先直连。"""
    preferred = preferred_mode()
    return tuple(sorted((False, True), key=lambda t: t != preferred))


def remember_mode(trust_env: bool) -> None:
    """记录本次成功的连接方式, 供后续请求优先复用。"""
    global _trust_env
    with _lock:
        _trust_env = trust_env


def reset_mode() -> None:
    """清除记忆的连接方式 (下一个请求重新先试直连)。"""
    global _trust_env
    with _lock:
        _trust_env = None


def new_session(trust_env: bool, headers: dict | None = None) -> requests.Session:
    """构造一个已设好 trust_env 与默认请求头的 Session (多步流程复用同一个)。"""
    sess = requests.Session()
    sess.trust_env = trust_env
    merged = dict(DEFAULT_HEADERS)
    if headers:
        merged.update(headers)
    sess.headers.update(merged)
    return sess


def request(
    method: str,
    url: str,
    *,
    headers: dict | None = None,
    trust_env: bool | None = None,
    **kwargs,
) -> requests.Response:
    """带"直连 -> 代理"自动降级的请求; 两种方式都失败时抛最后一次异常。

    trust_env 显式指定时只试那一种 (调用方自己已经决定好了连接方式)。
    """
    last: Exception | None = None
    for trust in (trust_env,) if trust_env is not None else mode_order():
        try:
            sess = new_session(trust, headers)
            resp = sess.request(method, url, **kwargs)
            resp.raise_for_status()
            remember_mode(trust)
            return resp
        except Exception as e:  # noqa: BLE001 - 换下一种连接方式重试
            last = e
    raise last if last is not None else RuntimeError("请求失败")


def get(url: str, **kwargs) -> requests.Response:
    return request("GET", url, **kwargs)


def post(url: str, **kwargs) -> requests.Response:
    return request("POST", url, **kwargs)


__all__ = [
    "request",
    "get",
    "post",
    "new_session",
    "preferred_mode",
    "mode_order",
    "remember_mode",
    "reset_mode",
    "DEFAULT_HEADERS",
]
