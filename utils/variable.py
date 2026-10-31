"""常量与预设数据: 模型列表、分辨率、采样器、提示词预设等。"""

from __future__ import annotations

import os

from utils.config import BASE_DIR, env

VERSION = "2.3.0-alpha.3"

MODELS = [
    "nai-diffusion-5-full",
    "nai-diffusion-5-full-medium",
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

# "Effort: Medium" 属于 V5 Full 同一个模型族 (字段集合完全一致), 质量预设相同
QUALITY_TAGS["nai-diffusion-5-full-medium"] = QUALITY_TAGS["nai-diffusion-5-full"]


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
    "nai-diffusion-5-full-medium": None,
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
    if model in [
        "nai-diffusion-5-full",
        "nai-diffusion-5-full-medium",
        "nai-diffusion-5-curated",
        "nai-diffusion-4-5-full",
    ]:
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

# V5 Full Medium 与 V5 Full 的 UC 预设完全一致
UC_PRESET_TAGS["nai-diffusion-5-full-medium"] = UC_PRESET_TAGS["nai-diffusion-5-full"]

# ---------------------------------------------------------------------------
# 官网 tag_hint_* 三参数 (2026-10-30 抓包 + 打包代码核对)
# ---------------------------------------------------------------------------
# 这三个字段都不是新的生成参数, 而是把 UI 里已选好的「质量预设 / UC 预设 / 透明背景」
# 按官网内部数字码回显进请求体, 供服务端写进图片元数据、也供官网再次导入时还原面板。
TAG_HINT_CODES = {
    "none": 0,
    "standard": 1,
    "heavy": 2,
    "light": 3,
    "humanFocus": 4,
    "furryFocus": 5,
    "lowQualityPlusBadAnatomy": 6,
    "lowQuality": 7,
    "badAnatomy": 8,
}

# 反查表 (法术解析读元数据时用): 数字码 -> 预设 id
TAG_HINT_PRESET_IDS = {code: preset for preset, code in TAG_HINT_CODES.items()}

# 官网 getModelSupportInfo().transparency 为 true 的模型。只有它们会发
# tag_hint_transparent_background 与 straight_alpha; 其余模型官网会把这两个字段直接删掉。
TRANSPARENCY_MODELS = {
    "nai-diffusion-5-full",
    "nai-diffusion-5-full-inpainting",
    "nai-diffusion-5-full-medium",
    "nai-diffusion-5-full-medium-inpainting",
    "nai-diffusion-5-curated",
    "nai-diffusion-5-curated-inpainting",
    "custom",
}


def return_tag_hint_code(preset_id):
    """预设 id -> 官网 tag_hint 数字码; 未知 id 返回 None (调用方不应写该字段)。"""
    return TAG_HINT_CODES.get(preset_id)


def model_supports_transparency(model):
    """该模型是否支持透明背景 (官网 transparency 能力位)。"""
    return model in TRANSPARENCY_MODELS


# ---------------------------------------------------------------------------
# Source -> 模型 (官网 functionGetModelFromSourceString 的哈希表, 2026-10 打包代码)
# ---------------------------------------------------------------------------
# 同一个版本会因训练快照不同写出**多个** Source 哈希 (V5 Full 有 2 个、V4.5 Full 有 5 个),
# 所以只能逐字精确匹配。未收录 / 没有 Source 的老图一律返回 None: 项目不猜, 保持当前模型。
SOURCE_MODEL_MAP = {
    # V5
    "NovelAI Diffusion V5 657484A5": "nai-diffusion-5-full",
    "NovelAI Diffusion V5 0ADF9AB7": "nai-diffusion-5-full",
    "NovelAI Diffusion V5 93F4BD30": "nai-diffusion-5-full-medium",
    "NovelAI Diffusion V5 70AB5786": "nai-diffusion-5-full-medium",
    "NovelAI Diffusion V5 DB276663": "nai-diffusion-5-curated",
    # V4.5
    "DiffusionModelMetaName.NAIv4next 4BDE2A90": "nai-diffusion-4-5-full",
    "NovelAI Diffusion V4.5 4BDE2A90": "nai-diffusion-4-5-full",
    "NovelAI Diffusion V4.5 1229B44F": "nai-diffusion-4-5-full",
    "NovelAI Diffusion V4.5 B9F340FD": "nai-diffusion-4-5-full",
    "NovelAI Diffusion V4.5 F3D95188": "nai-diffusion-4-5-full",
    "DiffusionModelMetaName.NAIv4next C02D4F98": "nai-diffusion-4-5-curated",
    "NovelAI Diffusion V4.5 C02D4F98": "nai-diffusion-4-5-curated",
    "NovelAI Diffusion V4.5 5AB81C7C": "nai-diffusion-4-5-curated",
    "NovelAI Diffusion V4.5 B5A2A797": "nai-diffusion-4-5-curated",
    "NovelAI Diffusion V4 5AB81C7C": "nai-diffusion-4-5-curated",
    "NovelAI Diffusion V4 B5A2A797": "nai-diffusion-4-5-curated",
    # V4
    "NovelAI Diffusion V4 37442FCA": "nai-diffusion-4-full",
    "NovelAI Diffusion V4 4F49EC75": "nai-diffusion-4-full",
    "NovelAI Diffusion V4 CA4B7203": "nai-diffusion-4-full",
    "NovelAI Diffusion V4 79F47848": "nai-diffusion-4-full",
    "NovelAI Diffusion V4 F6302A9D": "nai-diffusion-4-full",
    "NovelAI Diffusion V4 7ABFFA2A": "nai-diffusion-4-curated-preview",
    "NovelAI Diffusion V4 C1CCBA86": "nai-diffusion-4-curated-preview",
    "NovelAI Diffusion V4 770A9E12": "nai-diffusion-4-curated-preview",
    # V3 (SDXL 系)
    "Stable Diffusion XL B0BDF6C1": "nai-diffusion-3",
    "Stable Diffusion XL C1E1DE52": "nai-diffusion-3",
    "Stable Diffusion XL 7BCCAA2C": "nai-diffusion-3",
    "Stable Diffusion XL 1120E6A9": "nai-diffusion-3",
    "Stable Diffusion XL 8BA2AF87": "nai-diffusion-3",
    "Stable Diffusion XL 4BE8C60C": "nai-diffusion-furry-3",
    "Stable Diffusion XL C8704949": "nai-diffusion-furry-3",
    "Stable Diffusion XL 37C2B166": "nai-diffusion-furry-3",
    "Stable Diffusion XL F306816B": "nai-diffusion-furry-3",
    "Stable Diffusion XL 9CC2F394": "nai-diffusion-furry-3",
}


def return_model_from_source(source) -> str | None:
    """按官网 Source 哈希表识别模型; 未收录 / 无 Source 返回 None。"""
    if not source:
        return None
    return SOURCE_MODEL_MAP.get(str(source).strip())


def return_undesired_contentc_preset(model, undesired_contentc_preset):
    negative_prompts = UC_PRESET_TAGS.get(model, {}).get(undesired_contentc_preset, "")
    if env.remove_nsfw:
        negative_prompts = negative_prompts.replace("nsfw, ", "")
    return negative_prompts


def return_quality_preset_id(model):
    if model in ["nai-diffusion-5-full", "nai-diffusion-5-full-medium", "nai-diffusion-5-curated"]:
        return {"Standard": "standard", "Light": "light", "None": "none"}
    return {"Standard": "standard", "None": "none"}


def return_quality_tags(model, quality_tags_preset):
    return QUALITY_TAGS.get(model, {}).get(quality_tags_preset, "")
