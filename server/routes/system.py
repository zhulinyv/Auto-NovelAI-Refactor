"""系统与媒体相关 API。

包含: 状态快照 / 就绪探针 / 上次生成参数 / 图片浏览与缩略图 / 收藏 /
上传与系统对话框 / 背景与在线壁纸 / 图片访问 / 一言 / 系统资源统计。

从 server/routes/misc.py 拆出 (原文件 1549 行, 一个模块里混了 6 类互不相关的功能)。
"""

from __future__ import annotations

import hashlib
import os
import platform
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

import psutil
import send2trash
from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse

from utils import http_client as http_util
from utils import jsonstore
from utils.config import BASE_DIR, LAST_FILE, resolve_media_path
from utils.gen_queue import gen_queue
from utils.helpers import get_update_status, read_json
from utils.jobs import jobs
from utils.logger import logger
from utils.paths import BG_API_DIR, STATE_DIR, THUMB_CACHE_DIR
from utils.plugins import get_manifest, plugins_reload_status
from utils.services import settings as settings_service
from utils.services import tagger
from utils.variable import (
    CHARACTER_POSITION,
    CR_MODE,
    MODELS,
    NOISE_SCHEDULE,
    QP_PRESET,
    QUALITY_TAGS,
    RESOLUTION,
    SAMPLER,
    UC_PRESET,
    UC_PRESET_TAGS,
    VERSION,
    WILDCARD_TYPE,
)

router = APIRouter(prefix="/api", tags=["system"])


def _resolve_allowed(path: str) -> Path | None:
    """把前端传入的路径解析为绝对路径 (不再限制目录, 默认支持全部磁盘访问)。

    相对路径优先按 outputs 根解析: /api/browse/images 返回的正是 outputs 相对路径
    (全屏看图经 /api/image 直接收到该路径); outputs 下不存在时再按当前工作目录
    解析, 兼容旧的 CWD 相对路径调用方。
    """
    if not path:
        return None
    p = Path(path)
    if not p.is_absolute():
        cand = (BASE_DIR / "outputs" / path).resolve()
        if cand.exists():
            return cand
    p = p.resolve()
    return p if p.exists() else None


# ---------------------------------------------------------------- 状态


# last.json 里的 image / mask 是 base64 图片 (实测单次可达 1.5MB), 前端"加载上次"只用
# parameters 里的标量字段 (见 web/js/views/generate.js 读 app.last.parameters), 从不需要
# 这两个大字段。全量读取走 /api/last。此前 /api/state 把整份 last.json 带出去, 每次
# 页面加载都要多传 1.5MB 并同步序列化一次 (与 utils/wake.py 注释里记录的同一个坑)。
_STATE_LAST_DROP_KEYS = ("image", "mask")


def _last_params_for_state() -> dict:
    """读取 last.json 并剔除超大的 base64 图片字段 (供 /api/state 使用)。"""
    if not LAST_FILE.exists():
        return {}
    try:
        last_data = read_json(LAST_FILE)
    except Exception as e:
        logger.warning(f"读取 last.json 失败: {e}")
        logger.opt(exception=True).debug("读取 last.json 失败堆栈:")
        return {}
    if not isinstance(last_data, dict):
        return {}
    params = last_data.get("parameters")
    if isinstance(params, dict):
        for key in _STATE_LAST_DROP_KEYS:
            params.pop(key, None)
    return last_data


