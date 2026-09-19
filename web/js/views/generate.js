// ============================================================
// 图片生成视图 (ANR 原有 Gradio 布局)
//   Row1: 提示词(左) + 模型/预设/生成按钮(右)
//   Row2: 左侧页签(参数设置/角色分区/角色参考/风格迁移) + 右侧输出画廊
//   Wildcards 功能入口在每个提示词输入框右上角 (点击弹出全屏编辑窗口)
// ============================================================
import { $, $$, el, clear, toast, bus, sliderRow, edgeScroll, imageDropZone, fileDropZone, wireAutocomplete, wildcardsButton } from "../ui.js";
import { post, imageUrl, fetchLast, openDir } from "../api.js";
import { gallery, imageEditor, roleList, characterRegionPicker } from "../components.js";

let S = null;
let C = {};
let editor = null;
let charList = null;
let charRegion = null;
let refList = null;
let vibeList = null;
let genGalleryEl = null;
let infoEl = null;
let sendBtn = null;
let sendPnginfoBtn = null;
let openDirBtn = null;
let aiChoiceRow = null;
let inpaintCtlRow = null;
let vibeBundleRow = null;
let nai3VibeRow = null;
let resHintEl = null;
let charSection = null;
let tabBtns = {};
let tabBodies = {};
let refSection = null;
let enhanceRow = null;
let furryBtn = null;
let furryMode = false; // 显式状态, 避免因 Twemoji 替换 DOM 后 textContent 不含 emoji 导致检测失败
let tbBtn = null;          // "Transparent BG" 开关按钮 (正面提示词头部, 仅 v5 模型显示)
let transparentBg = false; // 开启后生成时在用户提示词末尾追加 , transparent background
let lastOutputPath = null;
let selectedOutputPath = null; // 多张结果中当前选中的图片 (再次单击取消)
let lastGeneratedImages = []; // 最近一次生成的全部图片 (供 wildcards 取最后一张做封面)

// 剩余点数/用量下拉徽标状态 (anlas-wrap: 容器, anlas-badge: 按钮, anlas-menu: 下拉面板)
let anlasWrapEl = null;
let anlasBadgeEl = null;
let anlasMenuEl = null;
let anlasSelected = 0;         // 徽标当前展示的 Token 序号
let anlasOutsideBound = false; // 点击外部关闭下拉 (页面级只绑一次)
let anlasRefreshBtn = null;    // 徽标右侧的「🔄 刷新」按钮 (手动重查剩余点数/用量)

// ---------------- 控件工厂 ----------------

function field(label, type = "text", opts = {}) {
  const wrap = el("div", { class: "field" });
  const lbl = el("label", { text: label });
  let input;

  if (type === "select") {
    input = el("select", {}, (opts.options || []).map((o) => el("option", { value: o, text: o })));
    if (opts.value !== undefined) input.value = opts.value;
    wrap.append(lbl, input);
    return {
      node: wrap, input, get: () => input.value, set: (v) => { input.value = v; },
      setOptions: (options) => {
        const cur = input.value;
        input.innerHTML = "";
        for (const o of options) input.append(el("option", { value: o, text: o }));
        if (options.includes(cur)) input.value = cur;
      },
    };
  } else if (type === "checkbox") {
    input = el("input", { type: "checkbox" });
    input.checked = !!opts.value;
    wrap.append(el("label", { class: "checkline" }, [input, document.createTextNode(label)]));
    return { node: wrap, input, get: () => input.checked, set: (v) => { input.checked = !!v; } };
  } else if (type === "slider") {
    const s = sliderRow({ min: opts.min ?? 0, max: opts.max ?? 100, step: opts.step ?? 1, value: opts.value ?? 0 });
    wrap.append(lbl, s.node);
    return { node: wrap, input: s.input, num: s.num, get: () => s.get(), set: (v) => s.set(v) };
  } else if (type === "textarea") {
    input = el("textarea", { rows: opts.rows ?? 3, placeholder: opts.placeholder || "", value: opts.value ?? "" });
    wrap.append(lbl, input);
    return { node: wrap, input, get: () => input.value, set: (v) => { input.value = v; } };
  } else {
    input = el("input", { type, value: opts.value ?? "", placeholder: opts.placeholder || "" });
    wrap.append(lbl, input);
    return { node: wrap, input, get: () => input.value, set: (v) => { input.value = v; } };
  }
}

// ---------------- 主渲染 ----------------

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  const saved = buildSavedState();

  container.append(el("h2", {}, ["🖼️ 图片生成", el("span", { class: "sub", text: "NovelAI 批量生图" })]));

  // 标题下方 / 提示词上方: 单条工具条 (左: 模型+Mode, 右: 数量+生成按钮)
  const modelBar = el("div", { class: "model-bar" });
  buildModelBar(modelBar, saved);
  container.append(modelBar);

  container.append(buildPromptCard(saved));

  // Row2: 左侧页签 + 右侧输出
  const row2 = el("div", { class: "grid gen-layout", style: "align-items:start;" });
  row2.append(buildLeftTabs(saved), buildRightPanel());

  container.append(row2);
  charRegion?.refresh?.();

  await applyModelChange(true);
  // 启动时恢复上次的角色分区 (需在 applyModelChange 之后, 避免被模型切换逻辑清空)
  if (saved.characters?.length) {
    charList.setItems(saved.characters);
    charRegion.setCount(saved.characters.length);
    charRegion.restore(saved.characters.map((c) => c.position));
  }
  updateAiChoiceVisibility();
  bindEvents();
  wireOutputActions();
  updateAnlasBadge();
}

// ---------------- 启动加载: 从 last.json 恢复上次参数 ----------------

/** 质量预设 id -> 显示名 (与后端 return_quality_preset_id 对应) */
function qpIdToName(model, id) {
  const five = { standard: "Standard", light: "Light", none: "None" };
  const base = { standard: "Standard", none: "None" };
  return (id && (isNai5(model) ? five : base)[id]) || null;
}

/** 负面预设 id -> 显示名 (与后端 return_uc_preset_id 对应) */
function ucIdToName(model, id) {
  const maps = {
    "nai-diffusion-5-full": { heavy: "Heavy", light: "Light", furryFocus: "Furry Focus", humanFocus: "Human Focus", none: "None" },
    "nai-diffusion-5-curated": { heavy: "Heavy", light: "Light", furryFocus: "Furry Focus", humanFocus: "Human Focus", none: "None" },
    "nai-diffusion-4-5-full": { heavy: "Heavy", light: "Light", furryFocus: "Furry Focus", humanFocus: "Human Focus", none: "None" },
    "nai-diffusion-4-5-curated": { heavy: "Heavy", light: "Light", humanFocus: "Human Focus", none: "None" },
    "nai-diffusion-4-full": { heavy: "Heavy", light: "Light", none: "None" },
    "nai-diffusion-4-curated-preview": { heavy: "Heavy", light: "Light", none: "None" },
    "nai-diffusion-3": { heavy: "Heavy", light: "Light", humanFocus: "Human Focus", none: "None" },
    "nai-diffusion-furry-3": { heavy: "Heavy", light: "Light", none: "None" },
  };
  return (id && maps[model]?.[id]) || null;
}

/**
 * 从提示词末尾剥离质量预设标签 (后端生成时会追加 "{提示词}, {预设标签}")。
 * 若末尾命中某预设标签, 返回剥离后的文本与预设名; 否则原样返回, preset=null。
 */
function stripQualityPresetFromEnd(text, model) {
  const map = (S && S.app && S.app.quality_preset_tags) ? (S.app.quality_preset_tags[model] || {}) : {};
  const entries = Object.entries(map).filter(([, tags]) => tags); // 去掉空标签 (None)
  entries.sort((a, b) => b[1].length - a[1].length); // 长标签优先, 避免部分匹配
  const t = String(text ?? "").trimEnd();
  for (const [preset, tags] of entries) {
    if (t === tags) return { text: "", preset }; // 整个就是标签
    const suffix = ", " + tags;
    if (t.endsWith(suffix)) {
      return { text: t.slice(0, t.length - suffix.length).trimEnd(), preset };
    }
  }
  return { text: t, preset: null };
}

/**
 * 从负面提示词开头剥离 UC 预设文本 (后端生成时会前置 "{预设文本}, {用户负面提示词}")。
 * 若开头命中某预设文本, 返回剥离后的文本与预设名; 否则原样返回, preset=null。
 * 同时兼容服务端 remove_nsfw 对 "nsfw, " 前缀的移除。
 */
