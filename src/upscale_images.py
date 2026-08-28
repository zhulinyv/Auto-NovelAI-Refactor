"""超分降噪: realcugan-ncnn-vulkan / Anime4K / waifu2x-caffe (仅 Windows)。"""
from __future__ import annotations

import os
import platform
import subprocess
from pathlib import Path

import ujson as json

from utils.config import env
from utils.helpers import check_stop, download, extract, playsound
from utils.image_tools import revert_image_info
from utils.jobs import single_job
from utils.logger import logger


def _input_images(input_path: str | None, input_image: str | None) -> list[str]:
    """收集待处理图片: 先单张图片, 再目录内全部图片 (同时输入时两者都处理)。"""
    os.makedirs("./outputs", exist_ok=True)
    with open("./outputs/temp_break.json", "w") as f:
        json.dump({"break": False}, f)
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


def _ensure_windows() -> bool:
    if platform.system() != "Windows":
        logger.error("仅支持 Windows 运行!")
        return False
    return True


def run_cmd(code: str):
    try:
        p = subprocess.Popen(code, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = p.communicate()
        return (stdout or stderr).decode("gb18030", errors="ignore").strip()
    except Exception as e:
        logger.error(f"命令执行失败: {e}")
        logger.opt(exception=True).debug("命令执行失败堆栈:")
        return None


@single_job("超分降噪")
def run_upscale(kind: str, input_path: str | None, input_image: str | None, options: dict | None = None) -> list[str]:
    """执行指定类型的超分处理。"""
    if not _ensure_windows():
        return []
    options = options or {}
    image_list: list[str] = []
    # 前端把引擎类型放在 kind 字段 (realcugan / anime4k / waifu2x),
    # 这里以 kind 作为引擎选择, 避免所有引擎都走 realcugan
    env_name = kind

    if env_name == "realcugan" and not os.path.exists("./assets/realcugan-ncnn-vulkan"):
        logger.debug("正在下载 realcugan-ncnn-vulkan 超分引擎")
        download(
            "https://huggingface.co/datasets/Xytpz/ANR_Upscale_Engine/resolve/main/realcugan-ncnn-vulkan.zip?download=true",
            "./outputs/temp.zip",
        )
        extract("./outputs/temp.zip", "./assets/realcugan-ncnn-vulkan")
    elif env_name == "anime4k" and not os.path.exists("./assets/Anime4K"):
        logger.debug("正在下载 Anime4K 超分引擎")
        download(
            "https://huggingface.co/datasets/Xytpz/ANR_Upscale_Engine/resolve/main/Anime4K.zip?download=true",
            "./outputs/temp.zip",
        )
        extract("./outputs/temp.zip", "./assets/Anime4K")
    elif env_name == "waifu2x" and not os.path.exists("./assets/waifu2x-caffe"):
        logger.debug("正在下载 waifu2x-caffe 超分引擎")
        download(
            "https://huggingface.co/datasets/Xytpz/ANR_Upscale_Engine/resolve/main/waifu2x-caffe.zip?download=true",
            "./outputs/temp.zip",
        )
        extract("./outputs/temp.zip", "./assets/waifu2x-caffe")

    for image in _input_images(input_path, input_image):
        if check_stop():
            logger.warning("已停止生成!")
            break

        name, extension = os.path.splitext(os.path.basename(image))
        output_dir = os.path.dirname(os.path.abspath(image))

        if env_name == "realcugan":
            noise = int(options.get("noise", 3))
            scale = int(options.get("scale", 2))
            model = options.get("model", "models-se")
            output_path = os.path.join(output_dir, f"{name}_realcugan_ncnn_vulkan_noise_{noise}_scale_{scale}{extension}")
            exe = os.path.abspath("./assets/realcugan-ncnn-vulkan/realcugan-ncnn-vulkan.exe")
            code = (
                f'"{exe}" -i "{os.path.abspath(image)}" '
                f'-o "{output_path}" -n {noise} -s {scale} -m {model}'
            )
        elif env_name == "anime4k":
            zoom = int(options.get("zoom", 2))
            hdn = int(options.get("hdn", 3))
            gpu = str(options.get("gpu", "true")).lower() == "true"
            cnn = str(options.get("cnn", "true")).lower() == "true"
            hdn_enabled = str(options.get("hdn_enabled", "true")).lower() == "true"
            output_path = os.path.join(output_dir, f"{name}_Anime4K_noise_{hdn}_scale_{zoom}{extension}")
            exe = os.path.abspath("./assets/Anime4K/Anime4KCPP_CLI.exe")
            code = f'"{exe}" -i "{os.path.abspath(image)}" -o "{output_path}" -z {zoom}'
            if gpu:
                code += " -q"  # GPU 模式
            else:
                code += " -p"  # CPU 模式
            if cnn:
                code += " -w"  # ACNet 模式
            if hdn_enabled:
                code += f" -H -L {hdn}"  # HDN 开启 + 等级
        else:  # waifu2x
            mode = options.get("mode", "noise_scale")
            process = options.get("process", "gpu")
            tta = str(options.get("tta", "false")).lower() == "true"
            scale = int(options.get("scale", 2))
            noise = int(options.get("noise", 3))
            model = options.get("model", "cunet")
            output_path = os.path.join(output_dir, f"{name}_waifu2x-caffe_noise_{noise}_scale_{scale}{extension}")
            exe = os.path.abspath("./assets/waifu2x-caffe/waifu2x-caffe-cui.exe")
            code = (
                f'"{exe}" -i "{os.path.abspath(image)}" '
                f'-o "{output_path}" -m {mode} -p {process} -s {scale} -n {noise} --model_dir models/{model}'
            )
            if tta:
                code += " -t 1"

        logger.debug(code)
        result = run_cmd(code)
        if result:
            logger.info(result)

        if os.path.exists(output_path):
            logger.success("超分完成!")
            logger.info(f"图片已保存到 {output_path}")
            if revert_image_info(image, output_path):
                logger.success("元数据还原成功!")
            else:
                logger.error("元数据还原失败!")
            image_list.append(output_path)
        else:
            logger.error("超分失败! 请查看上方输出日志!")

    playsound("./assets/finish.mp3")
    return image_list