@router.get("/state")
async def get_state():
    last_data = _last_params_for_state()
    parameters = last_data.get("parameters", {})
    model = last_data.get("model", "nai-diffusion-4-5-full").replace("-inpainting", "")
    if model == "nai-diffusion-4-curated":
        model = "nai-diffusion-4-curated-preview"
    return {
        "version": VERSION,
        "update": get_update_status(),
        "models": MODELS,
        "resolutions": RESOLUTION,
        "samplers": SAMPLER,
        "noise_schedules": NOISE_SCHEDULE,
        "uc_presets": UC_PRESET,
        "qp_presets": QP_PRESET,
        "quality_preset_tags": QUALITY_TAGS,  # 预设名 -> 标签文本 (前端加载上次时剥离检测用)
        "uc_preset_tags": UC_PRESET_TAGS,  # 负面预设名 -> 标签文本 (前端加载上次时剥离检测用)
        "positions": CHARACTER_POSITION,
        "cr_modes": CR_MODE,
        "wildcard_types": WILDCARD_TYPE,
        "tagger_models": tagger.TAGGER_MODELS,
        "model": model,
        "last": last_data,
        "parameters": parameters,
        "settings": settings_service.get_settings(),
        "plugins": get_manifest(),
        # 插件重载状态: 共享开关切换后前端等待重载完成再刷新一次
        "plugins_reload": plugins_reload_status(),
        # plugin_rows 已拆分到 /api/plugins/rows: 含逐插件 git 更新检查,
        # 放在这里会阻塞前端启动时的状态请求数秒
        "busy": jobs.is_busy,
        # 生图队列快照: 前端启动即可显示队列徽标与状态
        "queue": gen_queue.snapshot(),
    }


@router.get("/ready")
def ready():
    """轻量就绪探针: 只回版本号, 不碰 last.json 等大对象。

    给开始菜单唤醒脚本 (utils/wake.py) 的 0.5s 轮询用。为什么不复用 /api/state:
    那里会把 last.json (含 base64 图片, 实测单次响应 4MB+) 整个序列化返回 ——
    高频探测既拖慢启动, 又容易被调用方按固定长度截断而误判成"后端未就绪"。
    version 与 /api/state 同源 (utils.variable.VERSION), 判据不变 (200 + 含 version)。
    """
    return {"version": VERSION}


# ---------------------------------------------------------------- 上次参数 (实时读取 last.json)


@router.get("/last")
async def get_last():
    """读取 last.json 中的上次生成参数 (每次实时读取, 用于"加载上次"功能)。"""
    if LAST_FILE.exists():
        try:
            return read_json(LAST_FILE)
        except Exception as e:
            logger.warning(f"读取 last.json 失败: {e}")
            logger.opt(exception=True).debug("读取 last.json 失败堆栈:")
    return {}


# ---------------------------------------------------------------- 图片浏览

_BROWSE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


_BROWSE_EXCLUDED_DIRS = {
    "backgrounds",
    "uploads",
    "selector_trash",
}  # API 壁纸缓存 / 上传目录 / 筛选可撤销回收站, 不在图片浏览中展示


@router.get("/browse/folders")
def browse_folders():
    """列出 outputs 目录及其全部子目录 (相对路径), 供图片浏览视图选择。

    同步 def: FastAPI 会在线程池执行, 目录扫描不再阻塞事件循环 (大量图片时应用不再整体卡住)。
    scandir 递归遍历, 遇到排除目录直接跳过, 比 rglob + 逐项 is_dir 快得多。
    """
    base = BASE_DIR / "outputs"
    folders = [""]

    def walk(d: Path, rel_prefix: str):
        try:
            entries = sorted(os.scandir(d), key=lambda e: e.name)
        except OSError:
            return
        for entry in entries:
            if not entry.is_dir(follow_symlinks=False):
                continue
            name = entry.name
            if name.startswith((".", "_")):  # "_"/"." 开头为内部/测试目录
                continue
            rel = f"{rel_prefix}/{name}" if rel_prefix else name
            if rel.split("/")[0] in _BROWSE_EXCLUDED_DIRS:
                continue
            folders.append(rel)
            walk(Path(entry.path), rel)

    if base.exists():
        walk(base, "")
    return {"base": "outputs", "folders": folders}


