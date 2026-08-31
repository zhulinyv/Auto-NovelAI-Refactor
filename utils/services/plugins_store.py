"""插件商店服务: 从插件仓库安装 / 卸载 / 启停插件。"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import ujson as json

from utils.config import env
from utils.helpers import read_json, update_repo
from utils.logger import logger
from utils.plugins import load_plugins

try:
    from git import Repo
except Exception:
    os.environ["PATH"] = os.path.abspath("./Git/cmd")
    from git import Repo


def _plugin_registry() -> dict:
    return read_json("./assets/plugins.json")


# 列表缓存: list_plugins 含逐插件的 git 更新检查 (便携 git 下可达数秒),
# 缓存结果避免每次请求都重算; 安装 / 卸载 / 启停时主动失效
_rows_cache = {"rows": None, "ts": 0.0}
_rows_lock = threading.Lock()
ROWS_CACHE_TTL = 300


def invalidate_rows_cache() -> None:
    with _rows_lock:
        _rows_cache["rows"] = None
        _rows_cache["ts"] = 0.0


def list_plugins() -> list[dict]:
    """返回插件商店表格数据 (含安装状态, 结果短缓存)。"""
    with _rows_lock:
        if _rows_cache["rows"] is not None and time.time() - _rows_cache["ts"] < ROWS_CACHE_TTL:
            return _rows_cache["rows"]
    rows = _list_plugins()
    with _rows_lock:
        _rows_cache["rows"] = rows
        _rows_cache["ts"] = time.time()
    return rows


def _list_plugins() -> list[dict]:
    """返回插件商店表格数据 (只看本地安装/禁用状态, 不联网检查更新)。"""
    plugins = _plugin_registry()
    try:
        disable_list = read_json("./outputs/temp_plugins.json").get("disable_plugin", [])
    except FileNotFoundError:
        disable_list = []

    rows = []
    for key, info in plugins.items():
        path = f"./plugins/{info['name']}"
        if os.path.exists(path):
            status = "已禁用" if key in disable_list else "已安装"
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


def _check_update_online(plugin_path: str) -> str:
    """联网检查单个插件远程仓库是否有更新 (git ls-remote, 不改动本地仓库)。"""
    repo = Repo(plugin_path)
    try:
        branch = repo.active_branch.name
        # GitPython 的 kill_after_timeout 不支持 Windows, 用 subprocess 自带超时
        proc = subprocess.run(
            ["git", "ls-remote", "origin", f"refs/heads/{branch}"],
            cwd=plugin_path,
            capture_output=True,
            text=True,
            timeout=25,
        )
        out = proc.stdout.strip() if proc.returncode == 0 else ""
        remote = out.split()[0] if out else ""
        if not remote:
            return "版本检查失败"
        return "已安装" if repo.head.commit.hexsha == remote else "更新可用"
    finally:
        repo.close()


def check_updates() -> dict:
    """手动联网检查全部已安装插件的更新 (点击"检查更新"按钮时调用), 结果写入缓存。"""
    rows = list_plugins()
    targets = [
        (r, f"./plugins/{r['name']}")
        for r in rows
        if os.path.exists(f"./plugins/{r['name']}") and r["status"] != "已禁用"
    ]

    def _check(item):
        r, path = item
        try:
            return r, _check_update_online(path)
        except Exception:
            return r, "版本检查失败"

    updates = 0
    failed = 0
    if targets:
        with ThreadPoolExecutor(max_workers=min(8, len(targets))) as ex:
            for r, status in ex.map(_check, targets):
                if status == "更新可用":
                    updates += 1
                elif status == "版本检查失败":
                    failed += 1
                r["status"] = status

    with _rows_lock:
        _rows_cache["rows"] = rows
        _rows_cache["ts"] = time.time()

    if failed:
        message = f"检查完成: {updates} 个可更新, {failed} 个检查失败"
    elif updates:
        message = f"检查完成: {updates} 个插件有更新 🎉"
    else:
        message = "检查完成: 全部插件均为最新 ✅"
    return {"rows": rows, "message": message}


def install_plugin(name: str) -> str:
    invalidate_rows_cache()
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
    invalidate_rows_cache()
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
        subprocess.run(
            ["del", path, "/s", "/q", "/f"], shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        subprocess.run(["rmdir", path, "/s", "/q"], shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    logger.success(f"已删除插件: {name}")
    return "删除成功, 重启后生效!"


def toggle_plugin(name: str) -> str:
    invalidate_rows_cache()
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
