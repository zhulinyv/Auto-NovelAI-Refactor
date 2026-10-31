// ============================================================
// 法术解析视图: 读取信息 / 图片反推 / 抹除数据 (已迁移到「图片工具」插件)
// ============================================================
import { el, clear, toast, imageDropZone, copyText } from "../ui.js";
import { post } from "../api.js";
import { renderTabs } from "../components.js";
import { setGenerateState, getC, stripTextSection } from "./generate.js";
import { showView } from "../app.js";

let S = null;

export let pnginfoPicker = null;
let readTabBtn = null;

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["🔮 法术解析", el("span", { class: "sub", text: "读取 / 反推图片信息" })]),
  );
  const tabsWrap = el("div");
  container.append(tabsWrap);

  renderTabs([
    { title: "📖 读取信息", render: renderRead },
    { title: "🏷️ 图片反推", render: renderTagger },
    { title: "🧼 抹除数据", render: renderRemoveNotice },
  ], tabsWrap);
  // "读取信息"页签按钮: 外部发送图片时强制切回本页签 (视图 DOM 常驻, 上次可能停在反推/抹除页签)
  readTabBtn = container.querySelector(".tabs .tab-btn");
}

/** 供其他视图"发送到法术解析"调用: 激活读取信息页签并载入图片。
 *  否则新图只进隐藏的读取页签, 用户停留在旧页签上看到的还是上次那张旧图 */
export function openWithImage(path) {
  if (readTabBtn) readTabBtn.click();
  if (pnginfoPicker?.set) {
    pnginfoPicker.set(path);
    if (pnginfoPicker.onChange) pnginfoPicker.onChange(path);
  }
}

// ---------------- 读取信息 ----------------

let pnginfoReadFields = null;

/** 关闭图片时清空并隐藏全部信息 */
function clearPngInfoFields() {
  const f = pnginfoReadFields;
  if (!f) return;
  f.prompt.value = "";
  f.negative.value = "";
  f.allViewer.clear();
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

  // 全部信息 (树形展示; 值里是 JSON 字符串的字段, 如 Comment, 会继续解析展开)
  const allValue = info.all && Object.keys(info.all).length ? info.all : null;
  f.allViewer.set(allValue, { raw: info.all ? JSON.stringify(info.all, null, 2) : "" });

  f.box.style.display = "";
  toast("信息读取成功 📖", "success");
}

// ---------------- JSON 树形展示 (参考 spell.novelai.dev) ----------------

/** JSON 值的 2 空格缩进原文; 极端情况下退回 String() */
function jsonToText(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

function jsonKind(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isJsonContainer(value) {
  return value !== null && typeof value === "object";
}

/** 元数据里的 Comment 是"字符串形式的 JSON": 能解析成对象/数组时继续按树展开 */
function parseEmbeddedJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isJsonContainer(parsed) ? parsed : null;
  } catch { return null; }
}

