"""Wildcards 卡片库 API: 分类 / 名称 / 卡片列表 / 封面 / 增删改与排序。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from utils.logger import logger
from utils.services import wildcards

from .system import _resolve_allowed

router = APIRouter(prefix="/api", tags=["wildcards"])

# ---------------------------------------------------------------- wildcards


@router.get("/wildcards/types")
async def wildcard_types():
    return {"types": wildcards.list_types()}


@router.get("/wildcards/{wildcard_type}/names")
async def wildcard_names(wildcard_type: str):
    return {"names": wildcards.list_names(wildcard_type)}


@router.get("/wildcards/{wildcard_type}/cards")
async def wildcard_cards(wildcard_type: str):
    """列出卡片 (含封面信息), 用于网格展示。

    卡片多时涉及大量文件 IO, 放线程池执行, 避免阻塞事件循环上的其它接口。
    """
    return {"cards": await run_in_threadpool(wildcards.list_cards, wildcard_type)}


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
