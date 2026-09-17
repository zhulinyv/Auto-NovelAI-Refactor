"""图片处理工具: base64、尺寸、元数据读取等。"""

from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import ujson
import numpy as np
from PIL import Image, ExifTags
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
    """把遮罩转为白色前景 / 黑色背景。"""
    with Image.open(image_path) as image:
        image = image.convert("RGBA")
        pixels = image.load()
        width, height = image.size
        for x in range(width):
            for y in range(height):
                r, g, b, a = pixels[x, y]
                pixels[x, y] = (255, 255, 255, 255) if a != 0 else (0, 0, 0, 255)
        image.save(image_path)
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


def process_white_regions(image_path, output_path):
    """把遮罩的白色区域按 8x8 网格扩张, 使遮罩更贴合被绘制区域。"""
    img = Image.open(image_path)
    img_array = np.array(img)
    height, width = img_array.shape[:2]
    if height % 64 != 0 or width % 64 != 0:
        raise ValueError("图片尺寸必须是64的倍数")

    if len(img_array.shape) == 3:
        gray = np.mean(img_array, axis=2)
        binary = (gray > 128).astype(np.uint8) * 255
    else:
        binary = (img_array > 128).astype(np.uint8) * 255

    grid_height, grid_width = height // 8, width // 8
    white_grids = np.zeros((grid_height, grid_width), dtype=bool)
    for i in range(grid_height):
        for j in range(grid_width):
            if np.any(binary[i * 8 : (i + 1) * 8, j * 8 : (j + 1) * 8] > 0):
                white_grids[i, j] = True

    visited = np.zeros_like(white_grids, dtype=bool)
    regions = []

    def bfs(start_i, start_j):
        region = []
        queue = [(start_i, start_j)]
        visited[start_i, start_j] = True
        while queue:
            i, j = queue.pop(0)
            region.append((i, j))
            for di, dj in [(0, 1), (1, 0), (0, -1), (-1, 0)]:
                ni, nj = i + di, j + dj
                if 0 <= ni < grid_height and 0 <= nj < grid_width and white_grids[ni, nj] and not visited[ni, nj]:
                    visited[ni, nj] = True
                    queue.append((ni, nj))
        return region

    for i in range(grid_height):
        for j in range(grid_width):
            if white_grids[i, j] and not visited[i, j]:
                regions.append(bfs(i, j))

    result = binary.copy()
    brush_half = 2
    for region in regions:
        region_i = [pos[0] for pos in region]
        region_j = [pos[1] for pos in region]
        min_i, max_i = min(region_i), max(region_i)
        min_j, max_j = min(region_j), max(region_j)
        top_distance, bottom_distance = min_i, grid_height - 1 - max_i
        left_distance, right_distance = min_j, grid_width - 1 - max_j
        expanded_min_i = max(0, min_i - (top_distance - (top_distance // 8) * 8))
        expanded_max_i = min(grid_height - 1, max_i + (bottom_distance - (bottom_distance // 8) * 8))
        expanded_min_j = max(0, min_j - (left_distance - (left_distance // 8) * 8))
        expanded_max_j = min(grid_width - 1, max_j + (right_distance - (right_distance // 8) * 8))
        for ci in range(expanded_min_i, expanded_max_i + 1):
            for cj in range(expanded_min_j, expanded_max_j + 1):
                s_i, e_i = max(0, ci - brush_half), min(grid_height, ci + brush_half)
                s_j, e_j = max(0, cj - brush_half), min(grid_width, cj + brush_half)
                if any(s_i <= pos[0] < e_i and s_j <= pos[1] < e_j for pos in region):
                    result[s_i * 8 : e_i * 8, s_j * 8 : e_j * 8] = 255

    Image.fromarray(result).save(output_path)
    return output_path


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
