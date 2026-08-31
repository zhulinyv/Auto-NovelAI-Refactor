"""导演工具: Remove BG / Line Art / Sketch / Colorize / Emotion / Declutter。"""

from __future__ import annotations

import os
import random
from pathlib import Path

from PIL import Image

from utils.config import env
from utils.generator import Generator
from utils.helpers import check_stop, format_str, playsound, reset_stop, sleep_for_cool
from utils.image_tools import image_to_base64
from utils.logger import logger
from utils.models import director

generator = Generator("https://image.novelai.net/ai/augment-image")


def _input_images(input_path: str | None, input_image: str | None) -> list[str]:
    """收集待处理图片: 先单张图片, 再目录内全部图片 (同时输入时两者都处理)。"""
    os.makedirs("./outputs", exist_ok=True)
    reset_stop()  # 重置本任务的停止信号
    images = []
    if input_image:
        images.append(input_image)
    if input_path:
        images.extend(str(Path(input_path) / f) for f in sorted(os.listdir(input_path)))
    # 去重 (保留顺序: 先图片, 再目录)
    seen = set()
    result = []
    for img in images:
        key = os.path.abspath(img)
        if key not in seen:
            seen.add(key)
            result.append(img)
    return result


def _process(image_path: str, build_fn, image_type: str) -> str | None:
    logger.info(f"正在处理 {os.path.basename(image_path)} ...")
    with Image.open(image_path) as image:
        w, h = image.size
    json_data = build_fn(width=w, height=h, image=image_to_base64(image_path))
    image_data = generator.generate(json_data)
    if not image_data:
        return None
    return generator.save(image_data, image_type, random.randint(1000000000, 9999999999))


def run_director(kind: str, input_path: str | None, input_image: str | None, options: dict | None = None) -> list[str]:
    """执行指定类型的导演工具处理 (由生图队列调度, augment-image 同样占用通道)。"""
    options = options or {}
    image_list: list[str] = []
    input_images = _input_images(input_path, input_image)
    # 只处理一张图片时无需等待, 直接返回结果
    single = len(input_images) <= 1

    def build(kind, **kwargs):
        if kind == "remove_bg":
            return director.remove_bg(**kwargs)
        if kind == "line_art":
            return director.line_art(**kwargs)
        if kind == "sketch":
            return director.sketch(**kwargs)
        if kind == "colorize":
            return director.colorize(
                defry=int(options.get("defry", 0)),
                prompt=format_str(options.get("prompt", "")),
                **kwargs,
            )
        if kind == "emotion":
            emotion_map = {
                "Normal": 0,
                "Slightly Weak": 1,
                "Weak": 2,
                "Even Weaker": 3,
                "Very Weak": 4,
                "Weakest": 5,
            }
            tag = options.get("tag", "Neutral")
            return director.emotion(
                defry=emotion_map.get(options.get("strength", "Normal"), 0),
                prompt=format_str(f"{tag.lower()};;{options.get('prompt', '')}"),
                **kwargs,
            )
        if kind == "declutter":
            return director.declutter(**kwargs)
        raise ValueError(f"未知的导演工具类型: {kind}")

    for image_path in input_images:
        if check_stop():
            logger.warning("已停止生成!")
            break
        try:
            if kind == "remove_bg":
                # 抠图会返回三张结果 (masked / generated / blend);
                # 若接口只返回一张 (未压缩图片), 则只保存这一张
                with Image.open(image_path) as image:
                    w, h = image.size
                json_data = director.remove_bg(width=w, height=h, image=image_to_base64(image_path))
                result = generator.generate(json_data)
                if isinstance(result, tuple):
                    masked, generated, blend = result
                else:
                    masked, generated, blend = result, None, None
                for data in [masked, generated, blend]:
                    if data:
                        path = generator.save(data, "director/remove_bg", random.randint(1000000000, 9999999999))
                        image_list.append(path)
                # remove_bg 一次返回三张, 每个输入图片只等待一次
                if not single:
                    sleep_for_cool(env.cool_time)
            else:
                path = _process(image_path, lambda **kw: build(kind, **kw), f"director/{kind}")
                if path:
                    image_list.append(path)
                    if not single:
                        sleep_for_cool(env.cool_time)
        except Exception as e:
            logger.error(f"处理 {os.path.basename(image_path)} 失败: {e}")
            logger.opt(exception=True).debug("处理失败堆栈:")
            if not single:
                sleep_for_cool(5)

    playsound("./assets/finish.mp3")
    return image_list
