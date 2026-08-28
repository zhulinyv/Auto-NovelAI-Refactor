// ============================================================
// 超分降噪视图
// ============================================================
import { $, el, clear, toast, bus, sliderRow, showResult } from "../ui.js";
import { post } from "../api.js";
import { gallery } from "../components.js";

let S = null;
let pathCtl = null;
let imgCtl = null;
let galleryEl = null;
let infoEl = null;

const ENGINES = [
  { id: "realcugan", title: "🎯 realcugan-ncnn-vulkan" },
  { id: "anime4k", title: "🌟 Anime4K" },
  { id: "waifu2x", title: "🍥 waifu2x-caffe" },
];

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["✨ 超分降噪", el("span", { class: "sub", text: "仅支持 Windows" })]),
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

  // 单张图片: 直接输入/选择本地路径 (不上传, 处理后保存到原目录)
  const imgField = el("div", { class: "field" }, [
    el("label", { text: "单张图片路径" }),
  ]);
  const imgCtlInput = el("input", { type: "text", placeholder: "例如: D:/images/1.png" });
  const imgBtn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "🖼️ 选择图片" });
  imgBtn.addEventListener("click", async () => {
    try {
      const { pickFile } = await import("../api.js");
      const p = await pickFile();
      if (p) { imgCtlInput.value = p; toast(`已选择图片: ${p} 🖼️`, "success"); }
    } catch (e) { toast("选择图片失败: " + e.message, "error"); }
  });
  imgCtl = imgCtlInput;
  imgField.append(el("div", { class: "file-pick-row" }, [imgCtlInput, imgBtn]));

  const tabsWrap = el("div");
  // 左栏: 一张实底卡包含 输入 + 各引擎参数(含模型)
  const baseCard = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["📂 输入"]),
    pathField,
    imgField,
    tabsWrap,
  ]);

  const outCard = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, ["🖼️ 输出"]),
  ]);
  galleryEl = el("div", { class: "gallery" });
  infoEl = el("div", { class: "info-box" });
  outCard.append(galleryEl, infoEl);

  // 右上角共享动作条 (跨页签显示当前引擎的开始/停止)
  const actBar = el("div", { class: "view-head" });

  const layout = el("div", { class: "grid", style: "grid-template-columns:1fr 1.6fr;align-items:start;" });
  layout.append(el("div", { style: "min-width:0;" }, [baseCard]), outCard);
  container.append(actBar, layout);

  const bar = el("div", { class: "tabs" });
  const bodies = [];
  ENGINES.forEach((eng, i) => {
    const btn = el("button", { class: "tab-btn" + (i === 0 ? " active" : ""), text: eng.title });
    const body = el("div", { class: "tab-content" + (i === 0 ? " active" : "") });
    btn.addEventListener("click", () => {
      [...bar.children].forEach((b) => b.classList.remove("active"));
      bodies.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      body.classList.add("active");
      // 切换右上角按钮
      clear(actBar);
      const b = ENGINES[i]._btns;
      if (b) actBar.append(b.runBtn, b.stopBtn);
    });
    bar.append(btn);
    bodies.push(body);
    renderEngine(eng, body);
  });
  tabsWrap.append(bar, ...bodies);

  // 默认显示第一个引擎的按钮
  const firstBtns = ENGINES[0]._btns;
  if (firstBtns) actBar.append(firstBtns.runBtn, firstBtns.stopBtn);

  bus.on("job:done", (ev) => {
    if (ev.name?.startsWith("超分:")) {
      if (ev.images?.length) gallery(galleryEl, ev.images);
      if (ev.message) showResult(infoEl, ev.message);
    }
  });
  bus.on("job:failed", (ev) => {
    if (ev.name?.startsWith("超分:") && ev.error) showResult(infoEl, "❌ " + ev.error);
  });
}

function sliderField(label, min, max, step, value) {
  const s = sliderRow({ min, max, step, value });
  return { node: el("div", { class: "field" }, [el("label", { text: label }), s.node]), input: s.input };
}

