// ============================================================
// 导演工具视图
// ============================================================
import { $, el, clear, toast, bus, imageDropZone, showResult, wildcardsButton } from "../ui.js";
import { post, get, imageUrl, uploadFiles } from "../api.js";
import { gallery, renderTabs } from "../components.js";

let S = null;
let pathCtl = null;
let picker = null;
let galleryEl = null;
let infoEl = null;

const KINDS = [
  { id: "remove_bg", title: "🎭 Remove BG" },
  { id: "line_art", title: "✏️ Line Art" },
  { id: "sketch", title: "🖊️ Sketch" },
  { id: "colorize", title: "🎨 Colorize" },
  { id: "emotion", title: "😊 Emotion" },
  { id: "declutter", title: "🧹 Declutter" },
  { id: "pixel_snap", title: "🔳 Pixel Snap" },
];

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["🎬 导演工具", el("span", { class: "sub", text: "NovelAI API 导演工具(支持批量; Pixel Snap 浏览器本地执行)" })]),
  );

  const pathField = el("div", { class: "field" }, [
    el("label", { text: "批处理路径" }),
  ]);
  const pathCtlInput = el("input", { type: "text", placeholder: "例如: D:/images" });
  const pathBtn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁 选择文件夹" });
  pathBtn.addEventListener("click", async () => {
    try {
      const { pickFolder } = await import("../api.js");
      const p = await pickFolder();
      if (p) { pathCtlInput.value = p; toast(`已选择目录: ${p} 📂`, "success"); }
    } catch (e) { toast("选择目录失败: " + e.message, "error"); }
  });
  pathCtl = pathCtlInput;
  pathField.append(el("div", { class: "file-pick-row" }, [pathCtlInput, pathBtn]));
  picker = imageDropZone({ label: "单张图片", placeholder: "点击选择或拖入图片", native: true });

  const tabsWrap = el("div");
  // 左栏: 一张实底卡包含 输入 + 各个处理模式
  const baseCard = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["📂 输入"]),
    pathField,
    picker.node,
    tabsWrap,
  ]);

  const outCard = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, ["🖼️ 输出"]),
  ]);
  galleryEl = el("div", { class: "gallery" });
  infoEl = el("div", { class: "info-box" });
  outCard.append(galleryEl, infoEl);

  // 右上角共享动作条 (跨页签显示当前功能的开始/停止)
  const actBar = el("div", { class: "view-head" });

  const layout = el("div", { class: "grid", style: "grid-template-columns:1fr 1.6fr;align-items:start;" });
  layout.append(el("div", { style: "min-width:0;" }, [baseCard]), outCard);
  container.append(actBar, layout);

  renderTabs(KINDS.map((k) => ({
    title: k.title,
    render: (body) => renderKind(k, body),
    onShow: () => {
      clear(actBar);
      const b = k._btns;
      if (b) actBar.append(b.runBtn, b.stopBtn);
    },
  })), tabsWrap);

  // 默认显示第一个功能的按钮
  const firstBtns = KINDS[0]._btns;
  if (firstBtns) actBar.append(firstBtns.runBtn, firstBtns.stopBtn);

  bus.on("job:done", (ev) => {
    if (ev.name?.startsWith("导演工具:")) {
      if (ev.images?.length) gallery(galleryEl, ev.images, { zoomOnClick: true });
      if (ev.message) showResult(infoEl, ev.message);
    }
  });
  bus.on("job:failed", (ev) => {
    if (ev.name?.startsWith("导演工具:") && ev.error) showResult(infoEl, "❌ " + ev.error);
  });
}

