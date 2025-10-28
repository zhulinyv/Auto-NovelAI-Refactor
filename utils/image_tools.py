import base64
from io import BytesIO

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from utils import return_x64
from utils.naimeta import extract_data


def image_to_base64(image_path):
    with Image.open(image_path) as file:
        buffer = BytesIO()
        file.save(buffer, format="PNG")
        img_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        buffer.close()
    return img_base64


def process_image_by_orientation(image_path):
    with Image.open(image_path) as img:
        if img.mode != "RGB":
            img = img.convert("RGB")

        width, height = img.size

        if width > height:
            aspect_ratio = width / height
            target_aspect = 1536 / 1024
            if aspect_ratio > target_aspect:
                new_width = 1536
                new_height = int(height * (1536 / width))
                resized_img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                final_img = Image.new("RGB", (1536, 1024), (0, 0, 0))
                y_offset = (1024 - new_height) // 2
                final_img.paste(resized_img, (0, y_offset))
            else:
                new_height = 1024
                new_width = int(width * (1024 / height))
                resized_img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                final_img = Image.new("RGB", (1536, 1024), (0, 0, 0))
                x_offset = (1536 - new_width) // 2
                final_img.paste(resized_img, (x_offset, 0))

        elif height > width:
            aspect_ratio = width / height
            target_aspect = 1024 / 1536
            if aspect_ratio > target_aspect:
                new_width = 1024
                new_height = int(height * (1024 / width))
                resized_img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                final_img = Image.new("RGB", (1024, 1536), (0, 0, 0))
                y_offset = (1536 - new_height) // 2
                final_img.paste(resized_img, (0, y_offset))
            else:
                new_height = 1536
                new_width = int(width * (1536 / height))
                resized_img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
                final_img = Image.new("RGB", (1024, 1536), (0, 0, 0))
                x_offset = (1024 - new_width) // 2
                final_img.paste(resized_img, (x_offset, 0))

        else:
            final_img = img.resize((1472, 1472), Image.Resampling.LANCZOS)

        return final_img


def change_the_mask_color(image_path):
    with Image.open(image_path) as image:
        image_array = image.load()
        width, height = image.size
        for x in range(0, width):
            for y in range(0, height):
                rgba = image_array[x, y]
                r, g, b, a = rgba
                if a != 0:
                    image_array[x, y] = (255, 255, 255)
                elif a == 0:
                    image_array[x, y] = (0, 0, 0)
        image.save(image_path)
        return image_path


def is_fully_transparent(image_path):
    img = Image.open(image_path).convert("RGBA")
    img_array = np.array(img)
    alpha_channel = img_array[:, :, 3]
    return np.all(alpha_channel == 0)


def resize_image(image_path):
    with Image.open(image_path) as image:
        w, h = image.size
        new_size = (return_x64(w), return_x64(h))
        image = image.resize(new_size, Image.Resampling.LANCZOS)
        image.save(image_path)
    return image_path


def process_white_regions(image_path, output_path):
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

    grid_height = height // 8
    grid_width = width // 8

    white_grids = np.zeros((grid_height, grid_width), dtype=bool)

    for i in range(grid_height):
        for j in range(grid_width):
            grid_section = binary[i * 8 : (i + 1) * 8, j * 8 : (j + 1) * 8]
            if np.any(grid_section > 0):
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
                region = bfs(i, j)
                regions.append(region)

    result_array = binary.copy()

    for region_idx, region in enumerate(regions):
        region_i = [pos[0] for pos in region]
        region_j = [pos[1] for pos in region]

        min_i, max_i = min(region_i), max(region_i)
        min_j, max_j = min(region_j), max(region_j)

        top_distance = min_i
        bottom_distance = grid_height - 1 - max_i
        left_distance = min_j
        right_distance = grid_width - 1 - max_j

        target_top = (top_distance // 8) * 8
        target_bottom = (bottom_distance // 8) * 8
        target_left = (left_distance // 8) * 8
        target_right = (right_distance // 8) * 8

        expanded_min_i = max(0, min_i - (top_distance - target_top))
        expanded_max_i = min(grid_height - 1, max_i + (bottom_distance - target_bottom))
        expanded_min_j = max(0, min_j - (left_distance - target_left))
        expanded_max_j = min(grid_width - 1, max_j + (right_distance - target_right))

        brush_size_grid = 4
        brush_half = brush_size_grid // 2

        for center_i in range(expanded_min_i, expanded_max_i + 1):
            for center_j in range(expanded_min_j, expanded_max_j + 1):
                brush_start_i = max(0, center_i - brush_half)
                brush_end_i = min(grid_height, center_i + brush_half)
                brush_start_j = max(0, center_j - brush_half)
                brush_end_j = min(grid_width, center_j + brush_half)

                current_pos_in_original = any(
                    brush_start_i <= pos[0] < brush_end_i and brush_start_j <= pos[1] < brush_end_j for pos in region
                )

                if current_pos_in_original:
                    for gi in range(brush_start_i, brush_end_i):
                        for gj in range(brush_start_j, brush_end_j):
                            result_array[gi * 8 : (gi + 1) * 8, gj * 8 : (gj + 1) * 8] = 255

    result_img = Image.fromarray(result_array)
    result_img.save(output_path)

    return output_path


def get_image_information(image_path):
    with Image.open(image_path) as image:
        try:
            pnginfo = extract_data(image)
        except Exception:
            pnginfo = image.info
    return pnginfo


def revert_image_info(image_path1, image_path2):
    try:
        _pnginfo = get_image_information(image_path1)
        metadata = PngInfo()
        for k, v in _pnginfo.items():
            metadata.add_text(k, v)
        with Image.open(image_path2) as image2:
            image2.save(image_path2, pnginfo=metadata)
        return True
    except Exception():
        return False
