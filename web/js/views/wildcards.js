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
  const newType = el("input", { type: "text", placeholder: "新分类" });
  const newName = el("input", { type: "text", placeholder: "新卡片名" });
  const newTags = el("input", { type: "text", placeholder: "提示词内容 (逗号分隔多个标签)" });
  // "添加当前提示词": 把上方提示词编辑器中的当前内容填入此输入框 (已有时追加)
  const addCurBtn = el("button", {
    class: "btn btn-sm btn-file",
    type: "button",
    text: "➕ 添加当前提示词",
    title: "把上方提示词编辑器中的当前内容填入此输入框",
    onclick: () => {
      const cur = (opts.addTarget?.get() || "").trim();
      if (!cur) { toast("上方提示词为空, 没有可添加的内容", "warning"); return; }
      const existing = newTags.value.trim().replace(/,\s*$/, "");
      newTags.value = existing ? `${existing}, ${cur}` : cur;
      newTags.dispatchEvent(new Event("input", { bubbles: true }));
      toast("已填入当前提示词 🌸", "success");
    },
  });
  const createRow = el("div", { class: "wc-create-row hidden" }, [
    el("div", { class: "field" }, [el("label", { text: "分类" }), newType]),
    el("div", { class: "field" }, [el("label", { text: "名称" }), newName]),
    el("div", { class: "field" }, [
      el("label", { text: "提示词" }),
      el("div", { style: "display:flex;gap:6px;align-items:center;" }, [newTags, addCurBtn]),
    ]),
    el("button", { class: "btn btn-sm btn-primary", text: "✅ 创建", onclick: () => createCard() }),
    el("button", { class: "btn btn-sm btn-ghost", text: "✖", title: "收起", onclick: () => createRow.classList.add("hidden") }),
  ]);
  function toggleCreate() {
    createRow.classList.toggle("hidden");
    if (!createRow.classList.contains("hidden")) newType.focus();
  }

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

  const browseCard = el("div", { class: "card wc-browse" }, [
    el("div", { class: "wc-browse-head" }, [
      el("div", { class: "card-title", text: "🗂️ 卡片库" }),
      countEl,
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-sm", text: "➕ 新建卡片", onclick: toggleCreate }),
    ]),
    createRow,
    typeList,
    searchBox,
    grid,
    selBar,
  ]);

  // ---------------- 右: 卡片编辑 ----------------
  const editCard = el("div", { class: "card wc-edit" }, [
    el("div", { class: "card-title", text: "✏️ 编辑卡片" }),
    el("div", { class: "muted", text: "从左侧选择一张卡片后在此编辑。Ctrl+点击多选, Shift+点击范围选; 选中后可拖入上方提示词或点 \"添加选中\"" }),
  ]);

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

  // ---------------- 数据加载 ----------------
  async function loadTypes() {
    const res = await get("/api/wildcards/types");
    clear(typeList);
    (res.types || []).forEach((t) => {
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
      const coverImg = el("img", { style: "display:none;max-height:120px;border-radius:10px;border:1px solid var(--border);" });
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
    clear(editCard);
    editCard.append(
      el("div", { class: "card-title", text: "✏️ 编辑卡片" }),
      el("div", { class: "muted", text: "从左侧选择一张卡片后在此编辑" }),
    );
    syncSelection();
    await loadCards();
  }

  async function createCard() {
    const type = newType.value.trim();
    const name = newName.value.trim();
    const tags = newTags.value;
    if (!type || !name) { toast("分类和名称不能为空", "warning"); return; }
    await post("/api/wildcards", { type, name, tags });
    toast(`已创建 <${type}:${name}> ✨`, "success");
    newType.value = "";
    newName.value = "";
    newTags.value = "";
    createRow.classList.add("hidden");
    state.type = type;
    await loadTypes();
    await loadCards();
  }

  await loadTypes();
  await loadCards();
}

// 兼容旧入口
export async function render(container, ctx) {
  return renderPanel(container, ctx);
}

export function onShow() {}
