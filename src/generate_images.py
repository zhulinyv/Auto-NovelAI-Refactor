"""图片生成核心逻辑 (重构版)。

由原来的 Gradio 回调 (一长串位置参数) 改为接收结构化字典 `GenerateRequest`,
内部逻辑与原版保持一致: 模型 JSON 构建、wildcard 替换、图生图/重绘、Enhance 等。
"""

from __future__ import annotations

import os
import random
from copy import deepcopy
from io import BytesIO
from pathlib import Path

import ujson as json
from PIL import Image

from utils.config import env
from utils.errors import NovelAIAPIError
from utils.generator import Generator
from utils.helpers import (
    StopGeneration,
    check_stop,
    find_and_replace_wildcards_from_dict,
    format_str,
    generate_hash_string,
    playsound,
    position_to_float,
    read_json,
    reset_stop,
    return_last_value,
    return_max_size,
    return_x64,
    send_mail,
    sleep_for_cool,
)
from utils.image_tools import (
    change_the_mask_color,
    image_to_base64,
    is_fully_transparent,
    is_pure_white,
    process_image_by_orientation,
    process_white_regions,
    resize_image,
    revert_image_info,
)
from utils.logger import logger
from utils.models import *  # noqa: F401,F403
from utils.variable import (
    return_quality_preset_id,
    return_quality_tags,
    return_skip_cfg_above_sigma,
    return_uc_preset_id,
    return_undesired_contentc_preset,
)

image_generator = Generator("https://image.novelai.net/ai/generate-image")

# Enhance "Max" 选项 (仅 v5 系列) 的分辨率上限: 宽高乘积不超过 1536 × 2048
ENHANCE_MAX_SIZE = (1536, 2048)

# 裁剪重绘: 外侧选框面积上限 (不限制单边, 长宽可任意搭配, 只要乘积不超过它)
# (与前端 web/js/cropRect.js 的 CROP_MAX_AREA 一致, 改动需两侧同步)
# 注意: 裁剪块的尺寸就是送进模型的生成分辨率, 这个上限必须留在 v5 的 1536 × 2048 预算之内
CROP_MAX_AREA = 1024 * 1024

# 裁剪重绘: 外侧选框的对齐网格 —— 前端把宽高与起点都吸附到它的整数倍 (与 cropRect.js 的 CROP_SNAP 一致)。
# 裁剪块尺寸 = 生成分辨率, 所以 64 对齐后 return_x64 不会再去改动它, 生成图与裁剪块 1:1, 没有拉伸变形。
CROP_SNAP = 64

# 裁剪重绘: 内缩 a 的最小值 (与前端 cropRect.js 的 CROP_MIN_INSET 一致; 仅请求里缺 inset 时兜底用)
CROP_MIN_INSET = 32

# 裁剪重绘: 选框自动向外扩展的步长与"生成块"的面积上限
# (与前端 cropRect.js 的 CROP_EXPAND_STEP / CROP_EXPAND_MAX_AREA / CROP_EXPAND_MAX_AREA_RECT 一致, 改动需两侧同步)
# 用户框选得小时, 裁剪块的尺寸 (= 送进模型的生成分辨率) 也跟着小, 出图质量差; 于是自动向外扩几圈当
# 上下文, 扩到宽高乘积贴近上限为止 —— 正方形生成块贴 1024 × 1024, 非正方形贴 1024 × 960。
CROP_EXPAND_STEP = 64
CROP_EXPAND_MAX_AREA = 1024 * 1024
CROP_EXPAND_MAX_AREA_RECT = 1024 * 960


# ---------------------------------------------------------------- 辅助函数


def _generate_with_retry(generator, json_data, desc, max_retries=3):
    """生成单张图片并自动重试:
    - 429 且开启"429 自动重试"配置: 无上限重试 (每次等待 5 秒)
    - 其余错误: 最多重试 max_retries 次 (每次等待 5 秒), 仍失败则抛出异常 (由上层跳过该图片)
    - 任一点检测到停止信号: 立即抛出 StopGeneration, 不再等待/重试
    """
    retries = 0
    while True:
        if check_stop():
            raise StopGeneration("已停止生成")
        try:
            data = generator.generate(json_data)
            if not data:
                raise NovelAIAPIError("NovelAI 未返回图片数据")
            return data
        except StopGeneration:
            raise
        except Exception as e:
            # 捕获所有异常 (含 requests 连接错误/超时/NovelAIAPIError), 统一进入重试流程
            is_429 = "429" in str(e)
            if is_429 and getattr(env, "retry_429", False):
                retries += 1
                # 429 无上限重试, 但日志中展示次数与原因
                logger.warning(f"[{desc}] 429 限流, 等待 5 秒后自动重试 (第 {retries} 次): {e}")
                if check_stop():
                    raise StopGeneration("已停止生成")
                sleep_for_cool(5)
                continue
            retries += 1
            if retries > max_retries:
                logger.error(f"[{desc}] 重试 {max_retries} 次仍失败, 跳过该图片: {e}")
                logger.opt(exception=True).debug("生成重试失败堆栈:")
                raise
            logger.warning(f"[{desc}] 生成失败, 等待 5 秒后重试 ({retries}/{max_retries}): {e}")
            if check_stop():
                raise StopGeneration("已停止生成")
            sleep_for_cool(5)