function renderKind(kind, body) {
  const optsWrap = el("div");
  const options = {};

  if (kind.id === "colorize") {
    const defry = el("input", { type: "number", min: 0, max: 5, value: 0 });
    const prompt = el("input", { type: "text", placeholder: "Prompt (可选)" });
    const promptLabel = el("label", { text: "Prompt" });
    promptLabel.append(wildcardsButton(prompt, { title: "Prompt" }));
    optsWrap.append(
      el("div", { class: "field" }, [el("label", { text: "Defry" }), defry]),
      el("div", { class: "field" }, [promptLabel, prompt])
    );
    options.defry = defry;
    options.prompt = prompt;
  } else if (kind.id === "emotion") {
    const tags = ["Neutral","Happy","Sad","Angry","Scared","Surprised","Tired","Excited","Nervous","Thinking","Confused","Shy","Disgusted","Smug","Bored","Laughing","Irritated","Aroused","Embarrassed","Worried","Love","Determined","Hurt","Playful"];
    const tag = el("select", {}, tags.map((t) => el("option", { value: t, text: t })));
    const strengths = ["Normal","Slightly Weak","Weak","Even Weaker","Very Weak","Weakest"];
    const strength = el("select", {}, strengths.map((s) => el("option", { value: s, text: s })));
    const prompt = el("input", { type: "text", placeholder: "Prompt (可选)" });
    const promptLabel = el("label", { text: "Prompt" });
    promptLabel.append(wildcardsButton(prompt, { title: "Prompt" }));
    optsWrap.append(
      el("div", { class: "field" }, [el("label", { text: "Emotion" }), tag]),
      el("div", { class: "field" }, [el("label", { text: "强度" }), strength]),
      el("div", { class: "field" }, [promptLabel, prompt])
    );
    options.tag = tag;
    options.strength = strength;
    options.prompt = prompt;
  } else if (kind.id === "pixel_snap") {
    // 与官网一致: Palettize (Off/Auto/Custom + Colors 滑条) / Avoid Over-Refining / Upscale
    const palette = el("select", {}, [
      el("option", { value: "off", text: "Off" }),
      el("option", { value: "auto", text: "Auto" }),
      el("option", { value: "custom", text: "Custom" }),
    ]);
    palette.value = "auto";
    const colors = el("input", { type: "range", min: 16, max: 256, step: 16, value: 64 });
    const colorsVal = el("span", { class: "muted", text: " 64" });
    colors.addEventListener("input", () => { colorsVal.textContent = " " + colors.value; });
    const colorsLabel = el("label", { text: "Colors" });
    colorsLabel.append(colorsVal);
    const colorsRow = el("div", { class: "field hidden" }, [colorsLabel, colors]);
    palette.addEventListener("change", () => {
      colorsRow.classList.toggle("hidden", palette.value !== "custom");
    });
    const avoid = el("input", { type: "checkbox" });
    const upscale = el("input", { type: "checkbox" });
    optsWrap.append(
      el("div", { class: "field" }, [el("label", { text: "Palettize" }), palette]),
      colorsRow,
      el("div", { class: "field-row" }, [
        el("label", { class: "checkline" }, [document.createTextNode("Avoid Over-Refining"), avoid]),
        el("label", { class: "checkline" }, [document.createTextNode("Upscale"), upscale]),
      ]),
      el("div", { class: "muted", text: "🖥️ 浏览器本地执行: 识别被放大/平滑过的像素图, 还原为真实像素画分辨率; 勾选 Upscale 则按原倍数放回 (最近邻)。不请求 API、不消耗积分" }),
    );
    options.palette = palette;
    options.colors = colors;
    options.avoid = avoid;
    options.upscale = upscale;
  }

  const runBtn = el("button", { class: "btn btn-primary", text: "🚀 开始处理" });
  const stopBtn = el("button", { class: "btn btn-danger", text: "⏹ 停止" });
  stopBtn.addEventListener("click", async () => {
    if (kind.id === "pixel_snap") {
      snapStop = true;
      toast("正在停止本地处理...", "warning");
      return;
    }
    toast("正在停止处理...", "warning");
    try { await post("/api/stop"); } catch {}
  });

  runBtn.addEventListener("click", async () => {
    if (kind.id === "pixel_snap") {
      runPixelSnap({
        palette: options.palette.value,
        colors: +options.colors.value,
        avoid: options.avoid.checked,
        upscale: options.upscale.checked,
      }, runBtn);
      return;
    }
    const payload = {
      kind: kind.id,
      path: pathCtl.value.trim() || null,
      image: picker.get() || null,
      options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, v.value])),
    };
    runBtn.disabled = true;
    infoEl.textContent = "🚀 正在处理...";
    try {
      const res = await post("/api/director", payload);
      toast(`任务已启动: ${res.job_id}`, "success");
      runBtn.disabled = false;
    } catch (e) {
      infoEl.textContent = "❌ " + e.message;
      toast(e.message, "error");
      runBtn.disabled = false;
    }
  });

  kind._btns = { runBtn, stopBtn };
  if (optsWrap.children.length) body.append(optsWrap);
}

// ---------------- Pixel Snap (浏览器本地执行) ----------------

let snapStop = false;

/** ================= Pixel Snap: 对齐官方 pixelsnap worker 的浏览器端管线 =================
 * 官方 = WebGPU/WebGL/WASM 方差引擎找逻辑像素 pitch -> 网格拟合采样 -> Lab kmeans 调色 ->
 * 输出逻辑分辨率图 (Upscale 勾选时按原放大倍数最近邻放回; Avoid Over-Refining 跳过向更细
 * 网格的亚谐波细化)。下面是同一算法的纯 JS 实现 (等价其 "js" 后端)。 */