function stripUCPresetFromStart(text, model) {
  const map = (S && S.app && S.app.uc_preset_tags) ? (S.app.uc_preset_tags[model] || {}) : {};
  const entries = Object.entries(map).filter(([, tags]) => tags);
  entries.sort((a, b) => b[1].length - a[1].length); // 长文本优先, 避免部分匹配
  const t = String(text ?? "");
  // 去掉文本开头连续的逗号/空白 (后端拼接预设与用户负面时产生的分隔符)
  const cutPrefix = (s) => {
    let i = 0;
    while (i < s.length && (s[i] === "," || s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r")) i++;
    return s.slice(i);
  };
  for (const [preset, tags] of entries) {
    // 尝试原始预设文本
    if (t.startsWith(tags)) return { text: cutPrefix(t.slice(tags.length)), preset };
    // 兼容 remove_nsfw: 预设以 "nsfw, " 开头时, 尝试去掉该前缀再匹配
    if (tags.startsWith("nsfw, ")) {
      const stripped = tags.slice(6);
      if (t.startsWith(stripped)) return { text: cutPrefix(t.slice(stripped.length)), preset };
    }
  }
  return { text: t, preset: null };
}

/**
 * 检测预设完整标签串是否出现在提示词的"添加位置", 是则从那里剥离一次。
 * 后端生成时: 正面质量预设追加 (append) 在提示词末尾, 负面 UC 预设前置 (prepend) 在开头,
 * 故 position: "tail" = 只允许文本末尾整段命中 (末尾只剥一次, 前面再重复出现也不动);
 *             "head" = 只允许文本开头整段命中 (同理)。非锚定位置出现相同标签不再视为命中。
 * 按逗号段整体匹配, 大小写/空格不敏感; 长预设优先, 避免前缀重叠误判;
 * 兼容 remove_nsfw (预设以 nsfw 开头而实际文本缺失该段)。
 * 剥离时按字符偏移从原文裁掉命中的那一段 (连同紧邻的逗号/空白/换行分隔符),
 * 其余文字保持读取时的原样 —— 换行、空格、权重符号等一概不重排、不重组。
 * 命中返回 { text: 剥离后原文, preset: 预设名 }; 未命中返回 { text: 原文.trim(), preset: null }。
 */
function extractPresetTags(text, model, tableKey, position) {
  const map = (S && S.app && S.app[tableKey]) ? (S.app[tableKey][model] || {}) : {};
  const entries = Object.entries(map).filter(([, tags]) => tags);
  entries.sort((a, b) => b[1].length - a[1].length); // 长标签优先
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
  const src = String(text ?? "");
  // 逗号切段并记录每段在原文中的字符区间; n 归一化用于匹配, 空段剔除但不影响锚定判断
  const parts = [];
  let cur = 0;
  for (const seg of src.split(",")) { parts.push({ s: cur, e: cur + seg.length }); cur += seg.length + 1; }
  const items = [];
  for (const p of parts) { const n = norm(src.slice(p.s, p.e)); if (n) items.push({ s: p.s, e: p.e, n }); }
  const isSep = (ch) => ch === "," || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  for (const [preset, tagsStr] of entries) {
    const want = tagsStr.split(",").map(norm).filter(Boolean);
    if (!want.length) continue;
    const variants = [want];
    if (want[0] === "nsfw" && want.length > 1) variants.push(want.slice(1));
    for (const w of variants) {
      if (w.length > items.length) continue;
      const start = position === "head" ? 0 : items.length - w.length;
      let hit = true;
      for (let k = 0; k < w.length; k++) { if (items[start + k].n !== w[k]) { hit = false; break; } }
      if (!hit) continue;
      // 双向吃掉紧邻分隔符 (逗号+空白/换行), 剩余原文逐字符保留
      let cutStart = items[start].s;
      while (cutStart > 0 && isSep(src[cutStart - 1])) cutStart--;
      let cutEnd = items[start + w.length - 1].e;
      while (cutEnd < src.length && isSep(src[cutEnd])) cutEnd++;
      return { text: src.slice(0, cutStart) + src.slice(cutEnd), preset };
    }
  }
  return { text: src.trim(), preset: null };
}

/** 把预设下拉切到指定预设: 仅当该预设在当前可选列表中时才切换, 返回是否切换成功 */
function applyPresetOption(sel, preset) {
  if (!preset || !sel || typeof sel.set !== "function") return false;
  const opts = sel.input && sel.input.options ? Array.from(sel.input.options).map((o) => o.value) : null;
  if (opts && !opts.includes(preset)) return false;
  sel.set(preset);
  return true;
}

function gridNearest(v) {
  const opts = [0.1, 0.3, 0.5, 0.7, 0.9];
  let best = 0, bestD = Infinity;
  opts.forEach((o, i) => { const d = Math.abs(o - v); if (d < bestD) { bestD = d; best = i; } });
  return best;
}

/** 角色中心点 (x,y, 0-1) -> 网格坐标 (A1-E5), 与后端 float_to_position 一致 */
function centerToGrid(x, y) {
  return String.fromCharCode(65 + gridNearest(x)) + (gridNearest(y) + 1);
}

/** 从 last.json 的 v4_prompt_positive/negative 恢复角色列表 */
function lastCharacters(p, model) {
  const pos = p?.v4_prompt_positive || [];
  const neg = p?.v4_prompt_negative || [];
  const nai5 = isNai5(model);
  return pos.map((c, i) => {
    const center = c.centers?.[0];
    let position = "C3";
    if (center && typeof center.x === "number" && typeof center.y === "number") {
      position = nai5 ? center.x.toFixed(2) + "," + center.y.toFixed(2) : centerToGrid(center.x, center.y);
    }
    return {
      prompt: c.char_caption ?? "",
      negative_prompt: neg[i]?.char_caption ?? "",
      position,
      enabled: true,
    };
  });
}

/** 启动时构建表单初始值: last.json (上次参数) 优先, 其次本地缓存 */
function buildSavedState() {
  const stored = S.store.load() || {};
  const p = S.app.last?.parameters || {};
  const model = S.app.model || stored.model || "nai-diffusion-4-5-full";
  // 上次的正面提示词末尾带有质量预设标签: 剥离末尾标签并据此识别预设; 未命中则预设为 Standard
  const rawPositive = p.v4_prompt?.caption?.base_caption || p.input || stored.positive_prompt || "";
  const positive = stripQualityPresetFromEnd(rawPositive, model);
  // 上次的负面提示词开头带有 UC 预设文本: 剥离开头预设并据此识别预设; 未命中则预设为 Heavy
  const rawNegative = p.negative_prompt || p.v4_negative_prompt?.caption?.base_caption || stored.negative_prompt || "";
  const negative = stripUCPresetFromStart(rawNegative, model);
  return {
    model,
    positive_prompt: positive.text,
    negative_prompt: negative.text,
    width: p.width ?? stored.width ?? 832,
    height: p.height ?? stored.height ?? 1216,
    steps: p.steps ?? stored.steps ?? 23,
    scale: p.scale ?? stored.scale ?? 5,
    cfg_rescale: p.cfg_rescale ?? stored.cfg_rescale ?? 0,
    seed: "-1", // 启动时种子设为随机, 不加载上次的种子
    sampler: p.sampler ?? stored.sampler ?? "k_euler",
    noise_schedule: p.noise_schedule ?? stored.noise_schedule ?? "karras",
    quality: positive.preset || "Standard",
    uc: negative.preset || (negative.text ? "None" : "Heavy"),
    quantity: stored.quantity ?? 1,
    furry_mode: stored.furry_mode ?? false,
    transparent_bg: stored.transparent_bg ?? false,
    ai_choice: p.use_coords != null ? !p.use_coords : (stored.ai_choice ?? true),
    variety: p.skip_cfg_above_sigma != null ? true : (stored.variety ?? false),
    decrisp: p.dynamic_thresholding ?? stored.decrisp ?? false,
    sm: p.autoSmea ?? stored.sm ?? false,
    sm_dyn: p.sm_dyn ?? stored.sm_dyn ?? false,
    legacy_uc: p.legacy_uc ?? stored.legacy_uc ?? false,
    enhance: stored.enhance ?? { enabled: false, amount: "1.5x", magnitude: 1 },
    characters: lastCharacters(p, model),
  };
}

// ---------------- Row1: 提示词 ----------------

/** 标题行右侧的小号预设下拉 */
function cornerSelect(labelText, options) {
  const select = el("select", { class: "corner-select" }, options.map((o) => el("option", { value: o, text: o })));
  const node = el("div", { class: "prompt-corner" }, [
    el("span", { class: "prompt-corner-label", text: labelText }),
    select,
  ]);
  return {
    node,
    input: select,
    get: () => select.value,
    set: (v) => { select.value = v; },
    setOptions: (opts) => {
      const cur = select.value;
      select.innerHTML = "";
      for (const o of opts) select.append(el("option", { value: o, text: o }));
      if (opts.includes(cur)) select.value = cur;
    },
  };
}

/** 胶囊单选组 (如 AI's Choice / Custom): 返回 {node, get, set} */
function segChoice(options, value, onChange = null) {
  const group = el("div", { class: "opt-group" });
  const items = {};
  options.forEach((o) => {
    const item = el("label", { class: "opt-item" + (o === value ? " selected" : ""), text: o });
    item.addEventListener("click", () => {
      Object.values(items).forEach((x) => x.classList.remove("selected"));
      item.classList.add("selected");
      if (onChange) onChange(o);
    });
    group.append(item);
    items[o] = item;
  });
  return {
    node: group,
    get: () => options.find((o) => items[o].classList.contains("selected")) || options[0],
    set: (o) => {
      if (!items[o]) return;
      Object.values(items).forEach((x) => x.classList.remove("selected"));
      items[o].classList.add("selected");
    },
  };
}

/** 提示词输入框高度自适应: 最小 6 行, 最大 15 行, 超出滚动 */
function autosizeRows(ta, { minRows = 6, maxRows = 15 } = {}) {
  const fit = () => {
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 20;
    const extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const min = minRows * lh + extra;
    const max = maxRows * lh + extra;
    ta.style.height = "auto";
    const h = Math.min(max, Math.max(min, ta.scrollHeight));
    ta.style.height = h + "px";
    ta.style.overflowY = ta.scrollHeight > max + 1 ? "auto" : "hidden";
  };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return fit;
}

/** 提示词输入块: 节标题(左) + 右侧按钮组(Wildcards/预设等) + 多行输入框 (高度 6~15 行自适应) */
function promptField(title, presetCtl, opts) {
  const wrap = el("div", { class: "field prompt-field" });
  const ta = el("textarea", { rows: 6, placeholder: opts.placeholder || "", value: opts.value ?? "" });
  const fit = autosizeRows(ta);
  const head = el("div", { class: "prompt-head" }, [
    el("span", { class: "prompt-title", text: title }),
    el("div", { class: "prompt-head-right" }, [
      opts.loadBtn || null,
      wildcardsButton(ta, { title, text: "🃏 Wildcards" }),
      opts.tbBtn || null,
      presetCtl.node,
    ]),
  ]);
  const taBox = el("div", { class: "ta-box" }, [ta]);
  wrap.append(head, taBox);
  wireAutocomplete(ta, taBox);
  return { node: wrap, input: ta, get: () => ta.value, set: (v) => { ta.value = v; fit(); }, refit: fit };
}

function buildPromptCard(saved) {
  const card = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, ["📝 提示词", el("span", { class: "badge", text: "支持 wildcards" })]),
  ]);

  C.quality = cornerSelect("⭐ 正面预设", S.app.qp_presets || []);
  C.quality.set(saved.quality ?? "Standard");
  const loadPosBtn = el("button", { class: "mini-btn", type: "button", text: "🔁 加载上次", title: "载入上次生成的正面提示词" });
  loadPosBtn.addEventListener("click", async () => {
    try {
      const last = await fetchLast();
      const text = last?.parameters?.v4_prompt?.caption?.base_caption || last?.input || "";
      if (text) {
        // 末尾若含质量预设标签则剥离并同步预设; 不含则预设为 Standard
        const stripped = stripQualityPresetFromEnd(text, C.model.get());
        C.positive.set(stripped.text);
        const preset = stripped.preset || "Standard";
        if ((S.app.qp_presets || []).includes(preset)) C.quality.set(preset);
        toast("已加载上次正面提示词 ✅", "success");
      }
      else toast("没有找到上次的正面提示词", "warning");
    } catch (e) { toast(e.message, "error"); }
  });
  transparentBg = !!saved.transparent_bg;
  tbBtn = el("button", { class: "mini-btn tb-btn", type: "button", text: "🪟 Transparent BG", title: "仅 v5 模型可用: 开启后生成时在提示词末尾追加 transparent background (质量预设之前)" });
  tbBtn.addEventListener("click", () => { transparentBg = !transparentBg; updateTbBtn(); });
  updateTbBtn();
  C.positive = promptField("✨ 正面提示词", C.quality, { value: saved.positive_prompt ?? "", placeholder: "在此输入正面提示词...", rows: 6, loadBtn: loadPosBtn, tbBtn });
  card.append(C.positive.node);

  C.uc = cornerSelect("🚫 负面预设", S.app.uc_presets || []);
  C.uc.set(saved.uc ?? "Heavy");
  const loadNegBtn = el("button", { class: "mini-btn", type: "button", text: "🔁 加载上次", title: "载入上次生成的负面提示词" });
  loadNegBtn.addEventListener("click", async () => {
    try {
      const last = await fetchLast();
      const text = last?.parameters?.negative_prompt || last?.parameters?.v4_negative_prompt?.caption?.base_caption || "";
      if (text) {
        // 开头若含 UC 预设文本则剥离并同步预设; 不含则预设为 Heavy
        const stripped = stripUCPresetFromStart(text, C.model.get());
        C.negative.set(stripped.text);
        const preset = stripped.preset || (stripped.text ? "None" : "Heavy");
        if ((S.app.uc_presets || []).includes(preset)) C.uc.set(preset);
        toast("已加载上次负面提示词 ✅", "success");
      }
      else toast("没有找到上次的负面提示词", "warning");
    } catch (e) { toast(e.message, "error"); }
  });
  C.negative = promptField("🌙 负面提示词", C.uc, { value: saved.negative_prompt ?? "", placeholder: "在此输入负面提示词...", rows: 6, loadBtn: loadNegBtn });
  card.append(C.negative.node);
  return card;
}
/** 当前输出查看器的键盘翻页监听器 (每次重建查看器时先摘掉上一个, 避免多代监听器同时触发) */
let outputViewerOnKey = null;

