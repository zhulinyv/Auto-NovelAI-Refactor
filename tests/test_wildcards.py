"""wildcard 标记解析测试 (utils/helpers.replace_wildcards)。

规则只有一条: **必须写成 <分类:卡片> 才替换**。
历史 bug: 旧正则 `<([^:]+):([^>]+)>` 里 `[^:]+` 允许 ">", 于是 v5 的结构化提示词
(`<artist>` / `<scene>` 这种跨行、正文里又带 `artist:xxx` 冒号的段落) 会被整段当成
一个 wildcard —— 既误替换用户内容, 又因为解析失败在循环里反复重试 (跑满轮数上限)。

运行
----
    python -X utf8 tests/test_wildcards.py
    (Windows 下务必带 -X utf8; 临时 wildcard 目录建在系统临时目录, 不碰 data/state)
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from utils import helpers as H  # noqa: E402

_failures: list[str] = []
_passes = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passes
    if ok:
        _passes += 1
    else:
        _failures.append(f"{name}{(' -- ' + detail) if detail else ''}")


def _make_cards(tmp: Path) -> None:
    """临时卡片: card 里再嵌一个 wildcard (递归), loop 自引用 (测轮数上限)。"""
    (tmp / "cat").mkdir()
    (tmp / "cat" / "nested.txt").write_text("INNER", encoding="utf-8")
    (tmp / "cat" / "card.txt").write_text("A <cat:nested> B", encoding="utf-8")
    (tmp / "cat" / "loop.txt").write_text("<cat:loop>", encoding="utf-8")
    (tmp / "cat" / "空.txt").write_text("", encoding="utf-8")


def test_plain_tag_untouched() -> None:
    """没有冒号的 <xxx> 一律不许动 —— 这是 v5 结构化提示词的写法。"""
    cases = [
        "<artist>",
        "<scene>",
        "<style>watercolor</style>",
        "<artist>x:y</artist>",  # 标签内有冒号, 但不在 <标签:内容> 结构里
        "<artist>\nartist:foo, 0.8::artist:bar::\n</artist>",  # 跨行 + 多重冒号
        "<cat:>",  # 卡片名为空: 不算合法标记
        "<:card>",  # 分类为空: 同上
        "1girl, 2::artist:yajuu::",  # 权重语法, 没有尖括号
    ]
    for src in cases:
        got = H.replace_wildcards(src)
        check(f"原样保留 {src!r}", got == src, f"got {got!r}")


def test_v5_prompt_untouched() -> None:
    """整段 v5 提示词逐字节原样, 且瞬间返回 (旧实现会空转 50 轮)。"""
    v5 = (
        "<artist>\n"
        "artist:na tarapisu153, 0.8::artist:yajuu::, artist:ask (askzy)\n"
        "</artist>\n"
        "\n"
        "<scene>\n"
        "rainy narrow shopping lane, <style>watercolor</style>\n"
        "</scene>\n"
        "\n"
        "<composition>\n"
        "1girl, 1boy, 2::cat:xxx::\n"
        "</composition>"
    )
    check("v5 提示词原样", H.replace_wildcards(v5) == v5)


def test_replace_valid_token(tmp: Path) -> None:
    """合法标记照常替换; 冒号两边带空格也认。"""
    check("<cat:nested> 替换", H.replace_wildcards("<cat:nested>") == "INNER")
    check("<cat:card> 递归展开", H.replace_wildcards("<cat:card>") == "A INNER B")
    check("<cat : nested> 带空格替换", H.replace_wildcards("<cat : nested>") == "INNER")
    check("同段多处一起替换", H.replace_wildcards("<cat:nested>+<cat:nested>") == "INNER+INNER")
    check("空卡片替换成空串", H.replace_wildcards("[<cat:空>]") == "[]")


def test_missing_card_kept() -> None:
    """卡片/分类不存在: 保留原样, 且一轮就收工 (不再空转到轮数上限)。"""
    cases = ["<cat:不存在>", "<不存在:nested>", "<cat:card><cat:不存在>"]
    for src in cases:
        got = H.replace_wildcards(src)
        check(f"缺失保留 {src!r}", "不存在" in got or got.startswith("A "), f"got {got!r}")
    check("缺失标记原样", H.replace_wildcards("<cat:不存在>") == "<cat:不存在>")


def test_self_reference_bounded(tmp: Path) -> None:
    """自引用卡片不能卡死: 跑满轮数上限后停在原地。"""
    old = H._WILDCARD_MAX_ROUNDS
    H._WILDCARD_MAX_ROUNDS = 3
    try:
        got = H.replace_wildcards("<cat:loop>")
        check("自引用有上限", got == "<cat:loop>", f"got {got!r}")
    finally:
        H._WILDCARD_MAX_ROUNDS = old


def main() -> int:
    old_dir = H.WILDCARDS_DIR
    tmp = Path(tempfile.mkdtemp(prefix="anr-wildcards-"))
    try:
        _make_cards(tmp)
        H.WILDCARDS_DIR = tmp
        H._reset_wildcard_cache()

        print("== 1. <xxx> 原样保留 ==")
        test_plain_tag_untouched()
        print("== 2. v5 结构化提示词 ==")
        test_v5_prompt_untouched()
        print("== 3. <分类:卡片> 正常替换 ==")
        test_replace_valid_token(tmp)
        print("== 4. 缺失卡片 ==")
        test_missing_card_kept()
        print("== 5. 自引用上限 ==")
        test_self_reference_bounded(tmp)
    finally:
        H.WILDCARDS_DIR = old_dir
        H._reset_wildcard_cache()
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if _failures:
        print(f"FAILED: {len(_failures)} 项 (通过 {_passes} 项)")
        for f in _failures:
            print("  -", f)
        return 1
    print(f"ALL PASSED ({_passes} 项)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
