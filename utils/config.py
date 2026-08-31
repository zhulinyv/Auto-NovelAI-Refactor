"""应用配置: 内存运行时设置 + settings.json 持久化。

- 不再使用 .env 文件: 配置保存到 `settings.json`, 修改后立即生效, 无需重启
- 首次启动时自动从旧的 .env 迁移已有配置 (如 Token)
- `env` 是全局单例对象, 属性可直接修改并实时生效
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
SETTINGS_FILE = BASE_DIR / "settings.json"

DEFAULTS: dict[str, Any] = {
    "token": None,
    "tokens": [],
    "proxy": None,
    "custom_path": "<类型>/<日期>/<种子>_<编号>",
    "cool_time": 3,
    "port": 11451,
    "share": False,
    "retry_429": True,
    "start_sound": True,
    "finish_sound": True,
    "check_update": True,
    "hide_terminal": False,
    "disable_all_plugins": False,
    "skip_inquire_anlas": False,
    "format_input": True,
    "remove_nsfw": True,
    "smtp_num": 0,
    "smtp_mail": None,
    "smtp_token": None,
}

_LIST_KEYS = {"tokens"}

_BOOL_KEYS = {
    "share",
    "start_sound",
    "finish_sound",
    "retry_429",
    "check_update",
    "hide_terminal",
    "disable_all_plugins",
    "skip_inquire_anlas",
    "format_input",
    "remove_nsfw",
}
_INT_KEYS = {"cool_time", "port", "smtp_num"}


def _coerce(key: str, value: Any) -> Any:
    """把字符串形式的配置值转换成正确类型 (用于 .env 迁移)。"""
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip().strip('"').strip("'")
        if key in _BOOL_KEYS:
            return value.lower() in ("1", "true", "yes", "on")
        if key in _INT_KEYS:
            try:
                return int(value)
            except ValueError:
                return DEFAULTS[key]
        if value == "":
            return None if DEFAULTS.get(key) is None else ""
    return value


def _migrate_from_env(data: dict) -> dict:
    """首次启动 (无 settings.json 或无 token) 时从旧 .env 迁移配置。"""
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return data
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key in DEFAULTS and not data.get(key):
                data[key] = _coerce(key, value)
    except Exception:
        pass
    return data


class Settings:
    """运行时设置对象: 修改立即生效, 并持久化到 settings.json。"""

    def __init__(self):
        data: dict = {}
        if SETTINGS_FILE.exists():
            try:
                data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            except Exception:
                data = {}
        data = _migrate_from_env(data)
        for key, default in DEFAULTS.items():
            setattr(self, key, data.get(key, default))
        # 立即生成 settings.json (含旧 .env 迁移结果)
        self.persist()

    def to_dict(self) -> dict:
        return {key: getattr(self, key) for key in DEFAULTS}

    def update(self, data: dict) -> None:
        """更新配置并立即持久化。"""
        for key in DEFAULTS:
            if key in data:
                setattr(self, key, _coerce(key, data[key]))
        # tokens 列表与单 token 双向同步 (旧插件 / 旧调用只更新其中一个时也正确):
        # - 提供了 tokens: token = 第一个有效 Token
        # - 只提供了 token: tokens = [token]
        if "tokens" in data:
            tokens = [str(t).strip() for t in (self.tokens or []) if t and str(t).strip()]
            self.tokens = tokens
            self.token = tokens[0] if tokens else None
        elif "token" in data:
            single = str(self.token).strip() if self.token else ""
            self.tokens = [single] if single else []
        self.persist()

    def persist(self) -> None:
        SETTINGS_FILE.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


env = Settings()


def update_env(**kwargs) -> None:
    """兼容旧调用: 等价于 env.update()。"""
    env.update(kwargs)