/** sRGB(0-255) -> CIE Lab (D65), 官方调色板在 Lab 距离下合并 */
function srgbToLab(r, g, b) {
  const lin = (v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
  const R = lin(r), G = lin(g), B = lin(b);
  let X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  let Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (v) => (v > 0.008856451679 ? Math.cbrt(v) : 7.787037 * v + 0.137961);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

/** 6 通道积分图 (RGB 的一阶矩+二阶矩, stride (W+1)*6): 矩形方差 O(1) 查询 */
function buildSAT(rgb, W, H) {
  const W1 = W + 1;
  const S = new Float64Array(W1 * (H + 1) * 6);
  for (let y = 1; y <= H; y++) {
    let a0 = 0, a1 = 0, a2 = 0, a3 = 0, a4 = 0, a5 = 0;
    for (let x = 1; x <= W; x++) {
      const i = ((y - 1) * W + (x - 1)) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      a0 += r; a1 += g; a2 += b; a3 += r * r; a4 += g * g; a5 += b * b;
      const o = (y * W1 + x) * 6, p = ((y - 1) * W1 + x) * 6;
      S[o] = a0 + S[p]; S[o + 1] = a1 + S[p + 1]; S[o + 2] = a2 + S[p + 2];
      S[o + 3] = a3 + S[p + 3]; S[o + 4] = a4 + S[p + 4]; S[o + 5] = a5 + S[p + 5];
    }
  }
  return S;
}

function satRect(S, W1, x0, y0, x1, y1, c) {
  return S[(y1 * W1 + x1) * 6 + c] - S[(y1 * W1 + x0) * 6 + c] - S[(y0 * W1 + x1) * 6 + c] + S[(y0 * W1 + x0) * 6 + c];
}

/** 官方 spread 核: 矩形内三通道平均标准差 */
function rectStd(S, W1, x0, y0, x1, y1) {
  const n = (x1 - x0) * (y1 - y0);
  if (n < 2) return 0;
  let sd = 0;
  for (let c = 0; c < 3; c++) {
    const s1 = satRect(S, W1, x0, y0, x1, y1, c), s2 = satRect(S, W1, x0, y0, x1, y1, c + 3);
    const vn = n * s2 - s1 * s1;
    sd += (vn > 0 ? Math.sqrt(vn) : 0) / n;
  }
  return sd / 3;
}

/** 均匀划分边界 (cells 格覆盖长度 t), 与官方 trunc(i*t/a) 采样同构 */
function uniBounds(t, cells) {
  const b = new Int32Array(cells + 1);
  for (let i = 0; i <= cells; i++) b[i] = Math.min(t, Math.round((i * t) / cells));
  return b;
}

/** 行列梯度轮廓: 每条内部界线的 |dR|+|dG|+|dB| 总和 (官方 C/L) */
function gradientProfiles(rgb, W, H) {
  const col = new Float64Array(Math.max(1, W - 1));
  for (let x = 1; x < W; x++) {
    let acc = 0;
    for (let y = 0; y < H; y++) {
      const a = (y * W + x - 1) * 3, b = a + 3;
      acc += Math.abs(rgb[b] - rgb[a]) + Math.abs(rgb[b + 1] - rgb[a + 1]) + Math.abs(rgb[b + 2] - rgb[a + 2]);
    }
    col[x - 1] = acc;
  }
  const row = new Float64Array(Math.max(1, H - 1));
  for (let y = 1; y < H; y++) {
    let acc = 0;
    for (let x = 0; x < W; x++) {
      const a = ((y - 1) * W + x) * 3, b = a + W * 3;
      acc += Math.abs(rgb[b] - rgb[a]) + Math.abs(rgb[b + 1] - rgb[a + 1]) + Math.abs(rgb[b + 2] - rgb[a + 2]);
    }
    row[y - 1] = acc;
  }
  return { col, row };
}

/** 周期性判据: 轮廓按 pitch 分桶后 最大桶/均值 (规则网格 ~= pitch, 无网格 ~1) */
function boundaryContrast(prof, p) {
  const buckets = new Float64Array(p);
  let sum = 0;
  for (let i = 0; i < prof.length; i++) { buckets[i % p] += prof[i]; sum += prof[i]; }
  let mx = 0;
  for (let i = 0; i < p; i++) if (buckets[i] > mx) mx = buckets[i];
  return (p * mx) / Math.max(1e-9, sum);
}

function gridSpread(S, W1, xb, yb) {
  let acc = 0, n = 0;
  for (let j = 0; j < yb.length - 1; j++)
    for (let i = 0; i < xb.length - 1; i++) { acc += rectStd(S, W1, xb[i], yb[j], xb[i + 1], yb[j + 1]); n++; }
  return n ? acc / n : 1e18;
}

/** 候选 pitch: 官方用梯度谱找峰 (阈值 1.12, 非常宽: 普通图也会入围并强行给结果) */
function pitchCandidates(prof, maxP) {
  const out = [];
  for (let p = 3; p <= maxP; p++) if (boundaryContrast(prof, p) >= 1.12) out.push(p);
  if (out.length <= 10) return out;
  return out.sort((a, b) => boundaryContrast(prof, b) - boundaryContrast(prof, a)).slice(0, 10).sort((a, b) => a - b);
}

/** 找逻辑像素 pitch: 双轴候选 -> spread 最小对 -> 官方"最粗近似最优"阈值 (允许粗网格因抗锯齿略高) */
function findPitch(S, W1, W, H, prof, diag) {
  const maxP = Math.min(24, Math.floor(Math.min(W, H) / 4));
  if (maxP < 3) { if (diag) diag.tooSmall = true; return null; }
  let bx = { p: 3, r: -1 }, by = { p: 3, r: -1 };
  for (let p = 3; p <= maxP; p++) {
    const rx = boundaryContrast(prof.col, p), ry = boundaryContrast(prof.row, p);
    if (rx > bx.r) bx = { p: p, r: rx };
    if (ry > by.r) by = { p: p, r: ry };
  }
  // 官方: 两轴谱峰合并进同一候选表, 且每个峰做"谐波折叠" — 除以一切正整数直至下限 3, 间距 .12 内去重
  const peaks = Array.from(new Set(pitchCandidates(prof.col, maxP).concat(pitchCandidates(prof.row, maxP))));
  const cand = [];
  for (const e of peaks) {
    for (let r = 1; e / r >= 3 - 1e-9; r++) {
      const v = e / r;
      if (!cand.some((o) => Math.abs(o - v) <= 0.12)) cand.push(v);
    }
  }
  cand.sort((a, b) => a - b);
  if (!cand.length) {   // 官方: "no pitch candidates detected"
    if (diag) { diag.bestX = bx; diag.bestY = by; }
    return null;
  }
  // 官方两段式: 粗扫 (无拟合) → 1.35× 窗口保留 + top4 → 精扫 (先 refine 网格再评 spread) → 最粗可接受
  const uniSpread = (p) => gridSpread(S, W1,
    uniBounds(W, Math.max(1, Math.round(W / p))), uniBounds(H, Math.max(1, Math.round(H / p))));
  const coarse = cand.map((p) => [uniSpread(p), p]);
  const cmin = Math.min(...coarse.map((q) => q[0]));
  const keep = new Set(coarse.filter((q) => q[0] <= 1.35 * Math.max(1.25 * cmin, cmin + 0.5)).map((q) => q[1]));
  for (const q of coarse.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 4)) keep.add(q[1]);
  // 官方 L() 的 spread 评估带 2px 子格约束 (v() 的 a=2; k() 终评才放开) —
  // 非整数周期网格 (如 3.43) 的奇偶错位相消, 真周期的整数倍网格存活
  const evenB = (b) => {
    const out = [b[0]];
    for (let i = 1; i < b.length - 1; i++) {
      const v = Math.round(b[i] / 2) * 2;
      if (v - out[out.length - 1] >= 2) out.push(v);
    }
    const last = b[b.length - 1];
    if (last - out[out.length - 1] >= 2) out.push(last);
    else out[out.length - 1] = last;
    return out;
  };
  const fitted = [];
  for (const p of Array.from(keep).sort((a, b) => a - b)) {
    const rx = refineGrid(prof.col, W, p), ry = refineGrid(prof.row, H, p);
    fitted.push([gridSpread(S, W1, evenB(dpFitBounds(prof.col, W, rx.pitch, 1.2, rx.off)), evenB(dpFitBounds(prof.row, H, ry.pitch, 1.2, ry.off))), p]);
  }
  const fmin = Math.min(...fitted.map((q) => q[0]));
  const thr = Math.max(1.25 * fmin, fmin + 0.5);
  let chosen = null;
  for (const q of fitted) if (q[0] <= thr && (chosen === null || q[1] > chosen[1])) chosen = q;
  if (!chosen) chosen = fitted[0];
  return { pitchX: chosen[1], pitchY: chosen[1], spread: chosen[0] };
}

/** 网格重建平均绝对误差 (官方亚谐波采纳判据) */
function gridMAE(rgb, W, H, xb, yb) {
  let acc = 0;
  for (let j = 0; j < yb.length - 1; j++) {
    for (let i = 0; i < xb.length - 1; i++) {
      const x0 = xb[i], x1 = xb[i + 1], y0 = yb[j], y1 = yb[j + 1];
      let sr = 0, sg = 0, sb = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 3; sr += rgb[k]; sg += rgb[k + 1]; sb += rgb[k + 2]; }
      const n = Math.max(1, (x1 - x0) * (y1 - y0));
      const mr = sr / n, mg = sg / n, mb = sb / n;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 3; acc += Math.abs(rgb[k] - mr) + Math.abs(rgb[k + 1] - mg) + Math.abs(rgb[k + 2] - mb); }
    }
  }
  return acc / (W * H * 3);
}

