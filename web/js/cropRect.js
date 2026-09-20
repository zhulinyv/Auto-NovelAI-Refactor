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
//   - 单边不设 512 之类的硬上限, 只约束面积 ≤ 1024×1024 ——
//     在满足 64 的倍数后任意长宽都可以 (如 1280×800 / 256×1024);
//   - 内框没有最小区域要求: 外框最小边长 = 2a 向上对齐到 64 (a=32 时就是 64×64, 内框 0×0);
//   - 外框可以伸到图片外: 每边最多外扩 a —— 内框 = 外框每边向内缩 a, 所以"最多外扩 a"正好等价于
//     "内框始终落在图片内", 外框伸出去之后内框就能贴着图片边缘, 画笔才涂得到最外那一圈;
//   - 尺寸上限随"被钉住的那条边"走 (见 sideCap): 几何上限是 图片 + 2a; 而拖手柄 / 拖拽框选这类
//     "一条边固定、只让对面那条边动"的操作上限更紧 —— 收到"对面那条边正好伸出图片 a"为止,
//     也就是打到头时内框的对面那条边正好压在图片边缘上。收紧是必须的: 尺寸再大, 位置夹取的上界
//     (图宽-宽+a) 就会比下界 (-a) 还小, 夹取只好把固定的那条边自己推出去 —— 拖手柄时表现为
//     左上角突然向左跳 a 像素 ("左上角固定"失效)。
//   - 生成块 = 外框自动向外扩出来的裁剪范围 (见 expandCropRect): 外框太小 (宽高乘积不到该形状的上限)
//     时, 每轮四条边各向外扩 CROP_EXPAND_STEP (64) 像素, 扩到宽高乘积贴近上限为止 —— 正方形生成块
//     贴 1024×1024, 非正方形贴 1024×960。裁剪块的尺寸就是生成分辨率, 所以这一步等于"小框也按大分辨率
//     出图"; 扩出来的一圈只是给模型的上下文 —— 蒙版上它是黑的 (不重绘), 贴回时也就不会被改动。
//     某条边扩完会伸到图片外时这一轮就不扩它 (只扩对面的边), 所以扩展永远不越过图片。
//   - 归一化必须幂等 (前端画框算一次, 后端收到请求还会再兜底算一次, 同一个框喂回去必须原样返回):
//     被夹到边界上的 -a / 图宽-宽+a 一般不是 64 的倍数, 若写成"先吸附再夹取", 这个值会被下一次
//     吸附拉回网格 (a=32 时 -32 → 0), 两端算出来的裁剪位置就错开 a 像素 —— 所以越界一律"精确停在
//     边界上" (见 cropPos), 边界值自身就是归一化的不动点。
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

/** 图像能给的最大边长: 向下对齐到网格; 图像本身就比一格还小时只能退回图像尺寸 */
function maxSide(v) {
  const n = Math.max(0, Number(v) || 0);
  const f = floorGrid(n);
  return f >= CROP_SNAP ? f : Math.floor(n);
}

/**
 * 单边的尺寸上限。
 *
 * 外框每边最多伸出图片 a, 所以尺寸的几何上限是"图片 + 2a"(外框正好把图片连同两侧各 a 一起罩住)。
 * 若调用方钉住了某一条边 (拖右下角手柄时的左上角 / 重新框选时的起手角), 上限还要再收紧一档:
 * 只到"对面那条边伸出图片 a"为止 —— 钉左边在 ax 时, 宽最多 = 图宽 + a - ax。
 *
 * 收紧是必须的, 不是保守: 位置夹取的上界是 图宽-宽+a, 尺寸放得太大时它会比下界 -a 还小,
 * 夹取就只好把被钉住的那条边自己推出去 (拖手柄时左上角会突然向左跳 a 像素)。
 * 收好之后满载位置正好是"内框的对面那条边压在图片边缘上", 正是这个功能要的极限。
 * @param {number} size 图像在该方向上的边长
 * @param {number} inset 当前内缩 a
 * @param {number} [anchor] 被钉住的那条边的坐标 (左边 x / 上边 y); 不给就是纯几何上限
 */
function sideCap(size, inset, anchor) {
  const geom = maxSide(size + inset * 2);
  if (anchor === null || anchor === undefined || !Number.isFinite(Number(anchor))) return geom;
  const pin = Math.min(Math.max(Number(anchor), -inset), size + inset);   // 锚点本身越界时按边界算
  return Math.min(geom, maxSide(size + inset - pin));
}

