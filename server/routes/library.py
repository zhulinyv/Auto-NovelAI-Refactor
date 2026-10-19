"""提示词库与补全 API: 标签词典 / 补全建议 / 收藏库 / 在线翻译。"""

from __future__ import annotations

import os
import re
import threading
import time

from fastapi import APIRouter, HTTPException

from utils import jsonstore
from utils.logger import logger
from utils.paths import CACHE_DIR, STATE_DIR

router = APIRouter(prefix="/api", tags=["library"])

# ---------------------------------------------------------------- 提示词补全
# 数据格式 (assets/danbooru_tags_full_zh.csv): tag, category, count, aliases(逗号分隔), zh翻译
#   category: 0=general 1=artist 3=copyright 4=character 5=meta (与 Danbooru 一致)
# 匹配优先级: 标签前缀 > 标签包含 > 别名 > 中文翻译, 同级按热度 (count) 排序


def _load_tags(csv_filename: str = "./assets/danbooru_tags_full_zh.csv"):
    import csv as _csv

    tags = []
    try:
        with open(csv_filename, "r", encoding="utf-8") as f:
            for row in _csv.reader(f):
                if not row or not row[0].strip():
                    continue
                tag = row[0].strip()
                cat = int(row[1]) if len(row) >= 2 and row[1].strip().isdigit() else 0
                count = int(row[2]) if len(row) >= 3 and row[2].strip().isdigit() else 0
                aliases = [a.strip().lower() for a in row[3].split(",") if len(row) >= 4 and a.strip()]
                zh = row[4].strip() if len(row) >= 5 else ""
                if zh == tag:  # 表情/符号类标签翻译与原文相同, 视为无翻译
                    zh = ""
                tags.append((tag, cat, count, aliases, zh))
    except FileNotFoundError:
        logger.error(f"标签词典不存在: {csv_filename}")
    # 按热度降序, 前缀匹配时天然按热度排序
    tags.sort(key=lambda x: x[2], reverse=True)
    return tags


_TAGS_CACHE: dict | None = None
_ZH_MAP: dict | None = None
_TAGS_LOCK = threading.Lock()


def _tags_fingerprint() -> tuple | None:
    """词典文件指纹 (mtime, size): 变化即自动重建缓存, 换词典不必重启进程。"""
    try:
        st = os.stat("./assets/danbooru_tags_full_zh.csv")
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _build_tag_cache() -> dict:
    """解析全词典为热度降序行表, 并构建「前 2 字符 -> 行号」倒排前缀桶。

    桶内行号天然保持热度序; /api/suggest 的前缀层按 kw[:2] 取桶即可,
    不再每次线性扫满 32.7 万行 (原实测单次 143-153ms)。
    """
    rows = [(tag.lower(), tag, cat, count, aliases, zh) for tag, cat, count, aliases, zh in _load_tags()]
    exact2: dict = {}
    alias2: dict = {}
    for idx, row in enumerate(rows):
        tag_l, aliases = row[0], row[4]
        if len(tag_l) >= 2:
            exact2.setdefault(tag_l[:2], []).append(idx)
        for a in aliases:
            if len(a) >= 2:
                alias2.setdefault(a[:2], []).append(idx)
    return {"rows": rows, "exact2": exact2, "alias2": alias2, "fp": _tags_fingerprint()}


def _get_tag_cache() -> dict:
    """标签缓存 (行表 + 前缀桶): 懒加载; 词典文件 mtime/大小变化时自动重建。

    线程安全: suggest 等同步接口现在跑在线程池, 可能并发进来;
    双检锁保证重建只发生一次, 重建期间旧缓存照常可用 (整体替换引用)。
    """
    global _TAGS_CACHE, _ZH_MAP
    cache = _TAGS_CACHE
    if cache is not None and cache["fp"] == _tags_fingerprint():
        return cache
    with _TAGS_LOCK:
        cache = _TAGS_CACHE
        if cache is None or cache["fp"] != _tags_fingerprint():
            cache = _build_tag_cache()
            _TAGS_CACHE = cache
            _ZH_MAP = None  # 中文映射派生自行表, 必须一并失效
        return cache


