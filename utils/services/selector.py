"""图片筛选服务: 浏览目录中的图片并移动 / 复制 / 删除 / 撤销。

所有操作返回 (图片列表, 当前图, 错误信息):
- 正常推进/无更多图片 → 错误为 None (current=None 即真的浏览完)
- 前置条件不满足或文件操作失败 → 返回错误信息, 不改动队列与历史,
  避免前端把"失败/没有可撤销"误显示成"已浏览完所有图片"。
"""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
from PIL import Image

from utils.helpers import (
    clear_selector_trash,
    copy_current_img,
    del_current_img,
    move_current_img,
    show_first_img,
    show_next_img,
)
from utils.logger import logger

_QUEUE_FILE = "./outputs/temp_selector.npy"
# 操作历史: 支持无限制撤销 (每条记录含操作前的队列快照, 用于撤销后索引不向前跳)
_HISTORY: list[dict] = []


def _queue_snapshot():
    """记录操作前待浏览队列的快照 (temp_selector.npy)。"""
    try:
        if Path(_QUEUE_FILE).exists():
            return [str(f) for f in np.load(_QUEUE_FILE)]
    except Exception as e:
        logger.error(f"读取队列快照失败: {e}")
    return None


def _record(action, src, dst=None, queue=None):
    _HISTORY.append({"action": action, "src": src, "dst": dst, "queue": queue})


def load(input_path: str):
    _HISTORY.clear()
    clear_selector_trash()
    images, current = show_first_img(input_path)
    if current is None:
        return None, None, "该目录中没有可读取的图片"
    return images, current, None


def next_img(current_img: str | None = None):
    if current_img:
        _record("skip", current_img, queue=_queue_snapshot())
    images, current = show_next_img()
    return images, current, None


def move(current_img: str | None, output_path: str):
    if not current_img:
        return None, None, "当前没有正在浏览的图片"
    if not output_path:
        return None, None, "请先填写目标目录"
    queue = _queue_snapshot()
    dst = str(Path(output_path) / Path(current_img).name)
    images, current, err = move_current_img(current_img, output_path)
    if err:
        return None, None, err  # 移动失败: 不推进队列, 不记历史
    _record("move", current_img, dst, queue)
    return images, current, None


def copy(current_img: str | None, output_path: str):
    if not current_img:
        return None, None, "当前没有正在浏览的图片"
    if not output_path:
        return None, None, "请先填写目标目录"
    queue = _queue_snapshot()
    dst = str(Path(output_path) / Path(current_img).name)
    images, current, err = copy_current_img(current_img, output_path)
    if err:
        return None, None, err  # 复制失败: 不推进队列, 不记历史
    _record("copy", current_img, dst, queue)
    return images, current, None


def delete(current_img: str | None):
    if not current_img:
        return None, None, "当前没有正在浏览的图片"
    queue = _queue_snapshot()
    trash, images, nxt = del_current_img(current_img)
    if trash is None:
        return None, None, "删除失败 (详见后端日志)"
    _record("delete", current_img, trash, queue)
    return images, nxt, None


def undo():
    if not _HISTORY:
        return None, None, "没有可撤销的操作"
    entry = _HISTORY[-1]  # 先窥视: 文件恢复失败时不弹历史、不动队列, 保证状态一致
    action, src, dst = entry["action"], entry["src"], entry["dst"]
    try:
        if action == "move":
            shutil.move(dst, src)
            logger.info(f"已撤销移动: {dst} -> {src}")
        elif action == "copy":
            Path(dst).unlink(missing_ok=True)
            logger.info(f"已撤销复制: 删除 {dst}")
        elif action == "delete":
            # 删除时图片移入 outputs/selector_trash, 撤销即移回原位
            shutil.move(dst, src)
            logger.info(f"已撤销删除: {dst} -> {src}")
        elif action == "skip":
            logger.info(f"已撤销跳过: 回到 {src}")
        else:
            logger.error(f"未知操作类型: {action}")
    except Exception as e:
        logger.error(f"撤销失败: {e}")
        return None, None, f"撤销失败: {e}"
    _HISTORY.pop()
    # 恢复操作前的队列快照, 保证撤销后索引不向前跳 (后续操作从当前图片的下一个继续)
    queue = entry.get("queue")
    if queue is not None:
        try:
            np.save(_QUEUE_FILE, np.array(queue))
        except Exception as e:
            logger.error(f"恢复队列失败: {e}")
    # 撤销后显示恢复的图片; 若该文件已被外部删除, 顺延展示队列中下一张可读图片
    try:
        with Image.open(src):
            return [str(src)], src, None
    except Exception:
        logger.warning(f"撤销后无法读取 {src}, 顺延下一张")
        images, current = show_next_img()
        return images, current, None
