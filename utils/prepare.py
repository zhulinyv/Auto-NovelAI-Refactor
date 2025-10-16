import os
import shutil

from utils import read_json

if not os.path.exists("./outputs"):
    os.mkdir("./outputs")

if not os.path.exists(".env"):
    shutil.copyfile(".env.example", ".env")

if os.path.exists("last.json"):
    start_data = read_json("last.json")
    _model = start_data["model"]
else:
    _model = "nai-diffusion-4-5-full"