/** 展开/收起一个对象或数组节点; 三角与 aria 状态同步 */
function setJsonBlockOpen(block, open) {
  // 折叠的节点不提前构建子级 DOM: 大 JSON (如 ComfyUI workflow) 只在用户点开时才渲染,
  // 避免"读取成功但页面卡住"
  if (open && block._jsonEnsureChildren) {
    block._jsonEnsureChildren();
    block._jsonEnsureChildren = null;
  }
  block.classList.toggle("open", open);
  const toggle = block.firstElementChild && block.firstElementChild.querySelector(".json-toggle");
  if (toggle) {
    toggle.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

/** 展示字符串时保留真实换行: JSON.stringify 会把换行显示成反斜杠 + n,
 *  这里只转义反斜杠和双引号, 换行/回车原样交给 pre-wrap 渲染 */
function jsonStringText(value) {
  return '"' + String(value).replace(/\r\n?/g, "\n").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function jsonScalar(value) {
  const kind = jsonKind(value);
  let text;
  if (kind === "string") text = jsonStringText(value);
  else if (kind === "number") text = Number.isFinite(value) ? String(value) : "null";
  else text = String(value);
  return el("span", { class: "json-val json-" + kind, text });
}

function jsonRowShell(depth) {
  const row = el("div", { class: "json-row" });
  row.style.setProperty("--depth", depth);
  return row;
}

/** 叶子节点: 字符串 / 数字 / 布尔 / null */
function jsonLeafRow(key, value, depth) {
  const row = jsonRowShell(depth);
  row.append(el("span", { class: "json-toggle json-toggle-empty" }));
  if (key != null) {
    row.append(el("span", { class: "json-key", text: key }), el("span", { class: "json-punct json-colon", text: ":" }));
  }
  row.append(jsonScalar(value));
  return row;
}

/** 空对象/空数组不显示三角, 直接给 {} / [] */
function jsonEmptyContainerRow(key, value, depth) {
  const row = jsonRowShell(depth);
  row.append(el("span", { class: "json-toggle json-toggle-empty" }));
  if (key != null) {
    row.append(el("span", { class: "json-key", text: key }), el("span", { class: "json-punct json-colon", text: ":" }));
  }
  row.append(el("span", { class: "json-val json-object", text: Array.isArray(value) ? "[]" : "{}" }));
  return row;
}

function jsonBlock(value, key, depth, opts, extra = {}) {
  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, i) => [String(i), item]) : Object.entries(value);
  if (!entries.length) return jsonEmptyContainerRow(key, value, depth);

  const block = el("div", { class: "json-block" });
  if (extra.root) block.dataset.root = "1";
  const branch = jsonRowShell(depth);
  branch.classList.add("json-branch");
  const toggle = el("button", { class: "json-toggle", type: "button", "aria-label": "展开或收起" });
  branch.append(toggle);
  if (key != null) {
    branch.append(el("span", { class: "json-key", text: key }), el("span", { class: "json-punct json-colon", text: ":" }));
  }
  branch.append(el("span", { class: "json-punct", text: isArray ? "[" : "{" }));
  branch.append(el("span", { class: "json-ellipsis", text: "…" }));
  if (extra.badge) {
    branch.append(el("span", { class: "json-badge", text: extra.badge, title: extra.badgeTitle || "" }));
  }

  const children = el("div", { class: "json-children" });
  let childrenBuilt = false;
  block._jsonEnsureChildren = () => {
    if (childrenBuilt) return;
    childrenBuilt = true;
    entries.forEach(([childKey, childValue]) => children.append(jsonNode(childValue, childKey, depth + 1, opts)));
  };

  const closeRow = jsonRowShell(depth);
  closeRow.classList.add("json-close");
  closeRow.append(el("span", { class: "json-toggle json-toggle-empty" }), el("span", { class: "json-punct", text: isArray ? "]" : "}" }));

  block.append(branch, children, closeRow);
  setJsonBlockOpen(block, extra.open !== undefined ? extra.open : depth < opts.expandDepth);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    setJsonBlockOpen(block, !block.classList.contains("open"));
  });
  return block;
}

function jsonNode(value, key, depth, opts, isRoot = false) {
  // 字符串里藏着的对象/数组 (元数据 Comment): 显示成可展开的树, 并标注 JSON
  if (opts.parseEmbedded && typeof value === "string") {
    const parsed = parseEmbeddedJson(value);
    if (parsed) {
      return jsonBlock(parsed, key, depth, opts, {
        root: isRoot,
        // 「全部信息」展开后 Comment 的顶层字段直接可见; 其它字段里藏的 JSON 保持折叠
        open: key === "Comment" && depth < opts.expandDepth,
        badge: "JSON",
        badgeTitle: "该字段的值是 JSON 字符串，已解析为树形显示",
      });
    }
  }
  if (isJsonContainer(value)) return jsonBlock(value, key, depth, opts, { root: isRoot });
  return jsonLeafRow(key, value, depth);
}

/** 展开整棵子树: 先展开当前节点 (懒构建直接子级), 再递归展开新建出来的子节点 */
function setJsonSubtreeOpen(block, open) {
  setJsonBlockOpen(block, open);
  if (!open) return;
  block.querySelectorAll(":scope > .json-children > .json-block").forEach((child) => setJsonSubtreeOpen(child, true));
}

function buildJsonTree(value, opts) {
  const tree = el("div", { class: "json-tree" });
  tree.append(jsonNode(value, null, 0, opts, true));
  return tree;
}