@router.get("/browse/images")
def browse_images(dir: str = "", recursive: bool = False, limit: int = 0, offset: int = 0):
    """列出 outputs 下指定子目录的图片 (recursive=True 时含子目录, 前端自行排序)。

    同步 def: FastAPI 会在线程池执行, 浏览期间每 5 秒的轮询不再周期性阻塞事件循环。
    scandir 递归遍历 (Windows 上 DirEntry 自带 stat 信息, 无需逐文件 stat),
    并在遍历时跳过排除目录, 大量图片时扫描速度提升一个数量级。

    分页 (limit/offset): 默认 limit=0 表示不分页, 保持旧调用方的行为不变。
    上万张图时整份列表要序列化好几 MB, 且前端本来也只先渲染 100 张 —— 需要分页的
    调用方传 limit 即可; 响应里的 total 是**未分页前的总数**, 供前端算页数。
    """
    base = (BASE_DIR / "outputs").resolve()
    target = (base / dir).resolve()
    images = []
    # 防目录穿越: 解析后必须仍在 outputs 内
    if str(target).startswith(str(base)) and target.is_dir():
        top0 = dir.strip("/").split("/")[0] if dir else None

        def walk(d: Path, top: str | None):
            try:
                with os.scandir(d) as it:
                    for entry in it:
                        name = entry.name
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if not recursive:
                                    continue
                                if name.startswith((".", "_")):
                                    continue
                                child_top = top if top else name
                                if child_top in _BROWSE_EXCLUDED_DIRS:
                                    continue
                                walk(Path(entry.path), child_top)
                                continue
                            if not entry.is_file(follow_symlinks=False):
                                continue
                            if "temp_" in name.lower():  # 排除临时文件
                                continue
                            if os.path.splitext(name)[1].lower() not in _BROWSE_EXTS:
                                continue
                            if top is not None and (top in _BROWSE_EXCLUDED_DIRS or top.startswith(("_", "."))):
                                continue
                            st = entry.stat(follow_symlinks=False)
                            ap = Path(entry.path)
                            images.append(
                                {
                                    "name": name,
                                    # path: 相对 outputs (缩略图等新接口使用); _abs: 绝对路径,
                                    # 供全屏看图 / 删除 / 收藏 / 法术解析等按绝对路径工作的接口使用
                                    "path": ap.relative_to(base).as_posix(),
                                    "_abs": ap.as_posix(),
                                    "mtime": st.st_mtime,
                                    "size": st.st_size,
                                }
                            )
                        except OSError:
                            continue
            except OSError:
                return

        walk(target, top0)
    total = len(images)
    if limit and limit > 0:
        start = max(0, offset)
        images = images[start : start + limit]
    return {"dir": dir, "images": images, "total": total, "offset": max(0, offset), "limit": limit}


@router.post("/browse/delete")
def browse_delete(payload: dict):
    """把图片浏览中的图片移到系统回收站 (send2trash, 不经过 selector_trash 文件夹)。

    同步 def: 回收站操作是阻塞 IO, 在线程池执行避免卡住事件循环。
    """
    path = (payload.get("path") or "").strip()
    base = (BASE_DIR / "outputs").resolve()
    if not path:
        raise HTTPException(status_code=400, detail="缺少图片路径")
    # 相对路径按 outputs 根解析 (图片浏览接口返回 outputs 相对路径)
    target = Path(resolve_media_path(path)).resolve()
    # 防目录穿越: 仅允许删除 outputs 内的图片
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(status_code=404, detail="图片不存在或无权访问")
    if target.suffix.lower() not in _BROWSE_EXTS:
        raise HTTPException(status_code=400, detail="不支持的图片类型")
    try:
        send2trash.send2trash(str(target))
        logger.info(f"已将图片移到系统回收站: {target}")
        return {"ok": True, "path": target.as_posix()}
    except Exception as e:
        logger.error(f"删除图片失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {e}")


# ---------------------------------------------------------------- 图片浏览缩略图

_THUMB_SIZE = 360  # 网格缩略图最长边 (px), 兼容高分屏
_THUMB_DIR = THUMB_CACHE_DIR  # 现已移出 outputs, 不会再混进图片浏览
_THUMB_CAP = 20000  # 缓存文件数上限, 超过后按最旧优先清理一半


@router.post("/browse/reveal")
def browse_reveal(payload: dict):
    """在系统文件管理器中定位显示某张生成图。

    Windows 用 explorer /select, 高亮选中文件本身; 其他平台无对应参数, 退回打开所在目录。
    同步 def: 拉起 explorer 属阻塞操作, FastAPI 会在线程池执行。
    """
    target = _resolve_allowed(str(payload.get("path") or "").strip())
    if target is None or not target.is_file():
        raise HTTPException(404, "文件不存在")
    if os.name == "nt":
        # explorer.exe 不走标准 argv, 自己解析命令行字符串: "/select," 与路径之间有空格会解析失败
        # (只开文件夹不选中); 必须用无空格、路径整体加引号的单参数形态。成功时也返回非零码, 不校验结果
        subprocess.Popen(f'explorer /select,"{target}"')
    else:
        try:
            os.startfile(str(target.parent))
        except AttributeError:
            subprocess.Popen(["xdg-open", str(target.parent)])
    return {"ok": True}


