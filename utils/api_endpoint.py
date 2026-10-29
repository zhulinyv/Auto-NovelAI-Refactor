"""NovelAI / 第三方站点 (中转站) 的地址解析与端点推导。

为什么需要这一层
----------------
历史实现把这个 URL 当成常量写死在五处::

    src/generate_images.py        Generator("https://image.novelai.net/ai/generate-image")
    src/director_tools.py         Generator("https://image.novelai.net/ai/augment-image")
    utils/generator.py            GET https://image.novelai.net/user/subscription
    plugins/anr_plugin_random_artists/utils.py
    plugins/anr_plugin_stories_to_images/utils.py

用户想接第三方站点 (中转站) 就只能改代码。本模块把"一个用户填写的地址"归一化成一整套
端点, 与 NovelAI Prompt Studio 的 src/shared/relay.ts 思路一致: 用户可能填裸域名、
填到 /v1、也可能直接粘贴完整的生成地址, 三种情况都要能推导出全部端点。

支持的输入形态 (以用户填 https://api.example.com 为例)
-----------------------------------------------------
    https://api.example.com                     -> base = https://api.example.com
    https://api.example.com/v1                  -> base = https://api.example.com/v1
    https://api.example.com/novelai             -> base = https://api.example.com/novelai
    https://api.example.com/ai/generate-image   -> base = https://api.example.com (非流式)
    https://api.example.com/v1/ai/generate-image-stream -> base = https://api.example.com/v1 (流式)

推导出的端点
------------
    generate     /ai/generate-image-stream  (用户给的是非流式完整地址时改用 /ai/generate-image)
    upscale      /ai/upscale
    augment      /ai/augment-image
    encode_vibe  /ai/encode-vibe
    subscription /user/subscription

安全约束
--------
官方地址固定为常量 OFFICIAL_BASE。中转站地址要求 https (本机回环允许 http), 且不能带
query/fragment, 不能内嵌用户名密码 —— 避免 Token 被发到意料之外的主机。
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

OFFICIAL_BASE = "https://image.novelai.net"

# 用户可能直接粘贴的两种"完整生成地址"后缀: 长的先匹配 (stream 是 generate-image 的超集)
_GENERATE_SUFFIXES = ("/ai/generate-image-stream", "/ai/generate-image")

_LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]", "::1")


class EndpointError(ValueError):
    """服务地址非法。"""


@dataclass(frozen=True)
class Endpoints:
    """一整套端点 (全部为绝对 URL)。"""

    base: str
    generate: str
    # 流式生成端点。官方与非流式端点不同 (/ai/generate-image-stream), 必须分开存:
    # 把 stream 参数发给 /ai/generate-image 会得到 ZIP, 拿不到任何中间帧。
    generate_stream: str
    stream: bool
    upscale: str
    augment: str
    encode_vibe: str
    subscription: str
    is_relay: bool

    def stream_url(self) -> str:
        """流式请求该打到哪里 (始终是 -stream 端点)。

        stream 参数只有发给 /ai/generate-image-stream 才会得到逐帧预览;
        发给 /ai/generate-image 只会拿到 ZIP (实测)。
        """
        return self.generate_stream

    @property
    def origin(self) -> str:
        """scheme + host + port (模型列表探测时按 origin 兜底用)。"""
        u = urlparse(self.base)
        return f"{u.scheme}://{u.netloc}"


def official_endpoints() -> Endpoints:
    """官方端点 (生成走非流式 /ai/generate-image, 与既有行为一致)。"""
    return Endpoints(
        base=OFFICIAL_BASE,
        generate=f"{OFFICIAL_BASE}/ai/generate-image",
        generate_stream=f"{OFFICIAL_BASE}/ai/generate-image-stream",
        stream=False,
        upscale=f"{OFFICIAL_BASE}/ai/upscale",
        augment=f"{OFFICIAL_BASE}/ai/augment-image",
        encode_vibe=f"{OFFICIAL_BASE}/ai/encode-vibe",
        subscription=f"{OFFICIAL_BASE}/user/subscription",
        is_relay=False,
    )


def resolve_endpoints(value: str | None) -> Endpoints:
    """把用户填写的服务地址解析为整套端点; 空值/官方地址返回官方端点。

    非法地址抛 EndpointError (上层转成可读提示), 不静默回落到官方 —— 那会让用户以为
    请求发到了自己的中转站, 实际却打到了 NovelAI 官方。
    """
    raw = (value or "").strip()
    if not raw:
        return official_endpoints()

    if "?" in raw or "#" in raw:
        raise EndpointError("服务地址不能带 ? 或 # 参数")

    if not raw.startswith(("http://", "https://")):
        raise EndpointError("服务地址要以 http:// 或 https:// 开头")

    try:
        u = urlparse(raw)
    except ValueError as e:
        raise EndpointError(f"服务地址无法解析: {e}") from e

    if u.username or u.password:
        raise EndpointError("服务地址里不能带用户名或密码")

    host = (u.hostname or "").lower()
    if not host:
        raise EndpointError("服务地址缺少主机名")

    is_local = host in _LOCAL_HOSTS
    if u.scheme != "https" and not (u.scheme == "http" and is_local):
        raise EndpointError("服务地址要以 https:// 开头 (本机 localhost 可用 http)")

    path = (u.path or "").rstrip("/")

    # 官方地址: 无论用户写成什么形态, 一律走官方端点 (含非流式生成),
    # 避免"填了官方地址却按中转站的流式规则发请求"。
    if host == "image.novelai.net" and u.scheme == "https":
        return official_endpoints()

    endpoint_hit = ""
    for suffix in _GENERATE_SUFFIXES:
        if path.endswith(suffix):
            endpoint_hit = suffix
            break

    if endpoint_hit:
        base = f"{u.scheme}://{u.netloc}{path[: -len(endpoint_hit)]}"
        generate = f"{u.scheme}://{u.netloc}{path}"
        stream = endpoint_hit == "/ai/generate-image-stream"
    else:
        # 用户填到 /v1 时保留它 (很多中转站的模型列表挂在 /v1/models)
        base = f"{u.scheme}://{u.netloc}{path}"
        generate = f"{base}/ai/generate-image-stream"
        stream = True

    return Endpoints(
        base=base,
        generate=generate,
        generate_stream=f"{base}/ai/generate-image-stream",
        stream=stream,
        upscale=f"{base}/ai/upscale",
        augment=f"{base}/ai/augment-image",
        encode_vibe=f"{base}/ai/encode-vibe",
        subscription=f"{base}/user/subscription",
        is_relay=True,
    )


def current_endpoints() -> Endpoints:
    """当前配置对应的端点 (读 env.base_url, 每次实时求值, 设置改完立即生效)。"""
    from utils.config import env

    try:
        return resolve_endpoints(getattr(env, "base_url", None))
    except EndpointError:
        # 配置里存了非法地址 (手改 settings.json 造成): 回落官方
        return official_endpoints()


__all__ = [
    "EndpointError",
    "Endpoints",
    "OFFICIAL_BASE",
    "current_endpoints",
    "official_endpoints",
    "resolve_endpoints",
]