/** 构建输出图片查看器: 单图显示 + 左右切换 + 下方缩略图导航 */
function buildOutputViewer(container, images) {
  clear(container);
  if (outputViewerOnKey) { document.removeEventListener("keydown", outputViewerOnKey); outputViewerOnKey = null; }
  container.classList.remove("gallery", "count-1", "count-2", "count-3", "count-4");
  container.classList.add("output-viewer");
  if (!images || images.length === 0) {
    container.append(el("div", { class: "gallery-empty", text: "🌸 还没有图片, 去生成一张吧~" }));
    return;
  }

  let idx = 0;
  const mainImg = el("img", { class: "output-viewer-img", alt: "输出图片" });
  const mainWrap = el("div", { class: "output-viewer-main" });
  const prevBtn = el("button", { class: "output-viewer-nav output-viewer-prev", type: "button", html: "‹", title: "上一张" });
  const nextBtn = el("button", { class: "output-viewer-nav output-viewer-next", type: "button", html: "›", title: "下一张" });
  mainWrap.append(prevBtn, nextBtn, mainImg);
  container.append(mainWrap);

  // 缩略图条
  const thumbStrip = el("div", { class: "output-viewer-thumbs" });
  const thumbs = images.map((path, i) => {
    const t = el("div", { class: "thumb-item" + (i === 0 ? " active" : "") }, [
      el("img", { src: imageUrl(path), loading: "lazy", alt: "第 " + (i + 1) + " 张" }),
    ]);
    t.addEventListener("click", () => { idx = i; updateView(); });
    thumbStrip.append(t);
    return t;
  });
  container.append(thumbStrip);
  // 启用 edgeScroll 悬停自动滚动, 支持缩略图条左右滚动
  try { edgeScroll(thumbStrip); } catch {}

  // 自动翻页 (悬停左右边缘)
  let autoTimer = null;
  let autoDelay = null;
  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (autoDelay) { clearTimeout(autoDelay); autoDelay = null; }
    mainWrap.classList.remove("auto-flip-left", "auto-flip-right");
  }
  function startAuto(dir) {
    stopAuto();
    mainWrap.classList.add(dir < 0 ? "auto-flip-left" : "auto-flip-right");
    autoDelay = setTimeout(() => {
      autoTimer = setInterval(() => { idx = (idx + dir + images.length) % images.length; updateView(); }, 2500);
    }, 1500);
  }
  prevBtn.addEventListener("click", (e) => { e.stopPropagation(); stopAuto(); idx = (idx - 1 + images.length) % images.length; updateView(); });
  prevBtn.addEventListener("mouseenter", () => startAuto(-1));
  prevBtn.addEventListener("mouseleave", stopAuto);
  nextBtn.addEventListener("click", (e) => { e.stopPropagation(); stopAuto(); idx = (idx + 1) % images.length; updateView(); });
  nextBtn.addEventListener("mouseenter", () => startAuto(1));
  nextBtn.addEventListener("mouseleave", stopAuto);
  // 悬停在主图左右各 30% 区域也触发自动翻页 (与箭头按钮联动), 点击直接切换
  mainWrap.addEventListener("click", (e) => {
    const rect = mainWrap.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    if (rel < 0.3) { stopAuto(); idx = (idx - 1 + images.length) % images.length; updateView(); }
    else if (rel > 0.7) { stopAuto(); idx = (idx + 1) % images.length; updateView(); }
  });
  mainWrap.addEventListener("mouseenter", (e) => {
    const rect = mainWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const rel = x / rect.width;
    if (rel < 0.3) startAuto(-1);
    else if (rel > 0.7) startAuto(1);
  });
  mainWrap.addEventListener("mousemove", (e) => {
    const rect = mainWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const rel = x / rect.width;
    if (!autoTimer && !autoDelay) {
      mainWrap.classList.toggle("auto-flip-left", rel < 0.3);
      mainWrap.classList.toggle("auto-flip-right", rel > 0.7);
    }
  });
  mainWrap.addEventListener("mouseleave", stopAuto);

  function updateView() {
    const path = images[idx];
    mainImg.src = imageUrl(path);
    mainImg.alt = "第 " + (idx + 1) + " / " + images.length + " 张";
    thumbs.forEach((t, i) => t.classList.toggle("active", i === idx));
    setOutputSelection(path);
  }

  // 键盘左右键切换输出图片:
  //   - 焦点在输入框/文本域/下拉/富文本内时完全不拦截, 保留光标移动与选择 (修复: 生成多图后提示词里方向键变成翻页)
  //   - Ctrl/Alt/Meta 组合键与已被其它处理器消费的事件也放行
  const onKey = (e) => {
    if (!container.isConnected) {
      document.removeEventListener("keydown", onKey);
      if (outputViewerOnKey === onKey) outputViewerOnKey = null;
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    const t = e.target;
    if (t instanceof Element && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") { idx = (idx - 1 + images.length) % images.length; updateView(); e.preventDefault(); }
    else if (e.key === "ArrowRight") { idx = (idx + 1) % images.length; updateView(); e.preventDefault(); }
  };
  outputViewerOnKey = onKey;
  document.addEventListener("keydown", onKey);

  // 单击主图放大 (单图时不设热区; 多图时左右 30% 翻页热区仍交给 mainWrap 翻页, 避免放大与翻页同时触发)
  mainImg.addEventListener("click", async (e) => {
    if (images.length > 1) {
      const rect = mainWrap.getBoundingClientRect();
      const rel = (e.clientX - rect.left) / rect.width;
      if (rel < 0.3 || rel > 0.7) return;
    }
    setOutputSelection(images[idx]);
    const { openLightbox } = await import("../components.js");
    openLightbox(imageUrl(images[idx]), "第 " + (idx + 1) + " 张");
  });

  // 预加载相邻图片
  function preloadAdjacent() {
    [-1, 0, 1].forEach((offset) => {
      const i = (idx + offset + images.length) % images.length;
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "image";
      link.href = imageUrl(images[i]);
      document.head.append(link);
      setTimeout(() => link.remove(), 5000);
    });
  }
  preloadAdjacent();

  updateView();
}


/** 工具条: 左=生图模型+Mode, 右=生成数量+开始/停止 */
/** 更新 furry 按钮文本 (用显式状态, 不依赖 textContent: Twemoji 会把 emoji 换成 <img>) */
function updateFurryBtn() {
  furryBtn.textContent = furryMode ? "🐾 Mode: Furry" : "🌸 Mode: Anime";
}

/** Transparent BG 按钮状态: 文案固定, 仅用激活样式 (.tb-on 主色高亮) 表示开/关 */
function updateTbBtn() {
  if (!tbBtn) return;
  tbBtn.classList.toggle("tb-on", transparentBg);
}

/** 生成请求专用: 开关开启且当前为 v5 模型时, 在用户提示词末尾追加 transparent background
 *  (后端随后才拼质量预设, 最终顺序 = furry 前缀 + 用户输入 + transparent background + 预设) */
function promptWithTransparent() {
  const base = String((C.positive && C.positive.get()) || "");
  if (!transparentBg || !isNai5(C.model.get())) return base;
  const norm = base.trimEnd();
  if (!norm.trim()) return "transparent background";
  if (/(?:transparency|transparent background)\s*$/i.test(norm)) return norm; // 末尾已有同类标签则不重复追加
  return norm + ", transparent background";
}

/** 导入正面提示词时反向同步: 含有 transparent background 标签 (生成时由 Transparent BG 开关写入)
 *  → 从文本剥离并开启开关; 不含 → 关闭开关。整段精确匹配 (大小写/首尾空格不敏感),
 *  其余分段逐字保留 (含换行), 重组时只吸掉被删段自己的逗号 */
function syncTransparentBg(text) {
  const parts = String(text ?? "").split(",");
  const keep = [];
  let found = false;
  for (const p of parts) {
    if (p.trim().toLowerCase() === "transparent background") found = true;
    else keep.push(p);
  }
  transparentBg = found;
  updateTbBtn();
  return found ? keep.join(",").trim() : String(text ?? "").trim();
}

function buildModelBar(bar, saved) {
  C.model = field("🧬 生图模型", "select", { options: S.app.models, value: saved.model ?? S.app.model });
  furryMode = !!saved.furry_mode;
  furryBtn = el("button", { class: "btn btn-sm mode-btn", text: "🌸 Mode: Anime" });
  furryBtn.style.whiteSpace = "nowrap";
  furryBtn.addEventListener("click", () => {
    furryMode = !furryMode;
    updateFurryBtn();
  });
  updateFurryBtn();

  C.quantity = field("🔢 生成数量", "slider", { min: 1, max: 999, step: 1, value: saved.quantity ?? 1 });
  C.quantity.node.classList.add("mb-quantity");

  C.generateBtn = el("button", { class: "btn btn-primary btn-lg", text: "🚀 开始生成" });
  C.stopBtn = el("button", { class: "btn btn-danger btn-lg", text: "⏹ 停止" });
  C.stopBtn.title = "停止生成";

  bar.append(
    C.model.node,
    furryBtn,
    el("span", { class: "mb-divider" }),
    el("span", { class: "mb-flex" }),
    C.quantity.node,
    C.generateBtn,
    C.stopBtn,
  );
}

// ---------------- Row2 左: 页签 ----------------

/** nai3 风格迁移编辑器: 图片放左半 (支持拖拽), 信息/画风强度放右半左对齐。 */
function buildVibeEditor(container) {
  const items = []; // {node, dz, info, style}
  const state = { count: 0 };
  const max = 10;
  function createItem(idx) {
    const dz = imageDropZone({ label: "参考图 #" + (idx + 1), placeholder: "点击选择或拖入图片", native: true });
    const info = sliderRow({ min: 0, max: 1, step: 0.01, value: 1 });
    const style = sliderRow({ min: 0, max: 1, step: 0.01, value: 0.6 });
    const item = el("div", { class: "vibe-item" }, [
      el("div", { class: "vibe-left" }, [dz.node]),
      el("div", { class: "vibe-right" }, [
        el("div", { class: "field" }, [el("label", { text: "信息提取强度" }), info.node]),
        el("div", { class: "field" }, [el("label", { text: "画风参考强度" }), style.node]),
      ]),
    ]);
    return { node: item, dz, info, style };
  }
  function render() {
    // 先保存当前各参考图的值 (图片/强度), 重建后恢复, 避免添加/删除导致已添加的图片丢失
    const saved = items.map((it) => ({ path: it.dz.get(), info: it.info.get(), style: it.style.get() }));
    clear(container);
    items.length = 0;
    const btnRow = el("div", { style: "display:flex;gap:8px;margin-bottom:10px;" }, [
      el("button", { class: "btn btn-sm", text: "➕ 添加参考图", onclick: () => { if (state.count < max) { state.count++; render(); } else toast("最多 " + max + " 张", "warning"); } }),
      el("button", { class: "btn btn-sm btn-ghost", text: "➖ 删除", onclick: () => { if (state.count > 0) { state.count--; render(); } } }),
    ]);
    container.append(btnRow);
    for (let i = 0; i < state.count; i++) {
      const it = createItem(i);
      const v = saved[i];
      if (v) {
        if (v.path) it.dz.set(v.path);
        it.info.set(v.info);
        it.style.set(v.style);
      }
      items.push(it);
      container.append(it.node);
    }
  }
  render();
  return {
    getItems: () => items.map((it) => ({ path: it.dz.get(), information_strength: it.info.get(), style_strength: it.style.get() })),
    setItems: (arr) => {
      state.count = Math.min(max, arr.length);
      render();
      arr.forEach((v, i) => {
        const it = items[i];
        if (!it) return;
        if (v.path) it.dz.set(v.path);
        if (v.information_strength != null) it.info.set(v.information_strength);
        if (v.style_strength != null) it.style.set(v.style_strength);
      });
    },
  };
}

function buildLeftTabs(saved) {
  const wrap = el("div");

  // 页签栏 (Wildcards 已移至各提示词输入框右上角的按钮, 点击弹全屏窗口)
  const tabs = [
    { id: "params", title: "🎛️ 参数设置" },
    { id: "characters", title: "👥 角色分区" },
    { id: "references", title: "🧑‍🎨 角色参考" },
    { id: "vibe", title: "🎭 风格迁移" },
  ];
  const bar = el("div", { class: "tabs" });
  const bodies = [];
  tabBtns = {};
  tabBodies = {};
  tabs.forEach((t, i) => {
    const btn = el("button", { class: "tab-btn" + (i === 0 ? " active" : ""), text: t.title, onclick: () => {
      [...bar.children].forEach((b) => b.classList.remove("active"));
      bodies.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      bodies[i].classList.add("active");
      // 切到角色分区时刷新位置选择器尺寸 (隐藏时测量的宽度为 0)
      if (t.id === "characters") charRegion?.refresh?.();
    }});
    tabBtns[t.id] = btn;
    bar.append(btn);
    const tbody = el("div", { class: "tab-content" + (i === 0 ? " active" : "") });
    tabBodies[t.id] = tbody;
    bodies.push(tbody);
  });
  wrap.append(edgeScroll(bar));

  // 1. 参数设置
  buildParamsTab(bodies[0], saved);

  // 2. 角色分区
  charSection = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["👥 角色分区"]),
  ]);
  const charWrap = el("div");
  // 位置模式: AI's Choice / Custom (添加足够角色后才显示)
  aiChoiceRow = el("div", { class: "field" }, [el("label", { text: "🤖 位置模式" })]);
  C.aiChoice = segChoice(["AI's Choice", "Custom"], saved.ai_choice ? "AI's Choice" : "Custom", () => updateAiChoiceVisibility());
  aiChoiceRow.append(C.aiChoice.node);
  aiChoiceRow.style.display = "none";
  charSection.append(aiChoiceRow);
  // 共享区域选择器: 所有角色共用一块与分辨率同比例的区域, 点击或拖动放置
  const getCharSize = () => ({ w: Number(C.width.get()) || 832, h: Number(C.height.get()) || 1216 });
  charRegion = characterRegionPicker({ getSize: getCharSize });
  charSection.append(charRegion.node);
  charList = roleList(charWrap, {
    title: "角色",
    max: 32,
    selectable: true,
    // "启用"复选框放到头部, 与"角色 #n"并排
    headCheckbox: { id: "enabled", label: "启用", default: true },
    fields: [
      { id: "prompt", label: "✨ 正面提示词", type: "textarea", rows: 2 },
      { id: "negative_prompt", label: "🌙 负面提示词", type: "textarea", rows: 2 },
    ],
    onSelect: (i) => charRegion.select(i),
    onChange: (count) => {
      charRegion.setCount(count);
      updateAiChoiceVisibility();
    },
  });
  charSection.append(charWrap);
  bodies[1].append(charSection);

  // 3. 角色参考
  refSection = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["🧑‍🎨 角色参考", el("span", { class: "badge", text: "每张图片消耗 5 点数" })]),
  ]);
  const refWrap = el("div");
  refList = roleList(refWrap, {
    title: "参考角色",
    max: 10,
    // 两栏布局: 左列 参考图(占前两行)+模式(最下行); 右列 启用+Strength+Fidelity 自上而下
    grid: [
      { id: "path", r: 1, c: 1, rs: 2 },
      { id: "enabled", r: 1, c: 2 },
      { id: "strength", r: 2, c: 2 },
      { id: "mode", r: 3, c: 1 },
      { id: "fidelity", r: 3, c: 2 },
    ],
    fields: [
      { id: "path", label: "🖼️ 参考图", type: "image" },
      { id: "enabled", label: "启用", type: "checkbox", default: true },
      { id: "strength", label: "Strength", type: "slider", min: 0, max: 1, step: 0.05, default: 1 },
      { id: "fidelity", label: "Fidelity", type: "slider", min: 0, max: 1, step: 0.05, default: 1 },
      { id: "mode", label: "模式", type: "select", options: S.app.cr_modes, default: "character&style" },
    ],
    onChange: () => updateVibeVisibility(),
  });
  refSection.append(refWrap);
  bodies[2].append(refSection);

  // 4. 风格迁移
  vibeBundleRow = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["🎭 风格迁移 (Vibe)"]),
  ]);
  C.vibeBundle = fileDropZone({
    label: "📦 *.naiv4vibebundle 文件",
    placeholder: "点击选择或拖入 .naiv4vibebundle 文件",
    accept: ".naiv4vibebundle,.json",
    onChange: () => updateRefVisibility(),
  });
  C.vibeNormalize = field("🔁 Normalize Reference Strength", "checkbox", { value: true });
  vibeBundleRow.append(C.vibeBundle.node, C.vibeNormalize.node);

  nai3VibeRow = el("div", { class: "card hidden", style: "margin:0;margin-top:10px;" }, [
    el("div", { class: "card-title" }, ["🎭 风格迁移 (Vibe)"]),
  ]);
  const vibeWrap = el("div");
  vibeList = buildVibeEditor(vibeWrap);
  nai3VibeRow.append(vibeWrap);
  bodies[3].append(vibeBundleRow, nai3VibeRow);

  // 关键: 把页签内容插入 DOM
  wrap.append(...bodies);

  return wrap;
}

