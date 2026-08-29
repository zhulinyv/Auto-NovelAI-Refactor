// ============================================================
// 图片浏览视图: 浏览项目 outputs 目录下的图片
//   左 1/4: 输出文件夹选择    右 3/4: 图片网格 (默认按文件名正序)
//   右上角: 排序方式 (名称/修改时间/大小) + 递归展示复选框 + 正序/倒序
//   悬停突出显示; 双击打开应用内全屏查看器 (图片居中偏左, 右侧按钮:
//   "使用该图片参数" / "发送到图片生成" / "发送到法术解析")
//   浏览期间每 5 秒轮询目录变化, 内容有变自动刷新 (temp_ 文件已排除)
// ============================================================
import { $, el, clear, toast } from "../ui.js";
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
  recursive: false,
  folderSig: "",
  imgSig: "",
};

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
    showView("pnginfo");
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

  viewerEl.append(
    el("div", { class: "img-viewer-head" }, [
      el("span", { class: "img-viewer-name", text: name || "" }),
      el("button", { class: "btn btn-sm btn-danger", type: "button", text: "✖ 关闭", onclick: closeViewer }),
    ]),
    el("div", { class: "img-viewer-body" }, [
      el("div", { class: "img-viewer-img-wrap" }, [img]),
      el("div", { class: "img-viewer-side" }, [
        el("div", { class: "img-viewer-tip", text: "操作在主界面完成: 导入生成参数 / 载入图生图基础图片 / 打开法术解析。点击图片可切换原始大小。" }),
        mkBtn("🎯 使用该图片参数", "use-params"),
        mkBtn("🖼️ 发送到图片生成", "to-img2img"),
        mkBtn("🔮 发送到法术解析", "to-pnginfo"),
      ]),
    ]),
  );

  viewerEl.addEventListener("mousedown", (e) => { if (e.target === viewerEl) closeViewer(); });
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
  const list = sortedImages();
  if (count) count.textContent = `共 ${list.length} 张图片`;
  if (!list.length) {
    grid.append(el("div", { class: "browse-empty", text: "该目录下没有图片" }));
    return;
  }
  list.forEach((img) => {
    // 递归模式下, 子文件夹中的图片在名字前加 📂 标识
    const dirDepth = state.dir ? state.dir.split("/").length + 1 : 1;
    const sub = state.recursive && img.path.split("/").length > dirDepth;
    const item = el("div", { class: "browse-item", title: `${img.name}\n双击全屏查看` });
    item.append(
      el("img", { src: imageUrl(img.path), alt: img.name, loading: "lazy" }),
      el("div", { class: "b-name", text: sub ? "📂 " + img.name : img.name }),
    );
    item.addEventListener("click", () => openViewer(img.path, img.name));
    grid.append(item);
  });
}

function renderFolders() {
  const box = document.getElementById("browse-folders");
  if (!box) return;
  clear(box);
  state.folders.forEach((f) => {
    const depth = f ? f.split("/").length : 0;
    const label = f ? f.split("/").pop() : "outputs (根目录)";
    const row = el("div", {
      class: "browse-folder" + (f === state.dir ? " active" : ""),
      title: f || "outputs",
      style: `padding-left:${10 + depth * 14}px;`,
    }, [
      el("span", { text: f ? "📁" : "🏠" }),
      el("span", { text: label, style: "overflow:hidden;text-overflow:ellipsis;" }),
    ]);
    row.addEventListener("click", async () => {
      state.dir = f;
      renderFolders();
      await loadImages();
    });
    box.append(row);
  });
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
    el("h2", {}, ["📚 图片浏览", el("span", { class: "sub", text: "浏览 outputs 输出目录 · 单击图片全屏查看 (每 5 秒自动检测目录变化)" })]),
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

  await loadFolders();
  await loadImages();
}

export function onShow() {}
