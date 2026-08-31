"""Auto-NovelAI-Refactor 入口: 启动 FastAPI 服务并打开浏览器。"""

from __future__ import annotations

import os
import sys
import threading
import webbrowser
from pathlib import Path

# 统一 UTF-8 输出, 避免 Windows 控制台中文乱码
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 切换到项目根目录, 保证相对路径 (./outputs 等) 始终正确
BASE_DIR = Path(__file__).resolve().parent
os.chdir(BASE_DIR)
sys.path.insert(0, str(BASE_DIR))

from utils.config import env  # noqa: E402
from utils.helpers import apply_console_visibility, check_update, playsound  # noqa: E402
from utils.logger import logger, loguru_to_rich  # noqa: E402
from utils.plugins import load_plugins  # noqa: E402
from utils.variable import VERSION  # noqa: E402

if env.proxy:
    os.environ["http_proxy"] = env.proxy
    os.environ["https_proxy"] = env.proxy

# 按配置隐藏终端黑窗口 (仅 Windows): 隐藏后请通过 WebUI 右上角的关闭按钮退出
if env.hide_terminal:
    apply_console_visibility()

# 确保必要目录存在
for d in ("./outputs", "./plugins", "./wildcards"):
    Path(d).mkdir(parents=True, exist_ok=True)

is_updated, commit = check_update(BASE_DIR)
status = VERSION if is_updated else commit

logger.success(
    loguru_to_rich(
        f"""<c>
 █████╗ ███╗   ██╗██████╗     <y>###################################################</y>
██╔══██╗████╗  ██║██╔══██╗    <y># This project is completely <r>OPEN SOURCE</r> and <r>FREE</r> #</y>
███████║██╔██╗ ██║██████╔╝    <y>###################################################</y>
██╔══██║██║╚██╗██║██╔══██╗    Version:    {VERSION}
██║  ██║██║ ╚████║██║  ██║    Author:     https://github.com/zhulinyv
╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝    Repository: https://github.com/zhulinyv/Auto-NovelAI-Refactor</c>"""
    )
)

# 启动提示音: 进入加载阶段即后台播放, 与插件加载并行以节省时间
if env.start_sound:
    threading.Thread(target=playsound, args=("./assets/llss.mp3",), daemon=True).start()

logger.info("正在加载插件...")
load_plugins()
logger.info("插件加载完成")

import uvicorn  # noqa: E402

from server.app import create_app  # noqa: E402

app = create_app()


def _open_browser():
    webbrowser.open(f"http://127.0.0.1:{env.port}")


if __name__ == "__main__":
    # 重启后不重新打开浏览器窗口, 由前端刷新原窗口
    if os.environ.get("ANR_SKIP_BROWSER") != "1":
        threading.Timer(1.5, _open_browser).start()
    # 启动后在终端打印一次访问地址 (只保留一条, 不再输出带版本号的 INFO 日志)
    print(f"WebUI 已启动: http://127.0.0.1:{env.port}")
    uvicorn.run(app, host="127.0.0.1", port=env.port, log_level="warning")
