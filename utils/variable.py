"""常量与预设数据: 模型列表、分辨率、采样器、提示词预设等。"""

from __future__ import annotations

import os

from utils.config import BASE_DIR, env

VERSION = "2.0.3"

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

WILDCARD_TYPE = os.listdir(BASE_DIR / "wildcards")

CHARACTER_POSITION = [f"{chr(letter)}{number}" for letter in range(ord("A"), ord("F")) for number in range(1, 6)]

CR_MODE = ["character&style", "character", "style"]

BASE_PATH = str(BASE_DIR)

_SKIP_CFG_ABOVE_SIGMA = {
    "nai-diffusion-5-full": None,
    "nai-diffusion-5-curated": None,
    "nai-diffusion-4-5-full": 58,
    "nai-diffusion-4-5-curated": 58,
    "nai-diffusion-4-full": 19,
    "nai-diffusion-4-curated-preview": 16.92517469515569,
    "nai-diffusion-3": 9.36441710371274,
    "nai-diffusion-furry-3": 11.84515480302779,
}


def get_proxies():
    """根据当前配置实时返回代理字典 (设置修改后立即生效)。"""
    if env.proxy:
        return {"http": env.proxy, "https": env.proxy}
    return None


def refresh_proxies() -> None:
    """更新全局 proxies (供旧代码兼容)。"""
    global proxies
    proxies = get_proxies()


proxies = get_proxies()


def return_skip_cfg_above_sigma(model):
    return _SKIP_CFG_ABOVE_SIGMA.get(model)


def return_uc_preset_id(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated", "nai-diffusion-4-5-full"]:
        return {
            "Heavy": "heavy",
            "Light": "light",
            "Furry Focus": "furryFocus",
            "Human Focus": "humanFocus",
            "None": "none",
        }
    if model in ["nai-diffusion-3", "nai-diffusion-4-5-curated"]:
        return {"Heavy": "heavy", "Light": "light", "Human Focus": "humanFocus", "None": "none"}
    return {"Heavy": "heavy", "Light": "light", "None": "none"}


def return_undesired_contentc_preset(model, undesired_contentc_preset):
    presets = {
        "nai-diffusion-5-full": {
            "Heavy": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "nsfw, lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::",
            "Furry Focus": "nsfw, {worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
            "Human Focus": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
            "None": "",
        },
        "nai-diffusion-5-curated": {
            "Heavy": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::",
            "Furry Focus": "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
            "Human Focus": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
            "None": "",
        },
        "nai-diffusion-4-5-full": {
            "Heavy": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
            "Furry Focus": "nsfw, {worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
            "Human Focus": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
            "None": "",
        },
        "nai-diffusion-4-5-curated": {
            "Heavy": "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page",
            "Light": "blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page",
            "Human Focus": "blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page",
            "None": "",
        },
        "nai-diffusion-4-full": {
            "Heavy": "nsfw, blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page",
            "Light": "nsfw, blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page",
            "None": "",
        },
        "nai-diffusion-4-curated-preview": {
            "Heavy": "blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page",
            "Light": "blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page",
            "None": "",
        },
        "nai-diffusion-3": {
            "Heavy": "nsfw, lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]",
            "Light": "nsfw, lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing",
            "Human Focus": "nsfw, lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract], bad anatomy, bad hands, @_@, mismatched pupils, heart-shaped pupils, glowing eyes",
            "None": "lowres",
        },
        "nai-diffusion-furry-3": {
            "Heavy": "nsfw, {{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast",
            "Light": "nsfw, {worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text",
            "None": "",
        },
    }
    negative_prompts = presets.get(model, {}).get(undesired_contentc_preset, "")
    if env.remove_nsfw:
        negative_prompts = negative_prompts.replace("nsfw, ", "")
    return negative_prompts


def return_quality_preset_id(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated"]:
        return {"Standard": "standard", "Light": "light", "None": "none"}
    return {"Standard": "standard", "None": "none"}


def return_quality_tags(model, quality_tags_preset):
    presets = {
        "nai-diffusion-5-full": {
            "Standard": "very aesthetic, masterpiece, no text",
            "Light": "very aesthetic, amazing quality, no text",
            "None": "",
        },
        "nai-diffusion-5-curated": {
            "Standard": "very aesthetic, masterpiece, no text",
            "Light": "very aesthetic, amazing quality, no text",
            "None": "",
        },
        "nai-diffusion-4-5-full": {"Standard": "very aesthetic, masterpiece, no text", "None": ""},
        "nai-diffusion-4-5-curated": {
            "Standard": "very aesthetic, masterpiece, no text, -0.8::feet::, rating:general",
            "None": "",
        },
        "nai-diffusion-4-full": {"Standard": "no text, best quality, very aesthetic, absurdres", "None": ""},
        "nai-diffusion-4-curated-preview": {
            "Standard": "rating:general, best quality, very aesthetic, absurdres",
            "None": "",
        },
        "nai-diffusion-3": {"Standard": "best quality, amazing quality, very aesthetic, absurdres", "None": ""},
        "nai-diffusion-furry-3": {"Standard": "{best quality}, {amazing quality}", "None": "lowres"},
    }
    return presets.get(model, {}).get(quality_tags_preset, "")
