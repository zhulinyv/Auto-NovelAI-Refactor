// ============================================================
// Wildcards 全屏编辑弹窗:
//   顶部: 提示词标签块编辑器 (参考 sd-webui-prompt-all-in-one)
//     - 提示词按逗号拆分为可点击的标签块, 悬停可 删除/编辑/增减权重
//     - 双击空白处或点 ✏️ 切回文本输入 (手动输入保留, 自动补全可用)
//     - 卡片库中多选的卡片可拖拽进编辑器, 或点 "➕ 添加选中" 批量加入
//     - 所有编辑实时同步回原输入框
//   下方: Wildcards 面板全部功能 (views/wildcards.js)
// 触发按钮由 ui.js 的 wildcardsButton() 创建 (.wc-open-btn),
// 此处在 document 上做一次全局点击委托统一打开弹窗。
// ============================================================
import { $, $$, el, clear, toast, wireAutocomplete } from "./ui.js";
import { post } from "./api.js";
import { renderPanel, cardSelection, cardDrag, promptSelection, activeLib } from "./views/wildcards.js";
import { appState } from "./app.js";

let modalOpen = false;

/** 把弹窗输入框的值写回原输入框 (单行 input 会把换行合并为逗号), 并派发 input 事件联动保存/联动逻辑 */
function syncToSource(source, value) {
  if (!source || !source.isConnected) return;
  let v = value ?? "";
  if (source.tagName !== "TEXTAREA") v = v.replace(/\s*[\r\n]+\s*/g, ", ").replace(/,\s*$/, "");
  if (source.value === v) return;
  source.value = v;
  source.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------- 提示词 ⇄ 标签块 解析 ----------------

/** 按逗号拆分为标签 (括号/方括号/花括号/尖括号内的逗号不拆分) */
function splitTags(value) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of value ?? "") {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(buf); buf = ""; }
    else buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 解析 (内容:权重) 形式的标签, 无权重时 weight = 1 */
function parseWeight(raw) {
  const m = /^\((.+):(\d*\.?\d+)\)$/.exec(raw);
  if (m) return { content: m[1], weight: parseFloat(m[2]) };
  return { content: raw, weight: 1 };
}

const fmtTag = (content, weight) => (weight === 1 ? content : `(${content}:${weight})`);

/**
 * 打开 Wildcards 全屏弹窗。
 * @param {HTMLTextAreaElement|HTMLInputElement} source 触发弹窗的提示词输入框
 * @param {object} opts { title: 弹窗中显示的输入框名称 }
 */