@router.get("/browse/thumb")
def browse_thumb(path: str):
    """返回图片的 360px WebP 缩略图 (磁盘缓存)。

    缓存键包含原图 mtime_ns + size: 原图更新/覆盖后自动失效重新生成。
    同步 def: Pillow 解码/缩放在线程池执行, 不阻塞事件循环。
    生成失败返回 404, 前端收到后回退加载原图。
    """
    base = (BASE_DIR / "outputs").resolve()
    p = Path(path)
    target = (p if p.is_absolute() else base / path).resolve()
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(status_code=404, detail="图片不存在或无权访问")
    if target.suffix.lower() not in _BROWSE_EXTS:
        raise HTTPException(status_code=400, detail="不支持的图片类型")
    try:
        st = target.stat()
    except OSError:
        raise HTTPException(status_code=404, detail="图片不存在")
    rel = target.relative_to(base).as_posix()
    key = hashlib.sha1(f"{rel}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8")).hexdigest()
    _THUMB_DIR.mkdir(parents=True, exist_ok=True)
    thumb = _THUMB_DIR / f"{key}.webp"
    if not thumb.is_file():
        _generate_thumbnail(target, thumb)
    if not thumb.is_file():  # 生成失败 -> 前端回退原图
        raise HTTPException(status_code=404, detail="缩略图生成失败")
    # 缓存键已包含内容版本, 可永久缓存
    return FileResponse(
        thumb, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"}
    )


def _generate_thumbnail(target: Path, thumb: Path) -> None:
    """生成缩略图并原子写入缓存 (失败静默, 由调用方回退 404)。"""
    tmp = None
    try:
        from PIL import Image, ImageOps

        with Image.open(target) as img:
            img.load()
            try:
                img = ImageOps.exif_transpose(img)  # 按 EXIF 方向摆正 (手机拍摄等)
            except Exception as e:
                logger.debug(f"缩略图方向校正失败, 使用原图方向: {e}")
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if img.mode in ("P", "LA", "PA") else "RGB")
            img.thumbnail((_THUMB_SIZE, _THUMB_SIZE), Image.Resampling.LANCZOS)
            tmp = thumb.with_name(f".{uuid.uuid4().hex}.tmp")
            img.save(tmp, format="WEBP", quality=82, method=4)
        os.replace(tmp, thumb)  # 原子替换: 并发请求也不会读到半张图
        _prune_thumb_cache()
    except Exception as e:
        logger.debug(f"缩略图生成失败 {target}: {e}")
        logger.opt(exception=True).debug("缩略图生成失败堆栈:")
        try:
            if tmp is not None and tmp.exists():
                tmp.unlink()
        except OSError:
            pass


# 清理节流: 原先每次生成缩略图都扫一遍缓存目录 (上限 2 万条 -> 2 万次 scandir+stat),
# 改为最多每 _THUMB_PRUNE_INTERVAL 秒检查一次。
_THUMB_PRUNE_INTERVAL = 60.0
_thumb_prune_at = 0.0
_thumb_prune_lock = threading.Lock()


