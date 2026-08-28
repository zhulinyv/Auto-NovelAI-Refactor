// ============================================================
// 法术解析视图: 读取信息 / 图片反推 / 抹除数据
// ============================================================
import { $, el, clear, toast, imageDropZone } from "../ui.js";
import { post } from "../api.js";
import { renderTabs } from "../components.js";
import { setGenerateState, getC } from "./generate.js";
import { showView } from "../app.js";

let S = null;

export let pnginfoPicker = null;

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["🔮 法术解析", el("span", { class: "sub", text: "读取 / 反推 / 抹除图片信息" })]),
  );
  const tabsWrap = el("div");
  container.append(tabsWrap);

  renderTabs([
    { title: "📖 读取信息", render: renderRead },
    { title: "🏷️ 图片反推", render: renderTagger },
    { title: "🧼 抹除数据", render: renderRemove },
  ], tabsWrap);
}

// ---------------- 读取信息 ----------------

let pnginfoReadFields = null;

/** 关闭图片时清空并隐藏全部信息 */
function clearPngInfoFields() {
  const f = pnginfoReadFields;
  if (!f) return;
  f.prompt.value = "";
  f.negative.value = "";
  f.comment.value = "";
  f.all.value = "";
  Object.values(f.params).forEach((cell) => { cell.item.style.display = "none"; cell.val.textContent = ""; });
  Object.values(f.meta).forEach((cell) => { cell.item.style.display = "none"; cell.val.textContent = ""; });
  f.box.style.display = "none";
}

/** 解析 Comment (字符串或对象) */
function parseComment(info) {
  let c = info.comment;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { c = null; } }
  return c && typeof c === "object" ? c : {};
}

async function loadPngInfo(path) {
  const info = await post("/api/pnginfo", { image_path: path });
  const f = pnginfoReadFields;
  if (!f) return;
  const c = parseComment(info);

  // 提示词
  f.prompt.value = c.v4_prompt?.caption?.base_caption || c.prompt || info.description || "";
  f.negative.value = c.negative_prompt || c.v4_negative_prompt?.caption?.base_caption || c.uc || "";

  // 参数 (参考 spell.novelai.dev 的展示方式; 读不到的数据直接隐藏, 不展示横线)
  const set = (key, rawVal, present = true) => {
    const cell = f.params[key];
    if (!cell) return;
    if (!present || rawVal == null || rawVal === "") {
      cell.item.style.display = "none";
      cell.val.textContent = "";
      return;
    }
    cell.item.style.display = "";
    cell.val.textContent = String(rawVal);
  };
  // 布尔开关: 仅开启时显示 ✅, 关闭/读不到一律隐藏
  const boolCell = (key, val) => {
    if (val === true) set(key, "✅", true);
    else set(key, null, false);
  };
  set("resolution", c.width != null && c.height != null ? c.width + " × " + c.height : null);
  set("sampler", c.sampler);
  set("steps", c.steps);
  set("scale", c.scale);
  set("cfg_rescale", c.cfg_rescale);
  set("seed", c.seed);
  set("noise", c.noise_schedule);
  boolCell("sm", c.sm);
  boolCell("sm_dyn", c.sm_dyn);
  boolCell("legacy_uc", c.v4_prompt?.legacy_uc ?? c.v4_negative_prompt?.legacy_uc);
  boolCell("variety", c.skip_cfg_above_sigma != null);

  // 元数据 (读不到的直接隐藏)
  const setMeta = (key, val) => {
    const cell = f.meta[key];
    if (!cell) return;
    const text = val == null || val === "" ? null : String(val);
    cell.item.style.display = text ? "" : "none";
    cell.val.textContent = text || "";
  };
  setMeta("source", info.source);
  setMeta("generation_time", info.generation_time);
  setMeta("software", info.software);
  setMeta("description", info.description);

  // Comment (格式化 JSON, 与 Auto-NovelAI-Refactor 解析一致)
  let commentText = "";
  if (info.comment != null) {
    if (typeof info.comment === "string") {
      try { commentText = JSON.stringify(JSON.parse(info.comment), null, 2); }
      catch { commentText = info.comment; }
    } else {
      try { commentText = JSON.stringify(info.comment, null, 2); }
      catch { commentText = String(info.comment); }
    }
  }
  f.comment.value = commentText;

  // 全部信息
  f.all.value = JSON.stringify(info.all, null, 2);

  f.box.style.display = "";
  toast("信息读取成功 📖", "success");
}

