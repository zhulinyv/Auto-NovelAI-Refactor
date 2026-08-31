"""生图相关 API (全部经由生图队列调度)。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from src.generate_images import generate
from utils.gen_queue import gen_queue
from utils.helpers import stop_generate
from utils.logger import logger

router = APIRouter(prefix="/api", tags=["generate"])


def _build_label(request: dict) -> str:
    """根据请求生成队列展示用的任务标签。"""
    model = str(request.get("model", "")).replace("nai-diffusion-", "NAI")
    prompt = (request.get("positive_prompt") or "").strip().replace("\n", " ")[:24]
    try:
        quantity = int(request.get("quantity", 1) or 1)
    except (TypeError, ValueError):
        quantity = 1
    parts = [prompt or "无提示词", model]
    if quantity > 1:
        parts.append(f"× {quantity}")
    return " · ".join(parts)


@router.post("/generate")
async def start_generate(request: dict):
    """提交生图任务: 有空闲通道立即执行, 否则排队等待 (FIFO, 冷却后自动开始)。"""
    try:
        task = gen_queue.submit("图片生成", generate, request, label=_build_label(request))
    except Exception as e:
        logger.error(f"启动生成任务失败: {e}")
        raise HTTPException(status_code=500, detail=f"启动生成任务失败: {e}")
    return {"job_id": task.id, "queued": True, "position": gen_queue.position(task.id)}


@router.post("/generate/stop")
async def stop(payload: dict = None):
    """停止当前生图任务 (可选 name 前缀匹配, 如 '导演工具:')。"""
    name = (payload or {}).get("name")
    if name:
        stopped = gen_queue.stop_by_prefix(name)
    else:
        stopped = gen_queue.stop_by_name("图片生成")
    if not stopped:
        # 队列没有匹配的运行中任务时回落到全局停止 (兼容插件等旧入口)
        stop_generate()
    return {"ok": True, "stopped": stopped}


@router.post("/stop")
async def stop_any():
    """全局停止: 生图队列全部运行中任务 + 其它后台任务。"""
    stop_generate()
    return {"ok": True}
