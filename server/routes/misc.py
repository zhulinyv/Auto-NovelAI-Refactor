"""状态 / 上传 / 图片访问 / wildcards / 提示词补全 API。"""
from __future__ import annotations

import json
import os
import platform
import re
import subprocess
import time
import uuid
from pathlib import Path

import psutil
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


_BROWSE_EXCLUDED_DIRS = {"backgrounds", "uploads", "selector_trash"}  # API 壁纸缓存 / 上传目录 / 图片筛选回收站, 不在图片浏览中展示


@router.get("/browse/folders")
async def browse_folders():
    """列出 outputs 目录及其全部子目录 (相对路径), 供图片浏览视图选择。"""
    base = BASE_DIR / "outputs"
    folders = [""]
    if base.exists():
        for p in sorted(base.rglob("*")):
            if p.is_dir() and not p.name.startswith((".", "__")):
                rel = p.relative_to(base).as_posix()
                if rel.split("/")[0] in _BROWSE_EXCLUDED_DIRS:
                    continue
                folders.append(rel)
    return {"base": "outputs", "folders": folders}


@router.get("/browse/images")
async def browse_images(dir: str = "", recursive: bool = False):
    """列出 outputs 下指定子目录的图片 (recursive=True 时含子目录, 前端自行排序)。"""
    base = (BASE_DIR / "outputs").resolve()
    target = (base / dir).resolve()
    images = []
    # 防目录穿越: 解析后必须仍在 outputs 内
    if str(target).startswith(str(base)) and target.is_dir():
        candidates = target.rglob("*") if recursive else target.iterdir()
        for p in candidates:
            try:
                if not p.is_file() or p.suffix.lower() not in _BROWSE_EXTS:
                    continue
                if "temp_" in p.name.lower():  # 排除临时文件
                    continue
                if p.relative_to(base).as_posix().split("/")[0] in _BROWSE_EXCLUDED_DIRS:
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


# ---------------- 在线壁纸 (API 换图): Bing 每日精选为主, Picsum 兜底 ----------------

_BG_API_DIR = BASE_DIR / "outputs" / "backgrounds"
_BG_API_KEEP = 20  # 本地最多保留的 API 壁纸张数


def _save_api_wallpaper(content: bytes, min_w: int = 1024) -> str:
    """校验图片有效性后保存到 outputs/backgrounds, 返回相对路径 (只保留最近 N 张)。"""
    import time
    from io import BytesIO

    from PIL import Image

    if len(content) > 25 * 1024 * 1024:
        raise RuntimeError("图片体积过大")
    with Image.open(BytesIO(content)) as im:
        fmt = (im.format or "JPEG").lower()
        width = im.width
    if width < min_w:
        raise RuntimeError("图片分辨率过低")

    _BG_API_DIR.mkdir(parents=True, exist_ok=True)
    ext = ".png" if fmt == "png" else ".jpg"
    path = _BG_API_DIR / f"bg_api_{int(time.time() * 1000)}{ext}"
    path.write_bytes(content)
    files = sorted(_BG_API_DIR.glob("bg_api_*"))
    for old in files[:-_BG_API_KEEP]:
        try:
            old.unlink()
        except OSError:
            pass
    return path.as_posix()


