// ============================================================
// Pixel Snap: NovelAI 官方 pixelsnap worker 的浏览器端纯 JS 移植
// ============================================================
// 与官网 (novelai.net/image -> Director Tools -> Pixel Snap) 走同一套判定流程:
//   1) 梯度轮廓 + 周期图(periodogram)找峰 -> 候选像素周期 (支持非整数周期)
//   2) 两段式 spread 搜索 (粗扫 -> 保留集 -> 精扫 + 相位抖动) 定出周期与 x/y 相位
//   3) 亚谐波 (pitch/2, pitch/3) 用"网格重建 MAE 改善 20%"序贯判据决定是否细化
//      (勾选 Avoid Over-Refining 时跳过, 与官方 maxDetail:null 同构)
//   4) 一维 DP 非刚性边界拟合 (刚性模式为等分) -> 逻辑网格
//   5) 单元按 margin 内缩后取"中位色"采样 -> 逻辑分辨率图 (抗锯齿边缘被排除)
//   6) Palettize: 八叉树 + Lab 距离按计数加权贪心合并 (官方默认 tree)
// 第 2/3 步官方在 WebGPU/WebGL/WASM 上穷举 (纯 JS 后端 1M 像素的平滑图实测 50-70s, 浏览器不可接受)。
// 这里保留同一份 6 通道整数 SAT + 矩形方差公式, 但给整轮搜索一个"矩形评估数"预算 (默认 1.1e8):
// 按阶段分配预算, 超出时把格区间做分层随机抽稀 (与官方粗扫 stride=2 同理, 无偏), 于是耗时近似与
// 图片尺寸无关 (实测 0.06-2M 像素 0.5-3s)。预算充足时抽稀自动退回官方步长 (粗 2 / 精 1),
// 对干净的像素图 (最近邻放大 / 透明通道 / 轻压缩) 与官方逐位一致。
// 与官网的另一处差异: 官方在"找不到周期"时直接报错, 这里退让为最强峰继续处理, 因为用户反馈的
// 主要问题就是"很多图无法处理"; 只有纯色与全透明才判失败。
// 本模块不依赖 DOM, 便于离线单测; 画布解码/编码与最近邻放回在 director.js 里完成。
// ============================================================

/** 四舍六入五取偶 (官方 p()) */
const rndHalf = (v) => {
  const t = Math.floor(v), f = v - t;
  return f < 0.5 ? t : f > 0.5 ? t + 1 : (t % 2 === 0 ? t : t + 1);
};
/** 恒正取模 (官方 w()) */
const pmod = (v, m) => { const r = v % m; return r < 0 ? r + m : r; };
/** [a,b] 均匀 r 点, 末点强制 b (官方 b()) */
function linspace(a, b, r) {
  const out = new Float64Array(r);
  if (r === 1) { out[0] = a; return out; }
  const st = (b - a) / (r - 1);
  for (let i = 0; i < r; i++) out[i] = i * st + a;
  out[r - 1] = b;
  return out;
}
/** 变体列表改成"由内向外"排列: 官方穷举时最优解唯一, 抽稀后会出现并列
 *  (错位网格刚好采不到跨界单元 -> spread 同为 0)。argmin 取第一个最小值, 升序排列就会
 *  偏向最细的那一档, 随后被"MAE 改善 20%"判据采纳成 2x/3x 过细网格。中心优先 = 并列时
 *  选最接近周期图估计的档位, 与官网一致, 也不会过度细化。 */
function centerFirst(arr) {
  const n = arr.length;
  if (n < 3) return Array.from(arr);
  const mid = (arr[0] + arr[n - 1]) / 2;
  return Array.from(arr).sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y);
}

/** [0,1) 的 n 个等分相位 (官方 R()) */
function phases(n) { const t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = i / n; return t; }
/** 线性插值百分位 (官方 y()) */
function pct(arr, q) {
  const r = Float64Array.from(arr);
  r.sort();
  const n = r.length;
  if (n === 0) return NaN;
  if (n === 1) return r[0];
  const a = (q / 100) * (n - 1), lo = Math.floor(a), hi = Math.ceil(a);
  return r[lo] + (r[hi] - r[lo]) * (a - lo);
}
/** 官方 A(): 分块求和。累加顺序会影响浮点末位, 而候选判定常有并列,
 *  所以这里连"怎么加"都要和官方一致 (8 路累加器 / 折半递归)。 */
function sumRange(e, t, r) {
  if (r < 8) { let n = 0; for (let a = 0; a < r; a++) n += e[t + a]; return n; }
  if (r <= 128) {
    let n, a0 = e[t], a1 = e[t + 1], a2 = e[t + 2], a3 = e[t + 3], a4 = e[t + 4], a5 = e[t + 5], a6 = e[t + 6], a7 = e[t + 7];
    for (n = 8; n < r - r % 8; n += 8) {
      a0 += e[t + n]; a1 += e[t + n + 1]; a2 += e[t + n + 2]; a3 += e[t + n + 3];
      a4 += e[t + n + 4]; a5 += e[t + n + 5]; a6 += e[t + n + 6]; a7 += e[t + n + 7];
    }
    let h = a0 + a1 + (a2 + a3) + (a4 + a5 + (a6 + a7));
    for (; n < r; n++) h += e[t + n];
    return h;
  }
  let n = Math.floor(r / 2); n -= n % 8;
  return sumRange(e, t, n) + sumRange(e, t + n, r - n);
}

/** 子数组最小值下标 (官方 T()) */
function argmin(arr, off, len) {
  let bi = 0, bv = arr[off];
  for (let i = 1; i < len; i++) { const v = arr[off + i]; if (v < bv) { bv = v; bi = i; } }
  return bi;
}
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------------------------------------------------------- 统计基础

/** 列/行梯度轮廓: 每对相邻列/行的 |dR|+|dG|+|dB| 累加 */
function gradientProfiles(rgb, W, H) {
  const col = new Float64Array(Math.max(1, W - 1));
  for (let y = 0; y < H; y++) {
    let a = y * W * 3;
    for (let x = 0; x < W - 1; x++, a += 3) {
      col[x] += Math.abs(rgb[a + 3] - rgb[a]) + Math.abs(rgb[a + 4] - rgb[a + 1]) + Math.abs(rgb[a + 5] - rgb[a + 2]);
    }
  }
  const row = new Float64Array(Math.max(1, H - 1));
  for (let y = 0; y < H - 1; y++) {
    const a1 = W * 3;
    let acc = 0, a0 = y * W * 3;
    for (let x = 0; x < W; x++) {
      const p = a0 + x * 3, q = p + a1;
      acc += Math.abs(rgb[q] - rgb[p]) + Math.abs(rgb[q + 1] - rgb[p + 1]) + Math.abs(rgb[q + 2] - rgb[p + 2]);
    }
    row[y] = acc;
  }
  return { col, row };
}