/** 可折叠 JSON 树 + 原文切换 + 展开/收起/复制 (只做展示, 不改动数据) */
function createJsonViewer({ expandDepth = 2, parseEmbedded = false, emptyText = "无数据" } = {}) {
  const treeHost = el("div");
  const rawHost = el("pre", { class: "json-raw", style: "display:none;" });
  const body = el("div", { class: "json-viewer" }, [treeHost, rawHost]);

  const expandBtn = el("button", { class: "mini-btn", type: "button", text: "展开全部", title: "展开所有嵌套层级" });
  const collapseBtn = el("button", { class: "mini-btn", type: "button", text: "收起全部", title: "收起所有嵌套层级, 只保留顶层字段" });
  const copyBtn = el("button", { class: "mini-btn", type: "button", text: "复制", title: "复制完整 JSON 原文" });
  const rawBtn = el("button", { class: "mini-btn", type: "button", text: "原文", title: "在树形与原文之间切换" });
  const toolbar = el("div", { class: "json-toolbar" }, [expandBtn, collapseBtn, copyBtn, rawBtn]);

  let value = null;
  let raw = "";
  let available = false;
  let mode = "tree";

  function setMode(next) {
    mode = next;
    treeHost.style.display = mode === "tree" ? "" : "none";
    rawHost.style.display = mode === "raw" ? "" : "none";
    rawBtn.textContent = mode === "tree" ? "原文" : "树形";
  }

  function set(nextValue, options = {}) {
    available = nextValue !== undefined && nextValue !== null && nextValue !== "";
    value = nextValue;
    raw = options.raw != null ? String(options.raw) : (available ? jsonToText(nextValue) : "");
    rawHost.textContent = raw;
    treeHost.replaceChildren();
    if (available) treeHost.append(buildJsonTree(value, { expandDepth, parseEmbedded }));
    else treeHost.append(el("div", { class: "json-empty", text: emptyText }));
    [expandBtn, collapseBtn, copyBtn, rawBtn].forEach((btn) => { btn.disabled = !available; });
    setMode("tree");
  }

  function clear() { set(null); }

  expandBtn.addEventListener("click", () => {
    const rootBlock = treeHost.querySelector(".json-block");
    if (rootBlock) setJsonSubtreeOpen(rootBlock, true);
  });
  collapseBtn.addEventListener("click", () => {
    // 只收起嵌套层级; 顶层节点保持用户当前状态 (手动收起根节点后不会被这个按钮重新打开)
    treeHost.querySelectorAll(".json-block").forEach((block) => {
      if (block.dataset.root !== "1") setJsonBlockOpen(block, false);
    });
  });
  copyBtn.addEventListener("click", async () => {
    if (!available) return;
    const ok = await copyText(raw);
    toast(ok ? "JSON 已复制" : "复制失败", ok ? "success" : "error");
  });
  rawBtn.addEventListener("click", () => setMode(mode === "tree" ? "raw" : "tree"));

  set(null);
  return { node: body, toolbar, set, clear };
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
    // Description 是整段文本, 可能自带换行: 单独标记, 由 CSS 保留换行并左对齐
    if (key === "description") {
      item.classList.add("spell-item-desc");
      val.classList.add("spell-val-desc");
    }
    fields.meta[key] = { item, val };
    metaBox.append(item);
  });
  box.append(el("div", { class: "spell-sec" }, [el("div", { class: "spell-sec-title", text: "📄 元数据" }), metaBox]));

  const allViewer = createJsonViewer({ expandDepth: 2, parseEmbedded: true, emptyText: "无元数据" });
  fields.allViewer = allViewer;
  // 全部信息默认隐藏; 展开后按钮集中在标题下方的一行, 收起后只保留标题 + 展开
  const allWrap = el("div", { class: "spell-sec collapsed" });
  const allExpandBtn = el("button", { class: "mini-btn all-info-toggle", type: "button", text: "展开" });
  const allCollapseBtn = el("button", { class: "mini-btn", type: "button", text: "收起" });
  function setAllCollapsed(collapsed) {
    allWrap.classList.toggle("collapsed", collapsed);
  }
  allExpandBtn.addEventListener("click", (e) => { e.stopPropagation(); setAllCollapsed(false); });
  allCollapseBtn.addEventListener("click", () => setAllCollapsed(true));
  const allHead = el("div", { class: "spell-sec-title all-info-head", style: "cursor:pointer;" }, [
    el("span", { text: "🗂 全部信息 (JSON)" }),
    allExpandBtn,
  ]);
  allHead.addEventListener("click", () => setAllCollapsed(!allWrap.classList.contains("collapsed")));
  const allActions = el("div", { class: "all-info-actions" }, [allViewer.toolbar, allCollapseBtn]);
  allWrap.append(allHead, allActions, el("div", { class: "json-view-wrap" }, [allViewer.node]));
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

  // 图片与右侧信息 1:1 平分宽度; 右侧 JSON 树可能很长, 左侧不强制等高
  const rdLayout = el("div", { class: "grid", style: "grid-template-columns:1fr 1fr;align-items:start;" });
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
    // stripTextSection: 与法术解析"发送到图片生成"一致, 不把 teXt 段带进生图表单
    if (p && p.positive) { p.positive.set(stripTextSection(str.value)); showView("generate"); toast("已发送 🌸", "success"); }
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

