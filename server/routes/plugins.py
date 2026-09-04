"""插件相关 API: 清单 / 动作 / 商店管理。"""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, HTTPException

from utils.helpers import read_json
from utils.logger import logger
from utils.plugins import get_manifest, plugins_reload_status, run_action
from utils.services import plugins_store

router = APIRouter(prefix="/api", tags=["plugins"])


@router.get("/plugins/reload-status")
async def plugins_reload_status_route():
    """插件重载状态 (共享开关切换后前端轮询, 完成后自动刷新页面)。"""
    return plugins_reload_status()


# 插件表单值持久化 (跨浏览器/刷新保留上次使用的设置)
_VALUES_PATH = "./outputs/plugin_values.json"


def _load_plugin_values() -> dict:
    try:
        data = read_json(_VALUES_PATH)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_plugin_values(data: dict) -> None:
    os.makedirs(os.path.dirname(_VALUES_PATH), exist_ok=True)
    with open(_VALUES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@router.get("/plugins")
async def plugins_manifest():
    return {"plugins": get_manifest()}


@router.get("/plugins/rows")
async def plugin_rows():
    return {"rows": plugins_store.list_plugins()}


@router.post("/plugins/check-updates")
async def check_updates():
    """手动联网检查全部已安装插件的更新 (插件列表不再自动检查, 仅点击按钮时联网)。"""
    return plugins_store.check_updates()


# 注意: 值持久化路由必须在动作路由之前注册。否则 POST /plugin/{name}/{panel}/values
# 会被先声明的 /plugin/{plugin_name}/{panel_id}/{action_id} 匹配 (action_id="values") 而 404。
@router.get("/plugin/{plugin_name}/{panel_id}/values")
async def plugin_get_values(plugin_name: str, panel_id: str):
    """读取该插件面板上次保存的表单值 (跨浏览器保留)。"""
    data = _load_plugin_values()
    return {"values": data.get(plugin_name, {}).get(panel_id, {})}


@router.post("/plugin/{plugin_name}/{panel_id}/values")
async def plugin_set_values(plugin_name: str, panel_id: str, payload: dict):
    """保存该插件面板的表单值 (颜色/模糊程度等, 换浏览器仍生效)。"""
    data = _load_plugin_values()
    data.setdefault(plugin_name, {})[panel_id] = payload.get("values", {})
    _save_plugin_values(data)
    return {"ok": True}


@router.post("/plugin/{plugin_name}/{panel_id}/{action_id}")
async def plugin_action(plugin_name: str, panel_id: str, action_id: str, payload: dict):
    """执行插件动作: NovelAI 类动作进入生图队列 (queued=True), 其余本地多线程执行。"""
    try:
        job_id, queued = run_action(plugin_name, panel_id, action_id, payload.get("values", {}))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"插件动作执行失败: {e}")
        raise HTTPException(status_code=500, detail=f"插件动作执行失败: {e}")
    return {"job_id": job_id, "queued": queued}


@router.post("/plugins/install")
async def install(payload: dict):
    return {"message": plugins_store.install_plugin(payload.get("name", ""))}


@router.post("/plugins/uninstall")
async def uninstall(payload: dict):
    return {"message": plugins_store.uninstall_plugin(payload.get("name", ""))}


@router.post("/plugins/toggle")
async def toggle(payload: dict):
    return {"message": plugins_store.toggle_plugin(payload.get("name", ""))}


@router.post("/plugins/apply")
async def apply_plugins():
    """应用插件变更并重启后端。"""
    from utils.plugins import load_plugins

    try:
        load_plugins()
    except Exception as e:
        logger.error(f"插件加载失败: {e}")
    # 延迟重启, 让响应先返回 (与 run.bat 一致: -X utf8)
    import os
    import sys
    import threading
    import time

    def _restart():
        time.sleep(0.6)
        # 标记为重启: 重启后不再自动打开浏览器窗口
        os.environ["ANR_SKIP_BROWSER"] = "1"
        os.execv(sys.executable, [sys.executable, "-X", "utf8"] + sys.argv)

    threading.Thread(target=_restart, daemon=True).start()
    return {"message": "后端重启中..."}