def _prune_thumb_cache() -> None:
    """缓存文件数超过上限时删除最旧的一半 (缩略图随时可再生, 清理失败无影响)。

    带节流: 一分钟内最多真正扫描一次, 避免每次生成缩略图都全量 stat 缓存目录。
    """
    global _thumb_prune_at
    now = time.time()
    with _thumb_prune_lock:
        if now - _thumb_prune_at < _THUMB_PRUNE_INTERVAL:
            return
        _thumb_prune_at = now
    try:
        entries = [e for e in os.scandir(_THUMB_DIR) if e.is_file() and e.name.endswith(".webp")]
        if len(entries) <= _THUMB_CAP:
            return
        entries.sort(key=lambda e: e.stat().st_mtime)
        for e in entries[: len(entries) // 2]:
            try:
                os.unlink(e.path)
            except OSError:
                pass
    except OSError:
        pass


# ---------------------------------------------------------------- 图片收藏 (我的收藏)
# 仅保存图片路径引用, 不移动/复制文件; 持久化到 data/state/favorites.json
_FAVORITES_FILE = STATE_DIR / "favorites.json"
_FAVORITES_MAX = 1000


def _read_favorites() -> list:
    """读取收藏列表 (过滤掉已不存在的文件)。"""
    try:
        data = jsonstore.read_dict(_FAVORITES_FILE)
        items = data.get("items", [])
        out = []
        for it in items:
            if not (isinstance(it, dict) and it.get("path")):
                continue
            # 相对路径按 outputs 根解析 (兼容旧数据); 统一回绝对路径 posix, 与浏览接口 _abs 同形式
            fp = Path(resolve_media_path(str(it["path"]))).as_posix()
            if Path(fp).exists():
                out.append({**it, "path": fp})
        return out
    except Exception:
        return []


def _write_favorites(items: list) -> None:
    # 原子写: 收藏列表是用户手工攒出来的, 半截写入等于全部丢失
    jsonstore.write(_FAVORITES_FILE, {"items": items})


@router.get("/favorites")
async def favorites_get():
    """我的收藏列表 (仅路径引用, 按收藏时间倒序)。"""
    return {"items": _read_favorites()}


@router.post("/favorites/add")
async def favorites_add(payload: dict):
    """把一张图片加入收藏 (不移动/复制文件)。"""
    path = str(payload.get("path") or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="图片路径不能为空")
    # 统一存绝对路径 posix (相对路径按 outputs 根解析), 与 _read_favorites 输出/去重形式一致
    path = Path(resolve_media_path(path)).as_posix()
    name = str(payload.get("name") or "").strip() or Path(path).name
    items = [x for x in _read_favorites() if x["path"] != path]
    items.insert(0, {"path": path, "name": name, "added_at": time.time()})
    _write_favorites(items[:_FAVORITES_MAX])
    return {"items": items}


@router.post("/favorites/remove")
async def favorites_remove(payload: dict):
    """把一张图片移出收藏 (不删除文件)。"""
    path = str(payload.get("path") or "").strip()
    if path:
        path = Path(resolve_media_path(path)).as_posix()
    items = [x for x in _read_favorites() if x["path"] != path]
    _write_favorites(items)
    return {"items": items}


# ---------------------------------------------------------------- 上传


# 上传体积上限: 单文件与单次请求各一道闸。
# 原先 upload_files / upload_dir 都是 content = await file.read() 全量进内存再落盘 ——
# 拖进一个大文件就能让进程内存翻倍; 逐块读写后内存占用恒定, 与文件大小无关。
_MAX_UPLOAD_FILE = 200 * 1024 * 1024  # 单文件 200MB
_MAX_UPLOAD_TOTAL = 1024 * 1024 * 1024  # 单次请求合计 1GB
_UPLOAD_CHUNK = 1024 * 1024  # 1MB


async def _stream_to_file(upload: UploadFile, target: Path, budget: int) -> int:
    """把上传对象分块写到磁盘, 返回字节数; 超过 budget 抛 413。"""
    written = 0
    try:
        with target.open("wb") as f:
            while True:
                chunk = await upload.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > budget:
                    raise HTTPException(status_code=413, detail=f"文件过大: {target.name}")
                f.write(chunk)
    except HTTPException:
        target.unlink(missing_ok=True)  # 半截文件不留
        raise
    except Exception as e:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"写入文件失败: {e}")
    return written


