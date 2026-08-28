"""法术解析服务: 读取 / 应用 / 抹除图片元数据。"""
from __future__ import annotations

import json
import os
from pathlib import Path

import ujson
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from utils.config import env
from utils.helpers import format_str, float_to_position, playsound, read_json
from utils.image_tools import get_image_information
from utils.logger import logger
from utils.naimeta import inject_data


def get_pnginfo(image_path: str | None):
    """读取图片的全部元数据。"""
    if not image_path:
        return None
    pnginfo = get_image_information(image_path)
    return {
        "source": pnginfo.get("Source"),
        "generation_time": pnginfo.get("Generation time"),
        "comment": pnginfo.get("Comment"),
        "description": pnginfo.get("Description"),
        "software": pnginfo.get("Software"),
        "all": pnginfo,
    }


def _parse_comment(pnginfo: dict) -> dict:
    comment = pnginfo.get("Comment")
    if isinstance(comment, str):
        try:
            return ujson.loads(comment)
        except Exception:
            return {}
    if isinstance(comment, dict):
        return comment
    return {}


def pnginfo_to_generate(image_path: str) -> dict:
    """把图片元数据转换为生成参数 (供前端填入表单)。"""
    pnginfo = get_image_information(image_path)
    comment = _parse_comment(pnginfo)

    characters = []
    char_captions = comment.get("v4_prompt", {}).get("caption", {}).get("char_captions", [])
    neg_char_captions = comment.get("v4_negative_prompt", {}).get("caption", {}).get("char_captions", [])
    for i, cap in enumerate(char_captions):
        centers = cap.get("centers", [{}])
        x = centers[0].get("x", 0.1) if centers else 0.1
        y = centers[0].get("y", 0.1) if centers else 0.1
        neg = neg_char_captions[i].get("char_caption", "") if i < len(neg_char_captions) else ""
        characters.append(
            {
                "prompt": cap.get("char_caption", ""),
                "negative_prompt": neg,
                "position": float_to_position(x, y),
                "enabled": True,
            }
        )

    return {
        "positive_prompt": comment.get("prompt") or pnginfo.get("Description") or "",
        "negative_prompt": comment.get("uc") or "",
        "width": comment.get("width", 832),
        "height": comment.get("height", 1216),
        "steps": comment.get("steps", 23),
        "scale": comment.get("scale", 5),
        "cfg_rescale": comment.get("cfg_rescale", 0),
        "variety": bool(comment.get("skip_cfg_above_sigma")),
        "decrisp": comment.get("dynamic_thresholding", False),
        "sm": comment.get("sm", False),
        "sm_dyn": comment.get("sm_dyn", False),
        "seed": str(comment.get("seed", "-1")),
        "sampler": comment.get("sampler", "k_euler_ancestral"),
        "noise_schedule": comment.get("noise_schedule", "karras"),
        "legacy_uc": comment.get("v4_prompt", {}).get("legacy_uc", False),
        "ai_choice": not comment.get("v4_prompt", {}).get("use_coords", False),
        "characters": characters,
    }


def remove_pnginfo(image_path: str | None, batch_path: str | None, choices: list[str], info: str) -> str:
    """清除图片元数据 (单张和批处理可同时提供, 先处理单张再处理目录), 可追加自定义信息。"""
    file_list = []
    if image_path:
        file_list.append(image_path)
    if batch_path:
        _dir = Path(batch_path)
        if not _dir.is_dir():
            raise ValueError("批处理路径无效")
        file_list.extend(
            str(_dir / f) for f in os.listdir(_dir) if f.lower().endswith((".png", ".jpg", ".jpeg"))
        )
    if not file_list:
        raise ValueError("请提供图片或批处理路径")
    # 去重 (保留顺序: 先单张图片, 再目录)
    seen = set()
    unique = []
    for file in file_list:
        key = os.path.abspath(file)
        if key not in seen:
            seen.add(key)
            unique.append(file)
    file_list = unique

    metadata = PngInfo()
    if info:
        metadata.add_text("Auto-NovelAI-Refactor", info)

    last_path = ""
    for file in file_list:
        logger.info(f"正在清除 {os.path.basename(file)} 的元数据...")
        with Image.open(file) as img:
            img = inject_data(img, metadata, choices)
            img.save(last_path := str(Path(file)))
        logger.success("清除成功!")

    playsound("./assets/finish.mp3")
    return f"清除成功! 图片已保存到 {os.path.dirname(os.path.abspath(last_path))}"
