import gradio as gr


def _modify_env(**kwargs: dict):
    keys = list(kwargs.keys())
    for target_key in keys:
        new_value = kwargs[target_key]
        with open(".env", "r", encoding="utf-8") as f:
            lines = f.readlines()
            f.seek(0)
            setting = f.read()
        if target_key not in setting:
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
):
    _modify_env(
        token=f'"{token}"'.replace("\n", ""),
        proxy=f'"{proxy}"'.replace("\n", ""),
        custom_path=f'"{custom_path}"'.replace("\n", ""),
        cool_time=cool_time,
        port=port,
        share=share,
    )
    return gr.update(value="修改已保存, 重启后生效!", visible=True)
