import os

MODELS = [
    "nai-diffusion-4-5-full",
    "nai-diffusion-4-5-curated",
    "nai-diffusion-4-full",
    "nai-diffusion-4-curated-preview",
    "nai-diffusion-3",
    "nai-diffusion-furry-3",
]

RESOLUTION = [
    "832x1216",
    "1216x832",
    "1024x1024",
    "1024x1536",
    "1536x1024",
    "1472x1472",
    "1088x1920",
    "1920x1088",
    "512x768",
    "768x768",
    "640x640",
]

SAMPLER = [
    "k_euler",
    "k_euler_ancestral",
    "k_dpmpp_2s_ancestral",
    "k_dpmpp_2m",
    "k_dpmpp_sde",
    "k_dpmpp_2m_sde",
    "ddim_v3",
]

NOISE_SCHEDULE = ["native", "karras", "exponential", "polyexponential"]

UC_PRESET = ["Heavy", "Light", "Furry Focus", "Human Focus", "None"]

WILDCARD_TYPE = os.listdir("./wildcards")

CHARACTER_POSITION = [f"{chr(letter)}{number}" for letter in range(ord("A"), ord("F")) for number in range(1, 6)]


def return_skip_cfg_above_sigma(model):
    if model == "nai-diffusion-4-5-full":
        value = 58
    elif model == "nai-diffusion-4-5-curated":
        value = 36.158893609242725
    elif model in ["nai-diffusion-3", "nai-diffusion-furry-3", "nai-diffusion-4-curated-preview"]:
        value = 11.84515480302779
    elif model == "nai-diffusion-4-full":
        value = 18.254609533779934
    return value


def return_uc_preset_data(model):
    if model == "nai-diffusion-4-5-full":
        uc_preset_data = {
            "Heavy": 0,
            "Light": 1,
            "Furry Focus": 2,
            "Human Focus": 3,
            "None": 4,
        }
    elif model in ["nai-diffusion-3", "nai-diffusion-4-5-curated"]:
        uc_preset_data = {"Heavy": 0, "Light": 1, "Human Focus": 2, "None": 3}
    elif model in ["nai-diffusion-furry-3", "nai-diffusion-4-curated-preview", "nai-diffusion-4-full"]:
        uc_preset_data = {"Heavy": 0, "Light": 1, "None": 2}
    return uc_preset_data


def return_quality_tags(model):
    quality_tags = {
        "nai-diffusion-4-5-full": ", very aesthetic, masterpiece, no text",
        "nai-diffusion-4-5-curated": ", very aesthetic, masterpiece, no text, -0.8::feet::, rating:general",
        "nai-diffusion-4-full": ", no text, best quality, very aesthetic, absurdres",
        "nai-diffusion-4-curated-preview": ", rating:general, best quality, very aesthetic, absurdres",
        "nai-diffusion-3": ", best quality, amazing quality, very aesthetic, absurdres",
        "nai-diffusion-furry-3": ", {best quality}, {amazing quality}",
    }
    return quality_tags.get(model, "")


def return_undesired_contentc_preset(model, undesired_contentc_preset):
    presets = {
        "nai-diffusion-4-5-full": {
            "Heavy": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
            "Furry Focus": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
            "Human Focus": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
            "None": "",
        },
        "nai-diffusion-4-5-curated": {
            "Heavy": "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page",
            "Human Focus": "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page",
            "None": "",
        },
        "nai-diffusion-4-full": {
            "Heavy": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page",
            "Light": "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page",
            "None": "",
        },
        "nai-diffusion-4-curated-preview": {
            "Heavy": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page",
            "Light": "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page",
            "None": "",
        },
        "nai-diffusion-3": {
            "Heavy": "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]",
            "Light": "lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing",
            "Human Focus": "lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes",
            "None": "lowres",
        },
        "nai-diffusion-furry-3": {
            "Heavy": "{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast",
            "Light": "{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text",
            "None": "lowres",
        },
    }
    return presets.get(model, {}).get(undesired_contentc_preset, "")