/** 逐格平均色 + 逐格 alpha */
function sampleCells(rgb, alpha, W, H, xb, yb) {
  const cx = xb.length - 1, cy = yb.length - 1;
  const cells = new Float64Array(cx * cy * 3);
  const al = alpha ? new Uint8Array(cx * cy) : null;
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      let sr = 0, sg = 0, sb = 0, n = 0, sa = 0, na = 0;
      for (let y = yb[j]; y < yb[j + 1]; y++) for (let x = xb[i]; x < xb[i + 1]; x++) {
        const k = y * W + x;
        const a = alpha ? alpha[k] : 255;
        sa += a; na++;
        if (a >= 32) { const q = k * 3; sr += rgb[q]; sg += rgb[q + 1]; sb += rgb[q + 2]; n++; }
      }
      const o = (j * cx + i) * 3;
      if (n > 0) { cells[o] = sr / n; cells[o + 1] = sg / n; cells[o + 2] = sb / n; }
      if (al) al[j * cx + i] = na ? Math.round(sa / na) : 0;
    }
  }
  return { cells, cx, cy, alpha: al };
}

function p95(arr) {
  const a = Array.from(arr);
  a.sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0;
}

/** Lab kmeans (确定性初始化): 返回 RGB 调色板 / 唯一色归属 / 95 分位色差 */
function kmeansRGB(rgbList, labs, m) {
  const n = rgbList.length;
  m = Math.max(1, Math.min(m, n));
  const centLab = [], centRGB = [];
  for (let c = 0; c < m; c++) {
    const s = Math.floor(((c + 0.5) * n) / m);
    centLab.push(labs[s].slice()); centRGB.push(rgbList[s].slice());
  }
  const assign = new Int32Array(n);
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < n; i++) {
      const l = labs[i];
      let bi = 0, bd = Infinity;
      for (let c = 0; c < m; c++) {
        const cl = centLab[c];
        const a = l[0] - cl[0], b = l[1] - cl[1], d = l[2] - cl[2];
        const q = a * a + b * b + d * d;
        if (q < bd) { bd = q; bi = c; }
      }
      assign[i] = bi;
    }
    const sR = [], sL = [];
    for (let c = 0; c < m; c++) { sR.push([0, 0, 0, 0]); sL.push([0, 0, 0]); }
    for (let i = 0; i < n; i++) {
      const t = sR[assign[i]], u = sL[assign[i]];
      t[0] += rgbList[i][0]; t[1] += rgbList[i][1]; t[2] += rgbList[i][2]; t[3]++;
      u[0] += labs[i][0]; u[1] += labs[i][1]; u[2] += labs[i][2];
    }
    for (let c = 0; c < m; c++) {
      if (sR[c][3] > 0) {
        centRGB[c] = [sR[c][0] / sR[c][3], sR[c][1] / sR[c][3], sR[c][2] / sR[c][3]];
        centLab[c] = [sL[c][0] / sR[c][3], sL[c][1] / sR[c][3], sL[c][2] / sR[c][3]];
      }
    }
  }
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const l = labs[i];
    let bd = Infinity, bi = 0;
    for (let c = 0; c < m; c++) {
      const cl = centLab[c];
      const a = l[0] - cl[0], b = l[1] - cl[1], d = l[2] - cl[2];
      const q = a * a + b * b + d * d;
      if (q < bd) { bd = q; bi = c; }
    }
    assign[i] = bi;
    dist[i] = Math.sqrt(bd);
  }
  const palette = centRGB.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]);
  return { palette, assign, d95: p95(dist), k: m };
}

