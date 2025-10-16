import io
import os
import zipfile
from datetime import date

import requests
import ujson as json

from utils import generate_random_str
from utils.environment import env
from utils.logger import logger
from utils.models.headers import headers


class Generator:
    def __init__(self, url):
        self.url = url

    def generate(self, json_data):
        with open("last.json", "w", encoding="utf-8") as file:
            json.dump(json_data, file, ensure_ascii=False, indent=4)
        try:
            rep = requests.post(
                url=self.url,
                json=json_data,
                headers=headers,
                proxies=(
                    {
                        "http": env.proxy,
                        "https": env.proxy,
                    }
                    if env.proxy is not None
                    else None
                ),
            )
            with zipfile.ZipFile(io.BytesIO(rep.content), mode="r") as zip:
                with zip.open("image_0.png") as image:
                    return image.read()
        except Exception as e:
            logger.error(f"出现错误: {e}")
            return None

    def save(self, image_data, type, seed):
        if image_data:
            base_path = (
                f"./outputs/{env.custom_path}".replace("<类型>", type)
                .replace("<日期>", str(date.today()))
                .replace("<种子>", str(seed))
                .replace("<随机字符>", generate_random_str(6))
            )
            if not os.path.exists(_path := base_path.rsplit("/", 1)[0]):
                os.makedirs(_path, exist_ok=True)
            base_path = base_path.replace("<编号>", str(len(os.listdir(_path))).zfill(5))
            base_path += ".png"
            with open(base_path, "wb") as file:
                file.write(image_data)
            return base_path
