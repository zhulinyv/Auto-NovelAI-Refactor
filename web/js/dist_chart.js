// ============================================================
// 分段 Beta 分布实时分布图 (随机画风插件)
// 与后端 utils.generate_piecewise_beta 逻辑保持一致, 纯前端 Canvas 渲染,
// 左侧参数改动后右侧即时重绘; 颜色随 WebUI 明暗主题自动适配。
// ============================================================

const DEFAULT_SAMPLES = 30000;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** 读取当前主题的 CSS 变量颜色 (亮/暗自动适配) */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return {
    dark,
    bg: v("--panel-solid", dark ? "#161821" : "#ffffff"),
    text: v("--text", dark ? "#e7e9ee" : "#1d2029"),
    text2: v("--text-2", dark ? "#9aa0ae" : "#6b7280"),
    primary: v("--primary", "#8b5cf6"),
    success: v("--success", dark ? "#4ade80" : "#22c55e"),
    warning: v("--warning", "#f59e0b"),
    danger: v("--danger", "#ef4444"),
    border: v("--border", dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)"),
    grid: dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.06)",
  };
}

/**
 * 采样分段 Beta 分布, 返回 Float64Array。
 * 与后端 generate_piecewise_beta 完全同构。
 */
export function samplePiecewiseBeta(n, a, b, mode, leftSharpness, rightSharpness, probNegToPos, probZeroToOneAdd) {
  if (a > b) { const t = a; a = b; b = t; }
  mode = clamp(mode, a + 1e-6, b - 1e-6);
  probNegToPos = clamp(probNegToPos, 0, 1);
  probZeroToOneAdd = clamp(probZeroToOneAdd, 0, 1);

  const L_left = mode - a;
  const L_right = b - mode;
  const alpha_left = Math.max(1, leftSharpness + 1);
  const beta_right = Math.max(1, rightSharpness + 1);

  const f_left_mode = alpha_left / L_left;
  const f_right_mode = beta_right / L_right;
  const total = f_left_mode + f_right_mode;
  const p_left = total === 0 ? 0.5 : f_right_mode / total;

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let raw;
    if (Math.random() < p_left) {
      raw = a + Math.pow(Math.random(), 1 / alpha_left) * L_left;
    } else {
      raw = mode + (1 - Math.pow(Math.random(), 1 / beta_right)) * L_right;
    }
    if (raw < 0 && Math.random() < probNegToPos) raw = Math.min(Math.abs(raw), b);
    if (raw >= 0 && raw <= 1 && Math.random() < probZeroToOneAdd) raw = Math.min(raw + 0.5, b);
    const num2 = Math.round(raw * 100) / 100;
    out[i] = Math.abs(num2).toFixed(2).endsWith("5") ? num2 : Math.round(num2 * 10) / 10;
  }
  return out;
}

function fmt(v, digits = 1) {
  const x = Math.round(v * 10 ** digits) / 10 ** digits;
  return String(x);
}

/**
 * 在 canvas 上绘制分布图: 直方图 + 平滑密度曲线 + 上下界/众数参考线。
 * 颜色取自当前主题, 背景透明由外层 CSS (var(--panel-solid)) 提供。
 */
