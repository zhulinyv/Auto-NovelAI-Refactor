"""Wildcards 管理服务 (支持图片封面)。"""

from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

import send2trash

from utils import jsonstore
from utils.helpers import format_str, read_txt
from utils.logger import logger
from utils.paths import STATE_DIR, TEMP_DIR, WILDCARDS_DIR

_COVER_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif")


_TYPES_ORDER_FILE = STATE_DIR / "wildcards_order.json"


def migrate_legacy_root() -> None:
    """老版本把 wildcards/ 放在仓库根目录; 现在统一收进 data/state/wildcards/。

    幂等: 根目录没有旧目录时什么都不做; 同名分类保留目标目录里的那份 (不覆盖用户数据)。
    """
    legacy = Path("./wildcards")
    try:
        if not legacy.is_dir() or legacy.resolve() == WILDCARDS_DIR.resolve():
            return
    except OSError:
        return
    WILDCARDS_DIR.mkdir(parents=True, exist_ok=True)
    moved = 0
    for entry in list(legacy.iterdir()):
        target = WILDCARDS_DIR / entry.name
        if target.exists():
            continue
        try:
            shutil.move(str(entry), str(target))
            moved += 1
        except OSError as e:
            logger.warning(f"迁移通配符分类失败 ({entry.name}): {e}")
    try:
        legacy.rmdir()
    except OSError:
        pass
    if moved:
        logger.success(f"已把 {moved} 个通配符分类迁移到 {WILDCARDS_DIR}")


def list_types() -> list[str]:
    if not WILDCARDS_DIR.exists():
        return []
    actual = [d for d in sorted(os.listdir(WILDCARDS_DIR)) if (WILDCARDS_DIR / d).is_dir()]
    # 应用用户自定义排序 (拖拽调整, 新分类追加在后)
    order = [t for t in jsonstore.read_list(_TYPES_ORDER_FILE) if isinstance(t, str)]
    known = [t for t in order if t in actual]
    rest = [t for t in actual if t not in known]
    return known + rest


def save_types_order(types: list[str]) -> None:
    """保存卡片库分类的自定义排序。"""
    if not WILDCARDS_DIR.exists():
        return
    actual = {d for d in os.listdir(WILDCARDS_DIR) if (WILDCARDS_DIR / d).is_dir()}
    ordered = [t for t in types if t in actual]
    rest = sorted(t for t in actual if t not in ordered)
    jsonstore.write(_TYPES_ORDER_FILE, ordered + rest)


def create_type(wildcard_type: str) -> bool:
    """新建一个空分类 (就是建同名目录)。已存在时返回 False。"""
    name = (wildcard_type or "").strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ValueError("分类名不合法")
    _dir = WILDCARDS_DIR / name
    if _dir.is_dir():
        return False
    _dir.mkdir(parents=True, exist_ok=True)
    logger.success(f"已新建卡片库分类: {name}")
    return True


def list_names(wildcard_type: str) -> list[str]:
    _dir = WILDCARDS_DIR / wildcard_type
    if not _dir.is_dir():
        return []
    return ["随机", "顺序"] + sorted(f.split(".")[0] for f in os.listdir(_dir) if f.endswith(".txt"))


def find_cover(wildcard_type: str, name: str) -> str | None:
    """查找与卡片同名的封面图片 (name.png/jpg/webp 等), 返回路径或 None (仅第一个命中的扩展名)。"""
    _dir = WILDCARDS_DIR / wildcard_type
    for ext in _COVER_EXTS:
        p = _dir / f"{name}{ext}"
        if p.exists():
            return str(p)
    return None


def find_covers(wildcard_type: str, name: str, except_ext: str = "") -> list[str]:
    """列出同名卡片的全部既有封面 (可排除即将写入的那个扩展名)。"""
    _dir = WILDCARDS_DIR / wildcard_type
    out: list[str] = []
    for ext in _COVER_EXTS:
        if ext == except_ext:
            continue
        p = _dir / f"{name}{ext}"
        if p.exists():
            out.append(str(p))
    return out