def _resize_editor_image(image, size):
    return image if image.size == size else image.resize(size, Image.Resampling.LANCZOS)


def _enhance_target_size(model: str, amount, width: int, height: int) -> tuple[int, int]:
    """Enhance 的目标分辨率。

    - "Max" (仅 v5 系列): 保持纵横比缩放到宽高乘积不超过 1536×2048, 宽高均为 64 的倍数;
    - 其余 (1x / 1.5x): 按倍数放大后对齐到 64 的倍数;
    - 非 v5 模型收到 Max 时回退 1.5x (前端不会给出该选项, 只防御历史缓存/手写请求)。
    """
    amount = str(amount).strip()
    if amount.lower() == "max":
        if model in ("nai-diffusion-5-full", "nai-diffusion-5-curated"):
            new_width, new_height = return_max_size(width, height, *ENHANCE_MAX_SIZE)
            logger.info(f"Enhance Max: {return_x64(width)}×{return_x64(height)} → {new_width}×{new_height}")
            return new_width, new_height
        logger.warning(f"模型 {model} 不支持 Enhance 的 Max 选项, 已回退到 1.5x")
        amount = "1.5x"
    upscale_amount = float(amount.replace("x", ""))
    return return_x64(int(width * upscale_amount)), return_x64(int(height * upscale_amount))


