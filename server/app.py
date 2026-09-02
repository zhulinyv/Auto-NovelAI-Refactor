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
from utils.logger import logger
from utils.services import plugins_store

# 注意: 不能把路由模块导入为裸名 "queue", 否则会遮蔽标准库 queue,
# 导致 /api/events 的 except queue.Empty 抛 AttributeError, SSE 事件流整体失效
from .routes import generate, misc, plugins, settings, tools
from .routes import queue as queue_routes


def create_app() -> FastAPI:
    app = FastAPI(title="Auto-NovelAI-Refactor", version="2.0.4")

    # 后台预热常用缓存: 插件商店数据 (含 git 检查) 与提示词补全标签词典,
    # 避免打开商店页 / 首次输入提示词时的首次加载等待
    def _warm_caches():
        try:
            plugins_store.list_plugins()
        except Exception as e:
            logger.warning(f"插件商店数据预热失败: {e}")
        try:
            from .routes import misc

            misc._get_tag_cache()
        except Exception as e:
            logger.warning(f"标签词典预热失败: {e}")
        # 在线翻译多源引擎: 后台预导入 translators 库 (首次在线翻译不再卡几秒)
        try:
            from utils.translate import _get_tss

            _get_tss()
        except Exception as e:
            logger.debug(f"在线翻译库预热失败: {e}")

    threading.Thread(target=_warm_caches, daemon=True, name="warmup").start()

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
