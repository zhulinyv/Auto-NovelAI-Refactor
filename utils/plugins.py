"""插件系统: 声明式面板 + 动作, 前端根据清单自动渲染表单。

一个插件 = plugins/ 下的一个目录 (或 .py 文件), 其中 `__init__.py`
导出 `register(plugin)` 函数, 在函数内声明面板与动作:

    def register(plugin: Plugin):
        panel = Panel(
            id="my_panel",
            title="我的面板",
            fields=[Field(id="path", label="路径", type="path")],
            actions=[Action(id="run", label="开始", inputs=["path"], handler=my_handler)],
        )
        plugin.panels.append(panel)

动作处理函数接收字段值字典, 返回:
- 字典: {"text": str, "images": [路径], "image": 路径}
- 字符串: 作为提示信息
- 生成器: 每个产出作为实时事件推送给前端 (如随机画风的连续预览)
"""
from __future__ import annotations

import importlib.util
import inspect
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from utils.config import env
from utils.helpers import install_requirements, read_json
from utils.jobs import jobs
from utils.logger import logger

PLUGINS_ROOT = Path("./plugins").resolve()

# ---------------------------------------------------------------- 数据类型


@dataclass
class Field:
    """声明式字段定义, 前端据此渲染控件。"""

    id: str
    label: str
    type: str = "text"  # text|textarea|number|slider|checkbox|checkbox_group|radio|select|path|image|filearea|color|info
    default: Any = None
    options: list | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    placeholder: str = ""
    description: str = ""
    multiple: bool = False
    show_if: dict | None = None  # {"field": "method", "equals": "像素"} 或 {"contains": "YOLO"}
    rows: int = 2
    folder: bool = True  # type="path" 时是否显示"文件夹"按钮
    file: bool = True    # type="path" 时是否显示"文件"按钮
    autocomplete: bool = False  # type="textarea"/"text" 时是否启用提示词自动补全
    accept: str = ""     # type="filearea" 时限制文件类型 (如 ".xlsx, .xls")


@dataclass
class Action:
    """一个可点击的动作按钮。"""

    id: str
    label: str
    inputs: list[str] = field(default_factory=list)
    handler: Callable = None
    output: str = "auto"  # auto|gallery|image|text|info
    description: str = ""


@dataclass
class Panel:
    """一个面板 (对应前端一个子页签)。"""

    id: str
    title: str
    icon: str = "🌸"
    description: str = ""
    fields: list[Field] = field(default_factory=list)
    actions: list[Action] = field(default_factory=list)
    show_output: bool = True  # False 时不渲染输出区, 结果用右上角通知展示


class Plugin:
    """插件实例: 由 register() 填充面板后注册到全局。"""

    def __init__(self, name: str, module: Any):
        self.name = name
        self.module = module
        self.title = name
        self.description = ""
        self.icon = "🧩"
        self.panels: list[Panel] = []


_registry: dict[str, Plugin] = {}


# ---------------------------------------------------------------- 注册与加载


def register_plugin(plugin: Plugin) -> None:
    _registry[plugin.name] = plugin
    logger.success(f"插件已注册: {plugin.name} ({len(plugin.panels)} 个面板)")


def _load_plugin_module(location: str, plugin_name: str) -> Any:
    module_name = f"plugins.{plugin_name.replace('.py', '').replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_plugins() -> None:
    """扫描 ./plugins 目录并加载所有插件 (跳过禁用列表)。"""
    global _registry
    _registry = {}

    if env.share or env.disable_all_plugins:
        logger.warning("插件加载已跳过 (share 或 disable_all_plugins 开启)")
        return

    try:
        disable_list = read_json("./outputs/temp_plugins.json").get("disable_plugin", [])
    except FileNotFoundError:
        disable_list = []

    PLUGINS_ROOT.mkdir(parents=True, exist_ok=True)

    for plugin in sorted(os.listdir(PLUGINS_ROOT)):
        if plugin in disable_list:
            logger.warning(f"插件 {plugin} 已禁用, 跳过加载")
            continue
        if plugin == "__pycache__":
            continue

        plugin_path = (PLUGINS_ROOT / plugin).resolve()
        if not plugin_path.is_relative_to(PLUGINS_ROOT):
            logger.warning(f"已跳过非法插件路径: {plugin}")
            continue

        if plugin.endswith(".py"):
            location = str(plugin_path)
        else:
            req = plugin_path / "requirements.txt"
            if req.exists():
                install_requirements(str(req))
            location = str(plugin_path / "__init__.py")

        try:
            module = _load_plugin_module(location, plugin)
        except Exception as e:
            logger.error(f"插件 {plugin} 导入失败: {e}")
            logger.opt(exception=True).debug(f"插件 {plugin} 导入失败堆栈:")
            continue

        register_fn = getattr(module, "register", None)
        if not callable(register_fn):
            logger.warning(f"插件 {plugin} 没有 register() 函数, 已跳过")
            continue

        try:
            instance = Plugin(plugin, module)
            register_fn(instance)
            if instance.panels:
                register_plugin(instance)
            else:
                logger.warning(f"插件 {plugin} 没有注册任何面板")
        except Exception as e:
            logger.error(f"插件 {plugin} 注册失败: {e}")
            logger.opt(exception=True).debug(f"插件 {plugin} 注册失败堆栈:")


def get_plugins() -> list[Plugin]:
    return list(_registry.values())


# ---------------------------------------------------------------- 对外接口


def get_manifest() -> list[dict]:
    """返回给前端渲染的插件清单 (不含函数)。"""
    manifest = []
    for plugin in _registry.values():
        panels = []
        for panel in plugin.panels:
            panels.append(
                {
                    "id": panel.id,
                    "title": panel.title,
                    "icon": panel.icon,
                    "description": panel.description,
                    "show_output": panel.show_output,
                    "fields": [f.__dict__ for f in panel.fields],
                    "actions": [
                        {"id": a.id, "label": a.label, "inputs": a.inputs, "output": a.output, "description": a.description}
                        for a in panel.actions
                    ],
                }
            )
        manifest.append(
            {
                "name": plugin.name,
                "title": plugin.title,
                "description": plugin.description,
                "icon": plugin.icon,
                "panels": panels,
            }
        )
    return manifest


def run_action(plugin_name: str, panel_id: str, action_id: str, values: dict) -> str:
    """执行插件动作 (后台线程), 返回 job_id。"""
    plugin = _registry.get(plugin_name)
    if plugin is None:
        raise KeyError(f"插件不存在: {plugin_name}")
    panel = next((p for p in plugin.panels if p.id == panel_id), None)
    if panel is None:
        raise KeyError(f"面板不存在: {plugin_name}/{panel_id}")
    action = next((a for a in panel.actions if a.id == action_id), None)
    if action is None:
        raise KeyError(f"动作不存在: {plugin_name}/{panel_id}/{action_id}")

    def _execute():
        result = action.handler(values)
        if inspect.isgenerator(result):
            final = None
            try:
                while True:
                    item = next(result)
                    if isinstance(item, tuple):
                        item = {"prompt": item[0], "image": item[1]}
                    if isinstance(item, dict):
                        jobs.emit("preview", item)
                        final = item
            except StopIteration as stop:
                if getattr(stop, "value", None):
                    final = stop.value
            return final or {}
        return result

    return jobs.submit(f"plugin:{plugin_name}/{action_id}", _execute)
