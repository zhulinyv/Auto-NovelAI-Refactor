# -*- coding: utf-8 -*-
"""在线翻译多源引擎。

参考 sd-webui-prompt-all-in-one 的"无需 API Key"翻译接口清单, 全部接入,
并按"大陆可直连优先"的顺序自动选择可用接口: 单个失败立即切换下一个。

连接方式 (所有接口统一, 见 `_transports()`):
- 设置里配了代理 (settings.json -> env.proxy): **先代理, 失败或超时再直连**;
- 只配了系统/环境代理: 同样先代理, 再直连;
- 都没配: 只走直连。
(utils/http_client.py 是给壁纸/一言用的"直连优先"策略, 与这里相反, 故不复用。)

成功结果由调用方 (server/routes/library.py) 写入 data/caches/translate_cache.json 缓存。
实测大陆网络下 爱词霸/搜狗/阿里 最快 (0.2~0.4s), Google 直连反而较慢, 故排在其后。

接口分类:
- 直连实现 (仅依赖 requests, 无额外依赖):
    google           translate.googleapis.com GTX 免签接口 (大陆可直连)
    mymemory         MyMemory 免费接口 (未注册每天约 5000 字符)
    bing             cn.bing.com ttranslatev3 (需先取 IG token, 部分网络可用)
    baidu            fanyi.baidu.com 免费接口 (部分网络/地区可用)
- translators 库 (pip install translators, 懒加载; 未安装或失败时自动跳过):
    大陆可直连: sogou 搜狗 / iciba 爱词霸 / youdao 有道 / alibaba 阿里
                / caiyun 彩云 / cloudTranslation 云译 / qqTranSmart 腾讯交互翻译
    海外免费:   itranslate / lingvanex / modernMt / translateCom / sysTran
                / reverso / papago / argos / translateMe / judic

mbart50 (HuggingFace 离线模型) 需要下载数 GB 模型, 未纳入。
"""

from __future__ import annotations

import json
import re
import threading
import time

import requests

from utils.logger import logger

# 通用请求头 (部分免费接口校验 UA / Referer)
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# 超时: 首轮快速失败 (尽早换接口/换连接方式), 兜底那轮才给足时间
_TIMEOUT_FAST = (2.5, 5)
_TIMEOUT_SLOW = (4, 10)

# 接口失败冷却: 某接口报错后 _FAIL_COOLDOWN 秒内直接跳过,
# 避免一个挂掉的接口把整批标签逐个拖满超时
_FAIL_COOLDOWN = 60.0
_FAIL_UNTIL: dict[str, float] = {}
_FAIL_LOCK = threading.Lock()

# 同一免费接口的最大并发 (批量翻译时多线程共用, 防止被限流/封禁)
_PROVIDER_SEM: dict[str, threading.Semaphore] = {}
_PROVIDER_SEM_LOCK = threading.Lock()
_PROVIDER_CONCURRENCY = 2

# 探测系统代理时用的地址 (只看有没有代理, 不真的请求)
_PROBE_URL = "https://translate.googleapis.com"


def _proxy_conf() -> dict | None:
    """设置里配置的代理 (settings.json -> env.proxy); 没配返回 None。

    延迟导入 utils.variable: 翻译只是可选路径, 没必要在模块加载时就拉起整个配置模块,
    也避免与 utils.config 的初始化顺序耦合。
    """
    try:
        from utils.variable import get_proxies

        return get_proxies()
    except Exception as e:  # pragma: no cover - 仅防御导入/配置异常
        logger.debug(f"读取代理配置失败: {e}")
        return None


def _system_proxy_configured() -> bool:
    """系统/环境变量里是否配了代理 (Windows 下含 IE/系统代理设置)。"""
    try:
        return bool(requests.utils.get_environ_proxies(_PROBE_URL))
    except Exception:
        return False


def _transports() -> list[tuple[str, bool, dict | None]]:
    """连接方式的尝试顺序 —— 配了代理就先代理, 失败或超时再直连; 没配代理只直连。

    返回 (名称, trust_env, 显式 proxies):
    - 应用内代理: trust_env=False + 显式 proxies (不读系统代理, 避免双重代理)
    - 只有系统代理: trust_env=True (让 requests 自己读系统/环境代理)
    - 直连: trust_env=False 且不给 proxies
    """
    conf = _proxy_conf()
    direct = ("直连", False, None)
    if conf:
        return [("代理", False, conf), direct]
    if _system_proxy_configured():
        return [("代理(系统)", True, None), direct]
    return [direct]


