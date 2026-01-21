import os
import string
from pathlib import Path

import gradio as gr
import pandas as pd

from src.director_tools import colorize, declutter, emotion, line_art, remove_bg, sketch
from src.generate_images import main as generate_images
from src.upscale_images import anime4k, realcugan_ncnn_vulkan, waifu2x_caffe
from utils import (
    copy_current_img,
    del_current_img,
    load_plugins,
    move_current_img,
    plugin_list,
    read_json,
    remove_pnginfo,
    restart,
    show_first_img,
    show_next_img,
    stop_generate,
    tagger,
    tk_asksavefile_asy,
)
from utils.components import (
    add_character,
    add_wildcard,
    add_wildcard_to_textbox,
    auto_complete,
    delete_character,
    delete_wildcard,
    enable_plugin,
    install_plugin,
    modify_wildcard,
    return_character_reference_component,
    return_character_reference_component_visible,
    return_image2image_visible,
    return_pnginfo,
    return_position_interactive,
    send_pnginfo_to_generate,
    uninstall_plugin,
    update_components_for_models_change,
    update_components_for_sampler_change,
    update_components_for_sm_change,
    update_from_dropdown,
    update_from_height,
    update_from_width,
    update_repo,
    update_wildcard_names,
    update_wildcard_tags,
)
from utils.environment import env
from utils.image_tools import return_array_image
from utils.prepare import _model, is_updated, last_data, parameters
from utils.setting_updater import modify_env
from utils.variable import (
    BASE_PATH,
    CHARACTER_POSITION,
    MODELS,
    NOISE_SCHEDULE,
    RESOLUTION,
    SAMPLER,
    UC_PRESET,
    WILDCARD_TYPE,
)

