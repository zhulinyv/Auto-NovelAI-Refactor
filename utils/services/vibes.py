"""Vibes 素材库: 存放 Vibe 编码文件 (与 Wildcards / 提示词库并列的第三个素材库)。

三种来源
--------
1. .naiv4vibebundle (旧版 ANR 的 bundle, 一个文件可含多个 vibe)
2. .naiv4vibe (NovelAI Prompt Studio / 官方格式, 一个文件 = 一个编码)
3. 图片: 优先从图片的 PNG 元数据里读已有编码 (零成本); 读不到再按需调
   /ai/encode-vibe 现场编码 (每次 2 Anlas), 编码结果落库, 下次同模型同参数直接复用。

存储布局 (与 wildcards 一致: 一个条目 = 一个字典文件, 同名图片就是它的缩略图)
--------------------------------------------------------------------------
    data/state/vibes/<id>.json        单条 vibe (元数据 + 各模型编码, 走 jsonstore 原子写)
    data/state/vibes/<id>.jpg|png     缩略图, 与 <id>.json 同名 —— 删掉 json 就不再被列出
    data/state/vibes/img/<id>.png     原图 (编码 / 导出 / 按图查重都要用到)
    data/state/vibes/<id>.naiv4vibe   导出的标准编码文件 (用户可直接拿去别处用)
    data/state/vibes/_meta.json       分类列表与 builtin_seeded 标记 (不含条目数据)

早先是单文件 vibes.json: 十几 MB 的清单每次读写都要整体解析/序列化, 而缩略图 base64
内嵌在里面 —— 用户手动清空 vibes 目录后列表里的图还在 (删的只是原图)。拆成"一条一文件
+ 同名缩略图"后, 增删改只碰自己那一份, 缩略图也能直接当文件看/删。

一个 vibe 要对每个模型各存一份编码 (v4full / v4-5full / v5full ...), 而
information_extracted 又是编码的入参, 同一模型下还要按 information 分缓存 ——
这些关系仍留在各自的 JSON 里。

与既有安装的兼容
----------------
旧版只认 .naiv4vibebundle 的路径 (页面上"风格迁移"页签选一个文件)。新库建立后,
生成请求里的 vibe 字段既接受 {bundle_path} (旧), 也接受 {library_ids: [...]} (新),
后者由本模块解析成 reference_image_multiple 等数组 (见 resolve_for_request)。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote

import send2trash

from utils import jsonstore
from utils.logger import logger
from utils.paths import STATE_DIR, TEMP_DIR

# 条目目录: 一条 vibe 一个 <id>.json, 缩略图是同名图片文件 (命名规则与 wildcards 一致)
VIBES_DIR = STATE_DIR / "vibes"
VIBES_IMAGES_DIR = VIBES_DIR / "img"
VIBES_META_FILE = VIBES_DIR / "_meta.json"
# 旧版的单文件清单, 启动时自动拆成上面的结构
LEGACY_VIBES_FILE = STATE_DIR / "vibes.json"
# 向后兼容: 老代码里引用过这两个名字
VIBES_FILE = LEGACY_VIBES_FILE
VIBES_FILES_DIR = VIBES_DIR

# 缩略图允许的扩展名 (按优先级查找, 与 wildcards.find_cover 的顺序一致)
THUMB_EXTS = (".png", ".jpg", ".jpeg", ".webp")
_META_VERSION = 1
_ITEM_SUFFIX = ".json"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# 模型 -> bundle/vibe 文件里 encodings 的键名
MODEL_KEY = {
    "nai-diffusion-5-full": "v5full",
    "nai-diffusion-5-curated": "v5curated",
    "nai-diffusion-4-5-full": "v4-5full",
    "nai-diffusion-4-5-curated": "v4-5curated",
    "nai-diffusion-4-full": "v4full",
    "nai-diffusion-4-curated-preview": "v4curated",
    "nai-diffusion-3": "v3",
    "nai-diffusion-furry-3": "furry3",
}

# 支持 /ai/encode-vibe 的模型 (实测: 4 与 4.5 系列可用; 5 系列返回 500)
ENCODABLE_MODELS = (
    "nai-diffusion-4-full",
    "nai-diffusion-4-curated-preview",
    "nai-diffusion-4-5-full",
    "nai-diffusion-4-5-curated",
)

VIBE_IDENTIFIER = "novelai-vibe-transfer"

# 未指定分类的条目归到这里 (与卡片库的"分类"概念对齐: 一个分类 = 一组 vibe)
DEFAULT_CATEGORY = "默认"

# 编码的最小长度: 官方返回约 48KB 二进制 -> base64 后 64K 字符。
# 太短的字符串一定是坏的/占位的, 直接当作无效编码。
_MIN_ENCODING_LEN = 100


# 条目解析结果缓存: 列表要读全部条目, 而一条编码 JSON 常有几十 KB。
# 用每个文件自己的 (mtime_ns, size) 失效 —— 只重读改动过的那一条, 外部手改也自动生效。
_LOCK = threading.RLock()
_ITEM_CACHE: dict[str, tuple[tuple[int, int], dict]] = {}
_LAYOUT_READY = False
_LAYOUT_LOCK = threading.Lock()


def _safe_id(vibe_id: str) -> str | None:
    """校验条目 id 可以安全地当文件名 (同时挡住 ../ 之类的目录穿越)。"""
    vid = str(vibe_id or "").strip()
    return vid if _ID_RE.match(vid) else None


def _item_file(vibe_id: str) -> Path | None:
    vid = _safe_id(vibe_id)
    return VIBES_DIR / f"{vid}{_ITEM_SUFFIX}" if vid else None


def _thumb_file(vibe_id: str) -> Path | None:
    """找条目的缩略图文件 (同名不同扩展名, 按 THUMB_EXTS 优先级)。"""
    vid = _safe_id(vibe_id)
    if not vid:
        return None
    for ext in THUMB_EXTS:
        path = VIBES_DIR / f"{vid}{ext}"
        if path.is_file():
            return path
    return None


def thumbnail_path(vibe_id: str) -> str | None:
    """缩略图的绝对路径 (没有则 None)。"""
    path = _thumb_file(vibe_id)
    return str(path) if path else None


def _thumb_url(vibe_id: str) -> str | None:
    """前端 <img src> 直接能用的地址 (与卡片库一样走 /api/image)。"""
    path = _thumb_file(vibe_id)
    return f"/api/image?path={quote(str(path))}" if path else None


def thumbnail_bytes(item: dict) -> bytes | None:
    """取回缩略图字节 (导出时拼成 data URL 用)。"""
    path = _thumb_file(str(item.get("id") or ""))
    if path is None:
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


def thumbnail_data_url(item: dict) -> str | None:
    raw = thumbnail_bytes(item)
    if not raw:
        return None
    mime = "image/png" if raw[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _store_thumb(vibe_id: str, value: str | bytes | None) -> bool:
    """把缩略图写成 <id>.<ext> (data URL / 裸 base64 / 原始字节都收)。

    与 wildcards.save_cover 同样的处理: 换扩展名时先删旧的那张, 避免目录里
    同时躺着 <id>.png 和 <id>.jpg 让 find 结果取决于遍历顺序。
    """
    vid = _safe_id(vibe_id)
    if not vid or not value:
        return False
    raw = value if isinstance(value, bytes) else _decode_data_url(value)
    if not raw:
        return False
    ext = _image_ext(raw)
    if ext not in THUMB_EXTS:
        ext = ".jpg"
    target = VIBES_DIR / f"{vid}{ext}"
    try:
        VIBES_DIR.mkdir(parents=True, exist_ok=True)
        for old_ext in THUMB_EXTS:
            old = VIBES_DIR / f"{vid}{old_ext}"
            if old != target and old.exists():
                old.unlink(missing_ok=True)
        target.write_bytes(raw)
        return True
    except OSError as e:
        logger.warning(f"缩略图落盘失败 ({vid}): {e}")
        return False


def _read_item_file(path: Path) -> dict | None:
    """读一个条目 JSON, 按文件戳走缓存。"""
    try:
        st = path.stat()
    except OSError:
        _ITEM_CACHE.pop(path.stem, None)
        return None
    stamp = (st.st_mtime_ns, st.st_size)
    cached = _ITEM_CACHE.get(path.stem)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    data = jsonstore.read(path)
    if not isinstance(data, dict):
        return None
    data.setdefault("id", path.stem)
    # 旧格式把缩略图内嵌在 JSON 里; 现在以同名文件为准, 字段只作为迁移来源
    data.pop("thumbnail", None)
    _ITEM_CACHE[path.stem] = (stamp, data)
    return data


def _iter_items() -> list[dict]:
    """扫描条目目录 (跳过 _meta.json 之类的下划线文件)。"""
    ensure_layout()
    out: list[dict] = []
    try:
        entries = sorted(os.listdir(VIBES_DIR))
    except OSError:
        return out
    for name in entries:
        if not name.endswith(_ITEM_SUFFIX) or name.startswith("_"):
            continue
        item = _read_item_file(VIBES_DIR / name)
        if item is not None:
            out.append(item)
    return out


def _write_item(item: dict) -> dict:
    """写单条 JSON (不写缩略图, 也不把 base64 塞进文件)。"""
    vid = _safe_id(str(item.get("id") or ""))
    if not vid:
        raise ValueError("vibe id 非法")
    payload = {k: v for k, v in item.items() if k not in ("thumbnail", "image")}
    payload["id"] = vid
    path = VIBES_DIR / f"{vid}{_ITEM_SUFFIX}"
    with _LOCK:
        VIBES_DIR.mkdir(parents=True, exist_ok=True)
        jsonstore.write(path, payload)
        try:
            st = path.stat()
            _ITEM_CACHE[vid] = ((st.st_mtime_ns, st.st_size), payload)
        except OSError:
            _ITEM_CACHE.pop(vid, None)
    return payload


def _load_meta() -> dict:
    """分类列表与 builtin_seeded 等少量全局状态 (不含条目数据)。"""
    data = jsonstore.read_dict(VIBES_META_FILE)
    data.setdefault("version", _META_VERSION)
    if not isinstance(data.get("categories"), list):
        data["categories"] = []
    data.setdefault("builtin_seeded", False)
    if not isinstance(data.get("default_category"), str):
        data["default_category"] = ""
    return data


def _default_category(meta: dict | None = None) -> str:
    """当前"默认分类"的名字 —— 未指定分类的条目都归到这里。

    默认分类本身也可以被删: 删除时 delete_category() 会把 default_category
    切到剩下的第一个分类, 所以这里永远有一个可用的落点。
    """
    data = meta if isinstance(meta, dict) else _load_meta()
    name = str(data.get("default_category") or "").strip()
    if name:
        return name
    # 没有显式记录时沿用老行为 (「默认」), 不能拿 categories[0] 顶替 ——
    # 否则"新建一个分类"会把默认角色悄悄抢走, 默认分类就再也删不掉了。
    return DEFAULT_CATEGORY


def _save_meta(meta: dict) -> None:
    with _LOCK:
        VIBES_DIR.mkdir(parents=True, exist_ok=True)
        jsonstore.write(VIBES_META_FILE, meta)


def ensure_layout() -> None:
    """确保目录存在并把老的单文件清单迁移过来 (幂等, 只在第一次真正执行)。"""
    global _LAYOUT_READY
    if _LAYOUT_READY:
        return
    with _LAYOUT_LOCK:
        if _LAYOUT_READY:
            return
        VIBES_DIR.mkdir(parents=True, exist_ok=True)
        VIBES_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        try:
            migrate_legacy()
        except Exception as e:
            logger.error(f"拆分 vibes.json 失败 (仍按目录结构运行): {e}")
            logger.opt(exception=True).debug("拆分 vibes.json 失败堆栈:")
        _LAYOUT_READY = True


def migrate_legacy() -> int:
    """把老的单文件 vibes.json 拆成 <id>.json + 同名缩略图, 原文件改名留档。

    幂等: 没有 vibes.json 时什么都不做。缩略图原本是内嵌的 base64, 这里落成
    <id>.jpg/.png —— 之后再删图片文件, 列表里就真的不会再有图了。
    """
    if not LEGACY_VIBES_FILE.is_file():
        return 0
    data = jsonstore.read_dict(LEGACY_VIBES_FILE)
    raw_items = data.get("items") if isinstance(data.get("items"), list) else []
    moved = 0
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        vid = _safe_id(str(item.get("id") or ""))
        if not vid:
            continue
        item["id"] = vid
        thumb = item.pop("thumbnail", None)
        inline = item.pop("image", None)
        if isinstance(thumb, str) and thumb:
            _store_thumb(vid, thumb)
        if isinstance(inline, str) and inline and not item.get("image_file"):
            stored = _store_image(vid, _decode_data_url(inline))
            if stored:
                item["image_file"] = stored
        _write_item(item)
        moved += 1

    meta = {
        "version": _META_VERSION,
        "categories": [str(c).strip() for c in (data.get("categories") or []) if str(c).strip()],
        "builtin_seeded": bool(data.get("builtin_seeded")),
        # 空字符串 = 沿用老行为 (默认分类叫「默认」), 由 _default_category() 兜底
        "default_category": "",
    }
    _save_meta(meta)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    archive = LEGACY_VIBES_FILE.with_name(f"vibes.json.migrated-{stamp}")
    try:
        LEGACY_VIBES_FILE.replace(archive)
    except OSError as e:
        logger.warning(f"旧清单改名失败 (内容已拆分, 可手动删除): {e}")
    logger.success(
        f"已把 vibes.json 拆成 {moved} 个条目文件 (data/state/vibes/<id>.json + 同名缩略图),旧文件留档为 {archive.name}"
    )
    return moved


_IMG_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
)


def _image_ext(raw: bytes) -> str:
    for magic, ext in _IMG_MAGIC:
        if raw.startswith(magic):
            return ext
    return ".bin"


def _store_image(vibe_id: str, raw: bytes | None) -> str | None:
    """把原图写到磁盘, 返回文件名 (不把 base64 放进 JSON)。"""
    if not raw:
        return None
    try:
        VIBES_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        name = f"{vibe_id}{_image_ext(raw)}"
        (VIBES_IMAGES_DIR / name).write_bytes(raw)
        return name
    except OSError as e:
        # 落盘失败也不丢数据: 退回内嵌存储 (旧格式仍能读)
        logger.error(f"原图落盘失败, 改为内嵌存储: {e}")
        return None


def image_bytes(item: dict) -> bytes | None:
    """取回原图字节: 优先 img/<name>, 其次条目目录下的同名文件, 最后读旧格式内嵌 base64。"""
    name = item.get("image_file")
    if name:
        for base in (VIBES_IMAGES_DIR, VIBES_DIR):
            try:
                path = base / str(name)
                if path.is_file():
                    return path.read_bytes()
            except OSError:
                pass
    return _decode_data_url(item.get("image") or "")


def has_image(item: dict) -> bool:
    """是否真有原图 (只查文件在不在, 不把几 MB 的图读进内存)。"""
    name = item.get("image_file")
    if name:
        for base in (VIBES_IMAGES_DIR, VIBES_DIR):
            try:
                if (base / str(name)).is_file():
                    return True
            except OSError:
                pass
    return bool(item.get("image"))


def image_data_url(item: dict) -> str | None:
    """原图的 data URL (导出/预览用)。"""
    raw = image_bytes(item)
    return _to_data_url(raw) if raw else None


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _fingerprint(encoding: str) -> str:
    return hashlib.sha256(encoding.encode("utf-8", "ignore")).hexdigest()


def _valid_encoding(value: Any) -> bool:
    return isinstance(value, str) and len(value) > _MIN_ENCODING_LEN


def _info_key(information: Any) -> str:
    """information_extracted 的缓存键 (3 位小数, 避免 0.7 与 0.7000000001 分家)。"""
    try:
        return f"{float(information):.3f}"
    except (TypeError, ValueError):
        return "1.000"


# ---------------------------------------------------------------- 查询


def list_items() -> list[dict]:
    """列出全部 vibe (按加入时间倒序), 附带前端展示需要的派生字段。

    thumbnail 现在是**同名图片文件的 URL**, 不再是内嵌 base64 —— 删掉文件就真的没图。
    """
    items = []
    default = _default_category()
    for raw in _iter_items():
        if not raw.get("id"):
            continue
        encodings = raw.get("encodings") or {}
        models = [m for m, v in encodings.items() if isinstance(v, dict) and v]
        # 每个模型下已存编码的"信息提取强度"—— 同一模型换个强度就会多存一份编码,
        # 前端编辑弹窗要把它们全列出来 (只回数值, 不回几十 KB 的编码本体)。
        info_by_model: dict[str, list[float]] = {}
        for model_key, variants in encodings.items():
            if not isinstance(variants, dict) or not variants:
                continue
            values = set()
            for info_key in variants:
                try:
                    values.add(round(float(info_key), 3))
                except (TypeError, ValueError):
                    continue
            if values:
                info_by_model[model_key] = sorted(values, reverse=True)
        item_id = raw["id"]
        items.append(
            {
                "id": item_id,
                "name": raw.get("name") or item_id,
                "source": raw.get("source") or "unknown",
                "created_at": raw.get("created_at"),
                "thumbnail": _thumb_url(item_id),
                "models": models,
                "information": raw.get("information"),
                "info_by_model": info_by_model,
                "strength": raw.get("strength", 0.6),
                "has_image": has_image(raw),
                "file": f"{item_id}.naiv4vibe",
                "category": (raw.get("category") or "").strip() or default,
            }
        )
    items.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
    return items


def list_categories() -> list[str]:
    """全部分类: 当前默认分类 + 显式新建过的空分类 + 条目上出现过的分类。

    空分类必须能留下来, 否则"新建分类"会立刻消失 (条目一旦移走就查不到它)。
    默认分类也是普通分类: 它可以被删, 删完由 delete_category() 把"默认"这个角色
    交给剩下的第一个分类, 所以这里直接用 _default_category() 而不是写死 DEFAULT_CATEGORY。
    """
    meta = _load_meta()
    default = _default_category(meta)
    seen: list[str] = [default]
    for cat in meta.get("categories") or []:
        cat = str(cat).strip()
        if cat and cat not in seen:
            seen.append(cat)
    for raw in _iter_items():
        cat = (raw.get("category") or "").strip() or default
        if cat and cat not in seen:
            seen.append(cat)
    return seen


def create_category(category: str) -> bool:
    """新建一个空分类 (已存在返回 False)。"""
    name = (category or "").strip()
    if not name:
        raise ValueError("分类名不能为空")
    meta = _load_meta()
    cats = [str(c).strip() for c in (meta.get("categories") or []) if str(c).strip()]
    if name in cats or name in list_categories():
        return False
    cats.append(name)
    meta["categories"] = cats
    _save_meta(meta)
    logger.success(f"已新建 Vibe 分类: {name}")
    return True


def set_category(vibe_id: str, category: str) -> dict | None:
    """把某个 vibe 移到指定分类 (空值归默认分类)。"""
    item = get_item(vibe_id)
    if item is None:
        return None
    item["category"] = (category or "").strip() or _default_category()
    return _upsert(item)


def delete_category(category: str) -> int:
    """删除一个分类 (默认分类也可以删): 里面的 vibe **一起移入系统回收站**。

    与卡片库删除分类一致 (wildcards.delete_type): 分类连同内容一起进回收站,
    需要的话可以从系统回收站原样恢复 (json / 缩略图 / 原图 / 导出文件都会留在暂存目录里)。

    删除的是默认分类时, "默认"这个角色转交给剩下的第一个分类;
    最后一个分类不能删 (否则新导入的 vibe 无处安放)。
    """
    name = (category or "").strip()
    if not name:
        raise ValueError("分类名不能为空")
    meta = _load_meta()
    all_cats = list_categories()
    if name not in all_cats:
        raise ValueError(f"分类不存在: {name}")
    remaining = [c for c in all_cats if c != name]
    if not remaining:
        raise ValueError("至少要保留一个分类 —— 请先新建一个分类再删这个")

    old_default = _default_category(meta)
    victims = [raw for raw in _iter_items() if ((raw.get("category") or "").strip() or old_default) == name]
    # 先把整批文件挪出去 (立刻从列表消失), 后台线程再丢回收站
    trashed = _trash_items(victims, f"cat-{name}")
    if name == old_default:
        new_default = remaining[0]
        meta["default_category"] = new_default
        cats = [str(c).strip() for c in (meta.get("categories") or []) if str(c).strip()]
        if new_default not in cats:
            cats.append(new_default)
        meta["categories"] = cats
    meta["categories"] = [c for c in (meta.get("categories") or []) if str(c).strip() != name]
    _save_meta(meta)
    logger.info(f"已删除 Vibe 分类 {name} ({trashed} 个 vibe 移入回收站)")
    return trashed


def rename_category(old: str, new: str) -> int:
    """整类改名, 返回受影响的条目数 (新名为空时不允许)。"""
    new = (new or "").strip()
    if not new:
        raise ValueError("分类名不能为空")
    meta = _load_meta()
    old_default = _default_category(meta)
    old = (old or "").strip() or old_default
    count = 0
    for raw in _iter_items():
        current = (raw.get("category") or "").strip() or old_default
        if current == old:
            raw["category"] = new
            _write_item(raw)
            count += 1
    # meta 里登记过的空分类名也要跟着改, 否则旧名字会作为一个空分类残留下来
    cats = [str(c).strip() for c in (meta.get("categories") or []) if str(c).strip()]
    if old in cats:
        cats = [new if c == old else c for c in cats]
    elif count:
        cats.append(new)
    dedup: list[str] = []
    for c in cats:
        if c and c not in dedup:
            dedup.append(c)
    meta["categories"] = dedup
    if old == old_default:
        meta["default_category"] = new
    _save_meta(meta)
    return count


def get_item(vibe_id: str) -> dict | None:
    """按 id 读单条 (目录里没有 <id>.json 就是不存在)。"""
    ensure_layout()
    path = _item_file(vibe_id)
    if path is None:
        return None
    return _read_item_file(path)


def find_by_encoding(encoding: str) -> dict | None:
    """按编码串查重 (同一编码不重复入库)。"""
    if not _valid_encoding(encoding):
        return None
    for raw in _iter_items():
        for variants in (raw.get("encodings") or {}).values():
            if isinstance(variants, dict) and encoding in variants.values():
                return raw
    return None


def encoding_for(item: dict, model: str, information: Any = None) -> str | None:
    """取某模型下已缓存的编码; 没有返回 None。

    给了 information 就要求**精确匹配**: 官方把 information_extracted 当作编码的入参,
    换个数值等于换了一份编码, 不能拿别的数值顶替 (否则画风会跑偏)。
    """
    key = MODEL_KEY.get(model)
    if not key:
        return None
    variants = (item.get("encodings") or {}).get(key)
    if not isinstance(variants, dict) or not variants:
        return None
    want = information if information is not None else item.get("information")
    if want is not None:
        hit = variants.get(_info_key(want))
        if _valid_encoding(hit):
            return hit
        if information is not None:
            return None  # 指定了数值就必须精确命中, 不回退到别的数值
    for value in variants.values():
        if _valid_encoding(value):
            return value
    return None


# ---------------------------------------------------------------- 写入


def _upsert(item: dict) -> dict:
    """按 id 写入或覆盖单条记录, 返回落库后的内容。"""
    return _write_item(item)


def add_encoded(
    *,
    encoding: str,
    model: str,
    name: str | None = None,
    information: float | None = None,
    strength: float = 0.6,
    source: str = "image",
    image_data_url: str | None = None,
    thumbnail: str | None = None,
    category: str | None = None,
) -> dict:
    """把一份"已编码"的结果存入库 (同编码已存在时合并模型条目)。"""
    if not _valid_encoding(encoding):
        raise ValueError("Vibe 编码无效 (长度不足)")
    key = MODEL_KEY.get(model)
    if not key:
        raise ValueError(f"不支持的模型: {model}")

    existing = find_by_encoding(encoding)
    if existing is not None:
        existing.setdefault("encodings", {}).setdefault(key, {})[_info_key(information)] = encoding
        # 缩略图是独立文件: 已经有就不覆盖 (与原先"只在没有时补"的语义一致)
        if thumbnail and not _thumb_file(existing["id"]):
            _store_thumb(existing["id"], thumbnail)
        if image_data_url and not has_image(existing):
            stored = _store_image(existing["id"], _decode_data_url(image_data_url))
            if stored:
                existing["image_file"] = stored
        return _upsert(existing)

    item_id = _new_id()
    item = {
        "id": item_id,
        "name": name or f"Vibe {_fingerprint(encoding)[:8]}",
        "source": source,
        "created_at": time.time(),
        "strength": float(strength),
        "category": (category or "").strip() or _default_category(),
        "information": information,
        # 原图单独存文件 (换模型/换 information 时还要重新编码, 必须留着)
        "image_file": _store_image(item_id, _decode_data_url(image_data_url or "")),
        "encodings": {key: {_info_key(information): encoding}},
    }
    if thumbnail:
        _store_thumb(item_id, thumbnail)
    return _upsert(item)


def add_from_document(doc: dict, *, name: str | None = None, source: str = "bundle") -> list[dict]:
    """从一个 .naiv4vibe / .naiv4vibebundle 文档导入 (可能含多个 vibe)。"""
    docs = doc.get("vibes") if isinstance(doc.get("vibes"), list) else [doc]
    out: list[dict] = []
    for one in docs:
        if not isinstance(one, dict):
            continue
        variants = one.get("encodings") or {}
        info = (
            ((one.get("importInfo") or {}).get("information_extracted"))
            if isinstance(one.get("importInfo"), dict)
            else None
        )
        strength = (
            float(((one.get("importInfo") or {}).get("strength")) or 0.6)
            if isinstance(one.get("importInfo"), dict)
            else 0.6
        )
        # 文件里带原图时一并收下: 导出要靠它还原成"能解码出图片"的官方格式,
        # 另外将来换模型重新编码也必须有原图。
        file_category = (one.get("npsCategory") or "").strip()
        raw_image = _decode_data_url(one.get("image") or "")
        image_url = _to_data_url(raw_image) if raw_image else None
        thumbnail = one.get("thumbnail")
        if isinstance(thumbnail, str) and thumbnail and not thumbnail.startswith("data:"):
            thumbnail = f"data:image/png;base64,{thumbnail}"

        entry = None
        for model, key in MODEL_KEY.items():
            bucket = variants.get(key)
            if not isinstance(bucket, dict):
                continue
            encoding = None
            if info is not None:
                encoding = bucket.get(_info_key(info))
            if not _valid_encoding(encoding):
                for value in bucket.values():
                    if isinstance(value, dict):
                        value = value.get("encoding")
                    if _valid_encoding(value):
                        encoding = value
                        break
            if _valid_encoding(encoding):
                entry = add_encoded(
                    encoding=encoding,
                    model=model,
                    name=name or one.get("name"),
                    information=info,
                    strength=strength,
                    source=source,
                    image_data_url=image_url,
                    thumbnail=thumbnail,
                    category=file_category or None,
                )
        if entry is not None:
            out.append(entry)
    return out


def touch_model_encoding(item_id: str, model: str, information: Any, encoding: str) -> dict | None:
    """把某模型下新编码的结果补进已有记录。"""
    item = get_item(item_id)
    if item is None or not _valid_encoding(encoding):
        return None
    key = MODEL_KEY.get(model)
    if not key:
        return None
    item.setdefault("encodings", {}).setdefault(key, {})[_info_key(information)] = encoding
    return _upsert(item)


# 回收站暂存目录: 与卡片库(wildcards.delete_type)同一套做法 ——
# 同盘 rename 是毫秒级, 而 send2trash 在 Windows 上稳定要 ~3 秒 (Shell 操作),
# 所以删除分两步: 先把文件挪出条目目录 (立刻从列表消失), 再交给后台线程丢系统回收站。
VIBES_TRASH_DIR = TEMP_DIR / "vibes_trash"


def _item_file_paths(vibe_id: str, item: dict | None = None) -> list[Path]:
    """一个条目在磁盘上的全部文件: json / 缩略图 / 原图 / 导出的 .naiv4vibe。"""
    vid = _safe_id(vibe_id)
    if not vid:
        return []
    paths = [VIBES_DIR / f"{vid}{_ITEM_SUFFIX}", VIBES_DIR / f"{vid}.naiv4vibe"]
    paths.extend(VIBES_DIR / f"{vid}{ext}" for ext in THUMB_EXTS)
    name = (item or {}).get("image_file")
    if name:
        paths.append(VIBES_IMAGES_DIR / str(name))
        paths.append(VIBES_DIR / str(name))  # 历史版本把原图放在条目目录下
    # 去重: 缩略图与原图扩展名相同时会算出同一个路径
    seen: set[str] = set()
    out: list[Path] = []
    for path in paths:
        key = str(path).lower()
        if key not in seen:
            seen.add(key)
            out.append(path)
    return out


def _stage_files(paths: list[Path], dest: Path) -> int:
    """把文件挪进暂存目录 (同盘 rename), 返回实际挪走的数量。"""
    moved = 0
    for src in paths:
        if not src.is_file():
            continue
        # 原图放进 img/ 子目录: 顶层 <id>.png 是缩略图, 不分开会与 img/<id>.png 重名
        target_dir = dest / "img" if src.parent == VIBES_IMAGES_DIR else dest
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
            os.replace(src, target_dir / src.name)
            moved += 1
        except OSError as e:
            logger.warning(f"移入回收站暂存失败 {src}: {e}")
    return moved


def _trash_staged(staged: Path, label: str) -> None:
    """后台线程: 把暂存目录真正丢进系统回收站。"""
    try:
        send2trash.send2trash(str(staged))
        logger.info(f"已将 Vibe {label} 移入系统回收站")
    except Exception as e:
        logger.error(f"Vibe {label} 移入回收站失败 (文件仍在 {staged}): {e}")
        logger.opt(exception=True).debug("Vibe 移入回收站失败堆栈:")


def _sweep_staged() -> None:
    """清理上次没来得及丢进回收站的暂存目录 (进程被关掉时会留下)。"""
    try:
        for old in VIBES_TRASH_DIR.iterdir():
            if old.is_dir() and time.time() - old.stat().st_mtime > 60:
                _trash_staged(old, old.name)
    except OSError:
        pass


def _trash_items(items: list[dict], label: str) -> int:
    """把若干条目整体移入回收站 (立即返回, 真正丢回收站由后台线程完成)。"""
    if not items:
        return 0
    try:
        VIBES_TRASH_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.error(f"创建 Vibe 回收站暂存目录失败: {e}")
        return 0
    # 分类名可能带空格/斜杠等, 只留安全字符当目录名
    safe = re.sub(r"[^\w\u4e00-\u9fa5.-]", "_", label)[:40] or "vibes"
    staged = VIBES_TRASH_DIR / f"{time.time_ns()}_{safe}"
    for item in items:
        vid = _safe_id(str(item.get("id") or ""))
        if not vid:
            continue
        _stage_files(_item_file_paths(vid, item), staged)
        with _LOCK:
            _ITEM_CACHE.pop(vid, None)
    threading.Thread(
        target=lambda: (_sweep_staged(), _trash_staged(staged, label)),
        daemon=True,
        name="vibes-trash",
    ).start()
    return len(items)


def delete_item(vibe_id: str) -> bool:
    """删除一个 vibe: 条目 JSON 与同名缩略图/原图/导出文件一并删掉。"""
    item = get_item(vibe_id)
    if item is None:
        return False
    _trash_items([item], f"vibe-{vibe_id}")
    return True


def rename_item(vibe_id: str, name: str) -> dict | None:
    item = get_item(vibe_id)
    if item is None:
        return None
    item["name"] = (name or "").strip() or item["name"]
    return _upsert(item)


def set_thumbnail(vibe_id: str, thumbnail: str) -> dict | None:
    """换缩略图 (只写同名图片文件, 不动 JSON)。"""
    item = get_item(vibe_id)
    if item is None:
        return None
    if thumbnail:
        _store_thumb(vibe_id, thumbnail)
    return item


# ---------------------------------------------------------------- 导出


def build_document(item: dict) -> dict:
    """把库记录还原成标准 .naiv4vibe 文档 (官方 client 能识别的结构)。

    格式以官方/其它工具产出的文件为准 (实测比对 Semi-Auto-NovelAI-to-Pixiv 的 test.naiv4vibe):

        identifier / version / type: "image" / image / id / encodings / name /
        thumbnail / createdAt / importInfo

    **image 是必须的**: 官方导入后能"解码出图片"靠的就是这个字段 (整张原图的 base64)。
    早先这里写成 type: "encoding" 且不带 image, 导入后只剩一串编码, 自然看不到图。
    """
    encodings: dict[str, dict] = {}
    information = item.get("information")
    for model, key in MODEL_KEY.items():
        encoding = encoding_for(item, model)
        if not encoding:
            continue
        variant: dict[str, Any] = {"encoding": encoding}
        if information is not None:
            variant["params"] = {"information_extracted": float(information)}
        # 外层 key 用 encoding 的 sha256: 官方文件里是一串 64 位哈希,
        # 用它正好能保证"同一编码不同 information 各占一条"且不互相覆盖。
        encodings[key] = {_fingerprint(encoding): variant}
    if not encodings:
        raise ValueError("这个 vibe 还没有任何可用编码")

    raw = image_bytes(item)
    doc: dict[str, Any] = {
        "identifier": VIBE_IDENTIFIER,
        "version": 1,
        # 有原图就是 image 型 (官方会渲染缩略图/预览); 没有原图才退化成 encoding 型
        "type": "image" if raw else "encoding",
        "id": _fingerprint(base64.b64encode(raw).decode()) if raw else item["id"],
    }
    if raw:
        # 官方文件里 image 就是裸 base64 (不带 data: 前缀)
        doc["image"] = base64.b64encode(raw).decode()
    doc["encodings"] = encodings
    doc["name"] = item.get("name") or item["id"]
    # 缩略图在磁盘上是同名图片文件, 导出时再拼回官方要的 data URL
    thumbnail = thumbnail_data_url(item)
    if thumbnail:
        doc["thumbnail"] = thumbnail
    doc["createdAt"] = int((item.get("created_at") or time.time()) * 1000)
    category = (item.get("category") or "").strip()
    if category and category != _default_category():
        # 非官方字段: 只用来在导回本工具时还原分类, 其它客户端会忽略
        doc["npsCategory"] = category
    if information is not None:
        doc["importInfo"] = {
            "model": next((m for m, k in MODEL_KEY.items() if k in encodings), "nai-diffusion-4-5-full"),
            "information_extracted": float(information),
            "strength": float(item.get("strength") or 0.6),
        }
    return doc


def export_file(vibe_id: str) -> str:
    """导出为 <id>.naiv4vibe 并返回路径 (供用户在文件管理器里查看/拷走)。"""
    item = get_item(vibe_id)
    if item is None:
        raise ValueError("vibe 不存在")
    doc = build_document(item)
    VIBES_DIR.mkdir(parents=True, exist_ok=True)
    target = VIBES_DIR / f"{vibe_id}.naiv4vibe"
    import json as _json

    target.write_text(_json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(target)


def _normalize_image(raw: bytes, max_side: int = 1024):
    """把任意图片转成 (PNG 原图, PNG 缩略图), 都去掉 alpha 并按长边缩放。

    NovelAI 的 encode-vibe 只吃 RGB PNG; 带 alpha 或超大尺寸会被拒或编码质量变差。
    """
    from io import BytesIO

    from PIL import Image

    im = Image.open(BytesIO(raw))
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (0, 0, 0))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")

    png = BytesIO()
    im.save(png, format="PNG")

    thumb = im.copy()
    thumb.thumbnail((max_side, max_side), Image.LANCZOS)
    tbuf = BytesIO()
    thumb.save(tbuf, format="PNG")
    return png.getvalue(), tbuf.getvalue()


def _to_data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def _decode_data_url(value: str) -> bytes | None:
    """把图片字符串解析为原始字节。

    两种形态都要认 (官方的 .naiv4vibe 用前者, 我们自己的 state 用后者):
      - 裸 base64: 官方文件里 image 字段就是纯 base64, 不带 data: 前缀
      - data URL : data:image/png;base64,xxx (前端缩略图 / 我们自己存的原图)
    早先只认 data: 前缀, 于是导入官方文件时原图被静默丢掉, 导出后就解不出图片。
    """
    if not isinstance(value, str) or not value:
        return None
    payload = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    # 纯文本文件不会有这么长的 base64; 太短的一定不是图片
    if len(payload) < 64:
        return None
    try:
        raw = base64.b64decode(payload + "=" * (-len(payload) % 4), validate=False)
    except Exception:
        return None
    # 只认真正的图片魔数, 避免把一段普通文本误当原图
    return raw if raw[:8] in (b"\x89PNG\r\n\x1a\n",) or raw[:3] == b"\xff\xd8\xff" else None


def _model_from_source(source: str) -> str:
    """从 PNG 的 Source 字段推断模型 id (猜不出时按 4.5 full 处理)。"""
    text = str(source or "").upper()
    if "V5" in text:
        return "nai-diffusion-5-full"
    if "4.5" in text or "4_5" in text:
        return "nai-diffusion-4-5-full"
    if "V4" in text:
        return "nai-diffusion-4-full"
    if "V3" in text or "FURRY" in text:
        return "nai-diffusion-3"
    return "nai-diffusion-4-5-full"


def extract_embedded_encoding(raw: bytes) -> list[dict]:
    """从图片元数据里读已有的 Vibe 编码 (零成本, 不调 API)。

    NovelAI 把生成参数写进 PNG 的 Comment (JSON), 其中 reference_image_multiple /
    reference_strength_multiple 就是这次生成用到的 vibe 编码与强度。
    """
    import json as _json
    from io import BytesIO

    try:
        from PIL import Image

        im = Image.open(BytesIO(raw))
        info = im.info or {}
    except Exception:
        return []

    payload = info.get("Comment") or info.get("comment")
    if not isinstance(payload, str):
        return []
    try:
        data = _json.loads(payload)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []

    encodings = data.get("reference_image_multiple")
    if not isinstance(encodings, list) or not encodings:
        return []
    strengths = data.get("reference_strength_multiple")
    strengths = strengths if isinstance(strengths, list) else []
    information = data.get("reference_information_extracted_multiple")
    information = information if isinstance(information, list) else []

    # Comment 里没有 model 字段, 只能从 Source 推断 (如 "NovelAI Diffusion V4.5 4BDE2A90")
    model = _model_from_source(info.get("Source"))

    out = []
    for i, encoding in enumerate(encodings):
        if not _valid_encoding(encoding):
            continue
        out.append(
            {
                "encoding": encoding,
                "strength": float(strengths[i]) if i < len(strengths) else 0.6,
                "information": float(information[i]) if i < len(information) else None,
                "model": model,
            }
        )
    return out


def encode_via_api(image_b64: str, model: str, information: float = 1.0) -> str:
    """调用 /ai/encode-vibe 现场编码, 返回可直接进 reference_image_multiple 的编码串。

    官方返回的是**二进制** (application/binary, 实测 4.5 full 约 48KB), 必须 base64
    之后才能作为 reference_image_multiple 的元素 —— 直接当文本用会校验失败。
    """
    import requests

    from utils.api_endpoint import current_endpoints
    from utils.models.headers import build_headers
    from utils.variable import get_proxies

    endpoints = current_endpoints()
    body = {"image": image_b64, "model": model, "information_extracted": float(information)}
    try:
        rep = requests.post(
            endpoints.encode_vibe,
            json=body,
            headers=build_headers(),
            proxies=get_proxies(),
            timeout=(30, 120),
        )
    except Exception as e:
        raise RuntimeError(f"Vibe 编码请求失败: {e}") from e

    if rep.status_code != 200:
        detail = ""
        try:
            detail = str(rep.json().get("message") or "")
        except Exception:
            detail = rep.text[:200]
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"Vibe 编码失败 (HTTP {rep.status_code}){suffix}")

    content = rep.content
    if not content:
        raise RuntimeError("Vibe 编码返回为空")

    # 官方返回二进制; 少数中转站可能直接返回 base64 文本, 两种都兼容
    try:
        text = content.decode("ascii")
        if _valid_encoding(text):
            return text
    except (UnicodeDecodeError, AttributeError):
        pass
    encoded = base64.b64encode(content).decode()
    if not _valid_encoding(encoded):
        raise RuntimeError("Vibe 编码返回内容异常")
    return encoded


def add_pending_image(
    raw: bytes,
    *,
    model: str,
    name: str | None = None,
    information: float = 1.0,
    strength: float = 0.6,
    category: str | None = None,
) -> dict:
    """只收下原图, **不编码**: 生成时再现场编码 (每个 2 Anlas)。

    用于"风格迁移"里拖入一张不含编码的图片: 先让它出现在列表里并标上"需编码",
    编码费用计入按钮上的总点数, 真正生成时才扣。
    """
    png, thumb = _normalize_image(raw)
    item_id = _new_id()
    item = {
        "id": item_id,
        "name": name or f"Vibe {item_id[:8]}",
        "source": "image-pending",
        "created_at": time.time(),
        "strength": float(strength),
        "category": (category or "").strip() or _default_category(),
        "information": float(information),
        "image_file": _store_image(item_id, png),
        "encodings": {},  # 还没有任何模型的编码
        "pending_model": model,  # 记下当时选的模型, 仅用于说明
    }
    _store_thumb(item_id, thumb)
    logger.info(f"已收下一个待编码的 Vibe 图片: {item['name']} (生成时编码, 2 Anlas)")
    return _upsert(item)


# 仓库自带的示例 Vibe (与 wildcards/ 同理): 克隆后首次启动自动入库, 之后不再重复。
# 位置与导出的 .naiv4vibe 同目录, 但**只认 BUILTIN_VIBE_FILES 里的文件名** ——
# 否则会把本库自己导出的 <id>.naiv4vibe 也当成自带内容重新导进来。
BUILTIN_VIBES_DIR = VIBES_DIR
BUILTIN_VIBE_FILES = ("test.naiv4vibe", "test.naiv4vibebundle")


def seed_builtin(force: bool = False) -> int:
    """把仓库自带的示例 Vibe 收进素材库 (默认只做一次)。

    与 wildcards/ 的思路一致: 用户克隆仓库后**无需手动导入**就能在 Vibe 库里看到。
    用 builtin_seeded 标记保证只播种一次 —— 用户删掉之后不会自动复活。
    返回新加入的条目数。
    """
    meta = _load_meta()
    if meta.get("builtin_seeded") and not force:
        return 0
    if not BUILTIN_VIBES_DIR.is_dir():
        # 没有示例目录 (比如安装的是精简包): 直接标记, 之后不再检查
        meta["builtin_seeded"] = True
        _save_meta(meta)
        return 0

    added = 0
    for name in BUILTIN_VIBE_FILES:
        path = BUILTIN_VIBES_DIR / name
        if not path.is_file():
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning(f"自带示例 Vibe 解析失败 ({path.name}): {e}")
            continue
        try:
            before = len(_iter_items())
            add_from_document(doc, source="builtin")
            added += max(0, len(_iter_items()) - before)
        except Exception as e:
            logger.warning(f"自带示例 Vibe 导入失败 ({path.name}): {e}")

    meta = _load_meta()
    meta["builtin_seeded"] = True
    _save_meta(meta)
    if added:
        logger.success(f"已把 {added} 个自带示例 Vibe 放入素材库 (无需手动导入)")
    return added


def import_image(
    raw: bytes,
    *,
    model: str,
    name: str | None = None,
    information: float = 1.0,
    strength: float = 0.6,
    encode: bool = True,
    pending: bool = False,
) -> dict:
    """导入一张图片作为 vibe。

    顺序: 图片自带编码 (免费) -> 库里已有同一张图 -> 都没有才调 API 编码。
    encode=False 时只做"预演", 不花钱, 返回 needs_encode 供前端确认。
    """
    png, thumb = _normalize_image(raw)
    data_url = _to_data_url(png)
    thumb_url = _to_data_url(thumb)

    # 1) 图片里自带的编码 (零成本)
    for one in extract_embedded_encoding(raw):
        target_model = one["model"] if one["model"] in MODEL_KEY else model
        item = add_encoded(
            encoding=one["encoding"],
            model=target_model,
            name=name,
            information=one["information"] if one["information"] is not None else information,
            strength=one["strength"],
            source="image-metadata",
            image_data_url=data_url,
            thumbnail=thumb_url,
        )
        logger.success(f"从图片元数据读到 Vibe 编码, 已存入 vibes 库: {item['name']}")
        return {"ok": True, "item": item, "encoded": False, "from": "metadata"}

    # 2) 同一张原图之前处理过
    digest = hashlib.sha256(png).hexdigest()
    for raw_item in _iter_items():
        stored_raw = image_bytes(raw_item)
        if not stored_raw or hashlib.sha256(stored_raw).hexdigest() != digest:
            continue
        cached = encoding_for(raw_item, model)
        if cached:
            logger.info(f"这个 Vibe 已有 {model} 的编码, 直接复用: {raw_item.get('name')}")
            return {"ok": True, "item": raw_item, "encoded": False, "from": "cache"}
        if model not in ENCODABLE_MODELS:
            # 这个模型根本编不了码: 别答应"2 Anlas 现场编码", 直接说清楚该怎么办
            return {
                "ok": False,
                "unsupported_model": True,
                "model": model,
                "existing_id": raw_item.get("id"),
                "message": (
                    f"{model} 不支持现场编码 Vibe (只有 V4 / V4.5 系列支持)。"
                    "请先切到 V4.5 编码一次, 或改用带编码的 .naiv4vibe 文件。"
                ),
            }
        if pending:
            # 已经收过这张图: 直接复用它, 缺的编码等生成时再补
            logger.info(f"这张图已在库里, 沿用现有条目: {raw_item.get('name')} (缺 {model} 编码)")
            return {"ok": True, "item": raw_item, "encoded": False, "from": "pending"}
        pending_info = {
            "ok": False,
            "needs_encode": True,
            "existing_id": raw_item.get("id"),
            "model": model,
            "information": information,
            "message": f"这个 Vibe 还没有 {model} 的编码, 现场编码需要 2 Anlas",
        }
        if not encode:
            return pending_info
        encoding = encode_via_api(base64.b64encode(png).decode(), model, information)
        item = touch_model_encoding(raw_item["id"], model, information, encoding) or raw_item
        logger.success(f"已为 {model} 补充 Vibe 编码: {item.get('name')}")
        return {"ok": True, "item": item, "encoded": True, "from": "encode"}

    # 3) 全新图片
    if model not in ENCODABLE_MODELS:
        # 预演和真编码都要给同一条可读结论 (原先预演也会走到这里抛异常,
        # 前端只拿到一条"导入失败", 用户不知道是模型不支持)
        return {
            "ok": False,
            "unsupported_model": True,
            "model": model,
            "message": (
                f"{model} 不支持现场编码 Vibe (只有 V4 / V4.5 系列支持)。"
                "请先切到 V4.5 编码一次, 或改用带编码的 .naiv4vibe 文件。"
            ),
        }
    if pending:
        # 收下原图, 但不编码: 列表里显示"需编码", 费用等生成时再扣
        item = add_pending_image(
            raw,
            model=model,
            name=name,
            information=information,
            strength=strength,
        )
        return {"ok": True, "item": item, "encoded": False, "from": "pending-pending"}

    if not encode:
        return {
            "ok": False,
            "needs_encode": True,
            "model": model,
            "information": information,
            "image_data_url": data_url,
            "thumbnail": thumb_url,
            "message": "这张图片里没有 Vibe 编码, 现场编码需要 2 Anlas",
        }

    encoding = encode_via_api(base64.b64encode(png).decode(), model, information)
    item = add_encoded(
        encoding=encoding,
        model=model,
        name=name,
        information=information,
        strength=strength,
        source="image-encoded",
        image_data_url=data_url,
        thumbnail=thumb_url,
    )
    logger.success(f"已编码并存入 vibes 库: {item['name']}")
    return {"ok": True, "item": item, "encoded": True, "from": "encode"}


# ---------------------------------------------------------------- 生成请求集成


def find_by_image(raw: bytes) -> dict | None:
    """按图片内容查找库里已有的条目。

    库里存的原图有两种来源: ①从 .naiv4vibe 文件里拿到的原始字节 (未归一化);
    ②现场编码时归一化后再存的。所以原样哈希与归一化哈希都要比一遍。
    """
    digests = {hashlib.sha256(raw).hexdigest()}
    try:
        digests.add(hashlib.sha256(_normalize_image(raw)[0]).hexdigest())
    except Exception:
        pass
    for item in _iter_items():
        stored = image_bytes(item)
        if stored and hashlib.sha256(stored).hexdigest() in digests:
            return item
    return None


def resolve_for_request(vibe: dict, model: str, encode=None) -> dict:
    """把前端传来的 vibe 配置解析成 reference_* 三个数组。

    vibe 支持两种写法:
      {"bundle_path": "..."}                 旧版: 直接给 bundle 文件
      {"library_ids": ["id1", "id2"]}        新版: 引用 vibes 库

    encode(image_b64, model, information) 是可选回调: 有原图但缺当前模型的编码时,
    用它现场编码并回填缓存。
    """
    from pathlib import Path

    from utils.helpers import read_json

    ids = vibe.get("library_ids") or []
    if isinstance(ids, str):
        ids = [ids]

    images: list[str] = []
    strengths: list[float] = []
    informations: list[float] = []
    pending: list[dict] = []

    infos = vibe.get("informations") or {}
    for vibe_id in ids:
        item = get_item(str(vibe_id))
        if item is None:
            logger.warning(f"vibes 库里找不到 {vibe_id}, 已跳过")
            continue
        strength = float((vibe.get("strengths") or {}).get(str(vibe_id), item.get("strength", 0.6)))
        # 每条 vibe 可以用自己的"信息提取强度"覆盖库里的默认值
        info_raw = infos.get(str(vibe_id), item.get("information"))
        information = float(info_raw) if info_raw is not None else 1.0

        encoding = encoding_for(item, model, information)
        if not encoding and encode is not None and model in ENCODABLE_MODELS:
            stored_raw = image_bytes(item)
            if stored_raw is not None:
                try:
                    encoding = encode(base64.b64encode(stored_raw).decode(), model, information)
                    touch_model_encoding(item["id"], model, information, encoding)
                    logger.success(f"已为 {model} 现场编码 Vibe: {item.get('name')}")
                except Exception as e:
                    logger.error(f"现场编码失败 ({item.get('name')}): {e}")

        if encoding:
            images.append(encoding)
            strengths.append(strength)
            informations.append(information)
        else:
            pending.append(
                {
                    "id": item["id"],
                    "name": item.get("name"),
                    "model": model,
                    "message": f"「{item.get('name')}」没有 {model} 的编码",
                }
            )

    # 前端暂存的图片 (没有编码, 生成时才编码并落库)
    for one in vibe.get("staged") or []:
        if not isinstance(one, dict):
            continue
        b64 = str(one.get("image") or "")
        if not b64:
            continue
        information = float(one.get("information", 1.0) or 1.0)
        strength = float(one.get("strength", 0.6) or 0.6)
        label = one.get("name") or "暂存图片"
        # 前端发来的是 dataURL (data:image/png;base64,...), 也可能直接是裸 base64
        raw_bytes = _decode_data_url(b64)
        if not raw_bytes:
            logger.warning(f"暂存图片解不开, 已跳过: {label}")
            continue

        # 库里已有同一张图 (比如上次生成时已编码入库) -> 免费用现成编码
        pooled = find_by_image(raw_bytes)
        if pooled is not None:
            cached = encoding_for(pooled, model, information)
            if cached:
                images.append(cached)
                strengths.append(strength)
                informations.append(information)
                continue

        if encode is None:
            # 预演 (不花钱): 只报"需要编码"
            pending.append({"id": one.get("id"), "name": label, "model": model, "message": f"「{label}」需要编码"})
            continue

        try:
            png, thumb = _normalize_image(raw_bytes)
            encoding = encode(base64.b64encode(png).decode(), model, information)
            add_encoded(
                encoding=encoding,
                model=model,
                name=Path(str(label)).stem if label else None,
                information=information,
                strength=strength,
                source="image-encoded",
                image_data_url=_to_data_url(png),
                thumbnail=_to_data_url(thumb),
            )
            logger.success(f"暂存图片已编码并存入素材库: {label}")
        except Exception as e:
            logger.error(f"暂存图片编码失败 ({label}): {e}")
            pending.append({"id": one.get("id"), "name": label, "model": model, "message": str(e)})
            continue
        images.append(encoding)
        strengths.append(strength)
        informations.append(information)

    # 旧版 bundle: 仍支持, 顺带导入到库里 (以后就能按模型复用)
    bundle = vibe.get("bundle_path")
    if bundle and Path(bundle).exists():
        try:
            for one in add_from_document(read_json(bundle), source="bundle"):
                encoding = encoding_for(one, model)
                if encoding:
                    images.append(encoding)
                    strengths.append(float(one.get("strength") or 0.6))
                    informations.append(float(one.get("information") or 1.0))
        except Exception as e:
            logger.error(f"读取 Vibe bundle 失败 ({bundle}): {e}")

    return {
        "images": images,
        "strengths": strengths,
        "informations": informations,
        "pending": pending,
    }


__all__ = [
    "ENCODABLE_MODELS",
    "MODEL_KEY",
    "THUMB_EXTS",
    "VIBES_DIR",
    "VIBES_META_FILE",
    "add_encoded",
    "add_from_document",
    "build_document",
    "delete_item",
    "encode_via_api",
    "encoding_for",
    "ensure_layout",
    "export_file",
    "extract_embedded_encoding",
    "find_by_encoding",
    "get_item",
    "has_image",
    "image_bytes",
    "import_image",
    "list_items",
    "migrate_legacy",
    "rename_item",
    "resolve_for_request",
    "set_thumbnail",
    "thumbnail_data_url",
    "thumbnail_path",
    "touch_model_encoding",
]