/** Palettize: off=不动; custom=量化到 colors 色; auto=Lab 距离 95 分位 <= 6.5 (官方 autoTol) 下二分最少色数 */
function quantizeCells(cells, mode, colors) {
  if (mode === "off") return null;
  const total = cells.length / 3;
  const uniq = new Map();
  const rgbList = [], labs = [];
  const idxOf = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    const r = Math.round(cells[3 * i]), g = Math.round(cells[3 * i + 1]), b = Math.round(cells[3 * i + 2]);
    const key = ((r << 16) | (g << 8) | b) >>> 0;
    let u = uniq.get(key);
    if (u === undefined) { u = rgbList.length; uniq.set(key, u); rgbList.push([r, g, b]); labs.push(srgbToLab(r, g, b)); }
    idxOf[i] = u;
  }
  const nU = rgbList.length;
  if (nU <= 1) return null;
  let best;
  if (mode === "custom") {
    best = kmeansRGB(rgbList, labs, Math.min(colors, nU));
  } else {
    best = kmeansRGB(rgbList, labs, Math.min(256, nU));
    const tol = 6.5;
    if (best.d95 <= tol) {
      let lo = 1, hi = best.k;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const t = kmeansRGB(rgbList, labs, mid);
        if (t.d95 <= tol) { hi = mid; best = t; } else lo = mid + 1;
      }
    }
  }
  const out = new Float64Array(cells.length);
  for (let i = 0; i < total; i++) {
    const c = best.palette[best.assign[idxOf[i]]];
    out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2];
  }
  return { cells: out, size: best.k };
}

