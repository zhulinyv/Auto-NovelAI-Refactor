// ============================================================
// 导演工具视图
// ============================================================
import { $, el, clear, toast, bus, imageDropZone, showResult, wildcardsButton } from "../ui.js";
import { post, get, imageUrl, uploadFiles } from "../api.js";
import { gallery, renderTabs } from "../components.js";
import { snapPixels } from "../pixelsnap.js";

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
      el("div", { class: "muted", text: "🖥️ 浏览器本地执行, 算法与官网 Director Tools 一致 (逐位对齐其纯 JS 后端): 识别被放大/平滑过的像素图, 还原为真实像素画分辨率; 勾选 Upscale 则按原倍数放回 (最近邻)。不请求 API、不消耗积分" }),
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

/** ================= Pixel Snap: 与官网同一套算法, 实现在 ../pixelsnap.js =================
 * 官网的 Pixel Snap 跑在一个专用 Web Worker 里 (WebGPU/WebGL/WASM 后端): 用梯度周期图找逻辑
 * 像素周期 pitch -> spread 目标函数两段搜索定周期与相位 -> 亚谐波按"重建 MAE 降 20%"序贯采纳 ->
 * 一维 DP 拟合非刚性网格边界 -> 单元内缩后取中位色 -> 八叉树 + Lab 距离贪心调色 -> 输出逻辑分辨率
 * 图 (勾选 Upscale 时按原放大倍数最近邻放回; Avoid Over-Refining 跳过亚谐波细化)。
 * ../pixelsnap.js 是该流程逐位对齐其纯 JS 后端的移植 (不请求 API、不消耗 Anlas 积分);
 * 这里只负责画布解码、逻辑图编码与最近邻放回。 */
function pixelSnapToCanvas(bitmap, opts) {
  const w0 = bitmap.width, h0 = bitmap.height;
  const src = document.createElement("canvas");
  src.width = w0; src.height = h0;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(bitmap, 0, 0);
  const res = snapPixels(sctx.getImageData(0, 0, w0, h0).data, w0, h0, {
    palette: opts.palette, colors: opts.colors, avoid: opts.avoid, autoTol: 6.5,
  });
  if (res.error) return { error: res.error };
  const work = document.createElement("canvas");
  work.width = res.Wc; work.height = res.Hc;
  const wctx = work.getContext("2d");
  const img = wctx.createImageData(res.Wc, res.Hc);
  img.data.set(res.rgba);
  wctx.putImageData(img, 0, 0);
  let out = work, f = 1;
  if (opts.upscale) {
    // 官方: 取两轴"原尺寸/逻辑尺寸"的均值作为整数放大倍数, 最近邻放回
    f = Math.max(1, Math.round(((w0 / res.Wc) + (h0 / res.Hc)) / 2));
    out = document.createElement("canvas");
    out.width = res.Wc * f; out.height = res.Hc * f;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.drawImage(work, 0, 0, out.width, out.height);
  }
  return {
    canvas: out, pitch: res.pitch, logical: [res.Wc, res.Hc],
    paletteSize: res.paletteSize, upscale: f, note: res.note,
  };
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
      infoEl.textContent = "🖥️ 浏览器本地处理 " + (i + 1) + "/" + list.length + (lastNote ? " (上一张 " + lastNote + ")" : "") + " ...";
      try {
        const resp = await fetch(imageUrl(list[i]));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const bitmap = await createImageBitmap(await resp.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const t0 = performance.now();
        const snapped = pixelSnapToCanvas(bitmap, opts);
        lastNote = snapped.error ? "" : (Math.round(performance.now() - t0) + "ms → " + (snapped.logical || []).join("×")
          + (snapped.paletteSize ? " / " + snapped.paletteSize + "色" : "")
          + (snapped.upscale > 1 ? " ×" + snapped.upscale + " 放回" : ""));
        if (bitmap.close) bitmap.close();
        if (snapped.error) { fail++; lastFailMsg = snapped.error; continue; }
        if (snapped.note) lastNote += " · " + snapped.note;
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