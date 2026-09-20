# -*- coding: utf-8 -*-
"""开始菜单唤醒入口: ANR 没运行时也能"点图标直达界面"。

由开始菜单 "Auto-NovelAI-Refactor.lnk" 以 pythonw (无控制台) 拉起, 流程:
  1. 探测就绪 (先打轻量的 /api/ready, 老版本后端没有该路由时退回 /api/state;
     判据与 main.py 双开守卫一致: HTTP 200 且响应含 version 字段);
  2. 未运行则 CREATE_NO_WINDOW 拉起 `run.bat` 无参 (复用其探测链; 可见性由 run.bat 自己的
     hide_terminal 自检分流决定; ANR_SKIP_BROWSER=1 让开窗动作归本脚本统一执行);
     具名互斥防连点时第二个实例只等就绪不重复 spawn;
  3. 就绪后调 utils.tray.open_webui(): 走 explorer + 隐藏 AUMID 快捷方式通道,
     与托盘"打开"完全同一实现 (任务栏 ANR 图标、置前、强杀语义一致);
  4. pythonw 没有终端可看, 失败一律 MessageBoxW 弹窗示警 (带上最后一次探测错误)。

探测踩过两个坑, 症状都是"后端明明起来了却报 60 秒未就绪、窗口不自动打开":
  - /api/state 会把 last.json (含 base64 图片) 整个塞进响应里, 实测单次 4.4MB ——
    旧实现的 r.read(64 * 1024) 后 json.loads 必然被截断成 Unterminated string,
    于是永远探不到就绪; 而且每 0.5s 探测一次 = 让服务端白序列化 120 次 4MB (启动跟着变慢)。
    改用 /api/ready (只回版本号); 退回 /api/state 时只读头部查 version 标记即可
    (version 是那边响应的首个字段), 不整读也不整解析。
  - 环回请求不能走代理: 调用方环境里有 http_proxy 且系统代理例外表没有 127.* 时,
    请求会被转发给代理 → 探测失败。这里显式禁用代理。
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
PROBE_TIMEOUT_S = 1.5
PROBE_PATHS = ("/api/ready", "/api/state")
PROBE_HEAD_BYTES = 4096  # /api/state 可达 4MB+, 只读头部找 version 标记 (它是首个字段)
CREATE_NO_WINDOW = 0x08000000

# 环回探测显式禁用代理: 用户环境的 http_proxy / 系统代理例外表缺 127.* 时会误转发给代理
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

_last_error: str | None = None  # 最后一次探测失败原因, 只用于失败弹窗

if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))


def _port() -> int:
    try:
        cfg = json.loads((BASE_DIR / "settings.json").read_text(encoding="utf-8"))
        return int(cfg.get("port") or FALLBACK_PORT)
    except Exception:
        return FALLBACK_PORT


def _alive(port: int) -> bool:
    """后端是否已就绪 (HTTP 200 且响应含 version 字段); 失败原因记进 _last_error。"""
    global _last_error
    for path in PROBE_PATHS:
        try:
            with _OPENER.open(f"http://127.0.0.1:{port}{path}", timeout=PROBE_TIMEOUT_S) as r:
                head = r.read(PROBE_HEAD_BYTES)
            if b'"version"' in head:
                _last_error = None
                return True
            _last_error = f"{path}: 响应里没有 version 字段"
        except Exception as e:  # noqa: BLE001 - 探测失败即"未就绪", 下个周期重试
            _last_error = f"{path}: {type(e).__name__}: {e}"
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
            _message(
                f"后端 {READY_TIMEOUT_S:.0f} 秒内未就绪 (端口 {port})。\n"
                f"最后一次探测: {_last_error or '无响应'}\n"
                "可双击 run.bat 查看终端日志排查。"
            )
            return 1
    from utils.tray import open_webui  # 懒加载: 顶层仅标准库

    open_webui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
