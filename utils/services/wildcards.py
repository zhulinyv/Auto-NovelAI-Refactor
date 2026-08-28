"""Wildcards 管理服务 (支持图片封面)。"""
from __future__ import annotations

import os
import send2trash
from pathlib import Path

from utils.helpers import format_str, read_txt
from utils.logger import logger

WILDCARDS_DIR = Path("./wildcards")

_COVER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")


def list_types() -> list[str]:
    if not WILDCARDS_DIR.exists():
        return []
    return [d for d in sorted(os.listdir(WILDCARDS_DIR)) if (WILDCARDS_DIR / d).is_dir()]


def list_names(wildcard_type: str) -> list[str]:
    _dir = WILDCARDS_DIR / wildcard_type
    if not _dir.is_dir():
        return []
    return ["随机", "顺序"] + sorted(f.split(".")[0] for f in os.listdir(_dir) if f.endswith(".txt"))


def find_cover(wildcard_type: str, name: str) -> str | None:
    """查找与卡片同名的封面图片 (name.png/jpg/webp 等), 返回路径或 None。"""
    _dir = WILDCARDS_DIR / wildcard_type
    for ext in _COVER_EXTS:
        p = _dir / f"{name}{ext}"
        if p.exists():
            return str(p)
    return None


def list_cards(wildcard_type: str) -> list[dict]:
    """列出某分类下的全部卡片 (含封面信息与内容预览), 便于前端网格展示。"""
    _dir = WILDCARDS_DIR / wildcard_type
    if not _dir.is_dir():
        return []
    cards = []
    for f in sorted(os.listdir(_dir)):
        if not f.endswith(".txt"):
            continue
        name = f[:-4]
        try:
            tags = (_dir / f).read_text(encoding="utf-8").strip()
        except Exception:
            tags = ""
        cards.append({
            "name": name,
            "tags": tags[:200],
            "has_cover": find_cover(wildcard_type, name) is not None,
            "cover": find_cover(wildcard_type, name),
        })
    return cards


def get_tags(wildcard_type: str, wildcard_name: str) -> str | None:
    if wildcard_name in ("随机", "顺序"):
        return None
    return read_txt(WILDCARDS_DIR / wildcard_type / f"{wildcard_name}.txt")


def save_tags(wildcard_type: str, wildcard_name: str, tags: str) -> None:
    _dir = WILDCARDS_DIR / wildcard_type
    _dir.mkdir(parents=True, exist_ok=True)
    (_dir / f"{wildcard_name}.txt").write_text(tags, encoding="utf-8")
    logger.success(f"已保存 wildcard: <{wildcard_type}:{wildcard_name}>")


def save_cover(wildcard_type: str, wildcard_name: str, content: bytes, ext: str = ".png") -> str:
    """保存卡片封面图片, 返回其路径。"""
    _dir = WILDCARDS_DIR / wildcard_type
    _dir.mkdir(parents=True, exist_ok=True)
    # 先删除旧封面 (不同扩展名)
    for old in find_cover(wildcard_type, wildcard_name) or []:
        try:
            os.remove(old)
        except OSError:
            pass
    target = _dir / f"{wildcard_name}{ext}"
    target.write_bytes(content)
    logger.success(f"已保存封面: {target}")
    return str(target)


def save_cover_from_image(wildcard_type: str, wildcard_name: str, image_path: str) -> str:
    """把服务器上已有的图片文件直接复制为卡片封面 (不重新上传), 返回其路径。"""
    import shutil

    _dir = WILDCARDS_DIR / wildcard_type
    _dir.mkdir(parents=True, exist_ok=True)
    for old in find_cover(wildcard_type, wildcard_name) or []:
        try:
            os.remove(old)
        except OSError:
            pass
    ext = Path(image_path).suffix.lower()
    if ext not in _COVER_EXTS:
        ext = ".png"
    target = _dir / f"{wildcard_name}{ext}"
    shutil.copy2(image_path, str(target))
    logger.success(f"已保存封面: {target}")
    return str(target)


def delete(wildcard_type: str, wildcard_name: str) -> None:
    path = WILDCARDS_DIR / wildcard_type / f"{wildcard_name}.txt"
    if path.exists():
        send2trash.send2trash(str(path))
        # 同时删除封面
        cover = find_cover(wildcard_type, wildcard_name)
        if cover:
            send2trash.send2trash(cover)
        logger.info(f"已将 <{wildcard_type}:{wildcard_name}> 移动到回收站")
    else:
        logger.error(f"wildcard 不存在: <{wildcard_type}:{wildcard_name}>")


def add_wildcard_to_prompt(prompt: str, wildcard_type: str, wildcard_name: str) -> str:
    return format_str(f"{prompt}, <{wildcard_type}:{wildcard_name}>")
