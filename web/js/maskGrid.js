// ============================================================
// 重绘蒙版: 8x8 网格模型 —— 纯函数, 不依赖 DOM
//
// 对齐 NovelAI 官网的蒙版绘制规则:
//   - 画布尺寸必须是 64 的倍数 (AI 能接受的分辨率), 上传的图片不是的话先居中裁剪掉多余部分;
//   - 蒙版的最小单位是 8x8 的图像块 (MASK_CELL), 画笔只在网格上落笔, 不产生小于 8px 的细节;
//   - 前端画出来的格子 = 后端送进模型的蒙版, 逐格一致 (所见即所得) ——
//     所以后端不再做任何形状扩张, 只把绘制区域涂白、其余涂黑。
//
// 因为画布边长是 64 的倍数, 而 64 = 8x8, 所以 8x8 网格一定能整除画布, 不会出现残缺格子。
//
// "重绘"包含两种模式: 局部重绘 (遮罩) 与 涂鸦重绘 (涂鸦引导)。两者共用同一套
// 网格化绘制与自动扩展规则 —— 涂鸦层相当于"带颜色的遮罩"。
// ============================================================

export const MASK_CELL = 8;      // 蒙版最小单位: 8x8 图像像素
export const MASK_ALIGN = 64;    // 画布尺寸必须对齐到 64 的倍数 (NovelAI 的分辨率要求)

/**
 * 把尺寸收敛到不超过它的最大 64 倍数, 且至少 64。
 * 例: 1024→1024, 1000→960, 300→256, 100→64, 10→64 (兜底到最小可用画布)
 */
export function floor64(v) {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  const f = Math.floor(n / MASK_ALIGN) * MASK_ALIGN;
  return f >= MASK_ALIGN ? f : MASK_ALIGN;
}

/**
 * 居中裁剪: 求把 (w, h) 收敛到 64 倍数后, 应保留的源图区域。
 *
 * 四边均匀削掉多余部分 (左右各削一半余量), 这样画面主体不会被单侧裁掉。
 * 余量是奇数时 (例如 1000 % 64 = 40, 每边 20 正好; 但 1010 % 64 = 50, 每边 25 也正好;
 * 若余量为 63 则每边 31.5), 多出的那 1 像素固定切在右侧/下侧 —— 保证
 * cutW + keepW + restW 严格等于原宽, 不会因为两次 round 而少裁/多裁 1 像素。
 *
 * @param {number} w 源图宽
 * @param {number} h 源图高
 * @param {{anchor?: "center"|"start"}} [opts] center = 居中裁剪 (默认); start = 只裁右下
 * @returns {{sx:number, sy:number, sw:number, sh:number, dw:number, dh:number,
 *            cropped:boolean, droppedW:number, droppedH:number}}
 *          sx/sy/sw/sh = 在源图上的裁剪区域; dw/dh = 目标尺寸 (= 64 的倍数)
 */
export function cropToAlign64(w, h, opts = {}) {
  const srcW = Math.max(1, Math.round(Number(w) || 0));
  const srcH = Math.max(1, Math.round(Number(h) || 0));
  const dw = floor64(srcW);
  const dh = floor64(srcH);
  // 源图比 64 还小时 floor64 会兜底到 64 —— 那是放大而不是裁剪, 此时裁剪区域取整张源图
  const dropW = Math.max(0, srcW - dw);
  const dropH = Math.max(0, srcH - dh);
  const start = opts.anchor === "start";
  const sx = start ? 0 : Math.floor(dropW / 2);
  const sy = start ? 0 : Math.floor(dropH / 2);
  return {
    // 裁剪区域不能超出源图: dw > srcW (放大场景) 时取整张源图
    sx, sy, sw: Math.min(dw, srcW), sh: Math.min(dh, srcH),
    dw, dh,
    cropped: dropW > 0 || dropH > 0,
    droppedW: dropW,
    droppedH: dropH,
  };
}

/** 图像坐标 -> 所属网格单元下标 (向下取整; 负值夹到 0, 画布外的指针不会产生负下标) */
export const cellIndex = (v) => Math.floor(Math.max(0, v) / MASK_CELL);

/** 网格单元下标 -> 该单元左上角的图像坐标 */
export const cellOrigin = (i) => i * MASK_CELL;

