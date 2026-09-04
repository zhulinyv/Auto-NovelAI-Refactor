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
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from utils.config import env
from utils.gen_queue import gen_queue
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
    type: str = (
        "text"  # text|textarea|number|slider|checkbox|checkbox_group|radio|select|path|image|filearea|color|info
    )
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
    file: bool = True  # type="path" 时是否显示"文件"按钮
    autocomplete: bool = False  # type="textarea"/"text" 时是否启用提示词自动补全
    accept: str = ""  # type="filearea" 时限制文件类型 (如 ".xlsx, .xls")
    no_drag: bool = False  # type="filearea" 时仅允许点击选择文件, 禁用拖拽
    direct_path: bool = False  # type="filearea" 时用原生对话框取真实路径, 不上传
    hidden: bool = False  # 默认隐藏 (前端可通过彩蛋键位解锁显示, 如 naiv4vibebundle 的 Konami 码)
    column: str = "left"  # "left"|"right" — 字段渲染到插件页面的左列(表单)或右列(输出/图表/说明)
    inputs: list[str] = field(default_factory=list)  # type="chart" 时监听变化的参数 id 列表
    corner_of: str = ""  # type="select" 时作为角标下拉附属于指定字段 (如提示词预设)
    row_group: str = ""  # 相邻字段同一 row_group 时渲染到同一行 (如 variety 与 decrisp 并排)
    autosize: bool = False  # type="textarea" 时高度随内容自适应 (有最大行数限制)
    sync: str = ""  # 联动: "WxH" 表示选择 "宽x高" 选项时自动写入 inputs 指定的宽高字段
    on_text: str = ""  # type="toggle" 时开启状态按钮文字
    off_text: str = ""  # type="toggle" 时关闭状态按钮文字


@dataclass
class Action:
    """一个可点击的动作按钮。"""

    id: str
    label: str
    inputs: list[str] = field(default_factory=list)
    handler: Callable = None
    output: str = "auto"  # auto|gallery|image|text|info
    description: str = ""
    show_output: bool = True  # 是否创建输出信息框 (False 时仅显示 toast)
    set_field: str = ""  # 完成后将 content 设置到该字段 (如恢复文件内容到 textarea)
    stop: bool = True  # 是否在该面板显示"停止"按钮 (耗时动作保留, 快捷动作可关闭)
    uses_novelai: bool = (
        True  # 是否调用 NovelAI API: True 时进入生图队列 (排队/冷却/多 Token 并发), False 时走本地多线程立即执行
    )


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
    inline_actions: bool = False  # True 时动作按钮渲染在面板体内 (而非顶栏)
    reset_defaults: bool = False  # True 时添加"还原默认参数"按钮


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


# 重载状态: 共享链接开关切换后前端需要感知 "插件正在重载", 完成后自动刷新页面
_reload_lock = threading.Lock()
_reloading = False
_last_reload_done = 0.0


def mark_plugins_reloading() -> None:
    """在触发重载的请求线程内同步标记 (让保存响应返回前状态就绪)。"""
    global _reloading
    with _reload_lock:
        _reloading = True


def plugins_reload_status() -> dict:
    with _reload_lock:
        return {"reloading": _reloading, "done_at": _last_reload_done}


def load_plugins() -> None:
    """扫描 ./plugins 目录并加载所有插件 (跳过禁用列表)。"""
    global _registry, _reloading, _last_reload_done
    with _reload_lock:
        _reloading = True
    try:
        _load_all_plugins()
    finally:
        with _reload_lock:
            _reloading = False
            _last_reload_done = time.time()


def _load_all_plugins() -> None:
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
                    "inline_actions": panel.inline_actions,
                    "reset_defaults": panel.reset_defaults,
                    "fields": [f.__dict__ for f in panel.fields],
                    "actions": [
                        {
                            "id": a.id,
                            "label": a.label,
                            "inputs": a.inputs,
                            "output": a.output,
                            "description": a.description,
                            "show_output": a.show_output,
                            "set_field": a.set_field,
                            "stop": a.stop,
                            "uses_novelai": a.uses_novelai,
                        }
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


def run_action(plugin_name: str, panel_id: str, action_id: str, values: dict) -> tuple[str, bool]:
    """执行插件动作: NovelAI 类动作进生图队列, 其余本地多线程执行。返回 (job_id, queued)。"""
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

    job_name = f"plugin:{plugin_name}/{panel_id}/{action_id}"
    if action.uses_novelai:
        task = gen_queue.submit(job_name, _execute, label=f"{plugin.title} · {action.label}")
        return task.id, True
    return jobs.submit(f"{job_name}", _execute), False