function buildParamsTab(body, saved) {
  const card = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["🎛️ 参数设置"]),
  ]);

  // 分辨率
  const resRow = el("div", { class: "field-row" });
  C.resolution = field("📐 分辨率预设", "select", { options: [...S.app.resolutions, "自定义"] });
  C.width = field("📏 宽", "number", { value: saved.width ?? 832 });
  C.height = field("📏 高", "number", { value: saved.height ?? 1216 });
  const w0 = saved.width ?? 832, h0 = saved.height ?? 1216;
  C.resolution.set(S.app.resolutions.includes(w0 + "x" + h0) ? w0 + "x" + h0 : "自定义");
  resRow.append(C.resolution.node, C.width.node, C.height.node);
  card.append(resRow);
  // 像素数提示: 超过 1536×2048 时标红 (提交前仍会再拦一次)
  resHintEl = el("div", { class: "muted", style: "margin:-6px 0 10px;font-size:12px;" });
  card.append(resHintEl);
  updateResHint();

  // 采样
  const samplerRow = el("div", { class: "field-row" });
  C.sampler = field("🧪 采样器", "select", { options: S.app.samplers, value: saved.sampler ?? "k_euler" });
  C.noise = field("📈 调度器", "select", { options: S.app.noise_schedules, value: saved.noise_schedule ?? "karras" });
  samplerRow.append(C.sampler.node, C.noise.node);
  card.append(samplerRow);

  // 数值
  const numRow = el("div", { class: "grid grid-3" });
  C.steps = field("👣 采样步数", "slider", { min: 1, max: 50, step: 1, value: saved.steps ?? 23 });
  C.scale = field("🎯 指导系数", "slider", { min: 0, max: 10, step: 0.1, value: saved.scale ?? 5 });
  C.cfgRescale = field("🔄 重采样系数", "slider", { min: 0, max: 1, step: 0.02, value: saved.cfg_rescale ?? 0 });
  numRow.append(C.steps.node, C.scale.node, C.cfgRescale.node);
  card.append(numRow);

  // 种子
  const seedRow = el("div", { class: "field-row" });
  C.seed = field("🌱 种子", "text", { value: saved.seed ?? "-1" });
  const lastSeedBtn = el("button", { class: "mini-btn", text: "♻️ 上次" });
  const randomSeedBtn = el("button", { class: "mini-btn", text: "🎲 随机" });
  lastSeedBtn.addEventListener("click", async () => {
    try {
      const last = await fetchLast();
      const seed = last?.parameters?.seed;
      if (seed != null) { C.seed.set(String(seed)); toast("已加载上次的种子 ♻️", "success"); }
      else toast("没有找到上次的种子", "warning");
    } catch (e) { toast(e.message, "error"); }
  });
  randomSeedBtn.addEventListener("click", () => C.seed.set("-1"));
  seedRow.append(C.seed.node, lastSeedBtn, randomSeedBtn);
  card.append(seedRow);

  // 开关
  const toggles = el("div", { class: "grid grid-4" });
  C.variety = field("🎲 Variety+", "checkbox", { value: saved.variety ?? false });
  C.decrisp = field("💠 Decrisp", "checkbox", { value: saved.decrisp ?? false });
  C.sm = field("🪄 SMEA", "checkbox", { value: saved.sm ?? false });
  C.smDyn = field("🌊 DYN", "checkbox", { value: saved.sm_dyn ?? false });
  C.legacyUc = field("📜 Legacy UC", "checkbox", { value: saved.legacy_uc ?? false });
  toggles.append(C.variety.node, C.decrisp.node, C.sm.node, C.smDyn.node, C.legacyUc.node);
  card.append(toggles);

  // Enhance
  enhanceRow = el("div", { style: "margin-top:12px;" }, [el("div", { class: "card-title", text: "✨ Enhance 增强" })]);
  C.enhance = field("启用 Enhance", "checkbox", { value: saved.enhance?.enabled ?? false });
  // 放大倍数: 1x / 1.5x; Max 仅 v5 系列 (保持纵横比放大到 1536×2048 面积上限)
  const enhanceAmountOpts = enhanceAmounts(C.model.get());
  C.enhanceAmount = field("放大倍数", "select", {
    options: enhanceAmountOpts,
    value: normalizeEnhanceAmount(saved.enhance?.amount, enhanceAmountOpts),
  });
  C.enhanceAmount.input.title = "Max 仅 v5 系列模型可选: 保持纵横比放大到 1536×2048 的面积上限 (宽高均为 64 的倍数)";
  C.magnitude = field("强度", "slider", { min: 1, max: 5, step: 1, value: saved.enhance?.magnitude ?? 1 });
  const enRow = el("div", { class: "field-row" });
  enRow.append(C.enhance.node, C.enhanceAmount.node, C.magnitude.node);
  enhanceRow.append(enRow);
  card.append(enhanceRow);
  // 不勾选 Enhance 时隐藏 放大倍数/强度
  function toggleEnhance() {
    const show = C.enhance.get();
    C.enhanceAmount.node.style.display = show ? "" : "none";
    C.magnitude.node.style.display = show ? "" : "none";
  }
  C.enhance.input.addEventListener("change", toggleEnhance);
  toggleEnhance();

  // 图生图 / 重绘
  const inpaintTitle = el("div", { class: "card-title", style: "margin-top:14px;", text: "🎨 图生图 / 局部重绘 / 涂鸦重绘" });
  const editorWrap = el("div");
  editor = imageEditor(editorWrap, {
    onChange: () => updateInpaintVisibility(),
    // 上传基础图片后: 分辨率自动改为图片尺寸最接近的 64 倍数
    onImageLoad: (img) => {
      const w = round64(img.naturalWidth || img.width);
      const h = round64(img.naturalHeight || img.height);
      C.width.set(w);
      C.height.set(h);
      syncResolution();
      toast(`📐 分辨率已随图片对齐: ${w} × ${h}`, "info");
    },
  });
  inpaintCtlRow = el("div", { class: "grid grid-3 hidden", style: "margin-top:12px;" });
  C.inpaintStrength = field("💪 强度", "slider", { min: 0.01, max: 0.99, step: 0.01, value: 0.7 });
  C.inpaintNoise = field("🌫️ 噪声", "slider", { min: 0, max: 0.99, step: 0.01, value: 0 });
  C.maskStrength = field("🧩 Mask Strength", "slider", { min: 0.01, max: 1, step: 0.01, value: 1 });
  inpaintCtlRow.append(C.inpaintStrength.node, C.inpaintNoise.node, C.maskStrength.node);
  card.append(inpaintTitle, editorWrap, inpaintCtlRow);

  body.append(card);
}

