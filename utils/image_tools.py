import base64
from io import BytesIO

from PIL import Image


def image_to_base64(image_path):
    with Image.open(image_path) as file:
        buffer = BytesIO()
        file.save(buffer, format="PNG")
        img_base64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        buffer.close()
    return img_base64
