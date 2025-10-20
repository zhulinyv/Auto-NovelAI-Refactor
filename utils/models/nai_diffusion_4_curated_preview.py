def text2image(**kwargs):
    json_data = {
        "input": kwargs["_input"],
        "model": "nai-diffusion-4-curated-preview",
        "action": "generate",
        "parameters": {
            "params_version": 3,
            "width": kwargs["width"],
            "height": kwargs["height"],
            "scale": kwargs["scale"],
            "sampler": kwargs["sampler"],
            "steps": kwargs["steps"],
            "n_samples": 1,
            "ucPreset": kwargs["ucPreset"],
            "qualityToggle": kwargs["qualityToggle"],
            "autoSmea": kwargs["autoSmea"],
            "dynamic_thresholding": kwargs["dynamic_thresholding"],
            "controlnet_strength": 1,
            "legacy": kwargs["legacy"],
            "add_original_image": kwargs["add_original_image"],
            "cfg_rescale": kwargs["cfg_rescale"],
            "noise_schedule": kwargs["noise_schedule"],
            "legacy_v3_extend": kwargs["legacy_v3_extend"],
            "skip_cfg_above_sigma": kwargs["skip_cfg_above_sigma"],
            "use_coords": kwargs["use_coords"],
            "legacy_uc": kwargs["legacy_uc"],
            "normalize_reference_strength_multiple": kwargs["normalize_reference_strength_multiple"],
            "inpaintImg2ImgStrength": 1,
            "seed": kwargs["seed"],  # 10 位数
            "characterPrompts": kwargs[
                "characterPrompts"
            ],  # {"prompt": str, "uc": str, "center": {"x": float, "y": float}, "enabled": bool}
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
            "negative_prompt": kwargs["negative_prompt"],
            # "deliberate_euler_ancestral_bug": kwargs["deliberate_euler_ancestral_bug"],
            # "prefer_brownian": kwargs["prefer_brownian"],
            "stream": "msgpack",
        },
        "use_new_shared_trial": kwargs["use_new_shared_trial"],
    }

    if kwargs["sampler"] == "k_euler_ancestral":
        json_data["parameters"]["deliberate_euler_ancestral_bug"] = kwargs["deliberate_euler_ancestral_bug"]
        json_data["parameters"]["prefer_brownian"] = kwargs["prefer_brownian"]

    return json_data


def vibe_transfer(**kwargs):
    json_data = text2image(**kwargs)
    json_data["parameters"]["reference_image_multiple"] = kwargs["reference_image_multiple"]
    json_data["parameters"]["reference_strength_multiple"] = kwargs["reference_strength_multiple"]
    return json_data


def image2image(json_data, **kwargs):
    json_data["action"] = "img2img"
    json_data["parameters"]["color_correct"] = kwargs["color_correct"]
    json_data["parameters"]["strength"] = kwargs["strength"]
    json_data["parameters"]["noise"] = kwargs["noise"]
    json_data["parameters"]["image"] = kwargs["image"]
    json_data["parameters"]["extra_noise_seed"] = kwargs["extra_noise_seed"]
    return json_data
