"""常量与预设数据: 模型列表、分辨率、采样器、提示词预设等。"""

from __future__ import annotations

import os

from utils.config import BASE_DIR, env

VERSION = "2.3.0-alpha.1"

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

# 质量预设 -> 标签文本 (用于前端加载上次时检测/剥离末尾预设标签)
QUALITY_TAGS = {
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
    # 官网 furry-3 的质量预设只有 standard ("{best quality}, {amazing quality}") 与 none (无任何标签)。
    # 原先这里错写成了 "lowres" —— 那是 furry-3 负面 UC "None" 的文本, 被放错了表。
    "nai-diffusion-furry-3": {"Standard": "{best quality}, {amazing quality}", "None": ""},
}


def _list_wildcard_types() -> list[str]:
    """wildcard 分类列表 (导入时求值)。

    目录不存在时返回空列表: 原先直接 os.listdir 会在缺少 ./wildcards 时抛
    FileNotFoundError, 让整个 utils.variable 导入失败、应用起不来
    (main.py 创建该目录的时机在导入之后)。
    """
    try:
        return os.listdir(BASE_DIR / "wildcards")
    except OSError:
        return []


WILDCARD_TYPE = _list_wildcard_types()

CHARACTER_POSITION = [f"{chr(letter)}{number}" for letter in range(ord("A"), ord("F")) for number in range(1, 6)]

CR_MODE = ["character&style", "character", "style"]

BASE_PATH = str(BASE_DIR)

# Variety+ 的基准 sigma (官网 getModelSupportInfo().cfgDelaySigma)。
# v5 系列官网 cfgDelay 为 false (不支持 Variety+, 请求里会直接删掉该字段), 故为 None。
# 注意: 这不是最终发出的值 —— 官网会按分辨率把它乘上一个系数, 见 return_skip_cfg_above_sigma。
_SKIP_CFG_ABOVE_SIGMA_BASE = {
    "nai-diffusion-5-full": None,
    "nai-diffusion-5-curated": None,
    "nai-diffusion-4-5-full": 58,
    "nai-diffusion-4-5-curated": 58,
    "nai-diffusion-4-full": 19,
    "nai-diffusion-4-curated-preview": 19,
    "nai-diffusion-3": 19,
    "nai-diffusion-furry-3": 19,
}

# 分辨率系数的基准: 官网 getSNRMultiplierForResolution 以「4 通道 × 104 × 152 潜空间」为 1.0,
# 即 832 × 1216 (此时发出的值恰好等于基准值)。潜空间边长 = 像素边长 // 8。
_SKIP_CFG_SIGMA_REF_LATENT_AREA = 104 * 152
_SKIP_CFG_SIGMA_LATENT_FACTOR = 8


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


def return_skip_cfg_above_sigma(model, width=None, height=None):
    """Variety+ 实际要发出的 skip_cfg_above_sigma 值。

    官网不是直接发基准值: 请求组装时把基准 sigma 乘以分辨率系数
    getSNRMultiplierForResolution = sqrt(通道数 × 潜宽 × 潜高 / (4 × 104 × 152)),
    再原样发给服务端 (8749 行 3au10t_2otztm.js 与生图 worker 3jtnpze-wyslo.js 两处一致)。

    这是**乘法**而不是除法: 同一组官网参数在 832×1216 上得到 58, 在 1280×1856 上得到
    58 × 1.5324 = 88.88; 反过来把 58 当成"832×1216 上的最终值"再往下除会得到 37.85, 是错的。
    实测依据: 官网早期遗留的一组常量恰好是这套公式在别处的取值 ——
    nai-diffusion-3 的 9.36441710371274 = 19 × sqrt(245760 / 1011712) (256×960),
    furry-3 的 11.84515480302779 = 19 × sqrt(393216 / 1011712) (512×768),
    4-curated-preview 的 16.92517469515569 = 19 × sqrt(802816 / 1011712) (896×896),
    4-5-curated 的 36.158893609242725 = 58 × sqrt(393216 / 1011712) (512×768)。
    另有本站真实出图 (outputs/uploads 里 1280×1856 那张) 的元数据 29.11515597918561 = 19 × 1.5324 佐证。

    v5 系列官网不支持 Variety+ (cfgDelay 为 false), 返回 None, 调用方不应把它塞进请求。
    """
    base = _SKIP_CFG_ABOVE_SIGMA_BASE.get(model)
    if base is None or not width or not height:
        return base
    latent_w = int(width) // _SKIP_CFG_SIGMA_LATENT_FACTOR
    latent_h = int(height) // _SKIP_CFG_SIGMA_LATENT_FACTOR
    if latent_w <= 0 or latent_h <= 0:
        return base
    multiplier = (latent_w * latent_h / _SKIP_CFG_SIGMA_REF_LATENT_AREA) ** 0.5
    return base * multiplier


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


UC_PRESET_TAGS = {
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
        # 官网 UC 预设表里 none 的 prefix 是 "lowres", 但 solveUc 对它走特判分支
        # (`"none" === preset.id ? "" : preset.prefix`), 所以选 None 时实际不追加任何内容。
        # 原先按官网原始表写成了 "lowres", 会凭空多出一条 lowres。
        "None": "",
    },
    "nai-diffusion-furry-3": {
        "Heavy": "nsfw, {{worst quality}}, [displeasing], {unusual pupils}, guide lines, {{unfinished}}, {bad}, url, artist name, {{tall image}}, mosaic, {sketch page}, comic panel, impact (font), [dated], {logo}, ych, {what}, {where is your god now}, {distorted text}, repeated text, {floating head}, {1994}, {widescreen}, absolutely everyone, sequence, {compression artifacts}, hard translated, {cropped}, {commissioner name}, unknown text, high contrast",
        "Light": "nsfw, {worst quality}, guide lines, unfinished, bad, url, tall image, widescreen, compression artifacts, unknown text",
        "None": "",  # 同 nai-diffusion-3: none 的 prefix 被 solveUc 丢弃, 实际不追加内容
    },
}


def return_undesired_contentc_preset(model, undesired_contentc_preset):
    negative_prompts = UC_PRESET_TAGS.get(model, {}).get(undesired_contentc_preset, "")
    if env.remove_nsfw:
        negative_prompts = negative_prompts.replace("nsfw, ", "")
    return negative_prompts


def return_quality_preset_id(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-curated"]:
        return {"Standard": "standard", "Light": "light", "None": "none"}
    return {"Standard": "standard", "None": "none"}


def return_quality_tags(model, quality_tags_preset):
    return QUALITY_TAGS.get(model, {}).get(quality_tags_preset, "")