with gr.Blocks(
    theme=env.theme if env.theme != "空" else None,
    title="Auto-NovelAI-Refactor",
) as anr:
    with gr.Row():
        model = gr.Dropdown(
            choices=MODELS,
            value=_model,
            label="生图模型",
            interactive=True,
            scale=1,
        )
        with gr.Column(scale=2):
            gr.Markdown(
                "# [Auto-NovelAI-Refactor](https://github.com/zhulinyv/Auto-NovelAI-Refactor) | NovelAI 批量生成工具 | 版本: "
                + is_updated
            )

    with gr.Row():
        with gr.Column(scale=3):
            positive_input = gr.TextArea(
                value=last_data.get("input"),
                label="正面提示词",
                placeholder="请在此输入正面提示词...",
                lines=5,
            )
            auto_complete(positive_input)
            negative_input = gr.TextArea(
                value=parameters.get("negative_prompt"),
                label="负面提示词",
                placeholder="请在此输入负面提示词...",
                lines=5,
            )
            auto_complete(negative_input)
        with gr.Column(scale=1):
            with gr.Row():
                furry_mode = gr.Button(
                    "🌸", visible=False if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else True
                )
                furry_mode.click(lambda x: "🐾" if x == "🌸" else "🌸", inputs=furry_mode, outputs=furry_mode)
                add_quality_tags = gr.Checkbox(
                    value=parameters.get("qualityToggle", True), label="添加质量词", interactive=True
                )
            undesired_contentc_preset = gr.Dropdown(
                choices=[
                    x
                    for x in UC_PRESET
                    if x
                    not in {
                        "nai-diffusion-4-5-full": [],
                        "nai-diffusion-4-5-curated": ["Furry Focus"],
                        "nai-diffusion-4-full": ["Furry Focus", "Human Focus"],
                        "nai-diffusion-4-curated-preview": ["Furry Focus", "Human Focus"],
                        "nai-diffusion-3": ["Furry Focus"],
                        "nai-diffusion-furry-3": ["Furry Focus", "Human Focus"],
                    }.get(_model, [])
                ],
                value="None" if parameters.get("negative_prompt") else "Heavy",
                label="负面提示词预设",
                interactive=True,
            )
            generate_button = gr.Button(value="开始生成")
            stop_button = gr.Button(value="停止生成")
            stop_button.click(stop_generate)
            quantity = gr.Slider(
                minimum=1,
                maximum=999,
                value=1,
                step=1,
                label="生成数量",
                interactive=True,
            )

    with gr.Row():
        with gr.Column(scale=1):
            with gr.Tab(label="参数设置"):
                resolution = gr.Dropdown(
                    choices=RESOLUTION + ["自定义"],
                    value=(
                        "自定义"
                        if (res := "{}x{}".format(parameters.get("width"), parameters.get("height"))) not in RESOLUTION
                        else res
                    ),
                    label="分辨率预设",
                    interactive=True,
                )
                with gr.Row():
                    width = gr.Slider(
                        minimum=0,
                        maximum=50000,
                        value=parameters.get("width", 832),
                        step=64,
                        label="宽",
                        interactive=True,
                    )
                    height = gr.Slider(
                        minimum=0,
                        maximum=50000,
                        value=parameters.get("height", 1216),
                        step=64,
                        label="高",
                        interactive=True,
                    )
                resolution.change(
                    fn=update_from_dropdown,
                    inputs=[resolution],
                    outputs=[width, height],
                )
                width.change(
                    fn=update_from_width,
                    inputs=[width, height, resolution],
                    outputs=resolution,
                )
                height.change(
                    fn=update_from_height,
                    inputs=[width, height, resolution],
                    outputs=resolution,
                )
                steps = gr.Slider(
                    minimum=1,
                    maximum=50,
                    value=parameters.get("steps", 23),
                    label="采样步数",
                    step=1,
                    interactive=True,
                )
                prompt_guidance = gr.Slider(
                    minimum=0,
                    maximum=10,
                    value=parameters.get("scale", 5),
                    label="提示词指导系数",
                    step=0.1,
                    interactive=True,
                )
                prompt_guidance_rescale = gr.Slider(
                    minimum=0,
                    maximum=10,
                    value=parameters.get("cfg_rescale", 0),
                    label="提示词重采样系数",
                    step=0.02,
                    interactive=True,
                )
                with gr.Row():
                    variety = gr.Checkbox(
                        value=True if parameters.get("skip_cfg_above_sigma") else False,
                        label="Variety+",
                        interactive=True,
                    )
                    decrisp = gr.Checkbox(
                        value=parameters.get("dynamic_thresholding", False),
                        label="Decrisp",
                        visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                        interactive=True,
                    )
                with gr.Row():
                    sm = gr.Checkbox(
                        value=parameters.get("sm", False),
                        label="SMEA",
                        visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                        interactive=True,
                    )
                    sm_dyn = gr.Checkbox(
                        value=parameters.get("sm_dyn", False),
                        label="DYN",
                        visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                        interactive=True,
                    )
                with gr.Row():
                    seed = gr.Textbox(value="-1", label="种子", interactive=True, scale=4)
                with gr.Row(scale=1):
                    last_seed = gr.Button(value="♻️", size="sm")
                    random_seed = gr.Button(value="🎲", size="sm")
                    last_seed.click(
                        lambda: read_json("last.json")["parameters"]["seed"] if os.path.exists("last.json") else "-1",
                        outputs=seed,
                    )
                    random_seed.click(lambda: "-1", outputs=seed)
                sampler = gr.Dropdown(
                    choices=(
                        SAMPLER
                        if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"]
                        else [x for x in SAMPLER if x != "ddim_v3"]
                    ),
                    value=parameters.get("sampler", "k_euler_ancestral"),
                    label="采样器",
                    interactive=True,
                )
                noise_schedule = gr.Dropdown(
                    choices=(
                        NOISE_SCHEDULE
                        if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"]
                        else [x for x in NOISE_SCHEDULE if x != "native"]
                    ),
                    value=parameters.get("noise_schedule", "karras"),
                    label="调度器",
                    interactive=True,
                )
                legacy_uc = gr.Checkbox(
                    value=parameters.get("legacy_uc", False),
                    label="Legacy Prompt Conditioning Mode",
                    visible=(True if _model in ["nai-diffusion-4-full", "nai-diffusion-4-curated-preview"] else False),
                    interactive=True,
                )
                inpaint_input_image = gr.Sketchpad(
                    sources=["upload", "clipboard", "webcam"],
                    type="pil",
                    label="基础图片(可选)",
                )
                strength = gr.Slider(0.01, 0.99, 0.7, step=0.01, label="强度", visible=False, interactive=True)
                noise = gr.Slider(0, 10, 0, step=0.01, label="噪声", visible=False, interactive=True)
                inpaint_input_image.change(
                    return_image2image_visible,
                    inputs=inpaint_input_image,
                    outputs=[inpaint_input_image, strength, noise, width, height],
                )
            character_position_tab = gr.Tab(
                label="角色分区", visible=False if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else True
            )
            with character_position_tab:
                character_components_list = []
                character_components_number = gr.Number(value=0, visible=False)  # 使用 Number 替代 Slider
                add_character_button = gr.Button("添加角色")
                delete_character_button = gr.Button("删除角色")
                character_position_table = gr.Dataframe(
                    value=pd.DataFrame(
                        [
                            ["1", "A1", "B1", "C1", "D1", "E1"],
                            ["2", "A2", "B2", "C2", "D2", "E2"],
                            ["3", "A3", "B3", "C3", "D3", "E3"],
                            ["4", "A4", "B4", "C4", "D4", "E4"],
                            ["5", "A5", "B5", "C5", "D5", "E5"],
                        ],
                        columns=["位置", "A", "B", "C", "D", "E"],
                    ),
                    visible=False,
                    interactive=False,
                )
                ai_choice = gr.Checkbox(True, label="AI's Choice (Character Positions (Global))", interactive=False)
                ai_choice.change(lambda x: gr.update(visible=not x), inputs=ai_choice, outputs=character_position_table)
                gr.Markdown("<hr>")

                # 先创建所有组件
                for i in range(6):
                    character_components_list.append(
                        gr.TextArea(label=f"角色 {i+1} 正面提示词", lines=3, visible=False, interactive=True)
                    )
                    character_components_list.append(
                        gr.TextArea(label=f"角色 {i+1} 负面提示词", lines=3, visible=False, interactive=True)
                    )
                    with gr.Row():
                        character_components_list.append(
                            gr.Dropdown(
                                choices=CHARACTER_POSITION,
                                label=f"角色 {i+1} 位置",
                                visible=False,
                                interactive=True,
                            )
                        )
                        character_components_list.append(
                            gr.Checkbox(False, label="启用", visible=False, interactive=True)
                        )
                    character_components_list.append(gr.Markdown("<hr>", visible=False))

                add_character_button.click(
                    add_character,
                    inputs=character_components_number,
                    outputs=[ai_choice, character_components_number] + character_components_list,
                )
                delete_character_button.click(
                    delete_character,
                    inputs=character_components_number,
                    outputs=[ai_choice, character_components_number] + character_components_list,
                )
                ai_choice.change(return_position_interactive, inputs=ai_choice, outputs=character_components_list)
            character_reference_tab = gr.Tab(
                "角色参考",
                visible=True if _model in ["nai-diffusion-4-5-full", "nai-diffusion-4-5-curated"] else False,
            )
            with character_reference_tab:
                character_reference_image = gr.Image(label="Character Reference Image", type="filepath")
                with gr.Row():
                    fidelity = gr.Slider(0, 1, 1, step=0.05, label="Fidelity", visible=False)
                    style_aware = gr.Checkbox(True, label="Style Aware", visible=False, interactive=True)
            vibe_transfer_tab = gr.Tab(label="风格迁移", visible=True, interactive=True)
            character_reference_image.change(
                return_character_reference_component,
                inputs=character_reference_image,
                outputs=[style_aware, fidelity, vibe_transfer_tab],
            )
            with vibe_transfer_tab:
                naiv4vibebundle_file = gr.File(
                    type="filepath",
                    label="*.naiv4vibebundle",
                    visible=True if _model not in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                    interactive=True,
                )
                naiv4vibebundle_file.change(
                    return_character_reference_component_visible,
                    inputs=[model, naiv4vibebundle_file],
                    outputs=character_reference_tab,
                )
                normalize_reference_strength_multiple = gr.Checkbox(
                    True,
                    label="Normalize Reference Strength Values",
                    visible=True if _model not in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                    interactive=True,
                )
                naiv4vibebundle_file_instruction = gr.Markdown(
                    "关于 *.naiv4vibebundle 文件的获取: 请先在官网上传 vibe 使用的底图, 调整权重后进行编码, 待全部图片完成编码后下载 *.naiv4vibebundle 文件, 注意不要下载单张图片编码的 vibe 文件",
                    visible=True if _model not in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                )
                nai3vibe_column = gr.Column(
                    visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False
                )
                with nai3vibe_column:
                    nai3vibe_transfer_image_count = gr.State(1)
                    nai3vibe_transfer_add_button = gr.Button("添加图片")
                    nai3vibe_transfer_del_button = gr.Button("删除图片")
                    nai3vibe_transfer_add_button.click(
                        lambda x: x + 1,
                        nai3vibe_transfer_image_count,
                        nai3vibe_transfer_image_count,
                    )
                    nai3vibe_transfer_del_button.click(
                        lambda x: x - 1,
                        nai3vibe_transfer_image_count,
                        nai3vibe_transfer_image_count,
                    )
                    gr.Markdown("<hr>")

                    @gr.render(inputs=nai3vibe_transfer_image_count)
                    def _(count):
                        nai3vibe_transfer_components_list = []
                        for _ in range(count):
                            with gr.Row():
                                nai3vibe_transfer_image = gr.Image(type="filepath")
                                with gr.Column():
                                    reference_information_extracted_multiple = gr.Slider(
                                        0, 1, 1.0, step=0.01, label="信息提取强度", interactive=True
                                    )
                                    reference_strength_multiple = gr.Slider(
                                        0, 1, 0.6, step=0.01, label="画风参考强度", interactive=True
                                    )
                                    gr.Markdown("<hr>")
                            nai3vibe_transfer_components_list.append(nai3vibe_transfer_image)
                            nai3vibe_transfer_components_list.append(reference_information_extracted_multiple)
                            nai3vibe_transfer_components_list.append(reference_strength_multiple)
                        generate_button.click(
                            generate_images,
                            inputs=[
                                model,
                                positive_input,
                                negative_input,
                                furry_mode,
                                add_quality_tags,
                                undesired_contentc_preset,
                                quantity,
                                width,
                                height,
                                steps,
                                prompt_guidance,
                                prompt_guidance_rescale,
                                variety,
                                seed,
                                sampler,
                                noise_schedule,
                                decrisp,
                                sm,
                                sm_dyn,
                                legacy_uc,
                                inpaint_input_image,
                                strength,
                                noise,
                                naiv4vibebundle_file,
                                normalize_reference_strength_multiple,
                                character_reference_image,
                                style_aware,
                                fidelity,
                                ai_choice,
                            ]
                            + character_components_list
                            + nai3vibe_transfer_components_list,
                            outputs=[output_image, output_information],
                        )

            with gr.Tab(label="Wildcards"):
                with gr.Tab("使用或修改"):
                    wildcard_type = gr.Dropdown(
                        choices=WILDCARD_TYPE,
                        value=None,
                        label="分类",
                        interactive=True,
                    )
                    wildcard_name = gr.Dropdown(
                        value=None,
                        label="名称",
                        interactive=True,
                    )
                    wildcard_tags = gr.Textbox(label="包含的提示词", lines=2, interactive=True)
                    with gr.Row():
                        wildcard_add_positive = gr.Button("添加到正面提示词")
                        wildcard_add_negative = gr.Button("添加到负面提示词")
                    with gr.Row():
                        wildcard_modify = gr.Button("修改", size="sm")
                        wildcard_delete = gr.Button("删除", size="sm")
                with gr.Tab("创建新卡片"):
                    new_wildcard_type = gr.Textbox(label="分类")
                    new_wildcard_name = gr.Textbox(label="名称")
                    new_wildcard_tags = gr.Textbox(label="提示词", lines=2)
                    wildcard_add = gr.Button("添加卡片")
                    wildcard_refresh = gr.Button("刷新列表")

                wildcard_type.change(update_wildcard_names, inputs=wildcard_type, outputs=wildcard_name)
                wildcard_name.change(
                    update_wildcard_tags,
                    inputs=[wildcard_type, wildcard_name],
                    outputs=wildcard_tags,
                )
                wildcard_add_positive.click(
                    add_wildcard_to_textbox,
                    inputs=[positive_input, wildcard_type, wildcard_name],
                    outputs=positive_input,
                )
                wildcard_add_negative.click(
                    add_wildcard_to_textbox,
                    inputs=[negative_input, wildcard_type, wildcard_name],
                    outputs=negative_input,
                )
                wildcard_refresh.click(
                    lambda: gr.update(choices=os.listdir("./wildcards")),
                    outputs=wildcard_type,
                )
        with gr.Column(scale=2):
            with gr.Tab("图片生成"):
                with gr.Column(scale=2):
                    output_image = gr.Gallery(label="输出图片", interactive=False, show_label=False)
                    output_information = gr.Textbox(label="输出信息", interactive=False, show_label=False)
                    wildcard_modify.click(
                        modify_wildcard,
                        inputs=[wildcard_type, wildcard_name, wildcard_tags],
                        outputs=output_information,
                    )
                    wildcard_delete.click(
                        delete_wildcard,
                        inputs=[wildcard_type, wildcard_name],
                        outputs=output_information,
                    )
                    wildcard_add.click(
                        add_wildcard,
                        inputs=[new_wildcard_type, new_wildcard_name, new_wildcard_tags],
                        outputs=output_information,
                    )
            with gr.Tab("导演工具"):
                director_input_path = gr.Textbox(label="批处理路径(同时输入路径和图片时仅处理图片)")
                with gr.Row():
                    director_input_image = gr.Image(type="filepath", label="Input")
                    director_output_image = gr.Gallery(interactive=False, label="Output")
                with gr.Tab("Remove BG"):
                    remove_bg_button = gr.Button("开始处理")
                    remove_bg_button.click(
                        remove_bg, inputs=[director_input_path, director_input_image], outputs=director_output_image
                    )
                with gr.Tab("Line Art"):
                    line_art_button = gr.Button("开始处理")
                    line_art_button.click(
                        line_art, inputs=[director_input_path, director_input_image], outputs=director_output_image
                    )
                with gr.Tab("Sketch"):
                    sketch_button = gr.Button("开始处理")
                    sketch_button.click(
                        sketch, inputs=[director_input_path, director_input_image], outputs=director_output_image
                    )
                with gr.Tab("Colorize"):
                    with gr.Row():
                        colorize_defry = gr.Slider(0, 5, 0, step=1, label="Defry")
                        colorize_prompt = gr.Textbox(label="Prompt (Optional)")
                    colorize_button = gr.Button("开始处理")
                    colorize_button.click(
                        colorize,
                        inputs=[director_input_path, director_input_image, colorize_defry, colorize_prompt],
                        outputs=director_output_image,
                    )
                with gr.Tab("Emotion"):
                    with gr.Row():
                        emotion_tag = gr.Dropdown(
                            [
                                "Neutral",
                                "Happy",
                                "Sad",
                                "Angry",
                                "Scared",
                                "Surprised",
                                "Tired",
                                "Excited",
                                "Nervous",
                                "Thinking",
                                "Confused",
                                "Shy",
                                "Disgusted",
                                "Smug",
                                "Bored",
                                "Laughing",
                                "Irritated",
                                "Aroused",
                                "Embarrassed",
                                "Worried",
                                "Love",
                                "Determined",
                                "Hurt",
                                "Playful",
                            ],
                            value="Neutral",
                            label="Emotion",
                            interactive=True,
                        )
                        emotion_strength = gr.Dropdown(
                            ["Normal", "Slightly Weak", "Weak", "Even Weaker", "Very Weak", "Weakest"],
                            show_label=False,
                            interactive=True,
                        )
                        emotion_prompt = gr.Textbox(label="Prompt (Optional)")
                    emotion_button = gr.Button("开始处理")
                    emotion_button.click(
                        emotion,
                        inputs=[
                            director_input_path,
                            director_input_image,
                            emotion_tag,
                            emotion_strength,
                            emotion_prompt,
                        ],
                        outputs=director_output_image,
                    )
                with gr.Tab("Declutter"):
                    declutter_button = gr.Button("开始处理")
                    declutter_button.click(
                        declutter, inputs=[director_input_path, director_input_image], outputs=director_output_image
                    )
                director_stop_button = gr.Button("停止处理")
                director_stop_button.click(stop_generate)
            with gr.Tab("超分降噪"):
                upscale_input_path = gr.Textbox(label="批处理路径(同时输入路径和图片时仅处理图片)")
                with gr.Row():
                    with gr.Column():
                        upscale_input_image = gr.Image(type="numpy", interactive=False, label="Input")
                        with gr.Row():
                            upscale_input_text = gr.Textbox(visible=False)
                            upscale_input_btn = gr.Button("选择图片")
                            upscale_clear_btn = gr.Button("清除选择")
                    upscale_clear_btn.click(lambda x: x, gr.Textbox(None, visible=False), upscale_input_text)
                    upscale_input_btn.click(tk_asksavefile_asy, inputs=[], outputs=[upscale_input_text])
                    upscale_input_text.change(return_array_image, upscale_input_text, upscale_input_image)
                    upscale_output_image = gr.Gallery(interactive=False, label="Output")
                with gr.Tab("realcugan-ncnn-vulkan"):
                    with gr.Column():
                        # gr.Markdown("出现错误时请确保电脑上有 vulkan-1.dll 文件")
                        with gr.Row():
                            realcugan_noise = gr.Slider(minimum=-1, maximum=3, value=3, step=1, label="降噪强度")
                            realcugan_scale = gr.Slider(minimum=2, maximum=4, value=2, step=1, label="放大倍数")
                        realcugan_model = gr.Radio(
                            ["models-se", "models-pro", "models-nose"], value="models-se", label="超分模型"
                        )
                        realcugan_button = gr.Button("开始生成")
                        realcugan_button.click(
                            realcugan_ncnn_vulkan,
                            inputs=[
                                upscale_input_path,
                                upscale_input_text,
                                realcugan_noise,
                                realcugan_scale,
                                realcugan_model,
                            ],
                            outputs=upscale_output_image,
                        )
                with gr.Tab("Anime4K"):
                    with gr.Column():
                        # gr.Markdown("出现错误时请确保电脑上有 OpenCL.dll 文件")
                        with gr.Row():
                            anime4k_zoomFactor = gr.Slider(1, maximum=32, value=2, step=1, label="放大倍数")
                            anime4k_HDNLevel = gr.Slider(minimum=1, maximum=3, step=1, value=3, label="HDN 等级")
                        with gr.Row():
                            anime4k_GPUMode = gr.Radio([True, False], label="开启 GPU 加速", value=True)
                            anime4k_CNNMode = gr.Radio([True, False], label="开启 ACNet 模式", value=True)
                            anime4k_HDN = gr.Radio([True, False], label="为 ACNet 开启 HDN", value=True)
                        anime4k_button = gr.Button("开始生成")
                        anime4k_button.click(
                            anime4k,
                            inputs=[
                                upscale_input_path,
                                upscale_input_text,
                                anime4k_zoomFactor,
                                anime4k_HDNLevel,
                                anime4k_GPUMode,
                                anime4k_CNNMode,
                                anime4k_HDN,
                            ],
                            outputs=upscale_output_image,
                        )
                with gr.Tab("waifu2x-caffe"):
                    with gr.Column():
                        with gr.Row():
                            waifu2x_caffe_mode = gr.Radio(
                                ["noise", "scale", "noise_scale"], value="noise_scale", label="模式"
                            )
                            waifu2x_caffe_process = gr.Radio(["cpu", "gpu", "cudnn"], value="gpu", label="处理模式")
                            waifu2x_caffe_tta = gr.Radio([True, False], value=False, label="开启 tta 模式")
                        with gr.Row():
                            waifu2x_caffe_scale = gr.Slider(minimum=1, maximum=32, value=2, label="放大倍数")
                            waifu2x_caffe_noise = gr.Slider(minimum=0, maximum=3, step=1, value=3, label="降噪强度")
                        waifu2x_caffe_model = gr.Radio(
                            [
                                "anime_style_art_rgb",
                                "anime_style_art",
                                "photo",
                                "upconv_7_anime_style_art_rgb",
                                "upconv_7_photo",
                                "upresnet10",
                                "cunet",
                                "ukbench",
                            ],
                            value="cunet",
                            label="超分模型",
                        )
                        waifu2x_caffe_button = gr.Button("开始生成")
                        waifu2x_caffe_button.click(
                            waifu2x_caffe,
                            inputs=[
                                upscale_input_path,
                                upscale_input_text,
                                waifu2x_caffe_mode,
                                waifu2x_caffe_process,
                                waifu2x_caffe_tta,
                                waifu2x_caffe_scale,
                                waifu2x_caffe_noise,
                                waifu2x_caffe_model,
                            ],
                            outputs=upscale_output_image,
                        )
                upscale_stop_button = gr.Button("停止生成")
                upscale_stop_button.click(stop_generate)
            with gr.Tab("法术解析"):
                with gr.Tab("读取信息"):
                    with gr.Row():
                        with gr.Column():
                            pnginfo_image = gr.Image(type="filepath", image_mode="RGBA")
                            send_button = gr.Button("发送到图片生成", visible=False)
                            send_info_from_json = gr.Files(type="filepath", interactive=True, label="从 json 文件导入")
                            send_info_from_json.change(
                                send_pnginfo_to_generate,
                                inputs=send_info_from_json,
                                outputs=[
                                    positive_input,
                                    negative_input,
                                    width,
                                    height,
                                    steps,
                                    prompt_guidance,
                                    prompt_guidance_rescale,
                                    variety,
                                    decrisp,
                                    sm,
                                    sm_dyn,
                                    seed,
                                    sampler,
                                    noise_schedule,
                                    legacy_uc,
                                    ai_choice,
                                    character_components_number,
                                ]
                                + character_components_list,
                            )
                            show_all_pnginfo = gr.Checkbox(False, label="显示所有信息")
                        with gr.Column():
                            source = gr.Textbox(label="Source")
                            generation_time = gr.Textbox(label="Generation time")
                            comment = gr.JSON(label="Comment", open=True)
                            description = gr.TextArea(label="Description")
                            software = gr.Textbox(label="Software")
                    all_pnginfo = gr.JSON(label="全部信息", open=True, visible=False)
                    show_all_pnginfo.change(
                        lambda x: gr.update(visible=x), inputs=show_all_pnginfo, outputs=all_pnginfo
                    )
                    pnginfo_image.change(
                        return_pnginfo,
                        inputs=pnginfo_image,
                        outputs=[
                            send_button,
                            source,
                            generation_time,
                            comment,
                            description,
                            software,
                            all_pnginfo,
                        ],
                    )
                    send_button.click(
                        send_pnginfo_to_generate,
                        inputs=pnginfo_image,
                        outputs=[
                            positive_input,
                            negative_input,
                            width,
                            height,
                            steps,
                            prompt_guidance,
                            prompt_guidance_rescale,
                            variety,
                            decrisp,
                            sm,
                            sm_dyn,
                            seed,
                            sampler,
                            noise_schedule,
                            legacy_uc,
                            ai_choice,
                            character_components_number,
                        ]
                        + character_components_list,
                    )
                with gr.Tab("图片反推"):
                    with gr.Row():
                        with gr.Column():
                            tagger_image = gr.Image(type="filepath", label="Input")
                            tagger_model = gr.Dropdown(
                                choices=[
                                    "SmilingWolf/wd-swinv2-tagger-v3",
                                    "SmilingWolf/wd-convnext-tagger-v3",
                                    "SmilingWolf/wd-vit-tagger-v3",
                                    "SmilingWolf/wd-vit-large-tagger-v3",
                                    "SmilingWolf/wd-eva02-large-tagger-v3",
                                    "SmilingWolf/wd-v1-4-moat-tagger-v2",
                                    "SmilingWolf/wd-v1-4-swinv2-tagger-v2",
                                    "SmilingWolf/wd-v1-4-convnext-tagger-v2",
                                    "SmilingWolf/wd-v1-4-convnextv2-tagger-v2",
                                    "SmilingWolf/wd-v1-4-vit-tagger-v2",
                                    "deepghs/idolsankaku-swinv2-tagger-v1",
                                    "deepghs/idolsankaku-eva02-large-tagger-v1",
                                ],
                                value="SmilingWolf/wd-swinv2-tagger-v3",
                                label="Model",
                            )
                            with gr.Row():
                                general_tags_threshold = gr.Slider(
                                    0, 1, 0.35, step=0.05, label="General Tags Threshold"
                                )
                                use_mcut_threshold_general = gr.Checkbox(False, label="Use MCut threshold")
                            with gr.Row():
                                character_tags_threshold = gr.Slider(
                                    0, 1, 0.85, step=0.05, label="Character Tags Threshold"
                                )
                                use_mcut_threshold_character = gr.Checkbox(False, label="Use MCut threshold")
                            with gr.Row():
                                submit_button = gr.Button("提交")
                                tagger_send_button = gr.Button("发送到图片生成")
                        with gr.Column():
                            tagger_sorted_general_strings = gr.TextArea(label="Output (string)", interactive=False)
                            tagger_rating = gr.Label(label="Rating")
                            tagger_character_res = gr.Label(label="Output (characters)")
                            tagger_general_res = gr.Label(label="Output (tags)")
                        submit_button.click(
                            tagger,
                            inputs=[
                                tagger_image,
                                tagger_model,
                                general_tags_threshold,
                                use_mcut_threshold_general,
                                character_tags_threshold,
                                use_mcut_threshold_character,
                            ],
                            outputs=[
                                tagger_sorted_general_strings,
                                tagger_rating,
                                tagger_character_res,
                                tagger_general_res,
                            ],
                        )
                        tagger_send_button.click(
                            lambda x: x, inputs=tagger_sorted_general_strings, outputs=positive_input
                        )
                with gr.Tab("抹除数据"):
                    with gr.Row():
                        with gr.Column():
                            remove_pnginfo_image = gr.Image(type="numpy", interactive=False, label="单张处理(可选)")
                            with gr.Row():
                                norm_input_text = gr.Textbox(visible=False)
                                norm_input_btn = gr.Button("选择图片")
                                norm_clear_btn = gr.Button("清除选择")
                        norm_clear_btn.click(lambda x: x, gr.Textbox(None, visible=False), norm_input_text)
                        norm_input_btn.click(tk_asksavefile_asy, inputs=[], outputs=[norm_input_text])
                        norm_input_text.change(return_array_image, norm_input_text, remove_pnginfo_image)
                        with gr.Column():
                            remove_pnginfo_generate_button = gr.Button("开始处理")
                            remove_pnginfo_choices = gr.CheckboxGroup(
                                [
                                    "Title",
                                    "Description",
                                    "Software",
                                    "Source",
                                    "Generation time",
                                    "Comment",
                                    "dpi",
                                    "parameters",
                                    "prompt",
                                ],
                                value=[
                                    "Title",
                                    "Description",
                                    "Software",
                                    "Source",
                                    "Generation time",
                                    "Comment",
                                    "dpi",
                                    "parameters",
                                    "prompt",
                                ],
                                label="要清除的内容",
                                scale=2,
                            )
                            remove_pnginfo_metadate = gr.Textbox(label="添加自定义信息(可选)")
                            remove_pnginfo_input_path = gr.Textbox(label="批处理路径(可选)")
                            remove_pnginfo_output_information = gr.Textbox(show_label=False, visible=False)
                            remove_pnginfo_output_information.change(
                                lambda x: gr.update(visible=True if x else False),
                                inputs=remove_pnginfo_output_information,
                                outputs=remove_pnginfo_output_information,
                            )
                            remove_pnginfo_generate_button.click(
                                fn=remove_pnginfo,
                                inputs=[
                                    norm_input_text,
                                    remove_pnginfo_input_path,
                                    remove_pnginfo_choices,
                                    remove_pnginfo_metadate,
                                ],
                                outputs=[remove_pnginfo_output_information],
                            )
            with gr.Tab("图片筛选"):
                with gr.Column():
                    with gr.Row():
                        selector_input_path = gr.Textbox(label="图片目录", scale=4)
                        selector_select_button = gr.Button("加载图片", scale=1)
                    with gr.Row():
                        selector_output_path = gr.Textbox(label="目录1")
                        _selector_output_path = gr.Textbox(label="目录2")
                with gr.Row():
                    selector_output_image = gr.Gallery(scale=7, preview=True, label="Image")
                    with gr.Column(scale=1):
                        selector_next_button = gr.Button("跳过")
                        selector_move_button = gr.Button("移动到目录1")
                        _selector_move_button = gr.Button("移动到目录2")
                        selector_copy_button = gr.Button("复制到目录1")
                        _selector_copy_button = gr.Button("复制到目录2")
                        selector_delete_button = gr.Button("删除")
                    selector_current_img = gr.Textbox(visible=False)
                    selector_select_button.click(
                        fn=show_first_img,
                        inputs=[selector_input_path],
                        outputs=[selector_output_image, selector_current_img],
                    )
                    selector_next_button.click(fn=show_next_img, outputs=[selector_output_image, selector_current_img])
                    selector_move_button.click(
                        fn=move_current_img,
                        inputs=[selector_current_img, selector_output_path],
                        outputs=[selector_output_image, selector_current_img],
                    )
                    _selector_move_button.click(
                        fn=move_current_img,
                        inputs=[selector_current_img, _selector_output_path],
                        outputs=[selector_output_image, selector_current_img],
                    )
                    selector_copy_button.click(
                        fn=copy_current_img,
                        inputs=[selector_current_img, selector_output_path],
                        outputs=[selector_output_image, selector_current_img],
                    )
                    _selector_copy_button.click(
                        fn=copy_current_img,
                        inputs=[selector_current_img, _selector_output_path],
                        outputs=[selector_output_image, selector_current_img],
                    )
                    selector_delete_button.click(
                        fn=del_current_img,
                        inputs=[selector_current_img],
                        outputs=[selector_output_image, selector_current_img],
                    )
            with gr.Tab("插件商店"):
                plugin_store_output_information = gr.Textbox(show_label=False, visible=False)
                plugin_store_plugin_name = gr.Dropdown(
                    value=None,
                    choices=list(
                        dict.fromkeys(
                            list(read_json("./assets/plugins.json").keys())
                            + [i.replace(".py", "") for i in os.listdir("./plugins")]
                        )
                    ),
                    label="插件名称",
                )
                with gr.Row():
                    plugin_store_install_button = gr.Button("安装/更新")
                    plugin_store_uninstall_button = gr.Button("删除")
                    plugin_store_enable_button = gr.Button("启用/禁用")
                    plugin_store_restart_button = gr.Button("重启")
                gr.Markdown(plugin_list())
                plugin_store_install_button.click(
                    install_plugin, inputs=plugin_store_plugin_name, outputs=plugin_store_output_information
                )
                plugin_store_uninstall_button.click(
                    uninstall_plugin, inputs=plugin_store_plugin_name, outputs=plugin_store_output_information
                )
                plugin_store_enable_button.click(
                    enable_plugin, inputs=plugin_store_plugin_name, outputs=plugin_store_output_information
                )
                plugin_store_restart_button.click(restart)
            plugins = load_plugins(Path("./plugins"))
            for plugin_name, plugin_module in plugins.items():
                if hasattr(plugin_module, "plugin"):
                    plugin_module.plugin()
            with gr.Tab("配置设置"):
                update_anr_button = gr.Button("更新 ANR")
                with gr.Row():
                    setting_modify_button = gr.Button("保存")
                    setting_restart_button = gr.Button("重启")
                    setting_restart_button.click(restart)
                setting_output_information = gr.Textbox(show_label=False, visible=False)
                token = gr.Textbox(
                    value=env.token,
                    label="Token",
                    lines=2,
                    visible=True if not env.share else False,
                )
                gr.Markdown(
                    "获取 Token 的方法: [**自述文件**](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv#%EF%B8%8F-%E9%85%8D%E7%BD%AE)",
                    visible=True if not env.share else False,
                )
                format_input = gr.Checkbox(value=env.format_input, label="格式化输入")
                gr.Markdown("启用后, 将对输入的提示词进行格式化(删除多余空格和逗号或添加缺少的空格和逗号)")
                proxy = gr.Textbox(value=env.proxy, label="代理地址")
                gr.Markdown("<p>本地代理格式应为: http://127.0.0.1:xxx (xxx 为代理软件的端口号)</p>")
                custom_path = gr.Textbox(value=env.custom_path, label="自定义路径")
                gr.Markdown(
                    "已支持的自动替换路径: <类型>, <日期>, <种子>, <随机字符>, <编号>, 推荐: `<类型>/<日期>/<种子>_<编号>`"
                )
                cool_time = gr.Slider(1, 600, env.cool_time, label="冷却时间")
                gr.Markdown("会上下浮动 1 秒")
                port = gr.Textbox(value=env.port, label="ANR 的端口号")
                gr.Markdown("理论范围：1 - 65535")
                share = gr.Checkbox(value=env.share, label="共享 Gradio 链接")
                gr.Markdown("生成一个有效期一周的可分享链接, 可以在任意设备上访问")
                with gr.Row():
                    start_sound = gr.Checkbox(value=env.start_sound, label="启动提示音")
                    finish_sound = gr.Checkbox(value=env.finish_sound, label="完成提示音")
                check_update = gr.Checkbox(value=env.check_update, label="启动时检查更新")
                theme = gr.Dropdown(
                    value=env.theme,
                    choices=[
                        "空",
                        "gradio/base",
                        "gradio/glass",
                        "gradio/monochrome",
                        "gradio/seafoam",
                        "gradio/soft",
                        "gradio/dracula_test",
                        "abidlabs/dracula_test",
                        "abidlabs/Lime",
                        "abidlabs/pakistan",
                        "Ama434/neutral-barlow",
                        "dawood/microsoft_windows",
                        "finlaymacklon/smooth_slate",
                        "Franklisi/darkmode",
                        "freddyaboulton/dracula_revamped",
                        "freddyaboulton/test-blue",
                        "gstaff/xkcd",
                        "Insuz/Mocha",
                        "Insuz/SimpleIndigo",
                        "JohnSmith9982/small_and_pretty",
                        "nota-ai/theme",
                        "nuttea/Softblue",
                        "ParityError/Anime",
                        "reilnuud/polite",
                        "remilia/Ghostly",
                        "rottenlittlecreature/Moon_Goblin",
                        "step-3-profit/Midnight-Deep",
                        "Taithrah/Minimal",
                        "ysharma/huggingface",
                        "ysharma/steampunk",
                        "NoCrypt/miku",
                    ],
                    label="WebUI 主题",
                    allow_custom_value=True,
                )
                gr.Markdown(
                    f"[切换到浅色页面](http://127.0.0.1:{env.port}/?__theme=light) [切换到深色页面](http://127.0.0.1:{env.port}/?__theme=dark)"
                )
                setting_modify_button.click(
                    modify_env,
                    inputs=[
                        token,
                        proxy,
                        custom_path,
                        cool_time,
                        port,
                        share,
                        start_sound,
                        finish_sound,
                        check_update,
                        theme,
                        format_input,
                    ],
                    outputs=setting_output_information,
                )
                update_anr_button.click(
                    update_repo, inputs=gr.Textbox(BASE_PATH, visible=False), outputs=setting_output_information
                )

    model.change(
        update_components_for_models_change,
        inputs=model,
        outputs=[
            decrisp,
            sm,
            sm_dyn,
            legacy_uc,
            sampler,
            noise_schedule,
            undesired_contentc_preset,
            naiv4vibebundle_file,
            normalize_reference_strength_multiple,
            nai3vibe_column,
            character_reference_tab,
            naiv4vibebundle_file_instruction,
            furry_mode,
            character_position_tab,
        ],
    )
    sm.change(update_components_for_sm_change, inputs=sm, outputs=sm_dyn)
    sampler.change(update_components_for_sampler_change, inputs=sampler, outputs=noise_schedule)


anr.launch(
    inbrowser=True,
    share=env.share,
    server_port=env.port,
    favicon_path="./assets/logo.ico",
    allowed_paths=[f"{d}:" for d in string.ascii_uppercase if Path(f"{d}:").exists()],
)
