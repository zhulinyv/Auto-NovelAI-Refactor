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
import { $, el, clear, toast, wireAutocomplete } from "./ui.js";
import { post } from "./api.js";
import { renderPanel, cardSelection, cardDrag } from "./views/wildcards.js";
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
    title: "把卡片库中选中的卡片批量加入下方提示词 (Ctrl+点击多选 / Shift+点击范围选, 也可直接拖入)",
  });
  const modeBtn = el("button", { class: "btn btn-sm", type: "button", text: "✏️ 文本编辑", title: "在 标签块视图 / 文本输入 之间切换 (手动输入保留)" });

  const promptSec = el("div", { class: "wc-modal-prompt" }, [
    el("div", { class: "wc-modal-prompt-head" }, [
      el("span", { class: "wc-modal-prompt-label", text: "📝 " + title }),
      el("span", { class: "muted wc-prompt-hint", text: "编辑实时同步回原输入框, 可直接生成" }),
      el("span", { class: "spacer" }),
      addSelBtn,
      modeBtn,
    ]),
    editor,
  ]);

  // ---- 标签块渲染与操作 ----
  let mode = "tags";

  function renderChips() {
    clear(chipsView);
    const tags = splitTags(ta.value);
    if (!tags.length) {
      chipsView.append(el("div", { class: "p-chips-empty", text: "提示词为空 — 双击此处或点右上角 ✏️ 直接输入; 也可从下方卡片库点选 / 拖拽 / 点 \"添加选中\"" }));
      return;
    }
    tags.forEach((raw, i) => chipsView.append(makeChip(raw, i)));
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
    const chip = el("div", { class: "p-chip", title: "双击块可编辑 (Esc 取消), 悬停显示操作按钮" }, [
      el("span", { class: "p-chip-text", text: content }),
      weight !== 1 ? el("span", { class: "p-chip-w", text: "×" + weight }) : null,
    ]);
    chip.append(el("div", { class: "p-chip-ops" }, [
      el("span", { class: "p-op", title: "降低权重 (−0.1)", text: "▼", onclick: () => setWeight(i, -0.1) }),
      el("span", { class: "p-op", title: "增加权重 (+0.1)", text: "▲", onclick: () => setWeight(i, +0.1) }),
      el("span", { class: "p-op", title: "编辑", text: "✎", onclick: () => startEdit(i) }),
      el("span", { class: "p-op p-op-danger", title: "删除", text: "×", onclick: () => removeTag(i) }),
    ]));
    chip.addEventListener("dblclick", () => startEdit(i));
    return chip;
  }

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

  addSelBtn.addEventListener("click", () => addCards(cardSelection.names, cardSelection.type));
  cardSelection.onChange((names) => {
    addSelBtn.disabled = !names.length;
    addSelBtn.textContent = names.length ? `➕ 添加选中 (${names.length})` : "➕ 添加选中";
  });

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
