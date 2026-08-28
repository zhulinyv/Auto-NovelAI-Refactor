"""状态 / 上传 / 图片访问 / wildcards / 提示词补全 API。"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse

from src.generate_images import generate  # noqa: F401  (确保模型导入)
from utils.jobs import jobs
from utils.config import BASE_DIR, env
from utils.helpers import format_str, read_json
from utils.logger import logger
from utils.plugins import get_manifest
from utils.services import pnginfo as pnginfo_service
from utils.services import selector, settings, wildcards, tagger
from utils.services.wildcards import WILDCARDS_DIR
from utils.variable import (
    CHARACTER_POSITION,
    CR_MODE,
    MODELS,
    NOISE_SCHEDULE,
    QP_PRESET,
    RESOLUTION,
    SAMPLER,
    UC_PRESET,
    VERSION,
    WILDCARD_TYPE,
)

router = APIRouter(prefix="/api", tags=["misc"])

def _resolve_allowed(path: str) -> Path | None:
    """把前端传入的路径解析为绝对路径 (不再限制目录, 默认支持全部磁盘访问)。"""
    if not path:
        return None
    p = Path(path).resolve()
    return p if p.exists() else None


# ---------------------------------------------------------------- 状态

@router.get("/state")
async def get_state():
    last_data = {}
    if (BASE_DIR / "last.json").exists():
        try:
            last_data = read_json(BASE_DIR / "last.json")
        except Exception as e:
            logger.warning(f"读取 last.json 失败: {e}")
    parameters = last_data.get("parameters", {})
    model = last_data.get("model", "nai-diffusion-4-5-full").replace("-inpainting", "")
    if model == "nai-diffusion-4-curated":
        model = "nai-diffusion-4-curated-preview"
    return {
        "version": VERSION,
        "models": MODELS,
        "resolutions": RESOLUTION,
        "samplers": SAMPLER,
        "noise_schedules": NOISE_SCHEDULE,
        "uc_presets": UC_PRESET,
        "qp_presets": QP_PRESET,
        "positions": CHARACTER_POSITION,
        "cr_modes": CR_MODE,
        "wildcard_types": WILDCARD_TYPE,
        "tagger_models": tagger.TAGGER_MODELS,
        "model": model,
        "last": last_data,
        "parameters": parameters,
        "settings": settings.get_settings(),
        "plugins": get_manifest(),
        # plugin_rows 已拆分到 /api/plugins/rows: 含逐插件 git 更新检查,
        # 放在这里会阻塞前端启动时的状态请求数秒
        "busy": jobs.is_busy,
    }


# ---------------------------------------------------------------- 上次参数 (实时读取 last.json)

@router.get("/last")
async def get_last():
    """读取 last.json 中的上次生成参数 (每次实时读取, 用于"加载上次"功能)。"""
    if (BASE_DIR / "last.json").exists():
        try:
            return read_json(BASE_DIR / "last.json")
        except Exception as e:
            logger.warning(f"读取 last.json 失败: {e}")
    return {}


# ---------------------------------------------------------------- 打开图片保存目录

@router.post("/open-dir")
async def open_save_dir(payload: dict):
    """在系统文件管理器中打开图片保存目录 (未指定路径时打开 outputs 根目录)。"""
    path = (payload.get("path") or "").strip()
    target = _resolve_allowed(path) if path else None
    if target is None:
        target = BASE_DIR / "outputs"
    if target.is_file():
        target = target.parent
    target.mkdir(parents=True, exist_ok=True)
    try:
        os.startfile(str(target))
    except AttributeError:
        import subprocess
        subprocess.Popen(["xdg-open", str(target)])


# ---------------------------------------------------------------- 图片浏览

_BROWSE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


@router.get("/browse/folders")
async def browse_folders():
    """列出 outputs 目录及其全部子目录 (相对路径), 供图片浏览视图选择。"""
    base = BASE_DIR / "outputs"
    folders = [""]
    if base.exists():
        for p in sorted(base.rglob("*")):
            if p.is_dir() and not p.name.startswith((".", "__")):
                folders.append(p.relative_to(base).as_posix())
    return {"base": "outputs", "folders": folders}


@router.get("/browse/images")
async def browse_images(dir: str = ""):
    """列出 outputs 下指定子目录的图片文件 (前端自行按名称/时间/大小排序)。"""
    base = (BASE_DIR / "outputs").resolve()
    target = (base / dir).resolve()
    images = []
    # 防目录穿越: 解析后必须仍在 outputs 内
    if str(target).startswith(str(base)) and target.is_dir():
        for p in sorted(target.iterdir()):
            try:
                if not p.is_file() or p.suffix.lower() not in _BROWSE_EXTS:
                    continue
                st = p.stat()
                images.append({
                    "name": p.name,
                    "path": p.as_posix(),
                    "mtime": st.st_mtime,
                    "size": st.st_size,
                })
            except OSError:
                continue
    return {"dir": dir, "images": images}
    return {"message": f"已打开目录: {target}", "path": str(target)}


# ---------------------------------------------------------------- 上传


@router.post("/upload")
async def upload_files(files: list[UploadFile]):
    upload_dir = BASE_DIR / "outputs" / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for file in files:
        original = file.filename or "file"
        safe_name = re.sub(r"[^\w\-.]", "_", Path(original).name)
        target = upload_dir / f"{uuid.uuid4().hex[:8]}_{safe_name}"
        content = await file.read()
        target.write_bytes(content)
        saved.append({"name": original, "path": str(target)})
        logger.info(f"文件已上传: {original} -> {target}")
    return {"files": saved}


@router.post("/pick-folder")
async def pick_folder():
    """弹出系统原生目录选择框, 返回真实绝对路径 (后端直接读取该目录)。"""
    import threading
    result = {}

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            root.update_idletasks()
            path = filedialog.askdirectory(title="选择文件夹")
            root.destroy()
            result["path"] = path or ""
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)

    t = threading.Thread(target=_pick, daemon=True)
    t.start()
    t.join(timeout=600)
    if "error" in result:
        raise HTTPException(status_code=500, detail=f"无法打开目录选择框: {result['error']}")
    return {"path": result.get("path", "")}


@router.post("/pick-file")
async def pick_file(ft: str = ""):
    """弹出系统原生文件选择框, 返回真实绝对路径 (后端直接读取该文件)。
    ft=workbook 时过滤为 Excel 工作簿类型。"""
    import threading
    result = {}
    if ft == "workbook":
        filetypes = [("Excel 工作簿", "*.xlsx *.xls"), ("所有文件", "*.*")]
    else:
        filetypes = [("图片", "*.png *.jpg *.jpeg *.webp *.gif *.bmp"), ("所有文件", "*.*")]

    def _pick():
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            root.update_idletasks()
            path = filedialog.askopenfilename(
                title="选择文件",
                filetypes=filetypes,
            )
            root.destroy()
            result["path"] = path or ""
        except Exception as e:  # noqa: BLE001
            result["error"] = str(e)

    t = threading.Thread(target=_pick, daemon=True)
    t.start()
    t.join(timeout=600)
    if "error" in result:
        raise HTTPException(status_code=500, detail=f"无法打开文件选择框: {result['error']}")
    return {"path": result.get("path", "")}


@router.post("/upload-dir")
async def upload_dir(files: list[UploadFile]):
    """把选中的目录文件整体上传到独立子目录, 返回目录路径 (用于批处理)。"""
    folder = BASE_DIR / "outputs" / "uploads" / f"batch_{uuid.uuid4().hex[:8]}"
    folder.mkdir(parents=True, exist_ok=True)
    count = 0
    for file in files:
        original = file.filename or "file"
        safe_name = re.sub(r"[^\w\-.]", "_", Path(original).name)
        target = folder / safe_name
        content = await file.read()
        target.write_bytes(content)
        count += 1
    logger.info(f"目录上传完成: {folder} ({count} 个文件)")
    return {"path": str(folder), "count": count}


# ---------------------------------------------------------------- 图片访问

# ---------------------------------------------------------------- 背景轮播


@router.post("/bg/list")
async def bg_list(payload: dict):
    """列出文件夹内图片, 用于自定义背景轮播。"""
    folder = (payload.get("path") or "").strip()
    target = _resolve_allowed(folder)
    if target is None or not target.is_dir():
        raise HTTPException(status_code=404, detail="文件夹不存在或无权访问")
    exts = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")
    files = sorted(str(p) for p in target.iterdir() if p.is_file() and p.suffix.lower() in exts)
    if not files:
        raise HTTPException(status_code=404, detail="文件夹中没有图片")
    return {"files": files[:500]}

# ---------------------------------------------------------------- 自定义背景状态持久化

# 状态文件保存在 outputs 目录 (避免污染项目根目录), 跨端口与浏览器保留
_BG_STATE_FILE = BASE_DIR / "outputs" / "bg_state.json"
_BG_STATE_LEGACY_FILE = BASE_DIR / "bg_state.json"


def _migrate_legacy_bg_state():
    """把旧版根目录下的 bg_state.json 迁移到 outputs 目录 (合并旧键后删除旧文件)。"""
    if not _BG_STATE_LEGACY_FILE.exists():
        return
    try:
        legacy = json.loads(_BG_STATE_LEGACY_FILE.read_text(encoding="utf-8"))
        data: dict = {}
        if _BG_STATE_FILE.exists():
            try:
                data = json.loads(_BG_STATE_FILE.read_text(encoding="utf-8"))
            except Exception:
                data = {}
        # 旧文件的键覆盖新文件
        data.update(legacy)
        _BG_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _BG_STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        _BG_STATE_LEGACY_FILE.unlink(missing_ok=True)
        logger.info("已把根目录 bg_state.json 迁移到 outputs 目录")
    except Exception as e:
        logger.warning(f"迁移旧 bg_state.json 失败: {e}")


_migrate_legacy_bg_state()


@router.get("/bg/state")
async def bg_state_get():
    """读取状态 (背景 + 自定义颜色/模糊), 跨端口与浏览器保留。"""
    data = {"single": None, "folder": None, "interval": 10}
    if _BG_STATE_FILE.exists():
        try:
            data.update(json.loads(_BG_STATE_FILE.read_text(encoding="utf-8")))
        except Exception:
            pass
    return data


@router.post("/bg/state")
async def bg_state_save(payload: dict):
    """保存状态 (部分更新: 只更新提供的字段, 未提供的保留原值)。

    支持字段: single / folder / interval (背景) 与 color / blur (外观)。
    """
    data: dict = {}
    if _BG_STATE_FILE.exists():
        try:
            data = json.loads(_BG_STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    if "single" in payload:
        data["single"] = payload.get("single") or None
    if "folder" in payload:
        data["folder"] = payload.get("folder") if isinstance(payload.get("folder"), list) else None
    if "interval" in payload:
        try:
            interval = int(payload.get("interval") or 10)
        except (TypeError, ValueError):
            interval = 10
        if interval < 3:
            interval = 10
        data["interval"] = interval
    if "color" in payload:
        color = payload.get("color")
        data["color"] = color if isinstance(color, dict) and color else None
    if "blur" in payload:
        blur = payload.get("blur")
        data["blur"] = blur if isinstance(blur, dict) and blur else None
    _BG_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _BG_STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


@router.get("/image")
async def serve_image(path: str):
    target = _resolve_allowed(path)
    if target is None:
        raise HTTPException(status_code=404, detail="图片不存在或无权访问")
    return FileResponse(target)


# ---------------------------------------------------------------- wildcards


@router.get("/wildcards/types")
async def wildcard_types():
    return {"types": wildcards.list_types()}


@router.get("/wildcards/{wildcard_type}/names")
async def wildcard_names(wildcard_type: str):
    return {"names": wildcards.list_names(wildcard_type)}


@router.get("/wildcards/{wildcard_type}/cards")
async def wildcard_cards(wildcard_type: str):
    """列出卡片 (含封面信息), 用于网格展示。"""
    return {"cards": wildcards.list_cards(wildcard_type)}


@router.post("/wildcards/{wildcard_type}/{wildcard_name}/cover")
async def upload_cover(wildcard_type: str, wildcard_name: str, file: UploadFile):
    """上传卡片封面图片。"""
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件为空")
    original = (file.filename or "cover.png").lower()
    ext = Path(original).suffix if Path(original).suffix in (".png", ".jpg", ".jpeg", ".webp", ".gif") else ".png"
    path = wildcards.save_cover(wildcard_type, wildcard_name, content, ext)
    return {"message": "封面已保存!", "cover": path}


@router.post("/wildcards/{wildcard_type}/{wildcard_name}/cover-from-image")
async def cover_from_image(wildcard_type: str, wildcard_name: str, payload: dict):
    """把服务器上已有的图片文件直接设为卡片封面 (不重新上传), 用于"使用当前图片作为封面"。"""
    image_path = (payload.get("image_path") or "").strip()
    target = _resolve_allowed(image_path)
    if target is None:
        raise HTTPException(status_code=400, detail="图片不存在或无权访问")
    try:
        path = wildcards.save_cover_from_image(wildcard_type, wildcard_name, str(target))
    except Exception as e:
        logger.error(f"设置封面失败: {e}")
        raise HTTPException(status_code=400, detail=f"设置封面失败: {e}")
    return {"message": "封面已保存!", "cover": path}


@router.get("/wildcards/{wildcard_type}/{wildcard_name}")
async def wildcard_tags(wildcard_type: str, wildcard_name: str):
    return {"tags": wildcards.get_tags(wildcard_type, wildcard_name)}


@router.post("/wildcards")
async def save_wildcard(payload: dict):
    wildcard_type = payload.get("type", "")
    wildcard_name = payload.get("name", "")
    tags = payload.get("tags", "")
    if not wildcard_type or not wildcard_name:
        raise HTTPException(status_code=400, detail="分类与名称不能为空")
    wildcards.save_tags(wildcard_type, wildcard_name, tags)
    return {"message": f"已保存 <{wildcard_type}:{wildcard_name}>!"}


@router.delete("/wildcards/{wildcard_type}/{wildcard_name}")
async def delete_wildcard(wildcard_type: str, wildcard_name: str):
    wildcards.delete(wildcard_type, wildcard_name)
    return {"message": f"已将 <{wildcard_type}:{wildcard_name}> 移动到回收站!"}


@router.post("/wildcards/add-to-prompt")
async def add_wildcard_to_prompt(payload: dict):
    prompt = payload.get("prompt", "")
    wildcard_type = payload.get("type", "")
    wildcard_name = payload.get("name", "")
    return {"prompt": wildcards.add_wildcard_to_prompt(prompt, wildcard_type, wildcard_name)}


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


def _get_tag_cache() -> dict:
    global _TAGS_CACHE
    if _TAGS_CACHE is None:
        _TAGS_CACHE = {
            "rows": [
                (tag.lower(), tag, cat, count, aliases, zh)
                for tag, cat, count, aliases, zh in _load_tags()
            ]
        }
    return _TAGS_CACHE


_SUGGEST_LIMIT = 20


@router.post("/suggest")
async def suggest_tags(payload: dict):
    rows = _get_tag_cache()["rows"]
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
    for tag_l, tag, cat, count, aliases, zh in rows:
        if tag_l.startswith(kw_tag):
            t_exact.append((tag, cat, count, "", zh))
        else:
            hit = next((a for a in aliases if a.startswith(kw_tag)), None)
            if hit is not None:
                t_exact.append((tag, cat, count, hit, zh))
            elif kw_tag in tag_l:
                t_contains.append((tag, cat, count, "", zh))
            else:
                hit2 = next((a for a in aliases if kw_tag in a), None)
                if hit2 is not None:
                    t_alias_sub.append((tag, cat, count, hit2, zh))
                elif zh and kw_zh in zh:
                    t_zh.append((tag, cat, count, "", zh))
        if len(t_exact) >= 40 and len(t_contains) >= 40 and len(t_alias_sub) >= 40 and len(t_zh) >= 40:
            break
    items = (t_exact + t_contains + t_alias_sub + t_zh)[:_SUGGEST_LIMIT]
    return {
        "keyword": keyword,
        "items": [{"tag": t, "category": c, "count": n, "alias": a, "zh": z} for t, c, n, a, z in items],
    }