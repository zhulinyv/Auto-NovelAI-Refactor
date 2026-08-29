// ============================================================
// Wildcards 面板 (嵌入 Wildcards 全屏弹窗)
//   左: 卡片库 (分类页签 / 搜索 / 多选 / 拖拽)   右: 卡片编辑
//   卡片多选状态通过 cardSelection 共享给弹窗 ("添加选中" 按钮),
//   拖拽中的卡片通过 cardDrag 共享给弹窗的提示词编辑器投放。
//   交互: 普通点击=编辑并单选, Ctrl+点击=多选, Shift+点击=范围多选,
//         选中后可拖入上方提示词, 或点弹窗的 "➕ 添加选中"。
//   封面约定: 卡片同目录下的 <名称>.png/jpg/webp 即为其封面
// ============================================================
import { $, $$, el, clear, toast, confirmDialog, wireAutocomplete } from "../ui.js";
import { get, post, del, imageUrl } from "../api.js";
import { getCurrentOutputImage } from "./generate.js";
import { builtinPromptGroups } from "../data/builtinPrompts.js";

let S = null;
const state = { type: null, name: null, keyword: "", lastIdx: -1 };

/** 卡片多选状态 (弹窗的 "添加选中" 按钮据此批量插入提示词) */
export const cardSelection = {
  type: null,
  names: [],
  _listeners: new Set(),
  set(type, names) {
    this.type = type;
    this.names = names;
    for (const fn of this._listeners) {
      try { fn(names); } catch { /* 忽略监听器异常 */ }
    }
  },
  onChange(fn) { this._listeners.add(fn); },
};

/** 正在被拖拽的卡片 (弹窗提示词编辑器 drop 时读取) */
export const cardDrag = { type: null, names: [] };

/** 提示词库当前多选的内置提示词 (弹窗的 "添加选中/清除选择" 按钮据此操作) */
export const promptSelection = {
  tags: [],
  _listeners: new Set(),
  set(tags) {
    this.tags = tags;
    for (const fn of this._listeners) {
      try { fn(tags); } catch { /* 忽略监听器异常 */ }
    }
  },
  clear() { this.set([]); },
  onChange(fn) { this._listeners.add(fn); },
};

/** 弹窗面板当前所在的库 (cards / prompts), 弹窗共用按钮据此切换作用对象 */
export const activeLib = {
  lib: "cards",
  _listeners: new Set(),
  set(lib) {
    if (this.lib === lib) return;
    this.lib = lib;
    for (const fn of this._listeners) {
      try { fn(lib); } catch { /* 忽略监听器异常 */ }
    }
  },
  onChange(fn) { this._listeners.add(fn); },
};

