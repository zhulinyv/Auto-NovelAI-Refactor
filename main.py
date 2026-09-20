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
from utils.plugins import load_plugins, mark_plugins_reloading  # noqa: E402
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

# 启动提示音挪到"服务已起、窗口即将打开"那一刻再放 (见文件末尾) ——
# 原来在这里 (import 阶段) 就放: 那会儿离窗口出现还有好几秒, 而提示音只有 2.6s、开头又是轻声
# (0.1s 处就进正片, 中间还有 0.76s 静音), 等用户把注意力挪过来时只剩最后那句响的了,
# 听感就是"前面一部分根本没放"。顺带还避开两个坑: 双开守卫就在下面 (注定退出的重复实例不必再放一次),
# 以及紧接着的插件加载 CPU 高峰。


def _load_plugins_bg():
    try:
        load_plugins()
        logger.info("插件加载完成")
    except Exception as e:
        logger.error(f"插件后台加载失败 (不影响核心服务): {e}")
        logger.opt(exception=True).debug("插件后台加载失败 (不影响核心服务)堆栈:")


# 插件在后台线程加载: 先同步标记"正在加载" (早于 create_app/端口绑定, 无竞态窗口)。
# 前端 /api/state 读到 plugins_reload.reloading=true 后走已有的 800ms 轮询 +
# 完成自动整页刷新通道, 端口绑定不再被插件 pip 安装与 import 期重活拖住。
mark_plugins_reloading()
threading.Thread(target=_load_plugins_bg, daemon=True, name="plugin-load").start()

import uvicorn  # noqa: E402

from server.app import create_app  # noqa: E402

app = create_app()


def _open_browser():
    # 优先走 utils.tray 的托管窗口 (默认浏览器的 --app 独立窗口, 托盘可置前/强杀);
    # 默认浏览器非 Chromium 系或启动失败时退回 webbrowser 普通标签页
    try:
        from utils.tray import open_webui

        if open_webui():
            return
    except Exception as e:
        logger.debug(f"托管窗口打开失败, 退回普通标签页: {e}")
        logger.opt(exception=True).debug("托管窗口打开失败, 退回普通标签页堆栈:")
    webbrowser.open(f"http://127.0.0.1:{env.port}")


if __name__ == "__main__":
    # 双开幂等: 端口已有活的 ANR 实例 (/api/state 应答且带 version 字段, P1-6 真源) 时,
    # 不再起第二个服务也不再炸 bind 错误: 开/激活现成窗口后安静退出。
    # 端口被无关程序占用时探测不通过, 照旧走到 uvicorn.bind 把真冲突暴露出来。
    try:
        import requests

        # 环回探测必须绕开代理: 配了 proxy (且系统/环境代理例外表里没有 127.*) 时请求会被转发给代理,
        # 探测失败 -> "已有实例在跑"被判成"没在跑", 于是又起一个实例: 它会再放一次启动提示音,
        # 接着卡在端口占用上退出 (守护线程被一起收走, 声音半截就断)。utils/wake.py 的同名探测
        # 早就显式绕开了代理 (ProxyHandler({})), 这里补齐同一处理。
        _probe = requests.Session()
        _probe.trust_env = False
        _resp = _probe.get(f"http://127.0.0.1:{env.port}/api/state", timeout=1)
        _alive = _resp.ok and "version" in _resp.json()
    except Exception:
        _alive = False
    if _alive:
        print(f"检测到 ANR 已在运行 (http://127.0.0.1:{env.port}), 直接打开界面...")
        if os.environ.get("ANR_SKIP_BROWSER") != "1":
            _open_browser()
        sys.exit(0)

    if env.share:
        # 共享模式: 启动时自动建立外网访问隧道; 首次启动隧道就绪后自动打开共享链接,
        # 重启 (ANR_SKIP_BROWSER=1) 时沿用旧隧道进程, 由前端刷新原窗口即可恢复
        from utils.tunnel import start_tunnel

        threading.Thread(
            target=start_tunnel,
            args=(os.environ.get("ANR_SKIP_BROWSER") != "1",),
            daemon=True,
            name="share-tunnel",
        ).start()
    elif os.environ.get("ANR_SKIP_BROWSER") != "1":
        # 本地模式: 重启后不重新打开浏览器窗口, 由前端刷新原窗口
        threading.Timer(1.5, _open_browser).start()
    # 启动提示音: 服务已经起来、窗口即将打开 (上面那个 1.5s 定时器) 时才放, 用户正好在屏幕前听全;
    # 双开守卫已经过了, 注定退出的重复实例不会再放一次; 插件加载的 CPU 高峰也已经甩给后台线程,
    # 声卡从省电状态醒来的那几百毫秒不至于把开头吃掉。
    if env.start_sound:
        threading.Thread(target=playsound, args=("./assets/llss.mp3",), daemon=True).start()
    # 启动后在终端打印一次访问地址 (只保留一条, 不再输出带版本号的 INFO 日志)
    print(f"WebUI 已启动: http://127.0.0.1:{env.port}")
    # 系统托盘: 右键 打开/重启/关闭; 依赖缺失自动降级, 不影响服务启动
    try:
        from utils.tray import start_tray

        start_tray()
    except Exception as e:
        logger.debug(f"系统托盘不可用: {e}")
        logger.opt(exception=True).debug("系统托盘不可用堆栈:")
    uvicorn.run(app, host="127.0.0.1", port=env.port, log_level="warning")
