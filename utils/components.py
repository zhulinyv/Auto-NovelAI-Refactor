import csv
import os

import gradio as gr
import send2trash

from utils import format_str, list_to_str, read_txt
from utils.variable import NOISE_SCHEDULE, RESOLUTION, SAMPLER, UC_PRESET


def get_resolution_from_sliders(width, height):
    current_res = f"{int(width)}x{int(height)}"
    if current_res in RESOLUTION:
        return current_res
    else:
        return "自定义"


def update_from_dropdown(resolution_choice):
    if resolution_choice == "自定义":
        return gr.update(), gr.update()

    width, height = map(int, resolution_choice.split("x"))
    return width, height


def update_from_width(width, height, current_resolution):
    new_resolution = get_resolution_from_sliders(width, height)
    if new_resolution != current_resolution:
        return new_resolution
    else:
        return gr.update()


def update_from_height(width, height, current_resolution):
    new_resolution = get_resolution_from_sliders(width, height)
    if new_resolution != current_resolution:
        return new_resolution
    else:
        return gr.update()


def load_tags(csv_filename="./assets/danbooru_e621_merged_with_zh.csv"):
    tags = []
    with open(csv_filename, "r", encoding="utf-8") as file:
        reader = csv.reader(file)
        for row in reader:
            if len(row) >= 3 and row[0].strip() and row[1].strip():
                try:
                    main_tag = row[0].strip()
                    numerical_value = float(row[1].strip())
                    description = row[2].strip()
                    tags.append((main_tag, numerical_value, description))
                except ValueError:
                    continue
    return tags


def suggest_tags(input_text: str):
    input_text = input_text.strip().lower()
    if input_text != "":
        input_text = (
            input_text.strip().lower().split(",")[-1] if input_text[-1] != "," else "qwerty123465...一串神秘小代码"
        ).strip()
    else:
        input_text = "qwerty123465...一串神秘小代码"
    suggestions = []
    for main_tag, value, desc in load_tags():
        if input_text in "{},({})".format(main_tag, desc):
            display_text = desc if desc else main_tag
            suggestions.append({"display": display_text, "value": main_tag, "sort_key": value})
    sorted_suggestions = sorted(suggestions, key=lambda x: x["sort_key"], reverse=True)[:20]
    suggestions = []
    for item in sorted_suggestions:
        suggestions.append("{},({})".format(item["value"], item["display"]))
    return suggestions


def auto_complete(input_box):
    suggestions_radio = gr.Radio(
        label="补全建议",
        choices=[],
        elem_id="suggestion_list",
        visible=False,
        show_label=False,
    )
    input_box.input(
        lambda x: gr.Radio(choices=suggest_tags(x), visible=True),
        inputs=input_box,
        outputs=suggestions_radio,
    )

    def update_input(origin_tag, tag: str):
        value = format_str(origin_tag).split(", ")[:-1] + [tag.split(",")[0]]
        return gr.update(value=list_to_str(value)), gr.update(choices=[], visible=False)

    suggestions_radio.change(
        update_input,
        inputs=[input_box, suggestions_radio],
        outputs=[input_box, suggestions_radio],
    )


def update_wildcard_names(wildcard_type):
    return gr.update(choices=["随机"] + [file.split(".")[0] for file in os.listdir(f"./wildcards/{wildcard_type}")])


def update_wildcard_tags(wildcard_type, wildcard_name):
    if wildcard_name == "随机":
        return None
    else:
        return read_txt(f"./wildcards/{wildcard_type}/{wildcard_name}.txt")


def add_wildcard_to_textbox(positive_input, wildcard_type, wildcard_name):
    return format_str(positive_input + f", <{wildcard_type}:{wildcard_name}>")


def modify_wildcard(wildcard_type, wildcard_name, wildcard_tags):
    with open(f"./wildcards/{wildcard_type}/{wildcard_name}.txt", "w") as file:
        file.write(wildcard_tags)
    return f"已修改 <{wildcard_type}:{wildcard_name}>!"


def delete_wildcard(wildcard_type, wildcard_name):
    send2trash.send2trash(f"./wildcards/{wildcard_type}/{wildcard_name}.txt")
    return f"已将 <{wildcard_type}:{wildcard_name}> 移动到回收站!"


def add_wildcard(new_wildcard_type, new_wildcard_name, new_wildcard_tags):
    if not os.path.exists(_path := f"./wildcards/{new_wildcard_type}"):
        os.makedirs(_path, exist_ok=True)
    modify_wildcard(new_wildcard_type, new_wildcard_name, new_wildcard_tags)
    return f"已添加 <{new_wildcard_type}:{new_wildcard_name}>!"


