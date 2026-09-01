// ============================================================
// 图片浏览视图: 浏览项目 outputs 目录下的图片
//   左 1/4: 输出文件夹选择    右 3/4: 图片网格 (默认按文件名正序)
//   右上角: 排序方式 (名称/修改时间/大小) + 递归展示复选框 + 正序/倒序
//   悬停突出显示; 双击打开应用内全屏查看器 (图片居中偏左, 右侧按钮:
//   "使用该图片参数" / "发送到图片生成" / "发送到法术解析" / "删除 (移到回收站)")
//   浏览期间每 5 秒轮询目录变化, 内容有变自动刷新 (temp_ 文件已排除)
// ============================================================
import { $, el, clear, toast, confirmDialog } from "../ui.js";
import { get, post, imageUrl } from "../api.js";
import { showView } from "../app.js";
import { setGenerateState, sendToImg2img } from "./generate.js";
import { pnginfoPicker } from "./pnginfo.js";

let S = null;
const state = {
  dir: "",
  folders: [],
  images: [],
  sortKey: "name", // name | mtime | size
  sortAsc: true,
  recursive: true, // 递归展示默认开启
  folderSig: "",
  imgSig: "",
  favMode: false,        // true = 右侧展示"我的收藏"
  favItems: [],          // 收藏列表 [{path, name, added_at}]
};
// 文件夹树展开状态 (已展开的文件夹路径集合; 未展开的有子级文件夹只显示一行)
const expandedDirs = new Set();

// ---------------- 我的收藏 (仅保存路径引用, 不移动/复制文件) ----------------

let favPaths = new Set();   // path -> 是否已收藏

async function loadFavorites() {
  try {
    const res = await get("/api/favorites");
    state.favItems = res.items || [];
    favPaths = new Set(state.favItems.map((it) => it.path));
    updateFavUI();
  } catch (e) {
    toast("读取收藏失败: " + e.message, "error");
  }
}

/** 刷新左侧收藏按钮的计数与选中态, 以及收藏模式的文件夹高亮 */
function updateFavUI() {
  const btn = document.getElementById("browse-fav-btn");
  const count = document.getElementById("browse-fav-count");
  if (btn) btn.classList.toggle("active", state.favMode);
  if (count) count.textContent = String(state.favItems.length);
  if (state.favMode) {
    // 收藏模式: 清除文件夹高亮 (退出收藏模式时重新渲染文件夹树恢复)
    document.querySelectorAll(".browse-folder").forEach((r) => r.classList.remove("active"));
  }
  if (state.favMode && btn) btn.classList.add("active");
}

/** 切换收藏状态, 返回操作后的最新状态 (true=已收藏) */
async function toggleFav(path, name) {
  const was = favPaths.has(path);
  try {
    const res = was
      ? await post("/api/favorites/remove", { path })
      : await post("/api/favorites/add", { path, name });
    state.favItems = res.items || [];
    if (was) favPaths.delete(path); else favPaths.add(path);
    updateFavUI();
    if (state.favMode) renderGrid();   // 收藏模式下去除/加入实时刷新网格
    return !was;
  } catch (e) {
    toast((was ? "取消收藏失败: " : "收藏失败: ") + e.message, "error");
    return was;
  }
}

/** 网格内每个图片右上角的星星按钮 */
function makeFavStar(path, name) {
  const on = favPaths.has(path);
  const btn = el("button", {
    class: "browse-fav-star" + (on ? " on" : ""),
    type: "button",
    title: on ? "取消收藏" : "收藏",
  });
  btn.textContent = on ? "★" : "☆";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const now = await toggleFav(path, name);
    btn.classList.toggle("on", now);
    btn.textContent = now ? "★" : "☆";
    btn.title = now ? "取消收藏" : "收藏";
  });
  return btn;
}

