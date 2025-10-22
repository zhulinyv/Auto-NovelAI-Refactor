import os
import shutil
from urllib.request import getproxies

from utils import read_json

if not os.path.exists("./outputs"):
    os.mkdir("./outputs")

if not os.path.exists(".env"):
    shutil.copyfile(".env.example", ".env")

if os.path.exists("last.json"):
    start_data = read_json("last.json")
    _model = (start_data["model"]).replace("-inpainting", "")
    if _model == "nai-diffusion-4-curated":
        _model = "nai-diffusion-4-curated-preview"
else:
    _model = "nai-diffusion-4-5-full"

try:
    proxies = getproxies()
    os.environ["http_proxy"] = proxies["http"]
    os.environ["https_proxy"] = proxies["https"]
    os.environ["no_proxy"] = proxies.get("no", "localhost, 127.0.0.1, ::1")
except KeyError:
    pass