/**
 * 笔刷大小的取值范围 (对齐官网): 4 ~ 50。
 *
 * 单位是**格数**, 不是像素 —— 大小 N 表示边长 N x 8 像素的正方形:
 *   大小 4  -> 32x32 像素  (4x4 格)
 *   大小 50 -> 400x400 像素 (50x50 格)
 */
export const BRUSH_MIN = 4;
export const BRUSH_MAX = 50;
export const BRUSH_DEFAULT = 4;

/** 把笔刷大小收敛到 [BRUSH_MIN, BRUSH_MAX] 的整数 (格数) */
export function clampBrushSize(v) {
  const n = Math.round(Number(v) || 0);
  if (!Number.isFinite(n)) return BRUSH_DEFAULT;
  return Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, n));
}

/** 笔刷大小 (格数) -> 边长像素数 */
export const brushPixels = (brushSize) => clampBrushSize(brushSize) * MASK_CELL;

/**
 * 笔刷覆盖的格子范围 (相对落点格的偏移量) —— 画笔规则与预览共用的唯一真源。
 *
 * span 直接就是笔刷大小 (格数), 不做像素换算: 大小 N => 覆盖 N 个格子。
 * 覆盖范围必须是 span 个格子, 不能写成 2*pad+1 (那永远是奇数, 偶数 span 会少覆盖一格)。
 * 偶数 span 无法相对落点格对称, 所以奇数时两侧均分、偶数时多出的一格固定放在右下侧
 * (与 Canvas 的像素栅格一致: 矩形 [x, x+w) 从左上角开始铺)。
 *
 * @param {number} brushSize 笔刷大小 (**格数**, 4~50)
 * @returns {{lo:number, hi:number, span:number}} 相对落点格的闭区间偏移 (lo <= 0 <= hi, hi-lo+1 === span)
 */
export function brushSpan(brushSize) {
  const span = clampBrushSize(brushSize);
  const lo = -Math.floor((span - 1) / 2);
  return { lo, hi: lo + span - 1, span };
}

/**
 * 笔刷形状 —— 两档, 由 Square Brush 勾选框切换。
 *
 *   BRUSH_ROUND  圆 : 外接正方形挖掉四角 (未勾选 Square Brush)
 *   BRUSH_SQUARE 方 : 实心正方形, 铺满 span x span (勾选 Square Brush)
 *
 * 圆形按"格心是否落在外接圆内"逐格判定 (半径 = span/2 格, 圆心在方框正中):
 *   span=4 时每个角恰好挖掉 1 个 8x8 格 (四角各一格); span 越大挖掉的角越多
 *   (span=6 挖 4 格, span=8 挖 12 格, span=12 挖 32 格 ...), 逐步逼近真正的圆。
 */
export const BRUSH_ROUND = "round";
export const BRUSH_SQUARE = "square";

/**
 * 某形状下笔刷覆盖的格子 —— 画笔核心规则与预览共用的唯一真源。
 *
 * @param {number} brushSize 笔刷大小 (**格数**, 4~50; 边长 = brushSize * 8 像素)
 * @param {string} shape BRUSH_ROUND | BRUSH_SQUARE
 * @returns {Array<{c:number, r:number}>} 相对落点格的偏移 (落点格为 {c:0,r:0})
 */
export function brushCells(brushSize, shape = BRUSH_ROUND) {
  const { lo, hi, span } = brushSpan(brushSize);
  const out = [];
  if (shape === BRUSH_SQUARE) {
    for (let r = lo; r <= hi; r++) for (let c = lo; c <= hi; c++) out.push({ c, r });
    return out;
  }

  // 圆形: 半径 = span/2 格, 圆心在方框正中。
  // 用 (i + 0.5 - span/2) 表示"格心到圆心的距离", 偶数 span 时圆心正好落在格子交界上,
  // 结果天然左右/上下对称 (不会偏向任何一侧)。
  const R = span / 2;
  const r2 = R * R;
  for (let r = lo; r <= hi; r++) {
    for (let c = lo; c <= hi; c++) {
      const dx = (c - lo + 0.5) - R;
      const dy = (r - lo + 0.5) - R;
      if (dx * dx + dy * dy <= r2 + 1e-9) out.push({ c, r });
    }
  }
  return out;
}