/** 网格内每个图片右上角的删除按钮 (在星星左侧) */
function makeBrowseDelBtn(path, name) {
  const btn = el("button", {
    class: "browse-del-btn",
    type: "button",
    title: "把图片移动到系统回收站",
  });
  btn.textContent = "🗑️";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog(`确定将图片「${name}」移动到回收站吗？`, { danger: true });
    if (!ok) return;
    try {
      await post("/api/browse/delete", { path });
      toast("已移动到回收站 🗑️", "success");
      // 若已收藏则同步移除
      if (favPaths.has(path)) await toggleFav(path, name);
      await loadImages();
    } catch (e) {
      toast("删除失败: " + e.message, "error");
    }
  });
  return btn;
}

// ---------------- 查看动作 (查看器按钮直接调用) ----------------

async function handleViewerAction(action, path) {
  if (action === "use-params") {
    try {
      const params = await post("/api/pnginfo/to-generate", { image_path: path });
      setGenerateState(params);
      showView("generate");
      toast("已导入图片参数到图片生成 🌸", "success");
    } catch (e) {
      toast("导入参数失败: " + e.message, "error");
    }
  } else if (action === "to-img2img") {
    const ok = await sendToImg2img(path);
    if (ok) toast("已发送到图片生成 (图生图基础图片) 🌸", "success");
  } else if (action === "to-pnginfo") {
    await showView("pnginfo");
    if (pnginfoPicker?.set) {
      pnginfoPicker.set(path);
      if (pnginfoPicker.onChange) pnginfoPicker.onChange(path);
    }
    toast("已发送到法术解析 🔮", "success");
  }
}

// ---------------- 应用内全屏查看器 (Wildcards 弹窗风格) ----------------

let viewerEl = null;

function closeViewer() {
  if (!viewerEl) return;
  document.removeEventListener("keydown", viewerOnKey);
  viewerEl.remove();
  viewerEl = null;
  document.body.style.overflow = "";
}

function viewerOnKey(e) { if (e.key === "Escape") closeViewer(); }

function openViewer(path, name) {
  closeViewer();
  viewerEl = el("div", { class: "img-viewer-overlay" });

  const img = el("img", { src: imageUrl(path), alt: name || "", title: "点击切换 原始大小 / 适应窗口" });
  let zoomed = false;
  img.addEventListener("click", () => {
    zoomed = !zoomed;
    img.style.maxWidth = zoomed ? "none" : "100%";
    img.style.maxHeight = zoomed ? "none" : "100%";
  });

  const mkBtn = (text, action) => {
    const b = el("button", { class: "btn", type: "button", text });
    b.addEventListener("click", () => {
      closeViewer();
      handleViewerAction(action, path);
    });
    return b;
  };


  // 收藏按钮: 不关闭查看器, 点击切换收藏状态 (不移动/复制文件)
  const favBtn = el("button", {
    class: "btn" + (favPaths.has(path) ? " btn-fav-on" : ""),
    type: "button",
    title: "收藏图片",
  });
  favBtn.textContent = favPaths.has(path) ? "★ 已收藏 (点击取消)" : "☆ 收藏";
  favBtn.addEventListener("click", async () => {
    const now = await toggleFav(path, name);
    favBtn.textContent = now ? "★ 已收藏 (点击取消)" : "☆ 收藏";
    favBtn.classList.toggle("btn-fav-on", now);
  });

  // 删除按钮: 确认后把图片移到系统回收站 (send2trash), 成功后刷新网格
  const delBtn = el("button", { class: "btn btn-danger", type: "button", text: "🗑️ 删除" });
  delBtn.title = "把图片移动到系统回收站";
  delBtn.addEventListener("click", async () => {
    const ok = await confirmDialog(`确定将图片「${name || path}」移动到回收站吗？`, { danger: true });
    if (!ok) return;
    closeViewer();
    try {
      await post("/api/browse/delete", { path });
      toast("已移动到回收站 🗑️", "success");
      // 若已收藏则同步移除
      if (favPaths.has(path)) await toggleFav(path, name);
      await loadImages();
    } catch (e) {
      toast("删除失败: " + e.message, "error");
    }
  });

  viewerEl.append(
    el("div", { class: "img-viewer-head" }, [
      el("span", { class: "img-viewer-name", text: name || "" }),
      el("button", { class: "btn btn-sm btn-danger", type: "button", text: "✖ 关闭", onclick: closeViewer }),
    ]),
    el("div", { class: "img-viewer-body" }, [
      el("div", { class: "img-viewer-img-wrap" }, [img]),
      el("div", { class: "img-viewer-side" }, [
        el("div", { class: "img-viewer-tip", text: "操作在主界面完成: 导入生成参数 / 载入图生图基础图片 / 打开法术解析 / 删除 (移到回收站)。点击图片可切换原始大小。" }),
        mkBtn("🎯 使用该图片参数", "use-params"),
        mkBtn("🖼️ 发送到图片生成", "to-img2img"),
        mkBtn("🔮 发送到法术解析", "to-pnginfo"),
        delBtn,
        favBtn,
      ]),
    ]),
  );

  // 单击空白处关闭: 点击图片 / 右侧操作区 / 顶部栏时不关闭 (图片自身点击 = 切换原始大小)
  viewerEl.addEventListener("click", (e) => {
    if (e.target.closest(".img-viewer-img-wrap img, .img-viewer-side, .img-viewer-head")) return;
    closeViewer();
  });
  document.addEventListener("keydown", viewerOnKey);
  document.body.append(viewerEl);
  document.body.style.overflow = "hidden";
}

