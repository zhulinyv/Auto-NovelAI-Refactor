"""配置设置服务: 修改后立即生效, 无需重启。

- 写入 settings.json 持久化
- 更新内存中的 env 单例 (token / proxy / cool_time 等实时生效)
- 刷新代理、环境变量等依赖项
"""
from __future__ import annotations

import os

from utils.config import env


def get_settings() -> dict:
    return env.to_dict()


def _apply_runtime(data: dict) -> None:
    """把已保存的配置应用到运行时 (代理、环境变量、插件等)。"""
    from utils.variable import refresh_proxies

    refresh_proxies()

    if env.proxy:
        os.environ["http_proxy"] = env.proxy
        os.environ["https_proxy"] = env.proxy
    else:
        os.environ.pop("http_proxy", None)
        os.environ.pop("https_proxy", None)


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

    env.update(normalized)
    _apply_runtime(normalized)

    # 插件开关实时生效
    try:
        from utils.plugins import load_plugins

        load_plugins()
    except Exception:
        pass

    return "修改已生效! (端口 / 共享链接修改需重启后重新绑定)"
