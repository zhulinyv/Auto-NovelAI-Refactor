import random

from utils import format_str, replace_wildcards, return_x64, sleep_for_cool
from utils.generator import Generator
from utils.logger import logger
from utils.models import *  # noqa
from utils.variable import (
    return_quality_tags,
    return_skip_cfg_above_sigma,
    return_uc_preset_data,
    return_undesired_contentc_preset,
)


def main(
    model,
    positive_input,
    negative_input,
    add_quality_tags,
    undesired_contentc_preset,
    quantity,
    width,
    height,
    steps,
    prompt_guidance,
    prompt_guidance_rescale,
    variety,
    seed,
    sampler,
    noise_schedule,
    decrisp,
    sm,
    sm_dyn,
    legacy_uc,
):
    image_list = []

    for i in range(quantity):
        if quantity != 1:
            logger.info(f"正在生成第 {i+1} 张图片...")
        else:
            logger.info("正在生成图片...")

        _positive_input = replace_wildcards(positive_input)
        _negative_input = replace_wildcards(negative_input)

        model_function_map = {
            "nai-diffusion-4-5-full": nai45ft2i,  # noqa
            "nai-diffusion-4-5-curated": nai45ct2i,  # noqa
            "nai-diffusion-4-full": nai4ft2i,  # noqa
            "nai-diffusion-4-curated-preview": nai4cpt2i,  # noqa
            "nai-diffusion-3": nai3t2i,  # noqa
            "nai-diffusion-furry-3": naif3t2i,  # noqa
        }
        func = model_function_map.get(model)

        json_data = func(
            _input=format_str(_positive_input + return_quality_tags(model) if add_quality_tags else _positive_input),
            width=return_x64(width),
            height=return_x64(height),
            scale=prompt_guidance,
            sampler=sampler,
            steps=steps,
            ucPreset=return_uc_preset_data(model)[undesired_contentc_preset],
            qualityToggle=add_quality_tags,
            autoSmea=False,
            dynamic_thresholding=decrisp if model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
            legacy=False,
            add_original_image=True,
            cfg_rescale=prompt_guidance_rescale,
            noise_schedule=noise_schedule,
            legacy_v3_extend=False,
            skip_cfg_above_sigma=(return_skip_cfg_above_sigma(model) if variety else None),
            use_coords=False,
            normalize_reference_strength_multiple=True,
            use_order=True,
            legacy_uc=legacy_uc if model in ["nai-diffusion-4-full", "nai-diffusion-4-curated-preview"] else False,
            seed=random.randint(1000000000, 9999999999) if seed == "-1" else int(seed),
            negative_prompt=format_str(
                _negative_input + return_undesired_contentc_preset(model, undesired_contentc_preset)
            ),
            deliberate_euler_ancestral_bug=False,  # 仅在采样器为 k_euler_ancestral 时出现
            prefer_brownian=True,
            use_new_shared_trial=True,
            sm=sm,
            sm_dyn=sm_dyn,
        )

        generator = Generator("https://image.novelai.net/ai/generate-image")
        image_data = generator.generate(json_data)
        if image_data:
            path = generator.save(image_data, "text2image", json_data["parameters"]["seed"])
            image_list.append(path)
        if quantity != 1 and i != quantity - 1:
            sleep_for_cool(3)
    return image_list, "处理完成!"
