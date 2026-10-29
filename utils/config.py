"""应用配置: 内存运行时设置 + settings.json 持久化。

- 不再使用 .env 文件: 配置保存到 `settings.json`, 修改后立即生效, 无需重启
- 首次启动时自动从旧的 .env 迁移已有配置 (如 Token)
- `env` 是全局单例对象, 属性可直接修改并实时生效
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from utils.logger import logger
from utils.paths import migrate_legacy

# BASE_DIR 必须先于任何可能触发反向 import 的动作定义:
# logger 的终端 sink 会 from utils.variable import VERSION, 而 variable 又
# from utils.config import BASE_DIR, env —— 迁移过程中一旦打日志, 就会在 BASE_DIR
# 尚未定义时形成半个模块的循环 import。
BASE_DIR = Path(__file__).resolve().parent.parent

# 全量迁移一次旧版本散落在 outputs / data 下的状态与临时文件 (幂等, 失败不阻断启动)。
# 结果日志推迟到文件末尾 (env 实例建好之后) 再打, 避免循环 import。
try:
    _MIGRATED = migrate_legacy()
except Exception:  # noqa: BLE001 - 迁移失败不该让应用起不来
    _MIGRATED = []

# settings.json 与 last.json 刻意留在**项目根目录**:
# 这两个文件是用户日常要直接查看 / 手改 / 备份的, 放在根目录一眼就能看到;
# 其余"程序自己用"的状态、缓存与临时文件仍然收在 data/ 下 (见 utils/paths.py)。
SETTINGS_FILE = BASE_DIR / "settings.json"
LAST_FILE = BASE_DIR / "last.json"
OUTPUTS_DIR = BASE_DIR / "outputs"


def resolve_media_path(path):
    """把前端传入的图片路径规范为绝对路径。

    图片浏览接口 (/api/browse/images) 返回的是相对 outputs 的路径
    (如 text2image/2026-09-01/xxx.png), 而进程启动时已把工作目录切到
    项目根 (main.py), 相对路径直接按 CWD 解析找不到文件。统一规则:
    绝对路径原样返回; 相对路径按 outputs 目录解析; 空值原样返回。
    """
    if not path:
        return path
    p = Path(path)
    return p if p.is_absolute() else OUTPUTS_DIR / p


DEFAULTS: dict[str, Any] = {
    "token": None,
    "tokens": [],
    "proxy": None,
    "custom_path": "<类型>/<日期>/<种子>_<编号>",
    "cool_time": 9,
    "port": 11451,
    "share": False,
    "retry_429": True,
    "start_sound": True,
    "finish_sound": True,
    "check_update": True,
    # 默认隐藏终端黑窗口 (仅 Windows)。用户显式保存过该值时以用户配置为准 ——
    # 常量只决定"从未配置过"的首次启动行为 (见 Settings.__init__)。
    "hide_terminal": True,
    "disable_all_plugins": False,
    "skip_inquire_anlas": False,
    "anlas_remind_percent": 1,
    "skip_nai5_no_usage": False,
    "format_input": True,
    # 界面: 是否使用新版生图界面 (左侧 2/5 放生图模型 / 提示词 / 参数设置, 右侧 3/5 放输出图片)。
    # 默认关闭, 即保持原有的上下 + 左右两栏界面; 切换后刷新页面生效。
    "use_new_gen_ui": False,
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
    "skip_nai5_no_usage",
    "format_input",
    "use_new_gen_ui",
    "remove_nsfw",
}
_INT_KEYS = {"cool_time", "port", "smtp_num", "anlas_remind_percent"}


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
    except Exception as e:
        logger.debug(f"读取 .env 配置失败, 使用默认值: {e}")
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
        # 原子写: 先写临时文件再 os.replace, 避免进程被杀时留下半截 settings.json
        # (那会让下一次启动静默回落到默认值 —— 用户的 Token / 端口等全部丢失)
        try:
            SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = SETTINGS_FILE.with_name(f".{SETTINGS_FILE.name}.tmp")
            tmp.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, SETTINGS_FILE)
        except OSError:
            SETTINGS_FILE.write_text(
                json.dumps(self.to_dict(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )


env = Settings()

# 迁移结果在这里才打日志 (env 已建好, variable/logger 的循环不再成立)。
# 迁移目标不一定是 data/ (settings.json / last.json 是搬回项目根), 所以只说"已归位"。
try:
    if _MIGRATED:
        logger.info(f"已归位 {len(_MIGRATED)} 个旧版本残留文件")
        for _line in _MIGRATED[:8]:
            logger.debug(f"  {_line}")
except Exception:
    pass


def update_env(**kwargs) -> None:
    """兼容旧调用: 等价于 env.update()。"""
    env.update(kwargs)
