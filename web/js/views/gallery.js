// ============================================================
// 图片浏览视图: 浏览项目 outputs 目录下的图片
//   左 1/3: 输出文件夹选择    右 2/3: 图片网格 (默认按文件名正序)
//   右上角: 排序方式 (名称/修改时间/大小) + 正序/倒序切换
//   悬停突出显示; 双击在新窗口放大查看, 查看器右侧提供:
//   "使用该图片参数" (导入生成参数) / "发送到图片生成" (图生图基础图)
//   / "发送到法术解析" — 通过 postMessage 回传主窗口执行
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
};

// ---------------- 查看器回传处理 (模块级注册一次) ----------------

let msgBound = false;

function bindViewerMessages() {
  if (msgBound) return;
  msgBound = true;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.source !== "anr-gallery-viewer" || !d.path) return;
    handleViewerAction(d.action, d.path);
  });
}

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

// ---------------- 新窗口查看器 ----------------

function openViewer(path, name) {
  const win = window.open("", "_blank", "width=1280,height=840");
  if (!win) {
    toast("新窗口被浏览器拦截, 请允许本站弹出窗口后重试", "error");
    return;
  }
  const doc = win.document;
  doc.title = (name || "图片浏览") + " · ANR 查看器";
  const style = doc.createElement("style");
  style.textContent = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body { display: flex; background: #101116; color: #e7e9ee;
           font-family: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; overflow: hidden; }
    .viewer-img-wrap { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .viewer-img-wrap img { max-width: 100%; max-height: 100%; border-radius: 8px;
                           box-shadow: 0 10px 44px rgba(0, 0, 0, 0.55); cursor: zoom-in; }
    .viewer-side { width: 232px; flex-shrink: 0; display: flex; flex-direction: column; justify-content: center;
                   gap: 12px; padding: 24px 20px; border-left: 1px solid rgba(255, 255, 255, 0.08); background: #161821; }
    .viewer-side .fname { font-size: 12.5px; color: #9aa0ae; word-break: break-all; margin-bottom: 6px; }
    .viewer-side button { padding: 11px 12px; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 10px;
                          background: #1e2130; color: #e7e9ee; font-size: 14px; cursor: pointer; transition: all 0.15s; }
    .viewer-side button:hover { border-color: #a78bfa; color: #c4b5fd; transform: translateY(-1px); }
    .viewer-side .tip { font-size: 12px; color: #9aa0ae; line-height: 1.7; margin-top: 8px; }
  `;
  doc.head.append(style);
  const wrap = doc.createElement("div");
  wrap.className = "viewer-img-wrap";
  const img = doc.createElement("img");
  img.src = imageUrl(path);
  img.alt = name || "";
  img.title = "点击切换 原始大小 / 适应窗口";
  let zoomed = false;
  img.addEventListener("click", () => {
    zoomed = !zoomed;
    img.style.maxWidth = zoomed ? "none" : "100%";
    img.style.maxHeight = zoomed ? "none" : "100%";
  });
  wrap.append(img);

  const side = doc.createElement("div");
  side.className = "viewer-side";
  const fname = doc.createElement("div");
  fname.className = "fname";
  fname.textContent = name || "";
  const mkBtn = (text, action) => {
    const b = doc.createElement("button");
    b.textContent = text;
    b.addEventListener("click", () => {
      if (win.opener && !win.opener.closed) {
        win.opener.postMessage({ source: "anr-gallery-viewer", action, path }, win.location.origin);
        b.textContent = "✅ 已发送";
        setTimeout(() => { b.textContent = text; }, 1200);
      } else {
        b.textContent = "⚠️ 主窗口已关闭";
      }
    });
    return b;
  };
  const tip = doc.createElement("div");
  tip.className = "tip";
  tip.textContent = "操作在主窗口完成: 导入生成参数 / 载入图生图基础图片 / 打开法术解析。";
  side.append(fname, mkBtn("🎯 使用该图片参数", "use-params"), mkBtn("🖼️ 发送到图片生成", "to-img2img"), mkBtn("🔮 发送到法术解析", "to-pnginfo"), tip);
  doc.body.append(wrap, side);
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

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
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
    const item = el("div", { class: "browse-item", title: `${img.name}\n双击在新窗口放大查看` });
    item.append(
      el("img", { src: imageUrl(img.path), alt: img.name, loading: "lazy" }),
      el("div", { class: "b-name", text: img.name }),
    );
    item.addEventListener("dblclick", () => openViewer(img.path, img.name));
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
    const res = await get(`/api/browse/images?dir=${encodeURIComponent(state.dir)}`);
    state.images = res.images || [];
  } catch (e) {
    state.images = [];
    toast("读取图片列表失败: " + e.message, "error");
  }
  renderGrid();
}

// ---------------- 视图渲染 ----------------

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  bindViewerMessages();

  container.append(
    el("h2", {}, ["📚 图片浏览", el("span", { class: "sub", text: "浏览 outputs 输出目录 · 双击图片新窗口查看" })]),
  );

  // 左 1/3: 文件夹选择
  const leftCard = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "wc-browse-head" }, [
      el("div", { class: "card-title", text: "📂 文件夹" }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn btn-sm", text: "🔄 刷新", onclick: loadFolders }),
    ]),
    el("div", { class: "browse-folders", id: "browse-folders" }, [
      el("div", { class: "muted", style: "padding:10px;", text: "正在读取..." }),
    ]),
  ]);

  // 右 2/3: 图片网格 + 排序控件
  const sortSel = el("select", {}, [
    ["name", "按文件名"], ["mtime", "按修改时间"], ["size", "按文件大小"],
  ].map(([v, t]) => el("option", { value: v, text: t })));
  sortSel.value = state.sortKey;
  sortSel.addEventListener("change", () => {
    state.sortKey = sortSel.value;
    renderGrid();
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
      dirBtn,
    ]),
    el("div", { class: "browse-grid", id: "browse-grid" }, [
      el("div", { class: "browse-empty", text: "选择左侧文件夹后显示图片" }),
    ]),
  ]);

  const layout = el("div", { class: "browse-layout" });
  layout.append(leftCard, rightCard);
  container.append(layout);

  await loadFolders();
  await loadImages();
}

export function onShow() {}
