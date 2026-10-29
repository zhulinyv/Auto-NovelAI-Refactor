"""Vibes 素材库 API: 列表 / 导入 (文件或图片) / 编码 / 导出 / 改名 / 删除。

与 wildcards 一样挂在 /api 下, 由 server/app.py 注册。导入与编码都可能慢 (网络 + 图像),
因此全部用同步 def —— FastAPI 会把它们丢进线程池, 不会卡住事件循环。
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from utils.logger import logger
from utils.services import vibes

router = APIRouter(prefix="/api", tags=["vibes"])

# 上传文件上限: Vibe 编码文件本身很小 (<10MB), 图片给到 32MB 足够
_MAX_VIBE_FILE = 32 * 1024 * 1024
_VIBE_SUFFIXES = (".naiv4vibe", ".naiv4vibebundle", ".json")
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")

# 现场编码要花 2 Anlas, 默认不允许"隐式"发生: 前端必须显式带 encode=true
# (用户点了确认按钮) 才会真的调 API。estimate 走 encode=false 只做预演。
_TRUTHY = {"1", "true", "yes", "on"}


def _flag(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in _TRUTHY


@router.get("/vibes")
def list_vibes():
    """列出素材库里的全部 Vibe (含每个可用的模型编码与所属分类)。"""
    return {"items": vibes.list_items(), "categories": vibes.list_categories()}


@router.post("/vibes/find-by-image")
def find_vibe_by_image(file: UploadFile):
    """按图片内容查库里是否已有对应条目 (前端暂存图片在生成后归位用)。"""
    raw = file.file.read(_MAX_VIBE_FILE + 1)
    if len(raw) > _MAX_VIBE_FILE:
        raise HTTPException(status_code=400, detail="图片超过 32MB")
    item = vibes.find_by_image(raw)
    if item is None:
        return {"found": False, "item": None}
    by_id = {x["id"]: x for x in vibes.list_items()}
    return {"found": True, "item": by_id.get(item["id"])}


@router.get("/vibes/categories")
def list_vibe_categories():
    return {"categories": vibes.list_categories()}


@router.post("/vibes/categories")
def create_vibe_category(payload: dict):
    """新建一个空分类 (vibes 的分类是条目上的一个字段, 没有独立目录)。"""
    name = str((payload or {}).get("category") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="分类名不能为空")
    try:
        created = vibes.create_category(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "ok": True,
        "created": created,
        "categories": vibes.list_categories(),
        "items": vibes.list_items(),
    }


@router.post("/vibes/categories/delete")
def delete_vibe_category(payload: dict):
    """删除分类: 其中的 Vibe 退回"默认", 不删除数据。"""
    name = str((payload or {}).get("category") or "").strip()
    try:
        moved = vibes.delete_category(name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {
        "ok": True,
        "moved": moved,
        "categories": vibes.list_categories(),
        "items": vibes.list_items(),
    }


@router.post("/vibes/categories/rename")
def rename_vibe_category(payload: dict):
    """整类改名 (分类就是 vibe 上的一个字段, 没有独立目录)。"""
    old = str((payload or {}).get("from") or "").strip()
    new = str((payload or {}).get("to") or "").strip()
    if not new:
        raise HTTPException(status_code=400, detail="分类名不能为空")
    try:
        n = vibes.rename_category(old, new)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "moved": n, "categories": vibes.list_categories(), "items": vibes.list_items()}


@router.post("/vibes/{vibe_id}/category")
def set_vibe_category(vibe_id: str, payload: dict):
    category = str((payload or {}).get("category") or "").strip()
    item = vibes.set_category(vibe_id, category)
    if item is None:
        raise HTTPException(status_code=404, detail="Vibe 不存在")
    return {
        "ok": True,
        "item": item,
        "categories": vibes.list_categories(),
        "items": vibes.list_items(),
    }


@router.post("/vibes/import")
def import_vibe_file(
    files: list[UploadFile],
    encode: str = "true",
    model: str = "nai-diffusion-4-5-full",
    category: str = "",
):
    """导入 .naiv4vibe / .naiv4vibebundle 文件 (不必联网, 最快)。"""
    if not files:
        raise HTTPException(status_code=400, detail="没有选中文件")
    added_ids: list[str] = []
    skipped: list[str] = []
    for file in files:
        name = (file.filename or "vibe").strip()
        suffix = Path(name).suffix.lower()
        if suffix not in _VIBE_SUFFIXES:
            skipped.append(f"{name}: 只支持 {' / '.join(_VIBE_SUFFIXES)}")
            continue
        raw = file.file.read(_MAX_VIBE_FILE + 1)
        if len(raw) > _MAX_VIBE_FILE:
            skipped.append(f"{name}: 文件超过 {_MAX_VIBE_FILE // 1024 // 1024}MB")
            continue
        try:
            doc = json.loads(raw.decode("utf-8-sig"))
        except UnicodeDecodeError:
            skipped.append(f"{name}: 不是 UTF-8 文本")
            continue
        except json.JSONDecodeError as e:
            skipped.append(f"{name}: JSON 解析失败 ({e.msg})")
            continue
        if not isinstance(doc, dict):
            skipped.append(f"{name}: 内容不是 Vibe 文档")
            continue
        try:
            imported = vibes.add_from_document(doc, name=Path(name).stem, source=suffix.lstrip("."))
            if category.strip():
                for one in imported:
                    vibes.set_category(one["id"], category)
            items = imported
        except Exception as e:
            skipped.append(f"{name}: {e}")
            continue
        if items:
            added_ids.extend(i["id"] for i in items)
        else:
            skipped.append(f"{name}: 里面没有可用的编码")

    if not added_ids and skipped:
        raise HTTPException(status_code=400, detail="; ".join(skipped[:3]))

    # 返回**完整**的条目 (含 information / strength / thumbnail / category):
    # 前端要拿它做两个滑条的初值, 只给 id/name 会让"信息提取强度"回落到默认 1.0,
    # 与库里实际存编码用的数值对不上, 于是明明有编码却显示"需编码"。
    by_id = {x["id"]: x for x in vibes.list_items()}
    added = [by_id[i] for i in added_ids if i in by_id]
    return {
        "ok": True,
        "added": added,
        "skipped": skipped,
        "items": vibes.list_items(),
        "categories": vibes.list_categories(),
    }


@router.post("/vibes/import-image")
def import_vibe_image(
    files: list[UploadFile],
    model: str = "nai-diffusion-4-5-full",
    encode: str = "true",
    information: str = "1.0",
    name: str = "",
    category: str = "",
    pending: str = "false",
):
    """导入图片作为 Vibe。

    顺序: 图片自带的编码 (免费) -> 库里已有同一张图 -> 都没有才调 API 编码。
    encode=false 时只预演, 不花钱, 返回 needs_encode 让前端确认。
    """
    if not files:
        raise HTTPException(status_code=400, detail="没有选中图片")
    try:
        info = float(information)
    except (TypeError, ValueError):
        info = 1.0
    allow_encode = _flag(encode)

    results: list[dict] = []
    for file in files:
        filename = (file.filename or "image.png").strip()
        if Path(filename).suffix.lower() not in _IMAGE_SUFFIXES:
            results.append({"ok": False, "file": filename, "message": "只支持 PNG / JPG / WEBP"})
            continue
        raw = file.file.read(_MAX_VIBE_FILE + 1)
        if len(raw) > _MAX_VIBE_FILE:
            results.append({"ok": False, "file": filename, "message": "图片超过 32MB"})
            continue
        try:
            result = vibes.import_image(
                raw,
                model=model,
                name=name or Path(filename).stem,
                information=info,
                encode=allow_encode,
                # pending=true: 收下原图但不编码 (生成时再补, 计入点数)
                pending=_flag(pending),
            )
        except Exception as e:
            logger.error(f"导入 Vibe 图片失败 ({filename}): {e}")
            logger.opt(exception=True).debug("导入 Vibe 图片失败堆栈:")
            results.append({"ok": False, "file": filename, "message": str(e)})
            continue
        if category.strip() and result.get("ok") and result.get("item"):
            vibes.set_category(result["item"]["id"], category)
        result["file"] = filename
        results.append(result)

    ok = [r for r in results if r.get("ok")]
    needs = [r for r in results if r.get("needs_encode") and not r.get("ok")]
    return {
        "ok": bool(ok),
        "items": vibes.list_items(),
        "categories": vibes.list_categories(),
        "results": results,
        "needs_encode": needs,
        "encoded": sum(1 for r in ok if r.get("encoded")),
    }


@router.post("/vibes/{vibe_id}/encode")
def encode_vibe(vibe_id: str, payload: dict = None):
    """给某个 Vibe 补一份当前模型的编码 (花 2 Anlas)。"""
    body = payload or {}
    model = str(body.get("model") or "nai-diffusion-4-5-full")
    try:
        information = float(body.get("information") or 1.0)
    except (TypeError, ValueError):
        information = 1.0

    item = vibes.get_item(vibe_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Vibe 不存在")
    if vibes.encoding_for(item, model):
        return {"ok": True, "encoded": False, "message": "已有该模型的编码, 无需重新编码", "item": item}
    if model not in vibes.ENCODABLE_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"{model} 不支持现场编码 (只有 V4 / V4.5 支持); 请改用带编码的 .naiv4vibe 文件",
        )
    # 原图已改成独立文件 (img/<id>.png), 不再内嵌在 JSON 里
    raw = vibes.image_bytes(item)
    if not raw:
        raise HTTPException(status_code=400, detail="这个 Vibe 没有原图, 无法为新模型编码")
    try:
        updated = vibes.import_image(raw, model=model, name=item.get("name"), information=information, encode=True)
    except Exception as e:
        logger.error(f"编码 Vibe 失败: {e}")
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "encoded": True, "item": updated.get("item"), "items": vibes.list_items()}


@router.post("/vibes/{vibe_id}/rename")
def rename_vibe(vibe_id: str, payload: dict):
    name = str((payload or {}).get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="名称不能为空")
    item = vibes.rename_item(vibe_id, name)
    if item is None:
        raise HTTPException(status_code=404, detail="Vibe 不存在")
    return {"ok": True, "item": item, "items": vibes.list_items()}


@router.post("/vibes/{vibe_id}/export")
def export_vibe(vibe_id: str):
    """导出为 .naiv4vibe 并在文件管理器里定位 (供用户拿去别处用)。"""
    item = vibes.get_item(vibe_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Vibe 不存在")
    try:
        path = vibes.export_file(vibe_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    try:
        import subprocess
        import sys

        if sys.platform.startswith("win"):
            subprocess.Popen(["explorer", "/select,", path])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
    except Exception:
        logger.debug("定位导出文件失败 (不影响导出)")
    return {"ok": True, "path": path}


@router.delete("/vibes/{vibe_id}")
def delete_vibe(vibe_id: str):
    if not vibes.delete_item(vibe_id):
        raise HTTPException(status_code=404, detail="Vibe 不存在")
    return {"ok": True, "items": vibes.list_items()}