export async function renderPanel(container, ctx, opts = {}) {
  S = ctx;
  clear(container);
  cardSelection.set(null, []);
  promptSelection.set([]);
  activeLib.set("cards");
  const selection = new Set();
  let allCards = [];
  let visibleCards = [];

  // ---------------- 左: 卡片库 ----------------
  const countEl = el("span", { class: "wc-count muted" });
  // ---------------- 右: 新建 / 编辑卡片 (共用一个面板区域) ----------------
  const typeList = el("div", { class: "wc-types" });
  const searchBox = el("input", { type: "text", class: "wc-search", placeholder: "🔍 搜索卡片名称 (大量卡片时快速筛选)..." });
  const grid = el("div", { class: "wc-grid" });
  const selText = el("span", { text: "" });
  const selBar = el("div", { class: "wc-sel-bar hidden" }, [
    selText,
    el("span", { class: "spacer" }),
  ]);

  const libTabs = el("div", { class: "wc-lib-tabs" }, [
    el("button", { class: "tab-btn active", text: "🗂️ 卡片库", onclick: () => switchLib("cards") }),
    el("button", { class: "tab-btn", text: "📚 提示词库", onclick: () => switchLib("prompts") }),
  ]);
  const cardLibBox = el("div", {}, [typeList, searchBox, grid, selBar]);

  // ---- 分类 tab 拖拽排序 ----
  let typeDragKey = null;
  let typeDropKey = null;

  typeList.addEventListener("dragover", (e) => {
    if (!typeDragKey) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const tabs = [...typeList.querySelectorAll(".tab-btn")];
    let target = null;
    for (const tb of tabs) {
      if (tb.dataset.key === typeDragKey) continue;
      const r = tb.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { target = tb; break; }
    }
    $$(".tab-btn.drop-before", typeList).forEach((x) => x.classList.remove("drop-before"));
    (target || tabs[tabs.length - 1])?.classList.add("drop-before");
    typeDropKey = target ? target.dataset.key : "__end__";
  });
  typeList.addEventListener("dragleave", (e) => {
    if (!typeList.contains(e.relatedTarget)) {
      $$(".tab-btn.drop-before", typeList).forEach((x) => x.classList.remove("drop-before"));
    }
  });
  typeList.addEventListener("drop", async (e) => {
    if (!typeDragKey) return;
    e.preventDefault();
    const key = typeDragKey;
    typeDragKey = null;
    $$(".tab-btn.drop-before", typeList).forEach((x) => x.classList.remove("drop-before"));
    const ordered = allTypes.filter((t) => t !== key);
    let at = typeDropKey === "__end__" ? ordered.length : ordered.indexOf(typeDropKey);
    if (at < 0) at = ordered.length;
    ordered.splice(at, 0, key);
    allTypes = ordered;
    try {
      await post("/api/wildcards/reorder-types", { types: ordered });
      toast("分类顺序已保存 ↕️", "success");
    } catch (err) { toast(err.message, "error"); }
    await loadTypes();   // 按新顺序重绘 tab
  });

  // ---------------- 提示词库 (内置分类提示词 + 用户收藏) ----------------
  const plSearch = el("input", { type: "text", class: "wc-search", placeholder: "🔍 搜索提示词..." });
  plSearch.addEventListener("input", () => { plKeyword = plSearch.value; renderPromptChips(); });
  const plInput = el("input", { type: "text", style: "flex:1;min-width:0;", placeholder: "输入关键词或一段提示词, 保存后可随时加入提示词" });
  plInput.addEventListener("keydown", (e) => { if (e.key === "Enter") savePromptLib(); });
  // 分类: 与新建卡片一致的下拉形式, 支持选择已有分类或直接输入新分类
  const plCatInput = el("input", { type: "text", placeholder: "选择已有分类, 或输入新分类" });
  const plCatWrap = el("div", { class: "wc-type-wrap", style: "width:180px;flex-shrink:0;" }, [
    plCatInput,
    el("button", {
      class: "wc-type-caret", type: "button", text: "▾", title: "选择已有分类",
      onclick: (e) => { e.stopPropagation(); togglePlCatDropdown(); },
    }),
  ]);
  // 内置提示词多选计数 (添加/清除使用弹窗右上角的共用按钮)
  const plSelText = el("div", { class: "wc-pl-selbar muted hidden", text: "" });
  const builtinBox = el("div", { class: "wc-pl-builtin" });
  const promptLibBox = el("div", { class: "hidden" }, [
    el("div", { style: "display:flex;gap:6px;margin-bottom:10px;" }, [
      plCatWrap,
      plInput,
      el("button", { class: "btn btn-sm btn-primary", text: "💾 保存", onclick: savePromptLib }),
    ]),
    plSearch,
    el("div", { class: "wc-pl-title", text: "✨ 提示词标签 (点击标签多选, 点右上角 \"添加选中\" 一次加入)" }),
    builtinBox,
    plSelText,
  ]);

  const createBtn = el("button", { class: "btn btn-sm", text: "➕ 新建卡片", onclick: () => { switchLib("cards"); showCreate(); } });
  const browseCard = el("div", { class: "card wc-browse" }, [
    el("div", { class: "wc-browse-head" }, [
      el("div", { class: "card-title", text: "🗂️ 素材库" }),
      countEl,
      el("span", { class: "spacer" }),
      createBtn,
    ]),
    libTabs,
    cardLibBox,
    promptLibBox,
  ]);

  const editCard = el("div", { class: "card wc-edit" });

  const layout = el("div", { class: "wc-panel-grid" });
  layout.append(browseCard, editCard);
  container.append(layout);

  // 弹窗批量添加完成后会清空共享选择, 这里同步面板本地的选中 UI
  cardSelection.onChange((names) => {
    if (!container.isConnected) return;
    if (!names.length && selection.size) {
      selection.clear();
      state.lastIdx = -1;
      syncSelectionClasses();
    }
  });

  // ---------------- 提示词库 (参考 PAI 关键词库: 收藏关键词, 点击加入提示词) ----------------
  const plZh = new Map();
  let plItems = [];
  let plKeyword = "";
  let plLoaded = false;
  let plMeta = { hidden_tags: [], hidden_categories: [], category_order: [] };

  function switchLib(which) {
    const isCards = which === "cards";
    [...libTabs.children].forEach((b, i) => b.classList.toggle("active", i === 0 === isCards));
    cardLibBox.classList.toggle("hidden", !isCards);
    promptLibBox.classList.toggle("hidden", isCards);
    // 提示词库下没有"卡片"概念: 隐藏新建卡片入口和右侧编辑卡片区域 (单栏布局)
    createBtn.classList.toggle("hidden", !isCards);
    editCard.classList.toggle("hidden", !isCards);
    layout.classList.toggle("single", !isCards);
    // 同步当前库给弹窗 (共用按钮的作用对象随之切换)
    activeLib.set(isCards ? "cards" : "prompts");
    if (!isCards && !plLoaded) { plLoaded = true; loadPromptLib(); renderPromptChips(); }
  }

  // ---------------- 内置提示词 (参考 PAI 预设: 分类分组, 横向标签, 可多选) ----------------
  const builtinSel = new Set();   // 已勾选的内置提示词 (英文 tag)

  function syncBuiltinSelBar() {
    const n = builtinSel.size;
    plSelText.textContent = n ? `已选 ${n} 个内置提示词 — 点右上角 "➕ 添加选中" 加入, "✖ 清除选择" 取消` : "";
    plSelText.classList.toggle("hidden", !n);
  }

  // 弹窗 "✖ 清除选择" 或批量添加后会重置共享选择, 这里同步本地面板 UI
  promptSelection.onChange((tags) => {
    if (!container.isConnected) return;
    builtinSel.clear();
    tags.forEach((t) => builtinSel.add(t));
    renderPromptChips();
  });

  const plKey = (t) => (t || "").trim().toLowerCase().replace(/\s+/g, "_");

  async function loadPromptLib() {
    try {
      const [res, meta] = await Promise.all([
        get("/api/prompt-library"),
        get("/api/prompt-library/meta"),
      ]);
      plItems = res.items || [];
      plMeta = meta || plMeta;
      renderPromptChips();
      await translatePromptLib(plItems.map((it) => it.text));
    } catch (e) {
      toast("读取提示词库失败: " + e.message, "error");
    }
  }

  /** 部分更新提示词库元数据 (隐藏标签/分类, 分类排序) */
  async function savePlMeta(patch) {
    try {
      plMeta = await post("/api/prompt-library/meta", patch);
    } catch (e) { toast(e.message, "error"); }
  }

  /** 分类下拉: 与新建卡片一致的形式 (选择已有 / 直接输入新建) */
  function togglePlCatDropdown() {
    const dd = plCatWrap.querySelector(".wc-type-dd");
    if (dd) { dd.remove(); return; }
    document.querySelectorAll(".wc-type-dd").forEach((x) => x.remove());
    const cats = [...new Set(plItems.map((it) => it.category || "默认"))];
    const list = el("div", { class: "wc-type-dd" }, cats.map((c) =>
      el("div", { class: "wc-type-item", text: "📁 " + c, onclick: () => { plCatInput.value = c; dd.remove(); } })));
    if (!cats.length) list.append(el("div", { class: "muted", style: "padding:10px;text-align:center;", text: "暂无已有分类, 直接输入即新建" }));
    plCatWrap.append(list);
  }
  const closePlCatDd = (e) => {
    if (e.target instanceof Element && !plCatWrap.contains(e.target)) plCatWrap.querySelector(".wc-type-dd")?.remove();
  };
  document.addEventListener("click", closePlCatDd);

  async function translatePromptLib(texts) {
    const missing = texts.filter((t) => !plZh.has(plKey(t)));
    if (!missing.length) return;
    try {
      const r = await post("/api/suggest/translate", { tags: missing });
      Object.entries(r.translations || {}).forEach(([k, v]) => plZh.set(plKey(k), v || ""));
      renderPromptChips();
    } catch { /* 翻译失败静默 */ }
  }

  function renderPromptChips() {
    clear(builtinBox);
    const kw = plKeyword.trim().toLowerCase();
    const hiddenTags = new Set(plMeta.hidden_tags || []);
    const hiddenCats = new Set(plMeta.hidden_categories || []);
    const order = plMeta.category_order || [];
    let shown = 0;
    const groups = [];
    // 内置分组 (可隐藏分类/标签)
    for (const group of builtinPromptGroups) {
      if (hiddenCats.has(group.name)) continue;
      const tags = group.tags.filter(([en, zh]) =>
        !hiddenTags.has(en) && (!kw || en.toLowerCase().includes(kw) || (zh || "").toLowerCase().includes(kw)));
      if (!tags.length) continue;
      shown += tags.length;
      groups.push({
        key: group.name,
        name: `${group.name} (${tags.length})`,
        chips: tags.map(([en, zh]) => makePromptChip(en, zh, { builtin: en })),
        builtinCat: group.name,
        builtinCount: tags.length,
      });
    }
    // 用户收藏分组 (与内置同样式; 分类和单条均可删除)
    const userGroups = new Map();
    plItems.forEach((it) => {
      const cat = it.category || "默认";
      if (hiddenCats.has(cat)) return;
      if (!userGroups.has(cat)) userGroups.set(cat, []);
      userGroups.get(cat).push(it);
    });
    userGroups.forEach((items, cat) => {
      const visible = items.filter((it) => !kw || it.text.toLowerCase().includes(kw) || cat.toLowerCase().includes(kw));
      if (!visible.length) return;
      shown += visible.length;
      groups.push({
        key: cat,
        name: `📁 ${cat} (${visible.length})`,
        chips: visible.map((it) => makePromptChip(it.text, plZh.get(plKey(it.text)) || "", { userItem: it })),
        userCat: cat,
        userCount: items.length,
      });
    });
    // 应用自定义排序 (未排序的按原顺序追加在后)
    const rank = (key) => {
      const i = order.indexOf(key);
      return i === -1 ? 9999 : i;
    };
    groups.sort((a, b) => rank(a.key) - rank(b.key));
    groups.forEach((g) => builtinBox.append(buildGroupRow(g)));
    if (!shown) builtinBox.append(el("div", { class: "gallery-empty", text: "没有匹配的提示词" }));
    syncBuiltinSelBar();
  }

  /** 一个横向标签分组行: 分类名 (拖拽排序 + 悬停显示删除) + 标签行 */
  function buildGroupRow(g) {
    const nameCell = el("div", {
      class: "wc-pl-group-name wc-pl-group-drag",
      title: "拖动调整分类顺序",
      draggable: true,
    }, [el("span", { class: "wc-pl-group-title", text: g.name })]);
    if (g.builtinCat != null) {
      // 自带分类: 悬停显示隐藏按钮 (可编辑 meta 文件恢复)
      nameCell.append(el("span", {
        class: "wc-pl-chip-del", text: "✕", title: "隐藏该自带分类 (含全部标签)",
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await confirmDialog(`隐藏自带分类「${g.builtinCat}」(含 ${g.builtinCount} 个标签)? 恢复需编辑 outputs/prompt_library_meta.json。`, { danger: true });
          if (!ok) return;
          await savePlMeta({ hidden_categories: [...new Set([...(plMeta.hidden_categories || []), g.builtinCat])] });
          renderPromptChips();
          toast(`自带分类「${g.builtinCat}」已隐藏 🫥`, "success");
        },
      }));
    }
    if (g.userCat != null) {
      // 用户分类: 悬停显示删除按钮 (连带所有收藏)
      nameCell.append(el("span", {
        class: "wc-pl-chip-del", text: "🗑", title: "删除该分类及其中所有收藏 (不可恢复)",
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await confirmDialog(`确定删除分类「${g.userCat}」? 其中 ${g.userCount} 条收藏将一并删除, 不可恢复。`, { danger: true });
          if (!ok) return;
          try {
            const res = await post("/api/prompt-library/delete-category", { category: g.userCat });
            plItems = res.items || [];
            renderPromptChips();
            toast(`分类「${g.userCat}」已删除 🗑️`, "success");
          } catch (err) { toast(err.message, "error"); }
        },
      }));
    }
    const row = el("div", { class: "wc-pl-group", "data-key": g.key }, [
      nameCell,
      el("div", { class: "wc-pl-group-tags" }, g.chips),
    ]);
    // 拖拽排序: 按住分类名拖动
    nameCell.addEventListener("dragstart", (e) => {
      plDragKey = g.key;
      row.classList.add("pl-dragging");
      try {
        e.dataTransfer.setData("text/plain", g.key);
        e.dataTransfer.effectAllowed = "move";
      } catch { /* 忽略 */ }
    });
    nameCell.addEventListener("dragend", () => {
      plDragKey = null;
      row.classList.remove("pl-dragging");
      clearPlDropMarks();
    });
    return row;
  }

  // ---- 提示词分类拖拽排序 ----
  let plDragKey = null;
  let plDropTargetKey = null;

  function clearPlDropMarks() {
    $$(".wc-pl-group.drop-before", builtinBox).forEach((x) => x.classList.remove("drop-before"));
  }

  builtinBox.addEventListener("dragover", (e) => {
    if (!plDragKey) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rows = [...builtinBox.querySelectorAll(".wc-pl-group")];
    let target = null;
    for (const r of rows) {
      if (r.dataset.key === plDragKey) continue;
      const rect = r.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { target = r; break; }
    }
    clearPlDropMarks();
    (target || rows[rows.length - 1])?.classList.add("drop-before");
    plDropTargetKey = target ? target.dataset.key : "__end__";
  });
  builtinBox.addEventListener("dragleave", (e) => {
    if (!builtinBox.contains(e.relatedTarget)) clearPlDropMarks();
  });
  builtinBox.addEventListener("drop", async (e) => {
    if (!plDragKey) return;
    e.preventDefault();
    const key = plDragKey;
    plDragKey = null;
    clearPlDropMarks();
    // 完整分类键序 = 可见组 (内置+用户) + 隐藏分类补尾
    const hidden = new Set(plMeta.hidden_categories || []);
    const allKeys = [];
    for (const g of builtinPromptGroups) {
      if (!hidden.has(g.name) && !allKeys.includes(g.name)) allKeys.push(g.name);
    }
    plItems.forEach((it) => {
      const c = it.category || "默认";
      if (!hidden.has(c) && !allKeys.includes(c)) allKeys.push(c);
    });
    (plMeta.hidden_categories || []).forEach((c) => { if (!allKeys.includes(c)) allKeys.push(c); });
    const prev = plMeta.category_order || [];
    const rank = (k) => {
      const i = prev.indexOf(k);
      return i === -1 ? 9999 : i;
    };
    const ordered = [...allKeys].sort((a, b) => rank(a) - rank(b));
    const without = ordered.filter((k) => k !== key);
    let at = plDropTargetKey === "__end__" ? without.length : without.indexOf(plDropTargetKey);
    if (at < 0) at = without.length;
    without.splice(at, 0, key);
    plDropTargetKey = null;
    await savePlMeta({ category_order: without });
    renderPromptChips();
    toast("分类顺序已保存 ↕️", "success");
  });

  /** 提示词标签: 内置与用户通用; 悬停可删除 (内置为隐藏, 用户为真删除) */
  function makePromptChip(en, zh, opts = {}) {
    const chip = el("span", {
      class: "wc-pl-chip" + (builtinSel.has(en) ? " selected" : ""),
      title: zh ? `${en} · ${zh}` : en,
    }, [
      el("span", { text: en }),
      zh ? el("span", { class: "wc-pl-chip-zh", text: zh }) : null,
    ]);
    if (opts.userItem) {
      chip.append(el("span", {
        class: "wc-pl-chip-del", text: "✕", title: "从库中删除这条收藏",
        onclick: async (e) => {
          e.stopPropagation();
          try {
            const res = await post("/api/prompt-library/delete", { text: en });
            plItems = res.items || [];
            builtinSel.delete(en);
            promptSelection.set([...builtinSel]);
            renderPromptChips();
            toast("已从提示词库删除 🗑️", "success");
          } catch (err) { toast(err.message, "error"); }
        },
      }));
    } else if (opts.builtin) {
      chip.append(el("span", {
        class: "wc-pl-chip-del", text: "✕", title: "隐藏该自带标签 (可编辑 meta 文件恢复)",
        onclick: async (e) => {
          e.stopPropagation();
          await savePlMeta({ hidden_tags: [...new Set([...(plMeta.hidden_tags || []), en])] });
          builtinSel.delete(en);
          promptSelection.set([...builtinSel]);
          renderPromptChips();
          toast(`自带标签「${en}」已隐藏 🫥`, "success");
        },
      }));
    }
    chip.addEventListener("click", () => {
      if (builtinSel.has(en)) builtinSel.delete(en);
      else builtinSel.add(en);
      // 共享给弹窗的 "添加选中/清除选择" 按钮 (onChange 里统一重渲染)
      promptSelection.set([...builtinSel]);
    });
    return chip;
  }

  /** 把一段文字追加到当前提示词 (提示词库使用) (提示词库使用) */
  function addToPromptText(text) {
    if (!opts.addTarget) return;
    const cur = (opts.addTarget.get() || "").trim().replace(/,\s*$/, "");
    opts.addTarget.set(cur ? `${cur}, ${text}` : text);
    toast("已添加到提示词 🌸", "success");
  }

  async function savePromptLib() {
    const text = plInput.value.trim();
    if (!text) { toast("请输入要收藏的关键词", "warning"); return; }
    const category = plCatInput.value.trim() || "默认";
    try {
      const res = await post("/api/prompt-library/add", { text, category });
      plItems = res.items || [];
      plInput.value = "";
      renderPromptChips();
      await translatePromptLib(plItems.map((it) => it.text));
      toast(`已保存到提示词库「${category}」📚`, "success");
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------------- 数据加载 ----------------
  let allTypes = [];

  async function loadTypes() {
    const res = await get("/api/wildcards/types");
    allTypes = res.types || [];
    clear(typeList);
    allTypes.forEach((t) => {
      const tab = el("button", { class: "tab-btn" + (t === state.type ? " active" : ""), title: t, "data-key": t });
      tab.draggable = true;
      tab.addEventListener("dragstart", (e) => {
        typeDragKey = t;
        tab.classList.add("dragging");
        try {
          e.dataTransfer.setData("text/plain", t);
          e.dataTransfer.effectAllowed = "move";
        } catch { /* 忽略 */ }
      });
      tab.addEventListener("dragend", () => {
        typeDragKey = null;
        tab.classList.remove("dragging");
        $$(".tab-btn.drop-before", typeList).forEach((x) => x.classList.remove("drop-before"));
      });
      tab.append(el("span", { text: "📁 " + t }));
      // 悬停显示删除分类按钮 (文件夹连同卡片移到回收站)
      tab.append(el("span", {
        class: "wc-type-del", text: "✕", title: `删除分类 <${t}> (卡片移到回收站)`,
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await confirmDialog(`确定删除分类「${t}」? 该分类下的所有卡片和封面将移到回收站。`, { danger: true });
          if (!ok) return;
          try {
            await post("/api/wildcards/delete-type", { type: t });
            toast(`分类 <${t}> 已删除 (移到回收站) 🗑️`, "success");
            if (state.type === t) { state.type = null; renderEditPlaceholder(); }
            selection.clear();
            await loadTypes();
            await loadCards();
            syncSelection();
          } catch (err) { toast(err.message, "error"); }
        },
      }));
      tab.addEventListener("click", async () => {
        state.type = t;
        state.name = null;
        state.lastIdx = -1;
        selection.clear();
        await loadTypes();
        await loadCards();
        syncSelection();
      });
      typeList.append(tab);
    });
  }

  async function loadCards() {
    if (!state.type) { allCards = []; renderGrid(); return; }
    const res = await get(`/api/wildcards/${encodeURIComponent(state.type)}/cards`);
    allCards = res.cards || [];
    renderGrid();
  }

  function renderGrid() {
    clear(grid);
    if (!state.type) {
      visibleCards = [];
      countEl.textContent = "";
      grid.append(el("div", { class: "gallery-empty", text: "请选择一个分类" }));
      return;
    }
    const kw = state.keyword.trim().toLowerCase();
    // 特殊卡片: 随机 / 顺序 (与 ANR 原项目一致, 只在无搜索词时展示)
    const specials = kw ? [] : [
      { name: "随机", cover: null, tags: "随机抽取一张卡片", special: true },
      { name: "顺序", cover: null, tags: "按文件名顺序轮流使用", special: true },
    ];
    const filtered = kw ? allCards.filter((c) => c.name.toLowerCase().includes(kw)) : allCards;
    visibleCards = [...specials, ...filtered];
    countEl.textContent = state.type ? `${state.type} · ${visibleCards.length} / ${allCards.length} 张卡片` : "";
    if (!visibleCards.length) {
      grid.append(el("div", { class: "gallery-empty", text: !state.type ? "请选择一个分类" : (kw ? "没有匹配的卡片" : "该分类暂无卡片") }));
      return;
    }
    visibleCards.forEach((card) => grid.append(renderCard(card)));
    syncSelectionClasses();
  }

  searchBox.addEventListener("input", () => {
    state.keyword = searchBox.value;
    renderGrid();
  });

  // ---------------- 卡片多选 / 拖拽 ----------------
  function syncSelection() {
    cardSelection.set(state.type, [...selection]);
    syncSelectionClasses();
  }

  function syncSelectionClasses() {
    $$(".wildcard-card", grid).forEach((c) => c.classList.toggle("selected", selection.has(c.dataset.name)));
    const n = selection.size;
    selText.textContent = n ? `已选 ${n} 张卡片 — 拖入上方提示词, 或点右上角 "➕ 添加选中"` : "";
    selBar.classList.toggle("hidden", !n);
  }

  function renderCard(card) {
    const item = el("div", {
      class: "wildcard-card" + (card.special ? " wildcard-special" : ""),
      title: card.tags || card.name,
      draggable: true,
    });
    item.dataset.name = card.name;
    item.append(el("span", { class: "wc-check", text: "✓" }));
    if (card.cover) {
      // bust=true 强制刷新, 避免覆盖封面后浏览器仍显示旧图
      item.append(el("div", { class: "wc-cover" }, [el("img", { src: imageUrl(card.cover, true), alt: card.name, loading: "lazy" })]));
    } else {
      item.append(el("div", { class: "wc-cover wc-cover-empty" }, [el("span", { text: card.special ? (card.name === "随机" ? "🎲" : "🔁") : "🃏" })]));
    }
    item.append(el("div", { class: "wc-name", text: card.name }));
    item.append(el("div", { class: "wc-tags", text: (card.tags || "空").slice(0, 40) || "空" }));

    item.addEventListener("click", (e) => {
      const idx = visibleCards.findIndex((c) => c.name === card.name);
      if (e.ctrlKey || e.metaKey) {
        if (selection.has(card.name)) selection.delete(card.name);
        else selection.add(card.name);
        state.lastIdx = idx;
        syncSelection();
        return;
      }
      if (e.shiftKey && state.lastIdx >= 0 && idx >= 0) {
        const [a, b] = [Math.min(state.lastIdx, idx), Math.max(state.lastIdx, idx)];
        selection.clear();
        visibleCards.slice(a, b + 1).forEach((c) => selection.add(c.name));
        syncSelection();
        return;
      }
      // 普通点击: 编辑该卡片, 并将其设为唯一选中
      selection.clear();
      selection.add(card.name);
      state.lastIdx = idx;
      syncSelection();
      selectCard(card.name);
    });

    item.addEventListener("dragstart", (e) => {
      if (!selection.has(card.name)) {
        selection.clear();
        selection.add(card.name);
        syncSelection();
      }
      cardDrag.type = state.type;
      cardDrag.names = [...selection];
      try {
        e.dataTransfer.setData("text/plain", cardDrag.names.join(","));
        e.dataTransfer.effectAllowed = "copy";
      } catch { /* 某些浏览器限制, 忽略 */ }
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      cardDrag.type = null;
      cardDrag.names = [];
    });
    return item;
  }

  // ---------------- 选中卡片 -> 编辑区 ----------------
  async function selectCard(name) {
    state.name = name;
    clear(editCard);
    const isSpecial = name === "随机" || name === "顺序";
    const nameInput = el("input", { type: "text", value: name, readonly: isSpecial });
    const tagsInput = el("textarea", { rows: 4, placeholder: "提示词内容" });
    if (isSpecial) {
      tagsInput.value = `<${state.type}:${name}>`;
    } else {
      const res = await get(`/api/wildcards/${encodeURIComponent(state.type)}/${encodeURIComponent(name)}`);
      tagsInput.value = res.tags || "";
    }

    // 封面区 (特殊卡片 随机/顺序 无封面, 跳过)
    let coverBox = null;
    if (!isSpecial) {
      coverBox = el("div", { style: "margin:4px 0 8px;" });
      const coverImg = el("img", { style: "display:none;max-height:120px;border-radius:var(--radius-sm);border:1px solid var(--border);" });
      const coverFile = el("input", { type: "file", accept: "image/*", style: "display:none;" });
      const coverBtn = el("button", { class: "btn btn-sm btn-file", text: "🖼️ 上传封面" });
      const curCover = allCards.find((c) => c.name === name)?.cover;
      if (curCover) { coverImg.src = imageUrl(curCover); coverImg.style.display = ""; }
      coverBtn.addEventListener("click", () => coverFile.click());
      coverFile.addEventListener("change", async () => {
        if (!coverFile.files.length) return;
        try {
          const form = new FormData();
          form.append("file", coverFile.files[0]);
          const res = await fetch(`/api/wildcards/${encodeURIComponent(state.type)}/${encodeURIComponent(name)}/cover`, { method: "POST", body: form });
          if (!res.ok) throw new Error("上传失败");
          const data = await res.json();
          coverImg.src = imageUrl(data.cover);
          coverImg.style.display = "";
          toast("封面已保存 🖼️", "success");
          await loadCards();
        } catch (e) {
          toast("封面上传失败: " + e.message, "error");
        }
        coverFile.value = "";
      });
      // "使用当前图片作为封面": 将本次生成的最后一张图片设为封面
      const lastImgBtn = el("button", { class: "btn btn-sm", text: "🖼️ 使用当前图片作为封面", title: "将本次生成的最后一张图片设为该卡片封面" });
      lastImgBtn.addEventListener("click", async () => {
        if (!state.type || !name) { toast("请先选择卡片", "warning"); return; }
        const imgPath = getCurrentOutputImage();
        if (!imgPath) { toast("尚未生成图片", "warning"); return; }
        try {
          const url = "/api/wildcards/" + encodeURIComponent(state.type) + "/" + encodeURIComponent(name) + "/cover-from-image";
          const res = await post(url, { image_path: imgPath });
          coverImg.src = imageUrl(res.cover, true); // 强制刷新, 避免已存在封面不更新
          coverImg.style.display = "";
          toast("封面已保存 🖼️", "success");
          await loadCards();
        } catch (e) {
          toast("设置封面失败: " + e.message, "error");
        }
      });
      coverBox.append(coverImg, el("div", { style: "display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;" }, [coverBtn, lastImgBtn, coverFile]));
    }

    const actRow = el("div", { class: "wc-edit-actions" });
    // 弹窗模式: 把卡片写回打开此窗口的那个提示词输入框
    if (opts.addTarget) {
      actRow.append(el("button", {
        class: "btn btn-sm btn-primary",
        text: "➕ 添加到当前输入框",
        title: "添加到打开此窗口的提示词输入框",
        onclick: () => addToTarget(name),
      }));
    }
    // 特殊卡片 (随机/顺序) 是占位指令, 不可保存或删除
    if (!isSpecial) {
      actRow.append(
        el("button", { class: "btn btn-sm", text: "💾 保存修改", onclick: () => saveCard(name, tagsInput) }),
        el("button", { class: "btn btn-sm btn-danger", text: "🗑️ 删除", onclick: () => deleteCard(name) }),
      );
    } else {
      actRow.append(el("span", { class: "muted", style: "width:100%;font-size:12.5px;", text: "将生成 <" + state.type + ":" + name + ">, 生成时会" + (name === "随机" ? "随机抽取" : "按文件名顺序轮流使用") + "该分类下的一张卡片" }));
    }

    editCard.append(
      el("div", { class: "card-title", text: `✏️ <${state.type}:${name}>` }),
      coverBox,
      el("div", { class: "field" }, [el("label", { text: "名称" }), nameInput]),
      isSpecial ? null : wireTagsField(tagsInput),
      actRow,
    );
  }

  function wireTagsField(ta) {
    const f = el("div", { class: "field" });
    f.append(el("label", { text: "包含的提示词" }), ta);
    wireAutocomplete(ta, f);
    return f;
  }

  async function addToTarget(name) {
    if (!state.type || !name) { toast("请先选择卡片", "warning"); return; }
    if (!opts.addTarget) return;
    try {
      const res = await post("/api/wildcards/add-to-prompt", { prompt: opts.addTarget.get(), type: state.type, name });
      opts.addTarget.set(res.prompt);
      toast(`已添加 <${state.type}:${name}> 到当前输入框 🌸`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function saveCard(name, tagsInput) {
    if (!state.type || !name) { toast("请先选择卡片", "warning"); return; }
    await post("/api/wildcards", { type: state.type, name, tags: tagsInput.value });
    toast(`已保存 <${state.type}:${name}> 💾`, "success");
    await loadCards();
  }

  async function deleteCard(name) {
    if (!state.type || !name) { toast("请先选择卡片", "warning"); return; }
    await del(`/api/wildcards/${encodeURIComponent(state.type)}/${encodeURIComponent(name)}`);
    toast("已删除 (移到回收站) 🗑️", "success");
    selection.delete(name);
    renderEditPlaceholder();
    syncSelection();
    await loadCards();
  }

  /** 编辑区占位 (未选中任何卡片) */
  function renderEditPlaceholder() {
    state.name = null;
    clear(editCard);
    editCard.append(
      el("div", { class: "card-title", text: "✏️ 编辑卡片" }),
      el("div", { class: "muted", text: "从左侧选择一张卡片后在此编辑。Ctrl+点击多选, Shift+点击范围选; 选中后可拖入上方提示词或点 \"添加选中\"" }),
    );
  }

  /** 新建卡片: 在右侧编辑区展示完整表单 (分类可选已有分类或自行输入) */
  function showCreate() {
    state.name = null;
    clear(editCard);
    const typeInput = el("input", { type: "text", placeholder: "从下拉选择已有分类, 或输入新分类" });
    const typeWrap = el("div", { class: "wc-type-wrap" }, [typeInput, el("button", {
      class: "wc-type-caret",
      type: "button",
      text: "▾",
      title: "选择已有分类",
      onclick: (e) => { e.stopPropagation(); toggleTypeDropdown(typeWrap); },
    })]);
    const nameInput = el("input", { type: "text", placeholder: "新卡片名" });
    const tagsInput = el("textarea", { rows: 8, placeholder: "提示词内容 (逗号分隔多个标签, 支持自动补全)" });
    // "添加当前提示词": 把上方提示词编辑器中的当前内容填入此输入框 (已有时追加)
    const addCurBtn = el("button", {
      class: "btn btn-sm btn-file",
      type: "button",
      text: "➕ 添加当前提示词",
      title: "把上方提示词编辑器中的当前内容填入此输入框",
      onclick: () => {
        const cur = (opts.addTarget?.get() || "").trim();
        if (!cur) { toast("上方提示词为空, 没有可添加的内容", "warning"); return; }
        const existing = tagsInput.value.trim().replace(/,\s*$/, "");
        tagsInput.value = existing ? `${existing}, ${cur}` : cur;
        tagsInput.dispatchEvent(new Event("input", { bubbles: true }));
        toast("已填入当前提示词 🌸", "success");
      },
    });

    editCard.append(
      el("div", { class: "card-title", text: "✨ 新建卡片" }),
      el("div", { class: "field" }, [el("label", { text: "分类" }), typeWrap]),
      el("div", { class: "field" }, [el("label", { text: "名称" }), nameInput]),
      el("div", { class: "field" }, [el("label", { text: "提示词" }), tagsInput]),
      el("div", { class: "wc-edit-actions" }, [
        addCurBtn,
        el("button", { class: "btn btn-sm btn-primary", text: "✅ 创建", onclick: () => createCard(typeInput, nameInput, tagsInput) }),
        el("button", { class: "btn btn-sm btn-ghost", text: "✖ 取消", onclick: renderEditPlaceholder }),
      ]),
    );
    typeInput.focus();

    // 统一样式的分类下拉: 与 WebUI 其它下拉菜单观感一致
    function toggleTypeDropdown(wrap) {
      const dd = wrap.querySelector(".wc-type-dd");
      if (dd) { dd.remove(); return; }
      document.querySelectorAll(".wc-type-dd").forEach((x) => x.remove());
      const list = el("div", { class: "wc-type-dd" }, (allTypes || []).map((t) =>
        el("div", { class: "wc-type-item", text: "📁 " + t, onclick: () => { typeInput.value = t; dd.remove(); } })
      ));
      if (!(allTypes || []).length) list.append(el("div", { class: "muted", style: "padding:10px;text-align:center;", text: "暂无已有分类" }));
      wrap.append(list);
    }
    const closeTypeDd = (e) => {
      const wrap = editCard.querySelector(".wc-type-wrap");
      if (wrap && e.target instanceof Element && !wrap.contains(e.target)) wrap.querySelector(".wc-type-dd")?.remove();
    };
    document.addEventListener("click", closeTypeDd);
  }

  async function createCard(typeInput, nameInput, tagsInput) {
    const type = typeInput.value.trim();
    const name = nameInput.value.trim();
    const tags = tagsInput.value;
    if (!type || !name) { toast("分类和名称不能为空", "warning"); return; }
    await post("/api/wildcards", { type, name, tags });
    toast(`已创建 <${type}:${name}> ✨`, "success");
    typeInput.value = "";
    nameInput.value = "";
    tagsInput.value = "";
    state.type = type;
    await loadTypes();
    await loadCards();
  }

  renderEditPlaceholder();
  await loadTypes();
  await loadCards();
}

// 兼容旧入口
export async function render(container, ctx) {
  return renderPanel(container, ctx);
}

export function onShow() {}
