import asyncio
import os
import random
import re
import time
import tkinter as tk
from pathlib import Path
from tkinter.filedialog import askopenfilename

import numpy as np
import ujson as json
from gradio_client import Client, handle_file
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from utils.environment import env
from utils.logger import logger
from utils.naimeta import inject_data


def generate_random_str(randomlength):
    random_str = ""
    base_str = "ABCDEFGHIGKLMNOPQRSTUVWXYZabcdefghigklmnopqrstuvwxyz0123456789"
    length = len(base_str) - 1
    for i in range(randomlength):
        random_str += base_str[random.randint(0, length)]
    return random_str


def list_to_str(str_list: list[str]):
    empty_str = ""
    for i in str_list:
        empty_str += f"{i},"
    return format_str(empty_str)


def format_str(text):
    lines = text.splitlines(keepends=True)
    formatted_lines = []
    for line in lines:
        if not line.endswith("\n"):
            result = re.sub(r"[,\s]*,[,\s]*", ", ", line)
            result = re.sub(r" +", " ", result)
            result = result.strip()
            formatted_lines.append(result)
        else:
            content = line[:-1]
            if content:
                result = re.sub(r"[,\s]*,[,\s]*", ", ", content)
                result = re.sub(r" +", " ", result)
                result = result.strip()
                formatted_lines.append(result + "\n")
            else:
                formatted_lines.append("\n")
    return "".join(formatted_lines)


def return_x64(_int: int):
    if _int <= 64:
        _int = 64
    elif _int % 64 == 0:
        pass
    elif _int / 64 % 1 >= 0.5:
        _int = (_int // 64 + 1) * 64
    else:
        _int = (_int // 64) * 64
    return _int


def read_txt(path):
    with open(path, "r", encoding="utf-8") as file:
        return file.read()


def read_json(path):
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file)


def replace_wildcards(text: str):
    pattern = r"<([^:]+):([^>]+)>"
    matchers = re.findall(pattern, text)
    for wild_card in matchers:
        if wild_card[1] != "随机":
            name = wild_card[1]
            tag = read_txt(f"./wildcards/{wild_card[0]}/{wild_card[1]}.txt")
        else:
            tag = read_txt((_path := f"./wildcards/{wild_card[0]}/") + (name := random.choice(os.listdir(_path))))
        text = text.replace(f"<{wild_card[0]}:{wild_card[1]}>", tag)
        logger.debug(f'已将 <{wild_card[0]}:{wild_card[1]}> 替换为 {name}: "{tag}"')
    (logger.info(f"共发现 {len(matchers)} 个 wildcard, 已完成替换!") if len(matchers) != 0 else ...)
    return format_str(text)


def sleep_for_cool(seconds):
    sleep_time = round(random.uniform(abs(seconds - 1), seconds + 1), 3)
    logger.debug(f"等待 {sleep_time} 秒后继续...")
    time.sleep(sleep_time)
    return


def return_last_value(_dict):
    return list(_dict.values())[-1]


def position_to_float(position: str):
    offset = 0.1
    letter_dict = {chr(65 + i): i * 0.2 + offset for i in range(5)}
    number_dict = {str(i + 1): i * 0.2 + offset for i in range(5)}
    letter, number = position
    return round(letter_dict[letter], 1), round(number_dict[number], 1)


def float_to_position(letter_float: float, number_float: float) -> str:
    offset = 0.1
    letter_dict = {chr(65 + i): i * 0.2 + offset for i in range(5)}
    number_dict = {str(i + 1): i * 0.2 + offset for i in range(5)}
    letter = min(letter_dict, key=lambda x: abs(letter_dict[x] - letter_float))
    number = min(number_dict, key=lambda x: abs(number_dict[x] - number_float))
    return letter + number


def stop_generate():
    logger.warning("正在停止生成...")
    with open("./outputs/temp_break.json", "w") as f:
        json.dump({"break": True}, f)
    return


def tagger(image_path, model_repo, general_thresh, general_mcut_enabled, character_thresh, character_mcut_enabled):
    def format_dict(_dict):
        try:
            _list = _dict["confidences"]
            _dict = {}
            for i in _list:
                _dict.update({i["label"]: i["confidence"]})
            return _dict
        except KeyError:
            return None

    client = Client("SmilingWolf/wd-tagger", verbose=False)

    times = 0
    while times < 5:
        try:
            result = client.predict(
                image=handle_file(image_path),
                model_repo=model_repo,
                general_thresh=general_thresh,
                general_mcut_enabled=general_mcut_enabled,
                character_thresh=character_thresh,
                character_mcut_enabled=character_mcut_enabled,
                api_name="/predict",
            )
            logger.success("反推成功!")
            break
        except Exception as e:
            logger.error(f"出现错误: {e}")
            logger.info("正在重试...")
            times += 1
    return result[0], format_dict(result[1]), format_dict(result[2]), format_dict(result[3])


def tk_window_asksavefile(init_dir=os.getcwd(), suffix="") -> str:
    window = tk.Tk()
    window.wm_attributes("-topmost", 1)
    window.withdraw()
    filename = askopenfilename(initialdir=init_dir, filetypes=[("", suffix)])
    return filename


async def tk_asksavefile_asy(init_dir=os.getcwd(), suffix="") -> str:
    fname = await asyncio.to_thread(tk_window_asksavefile, init_dir, suffix)
    return fname


def return_array_image(path):
    if path:
        with Image.open(path) as image:
            return np.array(image)


def remove_pnginfo(image, path, choices, info):
    if image:
        file_list = [image]
    else:
        file_list = [Path(path) / file for file in os.listdir(path)]

    metadata = PngInfo()
    if info:
        metadata.add_text("Auto-NovelAI-Refactor", info)

    for file in file_list:
        logger.warning(f"正在清除 {os.path.basename(file)} 的元数据...")
        with Image.open(file) as img:
            img = inject_data(img, metadata, choices)
            img.save(_path := Path(file))
        logger.success("清除成功!")

    playsound("./assets/finish.mp3")

    return f"清除成功! 图片已保存到 {os.path.dirname(os.path.abspath(_path))}"


try:
    from playsound import playsound as _playsound

    def playsound(file_path):
        if file_path == "./assets/llss.mp3" and not env.start_sound:
            return
        elif file_path == "./assets/finish.mp3" and not env.finish_sound:
            return
        _playsound(file_path)
        return

except Exception:

    def playsound(file_path):
        logger.warning("playsound 导入失败, 无法播放提示音!")
        return