function renderEngine(eng, body) {
  const optsWrap = el("div", { class: "grid", style: "grid-template-columns:repeat(auto-fit,minmax(190px,1fr));" });
  const options = {};

  if (eng.id === "realcugan") {
    const noise = sliderField("🔇 降噪强度", -1, 3, 1, 3);
    const scale = sliderField("🔍 放大倍数", 2, 4, 1, 2);
    const model = el("select", {}, ["models-se", "models-pro", "models-nose"].map((m) => el("option", { value: m, text: m })));
    optsWrap.append(noise.node, scale.node, el("div", { class: "field" }, [el("label", { text: "超分模型" }), model]));
    options.noise = noise.input;
    options.scale = scale.input;
    options.model = model;
  } else if (eng.id === "anime4k") {
    const zoom = sliderField("🔍 放大倍数", 1, 32, 1, 2);
    const hdn = sliderField("🎚️ HDN 等级", 1, 3, 1, 3);
    const gpu = el("select", {}, ["true", "false"].map((v) => el("option", { value: v, text: v === "true" ? "GPU 加速" : "CPU" })));
    const cnn = el("select", {}, ["true", "false"].map((v) => el("option", { value: v, text: v === "true" ? "ACNet 模式" : "普通模式" })));
    const hdnEn = el("select", {}, ["true", "false"].map((v) => el("option", { value: v, text: v === "true" ? "HDN 开启" : "HDN 关闭" })));
    optsWrap.append(zoom.node, hdn.node,
      el("div", { class: "field" }, [el("label", { text: "GPU" }), gpu]),
      el("div", { class: "field" }, [el("label", { text: "CNN" }), cnn]),
      el("div", { class: "field" }, [el("label", { text: "HDN" }), hdnEn]));
    options.zoom = zoom.input;
    options.hdn = hdn.input;
    options.gpu = gpu;
    options.cnn = cnn;
    options.hdn_enabled = hdnEn;
  } else {
    const mode = el("select", {}, ["noise", "scale", "noise_scale"].map((m) => el("option", { value: m, text: m })));
    const process = el("select", {}, ["cpu", "gpu", "cudnn"].map((m) => el("option", { value: m, text: m })));
    const scale = sliderField("🔍 放大倍数", 1, 32, 1, 2);
    const noise = sliderField("🔇 降噪强度", 0, 3, 1, 3);
    const model = el("select", {}, ["anime_style_art_rgb","anime_style_art","photo","upconv_7_anime_style_art_rgb","upconv_7_photo","upresnet10","cunet","ukbench"].map((m) => el("option", { value: m, text: m })));
    model.value = "cunet";
    optsWrap.append(
      el("div", { class: "field" }, [el("label", { text: "模式" }), mode]),
      el("div", { class: "field" }, [el("label", { text: "处理模式" }), process]),
      scale.node, noise.node,
      el("div", { class: "field" }, [el("label", { text: "超分模型" }), model]));
    options.mode = mode;
    options.process = process;
    options.scale = scale.input;
    options.noise = noise.input;
    options.model = model;
  }

  const runBtn = el("button", { class: "btn btn-primary", text: "🚀 开始生成" });
  const stopBtn = el("button", { class: "btn btn-danger", text: "⏹ 停止生成" });
  stopBtn.addEventListener("click", async () => {
    toast("正在停止生成...", "warning");
    try { await post("/api/stop"); } catch {}
  });

  runBtn.addEventListener("click", async () => {
    const payload = {
      kind: eng.id,
      path: pathCtl.value.trim() || null,
      image: imgCtl.value.trim() || null,
      options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, v.value])),
    };
    runBtn.disabled = true;
    infoEl.textContent = "🚀 正在处理...";
    try {
      const res = await post("/api/upscale", payload);
      toast(`任务已启动: ${res.job_id}`, "success");
      runBtn.disabled = false;
    } catch (e) {
      infoEl.textContent = "❌ " + e.message;
      toast(e.message, "error");
      runBtn.disabled = false;
    }
  });

  eng._btns = { runBtn, stopBtn };
  if (optsWrap.children.length) body.append(optsWrap);
}

export function onShow() {}
