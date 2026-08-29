"""生图队列 API: 查看快照 / 取消 / 停止 / 调整顺序 / 清空排队。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from utils.gen_queue import gen_queue

router = APIRouter(prefix="/api/queue", tags=["queue"])


@router.get("")
async def get_queue():
    """当前队列快照 (通道状态 + 排队/运行任务 + 最近历史)。"""
    return gen_queue.snapshot()


@router.post("/cancel")
async def cancel_task(payload: dict):
    """取消排队中的任务。"""
    task_id = payload.get("id", "")
    if not gen_queue.cancel(task_id):
        raise HTTPException(status_code=404, detail="任务不存在或不在排队中")
    return gen_queue.snapshot()


@router.post("/stop")
async def stop_task(payload: dict):
    """请求停止运行中的任务 (写入该任务独立的停止信号)。"""
    task_id = payload.get("id", "")
    if not gen_queue.stop(task_id):
        raise HTTPException(status_code=404, detail="任务不存在或未在运行")
    return gen_queue.snapshot()


@router.post("/reorder")
async def reorder_task(payload: dict):
    """调整排队任务顺序 (direction: up / down / top / bottom)。"""
    task_id = payload.get("id", "")
    direction = payload.get("direction", "")
    if not gen_queue.reorder(task_id, direction):
        raise HTTPException(status_code=400, detail="任务不存在或无法移动")
    return gen_queue.snapshot()


@router.post("/clear")
async def clear_queue():
    """清空全部排队任务 (不影响运行中任务)。"""
    gen_queue.clear_pending()
    return gen_queue.snapshot()