/** 6 通道整数积分图: RGB 的 sum 与 sumsq, 前缀和按 uint32 环绕 (与官方一致) */
function buildSAT(rgb, W, H) {
  const W1 = W + 1;
  const S = new Uint32Array((H + 1) * W1 * 6);
  for (let y = 1; y <= H; y++) {
    const up = (y - 1) * W1, cur = y * W1;
    for (let x = 1; x <= W; x++) {
      const i = ((y - 1) * W + (x - 1)) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const o = (cur + x) * 6, p1 = (up + x) * 6, q1 = (cur + x - 1) * 6, r1 = (up + x - 1) * 6;
      S[o] = (r + S[p1] + S[q1] - S[r1]) >>> 0;
      S[o + 1] = (g + S[p1 + 1] + S[q1 + 1] - S[r1 + 1]) >>> 0;
      S[o + 2] = (b + S[p1 + 2] + S[q1 + 2] - S[r1 + 2]) >>> 0;
      S[o + 3] = (r * r + S[p1 + 3] + S[q1 + 3] - S[r1 + 3]) >>> 0;
      S[o + 4] = (g * g + S[p1 + 4] + S[q1 + 4] - S[r1 + 4]) >>> 0;
      S[o + 5] = (b * b + S[p1 + 5] + S[q1 + 5] - S[r1 + 5]) >>> 0;
    }
  }
  return S;
}

/** spread 引擎 (官方 js 后端): 同一张 6 通道整数 SAT, 矩形方差公式逐格累加 */
function makeEngine(S, W, H) {
  const W1 = W + 1;
  // 单个矩形内三通道"平均标准差"的均值: sqrt(n*S2 - S1^2)/n
  const rectStd = (r0, r1, c0, c1) => {
    const n = (r1 - r0) * (c1 - c0);
    if (n <= 0) return 0;
    const a11 = (r1 * W1 + c1) * 6, a10 = (r1 * W1 + c0) * 6;
    const a01 = (r0 * W1 + c1) * 6, a00 = (r0 * W1 + c0) * 6;
    const inv = 1 / n;
    const s1r = (S[a11] - S[a10] - S[a01] + S[a00]) >>> 0;
    const s2r = (S[a11 + 3] - S[a10 + 3] - S[a01 + 3] + S[a00 + 3]) >>> 0;
    const s1g = (S[a11 + 1] - S[a10 + 1] - S[a01 + 1] + S[a00 + 1]) >>> 0;
    const s2g = (S[a11 + 4] - S[a10 + 4] - S[a01 + 4] + S[a00 + 4]) >>> 0;
    const s1b = (S[a11 + 2] - S[a10 + 2] - S[a01 + 2] + S[a00 + 2]) >>> 0;
    const s2b = (S[a11 + 5] - S[a10 + 5] - S[a01 + 5] + S[a00 + 5]) >>> 0;
    let vr = n * s2r - s1r * s1r; if (vr < 0) vr = 0;
    let vg = n * s2g - s1g * s1g; if (vg < 0) vg = 0;
    let vb = n * s2b - s1b * s1b; if (vb < 0) vb = 0;
    return (Math.sqrt(vr) + Math.sqrt(vg) + Math.sqrt(vb)) * inv / 3;
  };
  // 描述符的"选中格区间"列表按次缓存 (同一描述符在整轮搜索里被反复复用)
  const listsOf = (desc) => {
    if (!desc._lists) {
      const { A, Z, sel, B, P, K } = desc;
      const lists = new Array(B * P);
      for (let bp = 0; bp < B * P; bp++) {
        const base = bp * K;
        let cnt = 0;
        for (let i = 0; i < K; i++) if (sel[base + i]) cnt++;
        const arr = new Int32Array(cnt * 2);
        let j = 0;
        for (let i = 0; i < K; i++) if (sel[base + i]) { arr[j++] = A[base + i]; arr[j++] = Z[base + i]; }
        lists[bp] = arr;
      }
      desc._lists = lists;
    }
    return desc._lists;
  };
  function spread(inner, outer, innerIsCol) {
    const { B: iB, P: iP } = inner;
    const iLists = listsOf(inner), oLists = listsOf(outer);
    const out = new Float64Array(iB * iP);
    for (let b = 0; b < iB; b++) {
      const oList = oLists[b];
      const oLen = oList.length, rc = oLen >> 1;
      for (let p = 0; p < iP; p++) {
        const iList = iLists[b * iP + p];
        const iLen = iList.length, cc = iLen >> 1;
        if (cc < 3 || rc < 3) { out[b * iP + p] = 1e18; continue; }
        let acc = 0;
        if (innerIsCol) {
          for (let oi = 0; oi < oLen; oi += 2) {
            const r0 = oList[oi], r1 = oList[oi + 1];
            for (let ii = 0; ii < iLen; ii += 2) acc += rectStd(r0, r1, iList[ii], iList[ii + 1]);
          }
        } else {
          for (let ii = 0; ii < iLen; ii += 2) {
            const c0 = iList[ii], c1 = iList[ii + 1];
            for (let oi = 0; oi < oLen; oi += 2) acc += rectStd(oList[oi], oList[oi + 1], c0, c1);
          }
        }
        out[b * iP + p] = acc / (rc * cc);
      }
    }
    return out;
  }
  return {
    spreadRows: (inner, outer) => spread(inner, outer, true),
    spreadCols: (inner, outer) => spread(inner, outer, false),
    maxPixels: 0,
  };
}

/** 确定性伪随机 [0,1): 抽稀点位必须可复现, 否则同一张图两次结果不同 */
function rand01(seed) {
  let x = (seed | 0) || 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) | 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) | 0;
  x = x ^ (x >>> 15);
  return (x >>> 0) / 4294967296;
}

/** 单元区间 (官方 v()): 每个 (pitch, 相位) 组合给出格区间与掩码。
 *  超出工作预算时按 stride 抽稀 —— 用"分层随机"而不是"整除跳步":
 *  跳步会和像素画本身的重复图案同相, 只采到少数几种颜色, 把 spread 估偏;
 *  分层随机每层取一点, 无偏且方差更小, 同预算下更接近官方穷举结果。 */