function renderRead(body) {
  const picker = imageDropZone({
    label: "🖼️ 图片",
    placeholder: "点击选择或拖入图片",
    zoneClass: "auto-fit",
    native: true,
    onChange: async (path) => {
      if (!path) { clearPngInfoFields(); return; }
      try { await loadPngInfo(path); }
      catch (e) { toast("读取失败: " + e.message, "error"); }
    },
  });
  pnginfoPicker = picker;

  // 右侧解析结果 (参考 spell.novelai.dev: 提示词 + 参数列表 + 元数据 + JSON)
  const box = el("div", { class: "card spell-card", style: "margin-top:12px;display:none;" });
  const fields = { params: {}, meta: {}, box };

  const promptTA = el("textarea", { rows: 6, readonly: true, placeholder: "读取后显示" });
  const negTA = el("textarea", { rows: 6, readonly: true, placeholder: "读取后显示" });
  fields.prompt = promptTA;
  fields.negative = negTA;
  // 正/负面提示词区域可弹性伸展, 充分利用右侧纵向空间
  box.append(
    el("div", { class: "spell-sec grow" }, [el("div", { class: "spell-sec-title", text: "✨ 正面提示词" }), promptTA]),
    el("div", { class: "spell-sec grow" }, [el("div", { class: "spell-sec-title", text: "🌙 负面提示词" }), negTA]),
  );

  const grid = el("div", { class: "spell-grid" });
  const params = [
    ["resolution", "分辨率"], ["sampler", "采样器"], ["steps", "步数"], ["scale", "引导系数"],
    ["cfg_rescale", "重采样系数"], ["seed", "种子"], ["noise", "噪声调度"],
    ["sm", "SMEA"], ["sm_dyn", "DYN"], ["legacy_uc", "Legacy UC"], ["variety", "Variety+"],
  ];
  params.forEach(([key, label]) => {
    const val = el("span", { class: "spell-val", text: "" });
    const item = el("div", { class: "spell-item", style: "display:none;" }, [el("span", { class: "spell-label", text: label }), val]);
    fields.params[key] = { item, val };
    grid.append(item);
  });
  box.append(el("div", { class: "spell-sec" }, [el("div", { class: "spell-sec-title", text: "⚙️ 参数" }), grid]));

  const metaBox = el("div", { class: "spell-meta" });
  [["source", "Source"], ["generation_time", "Generation time"], ["software", "Software"], ["description", "Description"]].forEach(([key, label]) => {
    const val = el("span", { class: "spell-val", text: "" });
    const item = el("div", { class: "spell-item", style: "display:none;" }, [el("span", { class: "spell-label", text: label }), val]);
    fields.meta[key] = { item, val };
    metaBox.append(item);
  });
  box.append(el("div", { class: "spell-sec" }, [el("div", { class: "spell-sec-title", text: "📄 元数据" }), metaBox]));

  // Comment (位于元数据与全部信息之间)
  const commentTA = el("textarea", { rows: 8, readonly: true, class: "mono-ta", placeholder: "读取后显示" });
  fields.comment = commentTA;
  box.append(el("div", { class: "spell-sec" }, [el("div", { class: "spell-sec-title", text: "💬 Comment" }), commentTA]));

  const allTA = el("textarea", { rows: 8, readonly: true, class: "mono-ta", placeholder: "读取后显示" });
  // 全部信息默认隐藏, 单击标题/按钮展开, 再次单击收起
  const allWrap = el("div", { class: "spell-sec collapsed" });
  const allToggle = el("button", { class: "mini-btn", type: "button", text: "展开" });
  function syncAllToggle() {
    allToggle.textContent = allWrap.classList.contains("collapsed") ? "展开" : "收起";
  }
  allToggle.addEventListener("click", (e) => { e.stopPropagation(); allWrap.classList.toggle("collapsed"); syncAllToggle(); });
  const allHead = el("div", { class: "spell-sec-title", style: "cursor:pointer;" }, [el("span", { text: "🗂 全部信息 (JSON)" }), allToggle]);
  allHead.addEventListener("click", () => { allWrap.classList.toggle("collapsed"); syncAllToggle(); });
  allWrap.append(allHead, allTA);
  fields.all = allTA;
  box.append(allWrap);

  pnginfoReadFields = fields;

  const sendBtn = el("button", { class: "btn btn-primary", text: "📤 发送到图片生成", style: "width:100%;" });
  sendBtn.addEventListener("click", async () => {
    try {
      const params = await post("/api/pnginfo/to-generate", { image_path: picker.get() });
      setGenerateState(params);
      showView("generate");
      toast("已发送到图片生成 🌸", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  });

  // 图片选择/拖入/外部设置经 onChange 触发读取; 关闭图片 (✖) 清空并隐藏全部信息

  // 图片与右侧信息 1:1 平分区域, 两侧等高
  const rdLayout = el("div", { class: "grid", style: "grid-template-columns:1fr 1fr;" });
  rdLayout.append(el("div", { class: "card", style: "margin:0;display:flex;flex-direction:column;" }, [picker.node, el("div", { style: "margin-top:10px;" }, [sendBtn])]), box);
  body.append(rdLayout);
}

// ---------------- 图片反推 ----------------

/** 文本域高度随内容自适应 */
function autoSizeTA(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

/** dict 数据渲染: tag + 进度条 + 百分数, 百分数越大进度条越长, 百分数在最右侧右对齐 */
function renderDictBars(container, dict) {
  clear(container);
  if (!dict || typeof dict !== "object") {
    container.append(el("div", { class: "muted", text: "无数据" }));
    return;
  }
  const entries = Object.entries(dict).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    container.append(el("div", { class: "muted", text: "无数据" }));
    return;
  }
  entries.forEach(([label, conf]) => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(conf) * 100)));
    container.append(
      el("div", { class: "bar-row" }, [
        el("span", { class: "bar-tag", text: label, title: label }),
        el("div", { class: "bar-track" }, [el("div", { class: "bar-fill", style: "width:" + pct + "%;" })]),
        el("span", { class: "bar-pct", text: pct + "%" }),
      ]),
    );
  });
}

