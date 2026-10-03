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
from rich.markup import escape
from rich.traceback import Traceback

from utils.events import broker

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
    from utils.variable import VERSION  # 用时导入: variable 依赖 config, config 依赖 logger, 顶层导入会成环

    record = message.record
    level = record["level"].name
    color = LEVEL_COLORS.get(level, "white")
    time_str = datetime.fromtimestamp(record["time"].timestamp()).strftime("%y-%m-%d %H:%M:%S")
    prefix = f"[{color}]{level:<7}[/{color}] | [magenta]ANR: {VERSION}[/magenta] | [cyan]{time_str}[/cyan] | "
    # 正文先做"只转义字面量方括号"的处理 (见 _escape_markup), 否则正文里的 [section] / [a-z]+
    # 会被 rich 当成样式标签吃掉, 只有终端缺字而 Web 端正常, 很难发现。
    msg = _escape_markup(record["message"])
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


# ANR 简写标签 -> rich 颜色名。日志正文里的着色标记**只有** loguru_to_rich() 产出的
# 这几种 (终端前缀用的 [magenta]/[cyan] 是 _terminal_sink 自己拼的, 不进 record["message"])。
# 下面剥标记用的正则就从这个映射生成, 两者不会各自漂移。
ANR_TAG_TO_RICH = {
    "c": "cyan",
    "m": "magenta",
    "y": "yellow",
    "r": "red",
}

# rich 标记只用于终端着色, 推给前端前要剥掉。
#
# 两条约束缺一不可, 否则会静默吃掉日志正文 (终端正常, 只有 Web 端缺字, 极难发现):
#   1) 只认上面这些"本项目确实会产生"的颜色名 —— 通用的 \[[a-z]+\] 会把正文里的
#      "字段 [section] 已跳过" 当成标记删掉;
#   2) 要求成对出现 (开标记 + 闭标记) —— loguru_to_rich() 产出的必定是 <c>x</c> 这种
#      配对形式, 而正文里可能单独出现 "[cyan]" 这样的字面量 (如说明文字), 不该被吞掉。
_COLORS_ALT = "|".join(ANR_TAG_TO_RICH.values())
_MARKUP_PAIR_RX = re.compile(rf"\[(?:{_COLORS_ALT})\](.*?)\[/(?:{_COLORS_ALT})\]", re.DOTALL)
_ORPHAN_MARKUP_RX = re.compile(rf"\[/(?:{_COLORS_ALT})\]")  # 防御: 只留了闭标记的残缺情况
# 按"已知标记"切分正文: 奇数位是标记本身, 偶数位是纯文本 (见 _escape_markup)
_MARKUP_SPLIT_RX = re.compile(rf"(\[/?(?:{_COLORS_ALT})\])")


def _strip_markup(text: str) -> str:
    """剥掉用于终端着色的 rich 标记, 保留正文里的其它方括号。

    成对标记连同标签一起去掉 (内容保留); 落单的闭标记也清掉 (残缺标记不该出现在正文里);
    落单的开标记原样保留 —— 它更可能是正文里的字面量而非标记。
    """
    if not text:
        return text
    out = _MARKUP_PAIR_RX.sub(r"\1", text)
    return _ORPHAN_MARKUP_RX.sub("", out)


def _escape_markup(text: str) -> str:
    """把正文里的方括号转义成 rich 字面量, 但**保留**本项目自己的着色标记。

    终端 sink 把整行交给 rich 解析, 于是正文里的方括号会被 rich 当成样式标签吃掉
    (如 "字段 [section] 已跳过" 显示成 "字段  已跳过", 正则 "[a-z]+" 更会被吞掉一段)。
    rich.markup.escape() 能解决, 但它会把我们要用的 [cyan] 也一起转义掉、导致正文不再着色。

    做法: 先按**已知标记名**把正文切成"标记"与"纯文本"两类片段, 只对纯文本片段转义。
    这样既能原样显示 "[section]"/"[a-z]+" 这类字面量, 又保住了 <c></c> 转换来的真实高亮。
    """
    if not text:
        return text
    parts = _MARKUP_SPLIT_RX.split(text)
    # split 的结果是 [文本, 标记, 文本, 标记, ...]: 偶数下标是文本, 奇数下标是标记
    for i in range(0, len(parts), 2):
        if parts[i]:
            parts[i] = escape(parts[i])
    return "".join(parts)


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
    out = fmt
    for tag, color in ANR_TAG_TO_RICH.items():
        out = out.replace(f"<{tag}>", f"[{color}]").replace(f"</{tag}>", f"[/{color}]")
    return out


__all__ = ["logger", "loguru_to_rich", "ANR_TAG_TO_RICH"]
