"""图片反推服务: 调用 HuggingFace 的 wd-tagger。"""
from __future__ import annotations

from utils.logger import logger

TAGGER_MODELS = [
    "SmilingWolf/wd-swinv2-tagger-v3",
    "SmilingWolf/wd-convnext-tagger-v3",
    "SmilingWolf/wd-vit-tagger-v3",
    "SmilingWolf/wd-vit-large-tagger-v3",
    "SmilingWolf/wd-eva02-large-tagger-v3",
    "SmilingWolf/wd-v1-4-moat-tagger-v2",
    "SmilingWolf/wd-v1-4-swinv2-tagger-v2",
    "SmilingWolf/wd-v1-4-convnext-tagger-v2",
    "SmilingWolf/wd-v1-4-convnextv2-tagger-v2",
    "SmilingWolf/wd-v1-4-vit-tagger-v2",
    "deepghs/idolsankaku-swinv2-tagger-v1",
    "deepghs/idolsankaku-eva02-large-tagger-v1",
]


def format_dict(_dict):
    try:
        _list = _dict["confidences"]
        return {i["label"]: i["confidence"] for i in _list}
    except (KeyError, TypeError):
        return None


def tagger(image_path, model_repo, general_thresh, general_mcut, character_thresh, character_mcut):
    """反推图片标签, 最多重试 5 次。"""
    from gradio_client import Client, handle_file

    logger.info("正在尝试反推...")
    times = 0
    result = None
    while times < 5:
        try:
            client = Client("SmilingWolf/wd-tagger", verbose=False)
            result = client.predict(
                image=handle_file(image_path),
                model_repo=model_repo,
                general_thresh=general_thresh,
                general_mcut_enabled=general_mcut,
                character_thresh=character_thresh,
                character_mcut_enabled=character_mcut,
                api_name="/predict",
            )
            logger.success("反推成功!")
            break
        except Exception as e:
            logger.error(f"反推失败: {e}")
            logger.info("正在重试...") if times < 4 else None
            times += 1
    if result is None:
        raise RuntimeError("反推失败, 请稍后重试")
    return result[0], format_dict(result[1]), format_dict(result[2]), format_dict(result[3])