/** 官方 k() refine: pitch ±4% 共 33 档 × 16 种分数偏移(1/16 pitch),
 *  以"边界落在强梯度上"的 1D 对齐度为评分 (替代官方 GPU 2D-spread 穷举) */
function refineGrid(prof, len, pitch) {
  const lo = 0.96 * pitch, step = (1.04 * pitch - lo) / 32;
  let bestP = pitch, bestOff = 0, bestScore = -1;
  for (let i = 0; i < 33; i++) {
    const p = Math.max(1.2, i === 32 ? 1.04 * pitch : lo + i * step);
    const kMax = Math.floor(len / p);
    if (kMax < 2) continue;
    for (let j = 0; j < 48; j++) {
      const off = (j / 48) * p;
      let sc = 0, cnt = 0;
      for (let k = 1; k <= kMax; k++) {           // 均值化: 不偏袒边界更多的细网格 (官方 spread 语义)
        const idx = Math.round(off + k * p) - 1;   // 边界列 1..len-1 -> prof 下标
        if (idx >= 0 && idx < prof.length) { sc += prof[idx]; cnt++; }
      }
      if (cnt > 1) sc /= cnt;
      if (sc > bestScore) { bestScore = sc; bestP = p; bestOff = off; }
    }
  }
  return { pitch: bestP, off: bestOff };
}

/** 高斯平滑 (官方 x(): sigma=.8, 3sigma 核, 零填充) */
function gaussSmoothP(e) {
  const t = 2, ker = new Float64Array(2 * t + 1); let a = 0;
  for (let j = -t; j <= t; j++) { ker[j + t] = Math.exp(-0.5 * (j / 0.8) ** 2); a += ker[j + t]; }
  for (let j = 0; j < ker.length; j++) ker[j] /= a;
  const n = e.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < ker.length; j++) { const idx = i + j - t; if (idx >= 0 && idx < n) acc += ker[j] * e[idx]; }
    out[i] = acc;
  }
  return out;
}
function pct(e, q) {
  const r = Float64Array.from(e); r.sort(); const n = r.length;
  if (!n) return NaN;
  if (n === 1) return r[0];
  const a = (q / 100) * (n - 1), l = Math.floor(a), o = Math.ceil(a);
  return r[l] + (r[o] - r[l]) * (a - l);
}
/** 官方 x(): DP 非刚性边界拟合。间距限 [max(2,.7p), max(d+1,1.35p)];
 *  评分 = 梯度强度 (98 分位归一, 封顶 1.5, 首尾 +0.6)
 *        - lam*((间距-pitch)/pitch)^2 均匀性罚
 *        - (给了 off 时) .35*((相位偏差)/(pitch/2))^2 相位罚; 尾链长<2 的边界剔除 */
function dpFitBounds(prof, len, pitch, lam, off) {
  if (lam === undefined || lam === null) lam = 1.2;
  const u = gaussSmoothP(prof);
  const s = pct(u, 98) + 1e-9;
  const c = prof.length + 1;
  const h = new Float64Array(c + 1);
  h[0] = h[c] = 0.6;
  for (let e = 1; e < c; e++) { const v = u[e - 1] / s; h[e] = v > 1.5 ? 1.5 : v; }
  if (off !== null && off !== undefined) {
    for (let e = 0; e <= c; e++) {
      let r = (e - off + pitch / 2) % pitch;
      if (r < 0) r += pitch;
      r -= pitch / 2;
      h[e] -= 0.35 * (r / (pitch / 2)) ** 2;
    }
  }
  const d = Math.max(2, Math.round(0.7 * pitch));
  const g = Math.max(d + 1, Math.round(1.35 * pitch));
  const m = new Float64Array(c + 1).fill(-1e18);
  const b = new Int32Array(c + 1).fill(-1);
  const A = Math.min(c, g);
  for (let e = 0; e <= A; e++) m[e] = h[e];
  for (let e = d; e <= c; e++) {
    const lo = Math.max(0, e - g), hi = e - d;
    let bi = -1, bs = -1e18;
    for (let i = lo; i <= hi; i++) {
      const sp = m[i] - lam * ((e - i - pitch) / pitch) ** 2 + h[e];
      if (sp > bs) { bs = sp; bi = i; }
    }
    if (bs > m[e]) { m[e] = bs; b[e] = bi; }
  }
  const x0 = Math.max(0, c - g);
  let M = x0, E = m[x0];
  for (let e = x0 + 1; e <= c; e++) { if (m[e] > E) { E = m[e]; M = e; } }
  const out = [];
  let v = M;
  while (v >= 0) { out.push(v); v = b[v]; }
  out.reverse();
  if (out[0] !== 0) out.unshift(0);
  if (out[out.length - 1] !== c) out.push(c);
  while (out.length > 2 && out[1] - out[0] < 2) out.splice(1, 1);
  while (out.length > 2 && out[out.length - 1] - out[out.length - 2] < 2) out.splice(out.length - 2, 1);
  return out;
}

