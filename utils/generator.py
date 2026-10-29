"""NovelAI API 客户端: 发送生成请求并保存图片。

多 Token 支持请求头通过 utils.tokens 按线程自动选择 Token;
剩余点数信息保存在线程本地, 并发生成时各任务互不串扰。

流式生成 (生图过程可见)
----------------------
NovelAI 的 /ai/generate-image-stream 用 SSE 推送, 每步一个 intermediate 帧, 帧里带
当前步的 JPEG 预览图。2026-10-28 实测 (steps=28) 收到 28 帧 intermediate + 1 帧 final:

    event: intermediate
    data: {"event_type":"intermediate","samp_ix":0,"step_ix":3,"gen_id":...,"sigma":43.25,
           "image":"/9j/4AAQSkZJRg..."}          <- JPEG 的 base64

    event: final
    data: {"event_type":"final","samp_ix":0,"image":"iVBORw0KGgo..."}   <- PNG 的 base64

所以"每步可见"不需要任何技巧: 解析帧 -> 把 image 交给回调即可。服务端不落盘中间帧
(一张 1024x1536 的成品约 1.8MB, 28 帧预览会白占几百 MB 磁盘), 只通过回调推给前端。

官方与非官方 (中转站)
--------------------
端点来自 utils/api_endpoint.current_endpoints(): 用户把「服务地址」填成第三方站点时
整套端点会跟着变。中转站默认走流式, 用户填的是非流式完整地址时自动回退。
"""

from __future__ import annotations

import base64
import io
import json as _json
import os
import threading
import zipfile
from datetime import date
from pathlib import Path
from typing import Callable

import requests

from utils import jsonstore
from utils.api_endpoint import EndpointError, current_endpoints
from utils.config import LAST_FILE, env
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

# 每个 Token 的订阅详情 (tier / active / usage.isNegative), 供费用预估判断是否落在免费区间
_SUBSCRIPTION: dict[str, dict] = {}

# 已触发用量提醒的 Token 集合: 提醒一次后不再重复提醒, 用量恢复到阈值以上时移除 (可再次提醒)
_REMINDED_TOKENS: set[str] = set()

# 流式响应里单帧的最大长度 (防止异常的中转站把内存打满)
_MAX_FRAME_BYTES = 8 * 1024 * 1024


def _endpoints_or_raise():
    """取当前端点; 配置里存了非法地址时给出可读错误而不是静默走官方。"""
    try:
        return current_endpoints()
    except EndpointError as e:
        raise NovelAIAPIError(f"服务地址配置有误: {e}") from e


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
            logger.opt(exception=True).debug("推送点数更新失败堆栈:")
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
                logger.opt(exception=True).debug("推送用量提醒通知失败堆栈:")
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


def get_subscription(token: str | None = None) -> dict:
    """当前 Token 的订阅快照 (tier / active / usage), 供费用预估判断免费区间。

    只读缓存, 不发请求; 没查过时返回 {} (调用方按"不免费"处理)。
    """
    if token is None:
        token = current_token() or (get_tokens()[0] if get_tokens() else None)
    if not token:
        return {}
    with _anlas_lock:
        return dict(_SUBSCRIPTION.get(token) or {})


def get_anlas_extra() -> dict[str, tuple]:
    """全部 Token 的 (订阅是否有效 active, 下次恢复 1% 的秒数) 快照。"""
    with _anlas_lock:
        return dict(_ANLAS_EXTRA)


