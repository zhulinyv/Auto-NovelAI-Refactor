"""配置设置 API。"""

from __future__ import annotations

from fastapi import APIRouter

from utils.config import env
from utils.helpers import restart, update_repo
from utils.services import settings as settings_service

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/share")
async def get_share():
    """共享链接状态: 开关、隧道进程与当前公网链接 (链接在可访问后才返回)。"""
    from utils import tunnel

    return {"share": bool(env.share), **tunnel.get_share_info()}


@router.get("/settings")
async def get_settings():
    return settings_service.get_settings()


@router.post("/settings")
async def save_settings(payload: dict):
    try:
        return settings_service.save_settings(payload)
    except Exception as e:
        from utils.logger import logger

        logger.error(f"保存配置失败: {e}")
        logger.opt(exception=True).debug("保存配置失败堆栈:")
        return {"ok": False, "message": f"保存配置失败: {e}"}


@router.post("/settings/restart")
async def restart_server():
    restart()
    return {"ok": True}


@router.post("/settings/update-repo")
def update_anr():
    """执行 git pull (同步 def: 阻塞网络操作放线程池; update_repo 已带超时, 不会永久占线程)。"""
    message = update_repo("./")
    return {"message": message}