def _new_session(trust_env: bool, proxies: dict | None = None) -> requests.Session:
    """按连接方式建 session (多步流程复用同一个, 才能带上 cookie)。"""
    sess = requests.Session()
    sess.trust_env = trust_env
    if proxies:
        sess.proxies.update(proxies)
    sess.headers.update(_HEADERS)
    return sess


def _request(method: str, url: str, **kw) -> requests.Response:
    """按 _transports() 的顺序请求: 先代理后直连 (没配代理时只有一次直连)。

    首轮用短超时快速失败, 兜底那轮放宽, 避免一个挂掉的代理把整批翻译拖住。
    """
    last: Exception | None = None
    for idx, (label, trust_env, proxies) in enumerate(_transports()):
        timeout = _TIMEOUT_SLOW if idx else _TIMEOUT_FAST
        try:
            resp = _new_session(trust_env, proxies).request(method, url, timeout=timeout, **kw)
            resp.raise_for_status()
            return resp
        except Exception as e:  # noqa: BLE001 - 换下一种连接方式重试
            logger.debug(f"翻译请求 ({label}) 失败: {e}")
            last = e
    raise last if last is not None else RuntimeError("翻译请求失败")


def _cooling(name: str) -> bool:
    """该接口是否处于失败冷却期。"""
    with _FAIL_LOCK:
        until = _FAIL_UNTIL.get(name, 0.0)
        if until <= time.monotonic():
            _FAIL_UNTIL.pop(name, None)
            return False
        return True


def _mark_fail(name: str) -> None:
    """接口调用失败: 冷却一段时间, 期间批量翻译不再逐个试它。"""
    with _FAIL_LOCK:
        _FAIL_UNTIL[name] = time.monotonic() + _FAIL_COOLDOWN


def _mark_ok(name: str) -> None:
    with _FAIL_LOCK:
        _FAIL_UNTIL.pop(name, None)


def _provider_sem(name: str) -> threading.Semaphore:
    """同一接口的并发闸门 (批量翻译时多线程共用一张表)。"""
    with _PROVIDER_SEM_LOCK:
        sem = _PROVIDER_SEM.get(name)
        if sem is None:
            sem = _PROVIDER_SEM[name] = threading.Semaphore(_PROVIDER_CONCURRENCY)
        return sem


# ---------------------------------------------------------------- 直连实现


def _google_direct(text: str) -> str:
    """Google GTX 免签接口 (大陆可直连, 速度最快, 默认首选)。"""
    resp = _request(
        "GET",
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "en", "tl": "zh-CN", "dt": "t", "q": text},
    )
    data = resp.json()
    parts = [seg[0] for seg in (data[0] or []) if seg and seg[0]]
    zh = "".join(parts).strip()
    if not zh:
        raise RuntimeError("Google 返回空结果")
    return zh


def _mymemory_direct(text: str) -> str:
    """MyMemory 免费接口 (无 key 每天约 5000 字符, 作为兜底)。"""
    resp = _request(
        "GET",
        "https://api.mymemory.translated.net/get",
        params={"q": text, "langpair": "en|zh-CN"},
    )
    data = resp.json()
    zh = str(data.get("responseData", {}).get("translatedText") or "").strip()
    # 过滤 MyMemory 的错误提示串
    if not zh or "MYMEMORY WARNING" in zh.upper() or "EXCEEDED" in zh.upper():
        raise RuntimeError("MyMemory 未返回有效译文")
    return zh


def _bing_direct(text: str) -> str:
    """Bing 免费翻译 (cn.bing.com ttranslatev3, 先取页面 IG token)。

    两步请求必须共用同一个 session (IG token 与 cookie 配套), 所以按连接方式各建一个;
    部分网络/地区可用; 失败由调用方自动切换下一接口。
    """
    last: Exception | None = None
    for idx, (label, trust_env, proxies) in enumerate(_transports()):
        timeout = _TIMEOUT_SLOW if idx else _TIMEOUT_FAST
        try:
            sess = _new_session(trust_env, proxies)
            page = sess.get("https://cn.bing.com/translator", timeout=timeout)
            page.raise_for_status()
            m = re.search(r'IG:"([0-9A-Fa-f]{8,})"', page.text)
            if not m:
                raise RuntimeError("Bing 页面未找到 IG token")
            ig = m.group(1)
            data = {"fromLang": "en", "text": text, "to": "zh-Hans", "token": "", "key": ""}
            url = f"https://cn.bing.com/ttranslatev3?isVertical=1&&IG={ig}&IID=translator.5028"
            resp = sess.post(url, data=data, timeout=timeout)
            resp.raise_for_status()
            j = resp.json()
            if isinstance(j, list) and j and j[0].get("translations"):
                zh = str(j[0]["translations"][0].get("text") or "").strip()
                if zh:
                    return zh
            raise RuntimeError(f"Bing 返回异常: {str(j)[:80]}")
        except Exception as e:  # noqa: BLE001 - 换下一种连接方式重试
            logger.debug(f"Bing 翻译 ({label}) 失败: {e}")
            last = e
    raise last if last is not None else RuntimeError("Bing 翻译失败")


