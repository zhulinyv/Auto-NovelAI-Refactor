import os

from utils.environment import env

VERSION = "1.7.2.preview2"

MODELS = [
    "nai-diffusion-5-full",
    "nai-diffusion-5-curated",
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

QP_PRESET = ["Standard", "Light", "None"]

WILDCARD_TYPE = os.listdir("./wildcards")

CHARACTER_POSITION = [f"{chr(letter)}{number}" for letter in range(ord("A"), ord("F")) for number in range(1, 6)]

CR_MODE = ["character&style", "character", "style"]

BASE_PATH = os.getcwd()


if env.proxy:
    proxies = {
        "http": env.proxy,
        "https": env.proxy,
    }
else:
    proxies = None


def return_skip_cfg_above_sigma(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated"]:
        value = None
    elif model == "nai-diffusion-4-5-full":
        value = 58
    elif model == "nai-diffusion-4-5-curated":
        value = 36.158893609242725
    elif model in ["nai-diffusion-4-full"]:
        value = 19
    elif model in ["nai-diffusion-3"]:
        value = 19.343056794463642
    elif model in ["nai-diffusion-furry-3", "nai-diffusion-4-curated-preview"]:
        value = 11.84515480302779
    return value


def return_uc_preset_id(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated", "nai-diffusion-4-5-full"]:
        uc_preset_data = {
            "Heavy": "heavy",
            "Light": "light",
            "Furry Focus": "furryFocus",
            "Human Focus": "humanFocus",
            "None": "none",
        }
    elif model in ["nai-diffusion-3", "nai-diffusion-4-5-curated"]:
        uc_preset_data = {"Heavy": "heavy", "Light": "light", "Human Focus": "humanFocus", "None": "none"}
    elif model in ["nai-diffusion-furry-3", "nai-diffusion-4-curated-preview", "nai-diffusion-4-full"]:
        uc_preset_data = {"Heavy": "heavy", "Light": "light", "None": "none"}
    return uc_preset_data


def return_undesired_contentc_preset(model, undesired_contentc_preset):
    presets = {
        "nai-diffusion-5-full": {
            "Heavy": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
            "Furry Focus": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
            "Human Focus": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "None": "",
        },
        "nai-diffusion-5-curated": {
            "Heavy": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
            "Furry Focus": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
            "Human Focus": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "None": "",
        },
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
            "None": "",
        },
        "nai-diffusion-furry-3": {
            "Heavy": "{{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast",
            "Light": "{worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text",
            "None": "",
        },
    }
    return presets.get(model, {}).get(undesired_contentc_preset, "")


def return_quality_preset_id(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated"]:
        quality_preset_data = {
            "Standard": "standard",
            "Light": "light",
            "None": "none",
        }
    else:
        quality_preset_data = {"Standard": "standard", "None": "none"}
    return quality_preset_data


def return_quality_tags(model, quality_tags_preset):
    presets = {
        "nai-diffusion-5-full": {
            "Standard": "",
            "Light": "",
            "None": "",
        },
        "nai-diffusion-5-curated": {
            "Standard": "",
            "Light": "",
            "None": "",
        },
        "nai-diffusion-4-5-full": {
            "Standard": "",
            "None": "",
        },
        "nai-diffusion-4-5-curated": {
            "Standard": "",
            "None": "",
        },
        "nai-diffusion-4-full": {
            "Standard": "",
            "None": "",
        },
        "nai-diffusion-4-curated-preview": {
            "Standard": "",
            "None": "",
        },
        "nai-diffusion-3": {
            "Standard": "",
            "None": "",
        },
        "nai-diffusion-furry-3": {
            "Standard": "",
            "None": "",
        },
    }
    return presets.get(model, {}).get(quality_tags_preset, "")
