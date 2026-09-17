"""法术解析服务: 读取 / 还原图片元数据。

抹除功能已迁移到「图片工具」插件的「清除元数据」面板, 本模块只负责读取与还原生成参数。
"""

from __future__ import annotations

import ujson

from utils.helpers import float_to_position
from utils.image_tools import get_image_information


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
                # 网格标签 (v4/v4.5 grid 模式); 原始浮点坐标一并给出 (v5 free 模式不丢精度)
                "position": float_to_position(x, y),
                "xy": [round(float(x), 4), round(float(y), 4)],
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
