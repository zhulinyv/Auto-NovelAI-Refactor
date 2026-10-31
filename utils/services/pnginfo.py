"""法术解析服务: 读取 / 还原图片元数据。

抹除功能已迁移到「图片工具」插件的「清除元数据」面板, 本模块只负责读取与还原生成参数。
"""

from __future__ import annotations

import ujson

from utils.helpers import float_to_position
from utils.image_tools import get_image_information
from utils.prompt_text import strip_text_section
from utils.variable import TAG_HINT_PRESET_IDS, return_model_from_source


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


def _tag_hint_preset_id(value):
    """官网 tag_hint 数字码 -> 预设 id; None / 非法值返回 None (调用方回落文本识别)。"""
    # bool 是 int 的子类, 这里必须排掉, 否则 True 会被当成 1 (standard)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return TAG_HINT_PRESET_IDS.get(value)


def pnginfo_to_generate(image_path: str) -> dict:
    """把图片元数据转换为生成参数 (供前端填入表单)。

    预设与透明背景优先按官网写入的 tag_hint_* 三字段判定 (见 2026-10-30 抓包结论);
    这三个字段缺失或为 null 时返回 None, 前端保留原有的"从提示词文本里剥离预设"逻辑。
    """
    pnginfo = get_image_information(image_path)
    comment = _parse_comment(pnginfo)

    # tag_hint_qt / tag_hint_uc_preset: 预设 id 的数字码 (0-8), 官网所有模型都会写
    quality_preset_id = _tag_hint_preset_id(comment.get("tag_hint_qt"))
    uc_preset_id = _tag_hint_preset_id(comment.get("tag_hint_uc_preset"))
    # tag_hint_transparent_background: 只在开启时写入 true; 缺省 (老图) 时回落文本识别
    tb_raw = comment.get("tag_hint_transparent_background")
    transparent_bg = True if tb_raw is True else (False if tb_raw is False else None)

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

    # 正面提示词只带 tag: teXt 段及其后面的内容一概不要 (下次生成会按当前输入重新拼装),
    # 否则"法术解析 / 画廊 -> 发送到图片生成"会把上一次的 teXt 段再带一遍
    positive = comment.get("prompt") or pnginfo.get("Description") or ""

    return {
        "positive_prompt": strip_text_section(positive),
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
        # 以下四项供前端优先判定, None 表示元数据未记录/无法识别 -> 回落到原有逻辑
        "model": return_model_from_source(pnginfo.get("Source")),
        "quality_preset_id": quality_preset_id,
        "uc_preset_id": uc_preset_id,
        "transparent_bg": transparent_bg,
    }
