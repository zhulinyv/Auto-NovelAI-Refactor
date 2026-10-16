"""提示词 teXt 段 (NAI v5 自然语言块) 的整理: 仅 v5 系列生效。

NAI v5 支持在提示词末尾用 teXt 段写自然语言:

    1girl, solo, teXt: a girl standing in the rain"

规则 (统一在生图请求里落地, 保证网页 / 插件 / API 调用行为一致):

1. 成对英文引号 "xxx" 包起来的内容收进 teXt 段, 引号本身从原位置消失;
   多段内容之间空两行 (\n\n), 末尾保留**一个**英文引号收尾。
   一对引号里的内容 ("xxx, yyy, zzz") 原样保留, 不拆成多段。
2. 手写的 teXt 段 —— 无论写在提示词哪个位置、写了几个 —— 都会被收集、去重,
   合并成**一个** teXt 段并挪到提示词最末尾。
3. 无论质量预设 / Transparent BG / furry 前缀在什么位置, teXt 段永远排在最后。
4. 非 v5 模型原样返回; 没有引号也没有 teXt 段的 v5 提示词同样原样返回
   (不做任何格式化), 保证这两类老用法逐字节不变。

本模块是纯字符串处理, 不依赖任何运行时环境, 便于单独验证。
"""

from __future__ import annotations

import re

# 仅在 v5 系列生图模型生效 (与 src/generate_images.py 的模型名保持一致)
V5_MODELS = ("nai-diffusion-5-full", "nai-diffusion-5-curated")

# 段关键字: 行首或逗号后的 "teXt:" (大小写不敏感, 中间的空格可有可无, 也兼容写成 text:)
_KEYWORD_RE = re.compile(r"(?im)(?:^|(?<=,))[ \t]*text[ \t]*:[ \t]*")

# 成对英文引号; [^"]* 不跨引号, 落单的引号不会被匹配 (原样留在提示词里)
_QUOTED_RE = re.compile(r'"([^"]*)"')

# 段关键字本身 (规范写法, 大小写敏感)
KEYWORD = "teXt:"

# 段内多条内容之间的分隔符: 两个换行
ITEM_SEPARATOR = "\n\n"

# 段末尾收尾的那一个英文引号
CLOSING_QUOTE = '"'

# teXt 段与前面提示词之间的分隔符 (与质量预设 / Transparent BG 的拼接方式一致)
SECTION_SEPARATOR = ", "


def is_v5_model(model) -> bool:
    """是否为 v5 系列模型 (teXt 段只在 v5 系列生效)。"""
    return str(model or "") in V5_MODELS


def build_text_section(items) -> str:
    """按 teXt 段格式拼接内容; 没有内容时返回空串。

    格式: teXt: a\n\nb\n\nc"
    """
    cleaned = [_clean_item(item) for item in items]
    cleaned = [item for item in cleaned if item]
    if not cleaned:
        return ""
    return f"{KEYWORD} {ITEM_SEPARATOR.join(cleaned)}{CLOSING_QUOTE}"


def extract_items(text: str) -> tuple[list[str], list[tuple[int, int]]]:
    """从左到右扫描提示词, 按出现顺序取出 teXt 段与成对引号的内容。

    返回 (内容列表, 需要从正文里挖掉的区间列表)。引号里出现的关键字不算新段
    (先扫到引号就让整对引号整体跳过), 所以引号内容里的 ", text:" 不会被误解成段。
    """
    items: list[str] = []
    spans: list[tuple[int, int]] = []
    pos = 0
    while pos < len(text):
        keyword = _KEYWORD_RE.search(text, pos)
        quoted = _QUOTED_RE.search(text, pos)
        if keyword and (quoted is None or keyword.start() <= quoted.start()):
            # teXt 段: 段体到"收尾引号 / 下一个 teXt 关键字 / 文本末尾"为止
            body_start = keyword.end()
            body_end = len(text)
            next_keyword = _KEYWORD_RE.search(text, body_start)
            if next_keyword:
                body_end = min(body_end, next_keyword.start())
            quote_at = text.find(CLOSING_QUOTE, body_start)
            if quote_at != -1:
                body_end = min(body_end, quote_at)
            items.extend(_split_items(text[body_start:body_end]))
            # 收尾的那个引号属于本段, 一并挖掉
            stop = body_end + 1 if quote_at == body_end else body_end
            spans.append((keyword.start(), stop))
            pos = stop
        elif quoted:
            items.append(quoted.group(1))
            spans.append((quoted.start(), quoted.end()))
            pos = quoted.end()
        else:
            break
    return items, spans


def apply_text_section(text: str | None, model: str) -> str:
    """按 teXt 段规则整理正面提示词 (仅 v5 系列; 其它模型原样返回)。

    调用时机必须在质量预设等附加内容拼接**之后**: teXt 段永远排在提示词最末尾。
    """
    prompt = text or ""
    if not prompt or not is_v5_model(model):
        return prompt

    items, spans = extract_items(prompt)
    if not spans:
        return prompt  # 没有引号也没有 teXt 段: 一个字符都不动

    core = _tidy(_remove_spans(prompt, spans))
    section = build_text_section(_dedupe(items))
    if not section:
        return core
    return f"{core}{SECTION_SEPARATOR}{section}" if core else section


# ---------------------------------------------------------------- 内部实现


def _clean_item(item: str) -> str:
    """单条内容: 去掉首尾空白与多余逗号。"""
    return str(item).strip().strip(",").strip()


def _split_items(body: str) -> list[str]:
    """段体 -> 多条内容: 逐行拆开, 每行一条。

    段体里不会再有引号 (遇到收尾引号就截断了), 所以 "xxx, yyy, zzz" 这种
    一行里的逗号原样保留 —— 一对引号内的多个内容算一条, 不拆开。
    """
    items = []
    for line in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = _clean_item(line)
        if line:
            items.append(line)
    return items


def _dedupe(items: list[str]) -> list[str]:
    """内容去重 (忽略大小写与空白差异), 保留首次出现的原始写法。"""
    result: list[str] = []
    seen: set[str] = set()
    for item in items:
        item = _clean_item(item)
        key = re.sub(r"\s+", " ", item).casefold()
        if key and key not in seen:
            seen.add(key)
            result.append(item)
    return result


def _remove_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """把 (start, end) 区间从文本里挖掉, 其余字符逐字保留。"""
    kept = []
    last = 0
    for start, end in spans:
        kept.append(text[last:start])
        last = end
    kept.append(text[last:])
    return "".join(kept)


def _tidy(text: str) -> str:
    """正文清理: 去掉挖掉内容后残留的空逗号段, 逐行处理以保留原有换行结构。"""
    lines = []
    for line in text.split("\n"):
        segments = [seg.strip() for seg in line.split(",")]
        lines.append(", ".join(seg for seg in segments if seg))
    return "\n".join(lines).strip()


__all__ = [
    "CLOSING_QUOTE",
    "ITEM_SEPARATOR",
    "KEYWORD",
    "SECTION_SEPARATOR",
    "V5_MODELS",
    "apply_text_section",
    "build_text_section",
    "extract_items",
    "is_v5_model",
]
