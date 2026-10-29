"""生图相关 API (全部经由生图队列调度)。"""

from __future__ import annotations

import threading

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


@router.post("/generate/estimate")
def estimate_generate(request: dict):
    """估算这次生成要花多少 Anlas (按钮上的 "🚀 开始生成: 20🔋")。

    同步 def: 内部要查订阅快照, 极少数情况下会真的联网, 放线程池别卡事件循环。
    不发送任何生成请求, 也不消耗点数 —— 只做本地计算。
    """
    from utils.generator import get_subscription
    from utils.pricing import estimate

    model = str(request.get("model") or "")
    try:
        width = int(request.get("width") or 832)
        height = int(request.get("height") or 1216)
        steps = int(request.get("steps") or 23)
        count = max(1, int(request.get("quantity") or 1))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="分辨率/步数/张数不合法")

    subscription = get_subscription() or {}
    if not subscription:
        # 订阅快照还没查到 (刚启动/刚换 Token): 补查一次, 30 秒内不重复查,
        # 否则每次调参数都会打一次 /user/subscription。
        subscription = _ensure_subscription() or {}
    usage = subscription.get("usage") or {}

    vibe = request.get("vibe") or {}
    vibe_ids = vibe.get("library_ids") or []
    if isinstance(vibe_ids, str):
        vibe_ids = [vibe_ids]
    vibe_count = len(vibe_ids)
    pending_encodes = 0
    pending_names = []
    pending_ids = []
    unencodable_ids = []
    if vibe_ids:
        from utils.services import vibes as vibes_lib

        # 每条 vibe 的"信息提取强度"由前端单独给 (informations), 缺省用库里的
        infos = vibe.get("informations") or {}
        for vibe_id in vibe_ids:
            item = vibes_lib.get_item(str(vibe_id))
            if item is None:
                continue
            info_raw = infos.get(str(vibe_id), item.get("information"))
            information = float(info_raw) if info_raw is not None else 1.0
            # 编码按 (模型, 信息提取强度) 精确匹配: 调过滑条就等于换了一份编码
            if not vibes_lib.encoding_for(item, model, information):
                # 缺编码一律记下来 (前端要显示"需编码"); 但这个模型编不了码时单独标出,
                # 免得提示成"生成前会自动编码" —— 那种情况生成时只会跳过这条 Vibe。
                pending_ids.append(str(vibe_id))
                pending_names.append(item.get("name"))
                if model in vibes_lib.ENCODABLE_MODELS:
                    pending_encodes += 1
                else:
                    unencodable_ids.append(str(vibe_id))
    elif vibe.get("bundle_path"):
        # 旧版 bundle: 一个文件算一个 vibe (里面可能有多个编码, 但按 1 个计费最接近实际)
        vibe_count = 1

    # 前端暂存的图片 (未入库): 生成时要现场编码, 每个 2 Anlas, 也计入 Vibe 数量
    staged = vibe.get("staged") or []
    if staged:
        vibe_count += len(staged)
        for one in staged:
            if not isinstance(one, dict):
                continue
            pending_encodes += 1
            pending_ids.append(str(one.get("id") or ""))
            pending_names.append(one.get("name") or "暂存图片")

    references = request.get("references") or []
    precise_count = len([r for r in references if r.get("enabled") and r.get("path")])

    inpaint = request.get("inpaint") or {}
    action = "img2img" if inpaint else "generate"
    strength = float(inpaint.get("strength", 0.7)) if inpaint else None

    # Enhance 是"再发一次整图 img2img", 等于多生成一张, 必须算进去
    enhance = None
    enhance_detail = request.get("enhance") or {}
    if enhance_detail.get("enabled"):
        from src.generate_images import _enhance_target_size

        ew, eh = _enhance_target_size(model, enhance_detail.get("amount", "1.5x"), width, height)
        # 强度对应 generate_images 里 Enhance 的 strength 表 (1..5 档)
        strength_map = {1: 0.2, 2: 0.4, 3: 0.5, 4: 0.6, 5: 0.7}
        try:
            magnitude = int(enhance_detail.get("magnitude", 1))
        except (TypeError, ValueError):
            magnitude = 1
        enhance = {
            "width": ew,
            "height": eh,
            "strength": strength_map.get(magnitude, 0.5),
        }

    result = estimate(
        width=width,
        height=height,
        steps=steps,
        count=count,
        model=model,
        sm=bool(request.get("sm")),
        sm_dyn=bool(request.get("sm_dyn")),
        action=action,
        strength=strength,
        vibe_count=vibe_count,
        precise_count=precise_count,
        pending_encodes=pending_encodes,
        enhance=enhance,
        tier=subscription.get("tier"),
        active=subscription.get("active"),
        usage_negative=bool(usage.get("isNegative")),
    )
    result["pending_encodes"] = pending_encodes
    result["pending_names"] = pending_names
    result["pending_ids"] = pending_ids
    result["unencodable_ids"] = unencodable_ids
    # 把"算了几张参考 / 几个 Vibe / 有没有 Enhance"一并回传: 按钮的悬停明细靠它自证,
    # 否则用户看到 15 会以为是算错了 (实际可能是 5 x 3 张, 或 3 张参考 x 5)。
    result["precise_count"] = precise_count
    result["vibe_count"] = vibe_count
    result["enhance"] = bool(enhance)
    result["is_relay"] = _is_relay()
    return result


_SUB_FETCH_AT = 0.0
_SUB_FETCH_LOCK = threading.Lock()


def _ensure_subscription() -> dict:
    """确保有订阅快照 (最多 30 秒补查一次); 查不到返回 {}。"""
    global _SUB_FETCH_AT
    import time

    from utils.generator import get_subscription, inquire_anlas

    got = get_subscription()
    if got:
        return got
    now = time.time()
    with _SUB_FETCH_LOCK:
        if now - _SUB_FETCH_AT < 30:
            return get_subscription()
        _SUB_FETCH_AT = now
    try:
        inquire_anlas()
    except Exception as e:
        logger.debug(f"费用预估时查询订阅失败: {e}")
        return {}
    return get_subscription()


def _is_relay() -> bool:
    """当前是否连的第三方站点 (中转站不按 Anlas 计费, 前端要换成按张数提示)。"""
    from utils.api_endpoint import current_endpoints

    try:
        return current_endpoints().is_relay
    except Exception:
        return False


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
