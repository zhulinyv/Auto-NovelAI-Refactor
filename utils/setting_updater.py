import gradio as gr


def _modify_env(**kwargs: dict):
    keys = list(kwargs.keys())
    for target_key in keys:
        new_value = kwargs[target_key]
        with open(".env", "r", encoding="utf-8") as f:
            lines = f.readlines()
            f.seek(0)
            setting = f.read()
        if not any(line.split("=", 1)[0].strip() == target_key for line in setting.splitlines()):
            with open(".env", "w", encoding="utf-8") as f:
                f.write(setting + f"\n{target_key}={new_value}\n")
        else:
            for i, line in enumerate(lines):
                if line.startswith(target_key + "="):
                    lines[i] = f"{target_key}={new_value}\n"
                    break
            with open(".env", "w", encoding="utf-8") as f:
                f.writelines(lines)
    return


def modify_env(
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
    skip_inquire_anlas,
    smtp_num,
    smtp_mail,
    smtp_token,
):
    _modify_env(
        token=f'"{token}"'.replace("\n", ""),
        proxy=f'"{proxy}"'.replace("\n", ""),
        custom_path=f'"{custom_path}"'.replace("\n", ""),
        cool_time=cool_time,
        port=port,
        share=share,
        start_sound=start_sound,
        finish_sound=finish_sound,
        check_update=check_update,
        theme=f'"{theme}"',
        format_input=format_input,
        skip_inquire_anlas=skip_inquire_anlas,
        smtp_num=smtp_num,
        smtp_mail=f'"{smtp_mail}"',
        smtp_token=f'"{smtp_token}"',
    )
    return gr.update(value="修改已保存, 重启后生效!", visible=True)