def _baidu_direct(text: str) -> str:
    """百度翻译免费接口 (fanyi.baidu.com, 需要先访问主页拿 cookies)。

    同样按连接方式各建一个 session (cookies 配套); 部分网络/地区会被风控拦截;
    失败由调用方自动切换下一接口。
    """
    last: Exception | None = None
    for idx, (label, trust_env, proxies) in enumerate(_transports()):
        timeout = _TIMEOUT_SLOW if idx else _TIMEOUT_FAST
        try:
            sess = _new_session(trust_env, proxies)
            sess.headers["Referer"] = "https://fanyi.baidu.com/"
            sess.get("https://fanyi.baidu.com/", timeout=timeout)  # 建立会话拿 cookies
            resp = sess.post(
                "https://fanyi.baidu.com/transapi",
                data={"from": "en", "to": "zh", "query": text},
                timeout=timeout,
            )
            resp.raise_for_status()
            j = resp.json()
            if j.get("errno") in (0, None) and j.get("data"):
                dst = str(j["data"][0].get("dst") or "").strip()
                if dst:
                    return dst
            raise RuntimeError(f"百度翻译返回异常: {str(j)[:80]}")
        except Exception as e:  # noqa: BLE001 - 换下一种连接方式重试
            logger.debug(f"百度翻译 ({label}) 失败: {e}")
            last = e
    raise last if last is not None else RuntimeError("百度翻译失败")


# ---------------------------------------------------------------- translators 库

_TSS = None  # None=未加载, False=不可用, 其它=translators.server 模块
_TSS_LOCK = threading.Lock()


def _get_tss():
    """懒加载 translators 库 (带锁防并发导入; 未安装/导入失败返回 None)。

    translators 6.x 在未设置 translators_default_region 时会尝试联网获取后端配置,
    大陆网络下容易失败 ("Unable to find server backend"), 因此必须先设置环境变量
    再导入, 让它直接使用内置的 CN 大陆节点配置 (搜狗/阿里/有道等走 cn 域名)。
    """
    global _TSS
    if _TSS is None:
        with _TSS_LOCK:
            if _TSS is None:
                try:
                    import os as _os
                    import warnings as _warnings

                    _os.environ.setdefault("translators_default_region", "CN")
                    # translators 6.x 内嵌正则含无效转义序列 (如 [^\.]), Python 3.12+ 导入时会触发
                    # SyntaxWarning; 该警告无害 (字符类中 \. 与 . 等价), 导入时屏蔽以免污染日志
                    with _warnings.catch_warnings():
                        _warnings.simplefilter("ignore", SyntaxWarning)
                        import translators.server as tss

                    try:
                        tss.server_region = "CN"
                    except Exception as e:
                        logger.debug(f"设置翻译服务地区失败: {e}")
                    _TSS = tss
                except Exception as e:
                    logger.warning(f"translators 库不可用, 海外免费接口将跳过: {e}")
                    logger.opt(exception=True).debug("translators 库不可用堆栈:")
                    _TSS = False
    return _TSS or None


def _tss_call(name: str, to_lang: str = "zh"):
    """生成一个调用 translators.server.<name> 的翻译函数 (en -> to_lang)。

    连接方式对齐 `_transports()`: 库内部自己建 session, 只能用它的 proxies 参数控制,
    所以"系统代理"和"直连"两档在库里都跟随环境代理, 视为同一次尝试 (按 key 去重)。
    """

    def call(text: str) -> str:
        tss = _get_tss()
        if tss is None:
            raise RuntimeError("translators 库不可用")
        fn = getattr(tss, name, None)
        if fn is None:
            raise RuntimeError(f"translators 无 {name}")
        last: Exception | None = None
        tried: set[str] = set()
        for idx, (label, _trust_env, proxies) in enumerate(_transports()):
            key = json.dumps(proxies, sort_keys=True) if proxies else "env"
            if key in tried:
                continue
            tried.add(key)
            try:
                out = fn(
                    text,
                    from_language="en",
                    to_language=to_lang,
                    timeout=10 if idx else 6,  # 首轮快失败, 兜底那轮放宽
                    proxies=proxies or {},
                )
                out = (out or "").strip()
                if not out:
                    raise RuntimeError(f"{name} 返回空结果")
                return out
            except Exception as e:  # noqa: BLE001 - 换下一种连接方式重试
                logger.debug(f"翻译接口 {name} ({label}) 失败: {e}")
                last = e
        raise last if last is not None else RuntimeError(f"{name} 翻译失败")

    return call