function makeCells(start, end, pitches, offsets, stride) {
  const L = pitches.length, O = offsets[0].length;
  let minP = Infinity;
  for (let i = 0; i < L; i++) if (pitches[i] < minP) minP = pitches[i];
  const K = Math.ceil((end - start) / minP) + 3;
  const N = L * O * K;
  const A = new Int32Array(N), Z = new Int32Array(N), sel = new Uint8Array(N);
  for (let i = 0; i < L; i++) {
    const p = pitches[i], half = Math.max(1, 0.27 * p);
    for (let j = 0; j < O; j++) {
      const d = start + pmod(offsets[i][j], 1) * p - p;
      const base = (i * O + j) * K;
      // 完整落在轴内的格是一段连续下标, 直接算出个数 (不必先遍历)
      let cMin = Math.ceil((start - 1e-9 - d) / p), cMax = Math.floor((end + 1e-9 - p - d) / p);
      if (cMin < 0) cMin = 0;
      if (cMax > K - 1) cMax = K - 1;
      const m = cMax - cMin + 1;
      for (let c = 0; c < K; c++) {          // 格区间本身全都算 (官方也算, 只有 sel 参与抽稀)
        const n = d + c * p;
        let lo = Math.floor(n + half), hi = Math.ceil(n + p - half);
        if (hi - lo < 2) { const mid = Math.floor(n + p / 2); lo = mid - 1; hi = mid + 1; }
        A[base + c] = lo; Z[base + c] = hi;
      }
      if (m <= 0) continue;
      const need = Math.min(m, Math.ceil(m / stride));
      if (need >= m) { for (let c = cMin; c <= cMax; c++) sel[base + c] = 1; continue; }
      let q = 0, next = Math.floor(rand01(i * 73856093 ^ j * 19349663) * (m / need));
      for (let c = cMin; c <= cMax; c++) {
        if (c - cMin === next) { sel[base + c] = 1; q++; next = q * (m / need) + Math.floor(rand01((i * 31 + j) * 2654435761 ^ q) * (m / need)); if (next >= m) next = m - 1; }
      }
    }
  }
  return { A, Z, sel, B: L, P: O, K };
}
/** 单固定相位版本 (官方 F()) */
const makeCellsFixed = (s, e, p, offs, stride) => makeCells(s, e, p, Array.from(offs, (o) => [o]), stride);
// ------------------------------------------------------ 1) 候选周期检测

/** 轮廓裁剪: 忽略 2% 以下的噪声列, 再用 60 分位截断离群尖峰, 防止强边缘支配归一化 */
function clampProfile(prof) {
  let mx = -Infinity;
  for (let i = 0; i < prof.length; i++) if (prof[i] > mx) mx = prof[i];
  const thr = 0.02 * mx + 1e-12;
  const nz = [];
  for (let i = 0; i < prof.length; i++) if (prof[i] > thr) nz.push(prof[i]);
  const cap = nz.length ? pct(nz, 60) : mx;
  const out = new Float64Array(prof.length);
  for (let i = 0; i < prof.length; i++) out[i] = Math.min(prof[i], cap);
  return out;
}

/** 单周期功率 (官方周期图): 按相位分桶 -> 分段取窗内最大质量占比 -> 按段质量加权平均 */
function periodogram(prof, pitch, coverFrac, minSeg) {
  if (coverFrac === undefined) coverFrac = 0.7;
  if (minSeg === undefined) minSeg = 14;
  const n = prof.length;
  if (n < 2) return 0;
  const segLen = Math.trunc(Math.max(80, minSeg * pitch));
  const buckets = Math.max(8, rndHalf(pitch / 0.25));
  const bw = pitch / buckets;
  const win = Math.max(1, rndHalf(coverFrac / bw));
  const segs = Math.floor((n - 1) / segLen) + 1;
  const f = new Float64Array(segs * buckets);
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / segLen);
    let bk = Math.floor(pmod(i + 1, pitch) / bw);
    if (bk > buckets - 1) bk = buckets - 1;
    f[seg * buckets + bk] += prof[i];
  }
  const c = buckets + win;
  const pre = new Float64Array(c + 1);
  const g = new Float64Array(segs), m = new Float64Array(segs);
  const d = (win * bw) / pitch;
  let b = 0;
  for (let s = 0; s < segs; s++) {
    const t = s * buckets;
    const total = sumRange(f, t, buckets);
    if (total <= 1e-9) continue;
    pre[0] = 0;
    for (let i = 0; i < c; i++) pre[i + 1] = pre[i] + f[t + (i < buckets ? i : i - buckets)];
    let best = -Infinity;
    for (let i = 0; i < buckets; i++) { const v = pre[i + win] - pre[i]; if (v > best) best = v; }
    g[b] = best / total / d;
    m[b] = total;
    b++;
  }
  if (b === 0) return 0;
  const y = new Float64Array(b);
  for (let i = 0; i < b; i++) y[i] = g[i] * m[i];
  const sm = sumRange(m, 0, b);
  return sm > 0 ? sumRange(y, 0, b) / sm : 0;
}

/** 候选周期表 (官方): 两轴周期图在 [3,24] 上以 .02 步长求功率, 局部极大 + 阈值 1.12
 *  -> 每轴前 8 峰 -> 谐波折叠到 >=3 并去重。官方此时若无候选直接抛错, 这里退让一档。*/
function pitchCandidates(profiles, cfg) {
  cfg = cfg || {};
  const minPitch = cfg.minPitch === undefined ? 3 : cfg.minPitch;
  const maxPitch = cfg.maxPitch === undefined ? 24 : cfg.maxPitch;
  const step = cfg.step === undefined ? 0.02 : cfg.step;
  const threshold = cfg.threshold === undefined ? 1.12 : cfg.threshold;
  // 官方用 (min+step)-min 作为步长再乘 index, 末位与 min+i*step 不同, 会改变并列判定
  const n = Math.max(0, Math.ceil((maxPitch - minPitch) / step));
  const ladder = step === 0.02 ? minPitch + step - minPitch : step;
  const grid = new Float64Array(n);
  if (n > 0) grid[0] = minPitch;
  if (n > 1) grid[1] = minPitch + step;
  for (let i = 2; i < n; i++) grid[i] = minPitch + i * ladder;
  const raw = [];
  let strongest = null;
  for (let a = 0; a < profiles.length; a++) {
    const cl = clampProfile(profiles[a]);
    const power = new Float64Array(grid.length);
    for (let i = 0; i < grid.length; i++) power[i] = periodogram(cl, grid[i]);
    const peaks = [];
    for (let i = 0; i < grid.length; i++) {
      let local = -Infinity;
      for (let j = Math.max(0, i - 15); j < Math.min(grid.length, i + 16); j++) if (power[j] > local) local = power[j];
      if (power[i] < local) continue;
      if (power[i] > threshold) peaks.push([power[i], grid[i]]);
      if (!strongest || power[i] > strongest[0]) strongest = [power[i], grid[i], a];
    }
    peaks.sort((x, y) => y[0] - x[0] || y[1] - x[1]);
    for (const pk of peaks.slice(0, 8)) raw.push(pk[1]);
  }
  const strong = raw.length > 0;   // 是否真有峰超过官方 1.12 阈值
  let list = raw;
  if (!list.length && strongest) list = [strongest[1]];   // 弱周期 (平滑照片) 也照常给出结果, 不再像官网那样直接判失败
  list = list.slice().sort((x, y) => x - y);
  const out = [];
  for (const e of list) {
    for (let r = 1; e / r >= minPitch - 1e-9; r++) {
      const v = e / r;
      if (out.every((o) => Math.abs(v - o) > 0.12)) out.push(v);
    }
  }
  return { pitches: out.sort((x, y) => x - y), strong };
}

