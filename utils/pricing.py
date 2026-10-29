"""Anlas 费用预估: 与 NovelAI 官方计费规则对齐的本地估算。

为什么要自己算
--------------
官方没有公开的"价格查询"接口, 网页版是在**发请求之前**用同一套公式在本地算出来的。
本模块复刻该公式, 让"开始生成"按钮上直接显示本次要花多少点数。

所有系数都是**用真实账号实测校准**的 (2026-10-28, 每次生成前后查 /user/subscription
的 trainingStepsLeft 差值), 不是从别的第三方实现抄来的:

    512x512 s23 v4.5                       -> 0    (Opus 免费区间)
    512x512 s23 + 1 张角色参考             -> 5    (参考费 5, 底价仍免费)
    512x512 s23 + 2 张角色参考             -> 10
    1024x1536 s23                          -> 26
    1024x1536 s23 + 1 张角色参考           -> 31   (= 26 + 5)
    1024x1536 s28                          -> 30
    1536x2048 s28                          -> 60
    1536x2048 s28 v5                       -> 90   (= 60 x 1.5)
    832x1216 s50                           -> 33
    512x512 s23 + 1 个 Vibe                -> 0    (4 个以内不加价)
    512x512 s23 + 5 个 Vibe                -> 2    (超出 4 个的部分每个 +2)
    /ai/encode-vibe 编码一次                -> 2

由此得到两条**容易搞错**的规则, 它们和某些第三方工具的做法相反:

  1. 角色参考 (精确参考) 是**附加费**, 不会把底价从免费区间踢出去 ——
     实测 512x512 带 1 张参考总共只扣 5, 不是"底价 + 5"。
  2. Vibe 编码本身不按个数计费, 只有超过 4 个的部分才每个 +2。

基础价:
    max(2, ceil(2.951823174884865e-6 * W*H + 5.753298233447344e-7 * W*H * steps))
再乘: SMEA 1.2 / SMEA+DYN 1.4 / V5 系列 1.5 (图生图另乘 strength)。

免费区间 (Opus, tier>=3): 宽高乘积 <= 1024x1024, 步数 <= 28, 且用量未透支。

估算只用于展示: 官方才是最终扣费方。
"""

from __future__ import annotations

import math

# Opus 免费区间的边界 (实测: 1024x1024 与 832x1216 在 28 步内为 0)
FREE_MAX_AREA = 1024 * 1024
FREE_MAX_STEPS = 28
FREE_MIN_TIER = 3

# 一次 Vibe 编码的花费 (实测 /ai/encode-vibe 每次扣 2)
VIBE_ENCODE_COST = 2

# 超过 4 个 Vibe 后每个额外收费 (实测: 5 个 Vibe 扣 2)
VIBE_FREE_COUNT = 4
VIBE_EXTRA_COST = 2

# 精确参考 (角色参考) 每张的花费 (实测: 带 1 张多扣 5)
PRECISE_REFERENCE_COST = 5

# SMEA / SMEA+DYN 的倍率
SMEA_MULTIPLIER = 1.2
SMEA_DYN_MULTIPLIER = 1.4

# V5 系列的基础价倍率
V5_MULTIPLIER = 1.5


def _base_price(width: int, height: int, steps: int) -> int:
    """未计任何倍率的基础价 (官方 client 的 checkStableDiffusionPrice)。"""
    area = max(1, int(width)) * max(1, int(height))
    raw = 2.951823174884865e-6 * area + 5.753298233447344e-7 * area * max(1, int(steps))
    return max(2, math.ceil(raw))


def free_reason(
    width: int,
    height: int,
    steps: int,
    *,
    tier: int | None = None,
    active: bool | None = None,
    usage_negative: bool = False,
    is_v5: bool = False,
) -> str:
    """说明"为什么这一张不落在免费区间" (空字符串表示免费)。

    注意: 角色参考 / Vibe 都是**附加费**, 不参与这里的判断 —— 实测带参考时底价仍然免费。
    """
    if not active or tier is None:
        return "未检测到有效订阅"
    if tier < FREE_MIN_TIER:
        return "当前订阅等级不含免费生成额度"
    if is_v5 and usage_negative:
        return "V5 用量已透支"
    w, h = int(width), int(height)
    if w * h > FREE_MAX_AREA:
        return f"尺寸 {w}×{h} 超出免费上限 (宽高乘积需 ≤ {FREE_MAX_AREA})"
    if int(steps) > FREE_MAX_STEPS:
        return f"步数 {int(steps)} 超出免费上限 ({FREE_MAX_STEPS} 步)"
    return ""