// ---------------- 抹除数据 (已并入「图片工具」插件) ----------------

const IMAGE_TOOLS_PLUGIN = "anr_plugin_image_tools";
const IMAGE_TOOLS_CLEAR_TAB = "清除元数据";
const IMAGE_TOOLS_CLEAR_PANEL = "meta_clear";

/** 跳到「图片工具」插件的「清除元数据」面板。
 *  插件页是异步渲染的 (renderPluginPage 先落盘上次表单值, 再清空容器重建 DOM), showView 会把
 *  这个 Promise 返回出来, 必须 await 之后再操作: 否则查到的是上一次渲染残留的旧页签, 点它等于没点,
 *  而新页面重建后又停在第一个面板 —— 表现为"只是跳到了图片工具, 没切到清除元数据"。 */
async function openImageToolsClearPanel() {
  if (!(S.app.plugins || []).some((p) => p.name === IMAGE_TOOLS_PLUGIN)) {
    toast("未找到「图片工具」插件, 请先在插件商店安装并启用", "warning");
    return;
  }
  await showView(`plugin-${IMAGE_TOOLS_PLUGIN}`);
  const btns = [...document.querySelectorAll("#view-plugin-page .tabs .tab-btn")];
  const panels = [...document.querySelectorAll("#view-plugin-page .tab-content[data-plugin]")];
  // 页签按钮与面板同序: 优先按 data-panel 定位, 插件改了面板 id 时退回按标题匹配
  let i = panels.findIndex((p) => p.dataset.panel === IMAGE_TOOLS_CLEAR_PANEL);
  if (i === -1 || !btns[i]) i = btns.findIndex((b) => b.textContent.includes(IMAGE_TOOLS_CLEAR_TAB));
  const btn = btns[i];
  if (btn) {
    btn.click();
    // 点完确认目标面板真的激活了, 别静悄悄停在别的面板
    if (panels[i]?.classList.contains("active")) return;
  }
  toast("未能定位「清除元数据」面板, 请在图片工具插件内手动切换页签", "warning");
}

/** 抹除数据页签的说明: 功能已迁移, 这里只提供入口 (原单张/批处理控件与后端接口已删除) */
function renderRemoveNotice(body) {
  const goBtn = el("button", { class: "btn btn-primary", text: "🧹 打开[图片工具•清除元数据]" });
  goBtn.addEventListener("click", () => { openImageToolsClearPanel(); });

  const items = [
    "单张图片或整个目录批处理 (目录内图片按文件名自然排序, 支持随时停止);",
    "按类别勾选清除项 (PNG 文本块 / NovelAI 隐写数据 / 自定义隐写数据 / EXIF / ICC / XMP), 也可只清除指定键, 例如仅删 Comment 而保留其余;",
    "清除后写入自定义信息 (写入 Auto-NovelAI-Refactor 字段);",
    "PNG / TIF / BMP 连藏在像素最低位里的隐写数据一并抹除;",
    "可顺带转换格式与调整质量, 默认不覆盖原图 (输出为「原名 + 后缀」, 也可指定输出目录或覆盖原图)。",
  ];
  const list = el("ul", { style: "margin:6px 0 10px 20px;line-height:2;font-size:13px;color:var(--text-2);" });
  items.forEach((t) => list.append(el("li", { text: t })));

  body.append(
    el("div", { class: "card", style: "max-width:960px;" }, [
      el("div", { class: "card-title", text: "🧼 抹除数据已迁移到「图片工具」插件" }),
      el("p", {
        class: "muted",
        text: "本页原来的单张 / 批处理抹除入口已移除, 请改用「图片工具」插件的「🧹 清除元数据」面板 —— 它比这里更彻底, 也更安全:",
      }),
      list,
      el("p", { class: "muted", text: "→ 只查看信息或把参数还原到图片生成, 用本页的「📖 读取信息」页签即可, 无需抹除。" }),
      // 入口按钮: 放在说明的左下方
      el("div", { style: "margin-top:14px;" }, [goBtn]),
    ]),
  );
}

export function onShow() {}
