"""图片筛选服务: 浏览目录中的图片并移动 / 复制 / 删除 / 撤销。"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from utils.helpers import (
    copy_current_img,
    del_current_img,
    move_current_img,
    show_first_img,
    show_next_img,
)
from utils.logger import logger

# 操作历史: 支持无限制撤销 (每条记录含操作前的队列快照, 用于撤销后索引不向前跳)
_HISTORY: list[dict] = []


def _queue_snapshot():
    """记录操作前待浏览队列的快照 (temp_selector.npy)。"""
    try:
        if os.path.exists("./outputs/temp_selector.npy"):
            return [str(f) for f in np.load("./outputs/temp_selector.npy")]
    except Exception as e:
        logger.error(f"读取队列快照失败: {e}")
    return None


def _record(action, src, dst=None, queue=None):
    _HISTORY.append({"action": action, "src": src, "dst": dst, "queue": queue})


def load(input_path: str):
    _HISTORY.clear()
    return show_first_img(input_path)


def next_img(current_img: str | None = None):
    if current_img:
        _record("skip", current_img, queue=_queue_snapshot())
    return show_next_img()


def move(current_img: str | None, output_path: str):
    if not current_img:
        logger.error("当前未选择图片!")
        return None, None
    queue = _queue_snapshot()
    result = move_current_img(current_img, output_path)
    _record("move", current_img, str(Path(output_path) / Path(current_img).name), queue)
    return result


def copy(current_img: str | None, output_path: str):
    if not current_img:
        logger.error("当前未选择图片!")
        return None, None
    queue = _queue_snapshot()
    result = copy_current_img(current_img, output_path)
    _record("copy", current_img, str(Path(output_path) / Path(current_img).name), queue)
    return result


def delete(current_img: str | None):
    if not current_img:
        logger.error("当前未选择图片!")
        return None, None
    queue = _queue_snapshot()
    trash, images, nxt = del_current_img(current_img)
    if trash:
        _record("delete", current_img, trash, queue)
    return images, nxt


def undo():
    if not _HISTORY:
        return None, None
    entry = _HISTORY.pop()
    action, src, dst = entry["action"], entry["src"], entry["dst"]
    # 恢复操作前的队列快照, 保证撤销后索引不向前跳 (后续操作从当前图片的下一个继续)
    queue = entry.get("queue")
    if queue is not None:
        try:
            np.save("./outputs/temp_selector.npy", np.array(queue))
        except Exception as e:
            logger.error(f"恢复队列失败: {e}")
    try:
        if action == "move":
            shutil.move(dst, src)
            logger.info(f"已撤销移动: {dst} -> {src}")
        elif action == "copy":
            Path(dst).unlink(missing_ok=True)
            logger.info(f"已撤销复制: 删除 {dst}")
        elif action == "delete":
            shutil.move(dst, src)
            logger.info(f"已撤销删除: {dst} -> {src}")
        elif action == "skip":
            logger.info(f"已撤销跳过: 回到 {src}")
        else:
            logger.error(f"未知操作类型: {action}")
            return None, None
    except Exception as e:
        logger.error(f"撤销失败: {e}")
        return None, None
    # 撤销后显示恢复的图片
    try:
        with Image.open(src):
            return [str(src)], src
    except Exception as e:
        logger.error(f"撤销后无法读取图片: {e}")
        return None, None
