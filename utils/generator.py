import io
import os
import zipfile
from datetime import date
from pathlib import Path

import requests
import ujson as json

from utils import generate_random_str
from utils.environment import env
from utils.errors import NovelAIAPIError
from utils.logger import logger, loguru_to_rich
from utils.models.headers import headers
from utils.variable import proxies

ANLAS = -1


def inquire_anlas():
    if env.skip_inquire_anlas:
        return "skipped"
    try:
        rep = requests.get(
            "https://api.novelai.net/user/subscription",
            headers=headers,
            proxies=proxies,
            timeout=30,
        )
        if rep.status_code == 200:
            return rep.json()["trainingStepsLeft"]["fixedTrainingStepsLeft"]
        return -1
    except Exception as e:
        return str(e)


def _response_error_message(rep):
    try:
        body = rep.json()
    except ValueError:
        return rep.text
    if isinstance(body, dict):
        return body.get("message") or body.get("error") or str(body)
    return str(body)


def _safe_output_path(image_type, seed):
    custom_path = env.custom_path or "<type>/<date>/<seed>_<index>"
    base_path = (
        f"./outputs/{custom_path}"
        .replace("<类型>", image_type)
        .replace("<日期>", str(date.today()))
        .replace("<种子>", str(seed))
        .replace("<随机字符>", generate_random_str(6))
        .replace("<绫诲瀷>", image_type)
        .replace("<鏃ユ湡>", str(date.today()))
        .replace("<绉嶅瓙>", str(seed))
        .replace("<闅忔満瀛楃>", generate_random_str(6))
        .replace("<type>", image_type)
        .replace("<date>", str(date.today()))
        .replace("<seed>", str(seed))
        .replace("<random>", generate_random_str(6))
    )
    outputs_root = Path("./outputs").resolve()
    target = Path(base_path).resolve()
    if not target.is_relative_to(outputs_root):
        raise ValueError("custom_path must stay inside ./outputs")

    target.parent.mkdir(parents=True, exist_ok=True)
    index = str(len(os.listdir(target.parent))).zfill(5)
    target = Path(str(target).replace("<编号>", index).replace("<缂栧彿>", index).replace("<index>", index) + ".png")
    target = target.resolve()
    if not target.is_relative_to(outputs_root):
        raise ValueError("custom_path must stay inside ./outputs")
    return target


class Generator:
    def __init__(self, url):
        self.url = url

    def generate(self, json_data: dict):
        with open("last.json", "w", encoding="utf-8") as file:
            json.dump(json_data, file, ensure_ascii=False, indent=4)

        rep = requests.post(
            url=self.url,
            json=json_data,
            headers=headers,
            proxies=proxies,
            timeout=30,
        )
        if rep.status_code != 200:
            message = _response_error_message(rep)
            logger.debug(f"Request status: {rep.status_code}")
            logger.debug(message)
            raise NovelAIAPIError(f"NovelAI request failed with HTTP {rep.status_code}: {message}")

        global ANLAS
        ANLAS = inquire_anlas()
        logger.success(loguru_to_rich(f"Request succeeded! <y>Remaining points: {ANLAS}</y>"))

        try:
            with zipfile.ZipFile(io.BytesIO(rep.content), mode="r") as zip_file:
                if json_data.get("req_type") == "bg-removal":
                    with (
                        zip_file.open("image_0.png") as masked,
                        zip_file.open("image_1.png") as generated,
                        zip_file.open("image_2.png") as blend,
                    ):
                        return masked.read(), generated.read(), blend.read()
                with zip_file.open("image_0.png") as image:
                    return image.read()
        except zipfile.BadZipFile as e:
            raise NovelAIAPIError("NovelAI returned a non-zip response for a successful request") from e

    def save(self, image_data, type, seed):
        if image_data:
            base_path = _safe_output_path(type, seed)
            with open(base_path, "wb") as file:
                file.write(image_data)
            return str(base_path)