// ------------------------------------------------------ 2/3) 网格搜索

/** 2 的幂向上取整 (抽稀步长) */
function pow2(v) { let s = 1; while (s < v) s *= 2; return s; }

/** 全图共享的"矩形评估数"账户。
 *  官方在 GPU 上穷举 (粗扫 stride=2, 精扫与逐级细化 stride=1); 纯 JS 必须按预算抽样。
 *  这里按"阶段"分配: 每个阶段先算出各次 spread 调用全量展开所需的评估数, 若预算够
 *  就一律用官方步长 (结果与官网逐位一致), 不够则按需求量比例摊薄、逐步长抽稀。
 *  于是中小图完全精确, 超大图耗时也被钳在 workTotal 内 (与像素数近似无关)。 */
function makeAcct(total) { return { left: total, spent: 0 }; }
function allocate(acct, needs, reserve) {
  const sum = needs.reduce((a, b) => a + b, 0);
  const avail = acct.left * (1 - reserve);
  const scale = sum > avail && sum > 0 ? avail / sum : 1;
  return needs.map((nd) => Math.max(1.2e5, nd * scale));
}
function spend(acct, used) {
  acct.left -= used; acct.spent += used;
  if (acct.left < 0) acct.left = 0;
}
/** 某组 (pitch 列表) 全量展开需要的矩形评估数 */
function groupWork(pitches, W, H, combos) {
  let minP = Infinity;
  for (let i = 0; i < pitches.length; i++) if (pitches[i] < minP) minP = pitches[i];
  return (Math.ceil(W / minP) + 3) * (Math.ceil(H / minP) + 3) * combos;
}
function strideFromRects(pitches, W, H, combos, rects, minStride) {
  return Math.max(minStride, pow2(groupWork(pitches, W, H, combos) / Math.max(1, rects)));
}

/** 官方 C(): 先固定 y 相位扫 x 相位, 再用最优 x 相位扫 y 相位。
 *  官方整批一次算, 但每个候选的行块彼此独立, 这里逐候选/逐组调用以便分别抽样。 */
function offsetScan(engine, varied, W, H, nPhase, stride) {
  const nVar = varied.length, ph = phases(nPhase);
  const offs = Array(nVar).fill(ph);
  const rowFixed = makeCellsFixed(0, H, varied, new Float64Array(nVar).fill(0.37), stride);
  const colVar = makeCells(0, W, varied, offs, stride);
  const sc = engine.spreadRows(colVar, rowFixed);
  const bestX = new Float64Array(nVar);
  for (let i = 0; i < nVar; i++) bestX[i] = ph[argmin(sc, i * nPhase, nPhase)];
  const colFixed = makeCellsFixed(0, W, varied, bestX, stride);
  const rowVar = makeCells(0, H, varied, offs, stride);
  const mc = engine.spreadCols(rowVar, colFixed);
  const bestY = new Float64Array(nVar);
  for (let i = 0; i < nVar; i++) bestY[i] = ph[argmin(mc, i * nPhase, nPhase)];
  return [bestX, bestY];
}

/** 单个候选周期一轮 spread 展开的评估数 */
const candCombos = (nVar, nPhase, jitter) => nVar * nPhase * 2 + nVar * (jitter ? 3 : 1) * ((jitter ? 3 : 1) + 2);

/** 官方 L() 在单个候选周期上的等价形式: 周期 nVar 档 x 相位 nPhase 档, 再叠 ±4% 相位抖动 */
function scanCandidate(engine, cand, W, H, nVar, nPhase, jitter, minStride, rects) {
  const varied = centerFirst(linspace(0.965 * cand, 1.035 * cand, nVar));
  const h = jitter ? [0, -0.04, 0.04] : [0];   // 同样: 并列时优先不加抖动
  const d = h.length;
  const combos = candCombos(nVar, nPhase, jitter);
  const stride = strideFromRects(varied, W, H, combos, rects, minStride);
  spendLast = groupWork(varied, W, H, combos) / (stride * stride);
  const [bestX, bestY] = offsetScan(engine, varied, W, H, nPhase, stride);
  const g = nVar * d;
  const m = new Float64Array(g), p = new Float64Array(g), w = new Array(g);
  for (let e = 0; e < g; e++) {
    const t = Math.floor(e / d);
    m[e] = varied[t];
    p[e] = bestY[t] + h[e % d];
    w[e] = h.map((x) => bestX[t] + x);
  }
  const y = engine.spreadRows(makeCells(0, W, m, w, stride), makeCellsFixed(0, H, m, p, stride));
  const A = nVar * d * d;
  let bi = 0, bv = y[0];
  for (let i = 1; i < A; i++) if (y[i] < bv) { bv = y[i]; bi = i; }
  if (bv >= 1e18) return [1e18, cand, 0, 0];
  const o = Math.floor(bi / d), k = bi % d;
  const u = Math.floor(o / d), gj = o % d;
  return [bv, varied[u], bestX[u] + h[k], bestY[u] + h[gj]];
}
let spendLast = 0;