export function drawBetaChart(canvas, params = {}) {
  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
  const a = num(params.min_weight, -3);
  const b = num(params.max_weight, 3);
  const mode = num(params.mode, 1);
  const ls = num(params.left_sharpness, 10);
  const rs = num(params.right_sharpness, 5);
  const pnp = num(params.prob_neg_to_pos, 0.7);
  const pza = num(params.prob_zero_to_one_add, 0.35);

  const data = samplePiecewiseBeta(DEFAULT_SAMPLES, a, b, mode, ls, rs, pnp, pza);
  const T = themeColors();

  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // 顶部留一条图例, 底部 x 轴 (padB 加大避免"权重"标签与数字重叠)
  const padL = 40, padR = 14, padT = 34, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // 数据范围
  let mn = Infinity, mx = -Infinity;
  const N = data.length;
  for (let i = 0; i < N; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = (mx - mn) || 1;
  const lo = mn - span * 0.04;
  const hi = mx + span * 0.04;

  // 直方图
  const BINS = 90;
  const counts = new Float64Array(BINS);
  const bw = (hi - lo) / BINS;
  for (let i = 0; i < N; i++) {
    let idx = Math.floor((data[i] - lo) / bw);
    if (idx < 0) idx = 0; else if (idx >= BINS) idx = BINS - 1;
    counts[idx]++;
  }
  const density = new Float64Array(BINS);
  let maxDens = 1e-9;
  for (let i = 0; i < BINS; i++) {
    density[i] = counts[i] / (N * bw);
    if (density[i] > maxDens) maxDens = density[i];
  }

  const xAt = (v) => padL + ((v - lo) / (hi - lo)) * plotW;
  const yAt = (d) => padT + plotH - (d / maxDens) * plotH;

  // 背景网格 (水平线)
  ctx.strokeStyle = T.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (plotH / 4) * g;
    ctx.moveTo(padL, gy); ctx.lineTo(padL + plotW, gy);
  }
  ctx.stroke();

  // 直方图柱 (半透明主色)
  const barW = plotW / BINS;
  ctx.fillStyle = T.dark ? "rgba(167,139,250,0.28)" : "rgba(139,92,246,0.22)";
  const bars = [];
  for (let i = 0; i < BINS; i++) {
    if (counts[i] === 0) continue;
    const h = (density[i] / maxDens) * plotH;
    const bx = padL + i * barW + 0.5;
    const by = yAt(density[i]);
    ctx.fillRect(bx, by, barW - 1, h);
    bars.push({ i, x: bx, y: by, w: barW - 1, h });
  }

  // 平滑密度曲线 (高斯核卷积) + 渐变面积填充
  const K = [0.061, 0.242, 0.394, 0.242, 0.061];
  const smooth = new Float64Array(BINS);
  for (let i = 0; i < BINS; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < BINS) s += density[j] * K[k + 2];
    }
    smooth[i] = s;
  }
  const pts = [];
  for (let i = 0; i < BINS; i++) {
    pts.push([padL + (i + 0.5) * barW, yAt(smooth[i])]);
  }
  // 面积填充
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, T.dark ? "rgba(74,222,128,0.25)" : "rgba(34,197,94,0.22)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(pts[0][0], padT + plotH);
  for (const [x, y] of pts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0], padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // 曲线
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
    else ctx.lineTo(pts[i][0], pts[i][1]);
  }
  ctx.strokeStyle = T.success;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  // 参考线: 下界(橙) / 上界(橙) / 众数(红)
  const refs = [
    { v: a, color: T.warning, label: "下界 " + fmt(a) },
    { v: b, color: T.warning, label: "上界 " + fmt(b) },
    { v: mode, color: T.danger, label: "众数 " + fmt(mode) },
  ];
  for (const r of refs) {
    const x = xAt(r.v);
    if (x < padL || x > padL + plotW) continue;
    ctx.save();
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.restore();
  }

  // x 轴刻度 (5 个均匀分布, 避免文字重叠)
  ctx.fillStyle = T.text2;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) / 4) * i;
    ctx.fillText(fmt(v, 2), xAt(v), padT + plotH + 16);
  }

  // 轴标签: "权重"放在刻度下方一行, 不与数字重叠
  ctx.fillStyle = T.text2;
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("权重", padL + plotW, padT + plotH + 33);
  ctx.save();
  ctx.translate(12, padT + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("概率", 0, 0);
  ctx.restore();

  // 顶部图例
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left";
  let lx = padL;
  const lh = 14;
  const swatch = (w) => {
    ctx.fillRect(lx, padT - 20, w, 4);
    lx += w + 6;
  };
  // 直方图
  ctx.fillStyle = T.dark ? "rgba(167,139,250,0.28)" : "rgba(139,92,246,0.22)";
  ctx.fillRect(lx, padT - 22, 12, 9);
  lx += 16;
  ctx.fillStyle = T.text2;
  ctx.fillText("直方图", lx, padT - 13);
  lx += ctx.measureText("直方图").width + 12;
  // 平滑曲线
  ctx.strokeStyle = T.success;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(lx, padT - 18); ctx.lineTo(lx + 14, padT - 18); ctx.stroke();
  lx += 18;
  ctx.fillStyle = T.text2;
  ctx.fillText("平滑曲线", lx, padT - 13);
  lx += ctx.measureText("平滑曲线").width + 14;
  // 参考线 (带数值)
  for (const r of refs) {
    ctx.strokeStyle = r.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(lx, padT - 18); ctx.lineTo(lx + 14, padT - 18); ctx.stroke();
    ctx.setLineDash([]);
    lx += 18;
    ctx.fillStyle = T.text2;
    ctx.fillText(r.label, lx, padT - 13);
    lx += ctx.measureText(r.label).width + 14;
  }

  // 保存悬停数据与画布快照 (供 tooltip 高亮使用, 避免悬停时重新采样)
  canvas.__chartData = {
    bins: BINS, lo, hi, bw, padL, barW, total: N,
    counts, bars, maxDens, padT, padH: plotH,
  };
  canvas.__snapshot = ctx.getImageData(0, 0, W, H);
  bindChartTooltip(canvas);
}