# (接口名, 显示名, 调用函数) —— 顺序即优先级: 大陆可直连在前, 海外兜底在后
def _build_providers() -> list:
    if _build_providers._cache is not None:
        return _build_providers._cache
    tss_ok = _get_tss() is not None
    # 实测 (大陆网络) 响应速度: iciba 0.2s / sogou 0.3s / alibaba 0.4s / cloudTranslation 0.6s
    # youdao 0.7s / caiyun 0.8s / qqTranSmart 2.8s / google 直连 5s / mymemory 1.8s
    # 故大陆可直连的免费接口排在 Google 之前 (用户要求"优先大陆可直连")
    providers: list = [
        ("iciba", "爱词霸", _tss_call("iciba")),
        ("sogou", "搜狗翻译", _tss_call("sogou")),
        ("alibaba", "阿里翻译", _tss_call("alibaba")),
        ("cloudTranslation", "云译翻译", _tss_call("cloudTranslation")),
        ("youdao", "有道翻译", _tss_call("youdao")),
        ("caiyun", "彩云小译", _tss_call("caiyun", "zh-CN")),
        ("qqTranSmart", "腾讯交互翻译", _tss_call("qqTranSmart", "zh-CN")),
        ("google", "Google 直连", _google_direct),
        ("mymemory", "MyMemory", _mymemory_direct),
        ("bing", "Bing 直连", _bing_direct),
        ("baidu", "百度直连", _baidu_direct),
        ("itranslate", "iTranslate", _tss_call("itranslate")),
        ("lingvanex", "Lingvanex", _tss_call("lingvanex")),
        ("modernMt", "ModernMt", _tss_call("modernMt")),
        ("translateCom", "TranslateCom", _tss_call("translateCom")),
        ("sysTran", "SysTran", _tss_call("sysTran")),
        ("reverso", "Reverso", _tss_call("reverso")),
        ("papago", "Papago", _tss_call("papago", "zh-CN")),
        ("argos", "Argos/Libre", _tss_call("argos")),
        ("translateMe", "TranslateMe", _tss_call("translateMe")),
        ("judic", "Judic", _tss_call("judic")),
    ]
    if not tss_ok:
        # translators 未安装: 只保留直连实现 (google/bing/baidu/mymemory)
        providers = [p for p in providers if p[0] in ("google", "bing", "baidu", "mymemory")]
    _build_providers._cache = providers
    return providers


_build_providers._cache = None

# 上次成功的接口下标: 优先重试, 避免每次都从头探测 (并发请求下只是尽力而为)
_LAST_SUCCESS: dict = {"idx": 0}


def translate_en_to_zh(text: str) -> str:
    """英文 -> 中文: 按优先级自动切换可用免费接口, 全部失败返回 ""。

    上次成功的接口优先重试; 最近失败过的接口进冷却 (60s) 排到最后;
    单个接口同时最多 2 个请求 (信号量), 因此批量翻译时可以多线程并发调用本函数。
    """
    q = (text or "").strip()
    if not q:
        return ""
    providers = _build_providers()
    if not providers:
        return ""
    order = list(range(len(providers)))
    last = _LAST_SUCCESS["idx"]
    if 0 <= last < len(providers):
        order = [last] + [i for i in order if i != last]
    # 失败冷却中的接口排到最后: 平时不再逐个等超时, 万一其它接口全挂也还有兜底机会
    ready: list[int] = []
    cooling: list[int] = []
    for i in order:
        (cooling if _cooling(providers[i][0]) else ready).append(i)
    for i in ready + cooling:
        name, display, fn = providers[i]
        started = time.monotonic()
        try:
            with _provider_sem(name):  # 同一接口最多 2 个并发 (批量翻译时防限流)
                zh = fn(q)
            cost = time.monotonic() - started
            if zh:
                _LAST_SUCCESS["idx"] = i
                _mark_ok(name)
                logger.debug(f"翻译接口 {display} 命中 ({cost:.2f}s)")
                return zh
            logger.debug(f"翻译接口 {display} 返回空结果 ({cost:.2f}s)")
        except Exception as e:
            cost = time.monotonic() - started
            _mark_fail(name)
            logger.debug(f"翻译接口 {display} 失败 ({cost:.2f}s), {_FAIL_COOLDOWN:.0f}s 内跳过: {e}")
            logger.opt(exception=True).debug("翻译接口调用失败堆栈:")
    logger.warning(f"所有翻译接口均失败: {q[:40]!r}")
    return ""