def _image_price(
    width: int,
    height: int,
    steps: int,
    *,
    model: str,
    sm: bool = False,
    sm_dyn: bool = False,
    strength: float | None = None,
    tier: int | None = None,
    active: bool | None = None,
    usage_negative: bool = False,
) -> tuple[int, str]:
    """单张图的基础价 (已考虑免费区间与倍率), 返回 (价格, 不免费的原因)。"""
    is_v5 = str(model or "").startswith("nai-diffusion-5-")
    reason = free_reason(
        width,
        height,
        steps,
        tier=tier,
        active=active,
        usage_negative=usage_negative,
        is_v5=is_v5,
    )
    if not reason:
        return 0, ""

    price = _base_price(width, height, steps)
    multiplier = 1.0
    if sm and sm_dyn:
        multiplier *= SMEA_DYN_MULTIPLIER
    elif sm:
        multiplier *= SMEA_MULTIPLIER
    if is_v5:
        multiplier *= V5_MULTIPLIER
    if strength is not None:
        multiplier *= max(0.0, min(1.0, float(strength)))
    return max(2, math.ceil(price * multiplier)), reason


def estimate(
    *,
    width: int,
    height: int,
    steps: int,
    count: int = 1,
    model: str = "",
    sm: bool = False,
    sm_dyn: bool = False,
    action: str = "generate",
    strength: float | None = None,
    vibe_count: int = 0,
    precise_count: int = 0,
    pending_encodes: int = 0,
    enhance: dict | None = None,
    tier: int | None = None,
    active: bool | None = None,
    usage_negative: bool = False,
) -> dict:
    """估算一次生成任务的花费, 返回可直接展示的明细。

    enhance 形如 {"width": w, "height": h, "strength": 0.5}: Enhance 是**第二次独立生成**
    (整图 img2img), 会把总价几乎翻倍, 之前漏算过。

    返回 {anlas, per_image, free, count, parts{...}, free_reason}。
    """
    count = max(1, int(count or 1))

    base, reason = _image_price(
        width,
        height,
        steps,
        model=model,
        sm=sm,
        sm_dyn=sm_dyn,
        strength=strength if action == "img2img" else None,
        tier=tier,
        active=active,
        usage_negative=usage_negative,
    )

    # 附加费: 角色参考按张数、Vibe 超量按个数、Enhance 按"再来一张"
    vibe_extra = VIBE_EXTRA_COST * max(0, int(vibe_count) - VIBE_FREE_COUNT)
    precise = PRECISE_REFERENCE_COST * max(0, int(precise_count))
    enhance_price = 0
    if enhance:
        enhance_price, _ = _image_price(
            int(enhance.get("width") or width),
            int(enhance.get("height") or height),
            steps,
            model=model,
            sm=sm,
            sm_dyn=sm_dyn,
            strength=enhance.get("strength"),
            tier=tier,
            active=active,
            usage_negative=usage_negative,
        )

    per_image = base + vibe_extra + precise + enhance_price
    encode = VIBE_ENCODE_COST * max(0, int(pending_encodes))
    total = per_image * count + encode

    return {
        "anlas": total,
        "per_image": per_image,
        "free": total == 0,
        "count": count,
        "parts": {
            "base": base * count,
            "vibe_extra": vibe_extra * count,
            "precise": precise * count,
            "enhance": enhance_price * count,
            "encode": encode,
        },
        "free_reason": reason,
    }


def free_dimension_hint(width: int, height: int, steps: int) -> dict:
    """给"一键改回免费"用的建议尺寸 (按原宽高比缩到面积预算内, 并对齐 64)。"""
    w, h = max(64, int(width)), max(64, int(height))
    if w * h > FREE_MAX_AREA:
        scale = math.sqrt(FREE_MAX_AREA / (w * h))
        w = max(64, int(w * scale) // 64 * 64)
        h = max(64, int(h * scale) // 64 * 64)
        while w * h > FREE_MAX_AREA and (w > 64 or h > 64):
            if w >= h:
                w = max(64, w - 64)
            else:
                h = max(64, h - 64)
    return {"width": w, "height": h, "steps": min(int(steps), FREE_MAX_STEPS)}


__all__ = [
    "FREE_MAX_AREA",
    "FREE_MAX_STEPS",
    "PRECISE_REFERENCE_COST",
    "VIBE_ENCODE_COST",
    "estimate",
    "free_dimension_hint",
    "free_reason",
]
