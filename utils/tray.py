"""系统托盘: 右键菜单 打开 / 重启 / 关闭。

- 图标与浏览器标签页 favicon 同源 (assets/logo.ico)。
- "打开"优先使用默认浏览器 (Chromium 系) 的 --app 独立窗口: 独立 profile + PID 落盘,
  可前置激活、可被"关闭"强杀; 默认浏览器非 Chromium 系时退回 webbrowser 普通标签页
  (浏览器安全模型限制, 普通标签页无法从后端强杀, "关闭"此时只结束后端)。
- "重启"等价于 WebUI 内重启 (os.execl 原地替换, 共享隧道沿用), 并由独立助手进程
  等后端端口就绪后重新打开 webui 窗口。
- 托管浏览器窗口 PID 经 .webui-browser/pid 跨进程保留: 无论从托盘还是 WebUI 重启,
  新进程都能重新接管旧窗口 ("打开"置前 / "关闭"强杀依然有效)。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.request import urlopen

from utils.config import env
from utils.logger import logger
from utils.variable import VERSION

BASE_DIR = Path(__file__).resolve().parents[1]
ICON_PATH = BASE_DIR / "assets" / "logo.ico"
PROFILE_DIR = BASE_DIR / ".webui-browser"
PID_FILE = PROFILE_DIR / "pid"

# 支持 --app 无地址栏窗口的 Chromium 系浏览器 (未命中则退回普通标签页)
_CHROMIUM_EXES = {"msedge.exe", "chrome.exe", "chromium.exe", "chromium-browser.exe", "vivaldi.exe", "brave.exe", "opera.exe"}
_WINDOW_MARK = "--anr-webui"  # 自有标记: 供 _managed_pid 校验窗口归属, Chromium 忽略未知开关
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def webui_url() -> str:
    return f"http://127.0.0.1:{env.port}"


# ---------------------------------------------------------------- 默认浏览器探测


def _default_browser_exe() -> str | None:
    """读注册表取 HTTP 默认浏览器的可执行文件路径 (仅 Chromium 系返回)。"""
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
        ) as k:
            prog_id, _ = winreg.QueryValueEx(k, "ProgId")
        cmd = None
        for root, sub in (
            (winreg.HKEY_CLASSES_ROOT, prog_id + r"\shell\open\command"),
            (winreg.HKEY_CURRENT_USER, "Software\\Classes\\" + prog_id + "\\shell\\open\\command"),
        ):
            try:
                with winreg.OpenKey(root, sub) as k2:
                    cmd, _ = winreg.QueryValueEx(k2, None)
                break
            except OSError:
                continue
        if not cmd:
            return None
        cmd = winreg.ExpandEnvironmentStrings(cmd)
        exe = cmd.split('"')[1] if cmd.startswith('"') else cmd.split(" ")[0]
        exe = exe.strip()
        if os.path.basename(exe).lower() in _CHROMIUM_EXES and os.path.isfile(exe):
            return exe
    except OSError:
        pass
    return None


# ---------------------------------------------------------------- 托管窗口状态


def _read_pid() -> int | None:
    try:
        return int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None


def _write_pid(pid: int) -> None:
    try:
        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(pid))
    except OSError:
        pass


def _clear_pid() -> None:
    try:
        PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def _managed_pid() -> int | None:
    """当前存活的托管浏览器主进程 PID; 失效时清除记录并返回 None。"""
    pid = _read_pid()
    if not pid:
        return None
    try:
        import psutil

        p = psutil.Process(pid)
        if p.is_running() and p.status() != psutil.STATUS_ZOMBIE and any(_WINDOW_MARK in str(a) for a in p.cmdline()):
            return pid
    except Exception:
        pass
    _clear_pid()
    return None


def _activate_windows(pid: int) -> int:
    """把该进程的可见顶层窗口还原并置前, 返回置前数量。"""
    if sys.platform != "win32":
        return 0
    try:
        import ctypes
        from ctypes.wintypes import BOOL, DWORD, HWND, LPARAM

        user32 = ctypes.windll.user32
        found: list[int] = []

        @ctypes.WINFUNCTYPE(BOOL, HWND, LPARAM)
        def _cb(hwnd, _lparam):
            pid_out = DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_out))
            if pid_out.value == pid and user32.IsWindowVisible(hwnd):
                found.append(int(hwnd))
            return True

        user32.EnumWindows(_cb, 0)
        for hwnd in found:
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
        return len(found)
    except Exception:
        return 0


# ---------------------------------------------------------------- 打开 / 强杀


def open_webui() -> bool:
    """在默认浏览器中打开 webui; 优先激活/拉起可托管的 --app 窗口。

    返回 True 表示托管窗口路径 (可被"关闭"强杀), False 表示退回普通标签页。
    """
    exe = _default_browser_exe()
    if not exe:
        webbrowser.open(webui_url())
        return False
    pid = _managed_pid()
    if pid:
        _activate_windows(pid)
        return True
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        p = subprocess.Popen(
            [
                exe,
                f"--app={webui_url()}",
                _WINDOW_MARK,
                f"--user-data-dir={PROFILE_DIR}",
                "--no-first-run",
                "--no-default-browser-check",
                "--start-maximized",  # 托管窗口默认最大化启动
            ],
            cwd=str(BASE_DIR),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
        )
        _write_pid(p.pid)
        return True
    except OSError:
        webbrowser.open(webui_url())
        return False


def _kill_window() -> None:
    """强杀托管浏览器窗口进程树并清除 PID 记录 (用户手开的普通标签页不在范围)。"""
    pid = _managed_pid()
    _clear_pid()
    if not pid:
        return
    if sys.platform == "win32":
        subprocess.Popen(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
        )
        time.sleep(0.3)  # 给 taskkill 一点时间, 避免随后的后端退出竞争
    else:
        try:
            import psutil

            proc = psutil.Process(pid)
            for child in proc.children(recursive=True):
                child.kill()
            proc.kill()
        except Exception:
            pass


# ---------------------------------------------------------------- 托盘动作


def _on_open(_icon=None, _item=None) -> None:
    open_webui()


def _spawn_wait_open() -> None:
    """独立助手进程: 等后端端口就绪后重新打开 webui 窗口 (本进程 exec/退出后仍存活)。"""
    subprocess.Popen(
        [sys.executable, "-m", "utils.tray", "--wait-open"],
        cwd=str(BASE_DIR),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


def _on_restart(icon=None, _item=None) -> None:
    from utils.helpers import restart

    logger.info("托盘: 重启服务...")
    _kill_window()
    _spawn_wait_open()
    if icon:
        try:
            icon.stop()
        except Exception:
            pass
    restart()  # os.execl 原地替换新进程, ANR_SKIP_BROWSER 由其设置, 窗口交给助手进程重开


def _on_close(icon=None, _item=None) -> None:
    from utils.helpers import shutdown_app

    logger.info("托盘: 关闭程序...")
    _kill_window()
    if icon:
        try:
            icon.stop()
        except Exception:
            pass
    shutdown_app()


# ---------------------------------------------------------------- 托盘启动


def start_tray() -> None:
    """创建托盘图标 (pystray)。依赖缺失或平台不支持时静默降级, 不影响服务启动。"""
    try:
        import pystray
        from PIL import Image
    except ImportError:
        logger.debug("未安装 pystray, 跳过系统托盘")
        return
    try:
        img = Image.open(ICON_PATH)
        img.load()
        img = img.convert("RGBA")
        img.thumbnail((32, 32))
        menu = pystray.Menu(
            pystray.MenuItem("打开", _on_open, default=True),  # 双击托盘图标 = 打开
            pystray.MenuItem("重启", _on_restart),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("关闭", _on_close),
        )
        icon = pystray.Icon("Auto-NovelAI-Refactor", img, f"Auto-NovelAI-Refactor v{VERSION}", menu, visible=True)
        icon.run_detached()
        logger.info("系统托盘已启动 (打开 / 重启 / 关闭)")
    except Exception as e:
        logger.warning(f"系统托盘启动失败: {e}")


def _wait_open_main() -> None:
    """--wait-open 入口: 轮询直至后端可访问, 再打开 webui 窗口 (最长约 60s)。"""
    url = webui_url()
    for _ in range(120):
        time.sleep(0.5)
        try:
            with urlopen(url, timeout=2):
                break
        except Exception:
            continue
    open_webui()


if __name__ == "__main__":  # python -m utils.tray --wait-open
    if "--wait-open" in sys.argv:
        _wait_open_main()
