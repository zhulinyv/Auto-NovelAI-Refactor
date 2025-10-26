def remove_bg(**kwargs):
    return {
        "req_type": "bg-removal",
        "use_new_shared_trial": True,
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def line_art(**kwargs):
    return {
        "req_type": "lineart",
        "use_new_shared_trial": True,
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def sketch(**kwargs):
    return {
        "req_type": "sketch",
        "use_new_shared_trial": True,
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def colorize(**kwargs):
    return {
        "req_type": "colorize",
        "use_new_shared_trial": True,
        "prompt": kwargs["prompt"],
        "defry": kwargs["defry"],
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def emotion(**kwargs):
    return {
        "req_type": "emotion",
        "use_new_shared_trial": True,
        "prompt": kwargs["prompt"],
        "defry": kwargs["defry"],
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }


def declutter(**kwargs):
    return {
        "req_type": "declutter",
        "use_new_shared_trial": True,
        "width": kwargs["width"],
        "height": kwargs["height"],
        "image": kwargs["image"],
    }
