# -*- coding: utf-8 -*-
"""在线翻译多源引擎。

参考 sd-webui-prompt-all-in-one 的"无需 API Key"翻译接口清单, 全部接入,
并按"大陆可直连优先"的顺序自动选择可用接口: 单个失败立即切换下一个,
成功结果由调用方 (server/routes/misc.py) 写入 outputs/translate_cache.json 缓存。
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

import re
import threading

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

# 翻译服务可用连接方式 (None=未探测, False=直连, True=代理) —— 与 misc.py 壁纸逻辑一致
_TRUST_ENV: bool | None = None


def _request(method: str, url: str, **kw) -> requests.Response:
    """直连优先 (实测比走系统代理快), 失败自动改走系统代理重试; 记录上次可用方式。"""
    global _TRUST_ENV
    modes = (False, True)
    if _TRUST_ENV is not None:
        modes = tuple(sorted(modes, key=lambda t: t != _TRUST_ENV))
    last = None
    for trust in modes:
        try:
            sess = requests.Session()
            sess.trust_env = trust
            sess.headers.update(_HEADERS)
            resp = sess.request(method, url, **kw)
            resp.raise_for_status()
            _TRUST_ENV = trust
            return resp
        except Exception as e:
            last = e
    raise last


# ---------------------------------------------------------------- 直连实现


def _google_direct(text: str) -> str:
    """Google GTX 免签接口 (大陆可直连, 速度最快, 默认首选)。"""
    resp = _request(
        "GET",
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": "en", "tl": "zh-CN", "dt": "t", "q": text},
        timeout=(4, 12),
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
        timeout=(4, 12),
    )
    data = resp.json()
    zh = str(data.get("responseData", {}).get("translatedText") or "").strip()
    # 过滤 MyMemory 的错误提示串
    if not zh or "MYMEMORY WARNING" in zh.upper() or "EXCEEDED" in zh.upper():
        raise RuntimeError("MyMemory 未返回有效译文")
    return zh


def _bing_direct(text: str) -> str:
    """Bing 免费翻译 (cn.bing.com ttranslatev3, 先取页面 IG token)。

    部分网络/地区可用; 失败由调用方自动切换下一接口。
    """
    sess = requests.Session()
    sess.trust_env = _TRUST_ENV if _TRUST_ENV is not None else False
    sess.headers.update(_HEADERS)
    page = sess.get("https://cn.bing.com/translator", timeout=(5, 10))
    page.raise_for_status()
    m = re.search(r'IG:"([0-9A-Fa-f]{8,})"', page.text)
    if not m:
        raise RuntimeError("Bing 页面未找到 IG token")
    ig = m.group(1)
    data = {"fromLang": "en", "text": text, "to": "zh-Hans", "token": "", "key": ""}
    url = f"https://cn.bing.com/ttranslatev3?isVertical=1&&IG={ig}&IID=translator.5028"
    resp = sess.post(url, data=data, timeout=(5, 10))
    resp.raise_for_status()
    j = resp.json()
    if isinstance(j, list) and j and j[0].get("translations"):
        zh = str(j[0]["translations"][0].get("text") or "").strip()
        if zh:
            return zh
    raise RuntimeError(f"Bing 返回异常: {str(j)[:80]}")


def _baidu_direct(text: str) -> str:
    """百度翻译免费接口 (fanyi.baidu.com, 需要先访问主页拿 cookies)。

    部分网络/地区会被风控拦截; 失败由调用方自动切换下一接口。
    """
    sess = requests.Session()
    sess.trust_env = _TRUST_ENV if _TRUST_ENV is not None else False
    sess.headers.update(_HEADERS)
    sess.headers["Referer"] = "https://fanyi.baidu.com/"
    sess.get("https://fanyi.baidu.com/", timeout=(5, 8))  # 建立会话拿 cookies
    resp = sess.post(
        "https://fanyi.baidu.com/transapi",
        data={"from": "en", "to": "zh", "query": text},
        timeout=(5, 8),
    )
    resp.raise_for_status()
    j = resp.json()
    if j.get("errno") in (0, None) and j.get("data"):
        dst = str(j["data"][0].get("dst") or "").strip()
        if dst:
            return dst
    raise RuntimeError(f"百度翻译返回异常: {str(j)[:80]}")


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

                    _os.environ.setdefault("translators_default_region", "CN")
                    import translators.server as tss

                    try:
                        tss.server_region = "CN"
                    except Exception:
                        pass
                    _TSS = tss
                except Exception as e:
                    logger.warning(f"translators 库不可用, 海外免费接口将跳过: {e}")
                    _TSS = False
    return _TSS or None


def _tss_call(name: str, to_lang: str = "zh"):
    """生成一个调用 translators.server.<name> 的翻译函数 (en -> to_lang)。"""

    def call(text: str) -> str:
        tss = _get_tss()
        if tss is None:
            raise RuntimeError("translators 库不可用")
        fn = getattr(tss, name, None)
        if fn is None:
            raise RuntimeError(f"translators 无 {name}")
        out = fn(text, from_language="en", to_language=to_lang, timeout=10)
        out = (out or "").strip()
        if not out:
            raise RuntimeError(f"{name} 返回空结果")
        return out

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
    """英文 -> 中文: 按优先级自动切换可用免费接口, 全部失败返回 ""。"""
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
    for i in order:
        name, display, fn = providers[i]
        try:
            zh = fn(q)
            if zh:
                _LAST_SUCCESS["idx"] = i
                return zh
        except Exception as e:
            logger.debug(f"翻译接口 {display} 失败: {e}")
    logger.warning(f"所有翻译接口均失败: {q[:40]!r}")
    return ""