def _reset_tag_cache() -> None:
    """强制清空标签缓存与中文映射 (下次访问重建)。

    词典文件 mtime/大小变化已由 _get_tag_cache 自动感知, 这里是显式入口:
    替换词典但刻意保留原 mtime (如还原备份) 等场景下调用。
    """
    global _TAGS_CACHE, _ZH_MAP
    _TAGS_CACHE = None
    _ZH_MAP = None


def _get_zh_map() -> dict:
    """标签/别名 -> 中文翻译 查询表 (小写键), 供标签块批量翻译。"""
    global _ZH_MAP
    if _ZH_MAP is None:
        m: dict = {}
        for tag_l, tag, cat, count, aliases, zh in _get_tag_cache()["rows"]:
            if zh:
                m[tag_l] = zh
                for a in aliases:
                    m.setdefault(a, zh)
        _ZH_MAP = m
    return _ZH_MAP


_SUGGEST_LIMIT = 20
_SUGGEST_LAYER_CAP = 40  # 每层独立上限 (与原实现一致)
_SUGGEST_SCAN_MAX_ROWS = 150_000  # 兜底线扫预算·行数 (原实现每次扫满 326,790 行)
_SUGGEST_SCAN_MAX_MS = 100.0  # 兜底线扫预算·毫秒


@router.post("/suggest")
def suggest_tags(payload: dict):
    """提示词补全 (同步 def: FastAPI 会在线程池执行, 慢查询不再冻结 SSE 与生成提交)。

    匹配优先级与原实现一致: 标签前缀 > 别名前缀 > 标签包含 > 别名包含 > 中文翻译包含。
    前两层按 kw 前 2 字符从倒排前缀桶直接取 (桶内已热度序, 不再全表扫);
    后三层是任意子串匹配, 保留线性扫但受行数/耗时双预算, 且凑满 20 条候选即提前退出。
    (方案 P1-1: 深位次结果的排序手感可能与旧实现不同, 需拿常用词校准。)
    """
    cache = _get_tag_cache()
    rows = cache["rows"]
    input_text = (payload.get("text") or "").strip().lower()
    keyword = input_text.split(",")[-1].strip().rstrip(",")
    if not keyword:
        return {"keyword": "", "items": []}
    # 用户习惯用空格, danbooru 标签是下划线
    kw_tag = keyword.replace(" ", "_")
    kw_zh = keyword
    # 精确层 (标签前缀 / 别名前缀, 按热度排序, 让输入完整别名时主标签靠前)
    t_exact: list = []
    t_contains: list = []
    t_alias_sub: list = []
    t_zh: list = []
    used: set = set()  # 已由前缀桶命中的行号: 扫描时跳过, 保持原实现的「一行只进一个层级」

    if len(kw_tag) >= 2:
        b = kw_tag[:2]
        bucket = sorted(set(cache["exact2"].get(b, ())) | set(cache["alias2"].get(b, ())))
        for idx in bucket:
            if len(t_exact) >= _SUGGEST_LAYER_CAP:
                break
            tag_l, tag, cat, count, aliases, zh = rows[idx]
            if tag_l.startswith(kw_tag):
                t_exact.append((tag, cat, count, "", zh))
                used.add(idx)
            else:
                hit = next((a for a in aliases if a.startswith(kw_tag)), None)
                if hit is not None:
                    t_exact.append((tag, cat, count, hit, zh))
                    used.add(idx)

    sealed = len(kw_tag) >= 2  # kw 满 2 字符时前缀层已被桶穷尽 (前缀命中必然同前 2 字符)
    if len(t_exact) < _SUGGEST_LIMIT:
        deadline = time.monotonic() + _SUGGEST_SCAN_MAX_MS / 1000.0
        for idx, (tag_l, tag, cat, count, aliases, zh) in enumerate(rows):
            if idx >= _SUGGEST_SCAN_MAX_ROWS or (idx % 512 == 0 and time.monotonic() > deadline):
                break  # 扫描预算耗尽: 有多少回多少
            if idx in used:
                continue
            # sealed 时以下前缀分支天然不触发 (全部前缀命中已在桶里处理);
            # 1 字符 kw 没有桶可取, 前缀层同样靠这条扫描兜底
            if tag_l.startswith(kw_tag):
                if len(t_exact) < _SUGGEST_LAYER_CAP:
                    t_exact.append((tag, cat, count, "", zh))
                continue  # 本行归属前缀层: 即使被上限截断, 也不许降级进后面的层
            hit = next((a for a in aliases if a.startswith(kw_tag)), None)
            if hit is not None:
                if len(t_exact) < _SUGGEST_LAYER_CAP:
                    t_exact.append((tag, cat, count, hit, zh))
                continue
            if kw_tag in tag_l:
                if len(t_contains) < _SUGGEST_LAYER_CAP:
                    t_contains.append((tag, cat, count, "", zh))
            else:
                hit2 = next((a for a in aliases if kw_tag in a), None)
                if hit2 is not None:
                    if len(t_alias_sub) < _SUGGEST_LAYER_CAP:
                        t_alias_sub.append((tag, cat, count, hit2, zh))
                elif zh and kw_zh in zh:
                    if len(t_zh) < _SUGGEST_LAYER_CAP:
                        t_zh.append((tag, cat, count, "", zh))
            if len(t_exact) >= _SUGGEST_LIMIT:
                break  # 前缀层自身凑满 20 条: 之后追加的都是更低热度项, 进不了前 20
            if sealed and len(t_exact) + len(t_contains) >= _SUGGEST_LIMIT:
                break  # 前缀层已被桶封板, 包含层又凑满窗口: 别名包含/中文层只会排在这两者之后, 不必再扫
    items = (t_exact + t_contains + t_alias_sub + t_zh)[:_SUGGEST_LIMIT]
    return {
        "keyword": keyword,
        "items": [{"tag": t, "category": c, "count": n, "alias": a, "zh": z} for t, c, n, a, z in items],
    }


