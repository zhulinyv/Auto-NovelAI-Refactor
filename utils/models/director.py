def remove_bg(**kwargs):
    return {
        "req_type": "bg-removal",
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def line_art(**kwargs):
    return {
        "req_type": "lineart",
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def sketch(**kwargs):
    return {
        "req_type": "sketch",
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def colorize(**kwargs):
    return {
        "req_type": "colorize",
        "prompt": kwargs["prompt"],
        "defry": kwargs["defry"],
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def emotion(**kwargs):
    return {
        "req_type": "emotion",
        "prompt": kwargs["prompt"],
        "defry": kwargs["defry"],
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def declutter(**kwargs):
    return {
        "req_type": "declutter",
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }
