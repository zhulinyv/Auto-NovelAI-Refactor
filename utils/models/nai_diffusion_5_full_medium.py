def text2image(**kwargs):
    # "Effort: Medium" 是 V5 Full 的蒸馏变体: 字段集合与 V5 Full 一致, 但官网
    # getModelSupportInfo().fixedSettings 固定了 steps/sampler/ucPresetId, 且关闭 cfgRescale
    # (官方请求体里连 cfg_rescale 字段都不出现)。这三项因此写死, 不再取 kwargs。
    json_data = {
        "input": kwargs["_input"],
        "model": "nai-diffusion-5-full-medium",
        "action": "generate",
        "parameters": {
            "params_version": kwargs["params_version"],
            "width": kwargs["width"],
            "height": kwargs["height"],
            "scale": kwargs["scale"],
            "sampler": "k_euler_ancestral",
            "steps": 14,
            "n_samples": kwargs["n_samples"],
            "ucPresetId": "heavy",
            "qualityPresetId": kwargs["qualityPresetId"],
            "autoSmea": kwargs["autoSmea"],
            "dynamic_thresholding": kwargs["dynamic_thresholding"],
            "controlnet_strength": kwargs["controlnet_strength"],
            "legacy": kwargs["legacy"],
            "add_original_image": kwargs["add_original_image"],
            "noise_schedule": kwargs["noise_schedule"],
            "legacy_v3_extend": kwargs["legacy_v3_extend"],
            # "skip_cfg_above_sigma": kwargs["skip_cfg_above_sigma"],
            "use_coords": kwargs["use_coords"],
            "normalize_reference_strength_multiple": kwargs["normalize_reference_strength_multiple"],
            "inpaintImg2ImgStrength": kwargs["inpaintImg2ImgStrength"],
            "v4_prompt": {
                "caption": {
                    "base_caption": kwargs["_input"],
                    "char_captions": kwargs[
                        "v4_prompt_positive"
                    ],  # {"char_caption": str, "centers": [{"x": float, "y": float}]},,
                },
                "use_coords": kwargs["use_coords"],
                "use_order": kwargs["use_order"],
            },
            "v4_negative_prompt": {
                "caption": {
                    "base_caption": kwargs["negative_prompt"],
                    "char_captions": kwargs[
                        "v4_prompt_negative"
                    ],  # {"char_caption": str, "centers": [{"x": float, "y": float}]},,
                },
                "legacy_uc": kwargs["legacy_uc"],
            },
            "legacy_uc": kwargs["legacy_uc"],
            "seed": kwargs["seed"],  # 9-10 位数
            "characterPrompts": kwargs[
                "characterPrompts"
            ],  # {"prompt": str, "uc": str, "center": {"x": float, "y": float}, "enabled": bool}
            "straight_alpha": kwargs["straight_alpha"],
            "negative_prompt": kwargs["negative_prompt"],
            # "deliberate_euler_ancestral_bug": kwargs["deliberate_euler_ancestral_bug"],
            # "prefer_brownian": kwargs["prefer_brownian"],
            "stream": "msgpack",
        },
        "use_new_shared_trial": kwargs["use_new_shared_trial"],
    }

    # sampler 固定为 k_euler_ancestral, 这两项始终写入 (官网 Medium 请求体里也是固定出现)
    json_data["parameters"]["deliberate_euler_ancestral_bug"] = kwargs["deliberate_euler_ancestral_bug"]
    json_data["parameters"]["prefer_brownian"] = kwargs["prefer_brownian"]

    # 官网 tag_hint_* (元数据回显): 预设数字码始终发送; 透明背景仅 true 时出现
    if kwargs.get("tag_hint_qt") is not None:
        json_data["parameters"]["tag_hint_qt"] = kwargs["tag_hint_qt"]
    if kwargs.get("tag_hint_uc_preset") is not None:
        json_data["parameters"]["tag_hint_uc_preset"] = kwargs["tag_hint_uc_preset"]
    if kwargs.get("tag_hint_transparent_background"):
        json_data["parameters"]["tag_hint_transparent_background"] = True

    return json_data


def vibe_transfer(**kwargs):
    json_data = text2image(**kwargs)
    json_data["parameters"]["reference_image_multiple"] = kwargs["reference_image_multiple"]
    json_data["parameters"]["reference_strength_multiple"] = kwargs["reference_strength_multiple"]
    return json_data


def character(**kwargs):
    json_data = text2image(**kwargs)
    json_data["parameters"]["director_reference_images_cached"] = kwargs["director_reference_images_cached"]
    json_data["parameters"]["director_reference_descriptions"] = kwargs["director_reference_descriptions"]
    json_data["parameters"]["director_reference_information_extracted"] = kwargs[
        "director_reference_information_extracted"
    ]
    json_data["parameters"]["director_reference_strength_values"] = kwargs["director_reference_strength_values"]
    json_data["parameters"]["director_reference_secondary_strength_values"] = kwargs[
        "director_reference_secondary_strength_values"
    ]
    return json_data


def image2image(json_data, **kwargs):
    json_data["action"] = "img2img"
    json_data["parameters"]["color_correct"] = kwargs["color_correct"]
    json_data["parameters"]["strength"] = kwargs["strength"]
    json_data["parameters"]["noise"] = kwargs["noise"]
    json_data["parameters"]["image"] = kwargs["image"]
    json_data["parameters"]["extra_noise_seed"] = kwargs["extra_noise_seed"]
    return json_data


def inpaint(json_data, **kwargs):
    json_data = image2image(json_data, **kwargs)
    json_data["model"] = "nai-diffusion-5-full-medium-inpainting"
    json_data["action"] = "infill"
    json_data["parameters"]["inpaintImg2ImgStrength"] = kwargs["inpaint_i2i_strength"]
    json_data["parameters"]["mask"] = kwargs["mask"]
    # 对齐官网 inpaint 默认行为 (Overlay Original Image): 蒙版外区域保持原图逐像素不变
    json_data["parameters"]["add_original_image"] = True
    return json_data