_PROMPT_LIB_FILE = STATE_DIR / "prompt_library.json"


def _read_prompt_lib():
    """读取提示词库 (用户收藏: {text, category}, 按最近保存倒序; 兼容迁移旧版纯文本格式)。"""
    try:
        data = jsonstore.read(_PROMPT_LIB_FILE, [])
        if not isinstance(data, list):
            return []
        items = []
        for x in data:
            if isinstance(x, dict) and str(x.get("text") or "").strip():
                items.append(
                    {
                        "text": str(x["text"]).strip(),
                        "category": str(x.get("category") or "默认").strip() or "默认",
                    }
                )
            elif isinstance(x, str) and x.strip():
                items.append({"text": x.strip(), "category": "默认"})  # 旧版数据迁移
        return items
    except Exception:
        return []


def _write_prompt_lib(items):
    jsonstore.write(_PROMPT_LIB_FILE, items)


@router.get("/prompt-library")
async def prompt_library_get():
    return {"items": _read_prompt_lib()}


@router.post("/prompt-library/add")
async def prompt_library_add(payload: dict):
    """保存关键词到提示词库 (可带分类, 已存在则更新分类并移到最前, 最多保留 500 条)。"""
    text = str(payload.get("text") or "").strip()
    category = str(payload.get("category") or "默认").strip() or "默认"
    if not text:
        raise HTTPException(status_code=400, detail="内容不能为空")
    items = [x for x in _read_prompt_lib() if x["text"] != text]
    items.insert(0, {"text": text, "category": category})
    items = items[:500]
    _write_prompt_lib(items)
    return {"items": items}


@router.post("/prompt-library/delete")
async def prompt_library_delete(payload: dict):
    """从提示词库删除指定关键词。"""
    text = str(payload.get("text") or "").strip()
    items = [x for x in _read_prompt_lib() if x["text"] != text]
    _write_prompt_lib(items)
    return {"items": items}


@router.post("/prompt-library/delete-category")
async def prompt_library_delete_category(payload: dict):
    """删除提示词库中的整个分类 (连同该分类下的所有收藏, 不可恢复)。"""
    category = str(payload.get("category") or "").strip()
    if not category:
        raise HTTPException(status_code=400, detail="分类不能为空")
    items = [x for x in _read_prompt_lib() if x["category"] != category]
    _write_prompt_lib(items)
    return {"items": items}


