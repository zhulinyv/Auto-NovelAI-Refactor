"""提示词 teXt 段 (NAI v5 自然语言块) 的整理: 仅 v5 系列生效。

NAI v5 支持在提示词末尾用 teXt 段写自然语言:

    1girl, solo, "a girl standing in the rain", teXt: a girl standing in the rain"

规则 (统一在生图请求里落地, 保证网页 / 插件 / API 调用行为一致):

1. 成对英文引号 "xxx" 包起来的内容, 在提示词最末尾**追加**一个 teXt 段, 引号本身留在原位不动:
       "xxx"          ->  "xxx", teXt: xxx"
   多对引号的内容之间空两行 (\n\n), 末尾保留**一个**英文引号收尾:
       "xxx", "yyy"   ->  "xxx", "yyy", teXt: xxx\n\nyyy"
   一对引号里的多个内容 ("xxx, yyy, zzz") 算一条, 原样搬进 teXt 段, 不拆条:
       "xxx, yyy, zzz" ->  "xxx, yyy, zzz", teXt: xxx, yyy, zzz"
2. 手写的 teXt 段 —— 无论写在提示词哪个位置、写了几个 —— 都被**移动**(不是复制)到最末尾,
   合并成**一个** teXt 段; 段内多个内容之间同样空两行。
3. 无论质量预设 / Transparent BG / furry 前缀在什么位置, teXt 段永远排在最后。
4. 非 v5 模型原样返回; 提示词里既没有成对引号也没有 teXt 段时同样原样返回
   (不做任何格式化), 保证这两类老用法逐字节不变。

本模块是纯字符串处理, 不依赖任何运行时环境, 便于单独验证。
"""

from __future__ import annotations

import re

# 仅在 v5 系列生图模型生效 (与 src/generate_images.py 的模型名保持一致)
V5_MODELS = ("nai-diffusion-5-full", "nai-diffusion-5-full-medium", "nai-diffusion-5-curated")

# 段关键字: 行首或逗号后的 "teXt:" (大小写不敏感, 中间的空格可有可无, 也兼容用户写成 text:)
_KEYWORD_RE = re.compile(r"(?im)(?:^|(?<=,))[ \t]*text[ \t]*:[ \t]*")

# 成对英文引号; [^"]* 不跨引号, 落单的引号不会被匹配 (原样留在提示词里)
_QUOTED_RE = re.compile(r'"([^"]*)"')

# 段内多条内容的分隔符: 空行 (spec 里的"两个换行符")
_ITEM_SPLIT_RE = re.compile(r"\n[ \t]*\n")

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
    """从左到右扫描提示词, 按出现顺序取出"要进 teXt 段"的内容。

    返回 (内容列表, 需要从正文里挖掉的区间列表):

    - 成对引号的内容**只抄一份**, 引号与其内容留在原地不动 (所以不产生挖除区间);
    - 手写的 teXt 段是**移动**, 整段 (含收尾引号) 记进挖除区间。

    引号里出现的关键字不算新段 (先扫到引号就让整对引号整体跳过), 所以引号内容里的
    ", text:" 不会被误解成段。
    """
    quoted_items: list[str] = []
    manual_items: list[str] = []
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
            manual_items.extend(_split_items(text[body_start:body_end]))
            # 整段挪走: 收尾的那个引号也属于本段
            stop = body_end + 1 if quote_at == body_end else body_end
            spans.append((keyword.start(), stop))
            pos = stop
        elif quoted:
            # 引号内容只抄一份进 teXt 段, 原位置原样保留
            quoted_items.append(quoted.group(1))
            pos = quoted.end()
        else:
            break
    # 引号项恒排在手写项之前: 手写段会被挪到末尾, 若按位置混排则再整理一次顺序就会变
    return quoted_items + manual_items, spans


def strip_text_section(text: str | None) -> str:
    """删掉 teXt 段**及其后面的全部内容**, 返回纯 tag 部分。

    专供"把已有数据/元数据送进图片生成表单"的路径 (法术解析 / 画廊"使用该图片参数" 等):
    导入时只该带 tag, teXt 段本来就会在下次生成时按当前输入重新拼装, 带入只会重复堆叠。
    与模型无关 (只处理 teXt 段, 其它文字逐字节保留); 没有 teXt 段时原样返回。
    """
    prompt = text or ""
    if not prompt:
        return prompt
    match = _KEYWORD_RE.search(prompt)
    if not match:
        return prompt
    # 连段前残留的分隔逗号/空白一起去掉
    return re.sub(r"[\s,]+$", "", prompt[: match.start()])


def apply_text_section(text: str | None, model: str) -> str:
    """按 teXt 段规则整理正面提示词 (仅 v5 系列; 其它模型原样返回)。

    调用时机必须在质量预设等附加内容拼接**之后**: teXt 段永远排在提示词最末尾。
    """
    prompt = text or ""
    if not prompt or not is_v5_model(model):
        return prompt

    items, spans = extract_items(prompt)
    if not items:
        return prompt  # 没有成对引号也没有 teXt 段: 一个字符都不动

    # 只有真的挪走了手写 teXt 段才清理接缝 —— 否则正文逐字节保持原样 (format_input 关掉时也不该被重排)
    core = _remove_spans(prompt, spans).strip() if spans else prompt
    section = build_text_section(_dedupe(items))
    if not section:
        return core
    return f"{core}{SECTION_SEPARATOR}{section}" if core else section


# ---------------------------------------------------------------- 内部实现


def _clean_item(item: str) -> str:
    """单条内容: 条内不留空行 (空行只当分隔符用), 去掉首尾空白与多余逗号。"""
    text = str(item).strip()
    text = _ITEM_SPLIT_RE.sub("\n", text)
    return text.strip().strip(",").strip()


def _split_items(body: str) -> list[str]:
    """段体 -> 多条内容: 按空行拆开。

    空行是唯一的分隔符, 所以条内的单个换行与 ", " 都原样保留 ——
    "xxx, yyy, zzz" 这种一行的多个内容算一条, 不拆开。
    """
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    return [item for item in (_clean_item(part) for part in _ITEM_SPLIT_RE.split(body)) if item]


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


# 接缝处残留的分隔符 (逗号 / 空白 / 换行)
_SEAM_CHARS = " \t\r\n,"


def _remove_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """把 (start, end) 区间从文本里挖掉, 并清理接缝处残留的分隔符; 其余字符逐字保留。

    只动接缝: 引号内容里的逗号与换行在别处, 一概不受影响 (全局重排会把
    "a girl,\nstanding" 这类内容改掉)。
    """
    out = []
    seams = []
    last = 0
    for start, end in spans:
        out.append(text[last:start])
        seams.append(sum(len(part) for part in out))
        last = end
    out.append(text[last:])
    result = "".join(out)
    # 从后往前处理, 前面的接缝坐标才不会被改动过
    for pos in reversed(seams):
        left = pos
        while left > 0 and result[left - 1] in _SEAM_CHARS:
            left -= 1
        right = pos
        while right < len(result) and result[right] in _SEAM_CHARS:
            right += 1
        if left == 0 or right == len(result):
            result = result[:left] + result[right:]  # 接缝在两端: 残留分隔符直接去掉
        else:
            result = result[:left] + ", " + result[right:]  # 两侧都还有内容: 并成一个逗号
    return result


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
    "strip_text_section",
]
