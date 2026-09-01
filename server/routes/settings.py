"""配置设置 API。"""

from __future__ import annotations

from fastapi import APIRouter

from utils.helpers import restart, update_repo
from utils.services import settings as settings_service

router = APIRouter(prefix="/api", tags=["settings"])


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
        return {"ok": False, "message": f"保存配置失败: {e}"}


@router.post("/settings/restart")
async def restart_server():
    restart()
    return {"ok": True}


@router.post("/settings/update-repo")
async def update_anr():
    message = update_repo("./")
    return {"message": message}