_PROMPT_LIB_META_FILE = STATE_DIR / "prompt_library_meta.json"


def _read_prompt_lib_meta():
    """提示词库附加信息: 自带标签/分类隐藏列表 + 分类自定义排序。"""
    meta = {"hidden_tags": [], "hidden_categories": [], "category_order": []}
    data = jsonstore.read_dict(_PROMPT_LIB_META_FILE)
    for key in meta:
        if isinstance(data.get(key), list):
            meta[key] = [str(x) for x in data[key]]
    return meta


@router.get("/prompt-library/meta")
async def prompt_library_meta_get():
    return _read_prompt_lib_meta()


@router.post("/prompt-library/meta")
async def prompt_library_meta_save(payload: dict):
    """部分更新提示词库附加信息 (hidden_tags / hidden_categories / category_order)。"""
    meta = _read_prompt_lib_meta()
    for key in ("hidden_tags", "hidden_categories", "category_order"):
        if key in payload and isinstance(payload[key], list):
            meta[key] = [str(x) for x in payload[key]]
    jsonstore.write(_PROMPT_LIB_META_FILE, meta)
    return meta


@router.post("/suggest/translate")
async def suggest_translate(payload: dict):
    """批量查询标签中文翻译 (供提示词标签块双语展示)。匹配标签名与别名。"""
    zh_map = _get_zh_map()
    cache = _read_translate_cache()
    translations = {}
    for tag in (payload.get("tags") or [])[:300]:
        key = str(tag).strip().lower().replace(" ", "_")
        if not key or key in translations:
            continue
        translations[str(tag)] = cache.get(key) or zh_map.get(key, "")
    return {"translations": translations}


_TRANSLATE_CACHE_FILE = CACHE_DIR / "translate_cache.json"
_CJK_RE = re.compile(r"[一-鿿぀-ヿ가-힯]")


def _read_translate_cache():
    """在线翻译结果缓存 (避免重复请求翻译服务)。"""
    return jsonstore.read_dict(_TRANSLATE_CACHE_FILE)


def _online_translate(text: str) -> str:
    """在线翻译一段英文 -> 中文: 多源免费接口链 (参考 sd-webui-prompt-all-in-one)。

    按"大陆可直连优先"顺序自动切换: Google/Sogou/Iciba/Youdao/Alibaba/Caiyun/
    CloudTranslation/QQ/Bing/Baidu/MyMemory/海外免费接口, 失败自动换下一个,
    结果由 translate_online 写入缓存。
    """
    q = text.strip()
    if not q:
        return ""
    from utils.translate import translate_en_to_zh

    try:
        return translate_en_to_zh(q)
    except Exception as e:
        logger.warning(f"在线翻译失败: {e}")
        logger.opt(exception=True).debug("在线翻译失败堆栈:")
    return ""


@router.post("/translate")
def translate_online(payload: dict):
    """在线批量翻译标签 (仅翻译离线词表没有的内容), 结果写入缓存供后续直接使用。

    payload.tags: 待翻译标签列表 (最长 100 个); 已含中日韩文字的跳过。
    """
    tags = payload.get("tags") or []
    if not isinstance(tags, list):
        raise HTTPException(status_code=400, detail="参数不合法")
    zh_map = _get_zh_map()
    cache = _read_translate_cache()
    changed = False
    translations = {}
    for raw in tags[:100]:
        tag = str(raw).strip()
        key = tag.lower().replace(" ", "_")
        if not tag or key in translations:
            continue
        if _CJK_RE.search(tag):
            translations[tag] = ""  # 已是中文/日文等, 无需翻译
            continue
        zh = cache.get(key) or zh_map.get(key, "")
        if not zh:
            zh = _online_translate(tag)
            if zh:
                cache[key] = zh
                changed = True
        translations[tag] = zh
    if changed:
        jsonstore.write(_TRANSLATE_CACHE_FILE, cache)
    return {"translations": translations}
