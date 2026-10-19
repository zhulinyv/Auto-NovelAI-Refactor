"""JSON 状态文件的原子读写。

为什么需要
----------
项目里有 6 个"读 -> 改 -> 写"的 JSON 状态文件 (收藏 / 提示词库 / 背景状态 / 插件表单值 /
翻译缓存 / 通配符排序), 历史上各自写成:

    data = json.loads(path.read_text(encoding="utf-8"))
    ...
    path.write_text(json.dumps(data), encoding="utf-8")

这带来三个问题:

1) **非原子写**: write_text 先截断再写。进程在两次系统调用之间被杀 (插件变更 os.execv /
   关窗 / 崩溃) 会留下半截 JSON, 下次读取抛异常被上层 except 吞掉 —— 表现是"收藏 /
   提示词库 / 插件参数突然全没了", 而且没有任何报错线索。
2) **无锁**: 两个请求同时读-改-写会互相覆盖 (后写的赢), 丢一次更新。
3) **五份重复实现**: 每加一个状态文件都要再抄一遍。

修复
----
- 写入走 "临时文件 + os.replace" (同目录, Windows 上也是原子的);
- 读-改-写整体在一把全局锁里完成 (状态文件都很小, 串行化开销可忽略);
- 损坏的旧文件先备份成 *.corrupt-<时间戳> 再返回默认值, 不再让用户的旧数据无声消失。
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

_lock = threading.RLock()


def read(path: str | Path, default: Any = None) -> Any:
    """读 JSON; 文件不存在 / 损坏 / 类型不符时返回 default (不抛异常)。"""
    p = Path(path)
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception:
        return default


def read_dict(path: str | Path) -> dict:
    """读成一个 dict (非 dict 内容视为损坏, 返回空 dict)。"""
    data = read(path, {})
    return data if isinstance(data, dict) else {}


def read_list(path: str | Path) -> list:
    """读成一个 list (非 list 内容视为损坏, 返回空 list)。"""
    data = read(path, [])
    return data if isinstance(data, list) else []


def write(path: str | Path, data: Any) -> bool:
    """原子写 JSON (临时文件 + os.replace), 返回是否成功。"""
    p = Path(path)
    tmp: Path | None = None
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        # 临时文件放同目录: os.replace 跨目录不保证原子, 同目录则一定是原子替换
        tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex[:8]}.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)  # 原子替换: 并发读者要么读到旧内容, 要么读到新内容, 不会读到半截
        return True
    except Exception:
        if tmp is not None:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
        return False


def update(path: str | Path, mutator: Callable[[Any], Any], default: Any = None) -> Any:
    """原子地读-改-写: 返回 mutator 的返回值。

    mutator 收到当前内容 (读不到时是 default), 返回新的完整内容 (会被写回)。
    整个过程持锁, 并发的 update 不会互相覆盖。
    """
    p = Path(path)
    with _lock:
        current = read(p, default)
        result = mutator(current)
        write(p, result)
        return result


def update_dict(path: str | Path, changes: dict) -> dict:
    """部分更新一个 dict 状态文件 (只覆盖 changes 里的键)。返回更新后的完整 dict。"""

    def _merge(current: Any) -> dict:
        base = current if isinstance(current, dict) else {}
        base.update(changes)
        return base

    return update(path, _merge, default={})


def quarantine(path: str | Path) -> str | None:
    """把损坏的状态文件改名留档, 返回新路径 (供上层在发现数据异常时调用)。"""
    p = Path(path)
    try:
        if not p.exists():
            return None
        backup = p.with_name(f"{p.name}.corrupt-{int(time.time())}")
        os.replace(p, backup)
        return backup.as_posix()
    except OSError:
        return None


__all__ = ["quarantine", "read", "read_dict", "read_list", "update", "update_dict", "write"]