def inquire_anlas(token: str | None = None):
    """查询剩余点数与用量 (token 缺省时用当前线程绑定的 Token), 并写入按 Token 缓存。"""
    if token is None:
        token = current_token()  # 与 _set_last_anlas / build_headers 同源, 保证两个缓存键一致
    if env.skip_inquire_anlas:
        return "skipped", "skipped"
    try:
        rep = requests.get(
            _endpoints_or_raise().subscription,
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
                _SUBSCRIPTION[token] = {
                    "tier": body.get("tier"),
                    "active": active,
                    "usage": body.get("usage") or {},
                }
            _set_last_anlas(anlas, remains, token)
            return anlas, remains
        return -1, -1
    except Exception as e:
        logger.debug(f"查询剩余点数失败 (不影响生成): {e}")
        logger.opt(exception=True).debug("查询剩余点数失败堆栈:")
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


def _stream_error_message(value: dict) -> str:
    """SSE 错误帧 / msgpack 错误帧里的可读原因 (中转站的报错格式五花八门, 尽量兜住)。"""
    for key in ("message", "error", "detail", "reason"):
        text = value.get(key)
        if isinstance(text, str) and text.strip():
            return text.strip()[:300]
        if isinstance(text, dict):
            inner = text.get("message") or text.get("type")
            if isinstance(inner, str) and inner.strip():
                return inner.strip()[:300]
    return ""


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
    # <编号>: 以目录内现有文件数为起点, 但**必须避开已存在的文件**。
    # 原先直接用 len(listdir) —— 两条生图通道并行跑同一 seed、同一目录时, 两边数到的
    # 文件数相同, 于是算出同一个编号, 后写的把前一张覆盖掉 (静默丢图)。
    index = len(os.listdir(_dir))
    while True:
        candidate = base_path.replace("<编号>", str(index).zfill(5)) + ".png"
        if not os.path.exists(candidate):
            break
        index += 1  # 撞名就往后顺延, 直到找到空位
    base_path = candidate

    target = Path(base_path).resolve()
    outputs_root = Path("./outputs").resolve()
    if not target.is_relative_to(outputs_root):
        logger.warning(f"输出路径超出 outputs 目录, 已回退到默认路径: {target}")
        # 回退路径带随机后缀, 撞名概率极低, 但仍做一次存在性检查 (并行任务兜底)
        while True:
            target = Path(f"./outputs/{image_type}/{date.today()}/{seed}_{generate_random_str(6)}.png").resolve()
            if not target.exists():
                break
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


class StreamFrames:
    """把 SSE / msgpack / 裸 ZIP 三种响应统一解成"帧"。

    为什么需要它
    ------------
    NovelAI 官方用 SSE (stream: "sse") 或 msgpack (stream: "msgpack") 两种流式编码;
    中转站实现不一致, 有的干脆忽略 stream 直接返回 ZIP 或裸 PNG。调用方不应该关心
    这些差异, 只想要"每步的预览图 + 最后的成品"。
    """

    def __init__(self, raw_frame: bytes, event_type: str, step_ix: int | None, samp_ix: int | None):
        self.raw = raw_frame
        self.event_type = event_type
        self.step_ix = step_ix
        self.samp_ix = samp_ix


def _decode_msgpack(payload: bytes) -> dict | None:
    """解一帧 msgpack (官方 stream=msgpack 时每帧是 4 字节长度 + msgpack 体)。"""
    try:
        from msgpack import unpackb  # type: ignore
    except ImportError:
        try:
            import msgpack  # type: ignore

            unpackb = msgpack.unpackb
        except ImportError:
            return None
    try:
        value = unpackb(payload, raw=False)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _looks_like_sse(chunk: bytes) -> bool:
    """这一小段是不是 SSE 帧 (以 event:/data:/: 注释行开头)。"""
    head = chunk.lstrip()[:16]
    return head.startswith((b"event:", b"data:", b":", b"id:", b"retry:"))


def _take_frame(buffer: bytes):
    """从缓冲区里切出完整的一帧 SSE, 返回 (帧, 剩余缓冲); 不完整时返回 None。

    分隔符按两个连续的换行算 (CRLF/LF 都认)。之所以不用简单的 b"\n\n" 查找:
    中转站可能用 \r\n\r\n, 那样 b"\n\n" 永远匹配不上, 整条流会一直堵在缓冲里。
    """
    lf = buffer.find(b"\n\n")
    crlf = buffer.find(b"\r\n\r\n")
    if lf < 0 and crlf < 0:
        return None
    if crlf >= 0 and (lf < 0 or crlf < lf):
        return buffer[:crlf], buffer[crlf + 4 :]
    return buffer[:lf], buffer[lf + 2 :]


def _iter_sse(raw: bytes):
    """把整段 SSE 文本切成 (event, data) 对。"""
    text = raw.decode("utf-8", "replace")
    event_name = ""
    data_lines: list[str] = []
    for line in text.replace("\r\n", "\n").split("\n"):
        if not line.strip():
            if data_lines:
                yield event_name, "\n".join(data_lines)
                event_name, data_lines = "", []
            continue
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].strip())
    if data_lines:
        yield event_name, "\n".join(data_lines)


