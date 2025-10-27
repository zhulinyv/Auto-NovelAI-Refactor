import os
import random
from pathlib import Path

import ujson as json
from PIL import Image

from utils import format_str, playsound, read_json
from utils.generator import Generator
from utils.image_tools import image_to_base64
from utils.logger import logger
from utils.models import director

generator = Generator("https://image.novelai.net/ai/augment-image")


def before_process(director_input_path, director_input_image):
    with open("./outputs/temp_break.json", "w") as f:
        json.dump({"break": False}, f)

    if director_input_image:
        image_list = [director_input_image]
    else:
        image_list = [Path(director_input_path) / file for file in os.listdir(director_input_path)]

    return image_list


def remove_bg(director_input_path, director_input_image):
    image_list = []

    for image_path in before_process(director_input_path, director_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        logger.info(f"正在处理 {os.path.basename(image_path)} ...")

        with Image.open(image_path) as image:
            w, h = image.size

        json_data = director.remove_bg(width=w, height=h, image=image_to_base64(image_path))
        masked, generated, blend = generator.generate(json_data)

        for image_data in [masked, generated, blend]:
            if image_data:
                path = generator.save(masked, "director/remove_bg", random.randint(1000000000, 9999999999))
                image_list.append(path)

    playsound("./assets/finish.mp3")

    return image_list


def line_art(director_input_path, director_input_image):
    image_list = []

    for image_path in before_process(director_input_path, director_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        logger.info(f"正在处理 {os.path.basename(image_path)} ...")

        with Image.open(image_path) as image:
            w, h = image.size

        json_data = director.line_art(width=w, height=h, image=image_to_base64(image_path))
        image_data = generator.generate(json_data)

        if image_data:
            path = generator.save(image_data, "director/line_art", random.randint(1000000000, 9999999999))
            image_list.append(path)

    playsound("./assets/finish.mp3")

    return image_list


def sketch(director_input_path, director_input_image):
    image_list = []

    for image_path in before_process(director_input_path, director_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        logger.info(f"正在处理 {os.path.basename(image_path)} ...")

        with Image.open(image_path) as image:
            w, h = image.size

        json_data = director.sketch(width=w, height=h, image=image_to_base64(image_path))
        image_data = generator.generate(json_data)

        if image_data:
            path = generator.save(image_data, "director/sketch", random.randint(1000000000, 9999999999))
            image_list.append(path)

    playsound("./assets/finish.mp3")

    return image_list


def colorize(director_input_path, director_input_image, colorize_defry, colorize_prompt):
    image_list = []

    for image_path in before_process(director_input_path, director_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        logger.info(f"正在处理 {os.path.basename(image_path)} ...")

        with Image.open(image_path) as image:
            w, h = image.size

        json_data = director.colorize(
            width=w,
            height=h,
            image=image_to_base64(image_path),
            defry=colorize_defry,
            prompt=format_str(colorize_prompt),
        )
        image_data = generator.generate(json_data)

        if image_data:
            path = generator.save(image_data, "director/colorize", random.randint(1000000000, 9999999999))
            image_list.append(path)

    playsound("./assets/finish.mp3")

    return image_list


def emotion(director_input_path, director_input_image, emotion_tag: str, emotion_strength, emotion_prompt):
    image_list = []

    for image_path in before_process(director_input_path, director_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        logger.info(f"正在处理 {os.path.basename(image_path)} ...")

        with Image.open(image_path) as image:
            w, h = image.size

        emotion_defry = {"Normal": 0, "Slightly Weak": 1, "Weak": 2, "Even Weaker": 3, "Very Weak": 4, "Weakest": 5}

        json_data = director.emotion(
            width=w,
            height=h,
            image=image_to_base64(image_path),
            defry=emotion_defry.get(emotion_strength),
            prompt=format_str(emotion_tag.lower() + f";;{emotion_prompt}"),
        )
        image_data = generator.generate(json_data)

        if image_data:
            path = generator.save(image_data, "director/emotion", random.randint(1000000000, 9999999999))
            image_list.append(path)

    playsound("./assets/finish.mp3")

    return image_list


def declutter(director_input_path, director_input_image):
    image_list = []

    for image_path in before_process(director_input_path, director_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        logger.info(f"正在处理 {os.path.basename(image_path)} ...")

        with Image.open(image_path) as image:
            w, h = image.size

        json_data = director.declutter(width=w, height=h, image=image_to_base64(image_path))
        image_data = generator.generate(json_data)

        if image_data:
            path = generator.save(image_data, "director/declutter", random.randint(1000000000, 9999999999))
            image_list.append(path)

    playsound("./assets/finish.mp3")

    return image_list
