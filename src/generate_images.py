import random

from utils import (
    format_str,
    position_to_float,
    read_json,
    replace_wildcards,
    return_last_value,
    return_x64,
    sleep_for_cool,
)
from utils.generator import Generator
from utils.image_tools import image_to_base64
from utils.logger import logger
from utils.models import *  # noqa
from utils.variable import (
    return_quality_tags,
    return_skip_cfg_above_sigma,
    return_uc_preset_data,
    return_undesired_contentc_preset,
)

generator = Generator("https://image.novelai.net/ai/generate-image")


def main(
    model,
    positive_input,
    negative_input,
    furry_mode,
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
    naiv4vibebundle_file,
    normalize_reference_strength_multiple,
    character_reference_image,
    style_aware,
    fidelity,
    ai_choice,
    *args,
):
    if furry_mode == "🐾" and model not in ["nai-diffusion-3", "nai-diffusion-furry-3"]:
        positive_input = "fur dataset, " + positive_input

    director_reference_images = []
    director_reference_descriptions = []
    director_reference_information_extracted = []
    director_reference_strength_values = []
    director_reference_secondary_strength_values = []

    character_components = args[:30]
    character_components = [list(chunk) for chunk in zip(*[iter(character_components)] * 5)]
    v4_prompt_positive = []
    v4_prompt_negative = []
    characterPrompts = []
    for character_prompt in character_components:
        if character_prompt[-2]:
            x, y = position_to_float(character_prompt[2])
            center = {"x": x, "y": y}
            centers = [center]

            v4_prompt_positive.append({"char_caption": character_prompt[0], "centers": centers})
            v4_prompt_negative.append({"char_caption": character_prompt[1], "centers": centers})
            characterPrompts.append(
                {"prompt": character_prompt[0], "uc": character_prompt[1], "center": center, "enabled": True}
            )

    vibe_components = args[30:]
    reference_image_multiple = []
    reference_information_extracted_multiple = []
    reference_strength_multiple = []
    if naiv4vibebundle_file or vibe_components[0]:
        model_function_map = {
            "nai-diffusion-4-5-full": nai45fvibe,  # noqa
            "nai-diffusion-4-5-curated": nai45cvibe,  # noqa
            "nai-diffusion-4-full": nai4fvibe,  # noqa
            "nai-diffusion-4-curated-preview": nai4cpvibe,  # noqa
            "nai-diffusion-3": nai3vibe,  # noqa
            "nai-diffusion-furry-3": nai3vibe,  # noqa
        }
        if model in ["nai-diffusion-3", "nai-diffusion-furry-3"]:
            vibe_images = [list(chunk) for chunk in zip(*[iter(vibe_components)] * 3)]
            for vibe_image in vibe_images:
                reference_image_multiple.append(image_to_base64(vibe_image[0]))
                reference_information_extracted_multiple.append(vibe_image[1])
                reference_strength_multiple.append(vibe_image[2])
        else:
            model_vibe_map = {
                "nai-diffusion-4-5-full": "v4-5full",
                "nai-diffusion-4-5-curated": "v4-5curated",
                "nai-diffusion-4-full": "v4full",
                "nai-diffusion-4-curated-preview": "v4curated",
            }
            vibe_data = read_json(naiv4vibebundle_file)
            vibe_model_name = model_vibe_map.get(model)
            for vibe_image in vibe_data["vibes"]:
                reference_image_multiple.append(return_last_value(vibe_image["encodings"][vibe_model_name])["encoding"])
                reference_strength_multiple.append(vibe_image["importInfo"]["strength"])
    else:
        if character_reference_image and model in ["nai-diffusion-4-5-full", "nai-diffusion-4-5-curated"]:
            director_reference_images = [image_to_base64(character_reference_image)]
            director_reference_descriptions = [
                {
                    "caption": {
                        "base_caption": "character&style" if style_aware else "character",
                        "char_captions": [],
                    },
                    "legacy_uc": False,
                }
            ]
            director_reference_information_extracted = [1]
            director_reference_strength_values = [1]
            director_reference_secondary_strength_values = [1 - fidelity]
            model_function_map = {
                "nai-diffusion-4-5-full": nai45fchar,  # noqa
                "nai-diffusion-4-5-curated": nai45cchar,  # noqa
            }
        else:
            model_function_map = {
                "nai-diffusion-4-5-full": nai45ft2i,  # noqa
                "nai-diffusion-4-5-curated": nai45ct2i,  # noqa
                "nai-diffusion-4-full": nai4ft2i,  # noqa
                "nai-diffusion-4-curated-preview": nai4cpt2i,  # noqa
                "nai-diffusion-3": nai3t2i,  # noqa
                "nai-diffusion-furry-3": naif3t2i,  # noqa
            }
    func = model_function_map.get(model)

    image_list = []

    for i in range(quantity):
        if quantity != 1:
            logger.info(f"正在生成第 {i+1} 张图片...")
        else:
            logger.info("正在生成图片...")

        _positive_input = replace_wildcards(positive_input)
        _negative_input = replace_wildcards(negative_input)

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
            use_coords=not ai_choice,
            normalize_reference_strength_multiple=normalize_reference_strength_multiple,
            use_order=True,
            legacy_uc=legacy_uc if model in ["nai-diffusion-4-full", "nai-diffusion-4-curated-preview"] else False,
            seed=random.randint(1000000000, 9999999999) if seed == "-1" else int(seed),
            negative_prompt=format_str(
                _negative_input + return_undesired_contentc_preset(model, undesired_contentc_preset)
            ),
            deliberate_euler_ancestral_bug=False,  # 仅在采样器为 k_euler_ancestral 时出现
            prefer_brownian=True,  # 仅在采样器为 k_euler_ancestral 时出现
            use_new_shared_trial=True,
            sm=sm,
            sm_dyn=sm_dyn,
            reference_image_multiple=reference_image_multiple,
            reference_information_extracted_multiple=reference_information_extracted_multiple,
            reference_strength_multiple=reference_strength_multiple,
            v4_prompt_positive=v4_prompt_positive,
            v4_prompt_negative=v4_prompt_negative,
            characterPrompts=characterPrompts,
            director_reference_images=director_reference_images,
            director_reference_descriptions=director_reference_descriptions,
            director_reference_information_extracted=director_reference_information_extracted,
            director_reference_strength_values=director_reference_strength_values,
            director_reference_secondary_strength_values=director_reference_secondary_strength_values,
        )

        image_data = generator.generate(json_data)
        if image_data:
            path = generator.save(image_data, "text2image", json_data["parameters"]["seed"])
            image_list.append(path)
        if quantity != 1 and i != quantity - 1:
            sleep_for_cool(3)
    return image_list, "处理完成!"