def _snap_grid(v: int) -> int:
    """四舍五入到 CROP_SNAP 的整数倍 (与前端 cropRect.js 的 snapGrid 逐值一致)。

    必须用 floor(v + 一半) 的整数写法: 原来的 int(v / CROP_SNAP + 0.5) 只对正数等于四舍五入,
    负数会朝 0 截断 (-144 被吸到 -64, 前端 snapGrid 给的是 -128)。外框允许伸到图片外之后
    起点会出现负值, 两侧必须完全一致, 否则后端会把前端算好的 -64 又吸回 0, 裁剪位置整体错开。
    """
    return (v + CROP_SNAP // 2) // CROP_SNAP * CROP_SNAP


def _size_cap(size: int, inset: int) -> int:
    """外侧选框单边的尺寸上限 = 图像 + 2 * inset (外框每边最多伸出图片 inset)。

    前端拖手柄 / 拖拽框选时还会按"钉住不动的那条边"再收紧一档 (见 cropRect.js 的 sideCap),
    但后端只做兜底收敛、不知道锚点, 所以取几何上限 —— 前端能算出来的任何 w/h 在这里都必须原样
    保留, 否则后端会把前端已经算好的框又夹小一截 (裁剪块与选框对不上, 蒙版整体错位)。
    """
    return _grid_max(size + 2 * inset)


def _crop_pos(v: int, lo: int, hi: int) -> int:
    """外框起点的归一化: 界内吸附 CROP_SNAP, 越过边界则精确停在边界上 (与前端 cropPos 逐值一致)。

    边界 lo = -inset、hi = 图宽 - 宽 + inset 正是"内框压住图片边缘"的那两个位置, 一般不是 64 的
    倍数 —— 这是刻意的, 也正是不能写成"先吸附再夹取"的原因: -inset 被吸附一次就回到网格上
    (inset=32 时 -32 → 0), 而前端画框已经归一化过一次、这里还要兜底一次, 两次结果就会错开
    inset 像素 (裁剪位置与选框对不上)。让边界值成为不动点, 幂等才有保证。
    """
    if v <= lo:
        return lo
    if v >= hi:
        return hi
    return min(max(_snap_grid(v), lo), hi)


def _floor_grid(v: int) -> int:
    return (v // CROP_SNAP) * CROP_SNAP


def _ceil_grid(v: int) -> int:
    return -(-v // CROP_SNAP) * CROP_SNAP


def _grid_max(v: int) -> int:
    """图像能给的最大边长: 向下对齐到网格; 图像本身比一格还小时只好退回图像尺寸"""
    n = max(0, int(v))
    f = _floor_grid(n)
    return f if f >= CROP_SNAP else n


def _crop_rect_from_request(crop, image_size):
    """把请求里的裁剪框换算成图像内的整数框 (x, y, w, h); 缺失或非法返回 None。

    只做兜底收敛: 起点与宽高都吸附到 CROP_SNAP (64) 的倍数 (裁剪块尺寸 = 生成分辨率,
    64 对齐后 return_x64 不会再改动它), 边长 ≥ 2a (内框允许退化到 0×0); 单边上限 = 图像 + 2a
    (见 _size_cap), 不设 512 之类的硬上限, 只约束面积。
    外框允许伸到图片外 —— 每边最多外扩 inset (与前端 cropRect.js 一致): 内框 = 外框每边向内缩 inset,
    所以这等价于"内框始终落在图片内", 而画笔就能涂到图片边缘那一圈。
    前端已经按 64 的倍数对齐过, 后端再夹一次防止手写请求越界。
    """
    if not isinstance(crop, dict):
        return None
    try:
        x, y, w, h = (int(round(float(crop[key]))) for key in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    try:
        inset = int(round(float(crop.get("inset", CROP_MIN_INSET))))
    except (TypeError, ValueError):
        inset = CROP_MIN_INSET
    image_w, image_h = image_size
    # 单边上限 = 图像 + 2a (外框每边可伸出图片 a, 见 _size_cap); 不设 512 之类的硬上限: 长宽可任意搭配
    max_w, max_h = _size_cap(image_w, inset), _size_cap(image_h, inset)
    min_w = min(max(CROP_SNAP, _ceil_grid(2 * inset)), max_w)
    min_h = min(max(CROP_SNAP, _ceil_grid(2 * inset)), max_h)
    w = min(max(min_w, _snap_grid(w)), max_w)
    h = min(max(min_h, _snap_grid(h)), max_h)
    if w * h > CROP_MAX_AREA:
        # 面积超限时按网格逐步收缩较长边 (极端兜底, 正常请求不会走到这里)
        while w * h > CROP_MAX_AREA and (w > min_w or h > min_h):
            if w >= h:
                w = min(max(min_w, w - CROP_SNAP), max_w)
            else:
                h = min(max(min_h, h - CROP_SNAP), max_h)
    # 起点: 界内吸附 64, 越界精确停在边界上 —— 外框每边最多伸出图片 inset, 此时内框正好压在图片边缘
    x = _crop_pos(x, -inset, image_w - w + inset)
    y = _crop_pos(y, -inset, image_h - h + inset)
    return x, y, w, h


def _expand_max_area(w: int, h: int) -> int:
    """生成块形状对应的面积上限: 正方形 1024×1024, 非正方形 1024×960 (与前端 expandMaxArea 一致)。

    形状按扩展之后的宽高是否相等算: 四条边都能扩时方形框每轮都还是方的, 会一路长到 1024×1024;
    只有某几条边能扩时框会变成非方的, 上限随即收到 1024×960。
    """
    return CROP_EXPAND_MAX_AREA if w == h else CROP_EXPAND_MAX_AREA_RECT


def _expand_crop_rect(rect, image_size):
    """裁剪重绘: 把归一化后的选框向外扩成"生成块" (真正拿去裁剪的范围); 与前端 expandCropRect 逐值一致。

    每轮四条边各向外扩 CROP_EXPAND_STEP (64) 像素, 逐边判定: 只有"扩完后这条边仍落在图片内"才扩它
    (选框本来就伸到图片外的那几条边因此永远扩不动, 于是只扩对面的边)。每扩完一圈再看一眼宽高乘积:
    超过该形状的上限就整圈作废 —— 宁可不扩, 也不能超上限。选框已经够大或四条边都扩不动时原样返回,
    所以这一步是幂等的。

    扩出来的一圈只是给模型的上下文: 蒙版在那里是透明的 (见 _prepare_inpaint_inputs 的 pad_edges=False),
    之后会变成纯黑 (change_the_mask_color), 模型不会去重绘它。
    """
    x, y, w, h = rect
    image_w, image_h = image_size
    # 每轮至少扩一条边 64 像素 => 面积严格变大, 又有上限兜着, 循环必然在有限轮内结束
    # (guard 只是防止常量被改坏之后死循环, 理论上不可达)
    for _ in range(4096):
        x0 = x - CROP_EXPAND_STEP if x - CROP_EXPAND_STEP >= 0 else x
        y0 = y - CROP_EXPAND_STEP if y - CROP_EXPAND_STEP >= 0 else y
        x1 = x + w + CROP_EXPAND_STEP if x + w + CROP_EXPAND_STEP <= image_w else x + w
        y1 = y + h + CROP_EXPAND_STEP if y + h + CROP_EXPAND_STEP <= image_h else y + h
        if (x0, y0, x1, y1) == (x, y, x + w, y + h):
            break  # 四条边都扩不动了
        new_w, new_h = x1 - x0, y1 - y0
        if new_w * new_h > _expand_max_area(new_w, new_h):
            break  # 再扩一圈就超上限: 到此为止 (这一圈整个作废)
        x, y, w, h = x0, y0, new_w, new_h
    return x, y, w, h


def _crop_pad_edge(image: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    """按 box 裁剪; box 伸出图片外的部分用最靠边的像素向外延伸填满, 而不是留透明/黑边。

    裁剪块是当"重绘上下文"送进模型的 (外框 = 重绘范围, 内框 = 画笔范围), 紧挨待重绘区域的一片
    纯透明黑很容易被模型当成真实内容接下去, 反而在图片边缘生成出奇怪的深色带。用边缘像素往外
    延伸既保持不透明, 又给模型一个说得通的上文。延伸出来的部分在图片之外, 贴回时会被丢掉。
    """
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if x0 >= 0 and y0 >= 0 and x1 <= image.width and y1 <= image.height:
        return image.crop(box)
    left, top = max(0, -x0), max(0, -y0)
    right, bottom = max(0, x1 - image.width), max(0, y1 - image.height)
    src = image.crop((max(0, x0), max(0, y0), min(image.width, x1), min(image.height, y1)))
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(src, (left, top))
    if src.width <= 0 or src.height <= 0:
        return out
    # 先补左右两条竖边, 再补上下两条横边 —— 后者把四角一起补上 (此时整行/整列已经有内容了)
    if left:
        out.paste(
            out.crop((left, top, left + 1, top + src.height)).resize((left, src.height), Image.Resampling.NEAREST),
            (0, top),
        )
    if right:
        out.paste(
            out.crop((left + src.width - 1, top, left + src.width, top + src.height)).resize(
                (right, src.height), Image.Resampling.NEAREST
            ),
            (left + src.width, top),
        )
    if top:
        out.paste(out.crop((0, top, w, top + 1)).resize((w, top), Image.Resampling.NEAREST), (0, 0))
    if bottom:
        out.paste(
            out.crop((0, h - bottom - 1, w, h - bottom)).resize((w, bottom), Image.Resampling.NEAREST), (0, h - bottom)
        )
    return out


def _prepare_inpaint_inputs(inpaint: dict | None, width: int, height: int):
    """从请求中的重绘配置构建 (background, mask, composite, crop) 四元组。

    普通图生图 / 局部重绘 / 涂鸦重绘: 三张图统一缩放到请求分辨率, crop 恒为 None。

    裁剪重绘 (mode == "裁剪重绘"): 先按 crop 归一化出用户选框, 再自动向外扩成"生成块"
    (见 _expand_crop_rect —— 选框小时也按接近上限的分辨率出图), 沿生成块把三张图裁下来当生成输入,
    生成分辨率取生成块尺寸 (对齐 64 的倍数, NovelAI 的硬要求), 此时 crop 为一份贴回说明:
        {"rect": (x, y, w, h), "gen": (gw, gh), "full": 完整原图, "size": (width, height)}
    其中 rect 是生成块 (不是用户选框): 生成图整块贴回那里, 扩出来那一圈因为蒙版是黑的而不会被改动。
    调用方生成完需用 _paste_crop_back 把结果贴回原图, 输出仍是完整原图。
    """
    if not inpaint or not inpaint.get("enabled"):
        return None
    background_path = inpaint.get("background_path")
    if not background_path or not Path(background_path).exists():
        return None
    with Image.open(background_path) as bg:
        background = bg.convert("RGBA")
    if is_pure_white(background):
        return None

    mode = inpaint.get("mode", "图生图")
    if mode == "图生图":
        mask = Image.new("RGBA", background.size, (0, 0, 0, 0))
    else:
        mask_path = inpaint.get("mask_path")
        if not mask_path or not Path(mask_path).exists():
            raise ValueError("局部重绘/涂鸦重绘需要先绘制遮罩")
        with Image.open(mask_path) as m:
            mask = m.convert("RGBA")

    composite_path = inpaint.get("composite_path")
    if composite_path and Path(composite_path).exists():
        with Image.open(composite_path) as c:
            composite = c.convert("RGBA")
    else:
        composite = background

    if mode == "裁剪重绘":
        rect = _crop_rect_from_request(inpaint.get("crop"), background.size)
        if rect is None:
            raise ValueError("裁剪重绘需要先在图片上框选裁剪区域")
        # 选框 -> 生成块: 小框自动向外扩到接近该形状的上限, 扩出来那圈只作上下文 (蒙版上是黑的)
        select_rect = rect
        rect = _expand_crop_rect(rect, background.size)
        crop_x, crop_y, crop_w, crop_h = rect
        box = (crop_x, crop_y, crop_x + crop_w, crop_y + crop_h)
        gen_size = (return_x64(crop_w), return_x64(crop_h))

        def _crop_and_fit(image, pad_edges=True):
            """按外框裁下并缩到生成分辨率。

            pad_edges: 外框伸到图片外的部分用边缘像素延伸填满 (背景与合成图 —— 它们是给模型看的上下文);
            蒙版要传 False: 填了就等于把图片外的地方也标成待重绘, 那部分本来就不存在。
            """
            if image.size != background.size:
                image = _resize_editor_image(image, background.size)
            patch = _crop_pad_edge(image, box) if pad_edges else image.crop(box)
            return _resize_editor_image(patch, gen_size)

        logger.info(
            f"裁剪重绘: 选框 {select_rect[2]}×{select_rect[3]} @ ({select_rect[0]}, {select_rect[1]}) "
            f"→ 生成块 {crop_w}×{crop_h} @ ({crop_x}, {crop_y}) → 生成分辨率 {gen_size[0]}×{gen_size[1]}"
        )
        return (
            _crop_and_fit(background),
            _crop_and_fit(mask, pad_edges=False),
            _crop_and_fit(composite),
            {"rect": rect, "gen": gen_size, "full": background, "size": (width, height)},
        )

    size = (width, height)
    return (
        _resize_editor_image(background, size),
        _resize_editor_image(mask, size),
        _resize_editor_image(composite, size),
        None,
    )


def _paste_crop_back(patch_path: str, crop_ctx: dict) -> Image.Image:
    """裁剪重绘: 把生成的裁剪块贴回原图对应位置, 返回完整原图尺寸的图像。

    裁剪块先缩回生成块尺寸 (生成分辨率对齐过 64, 可能比生成块尺寸大), 再按生成块坐标贴回,
    最后整体对齐到请求分辨率 —— 与图生图一致, 输出尺寸始终等于面板分辨率。
    生成块里扩出来的那一圈在蒙版上是黑的, 模型不会重绘它, 所以贴回后它仍是原图内容。
    """
    crop_x, crop_y, crop_w, crop_h = crop_ctx["rect"]
    with Image.open(patch_path) as patch:
        patch = patch.convert("RGBA")
    if patch.size != (crop_w, crop_h):
        patch = patch.resize((crop_w, crop_h), Image.Resampling.LANCZOS)
    full = crop_ctx["full"].copy()
    full.paste(patch, (crop_x, crop_y))
    return _resize_editor_image(full, crop_ctx["size"])


def _build_character_data(characters: list[dict]) -> tuple[list, list, list]:
    """角色分区 -> v4_prompt_positive / v4_prompt_negative / characterPrompts。"""
    v4_prompt_positive = []
    v4_prompt_negative = []
    character_prompts = []
    for char in characters or []:
        if not char.get("enabled"):
            continue
        pos = char.get("position", "A1")
        if isinstance(pos, str) and "," in pos:
            try:
                x, y = [float(v) for v in pos.split(",")[:2]]
                x = round(min(1.0, max(0.0, x)), 2)
                y = round(min(1.0, max(0.0, y)), 2)
            except ValueError:
                x, y = position_to_float("C3")
        else:
            x, y = position_to_float(pos)
        center = {"x": x, "y": y}
        v4_prompt_positive.append({"char_caption": char.get("prompt", ""), "centers": [center]})
        v4_prompt_negative.append({"char_caption": char.get("negative_prompt", ""), "centers": [center]})
        character_prompts.append(
            {"prompt": char.get("prompt", ""), "uc": char.get("negative_prompt", ""), "center": center, "enabled": True}
        )
    return v4_prompt_positive, v4_prompt_negative, character_prompts


def _build_reference_data(references: list[dict]) -> dict:
    """角色参考图 -> director_reference_* 数据。"""
    images_cached = []
    descriptions = []
    information_extracted = []
    strength_values = []
    secondary_strength_values = []
    for ref in references or []:
        if not ref.get("enabled") or not ref.get("path"):
            continue
        if not Path(ref["path"]).exists():
            logger.warning(f"角色参考图不存在, 已跳过: {ref['path']}")
            continue
        process_image_by_orientation(ref["path"]).save(image_path := "./outputs/temp_character_reference_image.png")
        images_cached.append({"cache_secret_key": generate_hash_string(), "data": image_to_base64(image_path)})
        descriptions.append(
            {
                "caption": {"base_caption": ref.get("mode", "character&style"), "char_captions": []},
                "legacy_uc": False,
            }
        )
        information_extracted.append(1)
        strength_values.append(float(ref.get("strength", 1.0)))
        secondary_strength_values.append(round(1 - float(ref.get("fidelity", 1.0)), 2))
    return {
        "images_cached": images_cached,
        "descriptions": descriptions,
        "information_extracted": information_extracted,
        "strength_values": strength_values,
        "secondary_strength_values": secondary_strength_values,
    }


def _build_vibe_data(vibe: dict | None, model: str) -> tuple[list, list, list]:
    """vibe 迁移 -> reference_image_multiple / information / strength。"""
    reference_image_multiple = []
    reference_information_extracted_multiple = []
    reference_strength_multiple = []
    if not vibe:
        return reference_image_multiple, reference_information_extracted_multiple, reference_strength_multiple

    if model in ["nai-diffusion-3", "nai-diffusion-furry-3"]:
        for img in vibe.get("images", []):
            if not img.get("path") or not Path(img["path"]).exists():
                continue
            reference_image_multiple.append(image_to_base64(img["path"]))
            reference_information_extracted_multiple.append(float(img.get("information_strength", 1.0)))
            reference_strength_multiple.append(float(img.get("style_strength", 0.6)))
        return reference_image_multiple, reference_information_extracted_multiple, reference_strength_multiple

    bundle = vibe.get("bundle_path")
    if not bundle or not Path(bundle).exists():
        return reference_image_multiple, reference_information_extracted_multiple, reference_strength_multiple
    model_vibe_map = {
        "nai-diffusion-5-full": "v5full",
        "nai-diffusion-5-curated": "v5curated",
        "nai-diffusion-4-5-full": "v4-5full",
        "nai-diffusion-4-5-curated": "v4-5curated",
        "nai-diffusion-4-full": "v4full",
        "nai-diffusion-4-curated-preview": "v4curated",
    }
    vibe_data = read_json(bundle)
    vibe_model_name = model_vibe_map.get(model)
    if not vibe_model_name:
        return reference_image_multiple, reference_information_extracted_multiple, reference_strength_multiple
    try:
        for vibe_image in vibe_data["vibes"]:
            reference_image_multiple.append(return_last_value(vibe_image["encodings"][vibe_model_name])["encoding"])
            reference_strength_multiple.append(vibe_image["importInfo"]["strength"])
    except KeyError:
        reference_image_multiple.append(return_last_value(vibe_data["encodings"][vibe_model_name])["encoding"])
        reference_strength_multiple.append(vibe_data["importInfo"]["strength"])
    return reference_image_multiple, reference_information_extracted_multiple, reference_strength_multiple


def _model_function_map(model: str, kind: str):
    """按模型与用途返回对应的 JSON 构建函数。"""
    maps = {
        "t2i": {
            "nai-diffusion-5-full": nai5ft2i,  # noqa: F405
            "nai-diffusion-5-curated": nai5ct2i,  # noqa: F405
            "nai-diffusion-4-5-full": nai45ft2i,  # noqa: F405
            "nai-diffusion-4-5-curated": nai45ct2i,  # noqa: F405
            "nai-diffusion-4-full": nai4ft2i,  # noqa: F405
            "nai-diffusion-4-curated-preview": nai4cpt2i,  # noqa: F405
            "nai-diffusion-3": nai3t2i,  # noqa: F405
            "nai-diffusion-furry-3": naif3t2i,  # noqa: F405
        },
        "vibe": {
            "nai-diffusion-5-full": nai5fvibe,  # noqa: F405
            "nai-diffusion-5-curated": nai5cvibe,  # noqa: F405
            "nai-diffusion-4-5-full": nai45fvibe,  # noqa: F405
            "nai-diffusion-4-5-curated": nai45cvibe,  # noqa: F405
            "nai-diffusion-4-full": nai4fvibe,  # noqa: F405
            "nai-diffusion-4-curated-preview": nai4cpvibe,  # noqa: F405
            "nai-diffusion-3": nai3vibe,  # noqa: F405
            "nai-diffusion-furry-3": naif3vibe,  # noqa: F405
        },
        "char": {
            "nai-diffusion-5-full": nai5fchar,  # noqa: F405
            "nai-diffusion-5-curated": nai5cchar,  # noqa: F405
            "nai-diffusion-4-5-full": nai45fchar,  # noqa: F405
            "nai-diffusion-4-5-curated": nai45cchar,  # noqa: F405
        },
        "i2i": {
            "nai-diffusion-5-full": nai5fi2i,  # noqa: F405
            "nai-diffusion-5-curated": nai5ci2i,  # noqa: F405
            "nai-diffusion-4-5-full": nai45fi2i,  # noqa: F405
            "nai-diffusion-4-5-curated": nai45ci2i,  # noqa: F405
            "nai-diffusion-4-full": nai4fi2i,  # noqa: F405
            "nai-diffusion-4-curated-preview": nai4cpi2i,  # noqa: F405
            "nai-diffusion-3": nai3i2i,  # noqa: F405
            "nai-diffusion-furry-3": naif3i2i,  # noqa: F405
        },
        "infill": {
            "nai-diffusion-5-full": nai5finfill,  # noqa: F405
            "nai-diffusion-5-curated": nai5cinfill,  # noqa: F405
            "nai-diffusion-4-5-full": nai45finfill,  # noqa: F405
            "nai-diffusion-4-5-curated": nai45cinfill,  # noqa: F405
            "nai-diffusion-4-full": nai4finfill,  # noqa: F405
            "nai-diffusion-4-curated-preview": nai4cpinfill,  # noqa: F405
            "nai-diffusion-3": nai3infill,  # noqa: F405
            "nai-diffusion-furry-3": naif3infill,  # noqa: F405
        },
    }
    return maps.get(kind, {}).get(model)


# ---------------------------------------------------------------- 主流程


def generate(request: dict) -> tuple[list[str], str]:
    """按请求生成一张或多张图片, 返回 (图片路径列表, 结果信息)。

    由生图队列 (utils.gen_queue) 调度: 排队 / 并发 / 冷却均由队列管理。
    """
    model = request["model"]
    positive_input = request.get("positive_prompt", "")
    negative_input = request.get("negative_prompt", "")
    furry_mode = request.get("furry_mode", False)
    add_quality_tags = request.get("quality_preset", "None")
    undesired_contentc_preset = request.get("uc_preset", "None")
    quantity = int(request.get("quantity", 1))
    width = int(request.get("width", 832))
    height = int(request.get("height", 1216))
    steps = int(request.get("steps", 23))
    prompt_guidance = float(request.get("scale", 5))
    prompt_guidance_rescale = float(request.get("cfg_rescale", 0))
    variety = bool(request.get("variety", False))
    seed = str(request.get("seed", "-1"))
    sampler = request.get("sampler", "k_euler_ancestral")
    noise_schedule = request.get("noise_schedule", "karras")
    decrisp = bool(request.get("decrisp", False))
    sm = bool(request.get("sm", False))
    sm_dyn = bool(request.get("sm_dyn", False))
    legacy_uc = bool(request.get("legacy_uc", False))
    ai_choice = bool(request.get("ai_choice", True))
    enhance = request.get("enhance", {}) or {}
    vibe = request.get("vibe") or {}
    inpaint = request.get("inpaint") or {}
    characters = request.get("characters", [])
    references = request.get("references", [])

    os.makedirs("./outputs", exist_ok=True)
    reset_stop()  # 重置本任务的停止信号 (队列多通道并行时各任务独立)

    _type = "text2image"
    image_list: list[str] = []
    use_reference = any(r.get("enabled") and r.get("path") for r in references) and model in [
        "nai-diffusion-4-5-full",
        "nai-diffusion-4-5-curated",
    ]
    use_vibe = bool(vibe.get("bundle_path")) or any(i.get("path") for i in vibe.get("images", []))

    skipped = 0  # 重试后仍失败的图片数量

    for i in range(quantity):
        if check_stop():
            logger.warning("已停止生成!")
            break

        logger.info(f"正在生成第 {i + 1} 张图片..." if quantity != 1 else "正在生成图片...")
        _seed = random.randint(1000000000, 9999999999) if seed == "-1" else int(seed)

        # 1. 选择模型函数
        if use_vibe and model not in ["nai-diffusion-5-full", "nai-diffusion-5-curated"]:
            func = _model_function_map(model, "vibe")
        elif use_reference:
            func = _model_function_map(model, "char")
        else:
            func = _model_function_map(model, "t2i")

        if func is None:
            raise NovelAIAPIError(f"不支持的模型: {model}")

        # 2. 处理 furry 模式
        _positive_input = (
            ("fur dataset, " + positive_input)
            if furry_mode and model not in ["nai-diffusion-3", "nai-diffusion-furry-3"]
            else positive_input
        )

        # 3. 角色与参考数据
        v4_pos, v4_neg, char_prompts = _build_character_data(characters)
        ref_data = _build_reference_data(references) if use_reference else None
        ref_imgs, ref_infos, ref_strengths = _build_vibe_data(vibe, model)

        # 4. 构建基础 JSON
        json_data = func(
            _input=format_str(
                f"{_positive_input}, " + return_quality_tags(model, add_quality_tags)
                if add_quality_tags != "None"
                else _positive_input
            ),
            params_version=4,
            width=return_x64(width),
            height=return_x64(height),
            scale=prompt_guidance,
            sampler=sampler,
            steps=steps,
            n_samples=1,
            ucPresetId=return_uc_preset_id(model)[undesired_contentc_preset],
            qualityPresetId=return_quality_preset_id(model)[add_quality_tags],
            autoSmea=False,
            dynamic_thresholding=decrisp if model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
            controlnet_strength=1,
            legacy=False,
            add_original_image=True,
            cfg_rescale=prompt_guidance_rescale,
            noise_schedule="karras" if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated"] else noise_schedule,
            legacy_v3_extend=False,
            skip_cfg_above_sigma=(return_skip_cfg_above_sigma(model) if variety else None),
            use_coords=not ai_choice,
            normalize_reference_strength_multiple=vibe.get("normalize", True),
            inpaintImg2ImgStrength=1,
            use_order=True,
            legacy_uc=legacy_uc if model in ["nai-diffusion-4-full", "nai-diffusion-4-curated-preview"] else False,
            seed=_seed,
            negative_prompt=format_str(
                return_undesired_contentc_preset(model, undesired_contentc_preset) + f", {negative_input}"
                if undesired_contentc_preset != "None"
                else negative_input
            ),
            deliberate_euler_ancestral_bug=False,
            prefer_brownian=True,
            use_new_shared_trial=True,
            sm=sm,
            sm_dyn=sm_dyn,
            reference_image_multiple=ref_imgs,
            reference_information_extracted_multiple=ref_infos,
            reference_strength_multiple=ref_strengths,
            v4_prompt_positive=v4_pos,
            v4_prompt_negative=v4_neg,
            characterPrompts=char_prompts,
            director_reference_images_cached=ref_data["images_cached"] if ref_data else [],
            director_reference_descriptions=ref_data["descriptions"] if ref_data else [],
            director_reference_information_extracted=ref_data["information_extracted"] if ref_data else [],
            director_reference_strength_values=ref_data["strength_values"] if ref_data else [],
            director_reference_secondary_strength_values=ref_data["secondary_strength_values"] if ref_data else [],
            straight_alpha=True,
        )

        # 4.5 留一份"干净"的基础请求给后面 Enhance 用 ——
        # inpaint() 会把 model 换成 xxx-inpainting、action 换成 infill, 并往 parameters 里塞 mask;
        # 若 Enhance 直接在这份被改过的请求上改成 img2img, 就会得到"inpainting 模型 + img2img"
        # 这种官网不接受的组合 (模型与 action 不匹配 -> 报错), 还残留 mask / inpaintImg2ImgStrength。
        base_json = deepcopy(json_data)

        # 5. 图生图 / 重绘
        crop_ctx = None  # 裁剪重绘的贴回说明; 其它模式恒为 None
        inpaint_inputs = _prepare_inpaint_inputs(inpaint, width, height)
        if inpaint_inputs:
            inpaint_image, inpaint_mask, inpaint_composite, crop_ctx = inpaint_inputs
            inpaint_image.save(image_path := "./outputs/temp_inpaint_image.png")
            inpaint_mask.save(mask_path := "./outputs/temp_inpaint_mask.png")
            inpaint_composite.save(composite_path := "./outputs/temp_inpaint_composite.png")

            if crop_ctx:
                # 裁剪重绘: 送入模型的就是生成块 (选框自动外扩出来的那块), 生成分辨率跟着它走
                # (已对齐 64 的倍数, return_x64 不会再改动)
                gen_w, gen_h = crop_ctx["gen"]
                json_data["parameters"]["width"] = gen_w
                json_data["parameters"]["height"] = gen_h

            if is_fully_transparent(mask_path):
                func = _model_function_map(model, "i2i")
                _type = "image2image"
            else:
                func = _model_function_map(model, "infill")
                _type = "inpaint"

            if func is None:
                raise NovelAIAPIError(f"该模型不支持图生图: {model}")

            image_kwargs = {
                "strength": float(inpaint.get("strength", 0.7)),
                "noise": float(inpaint.get("noise", 0)),
                "inpaint_i2i_strength": float(inpaint.get("mask_strength", 1)),
                "image": image_to_base64(
                    resize_image(composite_path if inpaint.get("mode") == "涂鸦重绘" else image_path)
                ),
                "extra_noise_seed": _seed,
                "color_correct": False,
            }
            if _type == "inpaint":
                image_kwargs["mask"] = image_to_base64(
                    resize_image(process_white_regions(change_the_mask_color(mask_path), mask_path))
                )
            json_data = func(json_data, **image_kwargs)

        # 6. 保存请求并生成 (wildcards 只解析一次, 重试沿用同一份请求)
        with open("./outputs/temp_last_origin.json", "w", encoding="utf-8") as f:
            json.dump(json_data, f, ensure_ascii=False, indent=4)

        try:
            resolved_json = find_and_replace_wildcards_from_dict(json_data)
            image_data = _generate_with_retry(image_generator, resolved_json, f"第 {i + 1} 张")
            if crop_ctx:
                # 裁剪重绘: 模型返回的只是裁剪块, 先原样落地保留 NovelAI 元数据,
                # 贴回原图后按正常命名重新写盘, 再把元数据搬过去 (PNG 隐写 + EXIF tEXt)
                crop_raw_path = "./outputs/temp_inpaint_crop.png"
                with open(crop_raw_path, "wb") as f:
                    f.write(image_data)
                buffer = BytesIO()
                _paste_crop_back(crop_raw_path, crop_ctx).save(buffer, format="PNG")
                path = image_generator.save(buffer.getvalue(), _type, json_data["parameters"]["seed"])
                revert_image_info(crop_raw_path, path)
            else:
                path = image_generator.save(image_data, _type, json_data["parameters"]["seed"])
            if not path:
                raise NovelAIAPIError("图片保存失败")
            if crop_ctx:
                logger.info(f"裁剪重绘已贴回原图 (生成块 {crop_ctx['rect'][2]}×{crop_ctx['rect'][3]}): {path}")

            # 7. Enhance (失败自动重试; 仍失败则保留原图继续)
            if enhance.get("enabled"):
                logger.info("正在 Enhance 图片...")
                func = _model_function_map(model, "i2i")
                if func is None:
                    raise NovelAIAPIError(f"该模型不支持 Enhance: {model}")
                new_width, new_height = _enhance_target_size(model, enhance.get("amount", "1.5x"), width, height)
                magnitude = int(enhance.get("magnitude", 1))
                strength_map = {1: 0.2, 2: 0.4, 3: 0.5, 4: 0.6, 5: 0.7}
                # Enhance 是"整图 img2img", 必须从干净的基础请求重建:
                # 直接用被重绘改过的 json_data 会带着 -inpainting 模型 + mask 发出去 (详见上面 base_json)
                json_data = func(
                    deepcopy(base_json),
                    strength=strength_map.get(magnitude, 0.5),
                    noise=0,
                    image=image_to_base64(resize_image(path, output_path="./outputs/temp_enhance_resized.png")),
                    extra_noise_seed=_seed,
                    color_correct=False,
                )
                _seed = random.randint(1000000000, 9999999999) if seed == "-1" else int(seed)
                json_data["parameters"]["seed"] = _seed
                json_data["parameters"]["extra_noise_seed"] = _seed
                json_data["parameters"]["width"] = new_width
                json_data["parameters"]["height"] = new_height
                # 模型与 action 必须是一对合法组合 (尤其别把上一步重绘的 -inpainting 带进来) —— 见 base_json
                logger.info(f"Enhance 请求: {json_data['model']} / {json_data['action']} -> {new_width}×{new_height}")
                try:
                    image_data = _generate_with_retry(
                        image_generator, find_and_replace_wildcards_from_dict(json_data), "Enhance"
                    )
                    path = image_generator.save(image_data, "image2image", json_data["parameters"]["seed"])
                except StopGeneration:
                    raise
                except Exception as e:
                    logger.error(f"Enhance 失败, 保留原图: {e}")
                    logger.opt(exception=True).debug("Enhance 失败堆栈:")
        except StopGeneration:
            logger.warning("已停止生成!")
            break
        except Exception as e:
            # 重试后仍失败: 跳过该张, 继续生成后续图片
            skipped += 1
            logger.error(f"第 {i + 1} 张图片生成失败, 已跳过 (累计 {skipped} 张): {e}")
            logger.opt(exception=True).debug("单张生成失败堆栈:")
            continue

        image_list.append(path)

        if quantity != 1 and i != quantity - 1:
            sleep_for_cool(env.cool_time)

    if not image_list:
        return image_list, "生成失败!"

    playsound("./assets/finish.mp3")
    if env.smtp_num > 0 and quantity >= env.smtp_num:
        try:
            send_mail()
        except Exception as e:
            logger.error(f"发送邮件提醒失败: {e}")
            logger.opt(exception=True).debug("发送邮件提醒失败堆栈:")

    from utils.generator import get_last_anlas

    _anlas, _remains = get_last_anlas()
    message = f"处理完成! 剩余点数: {_anlas}; 剩余用量: {_remains}%"
    if skipped:
        message += f" (已跳过 {skipped} 张失败图片)"
    return image_list, message