@router.post("/bg/random")
async def bg_random_wallpaper(payload: dict = None):
    """从在线壁纸 API 获取一张精美图片并保存, 返回路径与来源。

    payload.source = "bing" (默认): Bing 每日精选壁纸 (近 8 天随机一天,
      cn.bing.com / www.bing.com 双通道) -> Picsum 随机精选图 (兜底)。
    payload.source = "acg": Lolicon API v2 随机动漫壁纸 (Pixiv 收录, 非 R18 横图)。
    图片由后端代理下载, 前端不受跨域限制。
    """
    import random as _random

    import requests as _requests

    source = ((payload or {}).get("source") or "bing").strip().lower()
    errors = []

    # 0) Lolicon 随机动漫壁纸 (API v2: 仅横图 gt1, 非 R18; regular 规格省流量, pid 供前端展示)
    if source == "acg":
        def _fetch(method, url, **kw):
            """直连优先 (实测比走系统代理快), 失败自动改走系统代理重试。"""
            last = None
            for trust_env in (False, True):
                try:
                    sess = _requests.Session()
                    sess.trust_env = trust_env
                    resp = sess.request(method, url, **kw)
                    resp.raise_for_status()
                    return resp
                except Exception as e:
                    last = e
                    logger.warning(f"在线壁纸 Lolicon 请求失败 (trust_env={trust_env}): {e}")
            raise last

        try:
            meta = _fetch(
                "POST",
                "https://api.lolicon.app/setu/v2",
                json={"r18": 0, "num": 1, "aspectRatio": "gt1", "size": ["regular"]},
                timeout=(8, 10),
            )
            res = meta.json()
            if res.get("error"):
                raise RuntimeError(res["error"])
            item = (res.get("data") or [None])[0]
            if not item or not item.get("pid"):
                raise RuntimeError("接口无数据")
            url = (item.get("urls") or {}).get("regular")
            if not url:
                raise RuntimeError("接口未返回图片地址")
            img = _fetch("GET", url, timeout=(8, 30))
            return {
                "path": _save_api_wallpaper(img.content, min_w=800),
                "source": f"Pixiv #{item['pid']}",
                "pid": item["pid"],
                "title": item.get("title") or "",
                "author": item.get("author") or "",
            }
        except Exception as e:
            errors.append(f"Lolicon: {e}")
            logger.warning(f"在线壁纸 Lolicon 获取失败: {e}")
        raise HTTPException(status_code=502, detail="在线壁纸获取失败 (" + "; ".join(errors) + ")")

    # 1) Bing 每日壁纸
    for host in ("https://cn.bing.com", "https://www.bing.com"):
        try:
            idx = _random.randint(0, 7)
            meta = _requests.get(
                f"{host}/HPImageArchive.aspx",
                params={"format": "js", "idx": idx, "n": 1},
                timeout=8,
            )
            meta.raise_for_status()
            images = meta.json().get("images") or []
            if not images or not images[0].get("url"):
                raise RuntimeError("接口无数据")
            url = host + images[0]["url"]
            source = f"Bing 每日精选 · {images[0].get('copyright', '').split('(')[0].strip()}"
            img = _requests.get(url, timeout=25)
            img.raise_for_status()
            return {"path": _save_api_wallpaper(img.content), "source": source}
        except Exception as e:
            errors.append(f"{host}: {e}")
            logger.warning(f"在线壁纸 Bing ({host}) 获取失败: {e}")

    # 2) Picsum 随机精选图 (兜底)
    try:
        seed = _random.randint(0, 10**9)
        img = _requests.get(
            f"https://picsum.photos/seed/{seed}/1920/1080",
            timeout=30,
            allow_redirects=True,
        )
        img.raise_for_status()
        return {"path": _save_api_wallpaper(img.content), "source": "Picsum 随机精选"}
    except Exception as e:
        errors.append(f"Picsum: {e}")
        logger.warning(f"在线壁纸 Picsum 获取失败: {e}")

    raise HTTPException(status_code=502, detail="在线壁纸获取失败 (" + "; ".join(errors) + ")")


@router.get("/bg/state")
async def bg_state_get():
    """读取状态 (背景 + 自定义颜色/模糊), 跨端口与浏览器保留。"""
    data = {"single": None, "folder": None, "interval": 120, "api": False}
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
    if "api" in payload:
        data["api"] = bool(payload.get("api"))
    if "api_source" in payload:
        src = str(payload.get("api_source") or "bing").strip().lower()
        data["api_source"] = src if src in ("bing", "acg") else "bing"
    if "interval" in payload:
        try:
            interval = int(payload.get("interval") or 90)
        except (TypeError, ValueError):
            interval = 10
        if interval < 10:
            interval = 10
        data["interval"] = interval
    if "color" in payload:
        color = payload.get("color")
        data["color"] = color if isinstance(color, dict) and color else None
    if "blur" in payload:
        blur = payload.get("blur")
        data["blur"] = blur if isinstance(blur, dict) and blur else None
    if "art" in payload:
        art = payload.get("art")
        data["art"] = art if isinstance(art, dict) and art.get("pid") else None
    _BG_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _BG_STATE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


@router.get("/image")
async def serve_image(path: str):
    target = _resolve_allowed(path)
    if target is None:
        raise HTTPException(status_code=404, detail="图片不存在或无权访问")
    return FileResponse(target)


@router.get("/hitokoto")
async def hitokoto():
    """一言 (随机句子, 来源 hitokoto.cn): 标题栏展示, 前端每 30 分钟刷新一次。

    服务端转发避免浏览器跨域; 主源失败时尝试国际镜像, 全部失败返回空文本 (前端静默)。
    """
    import requests as _requests

    errors = []
    for url in ("https://v1.hitokoto.cn/", "https://international.v1.hitokoto.cn/"):
        try:
            resp = _requests.get(url, timeout=8)
            resp.raise_for_status()
            data = resp.json()
            text = (data.get("hitokoto") or "").strip()
            if text:
                return {
                    "text": text,
                    "from": (data.get("from") or "").strip(),
                    "from_who": (data.get("from_who") or "").strip(),
                }
        except Exception as e:
            errors.append(f"{e}")
    logger.warning(f"一言获取失败: {'; '.join(errors)}")
    return {"text": "", "from": "", "from_who": ""}


# ---------------- 系统资源占用 (运行日志栏展示) ----------------

# psutil.cpu_percent(interval=None) 首次调用无意义, 启动时先采样一次
psutil.cpu_percent(interval=None)

_GPU_CACHE = {"t": 0.0, "data": None}