def parse_response(raw: bytes, content_type: str = "") -> tuple[bytes | None, list[dict]]:
    """解析一次生成响应。

    返回 (最终 PNG 字节, 中间帧列表)。中间帧每项 {"step", "samp", "image"(data URL)}。

    三种形态:
      1. SSE (text/event-stream): 中间帧是 JPEG, final 帧是 PNG
      2. msgpack: 每帧前 4 字节长度 (大端), 帧内同样是中间/最终
      3. 非流式: 直接是 ZIP (含 image_0.png) 或裸 PNG
    """
    frames: list[dict] = []
    final: bytes | None = None

    head = raw[:4]
    is_zip = head == b"PK\x03\x04"
    is_png = raw[:8] == b"\x89PNG\r\n\x1a\n"
    looks_sse = content_type.startswith("text/event-stream") or raw[:6] in (b"event:", b"data: ")

    if is_png:
        return raw, frames

    if is_zip:
        try:
            with zipfile.ZipFile(io.BytesIO(raw), mode="r") as zf:
                names = [n for n in zf.namelist() if n.lower().endswith(".png")]
                if names:
                    return zf.read(names[0]), frames
        except zipfile.BadZipFile:
            pass
        return None, frames

    if looks_sse:
        for event_name, data in _iter_sse(raw):
            if not data or data == "[DONE]":
                continue
            try:
                value = _json.loads(data)
            except Exception:
                continue
            if not isinstance(value, dict):
                continue
            kind = value.get("event_type") or event_name
            if kind == "error":
                raise NovelAIAPIError(_stream_error_message(value) or "NovelAI 返回了错误帧")
            image_b64 = value.get("image")
            if kind == "final" and isinstance(image_b64, str) and image_b64:
                try:
                    final = base64.b64decode(image_b64)
                except Exception:
                    continue
            elif kind == "intermediate" and isinstance(image_b64, str) and image_b64:
                frames.append(
                    {
                        "step": value.get("step_ix"),
                        "samp": value.get("samp_ix"),
                        "image": "data:image/jpeg;base64," + image_b64,
                    }
                )
        return final, frames

    # msgpack: 4 字节大端长度 + 负载, 循环切帧
    if content_type.startswith("application/msgpack") or content_type.startswith("application/x-msgpack"):
        offset = 0
        total = len(raw)
        while offset + 4 <= total:
            size = int.from_bytes(raw[offset : offset + 4], "big")
            offset += 4
            if size <= 0 or size > _MAX_FRAME_BYTES or offset + size > total:
                break
            value = _decode_msgpack(raw[offset : offset + size])
            offset += size
            if not value:
                continue
            kind = value.get("event_type")
            if kind == "error":
                raise NovelAIAPIError(_stream_error_message(value) or "NovelAI 返回了错误帧")
            image_b64 = value.get("image")
            if not isinstance(image_b64, str) or not image_b64:
                continue
            if kind == "final":
                try:
                    final = base64.b64decode(image_b64)
                except Exception:
                    pass
            elif kind == "intermediate":
                frames.append(
                    {
                        "step": value.get("step_ix"),
                        "samp": value.get("samp_ix"),
                        "image": "data:image/jpeg;base64," + image_b64,
                    }
                )
        return final, frames

    # 兜底: 有些中转站忽略 stream, 直接回一段二进制; 先按 ZIP 再按 PNG 试
    # (截断的 ZIP 会抛各种异常, 不只是 BadZipFile, 这里一律兜住)
    try:
        with zipfile.ZipFile(io.BytesIO(raw), mode="r") as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".png")]
            if names:
                return zf.read(names[0]), frames
    except Exception:
        pass
    return (raw if raw else None), frames


