import os
import platform
import subprocess
from pathlib import Path

import ujson as json

from utils import download, extract, playsound, read_json
from utils.image_tools import return_array_image, revert_image_info
from utils.logger import logger


def before_process(upscale_input_path, upscale_input_image):
    with open("./outputs/temp_break.json", "w") as f:
        json.dump({"break": False}, f)

    if upscale_input_image:
        image_list = [upscale_input_image]
    else:
        image_list = [Path(upscale_input_path) / file for file in os.listdir(upscale_input_path)]

    if platform.system() != "Windows":
        logger.error("仅支持 Windows 运行!")
        return []

    return image_list


def run_cmd(code):
    try:
        p = subprocess.Popen(code, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = p.communicate()
        result = (stdout or stderr).decode("gb18030", errors="ignore").strip()
        return result
    except Exception as e:
        logger.error(f"出现错误! {e}")
        return


def realcugan_ncnn_vulkan(upscale_input_path, upscale_input_image, realcugan_noise, realcugan_scale, realcugan_model):
    if not os.path.exists("./assets/realcugan-ncnn-vulkan"):
        logger.debug("正在下载 realcugan-ncnn-vulkan 超分引擎")
        download(
            "https://huggingface.co/datasets/Xytpz/ANR_Upscale_Engine/resolve/main/realcugan-ncnn-vulkan.zip?download=true",
            "./outputs/temp.zip",
        )
        logger.debug("正在解压 realcugan-ncnn-vulkan 到 ./assets/realcugan-ncnn-vulkan")
        extract("./outputs/temp.zip", "./assets/realcugan-ncnn-vulkan")

    image_list = []
    for image in before_process(upscale_input_path, upscale_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        name, extension = os.path.splitext(os.path.basename(image))
        output_path = f"{os.path.dirname(os.path.abspath(image))}\\{name}_realcugan_ncnn_vulkan_noise_{realcugan_noise}_scale_{realcugan_scale}{extension}"

        code = f'.\\assets\\realcugan-ncnn-vulkan\\realcugan-ncnn-vulkan.exe -i "{os.path.abspath(image)}" -o "{output_path}" -n {realcugan_noise} -s {realcugan_scale} -m {realcugan_model}'

        logger.debug(code)
        result = run_cmd(code)
        logger.info("\n" + result)
        if os.path.exists(output_path):
            logger.success("超分完成!")
            logger.info(f"图片已保存到 {output_path}")

            logger.debug("正在还原元数据...")
            if revert_image_info(image, output_path):
                logger.success("还原成功!")
            else:
                logger.error("还原失败!")

            image_list.append(return_array_image(output_path))
        else:
            logger.error("超分失败! 请查看上方输出日志!")
    playsound("./assets/finish.mp3")
    return image_list


def anime4k(
    upscale_input_path,
    upscale_input_image,
    anime4k_zoomFactor,
    anime4k_HDNLevel,
    anime4k_GPUMode,
    anime4k_CNNMode,
    anime4k_HDN,
):
    if not os.path.exists("./assets/Anime4K"):
        logger.debug("正在下载 Anime4K 超分引擎")
        download(
            "https://huggingface.co/datasets/Xytpz/ANR_Upscale_Engine/resolve/main/Anime4K.zip?download=true",
            "./outputs/temp.zip",
        )
        logger.debug("正在解压 Anime4K 到 ./assets/Anime4K")
        extract("./outputs/temp.zip", "./assets/Anime4K")

    image_list = []
    for image in before_process(upscale_input_path, upscale_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        name, extension = os.path.splitext(os.path.basename(image))
        output_path = f"{os.path.dirname(os.path.abspath(image))}\\{name}_Anime4K_noise_{anime4k_HDNLevel}_scale_{anime4k_zoomFactor}{extension}"

        code = f'.\\assets\\Anime4K\\Anime4KCPP_CLI.exe -i "{os.path.abspath(image)}" -o "{output_path}" -z {anime4k_zoomFactor}'
        if anime4k_GPUMode:
            code += " -q"
        if anime4k_CNNMode:
            code += " -w"
            if anime4k_HDN:
                code += " -H -L {}".format(anime4k_HDNLevel)

        logger.debug(code)
        result = run_cmd(code)
        logger.info("\n" + result)
        if os.path.exists(output_path):
            logger.success("超分完成!")
            logger.info(f"图片已保存到 {output_path}")

            logger.debug("正在还原元数据...")
            if revert_image_info(image, output_path):
                logger.success("还原成功!")
            else:
                logger.error("还原失败!")

            image_list.append(return_array_image(output_path))
        else:
            logger.error("超分失败! 请查看上方输出日志!")
    playsound("./assets/finish.mp3")
    return image_list


def waifu2x_caffe(
    upscale_input_path,
    upscale_input_image,
    waifu2x_caffe_mode,
    waifu2x_caffe_process,
    waifu2x_caffe_tta,
    waifu2x_caffe_scale,
    waifu2x_caffe_noise,
    waifu2x_caffe_model,
):
    if not os.path.exists("./assets/waifu2x-caffe"):
        logger.debug("正在下载 waifu2x-caffe 超分引擎")
        download(
            "https://huggingface.co/datasets/Xytpz/ANR_Upscale_Engine/resolve/main/waifu2x-caffe.zip?download=true",
            "./outputs/temp.zip",
        )
        logger.debug("正在解压 waifu2x-caffe 到 ./assets/waifu2x-caffe")
        extract("./outputs/temp.zip", "./assets/waifu2x-caffe")

    image_list = []
    for image in before_process(upscale_input_path, upscale_input_image):
        _break = read_json("./outputs/temp_break.json")
        if _break["break"]:
            logger.warning("已停止生成!")
            break

        name, extension = os.path.splitext(os.path.basename(image))
        output_path = f"{os.path.dirname(os.path.abspath(image))}\\{name}_waifu2x-caffe_noise_{waifu2x_caffe_noise}_scale_{waifu2x_caffe_scale}{extension}"

        code = os.path.abspath("./assets/waifu2x-caffe/waifu2x-caffe-cui.exe")
        code += f' -i "{os.path.abspath(image)}" -o "{output_path}" -m {waifu2x_caffe_mode} -s {waifu2x_caffe_scale} -n {waifu2x_caffe_noise} -p {waifu2x_caffe_process} --model_dir models/{waifu2x_caffe_model}'

        if waifu2x_caffe_tta:
            code += " -t 1"

        with open("./outputs/temp_waifu2x_caffe.bat", "w") as temp:
            temp.write(code)
        os.system(os.path.abspath("./outputs/temp_waifu2x_caffe.bat"))

        if os.path.exists(output_path):
            logger.success("超分完成!")
            logger.info(f"图片已保存到 {output_path}")

            logger.debug("正在还原元数据...")
            if revert_image_info(image, output_path):
                logger.success("还原成功!")
            else:
                logger.error("还原失败!")

            image_list.append(return_array_image(output_path))
        else:
            logger.error("超分失败! 请查看上方输出日志!")
    playsound("./assets/finish.mp3")
    return image_list
