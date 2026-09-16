# -*- coding: utf-8 -*-
"""开始菜单唤醒入口: ANR 没运行时也能"点图标直达界面"。

由开始菜单 "Auto-NovelAI-Refactor.lnk" 以 pythonw (无控制台) 拉起, 流程:
  1. 探测 /api/state (与 main.py 双开守卫同判据: 200 且含 version 字段);
  2. 未运行则 CREATE_NO_WINDOW 拉起 `run.bat` 无参 (复用其探测链; 可见性由 run.bat 自己的
     hide_terminal 自检分流决定; ANR_SKIP_BROWSER=1 让开窗动作归本脚本统一执行);
     具名互斥防连点时第二个实例只等就绪不重复 spawn;
  3. 就绪后调 utils.tray.open_webui(): 走 explorer + 隐藏 AUMID 快捷方式通道,
     与托盘"打开"完全同一实现 (任务栏 ANR 图标、置前、强杀语义一致);
  4. pythonw 没有终端可看, 失败一律 MessageBoxW 弹窗示警。
"""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
FALLBACK_PORT = 11451
READY_TIMEOUT_S = 60.0
CREATE_NO_WINDOW = 0x08000000

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))


def _port() -> int:
    try:
        cfg = json.loads((BASE_DIR / "settings.json").read_text(encoding="utf-8"))
        return int(cfg.get("port") or FALLBACK_PORT)
    except Exception:
        return FALLBACK_PORT


def _alive(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1.5) as r:
            return r.status == 200 and "version" in json.loads(r.read(64 * 1024).decode("utf-8", "ignore"))
    except Exception:
        return False


def _message(text: str) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(None, text, "Auto-NovelAI-Refactor", 0x10)  # MB_ICONERROR
    except Exception:
        pass


def main() -> int:
    port = _port()
    if not _alive(port):
        k32 = ctypes.windll.kernel32
        k32.CreateMutexW(None, False, "Local\\AnrWakeSingleton")
        if k32.GetLastError() != 183:  # ERROR_ALREADY_EXISTS: 另一唤醒实例在spawn, 我只等
            subprocess.Popen(
                ["cmd", "/c", str(BASE_DIR / "run.bat")],
                cwd=str(BASE_DIR),
                creationflags=CREATE_NO_WINDOW,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env={**os.environ, "ANR_SKIP_BROWSER": "1"},
            )
        deadline = time.monotonic() + READY_TIMEOUT_S
        while time.monotonic() < deadline:
            time.sleep(0.5)
            if _alive(port):
                break
        else:
            _message(f"后端 {READY_TIMEOUT_S:.0f} 秒内未就绪 (端口 {port})。\n可双击 run.bat 查看终端日志排查。")
            return 1
    from utils.tray import open_webui  # 懒加载: 顶层仅标准库

    open_webui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