/**
 * 外框起点的归一化: 界内吸附 64, 越过边界则精确停在边界上 (与后端 _crop_pos 逐值一致)。
 *
 * 边界 lo = -a、hi = 图宽 - 宽 + a 正是"内框压住图片边缘"的那两个位置, 一般不是 64 的倍数 ——
 * 这是刻意的, 也正是不能写成"先吸附再夹取"的原因: -a 被吸附一次就回到网格上 (a=32 时 -32 → 0),
 * 而前后端各归一化一次, 两次结果就会错开 a 像素。让边界值成为不动点, 幂等才有保证。
 * @param {number} v 期望的起点
 * @param {number} lo 外扩下界 (-a: 外框左边伸出图片 a, 此时内框左缘正好落在 0)
 * @param {number} hi 外扩上界 (图宽-宽+a: 内框右缘正好落在图宽上)
 */
function cropPos(v, lo, hi) {
  if (v <= lo) return lo;
  if (v >= hi) return hi;
  return Math.min(Math.max(snapGrid(v), lo), hi);   // 界内: 吸附 64; 吸附过头就退回边界
}

/**
 * 外侧选框合法化: 返回新的 {x, y, w, h}, 满足上面的全部约束。
 * 外框可以伸到图像外 (每边最多外扩 inset), 内框才是必须落在图像内的那一个。
 * @param {{x:number,y:number,w:number,h:number}} rect 期望的选框 (可为任意值, 会被吸附/夹紧)
 * @param {{inset:number, imageW:number, imageH:number, anchorX?:number, anchorY?:number}} ctx
 *        当前内缩 a 与图像尺寸; anchorX / anchorY = 本次操作"钉住不动"的那条边 (左边 x / 上边 y),
 *        只有拖手柄与重新框选才给 —— 给了就把尺寸上限收到"对面那条边伸出图片 a"为止 (见 sideCap),
 *        平移 / 直接归一化一个已有的框则不给 (框尺寸已经合法, 只要原样保留)。
 */
export function normalizeCropRect(rect, { inset, imageW, imageH, anchorX, anchorY }) {
  const imgW = Math.max(0, Number(imageW) || 0);
  const imgH = Math.max(0, Number(imageH) || 0);
  const a = Math.max(0, Number(inset) || 0);
  // 尺寸: 上限按 sideCap (几何上限 = 图像 + 2a; 钉住一条边时收到"对面那条边伸出图片 a"),
  // 不设 512 之类的硬上限, 长宽可以任意搭配, 只要最终面积不超过 CROP_MAX_AREA 即可。
  // 下限: 内框只要不为负就行 (内框允许退化到 0×0, 所以最小边长 = 2a 向上对齐到网格);
  // 图像太小时以图像能容纳的最大值兜底 (图像本身就比一格还小时 maxSide 会退回图像尺寸)。
  const minW = Math.min(ceilGrid(2 * a), maxSide(imgW));
  const minH = Math.min(ceilGrid(2 * a), maxSide(imgH));
  const maxW = Math.max(minW, sideCap(imgW, a, anchorX));   // 上限被收到比下限还小时以下限为准
  const maxH = Math.max(minH, sideCap(imgH, a, anchorY));
  const clampW = (v) => Math.min(Math.max(v, minW), maxW);
  const clampH = (v) => Math.min(Math.max(v, minH), maxH);

  let w = clampW(snapGrid(rect.w));
  let h = clampH(snapGrid(rect.h));
  // 面积上限: 逐步收缩较长边 (每次一格), 直到乘积落在 1024×1024 以内 (两边都到底就退出, 不会死循环)
  while (w * h > CROP_MAX_AREA && (w > minW || h > minH)) {
    if (w >= h) w = clampW(w - CROP_SNAP);
    else h = clampH(h - CROP_SNAP);
  }

  // 位置: 界内吸附 64, 越界精确停在边界上 —— 外框每边最多伸出图片 a, 此时内框正好压在图片边缘
  // (内框与外框的差就是 a: 上界处 inner.x === 0, 右界处 inner.x + inner.w === 图宽)
  const x = cropPos(rect.x, -a, imgW - w + a);
  const y = cropPos(rect.y, -a, imgH - h + a);
  return { x, y, w, h };
}

/**
 * 拖拽中的两点 -> 合法化后的外框 (反向拖拽时取左上角为起点)。
 *
 * 起手那一角就是这次操作"钉住不动"的角, 所以按"钉住一条边"收紧尺寸上限: 往右/下拖过头时,
 * 外框最多让对面那条边伸出图片 a (此时内框那条边正好压住图片边缘), 再大就得挪起手角了 ——
 * 不收紧的话, 尺寸一超过 图宽+a-起手位, 位置夹取反而会把起手角自己挤出图片外 (画面里看起来
 * 就是"我明明从图片左边拖的, 左边却跑出去了")。
 */
export function cropRectFromDrag(sx, sy, cx, cy, ctx) {
  const x0 = Math.min(sx, cx), y0 = Math.min(sy, cy);
  return normalizeCropRect(
    { x: x0, y: y0, w: Math.abs(cx - sx), h: Math.abs(cy - sy) },
    { ...ctx, anchorX: x0, anchorY: y0 },
  );
}

