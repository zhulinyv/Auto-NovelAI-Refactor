import base64
from io import BytesIO

import numpy as np
from PIL import Image

from utils import return_x64


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