/**
 * 把一支画笔笔迹收敛成网格对齐的矩形集合 —— 画笔的核心规则。
 *
 * 笔迹被表示为"从 (px0, py0) 到 (px1, py1) 的圆头线段" (与 Canvas 的 lineCap:round 语义一致),
 * 这里返回覆盖该线段的所有网格单元。
 *
 * 关键: 两端先各自吸附到**格心**, 再按 span 数格子 —— 而不是把原始像素坐标塞进包围盒。
 * 否则笔刷会骑在网格线上: 8px 的笔刷点在格心 (36,36) 时包围盒是 [32,40], 正好压住 32 这条
 * 网格线, 会同时涂到第 3 格和第 4 格 —— 用户点一下却涂了两格。
 *
 * @param {number} x0 起点 (图像像素, 内部会吸附到格心)
 * @param {number} y0
 * @param {number} x1 终点 (图像像素)
 * @param {number} y1
 * @param {number} brushSize 笔刷直径 (图像像素); 方形笔刷时即边长
 * @param {number} canvasW 画布宽 (图像像素)
 * @param {number} canvasH 画布高 (图像像素)
 * @param {string} shape BRUSH_ROUND | BRUSH_SQUARE —— 决定笔迹的轮廓 (圆会切掉四角)
 * @returns {{c0:number, r0:number, c1:number, r1:number}|null} 覆盖的单元外框 (闭区间); 越界时返回 null
 */
export function strokeCells(x0, y0, x1, y1, brushSize, canvasW, canvasH, shape = BRUSH_ROUND) {
  void shape;   // 形状由 brushCells 逐格筛选, 这里只负责算出需要遍历的外框
  const w = Math.max(0, Number(canvasW) || 0);
  const h = Math.max(0, Number(canvasH) || 0);
  if (w <= 0 || h <= 0) return null;
  const cols = Math.ceil(w / MASK_CELL);
  const rows = Math.ceil(h / MASK_CELL);

  // 先用**原始坐标**判越界: snapToCellCenter 会把负数夹到第 0 格 (那是给预览用的,
  // 指针稍微移出画布时预览仍停在边缘), 但真实落笔不能靠这个夹取 ——
  // 否则指针拖到画布外会凭空在边缘冒出一排格子。两端都在画布外时直接判无效。
  const inCanvas = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < w && y < h;
  if (!inCanvas(x0, y0) && !inCanvas(x1, y1)) return null;
  // 端点只有一个在画布外时, 把它夹回画布内 (沿线段方向贴边), 避免越界端算出负下标
  const cx0 = Math.min(Math.max(x0, 0), w - 1), cy0 = Math.min(Math.max(y0, 0), h - 1);
  const cx1 = Math.min(Math.max(x1, 0), w - 1), cy1 = Math.min(Math.max(y1, 0), h - 1);

  const { lo, hi } = brushSpan(brushSize);

  // 两端吸附到格心后再转成格坐标
  const p0 = snapToCellCenter(cx0, cy0);
  const p1 = snapToCellCenter(cx1, cy1);
  const cA = Math.round((p0.x - MASK_CELL / 2) / MASK_CELL);
  const rA = Math.round((p0.y - MASK_CELL / 2) / MASK_CELL);
  const cB = Math.round((p1.x - MASK_CELL / 2) / MASK_CELL);
  const rB = Math.round((p1.y - MASK_CELL / 2) / MASK_CELL);

  // 线段两端的格子各自铺开 span 格, 取并集
  const cc0 = Math.max(0, Math.min(cA, cB) + lo);
  const cc1 = Math.min(cols - 1, Math.max(cA, cB) + hi);
  const rr0 = Math.max(0, Math.min(rA, rB) + lo);
  const rr1 = Math.min(rows - 1, Math.max(rA, rB) + hi);

  if (cc1 < cc0 || rr1 < rr0) return null;   // 完全落在画布外
  return { c0: cc0, r0: rr0, c1: cc1, r1: rr1 };
}

/**
 * 一次笔迹实际覆盖的格子集合 (已按笔刷形状筛选, 并夹取到画布内)。
 *
 * 与 strokeCells 的关系: strokeCells 只给"要遍历哪个外框", 本函数在外框内逐端铺开
 * brushCells (圆/方形状), 取两端的并集, 再夹到画布内并按 8x8 网格去重。
 *
 * 之所以两端分别铺开、而不是"外框直接内缩成圆": 圆头线段的中间段是矩形, 两端才是半圆;
 * 两端各按圆形铺开、把中间的格子按行/列补齐, 得到的正是这个形状的网格近似。
 *
 * @returns {{cells: Array<{c:number,r:number}>, anchorC:number, anchorR:number}}
 *          cells = 去重夹取后的格子; anchorC/anchorR = 落点格坐标 (预览用它摆容器)
 */
