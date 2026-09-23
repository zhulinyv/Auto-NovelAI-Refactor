"""图片处理工具: base64、尺寸、元数据读取等。"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import numpy as np
import ujson
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from utils.helpers import return_x64
from utils.naimeta import extract_data


def image_to_base64(image_path) -> str:
    with Image.open(image_path) as f:
        buffer = BytesIO()
        f.save(buffer, format="PNG")
        img_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return img_base64


def process_image_by_orientation(image_path):
    """按方向处理角色参考图: 统一缩放到 1536x1024 或 1024x1536 并居中黑底。"""
    with Image.open(image_path) as img:
        if img.mode != "RGB":
            img = img.convert("RGB")
        width, height = img.size
        if width > height:
            target_w, target_h = 1536, 1024
        elif height > width:
            target_w, target_h = 1024, 1536
        else:
            return img.resize((1472, 1472), Image.Resampling.LANCZOS)
        aspect = width / height
        target_aspect = target_w / target_h
        if aspect > target_aspect:
            new_w = target_w
            new_h = int(height * (target_w / width))
        else:
            new_h = target_h
            new_w = int(width * (target_h / height))
        resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        final = Image.new("RGB", (target_w, target_h), (0, 0, 0))
        final.paste(resized, ((target_w - new_w) // 2, (target_h - new_h) // 2))
        return final


def change_the_mask_color(image_path):
    """把遮罩转为白色前景 / 黑色背景 (唯一的蒙版后处理, 所见即所得)。

    前端画布本身就是 8x8 网格上的二值蒙版 (绘制过的格子 alpha=255, 其余 alpha=0),
    所以这里只做一次颜色映射, 不改变几何形状:
        alpha != 0  ->  (255, 255, 255, 255)   白色 = 交给 AI 重绘
        alpha == 0  ->  (0, 0, 0, 255)        黑色 = 保持原图不变

    用 numpy 向量化: 蒙版是整图尺寸 (最大 1536x2048), 逐像素 Python 循环太慢。
    """
    with Image.open(image_path) as image:
        arr = np.array(image.convert("RGBA"))
        # 用 alpha 通道做二值判定: 非零 -> 白, 零 -> 黑; 三个颜色通道取同一结果
        fg = (arr[:, :, 3] != 0)[:, :, None]
        out = np.where(fg, np.uint8(255), np.uint8(0))
        rgb = np.repeat(out, 3, axis=2)
        alpha = np.full(arr.shape[:2] + (1,), 255, dtype=np.uint8)
        Image.fromarray(np.concatenate([rgb, alpha], axis=2)).save(image_path)
    return image_path


def is_fully_transparent(image_path) -> bool:
    img = Image.open(image_path).convert("RGBA")
    alpha = np.array(img)[:, :, 3]
    return bool(np.all(alpha == 0))


def resize_image(image_path, output_path=None):
    with Image.open(image_path) as image:
        w, h = image.size
        nw, nh = return_x64(w), return_x64(h)
        if nw > w and nh < h:
            nw = nw - 64 if nw > 64 else nw
        if nw < w and nh > h:
            nh = nh - 64 if nh > 64 else nh
        image = image.resize((nw, nh), Image.Resampling.LANCZOS)
        image.save(output_path or image_path)
    return output_path or image_path


def ensure_mask_grid(image_path) -> str:
    """校验蒙版尺寸是 64 的倍数 (8x8 网格的前提), 原样返回路径。

    历史上这里调用过 process_white_regions: 把白色区域按 8x8 网格做连通域扩张,
    边界会被"鼓"到网格线上 —— 前端画的圆形/不规则笔迹经过它之后形状会变, 做不到所见即所得。
    现在前端画笔本身就吸附在 8x8 网格上 (见 web/js/maskGrid.js 的 strokeCells),
    蒙版与最终送进模型的内容逐格一致, 所以扩张这一步已经取消, 只保留尺寸校验。
    """
    with Image.open(image_path) as image:
        width, height = image.size
    if width % 64 != 0 or height % 64 != 0:
        raise ValueError(f"蒙版尺寸必须是 64 的倍数, 当前为 {width}x{height}")
    return image_path


def _extract_exif_metadata(image):
    # 从 webp/jpeg 等格式的 EXIF 块读取 NovelAI 元数据。
    # NAI 新版导出 (如 webp) 把参数写入 EXIF 而非 PNG 的 LSB:
    #   ImageDescription (270) -> Description
    #   Software (305)         -> Software (含模型哈希)
    #   DocumentName (269)     -> Source/Title
    #   UserComment (37510)    -> 一个 JSON 包装串 {"Comment": "<真实参数 JSON 串>", "Description":..., "Software":..., "Source":...}
    #      其中的内层 "Comment" 才是法术解析需要的真实参数 JSON; 若顶层字段缺失则回退用包装串里的同名项。
    # 任何一项缺失即视为不含 NAI 元数据 (返回 None)。
    try:
        exif = image.getexif()
    except Exception:
        return None
    if not exif:
        return None
    # EXIF 标签整数 ID: ImageDescription=270, Software=305, DocumentName=269
    # UserComment (37510, 含 Comment JSON) 在 Exif 子 IFD (0x8769) 中
    desc = exif.get(270)
    software = exif.get(305)
    source = exif.get(269)
    comment_raw = None
    try:
        for _tag, _val in exif.get_ifd(0x8769).items():
            if _tag == 37510:
                comment_raw = _val
                break
    except Exception:
        comment_raw = None

    comment = None
    if isinstance(comment_raw, (bytes, bytearray)):
        cb = bytes(comment_raw)
        if cb.startswith(b"ASCII"):
            cb = cb.split(b"ASCII", 1)[1].lstrip(b"\x00")
        comment = cb.decode("utf-8", "replace")
    elif isinstance(comment_raw, str):
        comment = comment_raw

    if not comment and desc is None and software is None:
        return None

    # 解析 EXIF UserComment 包装串, 取出内层真实参数 JSON
    inner_comment = None
    try:
        parsed = ujson.loads(comment)
        if isinstance(parsed, dict):
            if "Comment" in parsed and isinstance(parsed["Comment"], str):
                inner_comment = parsed["Comment"]
            # 顶层字段缺失时, 用包装串里的同名项补
            if desc is None and parsed.get("Description"):
                desc = parsed["Description"]
            if software is None and parsed.get("Software"):
                software = parsed["Software"]
            if source is None and parsed.get("Source"):
                source = parsed["Source"]
    except Exception:
        inner_comment = comment

    return {
        "Description": desc.decode("utf-8", "replace") if isinstance(desc, bytes) else desc,
        "Software": software.decode("utf-8", "replace") if isinstance(software, bytes) else software,
        "Source": source.decode("utf-8", "replace") if isinstance(source, bytes) else source,
        # 返回内层真实参数 JSON 串, 供 _parse_comment 继续解析
        "Comment": inner_comment if inner_comment is not None else comment,
    }


def get_image_information(image):
    """读取图片的全部元数据 (优先解析 NovelAI 的 LSB 隐藏数据, 其次 EXIF)。"""
    if isinstance(image, (str, Path)):
        with Image.open(image) as opened_image:
            return get_image_information(opened_image)
    # PNG 走 LSB 隐写; webp/jpeg 等可能把参数写在 EXIF 块
    if image.format != "PNG":
        exif_meta = _extract_exif_metadata(image)
        if exif_meta is not None:
            return exif_meta
    try:
        pnginfo = extract_data(image)
    except Exception:
        pnginfo = None
    # 兜底返回 image.info, 但剔除不可 JSON 序列化的 bytes (避免接口 500)
    if pnginfo is None:
        pnginfo = {k: v for k, v in image.info.items() if not isinstance(v, (bytes, bytearray))}
    return pnginfo


def revert_image_info(image_path1, image_path2) -> bool:
    """把 image_path1 的元数据写回 image_path2。"""
    try:
        with Image.open(image_path1) as image:
            pnginfo = get_image_information(image)
        metadata = PngInfo()
        for k, v in pnginfo.items():
            metadata.add_text(k, v)
        with Image.open(image_path2) as image2:
            image2.save(image_path2, pnginfo=metadata)
        return True
    except Exception:
        return False


def is_pure_white(image: Image.Image) -> bool:
    if image.mode != "RGB":
        image = image.convert("RGB")
    extrema = image.getextrema()
    return all(min_val == 255 and max_val == 255 for min_val, max_val in extrema)