def _gpu_stats():
    """通过 nvidia-smi 查询 GPU 占用; 结果缓存 1 秒 (与前端刷新频率一致)。"""
    now = time.time()
    if now - _GPU_CACHE["t"] < 1:
        return _GPU_CACHE["data"]
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=4,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        line = out.stdout.strip().splitlines()[0]
        name, util, mem_used, mem_total = [x.strip() for x in line.split(",")]
        _GPU_CACHE["data"] = {
            "name": name,
            "util": float(util),
            "mem_used": float(mem_used),
            "mem_total": float(mem_total),
        }
    except Exception:
        _GPU_CACHE["data"] = None  # 无独立显卡或 nvidia-smi 不可用
    _GPU_CACHE["t"] = now
    return _GPU_CACHE["data"]


def _os_name():
    """系统版本: Windows 按构建号区分 10/11, 其余用 内核名+版本。"""
    try:
        if platform.system() == "Windows":
            build = int(platform.version().split(".")[-1] or 0)
            return f"Windows {'11' if build >= 22000 else platform.release()}"
        return f"{platform.system()} {platform.release()}"
    except Exception:
        return platform.system()


@router.get("/system/stats")
async def system_stats():
    """系统版本与资源占用 (CPU / 内存 / GPU): 运行日志栏展示, 前端每 1 秒轮询。"""
    mem = psutil.virtual_memory()
    gpu = _gpu_stats()
    return {
        "app_version": VERSION,
        "os": _os_name(),
        "arch": platform.machine(),
        "cpu_percent": psutil.cpu_percent(interval=None),
        "cpu_cores": psutil.cpu_count(logical=True),
        "mem_percent": mem.percent,
        "mem_used_gb": round(mem.used / 1024**3, 1),
        "mem_total_gb": round(mem.total / 1024**3, 1),
        "gpu": gpu,
    }


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


@router.post("/wildcards/reorder-types")
async def wildcards_reorder_types(payload: dict):
    """保存卡片库分类的自定义排序 (拖拽调整)。"""
    types = payload.get("types")
    if not isinstance(types, list) or not all(isinstance(t, str) for t in types):
        raise HTTPException(status_code=400, detail="参数不合法")
    wildcards.save_types_order([t.strip() for t in types if t.strip()])
    return {"ok": True}


@router.post("/wildcards/delete-type")
async def wildcards_delete_type(payload: dict):
    """删除整个 wildcards 分类 (文件夹连同卡片/封面移到回收站)。"""
    wtype = str(payload.get("type") or "").strip()
    if not wtype or "/" in wtype or "\\" in wtype or wtype in (".", ".."):
        raise HTTPException(status_code=400, detail="分类名不合法")
    try:
        wildcards.delete_type(wtype)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True, "message": f"分类 <{wtype}> 已移到回收站"}


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
_ZH_MAP: dict | None = None


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


_PROMPT_LIB_FILE = BASE_DIR / "outputs" / "prompt_library.json"


def _read_prompt_lib():
    """读取提示词库 (用户收藏: {text, category}, 按最近保存倒序; 兼容迁移旧版纯文本格式)。"""
    try:
        data = json.loads(_PROMPT_LIB_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, list):
            return []
        items = []
        for x in data:
            if isinstance(x, dict) and str(x.get("text") or "").strip():
                items.append({
                    "text": str(x["text"]).strip(),
                    "category": str(x.get("category") or "默认").strip() or "默认",
                })
            elif isinstance(x, str) and x.strip():
                items.append({"text": x.strip(), "category": "默认"})  # 旧版数据迁移
        return items
    except Exception:
        return []


def _write_prompt_lib(items):
    _PROMPT_LIB_FILE.parent.mkdir(parents=True, exist_ok=True)
    _PROMPT_LIB_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


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


_PROMPT_LIB_META_FILE = BASE_DIR / "outputs" / "prompt_library_meta.json"


def _read_prompt_lib_meta():
    """提示词库附加信息: 自带标签/分类隐藏列表 + 分类自定义排序。"""
    meta = {"hidden_tags": [], "hidden_categories": [], "category_order": []}
    try:
        data = json.loads(_PROMPT_LIB_META_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for key in meta:
                if isinstance(data.get(key), list):
                    meta[key] = [str(x) for x in data[key]]
    except Exception:
        pass
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
    _PROMPT_LIB_META_FILE.parent.mkdir(parents=True, exist_ok=True)
    _PROMPT_LIB_META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


@router.post("/suggest/translate")
async def suggest_translate(payload: dict):
    """批量查询标签中文翻译 (供提示词标签块双语展示)。匹配标签名与别名。"""
    zh_map = _get_zh_map()
    translations = {}
    for tag in (payload.get("tags") or [])[:300]:
        key = str(tag).strip().lower().replace(" ", "_")
        if not key or key in translations:
            continue
        translations[str(tag)] = zh_map.get(key, "")
    return {"translations": translations}