// ---------------- 排序与渲染 ----------------

function sortedImages() {
  const list = [...state.images];
  const dir = state.sortAsc ? 1 : -1;
  const key = state.sortKey;
  list.sort((a, b) => {
    if (key === "name") return a.name.localeCompare(b.name, "zh-CN", { numeric: true }) * dir;
    return (a[key] - b[key]) * dir;
  });
  return list;
}

function renderGrid() {
  const grid = document.getElementById("browse-grid");
  const count = document.getElementById("browse-count");
  if (!grid) return;
  clear(grid);
  // 收藏模式: 按收藏时间倒序展示 (最近收藏在前), 不参与目录排序
  const favMode = state.favMode;
  const list = favMode ? state.favItems : sortedImages();
  if (count) count.textContent = favMode ? `共 ${list.length} 张收藏` : `共 ${list.length} 张图片`;
  if (!list.length) {
    grid.append(el("div", { class: "browse-empty", text: favMode ? "还没有收藏的图片 — 点击图片右上角 ☆ 即可收藏" : "该目录下没有图片" }));
    return;
  }
  list.forEach((img) => {
    const item = el("div", { class: "browse-item", title: `${img.name}\n单击全屏查看` });
    item.append(
      el("img", { src: imageUrl(img.path), alt: img.name, loading: "lazy" }),
    );
    // 右上角收藏按钮 (星星) 与删除按钮 (🗑️)
    item.append(makeBrowseDelBtn(img.path, img.name));
    item.append(makeFavStar(img.path, img.name));
    item.addEventListener("click", () => openViewer(img.path, img.name));
    grid.append(item);
  });
}
// ---------------- 文件夹树 (可展开 / 收起) ----------------

/** 把相对路径列表组装成树: { path, children: Map } */
function buildFolderTree(folders) {
  const root = { path: "", children: new Map() };
  for (const f of folders) {
    if (!f) continue;
    const parts = f.split("/");
    let node = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!node.children.has(path)) node.children.set(path, { path, children: new Map() });
      node = node.children.get(path);
    });
  }
  return root;
}

