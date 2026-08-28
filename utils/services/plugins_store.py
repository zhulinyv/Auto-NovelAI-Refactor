"""插件商店服务: 从插件仓库安装 / 卸载 / 启停插件。"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import ujson as json

from utils.config import env
from utils.helpers import check_update, read_json, update_repo
from utils.logger import logger
from utils.plugins import load_plugins

try:
    from git import Repo
except Exception:
    os.environ["PATH"] = os.path.abspath("./Git/cmd")
    from git import Repo


def _plugin_registry() -> dict:
    return read_json("./assets/plugins.json")


def list_plugins() -> list[dict]:
    """返回插件商店表格数据 (含安装状态)。"""
    plugins = _plugin_registry()
    try:
        disable_list = read_json("./outputs/temp_plugins.json").get("disable_plugin", [])
    except FileNotFoundError:
        disable_list = []

    rows = []
    for key, info in plugins.items():
        path = f"./plugins/{info['name']}"
        if os.path.exists(path):
            if key in disable_list:
                status = "已禁用"
            elif not env.check_update:
                status = "已安装"
            else:
                _status, commit = check_update(path)
                if _status:
                    status = "已安装"
                elif commit not in ["远程分支不存在", "更新检查已关闭"]:
                    status = "更新可用"
                else:
                    status = "版本检查失败"
        else:
            status = "未安装"
        rows.append(
            {
                "name": info["name"],
                "description": info["description"],
                "url": info["url"],
                "author": info["author"],
                "status": status,
            }
        )
    # 本地插件
    for p in sorted(os.listdir("./plugins")):
        if p == "__pycache__":
            continue
        name = p.replace(".py", "")
        if name not in {r["name"] for r in rows}:
            rows.append({"name": name, "description": "本地插件", "url": "", "author": "未知", "status": "已安装"})
    return rows


def install_plugin(name: str) -> str:
    if env.share:
        return "共享模式下禁止安装或更新插件"
    data = _plugin_registry()
    if not name or name not in data:
        return "请选择有效插件"
    plugin_path = f"./plugins/{data[name]['name']}"
    if os.path.exists(plugin_path):
        return update_repo(plugin_path)
    logger.info(f"正在安装 {name}...")
    for i in range(3):
        try:
            Repo.clone_from(data[name]["url"], plugin_path)
            break
        except Exception as e:
            logger.error(f"克隆失败: {e}")
            logger.warning(f"正在重试 {i + 1}/3")
    else:
        return "安装失败, 请检查网络后重试"
    logger.success("安装完成!")
    load_plugins()
    return "安装完成, 重启后生效!"


def uninstall_plugin(name: str) -> str:
    if env.share:
        return "共享模式下禁止删除插件"
    if not name:
        return "请选择有效插件"
    plugins_root = os.path.abspath("./plugins")
    path = os.path.abspath(f"./plugins/{name}")
    if path == plugins_root or os.path.commonpath([plugins_root, path]) != plugins_root:
        return "非法插件路径"
    os.chmod(path, 0o777)
    try:
        shutil.rmtree(path)
    except Exception:
        subprocess.run(["del", path, "/s", "/q", "/f"], shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["rmdir", path, "/s", "/q"], shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    logger.success(f"已删除插件: {name}")
    return "删除成功, 重启后生效!"


def toggle_plugin(name: str) -> str:
    if env.share:
        return "共享模式下禁止启用或禁用插件"
    if not name:
        return "请选择有效插件"
    try:
        disable_list = read_json("./outputs/temp_plugins.json").get("disable_plugin", [])
    except FileNotFoundError:
        disable_list = []
    if name in disable_list:
        disable_list.remove(name)
        message = f"插件 {name} 已启用 (点击应用后生效)"
    else:
        disable_list.append(name)
        message = f"插件 {name} 已禁用 (点击应用后生效)"
    os.makedirs("./outputs", exist_ok=True)
    with open("./outputs/temp_plugins.json", "w", encoding="utf-8") as f:
        json.dump({"disable_plugin": disable_list}, f, ensure_ascii=False)
    return message