@router.post("/upload")
async def upload_files(files: list[UploadFile], subdir: str = "uploads"):
    parts = [p for p in subdir.split("/") if p]
    if not parts or any(not re.fullmatch(r"[\w\-]+", p) for p in parts):
        raise HTTPException(status_code=400, detail="非法上传子目录")
    upload_dir = BASE_DIR.joinpath("outputs", *parts)
    upload_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    total = 0
    for file in files:
        original = file.filename or "file"
        safe_name = re.sub(r"[^\w\-.]", "_", Path(original).name)
        target = upload_dir / f"{uuid.uuid4().hex[:8]}_{safe_name}"
        total += await _stream_to_file(file, target, _MAX_UPLOAD_FILE)
        if total > _MAX_UPLOAD_TOTAL:
            target.unlink(missing_ok=True)
            raise HTTPException(status_code=413, detail="本次上传总量超过 1GB, 已中止")
        saved.append({"name": original, "path": str(target)})
        logger.info(f"文件已上传: {original} -> {target}")
    return {"files": saved}


@router.post("/pick-folder")
def pick_folder():
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
def pick_file(ft: str = ""):
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
    total = 0
    for file in files:
        original = file.filename or "file"
        safe_name = re.sub(r"[^\w\-.]", "_", Path(original).name)
        target = folder / safe_name
        total += await _stream_to_file(file, target, _MAX_UPLOAD_FILE)
        if total > _MAX_UPLOAD_TOTAL:
            raise HTTPException(status_code=413, detail="本次上传总量超过 1GB, 已中止")
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
    # scandir: Windows 上 DirEntry 自带 stat 信息, 不必逐项 is_file() 再 stat
    files = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                if Path(entry.name).suffix.lower() in exts and entry.is_file(follow_symlinks=False):
                    files.append(entry.path)
    except OSError as e:
        raise HTTPException(status_code=404, detail=f"读取文件夹失败: {e}")
    if not files:
        raise HTTPException(status_code=404, detail="文件夹中没有图片")
    files.sort()
    return {"files": files[:500]}


# ---------------------------------------------------------------- 自定义背景状态持久化

# 状态文件保存在 data/state 目录 (历史位置由 utils.paths.migrate_legacy 统一搬迁)


# ---------------- 在线壁纸 (API 换图): Bing 每日精选为主, Picsum 兜底 ----------------

_BG_API_DIR = BG_API_DIR  # data/caches/backgrounds (原 outputs/backgrounds)

# 自定义背景/外观状态 (跨端口与浏览器保留); 历史位置由 utils.paths.migrate_legacy 搬迁
_BG_STATE_FILE = STATE_DIR / "bg_state.json"
_BG_API_KEEP = 20  # 本地最多保留的 API 壁纸张数


def _save_api_wallpaper(content: bytes, min_w: int = 1024) -> str:
    """校验图片有效性后保存到 data/caches/backgrounds, 返回绝对路径 (只保留最近 N 张)。"""
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
def bg_random_wallpaper(payload: dict = None):
    """从在线壁纸 API 获取一张精美图片并保存, 返回路径与来源。

    payload.source = "bing" (默认): Bing 每日精选壁纸 (近 8 天随机一天,
      cn.bing.com / www.bing.com 双通道) -> Picsum 随机精选图 (兜底)。
    payload.source = "acg": Lolicon API v2 随机动漫壁纸 (Pixiv 收录, 非 R18 横图)。
    图片由后端代理下载, 前端不受跨域限制。
    """
    import random as _random

    source = ((payload or {}).get("source") or "bing").strip().lower()
    errors = []

    # 0) Lolicon 随机动漫壁纸 (API v2: 仅横图 gt1, 非 R18; regular 规格省流量, pid 供前端展示)
    if source == "acg":
        # 直连优先 / 失败自动改走系统代理: 统一实现在 utils.http_client (全项目同一套降级逻辑)
        def _fetch(method, url, **kw):
            return http_util.request(method, url, **kw)

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
            logger.opt(exception=True).debug("在线壁纸 Lolicon 获取失败堆栈:")
        raise HTTPException(status_code=502, detail="在线壁纸获取失败 (" + "; ".join(errors) + ")")

    # 1) Bing 每日壁纸
    for host in ("https://cn.bing.com", "https://www.bing.com"):
        try:
            idx = _random.randint(0, 7)
            meta = http_util.get(
                f"{host}/HPImageArchive.aspx",
                params={"format": "js", "idx": idx, "n": 1},
                timeout=8,
            )
            images = meta.json().get("images") or []
            if not images or not images[0].get("url"):
                raise RuntimeError("接口无数据")
            url = host + images[0]["url"]
            source = f"Bing 每日精选 · {images[0].get('copyright', '').split('(')[0].strip()}"
            img = http_util.get(url, timeout=25)
            return {"path": _save_api_wallpaper(img.content), "source": source}
        except Exception as e:
            errors.append(f"{host}: {e}")
            logger.warning(f"在线壁纸 Bing ({host}) 获取失败: {e}")
            logger.opt(exception=True).debug("在线壁纸 Bing 获取失败堆栈:")

    # 2) Picsum 随机精选图 (兜底)
    try:
        seed = _random.randint(0, 10**9)
        img = http_util.get(
            f"https://picsum.photos/seed/{seed}/1920/1080",
            timeout=30,
            allow_redirects=True,
        )
        return {"path": _save_api_wallpaper(img.content), "source": "Picsum 随机精选"}
    except Exception as e:
        errors.append(f"Picsum: {e}")
        logger.warning(f"在线壁纸 Picsum 获取失败: {e}")
        logger.opt(exception=True).debug("在线壁纸 Picsum 获取失败堆栈:")

    raise HTTPException(status_code=502, detail="在线壁纸获取失败 (" + "; ".join(errors) + ")")