def update_components_for_models_change(model):
    _SAMPLER = SAMPLER[:]
    _SAMPLER.remove("ddim_v3")
    _NOISE_SCHEDULE = NOISE_SCHEDULE[:]
    _NOISE_SCHEDULE.remove("native")
    _UC_PRESET = UC_PRESET[:]

    if model in ["nai-diffusion-4-5-full", "nai-diffusion-4-5-curated"]:
        if model == "nai-diffusion-4-5-curated":
            _UC_PRESET.remove("Furry Focus")
        return (
            gr.update(visible=False),  # decrisp
            gr.update(visible=False),  # sm
            gr.update(visible=False),  # sm_dyn
            gr.update(visible=False),  # legacy_uc
            gr.update(choices=_SAMPLER),  # sampler
            gr.update(choices=_NOISE_SCHEDULE),  # noise_schedule
            gr.update(choices=_UC_PRESET),  # uc_preset
            gr.update(visible=True),  # naiv4vibebundle_file
            gr.update(visible=True),  # normalize_reference_strength_multiple
            gr.update(visible=False),  # nai3vibe_column
            gr.update(visible=True),  # character_reference_tab
        )
    elif model in ["nai-diffusion-4-full", "nai-diffusion-4-curated-preview"]:
        _UC_PRESET.remove("Furry Focus")
        _UC_PRESET.remove("Human Focus")
        return (
            gr.update(visible=False),  # decrisp
            gr.update(visible=False),  # sm
            gr.update(visible=False),  # sm_dyn
            gr.update(visible=True),  # legacy_uc
            gr.update(choices=_SAMPLER),  # sampler
            gr.update(choices=_NOISE_SCHEDULE),  # noise_schedule
            gr.update(choices=_UC_PRESET),  # uc_preset
            gr.update(visible=True),  # naiv4vibebundle_file
            gr.update(visible=True),  # normalize_reference_strength_multiple
            gr.update(visible=False),  # nai3vibe_column
            gr.update(visible=False),  # character_reference_tab
        )
    elif model in ["nai-diffusion-3", "nai-diffusion-furry-3"]:
        _UC_PRESET.remove("Furry Focus")
        if model == "nai-diffusion-furry-3":
            _UC_PRESET.remove("Human Focus")
        return (
            gr.update(visible=True),  # decrisp
            gr.update(visible=True),  # sm
            gr.update(visible=True),  # sm_dyn
            gr.update(visible=False),  # legacy_uc
            gr.update(choices=SAMPLER),  # sampler
            gr.update(choices=NOISE_SCHEDULE),  # noise_schedule
            gr.update(choices=_UC_PRESET),  # uc_preset
            gr.update(visible=False),  # naiv4vibebundle_file
            gr.update(visible=False),  # normalize_reference_strength_multiple
            gr.update(visible=True),  # nai3vibe_column
            gr.update(visible=False),  # character_reference_tab
        )


def update_components_for_sm_change(sm):
    if sm:
        return gr.update(visible=True)
    else:
        return gr.update(visible=False)


def update_components_for_sampler_change(sampler):
    if sampler == "ddim_v3":
        return gr.update(visible=False)
    else:
        return gr.update(visible=True)


def add_character(character_components_number):
    if character_components_number < 6:
        character_components_number += 1
        update_visible_list = [gr.update(visible=True) for _ in range(5) for _ in range(character_components_number)]
        update_visible_list += [
            gr.update(visible=False) for _ in range(5) for _ in range(6 - character_components_number)
        ]
        return gr.update(value=character_components_number), *update_visible_list
    else:
        update_visible_list = [gr.update(visible=True) for _ in range(30)]
        return gr.update(value=character_components_number), *update_visible_list


def delete_character(character_components_number):
    if character_components_number > 0:
        character_components_number -= 1
        update_visible_list = [gr.update(visible=True) for _ in range(5) for _ in range(character_components_number)]
        update_visible_list += [
            gr.update(visible=False) for _ in range(5) for _ in range(6 - character_components_number)
        ]
        return gr.update(value=character_components_number), *update_visible_list
    else:
        update_visible_list = [gr.update(visible=False) for _ in range(30)]
        return gr.update(value=character_components_number), *update_visible_list


def return_position_interactive(ai_choice):
    components_list = []
    for _ in range(6):
        components_list.append(gr.update())
        components_list.append(gr.update())
        components_list.append(gr.update(interactive=not ai_choice))
        components_list.append(gr.update())
        components_list.append(gr.update())
    return (*components_list,)


def return_character_reference_component(character_reference_image):
    if character_reference_image:
        return gr.update(visible=True), gr.update(visible=True), gr.update(visible=False)
    else:
        return gr.update(visible=False), gr.update(visible=False), gr.update(visible=True)


def return_character_reference_component_visible(nai3vibe_transfer_image):
    if nai3vibe_transfer_image:
        return gr.update(visible=False)
    else:
        return gr.update(visible=True)