// ============================================================
// 鼠标悬停: 高亮当前方条 + 显示区间/频数/占比详情
// ============================================================
const TOOLTIP_ID = "__chartTip";
function getTooltip() {
  let tip = document.getElementById(TOOLTIP_ID);
  if (!tip) {
    tip = document.createElement("div");
    tip.id = TOOLTIP_ID;
    tip.className = "chart-tooltip hidden";
    document.body.append(tip);
  }
  return tip;
}

function bindChartTooltip(canvas) {
  if (canvas.dataset.tipBound) return;
  canvas.dataset.tipBound = "1";
  const ctx = canvas.getContext("2d");
  const tip = getTooltip();

  const restore = () => {
    if (canvas.__snapshot) {
      try { ctx.putImageData(canvas.__snapshot, 0, 0); } catch {}
    }
  };

  canvas.addEventListener("mousemove", (e) => {
    const d = canvas.__chartData;
    if (!d) return;
    // canvas 可能被 CSS 缩放显示, 需把屏幕坐标换算回画布内部像素, 否则悬停会偏移
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width ? canvas.width / rect.width : 1;
    const sy = rect.height ? canvas.height / rect.height : 1;
    const x = (e.clientX - rect.left) * sx;
    const y = (e.clientY - rect.top) * sy;
    const bar = d.bars.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y - 1 && y <= b.y + b.h + 1);
    if (!bar) {
      tip.classList.add("hidden");
      restore();
      canvas._hoverBar = null;
      return;
    }
    if (canvas._hoverBar !== bar.i) {
      canvas._hoverBar = bar.i;
      restore();
      const T = themeColors();
      ctx.fillStyle = T.dark ? "rgba(167,139,250,0.55)" : "rgba(139,92,246,0.5)";
      ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    }
    const loV = d.lo + bar.i * d.bw;
    const hiV = loV + d.bw;
    const count = d.counts[bar.i];
    const pct = (count / d.total) * 100;
    tip.innerHTML =
      "<b>权重 " + fmt(loV, 2) + " ~ " + fmt(hiV, 2) + "</b><br>" +
      "概率: " + count + "<br>" +
      "占比: " + pct.toFixed(2) + "%";
    tip.classList.remove("hidden");
    const tw = tip.offsetWidth || 150;
    const th = tip.offsetHeight || 60;
    let tx = e.clientX + 14;
    let ty = e.clientY + 14;
    if (tx + tw > window.innerWidth - 8) tx = e.clientX - tw - 14;
    if (ty + th > window.innerHeight - 8) ty = e.clientY - th - 14;
    tip.style.left = tx + "px";
    tip.style.top = ty + "px";
  });

  canvas.addEventListener("mouseleave", () => {
    tip.classList.add("hidden");
    restore();
    canvas._hoverBar = null;
  });
}