// ---------------- Row2 右: 输出 ----------------

function buildRightPanel() {
  // 剩余点数/用量: 下拉徽标 (多 Token 时避免标题行文本过长溢出, 点击展开选择查看的 Token)
  anlasWrapEl = el("div", { class: "anlas-wrap" });
  anlasBadgeEl = el("button", { class: "badge anlas-badge", id: "anlas-badge", type: "button", title: "剩余点数 / 用量" }, "点数: --");
  anlasMenuEl = el("div", { class: "anlas-menu" });
  anlasMenuEl.hidden = true;
  anlasWrapEl.append(anlasBadgeEl, anlasMenuEl);
  anlasBadgeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAnlasMenu();
  });
  anlasMenuEl.addEventListener("click", (e) => {
    const item = e.target.closest(".anlas-item");
    if (!item) return;
    anlasSelected = Number(item.dataset.idx) || 0;
    toggleAnlasMenu(false);
    updateAnlasBadge();
  });
  if (!anlasOutsideBound) {
    anlasOutsideBound = true;
    document.addEventListener("click", (e) => {
      if (anlasWrapEl && !anlasWrapEl.contains(e.target)) toggleAnlasMenu(false);
    });
  }
  // 紧挨徽标右侧的「刷新」按钮 (同一行、最右边): 手动重查剩余点数/用量
  anlasRefreshBtn = el("button", {
    class: "btn btn-sm anlas-refresh",
    id: "anlas-refresh",
    type: "button",
    text: "🔄 刷新",
    title: "立即重新查询剩余点数 / 用量 (会真实请求 NovelAI)",
  });
  anlasRefreshBtn.addEventListener("click", refreshAnlasNow);
  const card = el("div", { class: "card", style: "min-height:400px;display:flex;flex-direction:column;" }, [
    el("div", { class: "card-title" }, [
      "🖼️ 输出图片",
      anlasWrapEl,
      anlasRefreshBtn,
    ]),
  ]);
  genGalleryEl = el("div", { class: "gallery", style: "flex:1;" });
  // 两个"发送"按钮放在同一行, 右侧留出"打开保存目录"按钮
  sendBtn = el("button", { class: "btn btn-sm hidden", text: "📤 发送到图生图" });
  sendPnginfoBtn = el("button", { class: "btn btn-sm hidden", text: "🔮 发送到法术解析" });
  openDirBtn = el("button", { class: "btn btn-sm", text: "📁 打开保存目录", title: "在文件管理器中打开图片保存目录" });
  const btnRow = el("div", { class: "output-actions" }, [
    sendBtn,
    sendPnginfoBtn,
    el("span", { class: "spacer" }),
    openDirBtn,
  ]);
  infoEl = el("div", { class: "info-box", style: "margin-top:10px;" });
  card.append(genGalleryEl, btnRow, infoEl);
  return card;
}

/**
 * 点「刷新」: 让后端真实重查一遍全部 Token, 再重画徽标。
 * 徽标平时只在启动查询完成、生成结束或后端推送 anlas:update 时更新 —— 想立刻看到最新值就点它。
 * 查询期间按钮禁用并显示"刷新中…", 防重复点击 (后端那次查询是同步的, 要走完外部 HTTP)。
 */
