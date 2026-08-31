"""NovelAI API 客户端: 发送生成请求并保存图片。

多 Token 支持请求头通过 utils.tokens 按线程自动选择 Token;
剩余点数信息保存在线程本地, 并发生成时各任务互不串扰。
"""

from __future__ import annotations

import io
import os
import threading
import zipfile
from datetime import date
from pathlib import Path

import requests
import ujson as json

from utils.config import env
from utils.errors import NovelAIAPIError
from utils.helpers import generate_random_str
from utils.logger import logger
from utils.models.headers import build_headers
from utils.variable import get_proxies

_anlas_ctx = threading.local()

# 兼容保留的全局值 (多通道并发时请使用 get_last_anlas())
ANLAS = -1
REMAINS = -1


def _set_last_anlas(anlas, remains) -> None:
    _anlas_ctx.anlas = anlas
    _anlas_ctx.remains = remains


def get_last_anlas() -> tuple:
    """当前线程最近一次查询到的 (剩余点数, 剩余用量)。"""
    return getattr(_anlas_ctx, "anlas", -1), getattr(_anlas_ctx, "remains", -1)


def inquire_anlas():
    """查询剩余点数与用量。"""
    if env.skip_inquire_anlas:
        return "skipped", "skipped"
    try:
        rep = requests.get(
            "https://image.novelai.net/user/subscription",
            headers=build_headers(),
            proxies=get_proxies(),
            timeout=(15, 30),
        )
        if rep.status_code == 200:
            body = rep.json()
            remains = body["usage"]["percent"]
            anlas = body["trainingStepsLeft"]["fixedTrainingStepsLeft"]
            if anlas == 0:
                anlas = body["trainingStepsLeft"]["purchasedTrainingSteps"]
            return anlas, remains
        return -1, -1
    except Exception as e:
        logger.debug(f"查询剩余点数失败 (不影响生成): {e}")
        return -1, -1


def _response_error_message(rep) -> str:
    try:
        body = rep.json()
    except ValueError:
        return rep.text[:500]
    if isinstance(body, dict):
        return str(body.get("message") or body.get("error") or body)[:500]
    return str(body)[:500]


def _safe_output_path(image_type: str, seed: int, default_path=None) -> Path:
    custom_path = default_path or env.custom_path or "<类型>/<日期>/<种子>_<随机字符>"
    base_path = (
        f"./outputs/{custom_path}".replace("<类型>", image_type)
        .replace("<日期>", str(date.today()))
        .replace("<种子>", str(seed))
        .replace("<随机字符>", generate_random_str(6))
    )
    _dir = base_path.rsplit("/", 1)[0]
    os.makedirs(_dir, exist_ok=True)
    base_path = base_path.replace("<编号>", str(len(os.listdir(_dir))).zfill(5)) + ".png"

    target = Path(base_path).resolve()
    outputs_root = Path("./outputs").resolve()
    if not target.is_relative_to(outputs_root):
        logger.warning(f"输出路径超出 outputs 目录, 已回退到默认路径: {target}")
        target = Path(f"./outputs/{image_type}/{date.today()}/{seed}_{generate_random_str(6)}.png").resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


class Generator:
    """NovelAI 图片生成客户端。"""

    def __init__(self, url: str):
        self.url = url

    def generate(self, json_data: dict):
        with open("last.json", "w", encoding="utf-8") as f:
            json.dump(json_data, f, ensure_ascii=False, indent=4)

        logger.debug("正在发送生成请求...")
        # 重试逻辑在批量生成层 (generate_images) 统一处理: 429 无上限 / 其它最多 3 次
        rep = requests.post(
            url=self.url,
            json=json_data,
            headers=build_headers(),
            proxies=get_proxies(),
            timeout=(30, 180),  # 连接 30s, 读取 180s (生图耗时较长)
        )
        if rep.status_code != 200:
            message = _response_error_message(rep)
            raise NovelAIAPIError(f"NovelAI 请求失败 (HTTP {rep.status_code}): {message}")

        anlas, remains = inquire_anlas()
        _set_last_anlas(anlas, remains)
        logger.success(f"请求成功! 剩余点数: {anlas}; 剩余用量: {remains}%")

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
        except zipfile.BadZipFile:
            # 导演工具 (augment-image) 也可能直接返回未压缩的图片数据
            content = rep.content
            if json_data.get("req_type") == "bg-removal":
                # 单张图片时无法拆出三张, 只返回这一张 (其余为 None)
                return content, None, None
            return content

    def save(self, image_data, type: str, seed: int, default_path=None) -> str:
        if not image_data:
            raise NovelAIAPIError("图片数据为空, 保存失败")
        target = _safe_output_path(type, seed, default_path=default_path)
        with open(target, "wb") as f:
            f.write(image_data)
        logger.info(f"图片已保存: {target}")
        return str(target)