export function strokeCellSetDetailed(x0, y0, x1, y1, brushSize, canvasW, canvasH, shape = BRUSH_ROUND) {
  const box = strokeCells(x0, y0, x1, y1, brushSize, canvasW, canvasH, shape);
  if (!box) return { cells: [], anchorC: 0, anchorR: 0 };
  const w = Math.max(0, Number(canvasW) || 0);
  const h = Math.max(0, Number(canvasH) || 0);
  const cols = Math.ceil(w / MASK_CELL);
  const rows = Math.ceil(h / MASK_CELL);

  // 两端的格坐标 (与外框算法同源)
  const cx0 = Math.min(Math.max(x0, 0), w - 1), cy0 = Math.min(Math.max(y0, 0), h - 1);
  const cx1 = Math.min(Math.max(x1, 0), w - 1), cy1 = Math.min(Math.max(y1, 0), h - 1);
  const p0 = snapToCellCenter(cx0, cy0);
  const p1 = snapToCellCenter(cx1, cy1);
  const a = { c: Math.round((p0.x - MASK_CELL / 2) / MASK_CELL), r: Math.round((p0.y - MASK_CELL / 2) / MASK_CELL) };
  const b = { c: Math.round((p1.x - MASK_CELL / 2) / MASK_CELL), r: Math.round((p1.y - MASK_CELL / 2) / MASK_CELL) };

  const shape_ = brushCells(brushSize, shape);
  const clamp = (v, hi) => Math.min(Math.max(v, 0), hi - 1);
  const seen = new Set();
  const out = [];
  const put = (c, r) => {
    const cc = clamp(c, cols), rr = clamp(r, rows);
    const key = cc * 100000 + rr;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ c: cc, r: rr });
  };

  // 两端各铺一次形状; 中间逐格补一条直线, 保证拖动不断线
  for (const cell of shape_) {
    put(a.c + cell.c, a.r + cell.r);
    put(b.c + cell.c, b.r + cell.r);
  }
  const dc = b.c - a.c, dr = b.r - a.r;
  const steps = Math.max(Math.abs(dc), Math.abs(dr));
  for (let i = 1; i < steps; i++) {
    const c = Math.round(a.c + (dc * i) / steps);
    const r = Math.round(a.r + (dr * i) / steps);
    for (const cell of shape_) put(c + cell.c, r + cell.r);
  }

  return { cells: out, anchorC: clamp(b.c, cols), anchorR: clamp(b.r, rows) };
}

/**
 * 一次笔迹实际覆盖的格子集合 (只看格子列表的精简版)。
 * @returns {Array<{c:number,r:number}>}
 */
export function strokeCellSet(x0, y0, x1, y1, brushSize, canvasW, canvasH, shape = BRUSH_ROUND) {
  return strokeCellSetDetailed(x0, y0, x1, y1, brushSize, canvasW, canvasH, shape).cells;
}

/**
 * 指针位置 -> 吸附到网格中心。
 *
 * 画笔的"落点"永远是某个 8x8 格子的中心, 这样笔迹关于格子对称、视觉上居中,
 * 也保证连续移动时覆盖的格子单调前进 (不会因为跨格判定而抖动)。
 */
export function snapToCellCenter(x, y) {
  return {
    x: cellOrigin(cellIndex(x)) + MASK_CELL / 2,
    y: cellOrigin(cellIndex(y)) + MASK_CELL / 2,
  };
}

/**
 * 快速选区 (矩形/椭圆/套索) 的网格化: 把任意点集收敛成格子的集合。
 * @param {(col:number,row:number,x:number,y:number)=>boolean} test 判断某格是否被选中
 *        (参数为该格左上角坐标与格中心坐标, 便于矩形/椭圆/多边形判定)
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {Array<{c:number,r:number}>} 选中的格子列表
 */
export function collectCells(test, canvasW, canvasH) {
  const cols = Math.ceil(Math.max(0, canvasW) / MASK_CELL);
  const rows = Math.ceil(Math.max(0, canvasH) / MASK_CELL);
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * MASK_CELL;
      const y = r * MASK_CELL;
      if (test(c, r, x, y, x + MASK_CELL / 2, y + MASK_CELL / 2)) out.push({ c, r });
    }
  }
  return out;
}

