"""FastAPI 应用: 组装路由、静态资源与 SSE 事件流。"""

from __future__ import annotations

import asyncio
import json
import queue
import threading

from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from utils.config import BASE_DIR
from utils.events import broker
from utils.gen_queue import gen_queue
from utils.logger import logger
from utils.services import plugins_store
from utils.variable import VERSION

# 注意: 不能把路由模块导入为裸名 "queue", 否则会遮蔽标准库 queue,
# 导致 /api/events 的 except queue.Empty 抛 AttributeError, SSE 事件流整体失效
from .routes import generate, misc, plugins, settings, tools
from .routes import queue as queue_routes


def create_app() -> FastAPI:
    # version 取自 utils/variable.VERSION (发布唯一真源, main.py 横幅同用它);
    # 别再在这里写死号, 否则 openapi.json 与页面/终端三处会各说各话 (方案 P1-6)
    app = FastAPI(title="Auto-NovelAI-Refactor", version=VERSION)

    # 后台预热常用缓存: 插件商店数据 (含 git 检查) 与提示词补全标签词典,
    # 避免打开商店页 / 首次输入提示词时的首次加载等待
    def _warm_caches():
        # 顺序: 先本地必用的 (标签词典 ~2.5s 纯 CPU, 提示词补全第一输入就依赖),
        # 再排慢的网络/外部进程 (点数查询最坏 N×45s、插件商店含 git)。
        # 原先最慢的网络调用排在最前, 把标签预热挤到几十秒后 (方案 P1-1 配套)。
        # 点数查完仍会通过 anlas:update 事件刷新输出区右上角徽标, 只是晚于词典就绪。
        try:
            misc._get_tag_cache()
        except Exception as e:
            logger.warning(f"标签词典预热失败: {e}")
            logger.opt(exception=True).debug("标签词典预热失败堆栈:")
        try:
            from utils.generator import inquire_all_anlas

            inquire_all_anlas()
        except Exception as e:
            logger.debug(f"启动查询剩余点数失败: {e}")
            logger.opt(exception=True).debug("启动查询剩余点数失败堆栈:")
        try:
            plugins_store.list_plugins()
        except Exception as e:
            logger.warning(f"插件商店数据预热失败: {e}")
            logger.opt(exception=True).debug("插件商店数据预热失败堆栈:")
        # 在线翻译多源引擎: 后台预导入 translators 库 (首次在线翻译不再卡几秒)
        try:
            from utils.translate import _get_tss

            _get_tss()
        except Exception as e:
            logger.debug(f"在线翻译库预热失败: {e}")
            logger.opt(exception=True).debug("在线翻译库预热失败堆栈:")

    threading.Thread(target=_warm_caches, daemon=True, name="warmup").start()

    # 停止信号文件 (outputs/temp_break_<任务id>.json) 的清理机制:
    # 进程被杀 (插件变更 os.execv 重启 / 关窗 / 崩溃) 时任务来不及删自己的文件, 会一直堆积。
    # 这里启动时先清一次历史残留, 之后交给定期线程 + 退出兜底 (详见 utils/jobs.py)。
    try:
        from utils.jobs import start_break_cleanup

        removed = start_break_cleanup()
        if removed:
            logger.info(
                f"已清理 {len(removed)} 个无用的停止信号文件: {', '.join(removed[:5])}"
                f"{' ...' if len(removed) > 5 else ''}"
            )
    except Exception as e:
        logger.debug(f"停止信号文件清理机制启动失败 (不影响任务): {e}")
        logger.opt(exception=True).debug("停止信号文件清理机制启动失败堆栈:")

    # 静态资源禁用启发式缓存: 每次用 ETag 协商, 文件有改动立即生效
    @app.middleware("http")
    async def _no_cache_static(request, call_next):
        response = await call_next(request)
        if request.method == "GET" and not request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    # API 路由
    app.include_router(misc.router)
    app.include_router(generate.router)
    app.include_router(tools.router)
    app.include_router(plugins.router)
    app.include_router(queue_routes.router)
    app.include_router(settings.router)

    # 事件流 (SSE): 实时推送日志与任务状态
    @app.get("/api/events")
    async def events():
        async def stream():
            q = broker.subscribe()
            try:
                # 先补发历史日志事件 (刷新页面后日志不丢失); 跳过 job/queue 事件, 避免刷新后重复弹 toast
                for ev in broker.history("log"):
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                while True:
                    try:
                        ev = q.get_nowait()
                        yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                    except queue.Empty:
                        await asyncio.sleep(0.5)
                        yield ": keepalive\n\n"
            finally:
                broker.unsubscribe(q)

        return StreamingResponse(stream(), media_type="text/event-stream")

    # 共享链接 (隧道) 访问时 Cloudflare 会缓冲 SSE 实时流, 前端退化为轮询本接口:
    # 增量拉取日志 + 队列快照, 每 2 秒一次
    @app.get("/api/live")
    async def live_poll(log_after: int = 0, notify_after: int = 0, anlas_after: int = 0):
        seq_now = broker.current_seq()
        if log_after > seq_now:
            log_after = 0  # 后端重启后序号已重置, 前端序号失效时重新全量拉取
        if notify_after > seq_now:
            notify_after = 0
        if anlas_after > seq_now:
            anlas_after = 0
        logs = broker.history_after("log", log_after)
        notifications = broker.history_after("notice", notify_after)
        anlas_events = broker.history_after("anlas:update", anlas_after)
        last = logs[-1]["seq"] if logs else min(log_after, seq_now)
        notify_last = notifications[-1]["seq"] if notifications else min(notify_after, seq_now)
        anlas_last = anlas_events[-1]["seq"] if anlas_events else min(anlas_after, seq_now)
        return {
            "logs": logs,
            "last": last,
            "notifications": notifications,
            "notify_last": notify_last,
            "anlas": anlas_events,
            "anlas_last": anlas_last,
            "queue": gen_queue.snapshot(),
        }

    # 图标
    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon():
        return FileResponse(BASE_DIR / "assets" / "logo.ico")

    # 静态资源 (assets 目录: logo 图片等)
    @app.get("/assets/{filename}", include_in_schema=False)
    async def asset(filename: str):
        from pathlib import Path as _P

        safe = _P(filename).name  # 防目录穿越
        return FileResponse(BASE_DIR / "assets" / safe)

    # 静态前端 (必须最后挂载, 否则会拦截 /api)
    web_dir = BASE_DIR / "web"
    if web_dir.exists():
        app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")
    else:
        logger.error("web 目录不存在, 无法提供前端页面!")

    return app