/** 主流程: 解码 -> (过大缩小) -> SAT -> 找 pitch -> (亚谐波细化) -> 采样成逻辑分辨率 -> Palettize -> (Upscale) */
function pixelSnapToCanvas(bitmap, opts) {
  const w0 = bitmap.width, h0 = bitmap.height;
  const MAXP = 2500000;   // 纯 JS 后端的处理像素上限 (官方是后端 maxPixels 同类保护)
  let W = w0, H = h0, note = "";
  const src = document.createElement("canvas");
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (w0 * h0 > MAXP) {
    const f = Math.sqrt(MAXP / (w0 * h0));
    W = Math.max(1, Math.floor(w0 * f)); H = Math.max(1, Math.floor(h0 * f));
    src.width = W; src.height = H;
    sctx.imageSmoothingEnabled = true; sctx.imageSmoothingQuality = "high";
    sctx.drawImage(bitmap, 0, 0, W, H);
    note = "大图已缩到 " + W + "x" + H + " 检测";
  } else {
    src.width = W; src.height = H;
    sctx.drawImage(bitmap, 0, 0);
  }
  const data = sctx.getImageData(0, 0, W, H).data;
  const rgb = new Float64Array(W * H * 3);
  let hasA = false, blank = true;
  for (let k = 0, i = 0; k < W * H; k++, i += 4) {
    const a = data[i + 3];
    if (a !== 255) hasA = true;
    if (a !== 0) blank = false;
    rgb[k * 3] = data[i]; rgb[k * 3 + 1] = data[i + 1]; rgb[k * 3 + 2] = data[i + 2];
  }
  if (blank) return { error: "图片全透明, 无法处理" };
  let alpha = null;
  if (hasA) {
    alpha = new Uint8Array(W * H);
    for (let k = 0, i = 0; k < W * H; k++, i += 4) alpha[k] = data[i + 3];
  }
  const prof = gradientProfiles(rgb, W, H);
  const S = buildSAT(rgb, W, H);
  const diag = {};
  const pk = findPitch(S, W + 1, W, H, prof, diag);
  if (!pk) {
    if (diag.tooSmall) return { error: "图片太小, 无法检测像素网格" };
    return {
      error: "未检测到任何周期结构 (过平滑/纯色?): x轴最强周期 " + diag.bestX.p + "px 强度 " +
        diag.bestX.r.toFixed(2) + ", y轴 " + diag.bestY.p + "px 强度 " + diag.bestY.r.toFixed(2) + ", 需 >1.12",
    };
  }
  // 官方 D()+k(): 对 {锚点, 锚点/2, 锚点/3}(下限 1.5) 每档先 ±4%/16 偏移 refine, 再 MAE 序贯 20% 判据
  const evalGrid = (ax, ay) => {
    const rx = refineGrid(prof.col, W, ax), ry = refineGrid(prof.row, H, ay);
    const bx = dpFitBounds(prof.col, W, rx.pitch, 1.2, rx.off);
    const by = dpFitBounds(prof.row, H, ry.pitch, 1.2, ry.off);
    return { mae: gridMAE(rgb, W, H, bx, by), bx, by, px: rx.pitch, py: ry.pitch };
  };
  let chosen = evalGrid(pk.pitchX, pk.pitchY);
  if (!opts.avoid) {
    for (const d of [2, 3]) {
      const ax = pk.pitchX / d, ay = pk.pitchY / d;
      if (ax < 1.5 || ay < 1.5) continue;
      const c2 = evalGrid(ax, ay);
      if (c2.mae < chosen.mae * 0.8) chosen = c2;
    }
  }
  const smp = sampleCells(rgb, alpha, W, H, chosen.bx, chosen.by);
  let cells = smp.cells, paletteSize = 0;
  const q = quantizeCells(cells, opts.palette, opts.colors);
  if (q) { cells = q.cells; paletteSize = q.size; }
  const work = document.createElement("canvas");
  work.width = smp.cx; work.height = smp.cy;
  const wctx = work.getContext("2d");
  const img = wctx.createImageData(smp.cx, smp.cy);
  for (let k = 0; k < smp.cx * smp.cy; k++) {
    img.data[4 * k] = Math.round(cells[3 * k]);
    img.data[4 * k + 1] = Math.round(cells[3 * k + 1]);
    img.data[4 * k + 2] = Math.round(cells[3 * k + 2]);
    img.data[4 * k + 3] = smp.alpha ? smp.alpha[k] : 255;
  }
  wctx.putImageData(img, 0, 0);
  let out = work;
  if (opts.upscale) {
    // 官方: 回到输入所暗示的放大倍数 (原尺寸/逻辑尺寸), 最近邻放回
    const f = Math.max(1, Math.round(((w0 / smp.cx) + (h0 / smp.cy)) / 2));
    out = document.createElement("canvas");
    out.width = smp.cx * f; out.height = smp.cy * f;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.drawImage(work, 0, 0, out.width, out.height);
  }
  return { canvas: out, pitch: [chosen.px, chosen.py], logical: [smp.cx, smp.cy], paletteSize, note };
}

