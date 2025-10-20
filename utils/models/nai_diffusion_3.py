def text2image(**kwargs):
    json_data = {
        "input": kwargs["_input"],
        "model": "nai-diffusion-3",
        "action": "generate",
        "parameters": {
            "params_version": 3,
            "width": kwargs["width"],
            "height": kwargs["height"],
            "scale": kwargs["scale"],
            "sampler": kwargs["sampler"],
            "steps": kwargs["steps"],
            "seed": kwargs["seed"],  # 10 位数
            "n_samples": 1,
            "ucPreset": kwargs["ucPreset"],
            "qualityToggle": kwargs["qualityToggle"],
            "sm": kwargs["sm"],
            "sm_dyn": kwargs["sm_dyn"],
            "dynamic_thresholding": kwargs["dynamic_thresholding"],
            "controlnet_strength": 1,
            "legacy": kwargs["legacy"],
            "add_original_image": kwargs["add_original_image"],
            "cfg_rescale": kwargs["cfg_rescale"],
            # "noise_schedule": kwargs["noise_schedule"],
            "legacy_v3_extend": kwargs["legacy_v3_extend"],
            "skip_cfg_above_sigma": kwargs["skip_cfg_above_sigma"],
            "characterPrompts": [],
            "negative_prompt": kwargs["negative_prompt"],
            # "deliberate_euler_ancestral_bug": kwargs["prefer_brownian"],
            # "prefer_brownian": kwargs["prefer_brownian"],
        },
        "use_new_shared_trial": kwargs["use_new_shared_trial"],
    }

    if kwargs["sampler"] == "k_euler_ancestral":
        json_data["parameters"]["deliberate_euler_ancestral_bug"] = kwargs["deliberate_euler_ancestral_bug"]
        json_data["parameters"]["prefer_brownian"] = kwargs["prefer_brownian"]

    if kwargs["sampler"] != "ddim_v3":
        json_data["parameters"]["noise_schedule"] = kwargs["noise_schedule"]

    return json_data


def vibe_transfer(**kwargs):
    json_data = text2image(**kwargs)
    json_data["parameters"]["reference_image_multiple"] = kwargs["reference_image_multiple"]
    json_data["parameters"]["reference_information_extracted_multiple"] = kwargs[
        "reference_information_extracted_multiple"
    ]
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
