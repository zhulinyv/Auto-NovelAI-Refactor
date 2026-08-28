// ============================================================
// Wildcards 面板: 嵌入生成页页签, 支持图片封面与搜索
//   封面约定: 卡片同目录下的 <名称>.png/jpg/webp 即为其封面
//   也用于 Wildcards 全屏弹窗 (wildcardsModal.js), 此时传入
//   opts.addTarget = {get, set}, 面板会出现 "添加到当前输入框" 按钮
// ============================================================
import { $, $$, el, clear, toast, wireAutocomplete } from "../ui.js";
import { get, post, del, imageUrl } from "../api.js";
import { getC, getCurrentOutputImage } from "./generate.js";

let S = null;
let state = { type: null, name: null, tags: "", keyword: "" };

export async function renderPanel(container, ctx, opts = {}) {
  S = ctx;
  clear(container);

  // ---------------- 顶部整行: 新建卡片 ----------------
  const topCard = el("div", { class: "card", style: "margin:0 0 16px;" });
  const quickGrid = el("div", { class: "grid", style: "grid-template-columns:1fr 1fr 2.2fr auto;align-items:end;gap:12px;" });
  const newType = el("input", { type: "text", placeholder: "新分类" });
  const newName = el("input", { type: "text", placeholder: "新卡片名" });
  const newTags = el("input", { type: "text", placeholder: "提示词内容" });
  quickGrid.append(
    el("div", { class: "field" }, [el("label", { text: "分类" }), newType]),
    el("div", { class: "field" }, [el("label", { text: "名称" }), newName]),
    el("div", { class: "field" }, [el("label", { text: "提示词" }), newTags]),
    el("button", { class: "btn btn-sm btn-primary", style: "height:33px;white-space:nowrap;", text: "➕ 创建", onclick: () => createCard(newType, newName, newTags) }),
  );
  topCard.append(
    el("div", { class: "card-title" }, ["✨ 新建卡片"]),
    quickGrid,
  );
  container.append(topCard);

  // ---------------- 下方左右: 选择卡片 | 编辑区 ----------------
  const browseCard = el("div", { class: "card", style: "margin:0;" });
  const typeList = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;" });
  const searchBox = el("input", { type: "text", placeholder: "🔍 搜索卡片名称... (大量卡片时快速筛选)", style: "margin-bottom:10px;width:100%;" });
  const cardGrid = el("div", { class: "grid", style: "grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px;" });
  const countBox = el("div", { class: "muted", style: "margin-bottom:8px;" });
  browseCard.append(el("div", { class: "card-title" }, ["🗂️ 选择卡片"]), typeList, searchBox, countBox, cardGrid);

  const editCard = el("div", { class: "card", style: "margin:0;min-height:220px;" }, [
    el("div", { class: "card-title" }, ["✏️ 编辑卡片"]),
    el("div", { class: "muted", text: "从左侧选择一张卡片后在此编辑" }),
  ]);

  const layout = el("div", { class: "grid", style: "grid-template-columns:1.6fr 1fr;align-items:start;gap:16px;" });
  layout.append(browseCard, editCard);
  container.append(layout);

  let allCards = [];

  // ---------------- 分类 ----------------
  async function loadTypes() {
    const res = await get("/api/wildcards/types");
    clear(typeList);
    res.types.forEach((t) => {
      typeList.append(el("button", {
        class: "tab-btn" + (t === state.type ? " active" : ""),
        text: "📁 " + t,
        onclick: async () => {
          state.type = t;
          state.name = null;
          loadTypes();
          await loadCards();
        },
      }));
    });
  }

  // ---------------- 卡片网格 (带封面 + 搜索) ----------------
  async function loadCards() {
    if (!state.type) { clear(cardGrid); countBox.textContent = ""; return; }
    const res = await get(`/api/wildcards/${encodeURIComponent(state.type)}/cards`);
    allCards = res.cards || [];
    renderGrid();
  }

  function renderGrid() {
    clear(cardGrid);
    const kw = state.keyword.trim().toLowerCase();
    // 特殊卡片: 随机 / 顺序 (与 ANR 原项目一致, 只展示在无搜索关键词时)
    const specials = kw ? [] : [
      { name: "随机", cover: null, tags: "随机抽取一张卡片" },
      { name: "顺序", cover: null, tags: "按文件名顺序轮流使用" },
    ];
    const filtered = kw ? allCards.filter((c) => c.name.toLowerCase().includes(kw)) : allCards;
    countBox.textContent = `${state.type} · ${specials.length + filtered.length} / ${allCards.length} 张卡片`;

    if (!filtered.length && !specials.length) {
      cardGrid.append(el("div", { class: "gallery-empty", text: kw ? "没有匹配的卡片" : "该分类暂无卡片" }));
      return;
    }

    specials.forEach((card) => {
      const item = el("div", {
        class: "wildcard-card wildcard-special",
        title: card.tags,
        onclick: () => selectCard(card.name),
      });
      item.append(
        el("div", { class: "wc-cover wc-cover-empty" }, [el("span", { text: card.name === "随机" ? "🎲" : "🔁" })]),
        el("div", { class: "wc-name", text: card.name }),
        el("div", { class: "wc-tags", text: card.tags }),
      );
      cardGrid.append(item);
    });

    filtered.forEach((card) => {
      const item = el("div", {
        class: "wildcard-card",
        title: card.tags || card.name,
        onclick: () => selectCard(card.name),
      });
      // 封面
      if (card.cover) {
        // bust=true 强制刷新, 避免覆盖封面后浏览器仍显示旧图
        item.append(el("div", { class: "wc-cover" }, [el("img", { src: imageUrl(card.cover, true), alt: card.name, loading: "lazy" })]));
      } else {
        item.append(el("div", { class: "wc-cover wc-cover-empty" }, [el("span", { text: "🃏" })]));
      }
      item.append(el("div", { class: "wc-name", text: card.name }));
      item.append(el("div", { class: "wc-tags", text: (card.tags || "空").slice(0, 40) || "空" }));
      cardGrid.append(item);
    });
  }

  searchBox.addEventListener("input", () => {
    state.keyword = searchBox.value;
    renderGrid();
  });

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

    const actRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;" }, [
      el("button", { class: "btn btn-sm btn-primary", text: "➕ 添加到正面提示词", onclick: () => addToPrompt(name, true) }),
      el("button", { class: "btn btn-sm", text: "🌙 添加到负面提示词", onclick: () => addToPrompt(name, false) }),
    ]);
    // 弹窗模式: 把卡片写回打开此窗口的那个提示词输入框
    if (opts.addTarget) {
      actRow.prepend(el("button", {
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
      actRow.prepend(el("span", { class: "muted", style: "width:100%;font-size:12.5px;", text: "将生成 <" + state.type + ":" + name + ">, 生成时会" + (name === "随机" ? "随机抽取" : "按文件名顺序轮流使用") + "该分类下的一张卡片" }));
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

  async function addToPrompt(name, positive) {
    if (!state.type || !name) { toast("请先选择卡片", "warning"); return; }
    const p = getC();
    if (!p) { toast("提示词区域尚未就绪", "warning"); return; }
    const current = positive ? p.positive.get() : p.negative.get();
    const res = await post("/api/wildcards/add-to-prompt", { prompt: current, type: state.type, name });
    if (positive) p.positive.set(res.prompt); else p.negative.set(res.prompt);
    toast(`已添加 <${state.type}:${name}> 到${positive ? "正面" : "负面"}提示词 🌸`, "success");
  }

  /** 弹窗模式: 添加到打开此窗口的输入框 (值由弹窗实时同步回原输入框) */
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
    clear(editCard);
    await loadCards();
  }

  async function createCard(typeInput, nameInput, tagsInput) {
    const type = typeInput.value.trim();
    const name = nameInput.value.trim();
    const tags = tagsInput.value;
    if (!type || !name) { toast("分类和名称不能为空", "warning"); return; }
    await post("/api/wildcards", { type, name, tags });
    toast(`已创建 <${type}:${name}> ✨`, "success");
    nameInput.value = "";
    tagsInput.value = "";
    state.type = type;
    await loadTypes();
    await loadCards();
  }

  await loadTypes();
}

// 兼容旧入口
export async function render(container, ctx) {
  return renderPanel(container, ctx);
}

export function onShow() {}
