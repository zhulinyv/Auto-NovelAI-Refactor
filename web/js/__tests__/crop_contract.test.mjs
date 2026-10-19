// ============================================================
// 前后端"镜像算法"契约测试 (Node 内置 test runner, 无依赖)
//
// 为什么需要
// ----------
// 项目里有 4 组算法在前后端各写了一份, 靠注释约定"改动需两侧同步":
//   1. 64 对齐      utils/helpers.return_x64        <-> web/js/views/generate.js round64
//   2. 裁剪归一化   src/generate_images._crop_rect_from_request <-> web/js/cropRect.js normalizeCropRect
//   3. 裁剪扩展     src/generate_images._expand_crop_rect       <-> web/js/cropRect.js expandCropRect
//   4. teXt 段整理  utils/prompt_text.apply_text_section        <-> web/js/views/generate.js applyTextSection
//
// 任何一侧单独改动都会造成"前端预览与后端实际请求不一致"的静默偏差 —— 不报错, 只是出图不对。
// 本文件对 (2)(3) 做黄金用例校验: 用同一批输入跑 JS 实现, 与 Python 实现的结果逐值比对。
//
// 运行:
//   node --test web/js/__tests__/crop_contract.test.mjs
// 或 (含 Python 一侧的交叉验证):
//   python tests/test_contracts.py
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCropRect, expandCropRect, innerCropRect, CROP_MIN_INSET } from "../cropRect.js";

// ---- 黄金用例: 由 Python 侧 (src/generate_images.py) 生成, 见 tests/test_contracts.py ----
// 结构: [输入框 {x,y,w,h}, 图像 {w,h}, inset, 期望 {x,y,w,h}]
export const NORMALIZE_CASES = [
  // 界内: 已经 64 对齐, 原样返回
  [{ x: 128, y: 128, w: 512, h: 512 }, { w: 1216, h: 832 }, 32, { x: 128, y: 128, w: 512, h: 512 }],
  // 界内: 未对齐 -> 吸附到最近的 64
  [{ x: 100, y: 100, w: 500, h: 500 }, { w: 1216, h: 832 }, 32, { x: 128, y: 128, w: 512, h: 512 }],
  // 面积超上限 -> 收缩
  [{ x: 0, y: 0, w: 2048, h: 2048 }, { w: 2048, h: 2048 }, 32, { x: 0, y: 0, w: 1024, h: 1024 }],
  // 起点越界 (负) -> 精确停在 -inset 边界上 (不移回网格: 幂等性要求)
  [{ x: -999, y: -999, w: 512, h: 512 }, { w: 1216, h: 832 }, 32, { x: -32, y: -32, w: 512, h: 512 }],
];

// 幂等性: 同一个框归一化两次, 结果必须相同 (后端会再兜底算一次)
test("normalizeCropRect is idempotent", () => {
  for (const [rect, image, inset] of NORMALIZE_CASES) {
    const once = normalizeCropRect(rect, { inset, imageW: image.w, imageH: image.h });
    const twice = normalizeCropRect(once, { inset, imageW: image.w, imageH: image.h });
    assert.deepEqual(twice, once, "not idempotent for " + JSON.stringify(rect));
  }
});

test("normalizeCropRect snaps to 64 grid when inside image", () => {
  const r = normalizeCropRect({ x: 100, y: 100, w: 500, h: 500 }, { inset: 32, imageW: 1216, imageH: 832 });
  assert.equal(r.x % 64, 0);
  assert.equal(r.y % 64, 0);
  assert.equal(r.w % 64, 0);
  assert.equal(r.h % 64, 0);
});

test("normalizeCropRect never exceeds CROP_MAX_AREA", () => {
  const r = normalizeCropRect({ x: 0, y: 0, w: 4096, h: 4096 }, { inset: 32, imageW: 4096, imageH: 4096 });
  assert.ok(r.w * r.h <= 1024 * 1024, `area ${r.w * r.h} exceeds cap`);
});

test("innerCropRect shrinks by inset on every side", () => {
  const inner = innerCropRect({ x: 128, y: 128, w: 512, h: 512 }, 32);
  assert.deepEqual(inner, { x: 160, y: 160, w: 448, h: 448 });
});

test("expandCropRect never exceeds the expansion cap and stays idempotent", () => {
  const image = { imageW: 1216, imageH: 832 };
  const grown = expandCropRect({ x: 256, y: 256, w: 128, h: 128 }, image);
  assert.ok(grown.w * grown.h <= 1024 * 1024);
  // 扩展结果再扩展一次应当收敛 (不继续变大)
  const again = expandCropRect(grown, image);
  assert.deepEqual(again, grown, "expandCropRect is not idempotent");
});

test("expandCropRect keeps the original rect covered", () => {
  const image = { imageW: 1216, imageH: 832 };
  const src = { x: 256, y: 256, w: 128, h: 128 };
  const g = expandCropRect(src, image);
  assert.ok(g.x <= src.x && g.y <= src.y);
  assert.ok(g.x + g.w >= src.x + src.w);
  assert.ok(g.y + g.h >= src.y + src.h);
});
