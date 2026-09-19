// ============================================================
// 裁剪重绘 (局部重绘) 的外侧选框几何 —— 纯函数, 不依赖 DOM
//
// 选框是"矩形套矩形"的闭环结构:
//   外框 = 沿它裁剪图片送进模型重绘的范围;
//   内框 = 外框四边各向内缩 a 像素 (inset), 是画笔唯一能涂抹的范围。
//
// 约束 (与后端 src/generate_images.py 的 CROP_MAX_AREA / CROP_SNAP 保持一致, 改动需两侧同步):
//   - 宽高与起点都吸附到 CROP_SNAP (64) 的倍数: 裁剪块尺寸就是送进模型的生成分辨率,
//     64 对齐之后 return_x64 不再需要向上取整, 生成结果与裁剪块 1:1, 不再有拉伸变形;
//     (64 自身是 8 的倍数, 所以 1/8 分辨率蒙版的 8x8 方格依旧严格对齐)
//   - 单边不设上限 (只受图像本身限制), 只约束面积 ≤ 1024×1024,
//     即在满足 64 的倍数后任意长宽都可以 (如 1280×800 / 256×1024);
//   - 内框没有最小区域要求: 外框最小边长 = 2a 向上对齐到 64 (a=32 时就是 64×64, 内框 0×0)。
//
// 选框画好之后还能就地改: 拖框内部 = 整体平移 (见文件末尾的 *CropHandle* 与平移一组函数),
// 拖右下角的手柄 = 固定左上角改宽高; 在框外拖拽则是重新框一个。
// ============================================================

export const CROP_MAX_AREA = 1024 * 1024;  // 外侧选框面积上限 (1024×1024, 注意不是单边上限)
export const CROP_MIN_INSET = 32;        // 内缩 a 的最小值
export const CROP_MAX_INSET = 96;        // 内缩 a 的最大值
export const CROP_INSET_STEP = 8;        // 内缩 a 的步长 (= 蒙版块边长, 保证内框仍落在 8 的网格上)
export const CROP_SNAP = 64;             // 外侧选框的对齐网格 (= 生成分辨率的最小单位, 也是 8 的倍数)
export const CROP_HANDLE_SCREEN_R = 10;  // 右下角调整手柄的半径 (屏幕 CSS 像素, 视觉与命中区一致)

export const snapGrid = (v) => Math.round(v / CROP_SNAP) * CROP_SNAP;
export const floorGrid = (v) => Math.floor(v / CROP_SNAP) * CROP_SNAP;
export const ceilGrid = (v) => Math.ceil(v / CROP_SNAP) * CROP_SNAP;

/** 内侧框: 外框四边各向内缩 inset 像素 (inset 是 8 的倍数, 所以内框同样落在 8 的网格上) */
export function innerCropRect(rect, inset) {
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    w: rect.w - inset * 2,
    h: rect.h - inset * 2,
  };
}

/**
 * 外侧选框合法化: 返回新的 {x, y, w, h}, 全部落在图像内且满足上面的全部约束。
 * @param {{x:number,y:number,w:number,h:number}} rect 期望的选框 (可为任意值, 会被吸附/夹紧)
 * @param {{inset:number, imageW:number, imageH:number}} ctx 当前内缩 a 与图像尺寸
 */
/** 图像能给的最大边长: 向下对齐到网格; 图像本身就比一格还小时只能退回图像尺寸 */
function maxSide(v) {
  const n = Math.max(0, Number(v) || 0);
  const f = floorGrid(n);
  return f >= CROP_SNAP ? f : Math.floor(n);
}