def _drop_old_covers(wildcard_type: str, name: str, keep_ext: str) -> None:
    """删除同名卡片的旧封面 (保留 keep_ext 这一扩展名, 由调用方随后覆盖)。

    历史 bug: 原先写成 `for old in find_cover(...) or []`, 而 find_cover 返回的是
    单个路径字符串 -> 迭代得到的是字符, os.remove("C") 抛 FileNotFoundError
    (OSError 子类) 被 except-pass 吞掉, 旧封面从未真正删除。
    """
    for old in find_covers(wildcard_type, name, except_ext=keep_ext):
        try:
            os.remove(old)
        except OSError as e:
            logger.warning(f"删除旧封面失败 {old}: {e}")
            logger.opt(exception=True).debug("删除旧封面失败堆栈:")


def list_cards(wildcard_type: str) -> list[dict]:
    """列出某分类下的全部卡片 (含封面信息与内容预览), 便于前端网格展示。

    封面通过一次 listdir 建立索引 (按 _COVER_EXTS 优先级取第一个匹配),
    替代每卡多次 stat 扫描: 155 张卡实测 175ms -> 35ms。
    """
    _dir = WILDCARDS_DIR / wildcard_type
    if not _dir.is_dir():
        return []
    try:
        entries = sorted(os.listdir(_dir))
    except Exception:
        return []
    # 封面索引: 文件名主干 (小写) -> 完整路径, 按 _COVER_EXTS 顺序保证与 find_cover 相同的优先级
    covers: dict[str, str] = {}
    for ext in _COVER_EXTS:
        for f in entries:
            low = f.lower()
            if low.endswith(ext) and low[: -len(ext)] not in covers:
                covers[low[: -len(ext)]] = str(_dir / f)
    cards = []
    for f in entries:
        if not f.endswith(".txt"):
            continue
        name = f[:-4]
        try:
            tags = (_dir / f).read_text(encoding="utf-8").strip()
        except Exception:
            tags = ""
        cover = covers.get(name.lower())
        cards.append(
            {
                "name": name,
                "tags": tags[:200],
                "has_cover": cover is not None,
                "cover": cover,
            }
        )
    return cards


def get_tags(wildcard_type: str, wildcard_name: str) -> str | None:
    if wildcard_name in ("随机", "顺序"):
        return None
    return read_txt(WILDCARDS_DIR / wildcard_type / f"{wildcard_name}.txt")


def save_tags(wildcard_type: str, wildcard_name: str, tags: str) -> None:
    _dir = WILDCARDS_DIR / wildcard_type
    _dir.mkdir(parents=True, exist_ok=True)
    (_dir / f"{wildcard_name}.txt").write_text(tags, encoding="utf-8")
    logger.success(f"已保存 wildcard: <{wildcard_type}:{wildcard_name}>")


def save_cover(wildcard_type: str, wildcard_name: str, content: bytes, ext: str = ".png") -> str:
    """保存卡片封面图片, 返回其路径。"""
    _dir = WILDCARDS_DIR / wildcard_type
    _dir.mkdir(parents=True, exist_ok=True)
    # 先删除旧封面 (不同扩展名的历史封面)
    _drop_old_covers(wildcard_type, wildcard_name, ext)
    target = _dir / f"{wildcard_name}{ext}"
    target.write_bytes(content)
    logger.success(f"已保存封面: {target}")
    return str(target)


def save_cover_from_image(wildcard_type: str, wildcard_name: str, image_path: str) -> str:
    """把服务器上已有的图片文件直接复制为卡片封面 (不重新上传), 返回其路径。"""
    import shutil

    _dir = WILDCARDS_DIR / wildcard_type
    _dir.mkdir(parents=True, exist_ok=True)
    ext = Path(image_path).suffix.lower()
    if ext not in _COVER_EXTS:
        ext = ".png"
    # 先按目标扩展名删掉旧封面, 再写入新封面
    _drop_old_covers(wildcard_type, wildcard_name, ext)
    target = _dir / f"{wildcard_name}{ext}"
    shutil.copy2(image_path, str(target))
    logger.success(f"已保存封面: {target}")
    return str(target)


