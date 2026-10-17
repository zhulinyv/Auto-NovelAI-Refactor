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
        task = gen_queue.submit("图片生成", generate, request, label=_build_label(request), model=request.get("model"))
    except Exception as e:
        logger.error(f"启动生成任务失败: {e}")
        raise HTTPException(status_code=500, detail=f"启动生成任务失败: {e}")
    if task is None:
        # 启用 "用量为空时跳过 nai5 任务" 且全部 Token 剩余用量 <= 0: 任务未入队
        raise HTTPException(status_code=429, detail="全部 Token 剩余用量已用完, 已跳过本次 NAI5 生成任务")
    return {"job_id": task.id, "queued": True, "position": gen_queue.position(task.id)}


@router.post("/generate/stop")
async def stop(payload: dict = None):
    """停止当前生图任务 (可选 name 前缀匹配, 如 '导演工具:')。

    运行中的任务 / 还没被通道领走的排队任务都会收到停止信号:
    后者如果只停在"运行中"那一侧, 就有个很坑的空档 —— 上一轮任务刚结束、下一轮任务
    已经排进队列但通道还在冷却或刚被唤醒, 这时点"停止"看起来成功了, 下一个任务却照样开跑。
    """
    name = (payload or {}).get("name")
    if name:
        stopped = gen_queue.stop_by_prefix(name)
    else:
        stopped = gen_queue.stop_by_name("图片生成")
    return {"ok": True, "stopped": stopped}


@router.post("/stop")
async def stop_any():
    """全局停止: 生图队列全部运行中任务 + 其它后台任务。

    返回 stopped 让前端能区分"真的停了东西"和"当时本来就没有任务在跑",
    免得用户点了停止只看到一句"正在停止生成..."却不知道到底停没停。
    """
    stopped = gen_queue.stop_all_running()
    stop_generate()
    return {"ok": True, "stopped": stopped}