export function openWildcardsModal(source, { title = "提示词" } = {}) {
  if (modalOpen || !source) return;
  modalOpen = true;
  const initialValue = source.value ?? "";

  const overlay = el("div", { class: "wc-modal" });
  const box = el("div", { class: "wc-modal-box" });

  // ---- 头部 ----
  const closeBtn = el("button", { class: "btn btn-sm btn-danger", type: "button", text: "✖ 关闭" });
  const header = el("div", { class: "wc-modal-header" }, [
    el("div", { class: "wc-modal-title" }, [
      "🃏 Wildcards",
      el("span", { class: "wc-modal-sub", text: title }),
    ]),
    closeBtn,
  ]);

  // ---- 顶部: 提示词标签块编辑器 (双模式) ----
  const ta = el("textarea", { rows: 6, placeholder: source.placeholder || "在此输入提示词..." });
  ta.value = initialValue;
  const taBox = el("div", { class: "ta-box hidden" }, [ta]);
  const chipsView = el("div", { class: "prompt-chips" });
  const editor = el("div", { class: "wc-prompt-editor" }, [chipsView, taBox]);
  wireAutocomplete(ta, taBox);

  const addSelBtn = el("button", {
    class: "btn btn-sm btn-primary",
    type: "button",
    text: "➕ 添加选中",
    disabled: true,
    title: "把下方库中选中的项批量加入提示词 (卡片库: Ctrl+点击多选 / Shift+点击范围选, 也可直接拖入; 提示词库: 点击标签多选)",
  });
  const clearSelBtn = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "✖ 清除选择",
    disabled: true,
    title: "清除当前库中选中的项 (卡片/提示词)",
  });
  const modeBtn = el("button", { class: "btn btn-sm", type: "button", text: "✏️ 文本编辑", title: "在 标签块视图 / 文本输入 之间切换 (手动输入保留)" });

  const promptSec = el("div", { class: "wc-modal-prompt" }, [
    el("div", { class: "wc-modal-prompt-head" }, [
      el("span", { class: "wc-modal-prompt-label", text: "📝 " + title }),
      el("span", { class: "muted wc-prompt-hint", text: "编辑实时同步回原输入框, 可直接生成" }),
      el("span", { class: "spacer" }),
      addSelBtn,
      clearSelBtn,
      modeBtn,
    ]),
    editor,
  ]);

  // ---- 标签块渲染与操作 ----
  let mode = "tags";
  let chipDragIdx = -1;   // 正在拖拽的标签块索引
  let chipDropIdx = -1;   // 拖拽悬停的目标插入索引 (-1 表示原位)
  const zhCache = new Map();   // 标签 -> 中文翻译 (会话内缓存)
  let translating = false;

  const zhKey = (content) => (content || "").trim().toLowerCase().replace(/\s+/g, "_");

  /** 批量获取缺失的翻译 (PAI 风格双语标签), 拿到后重渲染一次 */
  async function fetchTranslations(contents) {
    const missing = [...new Set(contents.map(zhKey).filter((k) => k && !zhCache.has(k)))];
    if (!missing.length || translating) return;
    translating = true;
    try {
      const res = await post("/api/suggest/translate", { tags: missing });
      Object.entries(res.translations || {}).forEach(([tag, zh]) => zhCache.set(zhKey(tag), zh || ""));
      if (mode !== "tags" || !modalOpen) return;
      // 输入/编辑状态打开时不整体重渲染 (避免冲掉正在输入的内容), 改为就地更新翻译
      if (chipsView.querySelector(".p-chip-input")) {
        const tags = splitTags(ta.value);
        [...chipsView.querySelectorAll(".p-chip")].forEach((chip, i) => {
          if (tags[i] === undefined) return;
          const zhEl = chip.querySelector(".p-chip-zh");
          if (zhEl) zhEl.textContent = zhCache.get(zhKey(parseWeight(tags[i]).content)) || "";
        });
        return;
      }
      renderChips();
    } catch { /* 翻译获取失败静默处理, 标签块仍正常显示 */ }
    finally { translating = false; }
  }

  function renderChips() {
    clear(chipsView);
    const tags = splitTags(ta.value);
    if (!tags.length) {
      chipsView.append(el("div", { class: "p-chips-empty", text: "提示词为空 — 双击此处或点右上角 ✏️ 直接输入; 也可从下方卡片库点选 / 拖拽 / 点 \"添加选中\"" }));
      return;
    }
    tags.forEach((raw, i) => chipsView.append(makeChip(raw, i)));
    chipsView.append(makeAddChip());
    // 收集未翻译的普通标签, 批量查询 (通配符 <分类:卡片名> 不翻译)
    const need = tags.map((raw) => parseWeight(raw).content).filter((c) => c && !c.startsWith("<"));
    if (need.some((c) => !zhCache.has(zhKey(c)))) fetchTranslations(need);
  }

  /** 末尾的 "＋标签" 块: 点击展开输入框, 回车添加标签 (参考 PAI 添加关键词, 支持自动补全) */
  function makeAddChip() {
    const chip = el("div", { class: "p-chip p-chip-add", title: "添加标签", text: "＋ 标签" });
    chip.addEventListener("click", () => startAdd());
    return chip;
  }

  function startAdd() {
    const anchor = chipsView.querySelector(".p-chip-add");
    const inputChip = el("div", { class: "p-chip p-chip-add-input" });
    const input = el("input", { class: "p-chip-input", placeholder: "输入标签后回车 (可逗号分隔多个, Esc 取消)" });
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const parts = input.value.split(",").map((v) => v.trim()).filter(Boolean);
      if (parts.length) {
        applyTags([...splitTags(ta.value), ...parts]);
        const add = chipsView.querySelector(".p-chip-add");
        if (add) startAdd();  // 保持输入状态, 方便连续添加
      } else {
        renderChips();
      }
    };
    const cancel = () => {
      if (done) return;
      done = true;
      renderChips();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) commit(); else cancel(); });
    // portal 到弹窗 overlay: 补全下拉不会被标签块视图的 overflow 裁剪容器挡住
    wireAutocomplete(input, inputChip, { portal: overlay });  // 添加关键词同样支持自动补全
    inputChip.append(input);
    if (anchor) chipsView.replaceChild(inputChip, anchor);
    else chipsView.append(inputChip);
    input.focus();
  }

  function applyTags(tags) {
    ta.value = tags.join(", ");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  ta.addEventListener("input", () => {
    syncToSource(source, ta.value);
    if (mode === "tags") renderChips();
  });

  function setWeight(i, delta) {
    const tags = splitTags(ta.value);
    if (!tags[i]) return;
    const { content, weight } = parseWeight(tags[i]);
    const next = Math.min(10, Math.max(0.1, Math.round((weight + delta) * 10) / 10));
    tags[i] = fmtTag(content, next);
    applyTags(tags);
  }

  function removeTag(i) {
    const tags = splitTags(ta.value);
    tags.splice(i, 1);
    applyTags(tags);
  }

  function startEdit(i) {
    const tags = splitTags(ta.value);
    const { content, weight } = parseWeight(tags[i] ?? "");
    const chip = chipsView.children[i];
    if (!chip) return;
    let done = false;
    clear(chip);
    chip.classList.add("editing");
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      const t = splitTags(ta.value);
      if (!v) t.splice(i, 1);
      else t[i] = fmtTag(v, weight);
      applyTags(t);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      renderChips();
    };
    const input = el("input", { class: "p-chip-input", value: content });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
    });
    input.addEventListener("blur", commit);
    chip.append(input);
    input.focus();
    input.select();
  }

  function makeChip(raw, i) {
    const { content, weight } = parseWeight(raw);
    const zh = zhCache.get(zhKey(content)) || "";
    const chip = el("div", { class: "p-chip", title: "拖动可排序; 双击编辑 (Esc 取消); 悬停显示操作按钮" }, [
      el("div", { class: "p-chip-row" }, [
        el("span", { class: "p-chip-text", text: content }),
        weight !== 1 ? el("span", { class: "p-chip-w", text: "×" + weight }) : null,
      ]),
      el("div", { class: "p-chip-zh", text: zh }),  // 始终占位, 保证有/无翻译的标签等高
    ]);
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => {
      chipDragIdx = i;
      chipDropIdx = -1;
      chip.classList.add("chip-dragging");
      try {
        e.dataTransfer.setData("text/plain", raw);
        e.dataTransfer.effectAllowed = "move";
      } catch { /* 忽略 */ }
    });
    chip.addEventListener("dragend", () => {
      chipDragIdx = -1;
      chipDropIdx = -1;
      chip.classList.remove("chip-dragging");
      $$(".p-chip.drop-before", chipsView).forEach((c) => c.classList.remove("drop-before"));
    });
    chip.append(el("div", { class: "p-chip-ops" }, [
      el("span", { class: "p-op", title: "降低权重 (−0.1)", text: "▼", onclick: () => setWeight(i, -0.1) }),
      el("span", { class: "p-op", title: "增加权重 (+0.1)", text: "▲", onclick: () => setWeight(i, +0.1) }),
      el("span", { class: "p-op", title: "编辑", text: "✎", onclick: () => startEdit(i) }),
      el("span", { class: "p-op p-op-danger", title: "删除", text: "×", onclick: () => removeTag(i) }),
    ]));
    chip.addEventListener("dblclick", () => startEdit(i));
    return chip;
  }

  // 标签块拖动排序: dragover 计算插入位置 (按行列阅读顺序), drop 重排
  chipsView.addEventListener("dragover", (e) => {
    if (chipDragIdx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const chips = [...chipsView.querySelectorAll(".p-chip:not(.p-chip-add):not(.p-chip-add-input)")];
    let target = -1;
    for (let k = 0; k < chips.length; k++) {
      if (k === chipDragIdx) continue;
      const r = chips[k].getBoundingClientRect();
      const past = r.bottom <= e.clientY + 2
        || (e.clientY >= r.top && e.clientY <= r.bottom && r.left + r.width / 2 <= e.clientX);
      if (!past) { target = k; break; }
    }
    $$(".p-chip.drop-before", chipsView).forEach((c) => c.classList.remove("drop-before"));
    if (target < 0) {
      // 拖过所有标签: 追加到末尾
      chipDropIdx = splitTags(ta.value).length;
      const addChip = chipsView.querySelector(".p-chip-add");
      if (addChip) addChip.classList.add("drop-before");
    } else {
      chipDropIdx = target;
      if (target !== chipDragIdx) chips[target].classList.add("drop-before");
    }
  });
  chipsView.addEventListener("drop", (e) => {
    if (chipDragIdx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = chipDragIdx;
    const to = chipDropIdx;
    chipDragIdx = -1;
    chipDropIdx = -1;
    const tags = splitTags(ta.value);
    if (to < 0 || to === from) { renderChips(); return; }
    const [moved] = tags.splice(from, 1);
    if (to >= tags.length) tags.push(moved);
    else tags.splice(to > from ? to - 1 : to, 0, moved);
    applyTags(tags);
  });

  function setMode(m) {
    mode = m;
    chipsView.classList.toggle("hidden", m !== "tags");
    taBox.classList.toggle("hidden", m !== "text");
    modeBtn.textContent = m === "tags" ? "✏️ 文本编辑" : "🏷️ 标签视图";
    if (m === "tags") renderChips();
    else ta.focus();
  }
  modeBtn.addEventListener("click", () => setMode(mode === "tags" ? "text" : "tags"));
  chipsView.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".p-chip")) setMode("text");
  });

  // ---- 批量加入选中的卡片 (按钮 / 拖拽共用) ----
  async function addCards(names, type) {
    if (!type || !names?.length) {
      toast("请先在卡片库选择卡片 (普通点击选中并编辑, Ctrl+点击多选, Shift+点击范围选)", "warning");
      return;
    }
    let added = 0;
    for (const name of names) {
      try {
        const res = await post("/api/wildcards/add-to-prompt", { prompt: ta.value, type, name });
        ta.value = res.prompt ?? ta.value;
        added++;
      } catch (e) {
        toast(`添加 <${type}:${name}> 失败: ` + e.message, "error");
      }
    }
    if (!added) return;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    syncToSource(source, ta.value);
    try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 忽略 */ }
    toast(`已添加 ${added} 张卡片到提示词 🌸`, "success");
    cardSelection.set(cardSelection.type, []);
  }

  addSelBtn.addEventListener("click", () => {
    if (activeLib.lib === "prompts") {
      const tags = [...promptSelection.tags];
      if (!tags.length) { toast("请先在提示词库点击标签多选", "warning"); return; }
      const cur = (ta.value || "").trim().replace(/,\s*$/, "");
      addTarget.set(cur ? `${cur}, ${tags.join(", ")}` : tags.join(", "));
      promptSelection.clear();
      toast(`已添加 ${tags.length} 个提示词到提示词 🌸`, "success");
    } else {
      addCards(cardSelection.names, cardSelection.type);
    }
  });
  clearSelBtn.addEventListener("click", () => {
    if (activeLib.lib === "prompts") promptSelection.clear();
    else cardSelection.set(cardSelection.type, []);
  });
  /** 共用按钮状态: 随当前库和各自选择数量刷新 */
  function refreshSelBtns() {
    if (!addSelBtn.isConnected) return;
    const n = activeLib.lib === "prompts" ? promptSelection.tags.length : cardSelection.names.length;
    addSelBtn.disabled = !n;
    addSelBtn.textContent = n ? `➕ 添加选中 (${n})` : "➕ 添加选中";
    clearSelBtn.disabled = !n;
  }
  cardSelection.onChange(refreshSelBtns);
  promptSelection.onChange(refreshSelBtns);
  activeLib.onChange(refreshSelBtns);

  // ---- 拖拽: 卡片库 -> 提示词编辑器 ----
  editor.addEventListener("dragover", (e) => {
    if (!cardDrag.names?.length) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    editor.classList.add("drag-over");
  });
  editor.addEventListener("dragleave", (e) => {
    if (!editor.contains(e.relatedTarget)) editor.classList.remove("drag-over");
  });
  editor.addEventListener("drop", (e) => {
    if (!cardDrag.names?.length) return;
    e.preventDefault();
    editor.classList.remove("drag-over");
    const names = [...cardDrag.names];
    const type = cardDrag.type;
    cardDrag.type = null;
    cardDrag.names = [];
    addCards(names, type);
  });

  // ---- 下方: Wildcards 面板全部功能 ----
  const body = el("div", { class: "wc-modal-body" });
  body.append(el("div", { class: "muted wc-modal-loading", text: "🌸 正在加载 Wildcards..." }));

  // 卡片面板的 "添加到当前输入框": 以弹窗输入框为准, 写回后同步原输入框并刷新标签块
  const addTarget = {
    get: () => ta.value,
    set: (v) => {
      ta.value = v ?? "";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 忽略 */ }
    },
  };

  function close() {
    if (!modalOpen) return;
    modalOpen = false;
    if (ta.value !== initialValue) {
      syncToSource(source, ta.value);
      try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 忽略 */ }
    }
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    document.body.style.overflow = "";
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  overlay.append(box);
  box.append(header, promptSec, body);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";

  renderPanel(body, { app: appState || null }, { addTarget }).catch((e) => {
    clear(body);
    body.append(el("div", { class: "card" }, [el("div", { class: "muted", text: "Wildcards 加载失败: " + e.message })]));
  });
  setMode("tags");
}

// 全局委托: 所有 .wc-open-btn 按钮 (ui.js wildcardsButton 创建) 点击打开弹窗
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest(".wc-open-btn") : null;
  if (!btn || !btn._wcTarget) return;
  e.preventDefault();
  openWildcardsModal(btn._wcTarget, { title: btn._wcTitle || "提示词" });
});