class Generator:
    """NovelAI 图片生成客户端 (官方或第三方站点, 端点由当前配置决定)。"""

    def __init__(self, kind: str = "generate", url: str | None = None):
        """kind: generate / augment (导演工具); url 传入时固定用该地址 (插件兼容旧写法)。"""
        self.kind = kind
        self._fixed_url = url

    def url_for(self, streaming: bool = False) -> str:
        """实际请求地址 (每次实时求值, 设置改完立即生效)。

        流式与不流式是两个不同端点: 把 stream 参数发给 /ai/generate-image 只会拿到
        ZIP, 一帧中间图都没有 (实测)。
        """
        if self._fixed_url:
            return self._fixed_url
        endpoints = _endpoints_or_raise()
        if self.kind == "augment":
            return endpoints.augment
        return endpoints.stream_url() if streaming else endpoints.generate

    @property
    def url(self) -> str:
        """非流式请求地址 (兼容旧调用方)。"""
        return self.url_for(False)

    def generate(self, json_data: dict, on_frame: Callable[[dict], None] | None = None):
        """发送生成请求。

        on_frame 可选: 每收到一帧中间预览就回调 {"step", "samp", "image"(data URL), "total"}。
        传了它才走流式 (stream: "sse"); 不传时保持原来的非流式行为, 兼容导演工具等
        不需要过程预览的调用方。
        """
        # 上次请求参数落到项目根 last.json (原子写: 前端"加载上次"随时可能在读)
        try:
            jsonstore.write(LAST_FILE, json_data)
        except Exception:
            pass

        endpoints = _endpoints_or_raise()
        body = json_data
        streaming = on_frame is not None and self.kind == "generate"

        if streaming:
            # 流式: 显式要求 SSE。官方支持 "sse" 与 "msgpack"; sse 是纯文本帧,
            # 解析不需要额外依赖, 且中转站实现率更高。
            body = dict(json_data)
            params = dict(body.get("parameters") or {})
            params["stream"] = "sse"
            body["parameters"] = params
        elif self.kind == "generate" and endpoints.stream:
            # 非流式但端点默认是 stream (中转站): 显式改成 msgpack, 与官方默认行为一致
            body = dict(json_data)
            params = dict(body.get("parameters") or {})
            params.setdefault("stream", "msgpack")
            body["parameters"] = params

        logger.debug(
            f"正在发送生成请求 ({'流式' if streaming else '非流式'}, {'中转站' if endpoints.is_relay else '官方'})..."
        )
        # 重试逻辑在批量生成层 (generate_images) 统一处理: 429 无上限 / 其它最多 3 次
        try:
            rep = requests.post(
                url=self.url_for(streaming),
                json=body,
                headers=build_headers(),
                proxies=get_proxies(),
                timeout=(30, 300),  # 连接 30s, 读取 300s (流式时整轮生成都在读)
                stream=streaming,
            )
        except requests.RequestException as e:
            raise NovelAIAPIError(f"无法连接到生成服务: {e}") from e

        if rep.status_code != 200:
            message = _response_error_message(rep)
            source = "中转站" if endpoints.is_relay else "NovelAI"
            raise NovelAIAPIError(f"{source} 请求失败 (HTTP {rep.status_code}): {message}")

        content_type = (rep.headers.get("content-type") or "").lower()

        if not streaming:
            raw = rep.content
            final, _frames = parse_response(raw, content_type)
            if final is None:
                raise NovelAIAPIError("生成结果里没有图片")
            self._after_success(json_data)
            return final

        # 流式: 边收边解析。帧可能被 TCP 切片, 所以按缓冲区切 "\n\n"。
        total_steps = int(((json_data.get("parameters") or {}).get("steps")) or 0)
        buffer = b""
        collected: list[bytes] = []
        final: bytes | None = None
        saw_final = False
        frames_seen = 0
        for chunk in rep.iter_content(chunk_size=8192):
            if not chunk:
                continue
            # 原始字节也留一份: 若整个响应其实不是 SSE (有的中转站忽略 stream 直接回 ZIP),
            # 流已被逐块读走, 之后不能再取 rep.content (requests 会抛 "already consumed")。
            collected.append(chunk)
            buffer += chunk
            if len(buffer) > _MAX_FRAME_BYTES * 4:
                raise NovelAIAPIError("流式响应异常 (单帧过长)")
            while True:
                frame = _take_frame(buffer)
                if frame is None:
                    break
                frame, buffer = frame
                if _looks_like_sse(frame):
                    got, frames = parse_response(frame + b"\n\n", "text/event-stream")
                else:
                    got, frames = None, []
                if got:
                    final = got
                    saw_final = True
                for one in frames:
                    frames_seen += 1
                    one["total"] = total_steps
                    try:
                        on_frame(one)
                    except Exception:
                        logger.opt(exception=True).debug("推送生成预览失败堆栈:")
        # 末尾可能还剩一帧没被 "\n\n" 终结 (正常不会, 但有的中转站最后不带空行)
        if buffer.strip() and _looks_like_sse(buffer):
            got, frames = parse_response(buffer, "text/event-stream")
            if got:
                final = got
                saw_final = True
            for one in frames:
                frames_seen += 1
                one["total"] = total_steps
                try:
                    on_frame(one)
                except Exception:
                    logger.opt(exception=True).debug("推送生成预览失败堆栈:")

        if not saw_final or final is None:
            # 有些中转站忽略 stream 参数, 直接回了整段 ZIP/PNG: 用累积的原始字节再解一次
            alt, _ = parse_response(b"".join(collected), content_type)
            if alt is None:
                raise NovelAIAPIError("生成结果里没有图片")
            final = alt
        if frames_seen == 0:
            logger.debug("本次流式响应没有中间帧 (中转站可能不支持流式预览)")

        self._after_success(json_data)
        return final

    def _after_success(self, json_data: dict) -> None:
        """成功后刷新该 Token 的点数/用量 (失败不影响生成)。"""
        try:
            anlas, remains = inquire_anlas()
            _set_last_anlas(anlas, remains)
            if anlas == -1 and remains == -1:
                logger.debug("生成成功 (点数查询失败, 不影响结果)")
            else:
                logger.success(f"请求成功! 剩余点数: {anlas}; 剩余用量: {remains}%")
        except Exception:
            logger.opt(exception=True).debug("生成后刷新点数失败堆栈:")

    def save(self, image_data, type: str, seed: int, default_path=None) -> str:
        if not image_data:
            raise NovelAIAPIError("图片数据为空, 保存失败")
        target = _safe_output_path(type, seed, default_path=default_path)
        with open(target, "wb") as f:
            f.write(image_data)
        logger.info(f"图片已保存: {target}")
        return str(target)
