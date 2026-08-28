"""兼容层: 旧插件可能使用 `from utils.environment import env`。"""
from utils.config import env

__all__ = ["env"]
