import base64


def image_to_base64(image):
    with open(image, "rb") as file:
        img_base64 = base64.b64encode(file.read()).decode("utf-8")
    return img_base64
