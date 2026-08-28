"""应用级异常定义。

所有异常都继承自 ANRError, 便于上层统一捕获并输出可读的错误日志。
"""


class ANRError(Exception):
    """基类: 应用级失败。"""


class NovelAIAPIError(ANRError):
    """NovelAI 返回了不可用的响应 (非 200 或内容损坏)。"""


class JobAlreadyRunningError(ANRError):
    """已有任务正在运行, 无法启动新任务。"""


class ConfigError(ANRError):
    """配置缺失或非法 (例如未配置 Token)。"""


class PluginError(ANRError):
    """插件加载或执行失败。"""
