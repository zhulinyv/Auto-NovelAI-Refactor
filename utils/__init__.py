import asyncio
import importlib
import os
import random
import re
import shutil
import subprocess
import sys
import time
import tkinter as tk
import zipfile
from pathlib import Path
from tkinter.filedialog import askopenfilename

import numpy as np
import requests
import send2trash
import ujson as json

from utils.variable import BASE_PATH

try:
    from git import Repo
except Exception:
    os.environ["PATH"] = os.path.abspath("./Git/cmd")
    from git import Repo
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

    logger.info("正在尝试反推...")
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


def restart():
    logger.warning("开始重启...")
    p = sys.executable
    os.execl(p, p, *sys.argv)


def check_update(repo_path):
    try:
        if env.check_update:
            repo = Repo(repo_path)
            current_branch = repo.active_branch
            remote_ref = f"origin/{current_branch.name}"

            if remote_ref not in repo.references:
                return False, "远程分支不存在"

            local_commit = current_branch.commit.hexsha
            remote_commit = repo.references[remote_ref].commit.hexsha

            return local_commit == remote_commit, local_commit + " (更新可用)"
        else:
            return False, "更新检查已关闭"

    except Exception as e:
        return False, str(e)


def download(url, saved_path):
    rep = requests.get(
        url,
        proxies=(
            {
                "http": env.proxy,
                "https": env.proxy,
            }
            if env.proxy is not None
            else None
        ),
        stream=True,
    )
    with open(saved_path, "wb") as file:
        for chunk in rep.iter_content(chunk_size=256):
            file.write(chunk)
    return


def extract(file_path, otp_path):
    with zipfile.ZipFile(file_path) as zip:
        zip.extractall(otp_path)
    os.remove(file_path)
    return


def show_first_img(input_path):
    try:
        file_list: list = os.listdir(input_path)
        new_list = []
        for file in file_list:
            if file[-4:] in [".png", ".jpg"]:
                new_list.append(str(Path(input_path) / file))
        file_list = new_list[:]
        if file_list != []:
            img_path = file_list[0]
        else:
            img_path = None
        file_list.remove(img_path)
        array_data = np.array(file_list)
        np.save("./outputs/temp.npy", array_data)
        with Image.open(img_path) as img:
            return [np.array(img)], img_path
    except Exception:
        logger.error("未输入图片目录或输入的目录为空!")
        return None, None


def show_next_img():
    try:
        if os.path.exists("./outputs/temp.npy"):
            file_list = np.load("./outputs/temp.npy")
            file_list = list(file_list)
            new_list = []
            for file in file_list:
                new_list.append(str(file))
            file_list = new_list[:]
            try:
                img_path = file_list[0]
                if file_list != []:
                    file_list.remove(file_list[0])
                    array_data = np.array(file_list)
                    np.save("./outputs/temp.npy", array_data)
                    with Image.open(img_path) as img:
                        return [np.array(img)], img_path
            except Exception:
                os.remove("./outputs/temp.npy")
        return None, None
    except Exception:
        logger.error("未输入图片目录或输入的目录为空!")
        return None, None


def move_current_img(current_img, output_path):
    try:
        img_name = os.path.basename(current_img)
        shutil.move(current_img, str(Path(output_path) / img_name))
        logger.info(f"已将 {current_img} 移动到 {output_path}")
        return show_next_img()
    except Exception:
        logger.error("未输入要移动的目录!")
        return None, None


def del_current_img(current_img):
    try:
        if current_img:
            send2trash.send2trash(current_img)
            logger.info(f"已将 {current_img} 移动到回收站")
            return show_next_img()
        else:
            logger.error("当前未选择图片!")
            pass
    except Exception:
        logger.error("当前未选择图片!")
        return None, None
    os.chdir(BASE_PATH)


def copy_current_img(current_img, output_path):
    try:
        img_name = os.path.basename(current_img)
        shutil.copyfile(current_img, str(Path(output_path) / img_name))
        logger.info(f"已将 {current_img} 复制到 {output_path}")
        return show_next_img()
    except Exception:
        logger.error("未输入要复制的目录!")
        return None, None


def install_requirements(path):
    # logger.debug(f"开始安装所需依赖 {path}...")
    command = f"{sys.executable} -s -m pip install -r {path}"
    subprocess.call(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # logger.success("安装完成!")
    return


def load_plugins(directory: str):
    plugins = {}
    plugin_list = os.listdir(directory)
    for plugin in plugin_list:
        if plugin.endswith(".py"):
            location = os.path.join(directory, plugin)
        elif plugin != "__pycache__":
            if os.path.exists(requirements_path := os.path.join(directory, plugin, "requirements.txt")):
                install_requirements(requirements_path)
            location = os.path.join(directory, plugin, "__init__.py")
        else:
            location = None
        if location:
            plugin_name = plugin
            module_name = f"{directory}.{plugin_name}"
            spec = importlib.util.spec_from_file_location(module_name, location)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            plugins[plugin_name] = module
            logger.success(f"成功加载插件: {plugin}")
        else:
            logger.error(f"插件: {plugin} 没有 plugin 函数!")
    return plugins


def get_plugin_list():
    try:
        plugins: dict = requests.get(
            "https://raw.githubusercontent.com/zhulinyv/Auto-NovelAI-Refactor/main/assets/plugins.json",
            proxies=(
                {
                    "http": env.proxy,
                    "https": env.proxy,
                }
                if env.proxy is not None
                else None
            ),
        ).json()
    except Exception:
        plugins: dict = read_json("./assets/plugins.json")
    return plugins


def plugin_list():
    plugins = get_plugin_list()

    md = """| 名称(Name) | 描述(Description) | 仓库(URL) | 作者(Author) | 状态(Status) |
| :---: | :---: | :---: | :---: | :---: |
"""
    for plugin in list(plugins.keys()):
        if os.path.exists(
            path := "./plugins/{}".format(
                plugins[plugin]["name"],
            )
        ):
            if not env.check_update:
                status = "已安装"
            else:
                _status, commit = check_update(path)
                if _status:
                    status = "已安装"
                else:
                    if commit not in [
                        "远程分支不存在",
                        "更新检查已关闭",
                    ]:
                        status = "更新可用"
                    else:
                        status = "版本检查失败"
        else:
            status = "未安装"
        md += "| {} | {} | [{}]({}) | {} | {} |\n".format(
            plugins[plugin]["name"],
            plugins[plugin]["description"],
            plugins[plugin]["url"],
            plugins[plugin]["url"],
            plugins[plugin]["author"],
            status,
        )
    return md


def uninstall_plugin(name):
    data = get_plugin_list()
    shutil.rmtree("./plugins/{}".format(data[name]["name"]))
