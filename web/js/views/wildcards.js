// ============================================================
// Wildcards 面板 (嵌入 Wildcards 全屏弹窗)
//   左: 卡片库 (分类页签 / 搜索 / 多选 / 拖拽)   右: 卡片编辑
//   卡片多选状态通过 cardSelection 共享给弹窗 ("添加选中" 按钮),
//   拖拽中的卡片通过 cardDrag 共享给弹窗的提示词编辑器投放。
//   交互: 点击=选中/取消 (与提示词库一致), 双击=打开编辑, Shift+点击=范围选;
//         选择按分类分桶保存, 切换分类不清其它分类的选中, 可跨分类 "添加选中"。
//   封面约定: 卡片同目录下的 <名称>.png/jpg/webp 即为其封面
// ============================================================
import { $, $$, el, clear, toast, confirmDialog, inputDialog, wireAutocomplete, wildcardsButton, edgeScroll } from "../ui.js";
import { get, post, del, imageUrl } from "../api.js";
import { getCurrentOutputImage } from "./generate.js";
import { builtinPromptGroups, LEGACY_CATEGORY_NAMES } from "../data/builtinPrompts.js";

let S = null;
const state = { type: null, name: null, keyword: "", lastIdx: -1 };
// 封面刚被上传/替换过的卡片名: 只有这些需要给图片 URL 加时间戳绕开缓存。
// 原先所有封面一律带 &t=Date.now(), 导致每次渲染网格都要重新下载全部封面。
const coverBustNames = new Set();