async function refreshAnlasNow() {
  const btn = anlasRefreshBtn || document.getElementById("anlas-refresh");
  if (!btn || btn.disabled) return;
  const label = "🔄 刷新";
  btn.disabled = true;
  btn.textContent = "⏳ 刷新中…";
  try {
    // 必须打 /api/anlas/refresh: /api/anlas 只回缓存快照, 点多少次都刷不出新值
    const data = await post("/api/anlas/refresh");
    await updateAnlasBadge();
    const list = Array.isArray(data?.tokens) ? data.tokens : [];
    if (!list.length) {
      toast("未配置 Token, 无法查询剩余点数 / 用量", "warning");
    } else if (!list.some((t) => Number(t.anlas) >= 0)) {
      toast("刷新完成, 但仍未查询到点数 —— 检查设置里的「⚡ 跳过剩余点数/用量计算」或 Token 是否有效", "warning");
    } else {
      toast(`剩余点数 / 用量已刷新 (${list.length} 个 Token)`, "success");
    }
  } catch (e) {
    toast("刷新剩余点数失败: " + (e?.message || e), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 展开/收起剩余点数/用量下拉面板 (force 省略时切换) */
function toggleAnlasMenu(force) {
  if (!anlasMenuEl) return;
  const open = force !== undefined ? force : anlasMenuEl.hidden;
  anlasMenuEl.hidden = !open;
  anlasBadgeEl?.classList.toggle("open", open);
  if (open) updateAnlasBadge();
}

/** 刷新右上角"剩余点数/用量"下拉徽标 (启动时查询全部 Token, 生成结束与页面加载时更新, 生成后仅本次所用 Token 变化) */
let anlasRetryTimer = 0;
let anlasRetryCount = 0;
function anlasEntryText(t) {
  const a = Number(t.anlas);
  const r = Number(t.remains);
  const ok = Number.isFinite(a) && Number.isFinite(r) && a >= 0;
  const name = t.token || "Token";
  return ok ? `${name} · 点数: ${a} · 用量: ${r}%` : `${name} · 未查询到`;
}

/** 下拉行: 订阅状态 emoji (本地 Twemoji 资源 ✅/❌, 跨设备显示一致) */
function anlasStatusText(t) {
  if (t.active === true) return "✅";   // 2705.svg
  if (t.active === false) return "❌";  // 274c.svg
  return "·";                           // 尚未查询到
}

/** 下拉行: "下次恢复1%: x.xx 小时" (秒 -> 小时, 保留两位小数) */
function anlasRecoverText(t) {
  const s = Number(t.recover_seconds);
  if (!Number.isFinite(s) || s < 0) return "下次恢复1%: --";
  return `下次恢复1%: ${(s / 3600).toFixed(2)} 小时`;
}

async function updateAnlasBadge() {
  try {
    const res = await fetch("/api/anlas");
    const data = await res.json();
    const badge = anlasBadgeEl || document.getElementById("anlas-badge");
    if (!badge) return;
    const list = Array.isArray(data.tokens) ? data.tokens : [];
    if (!list.length) {
      badge.textContent = "点数: --";
      badge.title = "未配置 Token, 无法查询剩余点数 / 用量";
      if (anlasMenuEl) anlasMenuEl.replaceChildren();
      return;
    }
    // 启动查询尚未完成 (全部为 -1 哨兵值): 短暂自动重试; 查询完成后后端也会推送 anlas:update 主动刷新
    const ready = list.some((t) => Number(t.anlas) >= 0);
    if (ready) {
      if (anlasRetryTimer) { clearTimeout(anlasRetryTimer); anlasRetryTimer = 0; }
      anlasRetryCount = 0;
    } else if (anlasRetryCount < 10) {
      anlasRetryCount++;
      if (!anlasRetryTimer) {
        anlasRetryTimer = setTimeout(() => { anlasRetryTimer = 0; updateAnlasBadge(); }, 3000);
      }
    }
    // 徽标只显示当前选中的 Token (多 Token 时避免文本溢出, 下拉面板内查看全部)
    const cur = list.find((t) => (t.index ?? 0) === anlasSelected) || list[0];
    anlasSelected = cur.index ?? 0;
    badge.textContent = `${anlasStatusText(cur)} ${anlasEntryText(cur)}`;
    badge.title = list.length > 1
      ? "点击选择查看的 Token (启动时查询全部, 生成后只更新本次所用 Token)"
      : "剩余点数 / 用量 (启动时查询, 生成后只更新本次所用 Token)";
    if (!anlasMenuEl) return;
    anlasMenuEl.replaceChildren(
      ...list.map((t) => {
        const item = el("div", { class: "anlas-item" + ((t.index ?? 0) === anlasSelected ? " active" : "") }, [
          el("span", { class: "anlas-status", text: anlasStatusText(t), title: t.active === true ? "订阅有效" : t.active === false ? "订阅无效/未激活" : "尚未查询" }),
          el("span", { class: "anlas-item-name", text: t.token || "Token" }),
          el("span", { class: "anlas-item-val", text: (Number.isFinite(Number(t.anlas)) && Number(t.anlas) >= 0 ? `点数: ${Number(t.anlas)} · 用量: ${Number(t.remains)}%` : "未查询到") }),
          el("span", { class: "anlas-item-recover", text: anlasRecoverText(t) }),
        ]);
        item.dataset.idx = String(t.index ?? 0);
        return item;
      }),
      el("div", { class: "anlas-note muted", text: "剩余点数及用量 · 恢复时间在查询时更新" }),
    );
  } catch {}
}

function wireOutputActions() {
  sendPnginfoBtn.addEventListener("click", async () => {
    if (!lastOutputPath) return;
    const path = lastOutputPath;
    const { showView } = await import("../app.js");
    const pnginfoMod = await import("./pnginfo.js");
    await showView("pnginfo");
    // openWithImage: 渲染完成后经模块命名空间实时取用 (pnginfoPicker 是 export let, 首渲染才赋值),
    // 并强制切回"读取信息"页签 —— 否则上次停留的反推/抹除页签会一直显示旧图片, 看起来像"发送了以前的图"
    pnginfoMod.openWithImage(path);
  });
  sendBtn.addEventListener("click", () => sendToImg2img(lastOutputPath));
  openDirBtn.addEventListener("click", async () => {
    try {
      // 有选中图片时打开其所在目录, 否则打开 outputs 根目录
      await openDir(lastOutputPath || "");
    } catch {}
  });
}

// ---------------- 提示词自动补全 (从 ui.js 导入 wireAutocomplete) ----------------

// ---------------- 模型联动 (参考 ANR 原版处理) ----------------

function isNai3(model) { return model === "nai-diffusion-3" || model === "nai-diffusion-furry-3"; }
function isNai5(model) { return model === "nai-diffusion-5-full" || model === "nai-diffusion-5-curated"; }
function isNai45(model) { return model === "nai-diffusion-4-5-full" || model === "nai-diffusion-4-5-curated"; }

/** Enhance 放大倍数选项: 1x / 1.5x; Max 仅 v5 系列 (保持纵横比放大到 1536×2048 面积上限) */
function enhanceAmounts(model) {
  return isNai5(model) ? ["1x", "1.5x", "Max"] : ["1x", "1.5x"];
}

/** 归一化缓存的放大倍数: 旧版 2x 或当前模型不支持的 Max 一律回退 1.5x */
function normalizeEnhanceAmount(amount, options) {
  return options.includes(amount) ? amount : "1.5x";
}

function setVisible(ctrl, visible) {
  ctrl.node.style.display = visible ? "" : "none";
}

/** 显示/隐藏整个选项卡 (按钮 + 内容)。隐藏当前激活选项卡时切回参数设置。 */
function setTabVisible(id, visible) {
  const btn = tabBtns[id], body = tabBodies[id];
  if (!btn || !body) return;
  btn.style.display = visible ? "" : "none";
  body.style.display = visible ? "" : "none";
  if (!visible && body.classList.contains("active")) {
    // 切换到第一个可见页签
    const first = Object.entries(tabBtns).find(([tid, b]) => b.style.display !== "none")?.[0] || "params";
    tabBtns[first]?.click();
  }
}

/** 角色参考与风格迁移互斥: 添加参考角色后复位并隐藏风格迁移选项卡, 清空参考后恢复 */
function updateVibeVisibility() {
  if (!tabBtns || !tabBtns.vibe || !refList || !vibeList || !C.vibeBundle) return;
  const hasRef = refList.getCount() > 0;
  const vibeSupported = !isNai5(C.model.get());
  if (hasRef) {
    // 复位风格迁移内容 (清空 bundle 与参考图列)
    vibeList.setItems([]);
    C.vibeBundle.set("");
    setTabVisible("vibe", false);
  } else {
    setTabVisible("vibe", vibeSupported);
  }
}

/** 使用 vibe bundle 时隐藏整个"角色参考"选项卡 (不清空内容), 移除文件后恢复显示 */
function updateRefVisibility() {
  if (!tabBtns || !tabBtns.references || !refSection || !C.vibeBundle) return;
  const nai45 = isNai45(C.model.get());
  const show = nai45 && !C.vibeBundle.get();
  setTabVisible("references", show);
  refSection.style.display = show ? "" : "none";
}

/** AI's Choice / Custom 选择器显示条件: nai5 有 1 个角色, 其余模型 2 个角色 */
function updateAiChoiceVisibility() {
  if (!aiChoiceRow || !charList) return;
  const nai5 = isNai5(C.model.get());
  const count = charList.getCount();
  const visible = (nai5 ? count >= 1 : count >= 2);
  aiChoiceRow.style.display = visible ? "" : "none";
  // 共享位置区域: AI's Choice 时隐藏 (后端自动分配位置), Custom 时显示
  if (charRegion && C.aiChoice) {
    charRegion.node.style.display = (visible && C.aiChoice.get() === "Custom") ? "" : "none";
  }
}

async function applyModelChange(initial = false) {
  const model = C.model.get();
  const nai3 = isNai3(model);
  const nai5 = isNai5(model);
  const nai45 = isNai45(model);

  // Transparent BG 按钮仅 v5 系列模型显示; 非 v5 时追加逻辑也自动失效 (promptWithTransparent 内有双重判断)
  if (tbBtn) tbBtn.style.display = nai5 ? "" : "none";

  // 采样器: nai3 保留 ddim_v3, 其余移除
  const samplers = nai3 ? S.app.samplers : S.app.samplers.filter((s) => s !== "ddim_v3");
  C.sampler.setOptions?.(samplers);
  if (!samplers.includes(C.sampler.get())) C.sampler.set(samplers[0] || "k_euler_ancestral");

  // 调度器: nai5 固定 karras 并隐藏 (与 ANR 一致); 其余移除 native
  const noises = nai3 ? S.app.noise_schedules : S.app.noise_schedules.filter((n) => n !== "native");
  if (nai5) {
    C.noise.set("karras");
    setVisible(C.noise, false);
  } else {
    setVisible(C.noise, true);
    C.noise.setOptions?.(noises);
    if (!noises.includes(C.noise.get())) C.noise.set(noises[0] || "karras");
  }

  // 预设: nai5 保留 Light, 其余移除
  const qp = nai5 ? S.app.qp_presets : S.app.qp_presets.filter((q) => q !== "Light");
  C.quality.setOptions?.(qp);
  if (!qp.includes(C.quality.get())) C.quality.set("Standard");

  const uc = S.app.uc_presets.filter((u) => {
    if (nai5 || model === "nai-diffusion-4-5-full") return true;
    if (model === "nai-diffusion-3") return u !== "Furry Focus";
    if (model === "nai-diffusion-furry-3") return u !== "Furry Focus" && u !== "Human Focus";
    if (model === "nai-diffusion-4-5-curated") return u !== "Furry Focus";
    if (model === "nai-diffusion-4-full" || model === "nai-diffusion-4-curated-preview") return u === "Heavy" || u === "Light" || u === "None";
    return true;
  });
  C.uc.setOptions?.(uc);
  if (!uc.includes(C.uc.get())) C.uc.set("Heavy");

  // 开关: 按模型显示/隐藏 (与 ANR 原版一致)
  setVisible(C.variety, !nai5);            // v5 的 skip_cfg 为 None 无效果, 其余模型支持
  setVisible(C.decrisp, nai3);
  setVisible(C.sm, nai3);
  setVisible(C.smDyn, nai3 && C.sm.get());
  setVisible(C.legacyUc, model === "nai-diffusion-4-full" || model === "nai-diffusion-4-curated-preview");

  // Enhance 放大倍数: Max 仅在 v5 系列出现; 切换模型后当前值不可用则回退 1.5x
  // (必须先取值: setOptions 重建 option 后, 失效的旧值会被浏览器重置成第一项)
  const enhAmounts = enhanceAmounts(model);
  const curEnhAmount = C.enhanceAmount.get();
  C.enhanceAmount.setOptions?.(enhAmounts);
  if (!enhAmounts.includes(curEnhAmount)) C.enhanceAmount.set("1.5x");

  // furry 按钮: nai3 隐藏并复位
  furryBtn.style.display = nai3 ? "none" : "";
  if (nai3) { furryMode = false; updateFurryBtn(); }

  // 隐藏不可用模型的功能选项卡, 并复位其中的内容
  // 角色分区: nai3 不支持
  const charVisible = !nai3;
  setTabVisible("characters", charVisible);
  if (!charVisible) charList.setItems([]);
  // 角色参考: 仅 v4.5 支持 (v5/v4/v3 均无)
  const refVisible = nai45;
  setTabVisible("references", refVisible);
  if (!refVisible) refList.setItems([]);
  // 风格迁移: v5 不支持 (nai3 用多图列, v4/v4.5 用 bundle)
  const vibeVisible = !nai5;
  setTabVisible("vibe", vibeVisible);
  if (!vibeVisible) { vibeList.setItems([]); C.vibeBundle.set(""); }
  updateVibeVisibility();
  charSection.style.display = charVisible ? "" : "none";
  refSection.style.display = refVisible ? "" : "none";
  updateRefVisibility();
  vibeBundleRow.style.display = nai3 ? "none" : "";
  nai3VibeRow.classList.toggle("hidden", !nai3);

  // 角色数量限制: nai5 32, 其余 6 (以官网为准, 动态限制添加按钮)
  charList.setMax?.(nai5 ? 32 : 6);

  // 角色位置: nai5 用自由拖动, 其余用 A1-E5 网格区域
  charRegion?.setMode?.(nai5 ? "free" : "grid");
  updateAiChoiceVisibility();

  // 隐藏/不可用的开关复位为非 nai3 默认值, 避免残留值影响后端
  if (!nai3) {
    C.decrisp.set(false);
    C.sm.set(false);
    C.smDyn.set(false);
  }
  if (model !== "nai-diffusion-4-full" && model !== "nai-diffusion-4-curated-preview") {
    C.legacyUc.set(false);
  }
}

// ---------------- 事件绑定 ----------------

/** 对齐到最接近的 64 的倍数 (下限 64, 与后端 return_x64 一致); 供手动输入与图片上传共用 */
function round64(v) {
  const n = Math.round(Number(v) / 64) * 64;
  return Number.isFinite(n) && n >= 64 ? n : 64;
}

// 分辨率上限: 宽高乘积不得大于 1536×2048 (与后端 ENHANCE_MAX_SIZE 一致, 提交前拦截)
const MAX_RESOLUTION_LABEL = "1536×2048";
const MAX_RESOLUTION_PIXELS = 1536 * 2048;
const MIN_SIDE = 64;

/** 校验分辨率是否合法, 合法返回 null, 否则返回给用户看的错误说明。
 *  规则: 宽高均为不小于 64 的数, 且 宽 × 高 ≤ 1536 × 2048。 */
function validateResolution(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || Math.round(w) < MIN_SIDE || Math.round(h) < MIN_SIDE) {
    return `分辨率不合法: 宽高必须是不小于 ${MIN_SIDE} 的整数 (当前 ${width}×${height})`;
  }
  const pixels = Math.round(w) * Math.round(h);
  if (pixels > MAX_RESOLUTION_PIXELS) {
    return `分辨率 ${Math.round(w)}×${Math.round(h)} = ${pixels.toLocaleString()} 像素, 超过上限 ${MAX_RESOLUTION_LABEL} (${MAX_RESOLUTION_PIXELS.toLocaleString()} 像素), 请调低宽或高`;
  }
  return null;
}

/** 刷新分辨率行下方的像素数提示, 超上限时标红 */
function updateResHint() {
  if (!resHintEl) return;
  const w = Number(C.width?.get());
  const h = Number(C.height?.get());
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    resHintEl.textContent = "";
    resHintEl.className = "muted";
    return;
  }
  const pixels = Math.round(w) * Math.round(h);
  const over = pixels > MAX_RESOLUTION_PIXELS;
  resHintEl.textContent = over
    ? `⚠️ 像素 ${pixels.toLocaleString()} / 上限 ${MAX_RESOLUTION_PIXELS.toLocaleString()} — 超出 ${MAX_RESOLUTION_LABEL}, 无法生成`
    : `像素 ${pixels.toLocaleString()} / 上限 ${MAX_RESOLUTION_PIXELS.toLocaleString()} (${MAX_RESOLUTION_LABEL})`;
  resHintEl.className = "";
  resHintEl.style.color = over ? "var(--danger)" : "var(--text-2)";
}

function bindEvents() {
  C.model.input?.addEventListener("change", () => applyModelChange());
  C.resolution.input?.addEventListener("change", () => {
    const res = C.resolution.get();
    if (res && res !== "自定义") {
      const [w, h] = res.split("x").map(Number);
      C.width.set(w);
      C.height.set(h);
    }
    charRegion?.refresh?.();
    updateResHint();
  });
  // 自定义分辨率: 失焦/回车后自动对齐到最接近的 64 的倍数 (round64 为模块级函数)
  const snap64 = (c, label) => {
    const before = String(c.get()).trim();
    const after = round64(before);
    if (String(after) !== before) {
      c.set(after);
      syncResolution();
      toast(`📐 ${label}已对齐到 64 的倍数: ${after}`, "info");
    } else {
      syncResolution();
    }
  };
  C.width.input?.addEventListener("change", () => snap64(C.width, "宽"));
  C.height.input?.addEventListener("change", () => snap64(C.height, "高"));
  C.sm.input?.addEventListener("change", () => setVisible(C.smDyn, isNai3(C.model.get()) && C.sm.get()));
  C.generateBtn.addEventListener("click", onGenerate);
  C.stopBtn.addEventListener("click", async () => {
    try { await post("/api/generate/stop"); toast("已发送停止指令 ⏹", "warning"); } catch (e) { toast(e.message, "error"); }
  });
  bus.on("job:done", onJobDone);
  bus.on("job:failed", onJobFailed);
  // 启动查询 / 生成后按 Token 更新点数用量时, 后端会推送 anlas:update 事件, 徽标自动刷新
  bus.on("anlas:update", updateAnlasBadge);
}

function syncResolution() {
  const w = C.width.get(), h = C.height.get();
  const res = S.app.resolutions.includes(`${w}x${h}`) ? `${w}x${h}` : "自定义";
  C.resolution.set(res);
  charRegion?.refresh?.();
  updateResHint();
}

function updateInpaintVisibility() {
  if (!inpaintCtlRow) return;
  inpaintCtlRow.classList.toggle("hidden", !editor.hasImage());
}

// ---------------- 收集请求 ----------------

async function collectRequest() {
  const inpaint = editor.hasImage() ? await editor.exportImages() : null;
  if (inpaint) {
    inpaint.strength = C.inpaintStrength.get();
    inpaint.noise = C.inpaintNoise.get();
    inpaint.mask_strength = C.maskStrength.get();
  }

  // 角色位置来自共享区域选择器 (按列表下标一一对应), 再过滤未启用的角色
  const charPositions = charRegion.getPositions();
  const characters = charList.getItems()
    .map((c, i) => ({ ...c, position: charPositions[i] ?? c.position ?? "A1" }))
    .filter((c) => c.enabled);
  const references = refList.getItems();
  const vibeImages = vibeList.getItems().filter((v) => v.path);

  const isNai3Model = isNai3(C.model.get());
  const vibe = isNai3Model
    ? { images: vibeImages, normalize: true }
    : { bundle_path: C.vibeBundle.get() || null, normalize: C.vibeNormalize.get() };

  return {
    model: C.model.get(),
    positive_prompt: promptWithTransparent(),
    negative_prompt: C.negative.get(),
    furry_mode: furryMode,
    quality_preset: C.quality.get(),
    uc_preset: C.uc.get(),
    quantity: Number(C.quantity.get()) || 1,
    width: Number(C.width.get()) || 832,
    height: Number(C.height.get()) || 1216,
    steps: C.steps.get(),
    scale: C.scale.get(),
    cfg_rescale: C.cfgRescale.get(),
    variety: C.variety.get(),
    decrisp: C.decrisp.get(),
    sm: C.sm.get(),
    sm_dyn: C.smDyn.get(),
    legacy_uc: C.legacyUc.get(),
    seed: C.seed.get(),
    sampler: C.sampler.get(),
    noise_schedule: C.noise.get(),
    ai_choice: C.aiChoice.get() === "AI's Choice",
    enhance: {
      enabled: C.enhance.get(),
      amount: C.enhanceAmount.get(),
      magnitude: C.magnitude.get(),
    },
    inpaint,
    characters,
    references,
    vibe,
  };
}

async function onGenerate() {
  // 先校验分辨率: 不合法 (超过 1536×2048) 直接拦下, 不发请求, 也不做 inpaint 导出等重活。
  // 取值规则与 collectRequest 一致: 空值回落到 832×1216 (后端默认), 不把"留空"当成非法。
  const gateW = Number(C.width.get()) || 832;
  const gateH = Number(C.height.get()) || 1216;
  const resError = validateResolution(gateW, gateH);
  if (resError) {
    infoEl.textContent = "❌ " + resError;
    toast(resError, "error", 7000);
    C.width.input?.focus?.();
    return;
  }
  // 编辑器侧校验 (如裁剪重绘还没框选): 也放在导出/上传之前, 不走一遍重活
  const editorError = editor?.validate?.();
  if (editorError) {
    infoEl.textContent = "❌ " + editorError;
    toast(editorError, "error", 6000);
    return;
  }
  let request;
  try {
    request = await collectRequest();
  } catch (e) {
    toast("请求构建失败: " + e.message, "error");
    return;
  }
  C.generateBtn.disabled = true;
  infoEl.textContent = "🚀 正在提交生成任务...";
  try {
    const res = await post("/api/generate", request);
    if (res.position && res.position > 1) {
      infoEl.textContent = "🚦 已加入生图队列, 当前第 " + res.position + " 位, 等待前面的任务完成...";
      toast(`已加入生图队列 (第 ${res.position} 位): ${res.job_id}`, "info", 5000);
    } else {
      toast(`生成任务已启动: ${res.job_id}`, "success");
    }
  } catch (e) {
    infoEl.textContent = "❌ " + e.message;
    toast(e.message, "error", 6000);
  } finally {
    C.generateBtn.disabled = false;
  }
  try {
    const state = {
      model: C.model.get(), positive_prompt: C.positive.get(), negative_prompt: C.negative.get(),
      width: C.width.get(), height: C.height.get(), steps: C.steps.get(), scale: C.scale.get(),
      cfg_rescale: C.cfgRescale.get(), seed: C.seed.get(), quantity: C.quantity.get(), furry_mode: furryMode, transparent_bg: transparentBg,
      enhance: { enabled: C.enhance.get(), amount: C.enhanceAmount.get(), magnitude: C.magnitude.get() },
    };
    S.store.save(state);
  } catch { /* ignore */ }
}

function onJobDone(ev) {
  if (ev.name !== "图片生成") return;
  C.generateBtn.disabled = false;
  if (ev.images?.length) {
    lastGeneratedImages = ev.images;
    buildOutputViewer(genGalleryEl, ev.images);  // 内部已选中第一张并显示发送按钮
  }
  if (ev.message) {
    infoEl.textContent = "✅ " + ev.message;
    toast(ev.message, "success");
  }
  updateAnlasBadge();
}

/** 设置输出区选中图片与发送按钮的显示状态 (path 为 null 表示取消选择) */
function setOutputSelection(path) {
  selectedOutputPath = path || null;
  lastOutputPath = path || null;
  sendBtn.classList.toggle("hidden", !path);
  sendPnginfoBtn.classList.toggle("hidden", !path);
}

function onJobFailed(ev) {
  if (ev.name !== "图片生成") return;
  C.generateBtn.disabled = false;
  infoEl.textContent = "❌ " + (ev.error || "生成失败");
}

// ---------------- 对外接口 ----------------

export function onShow() {
  // "发送到图片生成"等外部 set 发生在视图隐藏期间 (scrollHeight=0 量不到真实高度, 只会停在最小行数);
  // 每次进入视图补一次自适应: 仍受 autosizeRows 的 6~15 行上下限约束, 超长自动出滚动条
  C.positive?.refit?.();
  C.negative?.refit?.();
}

/** 把图片载入图生图基础图片区, 并切到参数设置页签 (供输出区/图片浏览查看器调用) */
export async function sendToImg2img(path) {
  if (!path) return false;
  try {
    await editor.loadImage(path);
    // "已加载到图生图编辑器" 提示由编辑器 loadImage 内部弹出, 这里不再重复
    // 切换到参数设置页签
    const bar = document.querySelector("#view-generate .tabs");
    if (bar) { [...bar.children].forEach((b, i) => b.classList.toggle("active", i === 0)); }
    const bodies = document.querySelectorAll("#view-generate .tab-content");
    bodies.forEach((b, i) => b.classList.toggle("active", i === 0));
    showGenerateView();
    return true;
  } catch (e) {
    toast("加载失败: " + e.message, "error");
    return false;
  }
}

/** 显示图片生成视图 (本模块内直接调用, 避免动态 import app.js) */
function showGenerateView() {
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === "generate"));
  $$(".view").forEach((v) => { v.style.display = "none"; });
  const target = document.getElementById("view-generate");
  if (target) target.style.display = "block";
}