def delete(wildcard_type: str, wildcard_name: str) -> None:
    path = WILDCARDS_DIR / wildcard_type / f"{wildcard_name}.txt"
    if path.exists():
        send2trash.send2trash(str(path))
        # 同时删除封面
        cover = find_cover(wildcard_type, wildcard_name)
        if cover:
            send2trash.send2trash(cover)
        logger.info(f"已将 <{wildcard_type}:{wildcard_name}> 移动到回收站")
    else:
        logger.error(f"wildcard 不存在: <{wildcard_type}:{wildcard_name}>")


# 待回收站的暂存目录: 同盘 rename 是毫秒级, 而 send2trash 在本机实测稳定要 ~3 秒
# (Windows Shell 的回收站操作, 与文件数量无关 —— 空目录也要 3 秒)。
# 所以删除分两步: 先改名移出 wildcards/ (立刻从列表消失), 再交给后台线程慢慢丢回收站。
STAGED_TRASH_DIR = TEMP_DIR / "wildcards_trash"


def _trash_staged(path: Path, label: str) -> None:
    """后台线程: 把暂存目录真正丢进系统回收站。"""
    try:
        send2trash.send2trash(str(path))
        logger.info(f"已将分类 <{label}> 移动到回收站")
    except Exception as e:
        logger.error(f"分类 <{label}> 移入回收站失败 (文件已从分类列表移除, 仍在 {path}): {e}")
        logger.opt(exception=True).debug("移入回收站失败堆栈:")


def _sweep_staged() -> None:
    """清理上次没来得及丢进回收站的暂存目录 (进程被关掉时会留下)。"""
    try:
        for old in STAGED_TRASH_DIR.iterdir():
            if old.is_dir() and time.time() - old.stat().st_mtime > 60:
                _trash_staged(old, old.name)
    except OSError:
        pass


def delete_type(wildcard_type: str) -> None:
    """删除整个分类 (卡片与封面一并进回收站)。

    对调用方是**立即返回**: 只做一次同盘重命名, 真正进回收站由后台线程完成。
    """
    path = WILDCARDS_DIR / wildcard_type
    if not path.is_dir():
        logger.error(f"wildcard 分类不存在: <{wildcard_type}>")
        raise FileNotFoundError(f"分类不存在: <{wildcard_type}>")

    STAGED_TRASH_DIR.mkdir(parents=True, exist_ok=True)
    staged = STAGED_TRASH_DIR / f"{int(time.time() * 1000)}_{wildcard_type}"
    os.rename(path, staged)  # 同盘: 毫秒级; 失败会抛 OSError
    logger.info(f"分类 <{wildcard_type}> 已移出列表, 正在后台移入回收站")
    threading.Thread(
        target=lambda: (_sweep_staged(), _trash_staged(staged, wildcard_type)),
        daemon=True,
        name="wildcards-trash",
    ).start()


def add_wildcard_to_prompt(prompt: str, wildcard_type: str, wildcard_name: str) -> str:
    """把 <分类:卡片> 拼到提示词后面。

    拼接规则 (前端"添加选中"也走这里):
      - 前面没有任何内容 -> 直接给卡片, **不加逗号** (否则提示词以 ", " 开头)
      - 前面已有内容   -> 用一个逗号连接
      - 前面已经以逗号结尾 -> 不重复加
    """
    token = f"<{wildcard_type}:{wildcard_name}>"
    base = (prompt or "").rstrip()
    if not base.strip():
        return format_str(token)
    if base.endswith(",") or base.endswith("，"):
        return format_str(f"{base} {token}")
    return format_str(f"{base}, {token}")
