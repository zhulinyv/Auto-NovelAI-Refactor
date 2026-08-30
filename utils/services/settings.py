"""配置设置服务: 修改后立即生效, 无需重启。

- 写入 settings.json 持久化
- 更新内存中的 env 单例 (token / tokens / proxy / cool_time 等实时生效)
- 刷新代理、环境变量、生图队列通道数等依赖项
"""
from __future__ import annotations

import os

from utils.config import env


def get_settings() -> dict:
    return env.to_dict()


def _normalize_tokens(data: dict) -> None:
    """把 tokens 字段规范成非空字符串列表 (支持列表或每行一个的文本)。"""
    tokens = data.get("tokens")
    if isinstance(tokens, str):
        tokens = tokens.replace(",", "\n").splitlines()
    if not isinstance(tokens, list):
        tokens = []
    tokens = [str(t).strip() for t in tokens if t and str(t).strip()]
    # 兼容旧单 token 字段: 未提供 tokens 但填写了 token 时使用它
    if not tokens:
        single = str(data.get("token") or "").strip()
        if single:
            tokens = [single]
    data["tokens"] = tokens
    data["token"] = tokens[0] if tokens else None


def _apply_runtime(data: dict) -> None:
    """把已保存的配置应用到运行时 (代理、环境变量、生图队列通道等)。"""
    from utils.variable import refresh_proxies

    refresh_proxies()

    if env.proxy:
        os.environ["http_proxy"] = env.proxy
        os.environ["https_proxy"] = env.proxy
    else:
        os.environ.pop("http_proxy", None)
        os.environ.pop("https_proxy", None)

    # Token 数量可能变化: 按新配置重建生图队列执行通道
    try:
        from utils.gen_queue import gen_queue

        gen_queue.reload()
    except Exception:
        pass


def save_settings(data: dict) -> str:
    """保存配置: 立即生效 (端口与共享链接需要重启后重新绑定)。"""
    # 规范化: 空字符串转 None (可选字段)
    normalized = dict(data)
    for key in ("token", "proxy", "custom_path", "smtp_mail", "smtp_token"):
        if key in normalized and normalized[key] in (None, ""):
            normalized[key] = None if key in ("proxy", "token", "smtp_mail", "smtp_token") else ""
    for key in ("cool_time", "port", "smtp_num"):
        try:
            normalized[key] = int(normalized.get(key, 0))
        except (TypeError, ValueError):
            normalized[key] = 0

    _normalize_tokens(normalized)

    old_hide_terminal = env.hide_terminal
    env.update(normalized)
    _apply_runtime(normalized)

    # 终端隐藏开关实时生效 (仅 Windows)
    if bool(normalized.get("hide_terminal")) != bool(old_hide_terminal):
        try:
            from utils.helpers import apply_console_visibility

            apply_console_visibility()
        except Exception:
            pass

    # 插件开关实时生效
    try:
        from utils.plugins import load_plugins

        load_plugins()
    except Exception:
        pass

    return "修改已生效! (端口 / 共享链接修改需重启后重新绑定)"