/** 输入收集与后端 run_director 对齐: 单图在前 + 目录在后, 去重后浏览器逐张处理 */
async function runPixelSnap(opts, runBtn) {
  const inputs = [];
  const one = picker.get();
  if (one) inputs.push(one);
  const dir = pathCtl.value.trim();
  if (dir) {
    try {
      const res = await get("/api/director/local-images?dir=" + encodeURIComponent(dir));
      for (const p of res.images || []) inputs.push(p);
    } catch (e) {
      showResult(infoEl, "❌ 读取目录失败: " + e.message);
      return;
    }
  }
  const norm = (p) => p.replace(/[\\]/g, "/");
  const seen = new Set();
  const list = inputs.filter((p) => !seen.has(norm(p)) && seen.add(norm(p)));
  if (!list.length) {
    toast("请选择图片或填写批处理路径", "warning");
    return;
  }

  snapStop = false;
  runBtn.disabled = true;
  const urls = [];
  const pitches = new Set();
  let fail = 0, lastFailMsg = "", lastNote = "";
  try {
    for (let i = 0; i < list.length; i++) {
      if (snapStop) break;
      infoEl.textContent = "🖥️ 浏览器本地处理 " + (i + 1) + "/" + list.length + " ...";
      try {
        const resp = await fetch(imageUrl(list[i]));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const bitmap = await createImageBitmap(await resp.blob());
        const snapped = pixelSnapToCanvas(bitmap, opts);
        if (bitmap.close) bitmap.close();
        if (snapped.error) { fail++; lastFailMsg = snapped.error; continue; }
        if (snapped.note) lastNote = snapped.note;
        pitches.add((+snapped.pitch[0].toFixed(2)) + "x" + (+snapped.pitch[1].toFixed(2)));
        const blob = await new Promise((r) => snapped.canvas.toBlob(r, "image/png"));
        if (!blob) throw new Error("导出失败");
        const stem = (list[i].split(/[\\/]/).pop() || "image").replace(/[.][^.]+$/, "");
        const saved = await uploadFiles([new File([blob], stem + "_pixelsnap.png", { type: "image/png" })], "director/pixel_snap");
        if (saved[0] && saved[0].path) {
          urls.push(saved[0].path);
          gallery(galleryEl, urls, { zoomOnClick: true });   // 逐张回显, 与后端任务观感一致
        }
      } catch (e) {
        fail++;
        lastFailMsg = e && e.message ? e.message : "处理失败";
      }
    }
  } finally {
    runBtn.disabled = false;
  }
  const headMsg = snapStop ? "⏹ 已停止, " : "✅ ";
  let msg = headMsg + "Pixel Snap 完成: 共 " + urls.length + " 张";
  if (fail) msg += ", 跳过/失败 " + fail + " 张" + (lastFailMsg ? " (如: " + lastFailMsg + ")" : "");
  if (pitches.size) msg += " · 像素周期 " + Array.from(pitches).join(" / ");
  if (lastNote) msg += " · " + lastNote;
  msg += " (浏览器本地执行, 未消耗积分)";
  showResult(infoEl, msg);
  if (urls.length) toast("🔳 Pixel Snap 完成: " + urls.length + " 张", "success");
}

export function onShow() {}
