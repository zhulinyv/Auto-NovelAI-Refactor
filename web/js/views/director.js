// ============================================================
// 导演工具视图
// ============================================================
import { $, el, clear, toast, bus, imageDropZone, showResult } from "../ui.js";
import { post } from "../api.js";
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
];

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["🎬 导演工具", el("span", { class: "sub", text: "利用 NovelAI API 处理图片" })]),
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
      if (ev.images?.length) gallery(galleryEl, ev.images);
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
    optsWrap.append(
      el("div", { class: "field" }, [el("label", { text: "Defry" }), defry]),
      el("div", { class: "field" }, [el("label", { text: "Prompt" }), prompt])
    );
    options.defry = defry;
    options.prompt = prompt;
  } else if (kind.id === "emotion") {
    const tags = ["Neutral","Happy","Sad","Angry","Scared","Surprised","Tired","Excited","Nervous","Thinking","Confused","Shy","Disgusted","Smug","Bored","Laughing","Irritated","Aroused","Embarrassed","Worried","Love","Determined","Hurt","Playful"];
    const tag = el("select", {}, tags.map((t) => el("option", { value: t, text: t })));
    const strengths = ["Normal","Slightly Weak","Weak","Even Weaker","Very Weak","Weakest"];
    const strength = el("select", {}, strengths.map((s) => el("option", { value: s, text: s })));
    const prompt = el("input", { type: "text", placeholder: "Prompt (可选)" });
    optsWrap.append(
      el("div", { class: "field" }, [el("label", { text: "Emotion" }), tag]),
      el("div", { class: "field" }, [el("label", { text: "强度" }), strength]),
      el("div", { class: "field" }, [el("label", { text: "Prompt" }), prompt])
    );
    options.tag = tag;
    options.strength = strength;
    options.prompt = prompt;
  }

  const runBtn = el("button", { class: "btn btn-primary", text: "🚀 开始处理" });
  const stopBtn = el("button", { class: "btn btn-danger", text: "⏹ 停止处理" });
  stopBtn.addEventListener("click", async () => { try { await post("/api/stop"); } catch {} });

  runBtn.addEventListener("click", async () => {
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

export function onShow() {}
