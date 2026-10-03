"""图片文件收集与排序: 全项目唯一的"什么是图片 / 怎么排序"真源。

背景: 此前"收集单图 + 目录内图片 + 去重 + 自然排序"在 6 处各写了一份, 扩展名集合
分成 4 套、排序规则分成 2 套 (src/upscale_images.py 与 src/director_tools.py 甚至
完全不按扩展名过滤, 目录里混进的 .txt 会被送去超分)。这里统一到一个实现。

自然排序: `2.png` 排在 `10.png` 之前 (序列帧合成动图 / 拼图顺序都依赖它)。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# 支持处理的图片扩展名 (小写, 含点)。新增格式只改这一处。
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".ico", ".gif"}

# 视频抽帧等场景只认这些 (与 IMAGE_EXTS 分开: .gif/.ico 当帧处理没有意义)
FRAME_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}

_NATURAL_RX = re.compile(r"(\d+)")


def natural_key(text: str) -> list:
    """自然排序键: 把连续数字段按数值比较, 其余按小写文本比较。"""
    return [int(part) if part.isdigit() else part.lower() for part in _NATURAL_RX.split(text)]


def sort_images(paths: list[str]) -> list[str]:
    """按文件名自然排序。"""
    return sorted(paths, key=lambda p: natural_key(os.path.basename(p)))


def is_image(path: str | Path, exts: set[str] | None = None) -> bool:
    """扩展名是否为受支持的图片。"""
    return Path(path).suffix.lower() in (exts or IMAGE_EXTS)


def list_images(directory: str | Path, exts: set[str] | None = None, recursive: bool = False) -> list[str]:
    """列出目录内的图片 (默认非递归, 按文件名自然排序)。

    用 os.scandir: Windows 上 DirEntry 自带 stat 信息, 无需逐文件再 stat。
    不存在的目录返回空列表 (不抛错: 调用方多为"尽力而为"的批处理)。
    """
    root = Path(directory)
    if not root.is_dir():
        return []
    allowed = exts or IMAGE_EXTS
    found: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if recursive:
                                stack.append(Path(entry.path))
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                    except OSError:
                        continue
                    if Path(entry.name).suffix.lower() in allowed:
                        found.append(entry.path)
        except OSError:
            continue
    return sort_images(found)


def collect_images(
    path: str | None,
    image: str | None = None,
    exts: set[str] | None = None,
) -> list[str]:
    """收集待处理图片: 先单张图片, 再目录内全部图片 (同时给出时两者都处理)。

    - 目录按文件名自然排序; 只收集扩展名受支持的文件
    - 按绝对路径去重, 保留首次出现的顺序 (先单图, 后目录)
    - 路径既不是文件也不是目录时抛 ValueError (与原各实现的报错语义一致)
    """
    images: list[str] = []
    if image:
        images.append(image)
    raw_path = (path or "").strip()
    if raw_path:
        root = Path(raw_path)
        if root.is_file():
            images.append(str(root))
        elif root.is_dir():
            images.extend(list_images(root, exts=exts))
        else:
            raise ValueError(f"路径无效: {raw_path}")
    result: list[str] = []
    seen: set[str] = set()
    for img in images:
        key = os.path.abspath(img)
        if key not in seen:
            seen.add(key)
            result.append(img)
    return result


__all__ = [
    "IMAGE_EXTS",
    "FRAME_EXTS",
    "natural_key",
    "sort_images",
    "is_image",
    "list_images",
    "collect_images",
]
