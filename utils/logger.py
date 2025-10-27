import sys

from loguru import logger

from utils.prepare import is_updated

format_ = (
    f"<m>ANR:{is_updated} </m>"
    "| <c>{time:YY-MM-DD HH:mm:ss}</c> "
    "| <c>{module}:{line}</c> "
    "| <level>{level}</level> "
    "| <level>{message}</level>"
)

logger.remove()
logger.add(sys.stdout, format=format_, colorize=True)
