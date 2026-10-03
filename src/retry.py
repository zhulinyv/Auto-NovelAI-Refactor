"""NovelAI 请求重试: 生图与导演工具共用的唯一实现。

此前 generate_images.py 与 director_tools.py 各写了一份 _generate_with_retry,
且导演工具那份在非 429 分支缺少 check_stop() (停止请求要等睡满才生效)。

行为 (与原 genrate_images 版本一致, 作为唯一真源):
- 429 且开启 "429 自动重试" 配置: 无上限重试 (每次等待 5 秒)
- 其余错误: 最多重试 max_retries 次 (每次等待 5 秒), 仍失败则抛出异常
- 任一点检测到停止信号: 立即抛 StopGeneration, 不再等待/重试
"""

from __future__ import annotations

from typing import Any

from utils.config import env
from utils.errors import NovelAIAPIError
from utils.helpers import StopGeneration, check_stop, sleep_for_cool
from utils.logger import logger


def generate_with_retry(
    generator: Any,
    json_data: dict,
    desc: str,
    max_retries: int = 3,
    log_scope: str = "生成重试失败",
) -> Any:
    """发送一次生成请求并自动重试; 返回 generator.generate() 的结果。

    log_scope 只影响失败时的 debug 日志前缀 (生图 / 导演工具分别区分)。
    """
    retries = 0
    while True:
        if check_stop():
            raise StopGeneration("已停止生成")
        try:
            data = generator.generate(json_data)
            if not data:
                raise NovelAIAPIError("NovelAI 未返回图片数据")
            return data
        except StopGeneration:
            raise
        except Exception as e:
            # 捕获所有异常 (含 requests 连接错误/超时/NovelAIAPIError), 统一进入重试流程
            is_429 = "429" in str(e)
            if is_429 and getattr(env, "retry_429", False):
                retries += 1
                logger.warning(f"[{desc}] 429 限流, 等待 5 秒后自动重试 (第 {retries} 次): {e}")
                if check_stop():
                    raise StopGeneration("已停止生成")
                sleep_for_cool(5)
                continue
            retries += 1
            if retries > max_retries:
                logger.error(f"[{desc}] 重试 {max_retries} 次仍失败, 跳过该图片: {e}")
                logger.opt(exception=True).debug(f"{log_scope}堆栈:")
                raise
            logger.warning(f"[{desc}] 生成失败, 等待 5 秒后重试 ({retries}/{max_retries}): {e}")
            if check_stop():
                raise StopGeneration("已停止生成")
            sleep_for_cool(5)


__all__ = ["generate_with_retry"]