/** 官方 W(): 粗扫(stride>=2) -> "可接受里最粗" 保留集 -> 精扫(stride>=1) -> 同样取最粗 */
function searchPitch(engine, acct, W, H, candsIn, cfg) {
  const cands = Array.from(candsIn);
  if (!cands.length) return null;
  let needs = cands.map((c) => groupWork(linspace(0.965 * c, 1.035 * c, 7), W, H, candCombos(7, 10, false)));
  const rc = allocate(acct, needs, 0.62);
  const coarse = [];
  for (let i = 0; i < cands.length; i++) {
    coarse.push(scanCandidate(engine, cands[i], W, H, 7, 10, false, 2, rc[i]));
    spend(acct, spendLast);
  }
  const min0 = Math.min.apply(null, coarse.map((q) => q[0]));
  const win = 1.35 * Math.max(1.25 * min0, min0 + 0.5);
  if (cfg.debug) cfg.debug.coarse = cands.map((p, i) => [+p.toFixed(3), +coarse[i][0].toFixed(4), rc[i]]);
  const keep = [];
  for (let i = 0; i < cands.length; i++) if (coarse[i][0] <= win) keep.push(cands[i]);
  const order = cands.map((p, i) => [coarse[i][0], p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((q) => q[1]);
  for (const q of order.slice(0, 4)) if (keep.indexOf(q) < 0) keep.push(q);
  let fine = keep;
  if (fine.length > 12) {
    const rank = new Map(order.map((q, i) => [q, i]));
    fine = fine.slice().sort((a, b) => rank.get(a) - rank.get(b)).slice(0, 12);
  }
  fine = fine.slice().sort((a, b) => a - b);
  needs = fine.map((c) => groupWork(linspace(0.965 * c, 1.035 * c, 15), W, H, candCombos(15, 14, true)));
  const rf = allocate(acct, needs, 0.5);
  const res = [];
  for (let i = 0; i < fine.length; i++) {
    res.push(scanCandidate(engine, fine[i], W, H, 15, 14, true, 1, rf[i]));
    spend(acct, spendLast);
  }
  const min1 = Math.min.apply(null, res.map((q) => q[0]));
  const thr = Math.max(1.25 * min1, min1 + 0.5);
  if (cfg.debug) cfg.debug.fine = fine.map((p, i) => [+p.toFixed(3), +res[i][0].toFixed(4), rf[i]]);
  let best = null;
  for (const q of res) if (q[0] <= thr && (best === null || q[1] > best[1])) best = q;
  return best || res[0];
}

/** 官方 D(): 亚谐波 (q/2, q/3) 候选 + 逐级细化评估 + 序贯采纳 */
function refineGrids(engine, acct, rgb, prof, W, H, found, cfg, alpha) {
  const pitch = found[1];
  const levels = [pitch];
  const offs = [[found[2], found[3]]];
  if (cfg.maxDetail !== null) {
    for (const d of [2, 3]) {
      const t = pitch / d;
      if (t < cfg.minDetail) break;
      levels.push(t);
    }
  }
  if (levels.length > 1) {
    const ex = Float64Array.from(levels.slice(1));
    const stride = strideFromRects(ex, W, H, ex.length * 14 * 2, allocate(acct, [groupWork(ex, W, H, ex.length * 14 * 2)], 0.55)[0], 1);
    spend(acct, groupWork(ex, W, H, ex.length * 14 * 2) / (stride * stride));
    const [bx, by] = offsetScan(engine, ex, W, H, 14, stride);
    for (let e = 1; e < levels.length; e++) offs.push([bx[e - 1], by[e - 1]]);
  }
  const evaluated = [];
  for (let e = 0; e < levels.length; e++) {
    evaluated.push(evaluateLevel(engine, acct, rgb, prof, W, H, levels[e], offs[e], cfg, alpha));
  }
  let grid = evaluated[0].grid, mae = evaluated[0].mae;
  // 官方判据只有一条: 更细的网格要把重建 MAE 压低到当前的 (1-maxDetail) 倍才采纳,
  // 门槛随已采纳级别滚动, 避免"越细越好"的滑坡 (spread 本身恒偏好细网格)。
  for (let e = 1; e < evaluated.length; e++) {
    if (evaluated[e].mae < mae * (1 - cfg.maxDetail)) { grid = evaluated[e].grid; mae = evaluated[e].mae; }
  }
  if (cfg.debug) cfg.debug.levels = evaluated.map((q) => ({ grid: q.grid.map((v) => +v.toFixed(3)), mae: +q.mae.toFixed(4), cells: q.cells }));
  return { grid, mae };
}

/** 官方 k() 在单个级别上的等价形式: 33 周期档 x 16 相位档细化 -> 拟合边界 -> 重建 MAE */
function evaluateLevel(engine, acct, rgb, prof, W, H, level, off, cfg, alpha) {
  const nVar = 33, nPh = 16;
  const d = centerFirst(linspace(0.96 * level, 1.04 * level, nVar));
  const need = groupWork(d, W, H, nVar * nPh * 2);
  const stride = strideFromRects(d, W, H, nVar * nPh * 2, allocate(acct, [need], 0.15)[0], 1);
  spend(acct, need / (stride * stride));
  const ph = phases(nPh), y = Array(nVar).fill(ph);
  const rowP = new Float64Array(nVar).fill(level);
  const rowM = new Float64Array(nVar).fill(off[0]);
  const rowP2 = new Float64Array(nVar).fill(off[1]);
  const ax = engine.spreadRows(makeCells(0, W, d, y, stride), makeCellsFixed(0, H, rowP, rowP2, stride));
  const ay = engine.spreadCols(makeCells(0, H, d, y, stride), makeCellsFixed(0, W, rowP, rowM, stride));
  const pick = (arr, fallbackOff) => {
    let bi = 0, bv = arr[0];
    for (let i = 1; i < nVar * nPh; i++) if (arr[i] < bv) { bv = arr[i]; bi = i; }
    return bv >= 1e18 ? [level, fallbackOff] : [d[Math.floor(bi / nPh)], ph[bi % nPh]];
  };
  const [px, fx] = pick(ax, off[0]);
  const [py, fy] = pick(ay, off[1]);
  const [xb, yb] = gridBounds(prof.col, prof.row, W, H, px, py,
    pmod(fx * px, px), pmod(fy * py, py), cfg.lam, cfg.rigid);
  const smp = sampleCells(rgb, xb, yb, W, cfg.margin, alpha);
  return {
    grid: [px, py, fx, fy],
    mae: rebuildMAE(rgb, smp.cells, xb, yb, W, H),
    cells: [xb.length - 1, yb.length - 1],
  };
}

// ------------------------------------------------------ 4) 网格边界拟合

/** 高斯平滑 (sigma .8), 官方 x() 内部 */
function gaussSmooth(prof) {
  const half = Math.max(1, Math.trunc(3 * 0.8));
  const size = 2 * half + 1;
  const ker = new Float64Array(size);
  let sum = 0;
  for (let j = -half; j <= half; j++) { ker[j + half] = Math.exp(-0.5 * Math.pow(j / 0.8, 2)); sum += ker[j + half]; }
  for (let j = 0; j < size; j++) ker[j] /= sum;
  const n = prof.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < size; j++) { const k = i + j - half; if (k >= 0 && k < n) acc += ker[j] * prof[k]; }
    out[i] = acc;
  }
  return out;
}