// ---------------------------------------------------------------- 平移选框
//
// 框选好之后拖选框内部 = 整体平移 (尺寸与内缩都不变, 只是换个位置);
// 拖外框之外还是"重新框选", 两者靠命中区域区分。

/** 平移: 尺寸与内缩原样, 只改起点 (界内吸附 64; 越出图像时停在外扩边界上, 内框正好压住图片边缘) */
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

/**
 * 手柄圆心 (图像坐标) = 外框右下角。
 * 外框伸出图片外时圆心会被图片范围夹住 (只夹圆心, 不动外框本身): 外框伸出去多少, 右下角就跑到
 * 画布外多少, 不夹的话手柄会整个画在画布之外 —— 看不见也就点不到, 而"伸到图片右/下边缘"恰恰
 * 是最需要拖手柄的场景。夹住之后手柄正好落在画布看得见的那一角上, 画出来的与能点中的仍然一致。
 * @param {{x:number,y:number,w:number,h:number}} rect 外框
 * @param {{w:number,h:number}} [bounds] 画布/图片尺寸; 不传则不做钳位 (纯几何用法)
 */
export function cropHandleCenter(rect, bounds) {
  const cx = rect.x + rect.w;
  const cy = rect.y + rect.h;
  if (!bounds) return { x: cx, y: cy };
  const bw = Math.max(0, Number(bounds.w) || 0);
  const bh = Math.max(0, Number(bounds.h) || 0);
  return { x: Math.min(Math.max(cx, 0), bw), y: Math.min(Math.max(cy, 0), bh) };
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
export function hitCropHandle(rect, px, py, scale, bounds) {
  if (!rect) return false;
  const c = cropHandleCenter(rect, bounds);
  const r = cropHandleRadius(scale);
  return Math.abs(px - c.x) <= r && Math.abs(py - c.y) <= r;
}

/**
 * 拖手柄时的外框: 左上角固定在 anchor, 右下角跟到指针 (px, py)。
 * 指针越过锚点时收到最小尺寸 (不翻转成反方向的框) —— 这是手柄与"重新框选"的关键区别。
 *
 * 左上角是"钉住不动"的那条边, 于是尺寸上限收到"右下角伸出图片 a"为止:
 * 拖到手柄打到头时, 内框的右/下缘正好压在图片边缘上 (画笔够得到图片最右/最下一圈),
 * 而且**左上角一直不动** —— 不收紧的话, 尺寸大到一定程度后位置夹取会把左上角自己推出去。
 */
export function cropRectFromAnchor(anchor, px, py, ctx) {
  return normalizeCropRect(
    { x: anchor.x, y: anchor.y, w: Math.max(0, px - anchor.x), h: Math.max(0, py - anchor.y) },
    { ...ctx, anchorX: anchor.x, anchorY: anchor.y },
  );
}

// ---------------------------------------------------------------- 外框的可视部分
//
// 画布就是图片本身 (compositeCanvas 的尺寸 = 图片尺寸), 所以"外框伸到图片外"的那一段画布上根本
// 没有地方画: 直接按原坐标 strokeRect 的话, 伸出去的那条边整个落在画布之外 —— 界面上看起来就是
// "外框不见了", 往左/上伸出时尤其明显 (左边和上边两条线全在画布外, 只剩环带和内框)。
// 所以绘制侧一律先取"外框 ∩ 画布", 再画看得见的那几条边; 被截断的那几条边由绘制侧标在画布边缘上。

/**
 * 外框与画布 (图片范围) 的交集, 以及四条边里哪几条被图片边界截断了。
 * @param {{x:number,y:number,w:number,h:number}} rect 外框 (图像坐标, 可以伸到图片外)
 * @param {{w:number,h:number}} bounds 画布尺寸 (= 图片尺寸)
 * @returns {{x:number,y:number,w:number,h:number,
 *            cutLeft:boolean,cutTop:boolean,cutRight:boolean,cutBottom:boolean}} 画布内的那部分 +
 *          四条边的截断标记 (true = 这条边在图片外, 画不出来)
 */
export function cropVisibleRect(rect, bounds) {
  const bw = Math.max(0, Number(bounds && bounds.w) || 0);
  const bh = Math.max(0, Number(bounds && bounds.h) || 0);
  const x0 = Math.max(rect.x, 0);
  const y0 = Math.max(rect.y, 0);
  const x1 = Math.min(rect.x + rect.w, bw);
  const y1 = Math.min(rect.y + rect.h, bh);
  return {
    x: x0,
    y: y0,
    w: Math.max(0, x1 - x0),
    h: Math.max(0, y1 - y0),
    cutLeft: rect.x < 0,
    cutTop: rect.y < 0,
    cutRight: rect.x + rect.w > bw,
    cutBottom: rect.y + rect.h > bh,
  };
}

// ---------------------------------------------------------------- 自动扩展生成块
//
// 裁剪块的尺寸就是送进模型的生成分辨率: 框选得小 (比如 512×512), 生成分辨率也跟着小, 出图质量与
// 整图生成差得远。所以在用户选框之外再自动向外扩几圈当上下文, 让生成分辨率尽量贴近该形状的上限:
// 正方形生成块贴 1024×1024, 非正方形贴 1024×960。扩出来的一圈在蒙版上是黑的 (不重绘), 贴回原图时
// 自然不会被改动 —— 用户看到的改动范围仍然只是自己框选的那块。
//
// 三个必须与后端 src/generate_images.py 的 CROP_EXPAND_* / _expand_crop_rect 逐值一致的细节:
//   1) 步长: 每轮每条边各向外扩 64 像素 (与外框的 64 网格同源, 扩完尺寸仍是 64 的倍数);
//   2) 某条边扩完会伸到图片外 -> 这一轮就不扩它, 只扩对面的边 (选框本来就伸到图片外的那几条边
//      因此永远扩不动) —— 扩展只往图片里长, 与"用户把外框拖到图片外"是两回事;
//   3) 每扩完一圈都重新看一眼宽高乘积: 超过该形状的上限就整圈作废 (宁可不扩, 也不能超上限)。
//      形状按"扩完之后"的宽高是否相等算: 四条边都能扩时方形框每轮都还是方的, 会一路长到 1024×1024;
//      只有某几条边能扩时框会变成非方的, 上限随即收到 1024×960。

export const CROP_EXPAND_STEP = 64;                    // 自动扩展的步长 (每边每轮)
export const CROP_EXPAND_MAX_AREA = 1024 * 1024;       // 正方形生成块的面积上限 (宽 == 高)
export const CROP_EXPAND_MAX_AREA_RECT = 1024 * 960;   // 非正方形生成块的面积上限

/** 生成块形状对应的面积上限: 正方形 1024×1024, 非正方形 1024×960 (与后端 _expand_max_area 一致) */
export function expandMaxArea(w, h) {
  const nw = Math.max(0, Number(w) || 0);
  const nh = Math.max(0, Number(h) || 0);
  return nw === nh ? CROP_EXPAND_MAX_AREA : CROP_EXPAND_MAX_AREA_RECT;
}

/**
 * 自动扩展: 把归一化后的外框向外扩成"生成块" (后端真正拿去裁剪的范围)。
 * 外框已经够大 (面积 ≥ 上限) 或四条边都扩不动时原样返回, 所以这一步是幂等的。
 * @param {{x:number,y:number,w:number,h:number}} rect 归一化后的外框 (允许已经伸到图片外)
 * @param {{imageW:number,imageH:number}} ctx 图片尺寸 (扩展不许越过它)
 * @returns {{x:number,y:number,w:number,h:number}} 生成块 (未扩展时与入参逐值一致)
 */
export function expandCropRect(rect, { imageW, imageH }) {
  const imgW = Math.max(0, Number(imageW) || 0);
  const imgH = Math.max(0, Number(imageH) || 0);
  let { x, y, w, h } = rect;
  if (!(w > 0) || !(h > 0)) return { x, y, w, h };
  // 每轮至少扩一条边 64 像素 => 面积严格变大, 又有上限兜着, 循环必然在有限轮内结束;
  // guard 只是防止常量被改坏之后死循环 (理论上不可达)。
  for (let guard = 0; guard < 4096; guard++) {
    // 四条边逐条判定: 只有"扩完还落在图片内"才扩它 (本来就伸到图片外的那几条边借此自动跳过)
    const x0 = x - CROP_EXPAND_STEP >= 0 ? x - CROP_EXPAND_STEP : x;
    const y0 = y - CROP_EXPAND_STEP >= 0 ? y - CROP_EXPAND_STEP : y;
    const x1 = x + w + CROP_EXPAND_STEP <= imgW ? x + w + CROP_EXPAND_STEP : x + w;
    const y1 = y + h + CROP_EXPAND_STEP <= imgH ? y + h + CROP_EXPAND_STEP : y + h;
    if (x0 === x && y0 === y && x1 === x + w && y1 === y + h) break;   // 四条边都扩不动了
    const nw = x1 - x0;
    const nh = y1 - y0;
    if (nw * nh > expandMaxArea(nw, nh)) break;   // 再扩一圈就超上限: 到此为止 (这一圈整个作废)
    x = x0;
    y = y0;
    w = nw;
    h = nh;
  }
  return { x, y, w, h };
}

