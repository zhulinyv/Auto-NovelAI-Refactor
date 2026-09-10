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
from utils.events import broker
from utils.helpers import generate_random_str, send_anlas_remind_mail
from utils.logger import logger
from utils.models.headers import build_headers
from utils.tokens import current_token, get_tokens, mask_token
from utils.variable import get_proxies

_anlas_ctx = threading.local()
_anlas_lock = threading.Lock()

# 兼容保留的全局值 (多通道并发时请使用 get_last_anlas())
ANLAS = -1
REMAINS = -1

# 每个 Token 最近一次查询到的 (剩余点数, 剩余用量); 启动时全部查询, 生成后只更新用到的 Token
# 每次写入后通过 broker 发布 "anlas:update" 事件, 已打开的页面立即刷新剩余点数/用量徽标
_ANLAS_BY_TOKEN: dict[str, tuple] = {}

# 每个 Token 最近一次查询到的 (订阅是否有效 active, 下次恢复 1% 的秒数); 与 _ANLAS_BY_TOKEN 同步更新
_ANLAS_EXTRA: dict[str, tuple] = {}

# 已触发用量提醒的 Token 集合: 提醒一次后不再重复提醒, 用量恢复到阈值以上时移除 (可再次提醒)
_REMINDED_TOKENS: set[str] = set()


def _set_last_anlas(anlas, remains, token: str | None = None) -> None:
    global ANLAS, REMAINS
    _anlas_ctx.anlas = anlas
    _anlas_ctx.remains = remains
    ANLAS = anlas
    REMAINS = remains
    # 记录到按 Token 的缓存, 供前端分 Token 展示 (token 缺省时取当前线程绑定的 Token)
    if token is None:
        token = current_token()
    if token:
        with _anlas_lock:
            _ANLAS_BY_TOKEN[token] = (anlas, remains)
        try:
            broker.publish("anlas:update", {"token": mask_token(token) or "(未知)"})
        except Exception:
            pass
        _maybe_send_usage_remind(token, anlas, remains)


def _maybe_send_usage_remind(token: str, anlas, remains) -> None:
    """某 Token 剩余用量低于阈值时提醒一次 (配置 SMTP 发邮件, 否则 WebUI 右上角通知);
    恢复到阈值以上后重置, 再次跌破时可再次提醒。"""
    if anlas == "skipped" or remains == "skipped":
        return
    try:
        threshold = int(getattr(env, "anlas_remind_percent", 1))
    except (TypeError, ValueError):
        threshold = 1
    if threshold < 0:
        return  # -1 (或任何负值) 为关闭
    try:
        remains_num = float(remains)
    except (TypeError, ValueError):
        return
    if remains_num < 0 or remains_num > 100:
        return  # -1 等失败哨兵值, 不参与提醒判断
    masked = mask_token(token) or "(未知 Token)"
    with _anlas_lock:
        already = token in _REMINDED_TOKENS
    if remains_num <= threshold:
        if already:
            return
        with _anlas_lock:
            _REMINDED_TOKENS.add(token)
        if env.smtp_mail and env.smtp_token:
            logger.warning(f"Token {masked} 剩余用量 {remains_num}% 已低于提醒阈值 {threshold}%, 正在发送提醒邮件...")
            threading.Thread(
                target=send_anlas_remind_mail,
                args=(masked, remains_num, threshold),
                daemon=True,
                name="anlas-remind-mail",
            ).start()
        else:
            # 未配置 SMTP: WebUI 右上角消息通知
            try:
                broker.publish(
                    "notice",
                    {
                        "level": "warning",
                        "message": f"🪫 Token {masked} 剩余用量仅剩 {remains_num}% (低于提醒阈值 {threshold}%), 请及时关注",
                    },
                )
            except Exception as e:
                logger.debug(f"推送用量提醒通知失败: {e}")
            logger.warning(
                f"Token {masked} 剩余用量 {remains_num}% 已低于提醒阈值 {threshold}% (未配置 SMTP, 已通过 WebUI 通知)"
            )
    elif already:
        # 用量已恢复到阈值以上: 重置提醒状态, 再次跌破时可再次提醒
        with _anlas_lock:
            _REMINDED_TOKENS.discard(token)
        logger.info(f"Token {masked} 用量已恢复到 {remains_num}% (阈值 {threshold}%), 重置用量提醒状态")


def get_last_anlas() -> tuple:
    """当前线程最近一次查询到的 (剩余点数, 剩余用量)。"""
    return getattr(_anlas_ctx, "anlas", -1), getattr(_anlas_ctx, "remains", -1)


def get_anlas_snapshot() -> dict[str, tuple]:
    """全部 Token 的 (剩余点数, 剩余用量) 快照。"""
    with _anlas_lock:
        return dict(_ANLAS_BY_TOKEN)


def get_anlas_extra() -> dict[str, tuple]:
    """全部 Token 的 (订阅是否有效 active, 下次恢复 1% 的秒数) 快照。"""
    with _anlas_lock:
        return dict(_ANLAS_EXTRA)


def inquire_anlas(token: str | None = None):
    """查询剩余点数与用量 (token 缺省时用当前线程绑定的 Token), 并写入按 Token 缓存。"""
    if env.skip_inquire_anlas:
        return "skipped", "skipped"
    try:
        rep = requests.get(
            "https://image.novelai.net/user/subscription",
            headers=build_headers(token),
            proxies=get_proxies(),
            timeout=(15, 30),
        )
        if rep.status_code == 200:
            body = rep.json()
            remains = body["usage"]["percent"]
            anlas = body["trainingStepsLeft"]["fixedTrainingStepsLeft"]
            if anlas == 0:
                anlas = body["trainingStepsLeft"]["purchasedTrainingSteps"]
            # 订阅状态与下次恢复 1% 的秒数 (供前端展示 "下次恢复1%: x.xx 小时")
            active = bool(body.get("active"))
            try:
                seconds = float(body["usage"]["timeUntilNextPercent"])
            except (KeyError, TypeError, ValueError):
                seconds = None
            with _anlas_lock:
                _ANLAS_EXTRA[token] = (active, seconds)
            _set_last_anlas(anlas, remains, token)
            return anlas, remains
        return -1, -1
    except Exception as e:
        logger.debug(f"查询剩余点数失败 (不影响生成): {e}")
        return -1, -1


def inquire_all_anlas() -> dict[str, tuple]:
    """逐个查询全部有效 Token 的剩余点数与用量 (启动 / Token 配置变化时调用)。"""
    for token in get_tokens():
        inquire_anlas(token)
    return get_anlas_snapshot()


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