/** 官方 x(): 一维 DP 非刚性边界拟合 */
function dpBounds(prof, pitch, lamV, off, phaseW, edgeW, minF, maxF) {
  phaseW = phaseW === undefined ? 0.35 : phaseW;
  edgeW = edgeW === undefined ? 0.6 : edgeW;
  minF = minF === undefined ? 0.7 : minF;
  maxF = maxF === undefined ? 1.35 : maxF;
  let u = gaussSmooth(prof);
  const s = pct(u, 98) + 1e-9;
  const capped = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) capped[i] = Math.min(Math.max(u[i] / s, 0), 1.5);
  u = capped;
  const c = prof.length + 1;
  const h = new Float64Array(c + 1);
  for (let e = 1; e < c; e++) h[e] = u[e - 1];
  h[0] = h[c] = edgeW;
  if (off !== null && off !== undefined) {
    for (let e = 0; e <= c; e++) {
      const t = pmod(e - off + pitch / 2, pitch) - pitch / 2;
      h[e] -= phaseW * Math.pow(t / (pitch / 2), 2);
    }
  }
  const d = Math.max(2, rndHalf(minF * pitch));
  const g = Math.max(d + 1, rndHalf(maxF * pitch));
  const m = new Float64Array(c + 1);
  const bk = new Int32Array(c + 1);
  m.fill(-1e18); bk.fill(-1);
  const A = Math.min(c, g);
  for (let e = 0; e <= A; e++) m[e] = h[e];
  for (let e = d; e <= c; e++) {
    const lo = Math.max(0, e - g), hi = e - d;
    let bi = -1, bs = -1e18;
    for (let i = lo; i <= hi; i++) {
      const sp = m[i] - lamV * Math.pow((e - i - pitch) / pitch, 2) + h[e];
      if (sp > bs) { bs = sp; bi = i; }
    }
    if (bs > m[e]) { m[e] = bs; bk[e] = bi; }
  }
  const x0 = Math.max(0, c - g);
  let M = x0, E = m[x0];
  for (let e = x0 + 1; e <= c; e++) if (m[e] > E) { E = m[e]; M = e; }
  const bounds = [];
  for (let v = M; v >= 0; v = bk[v]) bounds.push(v);
  bounds.reverse();
  if (bounds[0] !== 0) bounds.unshift(0);
  if (bounds[bounds.length - 1] !== c) bounds.push(c);
  while (bounds.length > 2 && bounds[1] - bounds[0] < 2) bounds.splice(1, 1);
  while (bounds.length > 2 && bounds[bounds.length - 1] - bounds[bounds.length - 2] < 2) bounds.splice(bounds.length - 2, 1);
  return bounds;
}

/** 官方 M(): 刚性等分边界 */
function rigidBounds(len, pitch, off) {
  const o = pmod(off, pitch);
  const set = new Set([0, len]);
  const n = Math.floor((len - o) / pitch) + 2;
  for (let i = 0; i < n; i++) { const v = rndHalf(o + i * pitch); if (v >= 0 && v <= len) set.add(v); }
  const out = Array.from(set).sort((a, b) => a - b);
  while (out.length > 2 && out[1] - out[0] < 2) out.splice(1, 1);
  while (out.length > 2 && out[out.length - 1] - out[out.length - 2] < 2) out.splice(out.length - 2, 1);
  return out;
}

/** 官方 E(): 两轴边界 (rigid = 等分, 否则两轴各跑一次一维 DP) */
function gridBounds(colProf, rowProf, W, H, pitchX, pitchY, offX, offY, lamV, rigid) {
  return rigid
    ? [rigidBounds(W, pitchX, offX), rigidBounds(H, pitchY, offY)]
    : [dpBounds(colProf, pitchX, lamV, offX), dpBounds(rowProf, pitchY, lamV, offY)];
}

// ------------------------------------------------------ 5) 采样

/** 前 n 个元素的中位数 (官方 w(): 排序取中位) */
function median(arr, n) {
  const a = arr.slice(0, n);
  a.sort();
  const h = n >> 1;
  return n & 1 ? a[h] : (a[h - 1] + a[h]) / 2;
}

/** 官方 B(): 单元按 margin 内缩后取中位色 + 逐格 alpha 中位。
 *  官方还算一份"逐格离散度"仅用于 verbose 调试输出, 这里省去 (省一遍全图像素遍历)。 */
function sampleCells(rgb, xb, yb, W, margin, alpha) {
  const Hc = yb.length - 1, Wc = xb.length - 1;
  const cells = new Float64Array(Hc * Wc * 3);
  const al = alpha ? new Float64Array(Hc * Wc) : null;
  let cap = 0, hr = null, hg = null, hb = null, ha = null;
  for (let j = 0; j < Hc; j++) {
    const ry0 = yb[j], ry1 = yb[j + 1];
    const myInset = rndHalf((ry1 - ry0) * margin);
    let my0 = ry0 + myInset, my1 = ry1 - myInset;
    if (my1 - my0 < 1) { my0 = ry0; my1 = ry1; }
    for (let i = 0; i < Wc; i++) {
      const cx0 = xb[i], cx1 = xb[i + 1];
      let mx0 = cx0 + rndHalf((cx1 - cx0) * margin), mx1 = cx1 - rndHalf((cx1 - cx0) * margin);
      if (mx1 - mx0 < 1) { mx0 = cx0; mx1 = cx1; }
      const area = (mx1 - mx0) * (my1 - my0);
      if (area > cap) {
        cap = area;
        hr = new Float64Array(Math.max(1, cap)); hg = new Float64Array(Math.max(1, cap));
        hb = new Float64Array(Math.max(1, cap)); ha = new Float64Array(Math.max(1, cap));
      }
      let n = 0, na = 0;
      for (let y = my0; y < my1; y++) {
        let idx = y * W + mx0;
        for (let x = mx0; x < mx1; x++, idx++) {
          const a = alpha ? alpha[idx] : 255;
          if (alpha) ha[na] = a;
          na++;
          if (a > 0) { const q = idx * 3; hr[n] = rgb[q]; hg[n] = rgb[q + 1]; hb[n] = rgb[q + 2]; n++; }
        }
      }
      const o = (j * Wc + i) * 3;
      if (n > 0) {
        cells[o] = median(hr, n); cells[o + 1] = median(hg, n); cells[o + 2] = median(hb, n);
      }
      if (al) al[j * Wc + i] = median(ha, na);
    }
  }
  return { cells, Wc, Hc, alpha: al };
}

/** 官方重建误差: 全图每像素到所属单元中位色的平均绝对偏差 */
function rebuildMAE(rgb, cells, xb, yb, W, H) {
  const Wc = xb.length - 1;
  let acc = 0;
  for (let j = 0; j < yb.length - 1; j++) {
    for (let y = yb[j]; y < yb[j + 1]; y++) {
      for (let i = 0; i < Wc; i++) {
        const s = (j * Wc + i) * 3;
        const cr = cells[s], cg = cells[s + 1], cb = cells[s + 2];
        let idx = y * W + xb[i];
        for (let x = xb[i]; x < xb[i + 1]; x++, idx++) {
          const q = idx * 3;
          acc += Math.abs(cr - rgb[q]) + Math.abs(cg - rgb[q + 1]) + Math.abs(cb - rgb[q + 2]);
        }
      }
    }
  }
  return acc / (W * H * 3);
}

// ------------------------------------------------------ 6) 调色 (官方 tree)

