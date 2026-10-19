"""插件相关 API: 清单 / 动作 / 商店管理。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from utils import jsonstore
from utils.logger import logger
from utils.paths import STATE_DIR
from utils.plugins import get_manifest, plugins_reload_status, run_action
from utils.services import plugins_store

router = APIRouter(prefix="/api", tags=["plugins"])


@router.get("/plugins/reload-status")
async def plugins_reload_status_route():
    """插件重载状态 (共享开关切换后前端轮询, 完成后自动刷新页面)。"""
    return plugins_reload_status()


# 插件表单值持久化 (跨浏览器/刷新保留上次使用的设置); 落在 data/state 下。
# 读-改-写整体走 jsonstore.update: 两个面板同时保存时不会互相覆盖 (原先各自
# read 再 write, 后写的会把前一个面板刚存的值抹掉)。
_VALUES_PATH = STATE_DIR / "plugin_values.json"


def _load_plugin_values() -> dict:
    return jsonstore.read_dict(_VALUES_PATH)


def _update_plugin_values(mutator) -> dict:
    """对插件表单值做一次原子的读-改-写, 返回更新后的完整数据。"""
    return jsonstore.update(_VALUES_PATH, lambda cur: mutator(cur if isinstance(cur, dict) else {}), default={})


@router.get("/plugins")
async def plugins_manifest():
    return {"plugins": get_manifest()}


@router.get("/plugins/rows")
async def plugin_rows():
    return {"rows": plugins_store.list_plugins()}


@router.post("/plugins/check-updates")
def check_updates():
    """手动联网检查全部已安装插件的更新 (插件列表不再自动检查, 仅点击按钮时联网)。

    同步 def: 逐插件 git ls-remote 是阻塞子进程 (每个最长 25 秒),
    FastAPI 会在线程池执行, 不再冻结事件循环。
    """
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

    def _merge(data: dict) -> dict:
        data.setdefault(plugin_name, {})[panel_id] = payload.get("values", {})
        return data

    _update_plugin_values(_merge)
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
        logger.opt(exception=True).debug("插件加载失败堆栈:")
    # 延迟重启, 让响应先返回。执行体复用 utils.helpers.restart (与设置页同一个实现:
    # 解释器参数 / 环境变量标记都在那里统一维护), 这里只负责"先等响应发出去"。
    import threading
    import time

    def _restart():
        time.sleep(0.6)
        from utils.helpers import restart as _do_restart

        _do_restart()

    threading.Thread(target=_restart, daemon=True).start()
    return {"message": "后端重启中..."}