export function normalizeCropRect(rect, { inset, imageW, imageH }) {
  const imgW = Math.max(0, Number(imageW) || 0);
  const imgH = Math.max(0, Number(imageH) || 0);
  // 单边只受图像本身限制 (图像尺寸未必是 64 的倍数, 向下对齐); 不设 512 之类的硬上限,
  // 长宽可以任意搭配, 只要最终面积不超过 CROP_MAX_AREA 即可。
  const maxW = maxSide(imgW);
  const maxH = maxSide(imgH);
  // 下限: 内框只要不为负就行 (内框允许退化到 0×0, 所以最小边长 = 2a 向上对齐到网格);
  // 图像太小时以图像能容纳的最大值兜底
  const a = Math.max(0, Number(inset) || 0);
  const minW = Math.min(ceilGrid(2 * a), maxW);
  const minH = Math.min(ceilGrid(2 * a), maxH);
  const clampW = (v) => Math.min(Math.max(v, minW), maxW);
  const clampH = (v) => Math.min(Math.max(v, minH), maxH);

  let w = clampW(snapGrid(rect.w));
  let h = clampH(snapGrid(rect.h));
  // 面积上限: 逐步收缩较长边 (每次一格), 直到乘积落在 1024×1024 以内 (两边都到底就退出, 不会死循环)
  while (w * h > CROP_MAX_AREA && (w > minW || h > minH)) {
    if (w >= h) w = clampW(w - CROP_SNAP);
    else h = clampH(h - CROP_SNAP);
  }

  const x = Math.max(0, Math.min(snapGrid(rect.x), Math.max(0, floorGrid(imgW - w))));
  const y = Math.max(0, Math.min(snapGrid(rect.y), Math.max(0, floorGrid(imgH - h))));
  return { x, y, w, h };
}

/** 拖拽中的两点 -> 合法化后的外框 (反向拖拽时取左上角为起点) */
export function cropRectFromDrag(sx, sy, cx, cy, ctx) {
  return normalizeCropRect(
    { x: Math.min(sx, cx), y: Math.min(sy, cy), w: Math.abs(cx - sx), h: Math.abs(cy - sy) },
    ctx,
  );
}

// ---------------------------------------------------------------- 平移选框
//
// 框选好之后拖选框内部 = 整体平移 (尺寸与内缩都不变, 只是换个位置);
// 拖外框之外还是"重新框选", 两者靠命中区域区分。

/** 平移: 尺寸与内缩原样, 只改起点 (位置同样吸附 8, 越出图像时贴边停住) */
export function cropRectFromMove(rect, dx, dy, ctx) {
  return normalizeCropRect(
    { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h },
    ctx,
  );
}

/** 指针 (图像坐标) 是否落在选框内 (含四条边界): 拖这里 = 平移整个选框, 而不是重新框一个 */
export function hitCropRect(rect, px, py) {
  if (!rect) return false;
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

// ---------------------------------------------------------------- 右下角调整手柄
//
// 手柄圆心就是外框的右下角; 半径按"屏幕像素恒定"换算回图像坐标,
// 所以画布缩放多少, 手柄在屏幕上看起来都是同样大小、同样好点。

/** 手柄圆心 (图像坐标) = 外框右下角 */
export function cropHandleCenter(rect) {
  return { x: rect.x + rect.w, y: rect.y + rect.h };
}

/**
 * 手柄在图像坐标系的半径。
 * @param {number} scale 画布缩放 = 屏幕 CSS 像素 / 图像像素 (见 components.js 的 canvasScale)
 * @returns {number} 屏幕上半径恒为 CROP_HANDLE_SCREEN_R
 */
export function cropHandleRadius(scale) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  return CROP_HANDLE_SCREEN_R / s;
}

/** 指针 (图像坐标) 是否压在手柄上; 方形判定, 比圆形稍微好点一些 */
export function hitCropHandle(rect, px, py, scale) {
  if (!rect) return false;
  const c = cropHandleCenter(rect);
  const r = cropHandleRadius(scale);
  return Math.abs(px - c.x) <= r && Math.abs(py - c.y) <= r;
}

/**
 * 拖手柄时的外框: 左上角固定在 anchor, 右下角跟到指针 (px, py)。
 * 指针越过锚点时收到最小尺寸 (不翻转成反方向的框) —— 这是手柄与"重新框选"的关键区别。
 */
export function cropRectFromAnchor(anchor, px, py, ctx) {
  return normalizeCropRect(
    { x: anchor.x, y: anchor.y, w: Math.max(0, px - anchor.x), h: Math.max(0, py - anchor.y) },
    ctx,
  );
}
