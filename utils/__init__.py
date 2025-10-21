import os
import random
import re
import time

import ujson as json

from utils.logger import logger


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
            tag = read_txt(f"./wildcards/{wild_card[0]}/{wild_card[1]}.txt")
        else:
            tag = read_txt((_path := f"./wildcards/{wild_card[0]}/") + (name := random.choice(os.listdir(_path))))
        text = text.replace(f"<{wild_card[0]}:{wild_card[1]}>", tag)
        logger.debug(f'已将 <{wild_card[0]}:{wild_card[1]}> 替换为 {name}: "{tag}"')
    (logger.info(f"共发现 {len(matchers)} 个 wildcard, 已完成替换!") if len(matchers) != 0 else ...)
    return text


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