/** 卡片多选状态 (弹窗的 "添加选中" 按钮据此批量插入提示词) */
export const cardSelection = {
  map: {},  // 分类 -> 卡片名数组 (跨分类保留, 切换分类不清空其它分类)
  _listeners: new Set(),
  set(map) {
    this.map = map || {};
    for (const fn of this._listeners) {
      try { fn(this.map); } catch { /* 忽略监听器异常 */ }
    }
  },
  /** 已选卡片总数 (跨分类求和) */
  count() {
    return Object.values(this.map).reduce((a, s) => a + (s?.length || 0), 0);
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

/** Vibe 库当前多选的条目 id (弹窗的 "添加选中" 据此把它们送进生成页的风格迁移)。 */
export const vibeSelection = {
  ids: [],
  _listeners: new Set(),
  set(ids) {
    this.ids = ids || [];
    for (const fn of this._listeners) {
      try { fn(this.ids); } catch { /* 忽略监听器异常 */ }
    }
  },
  clear() { this.set([]); },
  count() { return this.ids.length; },
  onChange(fn) { this._listeners.add(fn); },
};

/** 弹窗面板当前所在的库 (cards / prompts / vibes), 弹窗共用按钮据此切换作用对象 */
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

// "点击空白关闭分类下拉" 的 document 级处理器: renderPanel/showCreate 每次执行都会重建面板,
// 挂新前先摘旧, 保证 document 上同类监听至多 1 个 (否则残留闭包钉住已脱离 DOM 的整棵面板, 且每次 click 多跑一遍)
let closePlCatDdRef = null;
let closeTypeDdRef = null;

export async function renderPanel(container, ctx, opts = {}) {
  S = ctx;
  clear(container);
  cardSelection.set({});
  promptSelection.set([]);
  vibeSelection.set([]);
  activeLib.set("cards");
  let selection = new Set();       // 当前分类的选中卡片 (与 cardSelection.map[state.type] 同步)
  const selectionStore = new Map(); // 分类 -> Set<卡片名>: 跨分类保留选择
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
    el("button", { class: "tab-btn", text: "🎭 Vibe 库", onclick: () => switchLib("vibes") }),
  ]);
  // 分类栏启用横向滚动: 分类多到放不下时不再换行把版面撑高,
  // 而是在一行内滚 (两端渐隐箭头, 悬停自动滚; "分类" 前缀固定在左不随内容滚)
  const typeScroller = edgeScroll(typeList, { label: "分类" });
  const cardLibBox = el("div", {}, [typeScroller, searchBox, grid, selBar]);

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
  //
  // 布局与卡片库保持一致 (按用户要求): 上方一排"分类"页签, 选中哪个分类,
  // 下方网格只展示该分类下的提示词。原先是一整页纵向罗列的全部分组,
  // 分类一多就要一直往下滚, 而且看不出"当前在哪个分类"。
  const plSearch = el("input", { type: "text", class: "wc-search", placeholder: "🔍 搜索当前分类的提示词..." });
  // 防抖: 重建网格要为每个 chip 建节点并绑监听器, 逐字符触发很卡; 与卡片搜索一致用 150ms 合并。
  let plSearchTimer = 0;
  plSearch.addEventListener("input", () => {
    clearTimeout(plSearchTimer);
    plSearchTimer = setTimeout(() => { plKeyword = plSearch.value; renderPlGrid(); }, 150);
  });
  // 收藏提示词表单的输入件: 由 showPromptCreate() 挂进右侧编辑卡片 (与"新建卡片"同款面板)
  const plInput = el("textarea", { rows: 8, placeholder: "要收藏的关键词或一段提示词 (支持自动补全)" });
  // 分类: 与新建卡片一致的下拉形式, 支持选择已有分类或直接输入新分类
  const plCatInput = el("input", { type: "text", style: "flex:1;min-width:0;", placeholder: "📁 选择/输入分类" });
  const plCatWrap = el("div", { class: "wc-type-wrap" }, [
    plCatInput,
    el("button", {
      class: "wc-type-caret", type: "button", text: "▾", title: "选择已有分类",
      onclick: (e) => { e.stopPropagation(); togglePlCatDropdown(); },
    }),
  ]);
  // 多选计数 (添加/清除使用弹窗右上角的共用按钮)
  const plSelText = el("div", { class: "wc-pl-selbar muted hidden", text: "" });
  // 分类页签栏 (与卡片库的 typeList 同款: 可拖拽排序、可删除)
  const plTypes = el("div", { class: "wc-types" });
  // 当前分类下的提示词网格
  const plGrid = el("div", { class: "wc-pl-grid" });
  // 右上角入口: 打开右侧面板收藏新提示词 (与"新建卡片"同一套交互, 见 showPromptCreate)
  const plAddBtn = el("button", {
    // 初始在卡片库, 提示词库的入口默认隐藏 (switchLib 会按当前库切换)
    class: "btn btn-sm hidden",
    text: "➕ 收藏提示词",
    onclick: () => showPromptCreate(),
  });
  const plTypeScroller = edgeScroll(plTypes, { label: "分类" });
  const promptLibBox = el("div", { class: "hidden" }, [
    plTypeScroller,
    plSearch,
    plGrid,
    plSelText,
  ]);

  // ---------------- Vibe 库 (第三个库): 分类 + 编码文件与图片导入 ----------------
  let vibeLoaded = false;
  let vibeItems = [];
  let vibeCategories = ["默认"];
  let vibeType = "默认";          // 当前选中的分类 (与卡片库的 state.type 同义)
  let vibeKeyword = "";           // 搜索词 (只在当前分类内过滤, 与卡片库一致)
  let vibeImportCategory = null;  // 导入弹窗里选/填的分类 (为空时用 vibeType)
  const vibeGrid = el("div", { class: "wc-vibe-grid" });
  const vibeHint = el("div", { class: "muted", style: "padding:6px 2px;", text: "" });
  /** 当前默认分类名: 后端把 categories[0] 当作默认分类, 它可以被删 (会换成剩下的第一个) */
  const vibeDefaultCat = () => vibeCategories[0] || "默认";
  // 搜索: 放在分类页签下方, 与卡片库/提示词库同一套视觉与防抖
  const vibeSearchBox = el("input", {
    type: "text",
    class: "wc-search",
    placeholder: "🔍 搜索 Vibe 名称...",
  });
  // 分类页签栏: 与卡片库/提示词库同一套视觉 (可横向滚动)
  const vibeTypesEl = el("div", { class: "wc-types" });
  const vibeTypeScroller = edgeScroll(vibeTypesEl, { label: "分类" });
  const vibesFileInput = el("input", { type: "file", accept: ".naiv4vibe,.naiv4vibebundle,.json", multiple: true, style: "display:none;" });
  const vibesImageInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, style: "display:none;" });
  const vibeAddBtn = el("button", {
    class: "btn btn-sm hidden", text: "➕ 导入 Vibe",
    onclick: () => vibeImportDialog(),
  });
  const vibeLibBox = el("div", { class: "hidden" }, [
    vibeTypeScroller,
    vibeSearchBox,
    vibeHint,
    vibeGrid,
    vibesFileInput,
    vibesImageInput,
  ]);

  const createBtn = el("button", { class: "btn btn-sm", text: "➕ 新建卡片", onclick: () => { switchLib("cards"); showCreate(); } });
  const browseCard = el("div", { class: "card wc-browse" }, [
    el("div", { class: "wc-browse-head" }, [
      el("div", { class: "card-title", text: "🗂️ 素材库" }),
      countEl,
      el("span", { class: "spacer" }),
      plAddBtn,      // 提示词库的入口 (与"新建卡片"同位, 由 switchLib 按当前库三选一显示)
      vibeAddBtn,    // Vibe 库的入口
      createBtn,     // 卡片库的入口
    ]),
    libTabs,
    cardLibBox,
    promptLibBox,
    vibeLibBox,
  ]);

  const editCard = el("div", { class: "card wc-edit" });

  const layout = el("div", { class: "wc-panel-grid" });
  layout.append(browseCard, editCard);
  container.append(layout);

  // 弹窗批量添加完成/清除选择后会把共享选择清空, 这里同步面板本地的选中 UI。
  // 注意: 当前分类的选中存在 selection 里, 只有切换过分类的旧桶才在 selectionStore 里,
  // 所以判断"是否还有本地选中"必须两者都看, 否则单分类下点"添加选中"后卡片不会取消高亮。
  cardSelection.onChange((map) => {
    if (!container.isConnected) return;
    let total = 0;
    for (const s of Object.values(map || {})) total += s?.length || 0;
    if (total) return;                                             // 仍有选中: 不动本地状态
    if (!selectionStore.size && !selection.size && state.lastIdx < 0) return;  // 本地本来就干净
    selectionStore.clear();
    selection = new Set();
    state.lastIdx = -1;
    syncSelectionClasses();
  });

  // ---------------- 提示词库 (参考 PAI 关键词库: 收藏关键词, 点击加入提示词) ----------------
  const plZh = new Map();
  let plItems = [];
  let plKeyword = "";
  let plLoaded = false;
  let plMeta = { hidden_tags: [], hidden_categories: [], category_order: [] };

  // 右侧编辑卡片当前是否承载内容: "选中了某张卡片" 或 "正在新建"。
  // 切库时要靠它决定卡片库模式下右侧显示什么 —— renderEditPlaceholder 现在是"隐藏右侧",
  // 若切回卡片库时无条件 editCard.classList.toggle("hidden", false), 就会把一个**空面板**显示出来
  // (典型复现: 点过"收藏新提示词"展开过表单再切库, 或初始未选卡片直接切库再切回)。
  let editActive = false;
  // 当前打开的编辑面板属于哪个库 ("cards" / "prompts"): 切库时只有库匹配才继续显示,
  // 否则会出现"在卡片库里挂着收藏提示词表单"这种错位 (面板内容与所在库不匹配)。
  let editLib = null;

  // ---------------- Vibe 库: 列表 / 导入 / 编码 / 导出 / 删除 ----------------
  // 三种导入来源都会落到同一个库里 (data/state/vibes/<id>.json, 缩略图是同名图片文件):
  //   .naiv4vibe / .naiv4vibebundle  直接解析 (不花钱)
  //   图片                            先读 PNG 元数据里的编码 (不花钱), 没有才按需编码 (2 Anlas)
  async function loadVibes() {
    try {
      const res = await get("/api/vibes");
      vibeItems = res.items || [];
      vibeCategories = res.categories || ["默认"];
      // 当前分类若已被删空, 回落到第一个可用分类
      if (!vibeCategories.includes(vibeType)) vibeType = vibeCategories[0] || "默认";
      renderVibes();
    } catch (e) {
      toast("读取 Vibe 库失败: " + e.message, "error");
    }
  }

  /** 编辑按钮 -> 展开详情菜单 (导出 / 改名 / 换分类 / 补编码 都在这里) */
  function editVibe(item) {
    const overlay = el("div", {
      style: "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:5200;display:flex;align-items:center;justify-content:center;",
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    function onKey(e) { if (e.key === "Escape") close(); }

    // 分类下拉: 直接列出现有分类, 选完立刻生效
    const catSelect = el("select", { class: "wc-vibe-cat-select" });
    const curCat = item.category || vibeDefaultCat();
    const cats = [...new Set([...(vibeCategories || []), curCat])];
    for (const c of cats) {
      const opt = el("option", { value: c, text: c });
      if (c === curCat) opt.selected = true;
      catSelect.append(opt);
    }
    catSelect.addEventListener("change", async () => {
      try {
        const r = await post("/api/vibes/" + item.id + "/category", { category: catSelect.value });
        vibeItems = r.items || vibeItems;
        vibeCategories = r.categories || vibeCategories;
        vibeType = catSelect.value;
        renderVibes();
        toast("已移到分类「" + catSelect.value + "」", "success");
        close();
      } catch (e) { toast(e.message, "error"); }
    });

    const rowBtn = (text, onclick, danger = false) =>
      el("button", { class: "btn btn-sm" + (danger ? " btn-danger" : ""), text, onclick });

    const box = el("div", { class: "card dialog-solid", style: "width:400px;animation:pop-in 0.2s ease;" }, [
      el("div", { class: "card-title", text: "🎭 " + item.name }),
      el("div", { class: "wc-vibe-detail" }, [
        el("div", { class: "muted", text: "已有编码模型: " + vibeModelLabel(item.models) }),
        el("div", { class: "muted", text: "信息提取: " + (item.information ?? "—") + " · 参考强度: " + (item.strength ?? "—") }),
      ]),
      el("div", { class: "field", style: "margin-top:10px;" }, [
        el("label", { text: "所属分类" }),
        catSelect,
      ]),
      el("div", { class: "wc-vibe-detail-actions" }, [
        rowBtn("📤 导出 .naiv4vibe", () => { close(); exportVibe(item); }),
        rowBtn("✏️ 重命名", () => { close(); renameVibe(item); }),
        rowBtn("🗑️ 删除", () => { close(); deleteVibe(item); }, true),
      ]),
      el("div", { style: "display:flex;justify-content:flex-end;margin-top:14px;" }, [
        el("button", { class: "btn btn-sm", text: "关闭", onclick: close }),
      ]),
    ]);
    overlay.append(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
  }

  function vibeModelLabel(models) {
    return (models || []).join(" / ") || "未编码";
  }

  /** 搜索匹配: 只看名称 (不区分大小写)。 */
  function vibeMatches(item, kw) {
    return String(item.name || "").toLowerCase().includes(kw);
  }

  function renderVibes() {
    clear(vibeGrid);
    // 上方是分类页签 + 搜索框: 无关键词时只显示选中分类, 有关键词时跨分类匹配
    renderVibeTypes();
    const kw = vibeKeyword.trim().toLowerCase();
    const inType = vibeItems.filter((it) => (it.category || vibeDefaultCat()) === vibeType);
    // 有关键词时跨全部分类搜索: vibe 条目不多, "记得名字但忘了放哪个分类"才是常态
    const shown = kw ? vibeItems.filter((it) => vibeMatches(it, kw)) : inType;
    if (!vibeItems.length) {
      vibeHint.textContent = "还没有 Vibe。点右上角「➕ 导入 Vibe」添加 .naiv4vibe / .naiv4vibebundle 文件, 或直接拖入图片。";
    } else if (kw) {
      vibeHint.textContent = "全部分类中匹配 " + shown.length + " / " + vibeItems.length + " 个 Vibe (关键词: " + vibeKeyword.trim() + ")";
    } else {
      vibeHint.textContent = "「" + vibeType + "」· " + inType.length + " / " + vibeItems.length + " 个 Vibe。导入的图片若没有现成编码, 需要按模型现场编码 (每次 2 Anlas)。";
    }
    if (!shown.length) {
      const empty = !vibeItems.length
        ? "点击右上角「➕ 导入 Vibe」开始"
        : (kw ? "没有匹配的 Vibe" : "该分类暂无 Vibe");
      vibeGrid.append(el("div", { class: "gallery-empty", text: empty }));
      return;
    }
    for (const item of shown) {
      const thumb = el("div", { class: "wc-vibe-thumb" });
      if (item.thumbnail) {
        thumb.append(el("img", { src: item.thumbnail, alt: item.name, loading: "lazy" }));
      } else {
        thumb.append(el("div", { class: "wc-vibe-ph", text: "🎭" }));
      }
      const models = el("div", { class: "muted", style: "font-size:11px;" },
        ["模型: " + vibeModelLabel(item.models)]);
      // 右上角两个按钮: ✏️ 展开详情菜单 (含导出) / 🗑️ 删除
      const acts = el("div", { class: "wc-card-acts" });
      const editBtn = el("button", { class: "wc-card-act", type: "button", text: "✏️", title: "编辑这个 Vibe" });
      editBtn.addEventListener("click", (e) => { e.stopPropagation(); editVibe(item); });
      const delBtn = el("button", { class: "wc-card-act wc-card-act-danger", type: "button", text: "🗑️", title: "删除这个 Vibe" });
      delBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteVibe(item); });
      acts.append(editBtn, delBtn);
      const card = el("div", { class: "wc-vibe-card" }, [
        acts,
        thumb,
        el("div", { class: "wc-vibe-name", text: item.name, title: item.name }),
        models,
      ]);
      // 单击多选 (与卡片库一致, 再点取消); 右上角按钮不算选中
      if (vibeSelection.ids.includes(item.id)) card.classList.add("selected");
      card.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        const ids = new Set(vibeSelection.ids);
        if (ids.has(item.id)) ids.delete(item.id);
        else ids.add(item.id);
        vibeSelection.set([...ids]);
        card.classList.toggle("selected", ids.has(item.id));
      });
      vibeGrid.append(card);
    }
  }

  // 搜索防抖: 与卡片库一致, 150ms 合并一次; 只重建网格, 不重新请求接口
  let vibeSearchTimer = 0;
  vibeSearchBox.addEventListener("input", () => {
    clearTimeout(vibeSearchTimer);
    vibeSearchTimer = setTimeout(() => {
      vibeKeyword = vibeSearchBox.value;
      renderVibes();
    }, 150);
  });

  /** 分类页签 (可拖拽排序 / 双击改名 / 点 ➕ 新建) */
  function renderVibeTypes() {
    clear(vibeTypesEl);
    for (const t of vibeCategories) {
      const btn = el("button", {
        class: "tab-btn" + (t === vibeType ? " active" : ""),
        // 与卡片库/提示词库同款: 分类名前缀文件夹图标
        text: "📁 " + t,
        title: "点击切换分类; 双击改名",
      });
      btn.addEventListener("click", () => {
        vibeType = t;
        renderVibes();
      });
      btn.addEventListener("dblclick", async (e) => {
        e.preventDefault();
        const name = await inputDialog("重命名分类", t);
        if (!name || name === t) return;
        try {
          const r = await post("/api/vibes/categories/rename", { from: t, to: name });
          vibeCategories = r.categories || vibeCategories;
          vibeItems = r.items || vibeItems;
          vibeType = name;
          renderVibes();
        } catch (err) { toast(err.message, "error"); }
      });
      // 删除分类 (默认分类也能删): 分类连同其中的 Vibe 一起移入系统回收站 (与卡片库一致)
      btn.append(el("span", {
        class: "wc-type-del", text: "✕", title: "删除分类「" + t + "」(其中的 Vibe 会一起移入回收站)",
        onclick: async (e) => {
          e.stopPropagation();
          const rest = vibeCategories.filter((c) => c !== t);
          if (!rest.length) {
            toast("至少要保留一个分类 —— 请先新建一个分类再删这个", "warning");
            return;
          }
          const n = vibeItems.filter((x) => (x.category || vibeDefaultCat()) === t).length;
          const okDel = await confirmDialog(
            n
              ? "确定删除分类「" + t + "」吗? 其中 " + n + " 个 Vibe 会一起移入系统回收站 (需要时可以从回收站恢复)。"
              : "确定删除空分类「" + t + "」吗?",
            { danger: true },
          );
          if (!okDel) return;
          try {
            const r = await post("/api/vibes/categories/delete", { category: t });
            vibeItems = r.items || vibeItems;
            vibeCategories = r.categories || vibeCategories;
            if (vibeType === t) vibeType = vibeCategories[0] || "默认";
            renderVibes();
            toast(
              "分类「" + t + "」已删除" + (r.moved ? ", " + r.moved + " 个 Vibe 已移入回收站" : ""),
              "success",
            );
          } catch (err) { toast(err.message, "error"); }
        },
      }));
      vibeTypesEl.append(btn);
    }
    // 分类末尾: 新建分类 (空分类会存进 vibes/_meta.json, 切走再回来还在)
    vibeTypesEl.append(el("button", {
      class: "wc-type-add", type: "button", text: "➕ 新建分类",
      title: "新建一个空分类",
      onclick: async () => {
        const name = (await inputDialog("新建 Vibe 分类", ""))?.trim();
        if (!name) return;
        if (vibeCategories.includes(name)) { toast("分类「" + name + "」已存在", "warning"); return; }
        try {
          const r = await post("/api/vibes/categories", { category: name });
          vibeCategories = r.categories || vibeCategories;
          vibeType = name;
          renderVibes();
          toast("分类「" + name + "」已创建", "success");
        } catch (e) { toast(e.message, "error"); }
      },
    }));
  }

  async function exportVibe(item) {
    try {
      const r = await post("/api/vibes/" + item.id + "/export");
      toast(r.path ? "已导出: " + r.path : "已导出", "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async function renameVibe(item) {
    const name = await inputDialog("重命名 Vibe", item.name);
    if (!name) return;
    try {
      const r = await post("/api/vibes/" + item.id + "/rename", { name });
      vibeItems = r.items || vibeItems;
      renderVibes();
    } catch (e) { toast(e.message, "error"); }
  }

  async function deleteVibe(item) {
    if (!(await confirmDialog("确定删除「" + item.name + "」吗? 会连同缩略图与原图移入系统回收站, 需要时可以从回收站恢复。", { danger: true }))) return;
    try {
      const r = await del("/api/vibes/" + item.id);
      vibeItems = r.items || vibeItems;
      renderVibes();
      toast("已移入回收站", "success");
    } catch (e) { toast(e.message, "error"); }
  }

  /** 导入对话框: 让用户选"编码文件"还是"图片", 图片还会问要不要现在编码。
   *
   *  用独立弹窗而不是往 toast 里塞内容: toast 是 flex 横排 + max-width 380,
   *  再 append 一整块 div 会把说明文字挤成一列 (实测截图), 而且难以点按钮。
   */
  function vibeImportDialog() {
    vibesFileInput.value = "";
    vibesImageInput.value = "";

    const overlay = el("div", {
      style: "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:5200;display:flex;align-items:center;justify-content:center;",
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      overlay.remove();
    };
    function onKey(e) { if (e.key === "Escape") close(); }

    // 分类: 既可从已有分类里选 (datalist 下拉), 也可以直接输入新名字
    vibeImportCategory = vibeType;
    const catInput = el("input", { type: "text", value: vibeType, list: "vibe-import-cat-options" });
    const catList = el("datalist", { id: "vibe-import-cat-options" },
      (vibeCategories || []).map((c) => el("option", { value: c })));
    catInput.addEventListener("input", () => { vibeImportCategory = catInput.value.trim() || vibeType; });

    // 选完文件先收起弹窗, 上传在后台继续 (change 事件不受关闭影响)
    vibesFileInput.onchange = () => { close(); uploadVibeFiles(); };
    vibesImageInput.onchange = () => { close(); uploadVibeImages(); };

    const box = el("div", { class: "card dialog-solid", style: "width:400px;animation:pop-in 0.2s ease;" }, [
      el("div", { class: "card-title", text: "🎭 导入 Vibe" }),
      el("div", { class: "wc-vibe-import" }, [
        el("div", { class: "wc-vibe-import-line", text: "📄 .naiv4vibe / .naiv4vibebundle —— 直接读编码, 不花点数" }),
        el("div", { class: "wc-vibe-import-line", text: "🖼️ 图片 —— 先找图里自带的编码; 没有才现场编码 (2 Anlas)" }),
        el("div", { class: "field wc-vibe-import-cat" }, [
          el("label", {}, [
            document.createTextNode("📁 导入到分类"),
            el("span", { class: "hint", text: "可下拉选已有分类, 也可直接输入新名字" }),
          ]),
          catInput,
          catList,
        ]),
        el("div", { class: "wc-vibe-import-actions" }, [
          el("button", {
            class: "btn btn-sm btn-primary", text: "📁 选择 Vibe 文件",
            onclick: () => vibesFileInput.click(),
          }),
          el("button", {
            class: "btn btn-sm", text: "🖼️ 选择图片",
            onclick: () => vibesImageInput.click(),
          }),
        ]),
      ]),
      el("div", { style: "display:flex;justify-content:flex-end;margin-top:14px;" }, [
        el("button", { class: "btn btn-sm", text: "关闭", onclick: close }),
      ]),
    ]);
    overlay.append(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
  }

  async function uploadVibeFiles() {
    const files = vibesFileInput.files;
    if (!files?.length) return;
    const form = new FormData();
    for (const f of files) form.append("files", f);
    try {
      const res = await fetch(
        "/api/vibes/import?category=" + encodeURIComponent(vibeImportCategory || vibeType),
        { method: "POST", body: form },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "导入失败");
      vibeItems = data.items || vibeItems;
      vibeCategories = data.categories || vibeCategories;
      // 导入到新分类时切过去, 让用户立刻看到结果
      if (vibeImportCategory) vibeType = vibeImportCategory;
      renderVibes();
      const n = (data.added || []).length;
      toast("已导入 " + n + " 个 Vibe" + (data.skipped?.length ? " (" + data.skipped.length + " 个被跳过)" : ""), "success");
    } catch (e) { toast(e.message, "error"); }
  }

  async function uploadVibeImages() {
    const files = vibesImageInput.files;
    if (!files?.length) return;
    const model = (S?.model?.get?.() || "nai-diffusion-4-5-full");
    const form = new FormData();
    for (const f of files) form.append("files", f);
    try {
      // encode=false: 只读图里自带的编码, 绝不花钱 (素材库不做现场编码)
      const probe = await fetch(
        "/api/vibes/import-image?encode=false&category=" + encodeURIComponent(vibeImportCategory || vibeType) + "&model=" + encodeURIComponent(model),
        { method: "POST", body: form },
      );
      const probed = await probe.json();
      if (!probe.ok) throw new Error(probed.detail || "导入失败");
      vibeItems = probed.items || vibeItems;
      if (probed.categories) vibeCategories = probed.categories;
      renderVibes();
      const okCount = (probed.results || []).filter((r) => r.ok).length;
      if (okCount) toast("已导入 " + okCount + " 个 (图片自带编码, 未花点数)", "success");

      // 没有编码的图片: 素材库直接拒绝 (要到生成页"风格迁移"里拖入才会收下并排队编码)
      const need = probed.needs_encode || [];
      if (need.length) {
        toast("导入失败: 所选图片不含编码 —— " + need.map((r) => r.file).join("、"), "error", 12000);
      }
      // 其它失败/不支持的原因也如实说出 (例如当前模型不支持编码)
      const failed = (probed.results || []).filter((r) => !r.ok && !r.needs_encode);
      if (failed.length) {
        toast(failed.map((r) => "・" + r.file + ": " + (r.message || "导入失败")).join("\n"), "error", 12000);
      }
    } catch (e) { toast("导入失败: " + e.message, "error"); }
  }

  /** 右侧面板的标题行: 标题 + 右上角关闭按钮 (只收起面板, 不影响左侧网格)。 */
  function panelTitle(text) {
    return el("div", { class: "card-title wc-title-row" }, [
      el("span", { text }),
      el("span", { class: "spacer" }),
      el("button", {
        class: "btn btn-sm btn-ghost", text: "✖", title: "关闭这个面板",
        onclick: () => renderEditPlaceholder(),
      }),
    ]);
  }

  /** 切到卡片库时自动选中第一个分类 (与提示词库 / Vibe 库的行为一致)。 */
  async function ensureCardTypeSelected() {
    if (state.type || !allTypes.length) return;
    state.type = allTypes[0];
    selection = selectionStore.get(state.type) || new Set();
    await loadTypes();
    await loadCards();
    syncSelection();
  }
  function switchLib(which) {
    const isCards = which === "cards";
    const isVibes = which === "vibes";
    [...libTabs.children].forEach((b, i) => b.classList.toggle("active", i === ["cards", "prompts", "vibes"].indexOf(which)));
    cardLibBox.classList.toggle("hidden", !isCards);
    promptLibBox.classList.toggle("hidden", which !== "prompts");
    vibeLibBox.classList.toggle("hidden", !isVibes);
    // 提示词库下没有"卡片"概念: 头部按钮按当前库二选一 (新建卡片 <-> 收藏新提示词)
    createBtn.classList.toggle("hidden", !isCards);
    plAddBtn.classList.toggle("hidden", which !== "prompts");
    if (vibeAddBtn) vibeAddBtn.classList.toggle("hidden", !isVibes);
    // 右侧编辑面板: "有编辑内容 且 面板属于当前所在库" 才显示。
    // 收藏提示词的面板属于提示词库 → 切到卡片库时收起 (避免"卡片库里挂着收藏表单"的错位),
    // 切回提示词库时恢复 (没保存的草稿还在)。
    // 面板只在自己所属的库显示: 原来只区分 cards / 其它, 于是"收藏提示词"表单
    // 会在切到 Vibe 库时继续挂着 (用户看到过)。
    const showEdit = editActive && editLib === which;
    editCard.classList.toggle("hidden", !showEdit);
    layout.classList.toggle("single", !showEdit);
    // 同步当前库给弹窗 (共用按钮的作用对象随之切换; Vibe 库下这些按钮会因无选择而禁用)
    activeLib.set(which);
    // 首次进入提示词库: loadPromptLib 内部拿到数据后会自己渲染, 不必在这里先渲染一次
    // (否则数据还没回来就画一屏"暂无分类", 闪一下)
    if (which === "prompts" && !plLoaded) { plLoaded = true; loadPromptLib(); }
    if (isVibes && !vibeLoaded) { vibeLoaded = true; loadVibes(); }
    // 卡片库: 没选分类时自动落到第一个 (另两个库首次进入就有内容, 这里保持一致)
    if (isCards) ensureCardTypeSelected();
  }

  // ---------------- 内置提示词 (参考 PAI 预设: 分类分组, 横向标签, 可多选) ----------------
  const builtinSel = new Set();   // 已勾选的内置提示词 (英文 tag)

  function syncBuiltinSelBar() {
    const n = builtinSel.size;
    plSelText.textContent = n ? `已选 ${n} 个内置提示词 — 点右上角 "➕ 添加选中" 加入, "✖ 清除选择" 取消` : "";
    plSelText.classList.toggle("hidden", !n);
  }

  // 弹窗 "✖ 清除选择" 或批量添加后会重置共享选择, 这里同步本地面板 UI
  // (只刷网格: 选中态画在 chip 上, 页签与选中无关)
  promptSelection.onChange((tags) => {
    if (!container.isConnected) return;
    builtinSel.clear();
    tags.forEach((t) => builtinSel.add(t));
    renderPlGrid();
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
      // 旧版本分类名自带 emoji ("✨ 画质"), 现分类名不带 —— meta 里存的旧名
      // (hidden_categories / category_order) 若不归一化, 改名后隐藏/排序都会失效。
      // 同时把用户收藏里挂在旧分类名下的条目归到新名 (仅改显示分组, 不回写库)。
      const legacy = LEGACY_CATEGORY_NAMES || {};
      if (plMeta.hidden_categories?.length) {
        plMeta.hidden_categories = plMeta.hidden_categories.map((c) => legacy[c] || c);
      }
      if (plMeta.category_order?.length) {
        plMeta.category_order = plMeta.category_order.map((c) => legacy[c] || c);
      }
      plItems.forEach((it) => { if (legacy[it.category]) it.category = legacy[it.category]; });
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
    const deleted = new Set(plMeta.hidden_categories || []);
    const cats = [
      ...builtinPromptGroups.map((g) => g.name).filter((n) => !deleted.has(n)),
      ...new Set(plItems.map((it) => it.category || "默认").filter((c) => !deleted.has(c))),
    ];
    const list = el("div", { class: "wc-type-dd" }, cats.map((c) =>
      el("div", { class: "wc-type-item", text: "📁 " + c, onclick: () => { plCatInput.value = c; dd.remove(); } })));
    if (!cats.length) list.append(el("div", { class: "muted", style: "padding:10px;text-align:center;", text: "暂无已有分类, 直接输入即新建" }));
    plCatWrap.append(list);
  }
  if (closePlCatDdRef) document.removeEventListener("click", closePlCatDdRef);
  const closePlCatDd = (e) => {
    if (e.target instanceof Element && !plCatWrap.contains(e.target)) plCatWrap.querySelector(".wc-type-dd")?.remove();
  };
  document.addEventListener("click", closePlCatDd);
  closePlCatDdRef = closePlCatDd;

  async function translatePromptLib(texts) {
    const missing = texts.filter((t) => !plZh.has(plKey(t)));
    if (!missing.length) return;
    try {
      const r = await post("/api/suggest/translate", { tags: missing });
      Object.entries(r.translations || {}).forEach(([k, v]) => plZh.set(plKey(k), v || ""));
      renderPlGrid();   // 翻译只影响 chip 的中文副文本, 页签无需重绘
    } catch { /* 翻译失败静默 */ }
  }

  // ---- 分类页签 + 当前分类网格 (布局与卡片库一致) ----
  // 当前选中的分类 (null = 未选择, 网格显示提示)。与卡片的 state.type 同语义。
  let plCat = null;

  /** 组装全部分类: 自带分组与用户收藏合并 (用户存入自带分类的条目并入同组)。
   *  返回 [{key, builtin, builtinTags, userItems}], 已按 category_order 排序、
   *  已剔除隐藏的分类/标签。 */
  function plGroups() {
    const deletedTags = new Set(plMeta.hidden_tags || []);
    const deletedCats = new Set(plMeta.hidden_categories || []);
    const groups = new Map();
    const groupOf = (key) => {
      if (!groups.has(key)) groups.set(key, { key, builtinTags: [], userItems: [] });
      return groups.get(key);
    };
    for (const group of builtinPromptGroups) {
      if (deletedCats.has(group.name)) continue;
      const g = groupOf(group.name);
      g.builtin = group.name;
      g.builtinTags = group.tags.filter(([en]) => !deletedTags.has(en));
    }
    // 用户显式新建的空分类 (没有条目, 也要出现)
    for (const c of plMeta.categories || []) {
      if (!deletedCats.has(c)) groupOf(c);
    }
    plItems.forEach((it) => {
      const cat = it.category || "默认";
      if (deletedCats.has(cat)) return;
      groupOf(cat).userItems.push(it);
    });
    const order = plMeta.category_order || [];
    const rank = (key) => {
      const i = order.indexOf(key);
      return i === -1 ? 9999 : i;
    };
    return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key));
  }

  /** 渲染分类页签 (含计数 / 删除 / 拖拽排序), 与卡片库的 typeList 同款。 */
  function renderPlCats() {
    clear(plTypes);
    const groups = plGroups();
    // 当前分类被删空时回落到第一个
    if (plCat && !groups.some((g) => g.key === plCat)) plCat = null;
    if (!plCat && groups.length) plCat = groups[0].key;
    groups.forEach((g) => {
      const total = g.builtinTags.length + g.userItems.length;
      // 空分类默认不占页签; 但"用户显式新建"的空分类要显示, 否则刚建完就看不见
      const userCreated = (plMeta.categories || []).includes(g.key);
      if (!total && !userCreated) return;
      const tab = el("button", {
        class: "tab-btn" + (g.key === plCat ? " active" : ""),
        title: g.key, "data-key": g.key,
      });
      tab.draggable = true;
      tab.addEventListener("dragstart", (e) => {
        plDragKey = g.key;
        tab.classList.add("dragging");
        try {
          e.dataTransfer.setData("text/plain", g.key);
          e.dataTransfer.effectAllowed = "move";
        } catch { /* 忽略 */ }
      });
      tab.addEventListener("dragend", () => {
        plDragKey = null;
        tab.classList.remove("dragging");
        clearPlDropMarks();
      });
      // 与卡片库/Vibe 库同款: 只显示"📁 分类名", 数量放进 tooltip, 避免三个库样式不一致
      tab.title = g.key + " · " + total + " 条";
      tab.append(el("span", { text: "📁 " + g.key }));
      // 悬停显示删除分类按钮: 自带分类为隐藏 (meta 可恢复), 用户分类连带收藏真删
      const isBuiltin = g.builtin != null;
      tab.append(el("span", {
        class: "wc-type-del", text: "✕",
        title: isBuiltin ? "删除自带分类 " + g.key + " (含 " + g.builtinTags.length + " 个标签)" : "删除分类 " + g.key + " 及其中 " + g.userItems.length + " 条收藏",
        onclick: async (e) => {
          e.stopPropagation();
          const ok = isBuiltin
            ? await confirmDialog("确定删除自带分类「" + g.key + "」(含 " + g.builtinTags.length + " 个标签)?", { danger: true })
            : await confirmDialog("确定删除分类「" + g.key + "」? 其中 " + g.userItems.length + " 条收藏将一并删除, 不可恢复。", { danger: true });
          if (!ok) return;
          try {
            if (isBuiltin) {
              await savePlMeta({ hidden_categories: [...new Set([...(plMeta.hidden_categories || []), g.key])] });
            } else {
              const res = await post("/api/prompt-library/delete-category", { category: g.key });
              plItems = res.items || [];
              // 后端同时把该分类从 meta.categories 摘掉了, 这里必须同步过来,
              // 否则"显式新建过的空分类"会被 plGroups() 重新渲染 (表现: 提示已删除但分类还在)
              if (res.meta) plMeta = res.meta;
            }
            if (plCat === g.key) plCat = null;
            renderPlCats();
            renderPlGrid();
            toast("分类「" + g.key + "」已删除 🗑️", "success");
          } catch (err) { toast(err.message, "error"); }
        },
      }));
      tab.addEventListener("click", () => {
        if (plCat === g.key) return;
        plCat = g.key;
        renderPlCats();
        renderPlGrid();
      });
      plTypes.append(tab);
    });
    if (!groups.length) {
      plTypes.append(el("span", { class: "muted", style: "font-size:12.5px;padding:3px 0;", text: "暂无分类 — 点右侧「➕ 新建分类」或展开上方「➕ 收藏新提示词」" }));
    }
    // 分类末尾: 新建分类
    plTypes.append(el("button", {
      class: "wc-type-add", type: "button", text: "➕ 新建分类",
      title: "新建一个空分类",
      onclick: async () => {
        const name = (await inputDialog("新建提示词分类", ""))?.trim();
        if (!name) return;
        if ((plMeta.categories || []).includes(name) || plGroups().some((g) => g.key === name)) {
          toast("分类「" + name + "」已存在", "warning");
          return;
        }
        try {
          await savePlMeta({ categories: [...new Set([...(plMeta.categories || []), name])] });
          plCat = name;
          renderPlCats();
          renderPlGrid();
          toast("分类「" + name + "」已创建", "success");
        } catch (e) { toast(e.message, "error"); }
      },
    }));
  }

  /** 渲染当前分类下的提示词网格 (搜索词只在当前分类内过滤, 与卡片库一致)。 */
  function renderPlGrid() {
    clear(plGrid);
    if (!plCat) {
      plGrid.append(el("div", { class: "gallery-empty", text: "请选择一个分类" }));
      syncBuiltinSelBar();
      return;
    }
    const kw = plKeyword.trim().toLowerCase();
    const g = plGroups().find((x) => x.key === plCat);
    if (!g) { plGrid.append(el("div", { class: "gallery-empty", text: "请选择一个分类" })); return; }
    const bTags = g.builtinTags.filter(([en, zh]) =>
      !kw || en.toLowerCase().includes(kw) || (zh || "").toLowerCase().includes(kw));
    const uItems = g.userItems.filter((it) =>
      !kw || it.text.toLowerCase().includes(kw) || g.key.toLowerCase().includes(kw));
    const chips = [
      ...bTags.map(([en, zh]) => makePromptChip(en, zh, { builtin: en })),
      ...uItems.map((it) => makePromptChip(it.text, plZh.get(plKey(it.text)) || "", { userItem: it })),
    ];
    if (!chips.length) {
      plGrid.append(el("div", { class: "gallery-empty", text: kw ? "当前分类没有匹配的提示词" : "该分类暂无提示词 — 展开上方「➕ 收藏新提示词」添加" }));
      syncBuiltinSelBar();
      return;
    }
    const frag = document.createDocumentFragment();
    chips.forEach((c) => frag.append(c));
    plGrid.append(frag);
    syncBuiltinSelBar();
  }

  /** 兼容入口: 同时刷新分类页签与网格 (原先只渲染分组行)。 */
  function renderPromptChips() {
    renderPlCats();
    renderPlGrid();
  }

  // ---- 提示词分类拖拽排序 (页签之间, 与卡片分类 tab 相同交互) ----
  let plDragKey = null;
  let plDropTargetKey = null;

  function clearPlDropMarks() {
    $$(".tab-btn.drop-before", plTypes).forEach((x) => x.classList.remove("drop-before"));
  }

  plTypes.addEventListener("dragover", (e) => {
    if (!plDragKey) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const tabs = [...plTypes.querySelectorAll(".tab-btn")];
    let target = null;
    for (const tb of tabs) {
      if (tb.dataset.key === plDragKey) continue;
      const r = tb.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { target = tb; break; }
    }
    clearPlDropMarks();
    (target || tabs[tabs.length - 1])?.classList.add("drop-before");
    plDropTargetKey = target ? target.dataset.key : "__end__";
  });
  plTypes.addEventListener("dragleave", (e) => {
    if (!plTypes.contains(e.relatedTarget)) clearPlDropMarks();
  });
  plTypes.addEventListener("drop", async (e) => {
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
    renderPlCats();
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
            renderPlGrid();   // 页签计数不变, 只刷当前分类的网格
            toast("已从提示词库删除 🗑️", "success");
          } catch (err) { toast(err.message, "error"); }
        },
      }));
    } else if (opts.builtin) {
      chip.append(el("span", {
        class: "wc-pl-chip-del", text: "✕", title: "从词库中删除这个标签",
        onclick: async (e) => {
          e.stopPropagation();
          await savePlMeta({ hidden_tags: [...new Set([...(plMeta.hidden_tags || []), en])] });
          builtinSel.delete(en);
          promptSelection.set([...builtinSel]);
          renderPromptChips();
          toast(`标签「${en}」已删除 🗑️`, "success");
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
      // 切到刚保存的分类: 新条目立刻可见, 不用再去页签里找
      plCat = category;
      plKeyword = "";
      plSearch.value = "";
      renderPromptChips();
      await translatePromptLib(plItems.map((it) => it.text));
      toast(`已收藏到「${category}」📚`, "success");
      // 保存完收起右侧面板 (与"新建卡片"保存后回占位的节奏一致); 连续收藏再点右上角按钮即可
      renderEditPlaceholder();
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
            // 大分类 (上百张卡片 + 封面) send2trash 要搬一会儿, 先给个即时反馈
            await post("/api/wildcards/delete-type", { type: t });
            toast(`分类 <${t}> 已删除 (移到回收站) 🗑️`, "success");
            if (state.type === t) { state.type = null; renderEditPlaceholder(); selection = new Set(); }
            selectionStore.delete(t);           // 移除被删分类的选择桶 (其它分类的选择保留)
            await loadTypes();
            await loadCards();
            syncSelection();
          } catch (err) { toast(err.message, "error"); }
        },
      }));
      tab.addEventListener("click", async () => {
        const prevType = state.type;
        if (prevType && prevType !== t) selectionStore.set(prevType, new Set(selection));
        state.type = t;
        state.name = null;
        state.lastIdx = -1;
        // 切换分类不清空其它分类的选中: 保存当前分类的桶, 恢复目标分类的桶
        selection = selectionStore.get(t) || new Set();
        await loadTypes();
        await loadCards();
        syncSelection();
      });
      typeList.append(tab);
    });
    // 分类末尾: 新建分类 (卡片库的分类就是 wildcards/ 下的目录)
    typeList.append(el("button", {
      class: "wc-type-add", type: "button", text: "➕ 新建分类",
      title: "新建一个空分类",
      onclick: async () => {
        const name = (await inputDialog("新建卡片库分类", ""))?.trim();
        if (!name) return;
        if (allTypes.includes(name)) { toast("分类「" + name + "」已存在", "warning"); return; }
        try {
          const res = await post("/api/wildcards/create-type", { type: name });
          allTypes = res.types || allTypes;
          state.type = name;
          state.name = null;
          state.lastIdx = -1;
          selection = new Set();
          await loadTypes();
          await loadCards();
          syncSelection();
          toast("分类「" + name + "」已创建", "success");
        } catch (e) { toast(e.message, "error"); }
      },
    }));
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
    // DocumentFragment 批量插入: 155 张卡时一次性 append 比逐张快约 40%
    const frag = document.createDocumentFragment();
    visibleCards.forEach((card) => frag.append(renderCard(card)));
    grid.append(frag);
    syncSelectionClasses();
    // 本次渲染已经用时间戳 URL 取到新封面, 之后的渲染恢复用缓存 URL
    coverBustNames.clear();
  }

  // 搜索防抖: 大量卡片时每敲一个字符全量重建网格很卡, 150ms 合并一次
  let searchTimer = 0;
  searchBox.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.keyword = searchBox.value;
      renderGrid();
    }, 150);
  });

  // ---------------- 卡片多选 / 拖拽 ----------------
  function syncSelection() {
    // 合并所有分类的选中桶同步给弹窗 (当前分类以 selection 为准)
    const map = {};
    for (const [t, s] of selectionStore) {
      if (t === state.type || !s.size) continue;
      map[t] = [...s];
    }
    if (state.type && selection.size) map[state.type] = [...selection];
    cardSelection.set(map);
    syncSelectionClasses();
  }

  function syncSelectionClasses() {
    $$(".wildcard-card", grid).forEach((c) => c.classList.toggle("selected", selection.has(c.dataset.name)));
    const n = cardSelection.count();
    const nTypes = Object.values(cardSelection.map).filter((s) => s?.length).length;
    selText.textContent = n
      ? `已选 ${n} 张卡片${nTypes > 1 ? ` (${nTypes} 个分类)` : ""} — 拖入上方提示词, 或点右上角 "➕ 添加选中"`
      : "";
    selBar.classList.toggle("hidden", !n);
  }

  function renderCard(card) {
    const item = el("div", {
      class: "wildcard-card" + (card.special ? " wildcard-special" : ""),
      title: "点击选中/取消 · 拖入提示词\n" + (card.tags || card.name),
      draggable: true,
    });
    item.dataset.name = card.name;
    item.append(el("span", { class: "wc-check", text: "✓" }));

    // 右上角操作: 编辑 / 删除 (特殊卡片"随机/顺序"没有实体文件, 不提供删除)
    const acts = el("div", { class: "wc-card-acts" });
    const editBtn = el("button", { class: "wc-card-act", type: "button", text: "✏️", title: "编辑这张卡片" });
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectCard(card.name);
    });
    acts.append(editBtn);
    if (!card.special) {
      const delBtn = el("button", { class: "wc-card-act wc-card-act-danger", type: "button", text: "🗑️", title: "删除这张卡片" });
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCard(card.name);
      });
      acts.append(delBtn);
    }
    item.append(acts);
    if (card.cover) {
      // 只在"封面刚被替换过"时加时间戳: 原先恒用 bust=true, 等于每次网格渲染都让浏览器
      // 重新下载全部封面 (缓存完全失效)。_coverBust 由上传/更换封面的代码路径写入。
      const bust = coverBustNames.has(card.name);
      item.append(el("div", { class: "wc-cover" }, [el("img", { src: imageUrl(card.cover, !!bust), alt: card.name, loading: "lazy" })]));
    } else {
      item.append(el("div", { class: "wc-cover wc-cover-empty" }, [el("span", { text: card.special ? (card.name === "随机" ? "🎲" : "🔁") : "🃏" })]));
    }
    item.append(el("div", { class: "wc-name", text: card.name }));
    item.append(el("div", { class: "wc-tags", text: (card.tags || "空").slice(0, 40) || "空" }));

    item.addEventListener("click", (e) => {
      const idx = visibleCards.findIndex((c) => c.name === card.name);
      if (e.shiftKey && state.lastIdx >= 0 && idx >= 0) {
        const [a, b] = [Math.min(state.lastIdx, idx), Math.max(state.lastIdx, idx)];
        selection.clear();
        visibleCards.slice(a, b + 1).forEach((c) => selection.add(c.name));
        syncSelection();
        return;
      }
      // 普通点击 / Ctrl+点击: 切换选中 (与提示词库一致, 再点取消)
      if (selection.has(card.name)) selection.delete(card.name);
      else selection.add(card.name);
      state.lastIdx = idx;
      syncSelection();
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
    editActive = true;                     // 右侧编辑卡片承载内容了
    editLib = "cards";                     // 这个面板属于卡片库
    editCard.classList.remove("hidden");
    layout.classList.remove("single");
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
          coverImg.src = imageUrl(data.cover, true);
          coverImg.style.display = "";
          // 标记本次卡片需要在网格里绕开缓存 (下次渲染后即可恢复用缓存 URL)
          coverBustNames.add(name);
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
          coverBustNames.add(name);
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
      panelTitle("✏️ <" + state.type + ":" + name + ">"),
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
    // 独立删除按钮比双击误触风险高, 加一次确认 (移到系统回收站, 可恢复)
    const okDelete = await confirmDialog("确定删除卡片「" + name + "」吗? 会移到系统回收站, 可恢复。", { danger: true });
    if (!okDelete) return;
    await del(`/api/wildcards/${encodeURIComponent(state.type)}/${encodeURIComponent(name)}`);
    toast("已删除 (移到回收站) 🗑️", "success");
    selection.delete(name);
    renderEditPlaceholder();
    syncSelection();
    await loadCards();
  }  // 删除后同步共享选择 (其它分类的选中保留)

  /** 编辑区复位 (未选中任何卡片 / 删除卡片 / 取消编辑)。
   *  原先这里渲染一块"✏️ 编辑卡片 / 从左侧选择一张卡片后在此编辑…"的占位说明面板,
   *  用户反馈多余 —— 现在直接隐藏右侧编辑卡片, 左栏网格占满整行 (.wc-panel-grid.single);
   *  只有真正选中卡片或点"新建卡片"时右侧才出现。 */
  function renderEditPlaceholder() {
    state.name = null;
    editActive = false;
    editLib = null;
    clear(editCard);
    editCard.classList.add("hidden");
    layout.classList.add("single");
  }

  /** 收藏提示词: 在右侧编辑区展示与"新建卡片"同款的表单。
   *  分类下拉的数据源是提示词库的分类 (内置分组 + 用户分类), 不是卡片分类。 */
  function showPromptCreate() {
    state.name = null;
    editActive = true;                     // 右侧编辑卡片承载内容了
    editLib = "prompts";                   // 这个面板属于提示词库
    editCard.classList.remove("hidden");
    layout.classList.remove("single");
    clear(editCard);
    // 分类留空: 让用户自己选/填 (留空保存时落 "默认" 分类, 见 savePromptLib)
    plCatInput.value = "";
    const addCurBtn = el("button", {
      class: "btn btn-sm btn-file",
      type: "button",
      text: "➕ 添加当前提示词",
      title: "把上方提示词编辑器中的当前内容填入此输入框",
      onclick: () => {
        const cur = (opts.addTarget?.get() || "").trim();
        if (!cur) { toast("上方提示词为空, 没有可添加的内容", "warning"); return; }
        const existing = plInput.value.trim().replace(/,\s*$/, "");
        plInput.value = existing ? `${existing}, ${cur}` : cur;
        plInput.dispatchEvent(new Event("input", { bubbles: true }));
        toast("已填入当前提示词 🌸", "success");
      },
    });
    const contentLabel = el("label", { class: "wc-field-label" }, [
      document.createTextNode("内容"),
      // 标题行右侧挂 Wildcards 按钮 (与图片生成页的提示词输入框同款交互)
      wildcardsButton(plInput, { title: "内容" }),
    ]);
    const taBox = el("div", { class: "ta-box" }, [plInput]);
    editCard.append(
      el("div", { class: "card-title", text: "📚 收藏提示词" }),
      el("div", { class: "field" }, [el("label", { text: "分类" }), plCatWrap]),
      el("div", { class: "field" }, [contentLabel, taBox]),
      el("div", { class: "wc-edit-actions" }, [
        addCurBtn,
        el("button", { class: "btn btn-sm btn-primary", text: "✅ 保存", onclick: savePromptLib }),
        el("button", { class: "btn btn-sm btn-ghost", text: "✖ 取消", onclick: renderEditPlaceholder }),
      ]),
    );
    // 与"新建卡片"的提示词输入框一致: portal 补全 (逃出弹窗裁剪)
    wireAutocomplete(plInput, taBox, { portal: editCard });
    plInput.focus();
  }

  /** 新建卡片: 在右侧编辑区展示完整表单 (分类可选已有分类或自行输入) */
  function showCreate() {
    state.name = null;
    editActive = true;                     // 新建表单也算编辑内容
    editLib = "cards";                     // 这个面板属于卡片库
    editCard.classList.remove("hidden");
    layout.classList.remove("single");
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
      panelTitle("✨ 新建卡片"),
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
    if (closeTypeDdRef) document.removeEventListener("click", closeTypeDdRef);
    const closeTypeDd = (e) => {
      const wrap = editCard.querySelector(".wc-type-wrap");
      if (wrap && e.target instanceof Element && !wrap.contains(e.target)) wrap.querySelector(".wc-type-dd")?.remove();
    };
    document.addEventListener("click", closeTypeDd);
    closeTypeDdRef = closeTypeDd;
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
  if (!(opts && opts.only === "vibes")) await ensureCardTypeSelected();

  // 只显示 Vibe 库的模式 (从生成页的"🎭 Vibe 库"按钮打开): 藏掉库页签与编辑面板
  if (opts && opts.only === "vibes") {
    libTabs.classList.add("hidden");
    createBtn.classList.add("hidden");
    plAddBtn.classList.add("hidden");
    browseCard.classList.add("wc-only-vibes");
    switchLib("vibes");
  }
}

// 兼容旧入口
export async function render(container, ctx) {
  return renderPanel(container, ctx);
}

export function onShow() {}
