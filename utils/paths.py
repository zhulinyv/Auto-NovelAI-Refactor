"""应用数据目录: data/ 之下的状态、缓存与临时文件统一入口。

为什么要有这一层
----------------
历史上这些文件散落在三处, 各自用字面量路径拼接:

  - 项目根:  settings.json / last.json / bg_state.json / .webui-browser/
  - outputs/: favorites.json / prompt_library.json / translate_cache.json /
             wildcards_order.json / plugin_values.json / bg_state.json(旧) /
             .thumb_cache/ / selector_trash/ / backgrounds/ / temp_break_*.json /
             temp_inpaint_*.png / temp_last_origin.json / temp_selector.npy /
             temp_wildcards.json / temp_plugins.json / temp_character_reference_image.png
  - 插件代码里的 ./outputs/temp_*.png

于是"应用状态"与"用户生成的图片"混在 outputs/ 里, 图片浏览只能靠一份手工维护的
排除目录表 (_BROWSE_EXCLUDED_DIRS) 把它们挡掉; 备份/迁移时也分不清哪些是用户的、
哪些是程序的。本模块把这类文件收敛到 data/, outputs/ 只留用户图片。

目录结构
--------
    settings.json            用户配置        (项目根 —— 日常要直接看/改/备份)
    last.json                上次生成参数    (项目根 —— 同上)
    data/
      state/                 用户可恢复的状态 (收藏 / 提示词库 / 背景 / 插件表单值)
      caches/                可随时再生的缓存 (缩略图 / 翻译缓存 / 壁纸 / 回收站)
      temp/                  短命中间文件 (生图 / 重绘 / 监控 / 选择队列)
      browser-profile/       托管浏览器窗口的独立 profile

设计取舍: **只有 settings.json 与 last.json 留在项目根**。它们是用户日常要打开看的
"人读文件", 放在根目录一眼就能找到; 其余都是程序自己读写的机器状态, 收进 data/。
文件常量定义在 utils/config.py (SETTINGS_FILE / LAST_FILE), 本模块只负责迁移。

temp/ 里的文件**按任务隔离**: 生图队列每个 Token 一条通道并行跑, 固定路径的
temp_inpaint_image.png 会被两个任务互相覆盖 (表现为偶发、无法复现的错图)。
job_temp_path() 给出 "本次任务专属" 的路径; 少数需要跨任务共享的文件
(如 last_origin.json, 推文生图插件要读主程序写的上一份) 用 shared_temp_path()。

兼容
----
旧版本的文件在首次启动时由 migrate_legacy() 归位 (见该函数); 两个位置都存在时
按修改时间保留更新的那份 (避免误删带 Token 的配置); 找不到旧文件时静默跳过。
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

# ---------------------------------------------------------------- 根目录
#
# BASE_DIR 以本文件位置反推, 与 utils/config.py 的定义保持一致 (那里也从 __file__ 推)。
# 不 import utils.config: config 会 import logger -> events, 而 events 之外还有一堆模块
# 想用本文件, 保持本模块**零依赖**才能被任何地方安全导入 (包括早于 config 初始化的时机)。

BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
STATE_DIR = DATA_DIR / "state"
CACHE_DIR = DATA_DIR / "caches"
TEMP_DIR = DATA_DIR / "temp"
# 通配符 (卡片库) 目录: 和示例 Vibe 一样收在 data/state 下, 不再占仓库根目录
WILDCARDS_DIR = STATE_DIR / "wildcards"

# 缩略图 / 回收站 / 在线壁纸这些"再生的缓存", 放在 caches 下
THUMB_CACHE_DIR = CACHE_DIR / "thumb_cache"
SELECTOR_TRASH_DIR = CACHE_DIR / "selector_trash"
BG_API_DIR = CACHE_DIR / "backgrounds"

# 建目录失败的场景 (只读介质 / 权限) 不该让整个模块导入失败:
# 调用方真正落盘时自然会报错, 这里只做"尽力而为"的预创建。
_ALL_DIRS = (DATA_DIR, STATE_DIR, CACHE_DIR, TEMP_DIR, THUMB_CACHE_DIR, SELECTOR_TRASH_DIR, BG_API_DIR, WILDCARDS_DIR)


def ensure_dirs() -> None:
    """创建 data/ 下的全部目录 (幂等, 失败静默)。"""
    for d in _ALL_DIRS:
        try:
            d.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass


def data_path(*parts: str) -> Path:
    """data/ 下的路径。"""
    return DATA_DIR.joinpath(*parts)


def state_path(name: str) -> Path:
    """data/state/ 下的状态文件名 (用户可恢复的数据)。"""
    return STATE_DIR / name


def cache_path(name: str) -> Path:
    """data/caches/ 下的缓存文件名 (随时可再生)。"""
    return CACHE_DIR / name


def temp_path(*names: str) -> Path:
    """data/temp/ 下的固定路径 (进程级共享的临时文件)。"""
    return TEMP_DIR.joinpath(*names)


ensure_dirs()


# ---------------------------------------------------------------- 任务级临时目录


def job_temp_dir(job_id: str | None = None) -> Path:
    """当前任务的专属临时目录; 没有任务上下文时退化为 temp/ 根。

    生图队列每个 Token 一条通道并行执行, 若用固定文件名写中间产物
    (temp_inpaint_image.png / temp_last_origin.json), 两个任务会互相覆盖 ——
    表现是"偶发、无法复现的错图"。按 job_id 分目录后互不可见。

    job_id 来自 utils.jobs.current_job_id() (线程级注册表), 所以这里不需要 import jobs:
    调用方传 None 时我们自己延迟导入, 避免 paths <- jobs <- events <- logger 的循环。
    """
    if job_id is None:
        try:
            from utils.jobs import current_job_id

            job_id = current_job_id()
        except Exception:
            job_id = None
    if not job_id:
        return TEMP_DIR
    d = TEMP_DIR / f"job-{job_id}"
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        return TEMP_DIR
    return d


def job_temp_path(name: str, job_id: str | None = None) -> Path:
    """当前任务专属临时目录下的文件名。"""
    return job_temp_dir(job_id) / name


# ---------------------------------------------------------------- 跨任务共享的临时文件
#
# 有些临时文件**不是**任务私有的, 按任务隔离反而会破坏功能:
#
#   last_origin.json (原 outputs/temp_last_origin.json)
#     语义是"最近一次生成请求的完整参数"。两处用法都依赖它跨进程/跨任务存在:
#       - serverside: src/generate_images.py 每次生成前写一份;
#       - 插件: anr_plugin_random_artists 写, anr_plugin_stories_to_images 读;
#       - 文档: tr / 用户按 README "先在主页做一次普通文生图, 插件才能读到上次参数"。
#     推文生图插件的处理器里根本不写这个文件, 它读的必然是**别的任务**留下的那份 ——
#     一旦按 job_id 隔离, 它永远读不到 (或读到早就被删掉的), 功能直接失效。
#
# 另有一类: 动作**返回给前端展示**的图片 (Plot / 分布图)。任务结束时 job 目录会被删除,
# 返回的路径就成了死链, 前端 <img> 全部加载失败。
#
# 所以这两类仍放在 temp/ 根下, 用固定文件名, 语义与改造前一致 (仍然在 data/temp 里,
# 不再污染 outputs/, 也就是本次改造真正要解决的那件事)。
# 它们的清理交给 sweep_job_temp_dirs 之外的一条策略: 见 prune_shared_temp()。

# 跨任务共享的固定文件名清单 (放 temp/ 根, 不按任务隔离)
SHARED_LAST_ORIGIN = "last_origin.json"


def shared_temp_path(name: str) -> Path:
    """放在 data/temp 根下的共享临时文件 (跨任务可见, 不随任务结束删除)。"""
    return TEMP_DIR / name


# 共享临时文件的最大文件数与保留时长: 谁都不会主动删它们 (下一轮任务还要读),
# 所以按"文件数 + 年龄"定期清理, 避免无限增长。
_SHARED_TEMP_MAX_AGE_S = 7 * 24 * 3600.0


def prune_shared_temp(max_age_s: float = _SHARED_TEMP_MAX_AGE_S) -> list[str]:
    """清理 data/temp 根下超龄的散文件 (不动 job-* 目录, 那个由 sweep_job_temp_dirs 负责)。"""
    removed: list[str] = []
    now = time.time()
    try:
        entries = list(os.scandir(TEMP_DIR))
    except OSError:
        return removed
    for entry in entries:
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            if now - entry.stat(follow_symlinks=False).st_mtime < max_age_s:
                continue
            os.remove(entry.path)
            removed.append(entry.name)
        except OSError:
            continue
    return removed


# 任务专属目录的清理: 任务收尾时删, 兜底再由后台线程按"最后修改时间"扫一遍
_JOB_DIR_MAX_AGE_S = 6 * 3600.0


def cleanup_job_temp(job_id: str | None = None) -> None:
    """删除某个任务的临时目录 (任务收尾时调用, 失败静默)。"""
    if not job_id:
        return
    d = TEMP_DIR / f"job-{job_id}"
    # 只删 data/temp 之下、名字形如 job-<8 位> 的目录: 防 job_id 里混入路径分量
    try:
        if d.is_dir() and d.parent == TEMP_DIR:
            shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass


def sweep_job_temp_dirs(max_age_s: float = _JOB_DIR_MAX_AGE_S) -> list[str]:
    """清理超龄的任务临时目录 (进程被杀时来不及收尾的兜底)。

    返回被删掉的目录名。正在运行的任务因目录一直被写、mtime 很新, 不会被误删。
    """
    removed: list[str] = []
    now = time.time()
    try:
        entries = list(os.scandir(TEMP_DIR))
    except OSError:
        return removed
    for entry in entries:
        try:
            if not entry.is_dir(follow_symlinks=False):
                continue
            if not entry.name.startswith("job-"):
                continue
            if now - entry.stat(follow_symlinks=False).st_mtime < max_age_s:
                continue
            shutil.rmtree(entry.path, ignore_errors=True)
            removed.append(entry.name)
        except OSError:
            continue
    return removed


_sweep_started = False
_sweep_lock = threading.Lock()


def start_temp_sweeper(interval: float = 1800.0) -> None:
    """启动后台清理线程 (幂等): 定时清超龄的任务临时目录。

    没有它的话, 进程被强杀 (插件变更 os.execv / 关窗 / 崩溃) 留下的 job-* 目录会一直堆积 ——
    与 utils.jobs 清理孤儿停止信号文件是同一类兜底。
    """
    global _sweep_started
    with _sweep_lock:
        if _sweep_started:
            return
        _sweep_started = True

    def _loop() -> None:
        while True:
            time.sleep(interval)
            try:
                removed = sweep_job_temp_dirs()
                stale = prune_shared_temp()
                if removed or stale:
                    from utils.logger import logger

                    logger.debug(f"已清理 {len(removed)} 个过期的任务临时目录, {len(stale)} 个过期的共享临时文件")
            except Exception:
                pass

    threading.Thread(target=_loop, daemon=True, name="temp-sweeper").start()


# ---------------------------------------------------------------- 旧路径迁移

# (旧绝对路径, 新路径)。只搬"用户数据"与"可重建缓存", 不动 outputs 里的用户图片。
#
# 注意 settings.json / last.json 的迁移方向是 **data/ -> 项目根**:
# 这两个文件是用户日常要直接看、手改、备份的, 放在根目录更顺手 (需求明确要求);
# 曾经有一版把它们收进了 data/, 这里负责把那种布局无损搬回来。
_LEGACY_MOVES: tuple[tuple[Path, Path], ...] = (
    # data/ -> 项目根 (回归到"一眼可见"的位置)
    (DATA_DIR / "settings.json", BASE_DIR / "settings.json"),
    (DATA_DIR / "last.json", BASE_DIR / "last.json"),
    # 旧版根目录的 bg_state.json -> data/state (外观设置属于程序状态, 不留在根)
    (BASE_DIR / "bg_state.json", STATE_DIR / "bg_state.json"),
    # outputs/ 下的状态
    (BASE_DIR / "outputs" / "favorites.json", STATE_DIR / "favorites.json"),
    (BASE_DIR / "outputs" / "prompt_library.json", STATE_DIR / "prompt_library.json"),
    (BASE_DIR / "outputs" / "prompt_library_meta.json", STATE_DIR / "prompt_library_meta.json"),
    (BASE_DIR / "outputs" / "wildcards_order.json", STATE_DIR / "wildcards_order.json"),
    (BASE_DIR / "outputs" / "plugin_values.json", STATE_DIR / "plugin_values.json"),
    (BASE_DIR / "outputs" / "bg_state.json", STATE_DIR / "bg_state.json"),
    # outputs/ 下的缓存
    (BASE_DIR / "outputs" / "translate_cache.json", CACHE_DIR / "translate_cache.json"),
    (BASE_DIR / "outputs" / ".thumb_cache", THUMB_CACHE_DIR),
    (BASE_DIR / "outputs" / "selector_trash", SELECTOR_TRASH_DIR),
    (BASE_DIR / "outputs" / "backgrounds", BG_API_DIR),
    # outputs/ 下的短命临时文件 -> data/temp
    (BASE_DIR / "outputs" / "temp_selector.npy", TEMP_DIR / "temp_selector.npy"),
    (BASE_DIR / "outputs" / "temp_wildcards.json", TEMP_DIR / "temp_wildcards.json"),
    (BASE_DIR / "outputs" / "temp_last_origin.json", TEMP_DIR / "temp_last_origin.json"),
    # 插件启用/禁用列表 (原 outputs/temp_plugins.json) 是用户意图, 归到 state
    (BASE_DIR / "outputs" / "temp_plugins.json", STATE_DIR / "plugins.json"),
)

# 旧的 temp_break_<id>.json 与 temp_*.png 等散件: 直接在 outputs/ 里按前缀搬到 data/temp。
# 插件的中间产物 (mosaics 的 temp_mask.png / temp_nudenet.*, random_artists 的
# temp_random_artists.png 等) 也在这个清单里 —— 它们同样是"程序生成、用完即弃"的文件,
# 留在 outputs/ 会让图片浏览必须靠 "temp_" 前缀手工排除。
_LEGACY_TEMP_GLOBS = (
    "temp_break_*.json",
    "temp_inpaint_*.png",
    "temp_character_reference_image.png",
    "temp_enhance_resized.png",
    "temp_mask.png",
    "temp_nudenet.*",
    "temp_random_artists.png",
)


def migrate_legacy() -> list[str]:
    """把旧版本的散落文件搬到 data/ 下, 返回搬过的相对描述 (供启动日志展示)。

    - 两边都存在时**保留修改时间更新的那份** (settings.json / last.json 里存着 Token,
      误删错的哪一份都会让用户丢配置, 所以不能简单地"新位置优先"或"旧位置优先");
    - 其余情况: 目标已存在则删源, 只留一份, 避免下次启动反复判;
    - 目录整体移动失败时 (跨盘符/占用), 退化为"复制后删除源";
    - 任何一个失败都只记录、不抛出: 迁移失败不该阻止应用启动。
    """
    moved: list[str] = []
    ensure_dirs()

    for old, new in _LEGACY_MOVES:
        try:
            if not old.exists() or old == new:
                continue
            if new.exists():
                # 两边都有: 文件按 mtime 决胜负 (新的留下), 目录直接以目标为准
                if old.is_file() and new.is_file():
                    try:
                        old_newer = old.stat().st_mtime > new.stat().st_mtime
                    except OSError:
                        old_newer = False
                    if old_newer:
                        os.replace(old, new)  # 旧位置的更新 -> 覆盖目标
                        moved.append(f"{_rel(old)} -> {_rel(new)} (源更新, 已覆盖)")
                    else:
                        _remove_path(old)
                        moved.append(f"{_rel(old)} (目标更新, 删除旧副本)")
                else:
                    _remove_path(old)
                    moved.append(f"{_rel(old)} (已存在新数据, 删除旧副本)")
                continue
            new.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.move(str(old), str(new))
            except (OSError, shutil.Error):
                # 跨盘/占用: 复制再删
                if old.is_dir():
                    shutil.copytree(old, new, dirs_exist_ok=True)
                else:
                    shutil.copy2(old, new)
                _remove_path(old)
            moved.append(f"{_rel(old)} -> {_rel(new)}")
        except Exception:
            continue

    # outputs/temp_* 散件
    try:
        outputs = BASE_DIR / "outputs"
        if outputs.is_dir():
            for pattern in _LEGACY_TEMP_GLOBS:
                for old in outputs.glob(pattern):
                    try:
                        new = TEMP_DIR / old.name
                        if not new.exists():
                            shutil.move(str(old), str(new))
                            moved.append(f"{_rel(old)} -> {_rel(new)}")
                        else:
                            _remove_path(old)
                    except Exception:
                        continue
    except Exception:
        pass

    return moved


def _remove_path(path: Path) -> None:
    try:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _rel(p: Path) -> str:
    """相对项目根的展示路径 (日志用)。"""
    try:
        return p.relative_to(BASE_DIR).as_posix()
    except ValueError:
        return p.as_posix()


__all__ = [
    "BASE_DIR",
    "DATA_DIR",
    "STATE_DIR",
    "CACHE_DIR",
    "TEMP_DIR",
    "THUMB_CACHE_DIR",
    "SELECTOR_TRASH_DIR",
    "BG_API_DIR",
    "cache_path",
    "cleanup_job_temp",
    "data_path",
    "ensure_dirs",
    "job_temp_dir",
    "job_temp_path",
    "migrate_legacy",
    "start_temp_sweeper",
    "prune_shared_temp",
    "shared_temp_path",
    "state_path",
    "sweep_job_temp_dirs",
    "temp_path",
]