/** sRGB -> CIE Lab */
function toLab(r, g, b) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  const fv = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const X = fv((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const Y = fv(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const Z = fv((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

/** 八叉树分桶: 叶子数超过 maxColors 时, 从最深一层里挑计数最小的节点合并 */
function octreeBuckets(cells, n, maxColors) {
  const mk = (isLeaf) => ({ leaf: !!isLeaf, count: 0, r: 0, g: 0, b: 0, kids: null });
  const root = mk(false);
  const level = [];
  for (let i = 0; i < 8; i++) level.push([]);
  let leaves = 0;
  const reduce = () => {
    let e = 7;
    while (e >= 0 && level[e].length === 0) e--;
    if (e < 0) return;
    const lst = level[e];
    let pick = 0;
    for (let i = 1; i < lst.length; i++) if (lst[i].count < lst[pick].count) pick = i;
    const nd = lst.splice(pick, 1)[0];
    let kids = 0;
    for (let i = 0; i < 8; i++) {
      const k = nd.kids && nd.kids[i];
      if (k) { nd.r += k.r; nd.g += k.g; nd.b += k.b; nd.count += k.count; kids++; }
    }
    nd.kids = null; nd.leaf = true;
    leaves += 1 - kids;
  };
  for (let i = 0; i < n; i++) {
    const r = clamp8(rndHalf(cells[3 * i])), g = clamp8(rndHalf(cells[3 * i + 1])), b = clamp8(rndHalf(cells[3 * i + 2]));
    let node = root, depth = 0;
    while (!node.leaf && depth < 8) {
      const bit = 7 - depth;
      const idx = (((r >> bit) & 1) << 2) | (((g >> bit) & 1) << 1) | ((b >> bit) & 1);
      if (!node.kids) { node.kids = [null, null, null, null, null, null, null, null]; level[depth].push(node); }
      if (!node.kids[idx]) { const isLeaf = depth === 7; node.kids[idx] = mk(isLeaf); if (isLeaf) leaves++; }
      node = node.kids[idx];
      depth++;
    }
    node.count++; node.r += r; node.g += g; node.b += b;
    while (leaves > maxColors) reduce();
  }
  const out = [];
  (function walk(nd) {
    if (nd.kids) { for (const k of nd.kids) if (k) walk(k); }
    else if (nd.count > 0) out.push({ r: nd.r / nd.count, g: nd.g / nd.count, b: nd.b / nd.count, count: nd.count });
  })(root);
  return out;
}

/** 官方 I(): 八叉树 + Lab 距离 (按计数加权惩罚) 贪心合并, 直到 stop(距离, 剩余数) 为真 */
function quantizeTree(cells, n, maxColors, stopFn) {
  const buckets = octreeBuckets(cells, n, maxColors)
    .map((e) => ({ r: e.r, g: e.g, b: e.b, count: e.count, lab: toLab(e.r, e.g, e.b) }));
  const weight = (c) => 1 + Math.max(Math.max(0, 1 - c / n / 0.02), 3 * Math.max(0, 1 - c / 16));
  while (buckets.length > 1) {
    let bi = -1, bj = -1, best = Infinity;
    for (let i = 0; i < buckets.length; i++) {
      const A = buckets[i];
      for (let j = i + 1; j < buckets.length; j++) {
        const B = buckets[j];
        const dr = A.lab[0] - B.lab[0], dg = A.lab[1] - B.lab[1], db = A.lab[2] - B.lab[2];
        const dd = Math.sqrt(dr * dr + dg * dg + db * db) / weight(Math.min(A.count, B.count));
        if (dd < best) { best = dd; bi = i; bj = j; }
      }
    }
    if (stopFn(best, buckets.length)) break;
    const A = buckets[bi], B = buckets[bj], cnt = A.count + B.count;
    A.r = (A.r * A.count + B.r * B.count) / cnt;
    A.g = (A.g * A.count + B.g * B.count) / cnt;
    A.b = (A.b * A.count + B.b * B.count) / cnt;
    A.count = cnt;
    A.lab = toLab(A.r, A.g, A.b);
    buckets.splice(bj, 1);
  }
  const out = new Float64Array(3 * n);
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const lab = toLab(cells[3 * i], cells[3 * i + 1], cells[3 * i + 2]);
    let bi = 0, bd = Infinity;
    for (let j = 0; j < buckets.length; j++) {
      const c = buckets[j].lab;
      const dr = lab[0] - c[0], dg = lab[1] - c[1], db = lab[2] - c[2];
      const dd = dr * dr + dg * dg + db * db;
      if (dd < bd) { bd = dd; bi = j; }
    }
    used.add(bi);
    out[3 * i] = buckets[bi].r; out[3 * i + 1] = buckets[bi].g; out[3 * i + 2] = buckets[bi].b;
  }
  return { cells: out, size: used.size };
}

// ------------------------------------------------------ 主流程

/**
 * @param {Uint8ClampedArray} rgba 原尺寸 RGBA (createImageBitmap 解码后 drawImage 读出)
 * @param {number} w0 原宽 @param {number} h0 原高
 * @param {object} opts {
 *   palette: 'off'|'auto'|'custom'   官方 paletteMode
 *   colors:  number                  custom 模式的目标色数 (官方 colors)
 *   avoid:   boolean                 Avoid Over-Refining (官方 maxDetail:null)
 *   autoTol: number = 6.5            auto 模式的 Lab 合并距离上限 (官方 UI 同值, 引擎默认 2.5)
 *   maxPixels: number = 4.2e6        超出则按官方 $() 截断抽取 (官方 js 后端 4e6)
 *   work: number = 1.1e8 / speed: 1  搜索"矩形评估数"预算, speed>1 更快更糙, <1 更精
 *   rigid: boolean                   等分网格 (官方 rigidity)
 *   debug: object|null               收集各级调试信息
 * }
 * @returns {{error:string}|{rgba:Uint8ClampedArray,Wc:number,Hc:number,pitch:[number,number],
 *   paletteSize:number,note:string,soft:boolean,work:number,searchW:number,searchH:number}}
 *   rgba 为逻辑分辨率 (Wc x Hc) 的 RGBA, 由调用方按需最近邻放回
 */
export function snapPixels(rgba, w0, h0, opts) {
  opts = opts || {};
  // 官方按后端 maxPixels 截断抽取 (js/wasm 后端就是 4e6); 这里再兜一层: 积分图分配失败时降档重来,
  // 免得大图直接抛异常给用户提供不了的"无法处理"。
  let cap = opts.maxPixels === undefined ? 4.2e6 : opts.maxPixels;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return analyze(rgba, w0, h0, opts, cap); }
    catch (e) {
      const mem = e instanceof RangeError || /array buffer|allocation|out of memory|do not fit/i.test((e && e.message) || "");
      if (!mem) throw e;
      if (cap <= 4e5) return { error: "内存不足: 图片过大, 请先缩小尺寸再处理" };
      cap = Math.max(4e5, Math.floor(cap / 2));
    }
  }
  return { error: "内存不足: 图片过大, 请先缩小尺寸再处理" };
}

/** 官方 $(): 超出像素预算时按 trunc(i*src/dst) 截断最近邻抽取 —— 平滑缩放会把网格一起抹掉 */
function descendRGBA(src, sw, sh, dw, dh) {
  const rgb = new Uint8Array(dw * dh * 3), alpha = new Uint8Array(dw * dh);
  for (let i = 0; i < dh; i++) {
    const sy = Math.min(sh - 1, Math.trunc((i * sh) / dh));
    for (let j = 0; j < dw; j++) {
      const sx = Math.min(sw - 1, Math.trunc((j * sw) / dw));
      const sp = (sy * sw + sx) * 4, dp = i * dw + j;
      rgb[dp * 3] = src[sp]; rgb[dp * 3 + 1] = src[sp + 1]; rgb[dp * 3 + 2] = src[sp + 2];
      alpha[dp] = src[sp + 3];
    }
  }
  return { rgb, alpha: alpha };
}

function analyze(rgba, w0, h0, opts, maxPix) {
  const dbg = opts.debug && typeof opts.debug === "object" ? opts.debug : null;
  let note = "";
  const f = Math.min(1, Math.sqrt(maxPix / (w0 * h0)));
  const W = Math.max(1, Math.floor(w0 * f)), H = Math.max(1, Math.floor(h0 * f));
  if (W < 3 || H < 3) return { error: "图片太小 (小于 3x3), 无法检测像素网格" };
  let rgb, alphaBuf;
  if (W < w0 || H < h0) {
    const src = new Uint8Array(w0 * h0 * 4);
    src.set(rgba.subarray(0, src.length));
    const dn = descendRGBA(src, w0, h0, W, H);
    rgb = dn.rgb; alphaBuf = dn.alpha;
    note = "图片过大, 已按官网同款截断抽取到 " + W + "\u00d7" + H + " 后检测";
  } else {
    rgb = new Uint8Array(W * H * 3);
    alphaBuf = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) {
      rgb[3 * i] = rgba[j]; rgb[3 * i + 1] = rgba[j + 1]; rgb[3 * i + 2] = rgba[j + 2];
      alphaBuf[i] = rgba[j + 3];
    }
  }

  // ---- 透明像素: 颜色按官方置 0, 仅全图透明才算失败 ----
  let visible = false, anyAlpha = false;
  for (let i = 0; i < W * H; i++) {
    const a = alphaBuf[i];
    if (a !== 0) visible = true;
    if (a !== 255) anyAlpha = true;
  }
  if (!visible) return { error: "图片解码后全透明 (读回失败?), 无法处理" };
  let alpha = null;
  for (let i = 0; i < W * H; i++) {
    if (alphaBuf[i] === 0) { rgb[3 * i] = 0; rgb[3 * i + 1] = 0; rgb[3 * i + 2] = 0; }
  }
  if (anyAlpha) alpha = alphaBuf;

  const prof = gradientProfiles(rgb, W, H);
  // 纯色/无内容图官方直接判错, 这里给出同样的明确提示 (不再硬凑一个网格)
  let flat = true;
  for (let i = 0; i < prof.col.length; i++) if (prof.col[i] > 0) { flat = false; break; }
  if (flat) for (let i = 0; i < prof.row.length; i++) if (prof.row[i] > 0) { flat = false; break; }
  if (flat) return { error: "纯色图片, 没有可还原的像素网格" };
  const engine = makeEngine(buildSAT(rgb, W, H), W, H);
  const speed = opts.speed === undefined ? 1 : Math.max(0.2, opts.speed);
  const cfg = {
    lam: 1.2, margin: 0.27, minDetail: 1.5,
    maxDetail: opts.avoid ? null : 0.2,
    rigid: !!opts.rigid,
    // 一次穷举的"矩形评估数"总预算: 越大越贴近官网 (足够大时步长回落到官方口径, 结果逐位一致),
    // 越小越快; 超预算的图会自动抽稀, 因此耗时近似与图片尺寸无关。
    workTotal: (opts.work === undefined ? 1.1e8 : opts.work) / speed,
    debug: dbg,
  };

  // ---- 1) 候选周期 ----
  const det = pitchCandidates([prof.col, prof.row]);
  const cands = det.pitches;
  if (!cands.length) return { error: "未检测到任何周期结构, 不像被放大过的像素图" };
  const acct = makeAcct(cfg.workTotal);

  // ---- 2) 两段式 spread 搜索 ----
  const found = searchPitch(engine, acct, W, H, cands, cfg);
  if (!found || !isFinite(found[1])) return { error: "网格搜索失败 (无有效周期候选)" };
  const soft = !det.strong;   // 只有"弱周期"(平滑图)才走退让路径

  // ---- 3) 亚谐波细化 ----
  const refined = refineGrids(engine, acct, rgb, prof, W, H, found, cfg, alpha);
  const [pitchX, pitchY, offXf, offYf] = refined.grid;

  // ---- 4) 最终网格边界 (DP 或刚性) ----
  const [xb, yb] = gridBounds(prof.col, prof.row, W, H, pitchX, pitchY,
    pmod(offXf * pitchX, pitchX), pmod(offYf * pitchY, pitchY), cfg.lam, cfg.rigid);

  // ---- 5) 逻辑分辨率采样 ----
  const smp = sampleCells(rgb, xb, yb, W, cfg.margin, alpha);
  if (smp.Wc < 1 || smp.Hc < 1) return { error: "网格划分结果无效" };
  const nCells = smp.Wc * smp.Hc;

  // ---- 6) Palettize ----
  const __distinct = opts.debug ? new Set(Array.from({ length: nCells }, (_0, i) => (smp.cells[3 * i] | 0) * 65536 + (smp.cells[3 * i + 1] | 0) * 256 + (smp.cells[3 * i + 2] | 0))).size : 0;
  let cells = smp.cells, paletteSize = 0;
  if (opts.palette === "auto") {
    const q = quantizeTree(cells, nCells, 256, (dist) => dist > (opts.autoTol === undefined ? 6.5 : opts.autoTol));
    cells = q.cells; paletteSize = q.size;
  } else if (opts.palette === "custom") {
    const m = Math.max(1, Math.round(opts.colors || 64));
    const q = quantizeTree(cells, nCells, Math.max(256, m), (_d, cnt) => cnt <= m);
    cells = q.cells; paletteSize = q.size;
  }

  // ---- 7) 输出逻辑分辨率 RGBA ----
  const out = new Uint8ClampedArray(nCells * 4);
  for (let i = 0; i < nCells; i++) {
    out[4 * i] = clamp8(rndHalf(cells[3 * i]));
    out[4 * i + 1] = clamp8(rndHalf(cells[3 * i + 1]));
    out[4 * i + 2] = clamp8(rndHalf(cells[3 * i + 2]));
    out[4 * i + 3] = smp.alpha ? clamp8(rndHalf(smp.alpha[i])) : 255;
  }
  return {
    rgba: out, Wc: smp.Wc, Hc: smp.Hc,
    pitch: [pitchX, pitchY], paletteSize, note, soft, work: Math.round(acct.spent),
    searchW: W, searchH: H, distinct: __distinct,
  };
}