/** 最近一次生成的图片列表 (多张时取最后一张用于 wildcard 封面等) */
export function getLastGeneratedImages() {
  return lastGeneratedImages;
}

/** 当前选中的输出图片; 未选择时返回最近一次生成的最后一张 (用于 wildcard 封面) */
export function getCurrentOutputImage() {
  if (selectedOutputPath) return selectedOutputPath;
  return lastGeneratedImages.length ? lastGeneratedImages[lastGeneratedImages.length - 1] : null;
}

export function getC() { return C; }
export function setGenerateState(state, opts = {}) {
  // 法术解析/画廊"发送到图片生成": 元数据里的正/负面提示词带有预设标签
  // (生成时后端会追加质量预设、前置 UC 预设), 这里检测并剥离这些标签, 自动切换到对应预设
  const switched = [];
  const model = C.model.get();
  if (state.positive_prompt != null) {
    const hit = extractPresetTags(state.positive_prompt, model, "quality_preset_tags", "tail"); // 质量预设追加在末尾, 只从末尾剥离一次
    let posText = state.positive_prompt;
    if (hit.preset && applyPresetOption(C.quality, hit.preset)) {
      posText = hit.text;
      switched.push(`正面预设 → ${hit.preset}`);
    }
    // 预设剥离后再处理 transparent background (生成时顺序: 用户输入+TB+预设, 剥离顺序相反); 同步开关为图片真实状态
    C.positive.set(syncTransparentBg(posText));
  }
  if (state.negative_prompt != null) {
    const hit = extractPresetTags(state.negative_prompt, model, "uc_preset_tags", "head"); // UC 预设前置在开头, 只从开头剥离一次
    if (hit.preset && applyPresetOption(C.uc, hit.preset)) {
      C.negative.set(hit.text);
      switched.push(`负面预设 → ${hit.preset}`);
    } else {
      C.negative.set(state.negative_prompt);
    }
  }
  // opts.silent: 后台同步路径 (画廊"发送到法术解析"顺带更新图片生成表单) 不弹提示;
  // 预设剥离与切换照常执行, 保证后续生成不会把元数据里的预设原文再重复拼一遍
  if (switched.length && !opts.silent) toast(`已剥离预设标签并自动切换: ${switched.join("，")} ⭐`, "info");
  if (state.width != null) C.width.set(state.width);
  if (state.height != null) C.height.set(state.height);
  // 外部送入的尺寸可能超限 (如从大图反推后发送), 立刻刷新像素提示, 别让告警信息停在旧值
  if (state.width != null || state.height != null) updateResHint();
  if (state.steps != null) C.steps.set(state.steps);
  if (state.scale != null) C.scale.set(state.scale);
  if (state.cfg_rescale != null) C.cfgRescale.set(state.cfg_rescale);
  if (state.seed != null) C.seed.set(state.seed);
  if (state.sampler != null) C.sampler.set(state.sampler);
  if (state.noise_schedule != null) C.noise.set(state.noise_schedule);
  if (state.characters?.length) {
    charList.setItems(state.characters.map((c) => ({
      prompt: c.prompt ?? "",
      negative_prompt: c.negative_prompt ?? "",
      enabled: !!c.enabled,
    })));
    charRegion.setCount(state.characters.length);
    // 元数据导出的 position 是 5x5 网格标签 (自由坐标被吸附到 A1-E5 格心);
    // v5 且后端给出原始 xy 时优先用 xy, 与 "加载上次" 的 toFixed(2) 精度一致, 切换模型时组件自会网格↔自由换算
    const rawXy = isNai5(C.model.get());
    charRegion.restore(state.characters.map((c) =>
      (rawXy && Array.isArray(c.xy) && Number.isFinite(c.xy[0]) && Number.isFinite(c.xy[1]))
        ? c.xy[0] + "," + c.xy[1]
        : (c.position ?? "A1"),
    ));
  }
}