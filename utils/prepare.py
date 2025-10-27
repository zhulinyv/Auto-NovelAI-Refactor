import os
import shutil
from urllib.request import getproxies

from utils import check_update, playsound, read_json
from utils.environment import env
from utils.logger import logger
from utils.variable import BASE_PATH, VERSION

if not os.path.exists("./outputs"):
    os.mkdir("./outputs")

if not os.path.exists(".env"):
    shutil.copyfile(".env.example", ".env")

if os.path.exists("last.json"):
    last_data = read_json("last.json")
    parameters = last_data.get("parameters", {})
    _model = (last_data.get("model", "nai-diffusion-4-5-full")).replace("-inpainting", "")
    if _model == "nai-diffusion-4-curated":
        _model = "nai-diffusion-4-curated-preview"
else:
    last_data = {}
    parameters = {}
    _model = "nai-diffusion-4-5-full"

if env.proxy:
    os.environ["http_proxy"] = env.proxy
    os.environ["https_proxy"] = env.proxy

try:
    proxies = getproxies()
    os.environ["http_proxy"] = proxies["http"]
    os.environ["https_proxy"] = proxies["https"]
    os.environ["no_proxy"] = proxies.get("no", "localhost, 127.0.0.1, ::1")
except KeyError:
    pass

is_updated, commit = check_update(BASE_PATH)
if is_updated:
    is_updated = VERSION
else:
    is_updated = commit

logger.opt(colors=True).success(
    f"""<c>
 █████╗ ███╗   ██╗██████╗     <y>###################################################</y>
██╔══██╗████╗  ██║██╔══██╗    <y># This project is completely <r><i><u>OPEN SOURCE</u></i></r> and <r><i><u>FREE</u></i></r> #</y>
███████║██╔██╗ ██║██████╔╝    <y>###################################################</y>
██╔══██║██║╚██╗██║██╔══██╗    Version:    {VERSION}
██║  ██║██║ ╚████║██║  ██║    Author:     https://github.com/zhulinyv
╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝    Repository: https://github.com/zhulinyv/Auto-NovelAI-Refactor</c>"""
)

playsound("./assets/llss.mp3")