@router.get("/bg/state")
async def bg_state_get():
    """读取状态 (背景 + 自定义颜色/模糊), 跨端口与浏览器保留。"""
    data = {"single": None, "folder": None, "interval": 120, "api": False, "charm": True}
    data.update(jsonstore.read_dict(_BG_STATE_FILE))
    return data


@router.post("/bg/state")
async def bg_state_save(payload: dict):
    """保存状态 (部分更新: 只更新提供的字段, 未提供的保留原值)。

    支持字段: single / folder / interval (背景), color / blur / art (外观)
    与 charm (侧边栏晴天娃娃开关, 需要跨端口/浏览器/重启保留)。
    """
    data = jsonstore.read_dict(_BG_STATE_FILE)
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
    if "charm" in payload:
        data["charm"] = bool(payload.get("charm"))
    jsonstore.write(_BG_STATE_FILE, data)
    return {"ok": True}


@router.get("/image")
async def serve_image(path: str):
    target = _resolve_allowed(path)
    if target is None:
        raise HTTPException(status_code=404, detail="图片不存在或无权访问")
    return FileResponse(target)


@router.get("/hitokoto")
def hitokoto():
    """一言 (随机句子, 来源 hitokoto.cn): 标题栏展示, 前端每 30 分钟刷新一次。

    服务端转发避免浏览器跨域; 主源失败时尝试国际镜像, 全部失败返回空文本 (前端静默)。
    同步 def: FastAPI 会在线程池执行, 不再阻塞事件循环 (修复启动时 /api/state 排队等待)。
    """
    import concurrent.futures

    errors = []

    def _fetch(url: str) -> dict:
        """直连优先 (与在线壁纸一致), 失败自动改走系统代理重试: 见 utils.http_client。"""
        resp = http_util.get(url, timeout=8)
        data = resp.json()
        text = (data.get("hitokoto") or "").strip()
        if not text:
            raise RuntimeError("接口返回空句子")
        return {
            "text": text,
            "from": (data.get("from") or "").strip(),
            "from_who": (data.get("from_who") or "").strip(),
        }

    # 两个源并行请求, 取先成功的一个 (v1.hitokoto.cn 在国内有时很慢, 国际镜像兜底)
    urls = ("https://v1.hitokoto.cn/", "https://international.v1.hitokoto.cn/")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        futures = [ex.submit(_fetch, url) for url in urls]
        for fut in concurrent.futures.as_completed(futures):
            try:
                return fut.result()
            except Exception as e:
                errors.append(f"{e}")
    logger.warning(f"一言获取失败: {'; '.join(errors)}")
    return {"text": "", "from": "", "from_who": ""}


# ---------------- 系统资源占用 (运行日志栏展示) ----------------

# psutil.cpu_percent(interval=None) 首次调用无意义, 启动时先采样一次
psutil.cpu_percent(interval=None)