function renderTagger(body) {
  const picker = imageDropZone({ label: "🖼️ 图片", placeholder: "点击选择或拖入图片", native: true });
  const modelSel = el("select", {}, S.app.tagger_models.map((m) => el("option", { value: m, text: m })));
  const genThresh = el("input", { type: "number", min: 0, max: 1, step: 0.05, value: 0.35 });
  const genMcut = el("input", { type: "checkbox" });
  const charThresh = el("input", { type: "number", min: 0, max: 1, step: 0.05, value: 0.85 });
  const charMcut = el("input", { type: "checkbox" });
  const outBox = el("div", { class: "card", style: "margin-top:12px;" });

  // 四个区块始终展示 (不需要反推后才出现), 反推后填充数据
  const str = el("textarea", { rows: 3, readonly: true, placeholder: "反推后显示" });
  str.addEventListener("input", () => autoSizeTA(str));
  const sendBtn = el("button", { class: "btn btn-sm", text: "📤 发送到正面提示词" });
  sendBtn.addEventListener("click", () => {
    const p = getC();
    if (p && p.positive) { p.positive.set(str.value); showView("generate"); toast("已发送 🌸", "success"); }
  });
  const ratingBox = el("div", { class: "dict-bars" });
  const charBox = el("div", { class: "dict-bars" });
  const tagsBox = el("div", { class: "dict-bars dict-bars-scroll" });
  [ratingBox, charBox, tagsBox].forEach((b) => b.append(el("div", { class: "muted", text: "尚未反推" })));
  outBox.append(
    el("div", { class: "tagger-sec" }, [
      el("div", { class: "tagger-sec-title" }, [el("span", { text: "Output (string)" }), sendBtn]),
      str,
    ]),
    el("div", { class: "tagger-sec" }, [el("div", { class: "tagger-sec-title", text: "Rating" }), ratingBox]),
    el("div", { class: "tagger-sec" }, [el("div", { class: "tagger-sec-title", text: "Characters" }), charBox]),
    el("div", { class: "tagger-sec" }, [el("div", { class: "tagger-sec-title", text: "Tags" }), tagsBox]),
  );

  const submitBtn = el("button", { class: "btn btn-primary", text: "🚀 提交反推" });
  submitBtn.addEventListener("click", async () => {
    if (!picker.get()) { toast("请先上传图片", "warning"); return; }
    submitBtn.disabled = true;
    try {
      const res = await post("/api/tagger", {
        image_path: picker.get(),
        model: modelSel.value,
        general_thresh: Number(genThresh.value),
        general_mcut: genMcut.checked,
        character_thresh: Number(charThresh.value),
        character_mcut: charMcut.checked,
      });
      // Output (string) = Tags 各 tag + Characters 各 tag 按百分数从大到小合并
      const merged = [];
      Object.entries(res.general || {}).forEach(([label, conf]) => merged.push({ label, conf }));
      Object.entries(res.characters || {}).forEach(([label, conf]) => merged.push({ label, conf }));
      merged.sort((a, b) => b.conf - a.conf);
      const mergedString = merged.map((x) => x.label).join(", ");
      str.value = mergedString || res.string || "";
      // 已在 DOM 中, 自适应高度
      requestAnimationFrame(() => autoSizeTA(str));
      renderDictBars(ratingBox, res.rating);
      renderDictBars(charBox, res.characters);
      renderDictBars(tagsBox, res.general);
      toast("反推完成 🏷️", "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      submitBtn.disabled = false;
    }
  });

  body.append(
    el("div", { class: "grid", style: "grid-template-columns:1fr 1.4fr;" }, [
      el("div", { class: "card", style: "margin:0;" }, [
        picker.node,
        el("div", { class: "field" }, [el("label", { text: "Model" }), modelSel]),
        el("div", { class: "grid grid-2" }, [
          el("div", { class: "field" }, [el("label", { text: "General Tags Threshold" }), genThresh]),
          el("label", { class: "checkline", style: "align-self:end;" }, [genMcut, document.createTextNode("Use MCut")]),
        ]),
        el("div", { class: "grid grid-2" }, [
          el("div", { class: "field" }, [el("label", { text: "Character Tags Threshold" }), charThresh]),
          el("label", { class: "checkline", style: "align-self:end;" }, [charMcut, document.createTextNode("Use MCut")]),
        ]),
      ]),
      outBox,
    ]),
  );
  body.prepend(el("div", { class: "view-head" }, [submitBtn]));
}

// ---------------- 抹除数据 ----------------

function renderRemove(body) {
  const picker = imageDropZone({ label: "🖼️ 单张处理", placeholder: "点击选择图片", native: true, dropNative: true });
  const batchPath = el("input", { type: "text", placeholder: "批处理路径 (可选, 可手动输入)", style: "flex:1;min-width:0;" });
  const dirBtn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁 选择文件夹" });
  dirBtn.addEventListener("click", async () => {
    try {
      const { pickFolder } = await import("../api.js");
      const p = await pickFolder();
      if (p) { batchPath.value = p; toast(`已选择目录: ${p} 📂`, "success"); }
    } catch (e) { toast("选择目录失败: " + e.message, "error"); }
  });
  const info = el("input", { type: "text", placeholder: "添加自定义信息 (可选)" });
  const choices = ["Title","Description","Software","Source","Generation time","Comment","dpi","parameters","prompt"];
  const choiceWrap = el("div", { class: "opt-group" });
  const selected = new Set(choices);
  choices.forEach((c) => {
    const item = el("label", { class: "opt-item selected", text: c });
    item.addEventListener("click", () => {
      item.classList.toggle("selected");
      if (selected.has(c)) selected.delete(c); else selected.add(c);
    });
    choiceWrap.append(item);
  });

  const infoBox = el("div", { class: "info-box", style: "margin-top:12px;" });
  const runBtn = el("button", { class: "btn btn-primary", text: "🧼 开始处理" });
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    infoBox.textContent = "处理中...";
    try {
      const res = await post("/api/pnginfo/remove", {
        image_path: picker.get() || null,
        batch_path: batchPath.value.trim() || null,
        choices: [...selected],
        info: info.value.trim(),
      });
      infoBox.textContent = "✅ " + res.message;
      toast(res.message, "success");
    } catch (e) {
      infoBox.textContent = "❌ " + e.message;
      toast(e.message, "error");
    } finally {
      runBtn.disabled = false;
    }
  });

  body.append(
    el("div", { class: "view-head" }, [runBtn]),
    el("div", { class: "grid", style: "grid-template-columns:1fr 1.4fr;" }, [
      el("div", { class: "card", style: "margin:0;" }, [
        picker.node,
        el("div", { class: "field" }, [el("label", { text: "📂 批处理路径 (可选)" }), el("div", { class: "file-pick-row" }, [batchPath, dirBtn])]),
      ]),
      el("div", { class: "card", style: "margin:0;" }, [
        el("div", { class: "field" }, [el("label", { text: "📝 要清除的内容" }), choiceWrap]),
        el("div", { class: "field" }, [el("label", { text: "🔖 自定义信息" }), info]),
        infoBox,
      ]),
    ])
  );
}

export function onShow() {}
