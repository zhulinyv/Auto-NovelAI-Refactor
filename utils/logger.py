"""日志系统。

- 终端: rich 彩色输出, 异常只显示 rich 面板 (不再重复输出普通文本 traceback)
- 前端: 通过事件总线推送结构化日志 (级别 / 消息 / 时间 / 异常详情)
"""
from __future__ import annotations

import re
import sys
import traceback
from datetime import datetime

from loguru import logger
from rich.console import Console
from rich.highlighter import Highlighter
from rich.traceback import Traceback

from utils.events import broker
from utils.variable import VERSION

console = Console(color_system="windows" if sys.platform == "win32" else "auto")


class DisabledHighlighter(Highlighter):
    def highlight(self, text):
        pass


LEVEL_COLORS = {
    "SUCCESS": "bold green",
    "WARNING": "yellow",
    "INFO": "white",
    "DEBUG": "bold blue",
    "ERROR": "bold red",
}


def _patcher(record):
    level_name = record["level"].name
    record["extra"]["lvl_color"] = LEVEL_COLORS.get(level_name, "white")


logger = logger.patch(_patcher)
logger.remove()


def _terminal_sink(message):
    """终端日志: 普通消息一行带颜色; 异常只渲染 rich 面板 (红框), 不再输出普通文本 traceback。"""
    record = message.record
    level = record["level"].name
    color = LEVEL_COLORS.get(level, "white")
    time_str = datetime.fromtimestamp(record["time"].timestamp()).strftime("%y-%m-%d %H:%M:%S")
    prefix = f"[{color}]{level:<7}[/{color}] | [magenta]ANR: {VERSION}[/magenta] | [cyan]{time_str}[/cyan] | "
    msg = record["message"]
    exc = record.get("exception")
    if exc and exc[2]:
        # 消息单独一行, 异常用 rich 面板展示 (不显示 loguru 附加的普通文本 traceback)
        console.print(prefix + f"[{color}]{msg}[/{color}]")
        tb = Traceback.from_exception(exc[0], exc[1], exc[2])
        console.print(tb)
    else:
        console.print(prefix + f"[{color}]{msg}[/{color}]")


# enqueue=False: enqueue=True 会序列化记录, 异常 traceback 无法跨线程传递 (会丢失)
logger.add(_terminal_sink, level="DEBUG", format="{message}", enqueue=False)


def _format_exception(record) -> str | None:
    """把 loguru record 中的异常信息格式化为标准 traceback 文本 (与终端一致)。"""
    exc_info = record.get("exception")
    if not exc_info or not exc_info[2]:
        return None
    exc_type, exc_value, tb = exc_info
    frames = []
    for frame in traceback.extract_tb(tb):
        frames.append(f'  File "{frame.filename}", line {frame.lineno}, in {frame.name}\n    {frame.line}')
    head = f"{exc_type.__name__}: {exc_value}"
    if frames:
        return "Traceback (most recent call last):\n" + "\n".join(frames) + "\n" + head
    return head


# rich 标记 (如 <c>/<y>/<r> 转换来的 [cyan]/[yellow]/[red]) 只用于终端着色, 推给前端前要剥掉
_MARKUP_RX = re.compile(r"\[/?[a-z]+(?: [a-z]+)*\]")


def _strip_markup(text: str) -> str:
    return _MARKUP_RX.sub("", text) if text else text


def _web_sink(message):
    """把日志记录推送到前端事件总线 (异常堆栈需在同一线程内获取, 故不用 enqueue)。"""
    try:
        record = message.record
        broker.publish(
            "log",
            {
                "level": record["level"].name.lower(),
                "message": _strip_markup(record["message"]),
                "time": datetime.fromtimestamp(record["time"].timestamp()).strftime("%H:%M:%S"),
                "exception": _format_exception(record),
            },
        )
    except Exception:
        # 推送失败不能影响业务代码
        pass


logger.add(_web_sink, level="DEBUG", format="{message}", enqueue=False)


def loguru_to_rich(fmt: str) -> str:
    """把 ANR 风格的 <c> 标签转换成 rich 的 [cyan] 标签。"""
    return (
        fmt.replace("<c>", "[cyan]")
        .replace("</c>", "[/cyan]")
        .replace("<m>", "[magenta]")
        .replace("</m>", "[/magenta]")
        .replace("<y>", "[yellow]")
        .replace("</y>", "[/yellow]")
        .replace("<r>", "[red]")
        .replace("</r>", "[/red]")
    )


__all__ = ["logger", "loguru_to_rich"]
