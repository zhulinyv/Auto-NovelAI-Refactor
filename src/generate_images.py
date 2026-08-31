"""图片生成核心逻辑 (重构版)。

由原来的 Gradio 回调 (一长串位置参数) 改为接收结构化字典 `GenerateRequest`,
内部逻辑与原版保持一致: 模型 JSON 构建、wildcard 替换、图生图/重绘、Enhance 等。
"""

from __future__ import annotations

import os
import random
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
    return_x64,
    send_mail,
    sleep_for_cool,
    sleep_interruptible,
)
from utils.image_tools import (
    change_the_mask_color,
    image_to_base64,
    is_fully_transparent,
    is_pure_white,
    process_image_by_orientation,
    process_white_regions,
    resize_image,
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
                sleep_interruptible(5)
                continue
            retries += 1
            if retries > max_retries:
                logger.error(f"[{desc}] 重试 {max_retries} 次仍失败, 跳过该图片: {e}")
                logger.opt(exception=True).debug("生成重试失败堆栈:")
                raise
            logger.warning(f"[{desc}] 生成失败, 等待 5 秒后重试 ({retries}/{max_retries}): {e}")
            if check_stop():
                raise StopGeneration("已停止生成")
            sleep_interruptible(5)


def _resize_editor_image(image, size):
    return image if image.size == size else image.resize(size, Image.Resampling.LANCZOS)


def _prepare_inpaint_inputs(inpaint: dict | None, width: int, height: int):
    """从请求中的重绘配置构建 (background, mask, composite) PIL 图像。"""
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

    size = (width, height)
    return (
        _resize_editor_image(background, size),
        _resize_editor_image(mask, size),
        _resize_editor_image(composite, size),
    )


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

        # 5. 图生图 / 重绘
        inpaint_inputs = _prepare_inpaint_inputs(inpaint, width, height)
        if inpaint_inputs:
            inpaint_image, inpaint_mask, inpaint_composite = inpaint_inputs
            inpaint_image.save(image_path := "./outputs/temp_inpaint_image.png")
            inpaint_mask.save(mask_path := "./outputs/temp_inpaint_mask.png")
            inpaint_composite.save(composite_path := "./outputs/temp_inpaint_composite.png")

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
            path = image_generator.save(image_data, _type, json_data["parameters"]["seed"])
            if not path:
                raise NovelAIAPIError("图片保存失败")

            # 7. Enhance (失败自动重试; 仍失败则保留原图继续)
            if enhance.get("enabled"):
                logger.info("正在 Enhance 图片...")
                func = _model_function_map(model, "i2i")
                if func is None:
                    raise NovelAIAPIError(f"该模型不支持 Enhance: {model}")
                upscale_amount = float(str(enhance.get("amount", "1.5x")).replace("x", ""))
                new_width = return_x64(int(width * upscale_amount))
                new_height = return_x64(int(height * upscale_amount))
                magnitude = int(enhance.get("magnitude", 1))
                strength_map = {1: 0.2, 2: 0.4, 3: 0.5, 4: 0.6, 5: 0.7}
                json_data = func(
                    json_data,
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

    from utils.generator import get_last_anlas

    _anlas, _remains = get_last_anlas()
    message = f"处理完成! 剩余点数: {_anlas}; 剩余用量: {_remains}%"
    if skipped:
        message += f" (已跳过 {skipped} 张失败图片)"
    return image_list, message
