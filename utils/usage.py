"""用量快照读取: 供生图队列等只读场景使用 (避免与 utils.generator 循环导入)。

数据源是 utils.generator 中按 Token 缓存的剩余点数/用量 (延迟导入读取),
全部查询/写入/提醒逻辑集中在 utils.generator。
"""

from __future__ import annotations


def tokens_with_no_usage() -> list[str]:
    """返回剩余用量 <= 0 的 Token 列表 (按配置顺序; 无查询记录 / 查询失败的 Token 视为有用量)。"""
    from utils.generator import get_anlas_snapshot
    from utils.tokens import get_tokens

    snapshot = get_anlas_snapshot()
    empty: list[str] = []
    for token in get_tokens():
        info = snapshot.get(token)
        if info is None:
            continue
        _anlas, remains = info
        try:
            remains_num = float(remains)
        except (TypeError, ValueError):
            continue
        if 0 <= remains_num <= 100 and remains_num <= 0:
            empty.append(token)
    return empty


def has_usable_token() -> bool:
    """是否存在剩余用量 > 0 的 Token (无查询数据的 Token 视为可用; 未配置 Token 时返回 True 交由正常流程报错)。"""
    from utils.tokens import get_tokens

    tokens = get_tokens()
    if not tokens:
        return True
    empty = set(tokens_with_no_usage())
    return any(token not in empty for token in tokens)