function folderRow(path, label, depth, hasChildren) {
  const open = expandedDirs.has(path);
  const row = el("div", {
    class: "browse-folder" + (path === state.dir ? " active" : ""),
    title: path || "outputs",
    style: `padding-left:${10 + depth * 14}px;`,
  });
  // 展开 / 收起箭头 (无子文件夹的目录占位对齐)
  const caret = el("span", {
    class: "browse-caret" + (hasChildren ? "" : " leaf"),
    text: hasChildren ? (open ? "▾" : "▸") : "",
    title: hasChildren ? (open ? "收起子文件夹" : "展开子文件夹") : "",
  });
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!hasChildren) return;
    if (expandedDirs.has(path)) expandedDirs.delete(path);
    else expandedDirs.add(path);
    renderFolders();
  });
  row.append(
    caret,
    el("span", { text: path ? (open && hasChildren ? "📂" : "📁") : "🏠" }),
    el("span", { text: label, style: "overflow:hidden;text-overflow:ellipsis;" }),
  );
  row.addEventListener("click", async () => {
    state.dir = path;
    state.favMode = false;   // 选择目录时退出"我的收藏"模式
    // 选中目录时自动展开, 方便继续往里浏览
    if (hasChildren) expandedDirs.add(path);
    renderFolders();
    await loadImages();
  });
  return row;
}

function renderFolders() {
  const box = document.getElementById("browse-folders");
  if (!box) return;
  clear(box);
  box.append(folderRow("", "outputs (根目录)", 0, false));
  const root = buildFolderTree(state.folders);
  const walk = (node, depth) => {
    for (const child of node.children.values()) {
      box.append(folderRow(child.path, child.path.split("/").pop(), depth, child.children.size > 0));
      if (expandedDirs.has(child.path)) walk(child, depth + 1);
    }
  };
  walk(root, 1);
}

async function loadFolders() {
  try {
    const res = await get("/api/browse/folders");
    state.folders = res.folders || [];
    state.folderSig = state.folders.join("|");
    if (!state.folders.includes(state.dir)) state.dir = "";
    renderFolders();
  } catch (e) {
    toast("读取文件夹列表失败: " + e.message, "error");
  }
}

async function loadImages() {
  const grid = document.getElementById("browse-grid");
  if (grid) { clear(grid); grid.append(el("div", { class: "browse-empty", text: "🌸 正在加载..." })); }
  // 收藏模式: 直接渲染收藏列表, 不请求目录
  if (state.favMode) {
    renderGrid();
    return;
  }
  try {
    const res = await get(`/api/browse/images?dir=${encodeURIComponent(state.dir)}&recursive=${state.recursive}`);
    state.images = res.images || [];
    state.imgSig = imagesSig(state.images);
  } catch (e) {
    state.images = [];
    toast("读取图片列表失败: " + e.message, "error");
  }
  renderGrid();
}
// ---------------- 自动刷新: 浏览期间轮询目录变化 ----------------

const imagesSig = (images) => images.map((i) => `${i.path}:${i.mtime}:${i.size}`).join("|");
const POLL_MS = 5000;
let pollTimer = null;

function browseVisible() {
  const view = document.getElementById("view-browse");
  return !!view && view.style.display !== "none";
}

async function pollOnce() {
  if (!browseVisible()) return;
  if (state.favMode) return;   // 收藏模式不轮询目录变化
  try {
    const [fRes, iRes] = await Promise.all([
      get("/api/browse/folders"),
      get(`/api/browse/images?dir=${encodeURIComponent(state.dir)}&recursive=${state.recursive}`),
    ]);
    // 文件夹树变化 (如新生成产生了日期子目录)
    const folders = fRes.folders || [];
    if (folders.join("|") !== state.folderSig) {
      state.folders = folders;
      state.folderSig = folders.join("|");
      if (!folders.includes(state.dir)) state.dir = "";
      renderFolders();
      await loadImages();
      return;
    }
    // 当前目录图片变化 (新增/删除生成结果)
    const images = iRes.images || [];
    if (imagesSig(images) !== state.imgSig) {
      state.images = images;
      state.imgSig = imagesSig(images);
      renderGrid();
    }
  } catch { /* 轮询失败静默, 下次再试 */ }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, POLL_MS);
}

