import os
import string
from pathlib import Path

import gradio as gr

from src.generate_images import main as generate_images
from utils import read_json, stop_generate
from utils.components import (
    add_character,
    add_wildcard,
    add_wildcard_to_textbox,
    auto_complete,
    delete_character,
    delete_wildcard,
    modify_wildcard,
    return_character_reference_component,
    return_character_reference_component_visible,
    return_image2image_visible,
    return_pnginfo,
    return_position_interactive,
    send_pnginfo_to_generate,
    update_components_for_models_change,
    update_components_for_sampler_change,
    update_components_for_sm_change,
    update_from_dropdown,
    update_from_height,
    update_from_width,
    update_wildcard_names,
    update_wildcard_tags,
)
from utils.environment import env
from utils.prepare import _model, last_data, parameters
from utils.setting_updater import modify_env
from utils.variable import CHARACTER_POSITION, MODELS, NOISE_SCHEDULE, RESOLUTION, SAMPLER, UC_PRESET, WILDCARD_TYPE

with gr.Blocks() as anr:
    with gr.Row():
        model = gr.Dropdown(
            choices=MODELS,
            value=_model,
            label="生图模型",
            interactive=True,
            scale=1,
        )
        with gr.Column(scale=2):
            gr.Markdown("# Auto-NovelAI-Refactor | NovelAI 批量生成工具")

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
                value="Heavy",
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
                        value=True if parameters.get("skip_cfg_above_sigma") else False, label="Variety+"
                    )
                    decrisp = gr.Checkbox(
                        value=parameters.get("dynamic_thresholding", False),
                        label="Decrisp",
                        visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                    )
                with gr.Row():
                    sm = gr.Checkbox(
                        value=parameters.get("sm", False),
                        label="SMEA",
                        visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
                    )
                    sm_dyn = gr.Checkbox(
                        value=parameters.get("sm_dyn", False),
                        label="DYN",
                        visible=True if _model in ["nai-diffusion-3", "nai-diffusion-furry-3"] else False,
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
            with gr.Tab(label="角色分区"):
                character_components_list = []
                character_components_number = gr.Number(value=0, visible=False)  # 使用 Number 替代 Slider
                add_character_button = gr.Button("添加角色")
                delete_character_button = gr.Button("删除角色")
                ai_choice = gr.Checkbox(True, label="AI's Choice", interactive=True)
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
                    outputs=[character_components_number] + character_components_list,
                )
                delete_character_button.click(
                    delete_character,
                    inputs=character_components_number,
                    outputs=[character_components_number] + character_components_list,
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
                    inputs=naiv4vibebundle_file,
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
            with gr.Tab("法术解析"):
                with gr.Tab("读取信息"):
                    with gr.Row():
                        with gr.Column():
                            pnginfo_image = gr.Image(type="filepath")
                            send_button = gr.Button("发送到图片生成", visible=False)
                            show_all_pnginfo = gr.Checkbox(False, label="显示所有信息")
                        with gr.Column():
                            source = gr.Textbox(label="Source")
                            generation_time = gr.Textbox(label="Generation_time")
                            comment = gr.JSON(label="Comment", open=True)
                            title = gr.Textbox(label="Title")
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
                            title,
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
                            sampler,
                            noise_schedule,
                            legacy_uc,
                        ],
                    )
                with gr.Tab("图片反推"):
                    ...
            with gr.Tab("配置设置"):
                with gr.Row():
                    setting_modify_button = gr.Button("保存")
                    # setting_restart_button = gr.Button("重启")
                setting_output_information = gr.Textbox(show_label=False, visible=False)
                token = gr.Textbox(
                    value=env.token,
                    label="Token",
                    lines=2,
                    visible=True if not env.share else False,
                )
                gr.Markdown(
                    "获取 Token 的方法(The Way to Get Token): [**自述文件(README)**](https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv#%EF%B8%8F-%E9%85%8D%E7%BD%AE)",
                    visible=True if not env.share else False,
                )
                proxy = gr.Textbox(value=env.proxy, label="代理地址")
                custom_path = gr.Textbox(value=env.custom_path, label="自定义路径")
                gr.Markdown("已支持的自动替换路径: <类型>, <日期>, <种子>, <随机字符>, <编号>")
                cool_time = gr.Slider(1, 600, env.cool_time, label="冷却时间")
                gr.Markdown("会上下浮动 1 秒")
                port = gr.Textbox(value=env.port, label="端口号")
                share = gr.Checkbox(value=env.share, label="共享 Gradio 连接")
                setting_modify_button.click(
                    modify_env,
                    inputs=[token, proxy, custom_path, cool_time, port, share],
                    outputs=setting_output_information,
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
        ],
    )
    sm.change(update_components_for_sm_change, inputs=sm, outputs=sm_dyn)
    sampler.change(update_components_for_sampler_change, inputs=sampler, outputs=noise_schedule)


anr.launch(
    inbrowser=True,
    share=env.share,
    server_port=env.port,
    allowed_paths=[f"{d}:" for d in string.ascii_uppercase if Path(f"{d}:").exists()],
)
