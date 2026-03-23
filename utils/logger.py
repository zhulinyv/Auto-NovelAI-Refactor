from loguru import logger
from rich.highlighter import Highlighter
from rich.logging import RichHandler

from utils.variable import VERSION


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


def patcher(record):
    level_name = record["level"].name
    record["extra"]["lvl_color"] = LEVEL_COLORS.get(level_name, "white")


logger = logger.patch(patcher)


rich_format = (
    "[{extra[lvl_color]}]{level: <7}[/{extra[lvl_color]}] | "
    f"[magenta]ANR: {VERSION}[/magenta] | "
    "[cyan]{time:YY-MM-DD HH:mm:ss}[/cyan] | "
    "[{extra[lvl_color]}]{message}[/{extra[lvl_color]}]"
)

logger.remove()
logger.add(
    RichHandler(
        rich_tracebacks=True,
        show_time=False,
        markup=True,
        show_level=False,
        highlighter=DisabledHighlighter(),
    ),
    format=rich_format,
    colorize=False,
)


def loguru_to_rich(fmt: str):
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