// ---------------- 视图渲染 ----------------

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  startPolling();

  container.append(
    el("h2", {}, ["📚 图片浏览", el("span", { class: "sub", text: "浏览 ./outputs 输出目录" })]),
  );

  // 左 1/4: 文件夹选择 (可收起/展开)
  const layout = el("div", { class: "browse-layout" });
  const leftCard = el("div", { class: "card browse-left", style: "margin:0;" }, [
    el("div", { class: "wc-browse-head browse-left-head" }, [
      el("div", { class: "card-title", text: "📂 文件夹" }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-sm", text: "🔄 刷新", onclick: loadFolders }),
      el("button", {
        class: "btn btn-sm",
        text: "◀",
        title: "收起文件夹区域",
        onclick: () => layout.classList.add("left-collapsed"),
      }),
    ]),
    el("div", { class: "browse-folders", id: "browse-folders" }, [
      el("div", { class: "muted", style: "padding:10px;", text: "正在读取..." }),
    ]),
    // 我的收藏: 仅保存路径引用, 不移动/复制文件
    el("div", { class: "browse-fav-section" }, [
      el("button", {
        class: "browse-fav-btn" + (state.favMode ? " active" : ""),
        id: "browse-fav-btn",
        type: "button",
        title: "查看所有收藏的图片 (收藏仅保存路径, 不移动/复制文件)",
      }, [
        el("span", { text: "⭐" }),
        el("span", { text: "我的收藏" }),
        el("span", { class: "browse-fav-count", id: "browse-fav-count", text: "0" }),
      ]),
    ]),
    el("button", {
      class: "browse-left-expand",
      type: "button",
      text: "▶ 文件夹",
      title: "展开文件夹区域",
      onclick: () => layout.classList.remove("left-collapsed"),
    }),
  ]);

  // 右 3/4: 图片网格 + 排序/递归控件
  const sortSel = el("select", {}, [
    ["name", "按文件名"], ["mtime", "按修改时间"], ["size", "按文件大小"],
  ].map(([v, t]) => el("option", { value: v, text: t })));
  sortSel.value = state.sortKey;
  sortSel.addEventListener("change", () => {
    state.sortKey = sortSel.value;
    renderGrid();
  });
  const recursiveCb = el("input", { type: "checkbox" });
  recursiveCb.checked = state.recursive;
  recursiveCb.addEventListener("change", () => {
    state.recursive = recursiveCb.checked;
    loadImages();
  });
  const dirBtn = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: state.sortAsc ? "↑ 正序" : "↓ 倒序",
    title: "切换正序 / 倒序",
  });
  dirBtn.addEventListener("click", () => {
    state.sortAsc = !state.sortAsc;
    dirBtn.textContent = state.sortAsc ? "↑ 正序" : "↓ 倒序";
    renderGrid();
  });
  const rightCard = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "browse-head" }, [
      el("div", { class: "card-title", text: "🖼️ 图片" }),
      el("span", { class: "muted", id: "browse-count", text: "" }),
      el("span", { class: "spacer" }),
      el("span", { class: "muted", text: "排序" }),
      sortSel,
      el("label", { class: "browse-recursive", title: "同时显示所选文件夹的子文件夹中的图片" }, [
        recursiveCb,
        document.createTextNode("递归展示"),
      ]),
      dirBtn,
    ]),
    el("div", { class: "browse-grid", id: "browse-grid" }, [
      el("div", { class: "browse-empty", text: "选择左侧文件夹后显示图片" }),
    ]),
  ]);

  layout.append(leftCard, rightCard);
  container.append(layout);

  // 我的收藏按钮: 切换收藏/目录模式
  const favBtnEl = document.getElementById("browse-fav-btn");
  if (favBtnEl) {
    favBtnEl.addEventListener("click", () => {
      state.favMode = !state.favMode;
      if (!state.favMode) renderFolders();   // 退出收藏模式: 恢复当前文件夹高亮
      updateFavUI();
      loadImages();
    });
  }
  await Promise.all([loadFolders(), loadFavorites()]);   // 目录与收藏并行加载
  await loadImages();
}

export function onShow() {}
