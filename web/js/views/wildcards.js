// ============================================================
// Wildcards 面板 (嵌入 Wildcards 全屏弹窗)
//   左: 卡片库 (分类页签 / 搜索 / 多选 / 拖拽)   右: 卡片编辑
//   卡片多选状态通过 cardSelection 共享给弹窗 ("添加选中" 按钮),
//   拖拽中的卡片通过 cardDrag 共享给弹窗的提示词编辑器投放。
//   交互: 普通点击=编辑并单选, Ctrl+点击=多选, Shift+点击=范围多选,
//         选中后可拖入上方提示词, 或点弹窗的 "➕ 添加选中"。
//   封面约定: 卡片同目录下的 <名称>.png/jpg/webp 即为其封面
// ============================================================
import { $, $$, el, clear, toast, wireAutocomplete } from "../ui.js";
import { get, post, del, imageUrl } from "../api.js";
import { getCurrentOutputImage } from "./generate.js";

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

export async function renderPanel(container, ctx, opts = {}) {
  S = ctx;
  clear(container);
  cardSelection.set(null, []);
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
    el("button", {
      class: "btn btn-sm btn-ghost",
      text: "✖ 清除选择",
      onclick: () => { selection.clear(); state.lastIdx = -1; syncSelection(); },
    }),
  ]);

  const libTabs = el("div", { class: "wc-lib-tabs" }, [
    el("button", { class: "tab-btn active", text: "🗂️ 卡片库", onclick: () => switchLib("cards") }),
    el("button", { class: "tab-btn", text: "📚 提示词库", onclick: () => switchLib("prompts") }),
  ]);
  const cardLibBox = el("div", {}, [typeList, searchBox, grid, selBar]);
  const plList = el("div", { class: "wc-pl-list" });
  const plSearch = el("input", { type: "text", class: "wc-search", placeholder: "🔍 搜索提示词..." });
  plSearch.addEventListener("input", () => { plKeyword = plSearch.value; renderPromptLib(); });
  const plInput = el("input", { type: "text", placeholder: "输入关键词, 保存后可随时加入提示词" });
  plInput.addEventListener("keydown", (e) => { if (e.key === "Enter") savePromptLib(); });
  const promptLibBox = el("div", { class: "hidden" }, [
    el("div", { style: "display:flex;gap:6px;margin-bottom:10px;" }, [
      plInput,
      el("button", { class: "btn btn-sm btn-primary", text: "💾 保存", onclick: savePromptLib }),
    ]),
    plSearch,
    plList,
  ]);

  const browseCard = el("div", { class: "card wc-browse" }, [
    el("div", { class: "wc-browse-head" }, [
      el("div", { class: "card-title", text: "🗂️ 素材库" }),
      countEl,
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-sm", text: "➕ 新建卡片", onclick: () => { switchLib("cards"); showCreate(); } }),
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

  function switchLib(which) {
    const isCards = which === "cards";
    [...libTabs.children].forEach((b, i) => b.classList.toggle("active", i === 0 === isCards));
    cardLibBox.classList.toggle("hidden", !isCards);
    promptLibBox.classList.toggle("hidden", isCards);
    if (!isCards && !plLoaded) { plLoaded = true; loadPromptLib(); }
  }

  const plKey = (t) => (t || "").trim().toLowerCase().replace(/\s+/g, "_");

  async function loadPromptLib() {
    try {
      const res = await get("/api/prompt-library");
      plItems = res.items || [];
      renderPromptLib();
      await translatePromptLib(plItems);
    } catch (e) {
      toast("读取提示词库失败: " + e.message, "error");
    }
  }

  async function translatePromptLib(items) {
    const missing = items.filter((t) => !plZh.has(plKey(t)));
    if (!missing.length) return;
    try {
      const r = await post("/api/suggest/translate", { tags: missing });
      Object.entries(r.translations || {}).forEach(([k, v]) => plZh.set(plKey(k), v || ""));
      renderPromptLib();
    } catch { /* 翻译失败静默 */ }
  }

  function renderPromptLib() {
    clear(plList);
    const kw = plKeyword.trim().toLowerCase();
    const list = plItems.filter((t) => !kw || t.toLowerCase().includes(kw));
    if (!list.length) {
      plList.append(el("div", { class: "gallery-empty", text: "暂无收藏 — 输入关键词后保存到库中" }));
      return;
    }
    list.forEach((text) => {
      const zh = plZh.get(plKey(text)) || "";
      const row = el("div", { class: "wc-pl-item", title: text + (zh ? " · " + zh : "") }, [
        el("div", { class: "wc-pl-text" }, [
          el("span", { class: "wc-pl-en", text }),
          zh ? el("span", { class: "wc-pl-zh", text: zh }) : null,
        ]),
        el("button", { class: "btn btn-sm", text: "➕", title: "添加到提示词", onclick: (e) => { e.stopPropagation(); addToPromptText(text); } }),
        el("button", { class: "btn btn-sm btn-clear-file", text: "🗑", title: "从库中删除", onclick: async (e) => {
          e.stopPropagation();
          try {
            const res = await post("/api/prompt-library/delete", { text });
            plItems = res.items || [];
            renderPromptLib();
            toast("已从提示词库删除 🗑️", "success");
          } catch (err) { toast(err.message, "error"); }
        } }),
      ]);
      row.addEventListener("click", () => addToPromptText(text));
      plList.append(row);
    });
  }

  /** 把一段文字追加到当前提示词 (提示词库使用) */
  function addToPromptText(text) {
    if (!opts.addTarget) return;
    const cur = (opts.addTarget.get() || "").trim().replace(/,\s*$/, "");
    opts.addTarget.set(cur ? `${cur}, ${text}` : text);
    toast("已添加到提示词 🌸", "success");
  }

  async function savePromptLib() {
    const text = plInput.value.trim();
    if (!text) { toast("请输入要收藏的关键词", "warning"); return; }
    try {
      const res = await post("/api/prompt-library/add", { text });
      plItems = res.items || [];
      plInput.value = "";
      renderPromptLib();
      await translatePromptLib(plItems);
      toast("已保存到提示词库 📚", "success");
    } catch (e) { toast(e.message, "error"); }
  }

  // ---------------- 数据加载 ----------------
  let allTypes = [];

  async function loadTypes() {
    const res = await get("/api/wildcards/types");
    allTypes = res.types || [];
    clear(typeList);
    allTypes.forEach((t) => {
      typeList.append(el("button", {
        class: "tab-btn" + (t === state.type ? " active" : ""),
        text: "📁 " + t,
        onclick: async () => {
          state.type = t;
          state.name = null;
          state.lastIdx = -1;
          selection.clear();
          await loadTypes();
          await loadCards();
          syncSelection();
        },
      }));
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