_GPU_CACHE = {"t": 0.0, "data": None}
# 采样节流 (与前端刷新间隔解耦, 不要互相"对齐": 之前 TTL 与轮询同为 1 秒, 缓存吸收不到任何请求,
# 等于每秒 fork 一次 nvidia-smi)。成功结果最多复用 _GPU_TTL_OK 秒 (兜住多标签页/并发重复采样);
# 取不到 (无独显 / 驱动异常 / 超时) 则退避 _GPU_TTL_FAIL 秒, 避免每次都真去起进程。前端见 web/js/components.js
_GPU_TTL_OK = 8.0
_GPU_TTL_FAIL = 60.0
# nvidia-smi 不在 PATH (无独显 / 未装驱动) 是环境常态而非故障: 退避拉长到 10 分钟再探一次
_GPU_TTL_NO_SMI = 600.0
_GPU_CACHE["ttl"] = _GPU_TTL_FAIL
# 同一类采样失败只上报一次: 前端每 10 秒轮询, 没必要反复刷同一条消息/堆栈
_GPU_LOGGED: set[str] = set()


def _gpu_note(key: str, msg: str, stack: bool = False) -> None:
    """同一类采样失败只在首次上报, 避免周期性轮询反复刷同一条日志。"""
    if key in _GPU_LOGGED:
        return
    _GPU_LOGGED.add(key)
    logger.debug(msg)
    if stack:
        logger.opt(exception=True).debug("nvidia-smi 采样失败堆栈:")


def _gpu_stats():
    """通过 nvidia-smi 查询 GPU 占用; 成功按 _GPU_TTL_OK 复用, 失败时保留上一次的有效值。"""
    now = time.time()
    if now - _GPU_CACHE["t"] < _GPU_CACHE["ttl"]:
        return _GPU_CACHE["data"]
    try:
        if shutil.which("nvidia-smi") is None:
            # 没有 NVIDIA 独显或没装驱动: 起子进程必然 FileNotFoundError, 直接预检跳过
            _gpu_note("no-smi", "未检测到 nvidia-smi (无 NVIDIA 显卡或未装驱动), 已跳过 GPU 采样")
            _GPU_CACHE.update(t=now, ttl=_GPU_TTL_NO_SMI)
            return _GPU_CACHE["data"]
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=1.5,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        line = out.stdout.strip().splitlines()[0]
        name, util, mem_used, mem_total = [x.strip() for x in line.split(",")]
        _GPU_CACHE.update(
            data={
                "name": name,
                "util": float(util),
                "mem_used": float(mem_used),
                "mem_total": float(mem_total),
            },
            t=now,
            ttl=_GPU_TTL_OK,
        )
    except Exception as e:
        # 采样超时 / 输出解析异常: 保留上一次的有效值, 首次就失败则维持 None
        _gpu_note("smi-error", f"nvidia-smi 采样失败: {e}", stack=True)
        _GPU_CACHE.update(t=now, ttl=_GPU_TTL_OK if _GPU_CACHE["data"] is not None else _GPU_TTL_FAIL)
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


def _python_version():
    """Python 版本: 非 CPython 实现 (PyPy 等) 带上实现名, 方便对照环境差异。"""
    version = platform.python_version()
    impl = platform.python_implementation()
    return version if impl == "CPython" else f"{impl} {version}"


@router.get("/system/stats")
def system_stats():
    """系统版本 / Python 版本与资源占用 (CPU / 内存 / GPU): 运行日志栏展示, 前端每 10 秒轮询。

    同步 def: _gpu_stats 里的 nvidia-smi 是阻塞子进程, 放线程池执行,
    不再周期性占用事件循环 (同 browse_images / hitokoto 的处理方式)。
    """
    mem = psutil.virtual_memory()
    gpu = _gpu_stats()
    return {
        # 应用版本不在此重复返回: 前端统一读 /api/state 的 version (真源同为 utils/variable.VERSION)
        "os": _os_name(),
        "python": _python_version(),
        "arch": platform.machine(),
        "cpu_percent": psutil.cpu_percent(interval=None),
        "cpu_cores": psutil.cpu_count(logical=True),
        "mem_percent": mem.percent,
        "mem_used_gb": round(mem.used / 1024**3, 1),
        "mem_total_gb": round(mem.total / 1024**3, 1),
        "gpu": gpu,
    }
