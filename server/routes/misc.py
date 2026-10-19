"""路由入口汇总: 关闭程序 / 打开保存目录。

历史上这里是一个 1549 行的 misc.py, 把状态 / 图片浏览 / 上传 / wildcards /
提示词补全 / 翻译 / 剩余点数全塞在一起。现已按内聚性拆成:

  system.py     状态 / 就绪 / 上次参数 / 图片浏览与缩略图 / 收藏 / 上传 / 背景 / 一言 / 系统统计
  wildcards.py  /api/wildcards/* 全部
  library.py    标签词典补全 / 提示词库 / 在线翻译
  anlas.py      /api/anlas 与 /api/anlas/refresh

本文件只留两个"不属于上面任何一组"的进程级入口 (关闭程序 / 打开保存目录)。
"""

from __future__ import annotations

import os
import subprocess

from fastapi import APIRouter

from utils.config import BASE_DIR
from utils.helpers import shutdown_app
from utils.services import settings as settings_service  # noqa: F401  (供旧调用方)

from .system import _resolve_allowed

router = APIRouter(prefix="/api", tags=["misc"])


@router.post("/shutdown")
async def shutdown_server():
    """退出程序: 结束后端进程树 (由 run.bat 启动时连同终端一起结束), 供顶栏关闭按钮调用。"""
    shutdown_app()
    return {"message": "已请求退出, 页面即将关闭"}


@router.post("/open-dir")
async def open_save_dir(payload: dict):
    """在系统文件管理器中打开图片保存目录 (未指定路径时打开 outputs 根目录)。"""
    path = (payload.get("path") or "").strip()
    target = _resolve_allowed(path) if path else None
    if target is None:
        target = BASE_DIR / "outputs"
    if target.is_file():
        target = target.parent
    target.mkdir(parents=True, exist_ok=True)
    try:
        os.startfile(str(target))
    except AttributeError:
        subprocess.Popen(["xdg-open", str(target)])
    return {"ok": True}


__all__ = ["router", "_resolve_allowed"]
