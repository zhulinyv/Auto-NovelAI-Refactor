"""前后端"镜像算法"契约测试。

背景
----
项目里有几组算法在 Python 与 JavaScript 各写了一份, 只能靠注释约定"改动需两侧同步":

  1. 64 对齐         utils/helpers.return_x64
                     <-> web/js/views/generate.js round64
  2. 裁剪框归一化    src/generate_images._crop_rect_from_request
                     <-> web/js/cropRect.js normalizeCropRect
  3. 裁剪框自动扩展  src/generate_images._expand_crop_rect
                     <-> web/js/cropRect.js expandCropRect
  4. teXt 段整理     utils/prompt_text.apply_text_section
                     <-> web/js/views/generate.js applyTextSection

任何一侧单独改动都会造成"前端预览与后端实际请求不一致"的静默偏差 —— 不报错, 只是出图不对。
本文件用同一批输入分别跑两套实现, 逐值比对。

运行
----
    python tests/test_contracts.py          # 只跑 Python 侧自检 + 与 JS 的交叉验证
    node --test web/js/__tests__/crop_contract.test.mjs   # 只跑 JS 侧

交叉验证需要 node; 没有 node 时自动跳过 (只跑 Python 侧), 不会失败。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from utils.helpers import return_max_size, return_x64  # noqa: E402

_failures: list[str] = []
_passes = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passes
    if ok:
        _passes += 1
    else:
        _failures.append(f"{name}{(' -- ' + detail) if detail else ''}")


# ---------------------------------------------------------------- 1. 64 对齐


def test_return_x64() -> None:
    """return_x64 的边界行为 (前端 round64 必须给出同样的值)。"""
    # 规则: 不足 64 一律 64; 小数部分 >= 0.5 向上取整到 64 的倍数, 否则向下。
    # 96/64 = 1.5 -> 2*64 = 128 (正好 .5 时向上, 与前端 Math.round(96/64) 一致)。
    cases = [
        (0, 64),
        (1, 64),
        (63, 64),
        (64, 64),
        (65, 64),
        (95, 64),
        (96, 128),
        (97, 128),
        (128, 128),
        (832, 832),
        (1216, 1216),
    ]
    for given, want in cases:
        check(f"return_x64({given})", return_x64(given) == want, f"got {return_x64(given)}, want {want}")


def test_return_max_size() -> None:
    """Enhance Max: 结果必须是 64 的倍数, 面积不超上限, 且尽量顶到上限。"""
    for w, h in ((832, 1216), (1024, 1024), (512, 768), (1536, 2048)):
        nw, nh = return_max_size(w, h)
        check(f"return_max_size({w},{h}) 64-aligned", nw % 64 == 0 and nh % 64 == 0, f"{nw}x{nh}")
        check(f"return_max_size({w},{h}) area", nw * nh <= 1536 * 2048, f"{nw}x{nh}")


# ---------------------------------------------------------------- 2/3. 裁剪几何


def _py_normalize(rect, image_w, image_h, inset):
    from src.generate_images import _crop_rect_from_request

    r = _crop_rect_from_request({**rect, "inset": inset}, (image_w, image_h))
    return None if r is None else {"x": r[0], "y": r[1], "w": r[2], "h": r[3]}


def _py_expand(rect, image_w, image_h):
    from src.generate_images import _expand_crop_rect

    r = _expand_crop_rect((rect["x"], rect["y"], rect["w"], rect["h"]), (image_w, image_h))
    return {"x": r[0], "y": r[1], "w": r[2], "h": r[3]}


NORMALIZE_CASES = [
    ({"x": 128, "y": 128, "w": 512, "h": 512}, 1216, 832, 32),
    ({"x": 100, "y": 100, "w": 500, "h": 500}, 1216, 832, 32),
    ({"x": 0, "y": 0, "w": 2048, "h": 2048}, 2048, 2048, 32),
    ({"x": -999, "y": -999, "w": 512, "h": 512}, 1216, 832, 32),
    ({"x": 700, "y": 300, "w": 700, "h": 300}, 1216, 832, 32),
]

EXPAND_CASES = [
    ({"x": 256, "y": 256, "w": 128, "h": 128}, 1216, 832),
    ({"x": 0, "y": 0, "w": 256, "h": 256}, 1216, 832),
    ({"x": 512, "y": 384, "w": 512, "h": 384}, 1216, 832),
]


def test_crop_python_side() -> None:
    """Python 侧自检: 归一化幂等、面积上限、扩展覆盖原框。"""
    for rect, iw, ih, inset in NORMALIZE_CASES:
        once = _py_normalize(rect, iw, ih, inset)
        if once is None:
            check(f"normalize{rect}", False, "returned None")
            continue
        twice = _py_normalize(once, iw, ih, inset)
        check(f"normalize{rect} idempotent", once == twice, f"{once} != {twice}")
        check(f"normalize{rect} area<=cap", once["w"] * once["h"] <= 1024 * 1024, str(once))

    for rect, iw, ih in EXPAND_CASES:
        g = _py_expand(rect, iw, ih)
        check(f"expand{rect} area<=cap", g["w"] * g["h"] <= 1024 * 1024, str(g))
        check(
            f"expand{rect} covers",
            g["x"] <= rect["x"]
            and g["y"] <= rect["y"]
            and g["x"] + g["w"] >= rect["x"] + rect["w"]
            and g["y"] + g["h"] >= rect["y"] + rect["h"],
            str(g),
        )
        check(f"expand{rect} idempotent", _py_expand(g, iw, ih) == g, str(_py_expand(g, iw, ih)))


_JS_RUNNER = r"""
import { normalizeCropRect, expandCropRect } from "%(croprect)s";
// 注意: node -e 时 process.argv 是 [node, ...用户参数], 没有脚本路径, 所以取最后一个
const cases = JSON.parse(process.argv[process.argv.length - 1]);
const out = cases.map((c) => {
  if (c.kind === "normalize") {
    return normalizeCropRect(c.rect, { inset: c.inset, imageW: c.w, imageH: c.h });
  }
  return expandCropRect(c.rect, { imageW: c.w, imageH: c.h });
});
process.stdout.write(JSON.stringify(out));
"""


def test_crop_cross_check() -> int | None:
    """Python 与 JS 的裁剪几何逐值比对 (需要 node)。"""
    node = shutil.which("node")
    if not node:
        print("  (跳过交叉验证: 未找到 node)")
        return None

    # Windows 上 ESM 的 import 只认 file:// URL, 绝对路径 "D:/..." 会被当成协议 "d:"
    croprect = (ROOT / "web" / "js" / "cropRect.js").as_uri()
    runner = _JS_RUNNER % {"croprect": croprect}
    payload = []
    for rect, iw, ih, inset in NORMALIZE_CASES:
        payload.append({"kind": "normalize", "rect": rect, "w": iw, "h": ih, "inset": inset})
    for rect, iw, ih in EXPAND_CASES:
        payload.append({"kind": "expand", "rect": rect, "w": iw, "h": ih})

    try:
        proc = subprocess.run(
            [node, "--input-type=module", "-e", runner, json.dumps(payload)],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(ROOT),
        )
    except Exception as e:  # noqa: BLE001
        print(f"  (跳过交叉验证: node 执行失败 {e})")
        return None
    if proc.returncode != 0:
        print(f"  (跳过交叉验证: node 返回 {proc.returncode}) {proc.stderr[:400]}")
        return None

    js_results = json.loads(proc.stdout)
    idx = 0
    for rect, iw, ih, inset in NORMALIZE_CASES:
        py = _py_normalize(rect, iw, ih, inset)
        js = js_results[idx]
        idx += 1
        js_norm = {"x": js["x"], "y": js["y"], "w": js["w"], "h": js["h"]}
        check(f"JS==PY normalize{rect}", py == js_norm, f"py={py} js={js_norm}")

    for rect, iw, ih in EXPAND_CASES:
        py = _py_expand(rect, iw, ih)
        js = js_results[idx]
        idx += 1
        js_norm = {"x": js["x"], "y": js["y"], "w": js["w"], "h": js["h"]}
        check(f"JS==PY expand{rect}", py == js_norm, f"py={py} js={js_norm}")
    return 0


# ---------------------------------------------------------------- 4. teXt 段


def test_text_section() -> None:
    """teXt 段规则: 引号内容抄进末尾, 手写段移到末尾, 非 v5 原样返回。"""
    from utils.prompt_text import apply_text_section

    v5 = "nai-diffusion-5-full"
    cases = [
        ("1girl, solo", "1girl, solo"),  # 无引号无段: 原样
        ('1girl, "a girl in rain"', '1girl, "a girl in rain", teXt: a girl in rain"'),
        ('1girl, teXt: hello there"', '1girl, teXt: hello there"'),
        ('1girl, "x", teXt: y"', '1girl, "x", teXt: x\n\ny"'),
    ]
    for given, want in cases:
        got = apply_text_section(given, v5)
        check(f"apply_text_section({given!r})", got == want, f"got {got!r}, want {want!r}")

    # 非 v5 必须逐字节原样返回
    for model in ("nai-diffusion-4-full", "nai-diffusion-3", "nai-diffusion-4-5-curated"):
        src = '1girl, "quoted", teXt: manual"'
        check(f"non-v5 passthrough ({model})", apply_text_section(src, model) == src)


# ---------------------------------------------------------------- main


def main() -> int:
    print("== 1. 64 对齐 ==")
    test_return_x64()
    test_return_max_size()
    print("== 2/3. 裁剪几何 (Python 自检) ==")
    test_crop_python_side()
    print("== 2/3. 裁剪几何 (与 JS 交叉验证) ==")
    test_crop_cross_check()
    print("== 4. teXt 段 ==")
    test_text_section()

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
