"""生图相关 API。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from src.generate_images import generate
from utils.errors import JobAlreadyRunningError
from utils.helpers import stop_generate
from utils.jobs import jobs
from utils.logger import logger

router = APIRouter(prefix="/api", tags=["generate"])


@router.post("/generate")
async def start_generate(request: dict):
    if jobs.is_busy:
        raise HTTPException(status_code=409, detail="已有任务正在运行, 请先停止或等待当前任务完成")
    try:
        job_id = jobs.submit("图片生成", generate, request)
    except JobAlreadyRunningError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        logger.error(f"启动生成任务失败: {e}")
        raise HTTPException(status_code=500, detail=f"启动生成任务失败: {e}")
    return {"job_id": job_id}


@router.post("/generate/stop")
async def stop():
    stop_generate()
    return {"ok": True}


@router.post("/stop")
async def stop_any():
    stop_generate()
    return {"ok": True}
