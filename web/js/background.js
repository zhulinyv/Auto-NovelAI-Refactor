// ============================================================
// 自定义背景: 单张图片 / 文件夹轮播 (跨端口/浏览器持久化)
//   状态保存在后端 outputs/bg_state.json, 首次启动时自动从 localStorage 迁移
// ============================================================
import { el, toast, enableDrop } from "./ui.js";
import { imageUrl, uploadFiles, get, post } from "./api.js";

const KEY_SINGLE = "anr-bg";
const KEY_FOLDER = "anr-bg-folder";
const KEY_INTERVAL = "anr-bg-interval";

let rotationList = [];
let rotationIdx = 0;
let rotationTimer = null;
let popoverEl = null;
let bgState = { single: null, folder: null, interval: 10, api: false, apiSource: "bing" };

function savedInterval() {
  return Number.isFinite(bgState.interval) && bgState.interval >= 10 ? bgState.interval : 90;
}

export function applyBackground() {
  const body = document.body;
  let src = null;
  if (rotationList.length) {
    src = rotationList[rotationIdx % rotationList.length];
  } else {
    src = bgState.single || null;
  }
  body.classList.toggle("has-custom-bg", !!src);
  if (src) body.style.backgroundImage = "url(" + imageUrl(src) + ")";
  else body.style.backgroundImage = "";
}

function startRotation() {
  stopRotation();
  if (!rotationList.length) return;
  rotationTimer = setInterval(() => {
    rotationIdx = (rotationIdx + 1) % rotationList.length;
    applyBackground();
  }, savedInterval() * 1000);
}

function stopRotation() {
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
}

function setFolder(files) {
  rotationList = files;
  rotationIdx = 0;
  bgState.folder = files;
  bgState.single = null;
  saveState();
  startRotation();
  applyBackground();
}

async function saveState() {
  try {
    await post("/api/bg/state", {
      single: bgState.single,
      folder: bgState.folder,
      interval: bgState.interval,
      api: !!bgState.api,
      api_source: bgState.apiSource || "bing",
    });
  } catch { /* 静默失败 */ }
}

async function loadState() {
  try {
    const res = await get("/api/bg/state");
    if (res && res.single) bgState.single = res.single;
    bgState.api = !!res.api;
    if (res.api_source) bgState.apiSource = res.api_source;
    if (res && Array.isArray(res.folder) && res.folder.length) bgState.folder = res.folder;
    if (res && Number.isFinite(res.interval) && res.interval >= 3) bgState.interval = res.interval;

    // 从 localStorage 迁移 (旧版本遗留数据)
    const localSingle = localStorage.getItem(KEY_SINGLE);
    const localFolder = localStorage.getItem(KEY_FOLDER);
    let migrated = false;
    if (!bgState.single && !bgState.folder && (localSingle || localFolder)) {
      if (localSingle) {
        bgState.single = localSingle;
        migrated = true;
      }
      if (localFolder) {
        try {
          const arr = JSON.parse(localFolder);
          if (Array.isArray(arr) && arr.length) { bgState.folder = arr; migrated = true; }
        } catch {}
      }
      const localInt = parseInt(localStorage.getItem(KEY_INTERVAL), 10);
      if (Number.isFinite(localInt) && localInt >= 3) { bgState.interval = localInt; }
      if (migrated) await saveState();
    }

    // 恢复轮播
    if (bgState.folder && bgState.folder.length) {
      rotationList = bgState.folder;
      startRotation();
    }
    applyBackground();
  } catch {
    // 后端未就绪时使用 localStorage 回退
    const localSingle = localStorage.getItem(KEY_SINGLE);
    if (localSingle) bgState.single = localSingle;
    try {
      const localFolder = localStorage.getItem(KEY_FOLDER);
      if (localFolder) { const arr = JSON.parse(localFolder); if (Array.isArray(arr) && arr.length) { rotationList = arr; startRotation(); } }
    } catch {}
    applyBackground();
  }
}

export async function initBackground() {
  await loadState();
  if (bgState.api) startApiRotation();
  // 单张图片失效探测 (仅在服务端无数据时用 localStorage 兜底)
  if (bgState.single) {
    const probe = new Image();
    probe.onerror = () => {
      bgState.single = null;
      saveState();
      applyBackground();
      toast("背景图片已失效, 已恢复默认", "warning");
    };
    probe.src = imageUrl(bgState.single);
  }
}

// ---------------- 在线壁纸: 获取与按切换间隔自动轮换 ----------------

let apiTimer = null;

function stopApiRotation() {
  if (apiTimer) { clearInterval(apiTimer); apiTimer = null; }
}

function startApiRotation() {
  stopApiRotation();
  if (!bgState.api) return;
  apiTimer = setInterval(async () => {
    await fetchApiWallpaper({ silent: true });
  }, Math.max(10, savedInterval()) * 1000);
}

/** 从 /api/bg/random 获取一张在线壁纸并应用; silent=true 时不弹通知 (自动轮换) */
async function fetchApiWallpaper({ silent = false } = {}) {
  try {
    const res = await post("/api/bg/random", { source: bgState.apiSource || "bing" });
    bgState.single = res.path;
    bgState.folder = null;
    rotationList = [];
    stopRotation();
    await saveState();
    applyBackground();
    if (popoverEl) refreshPopoverState(popoverEl);
    if (!silent) toast(`背景已更新: ${res.source || "在线壁纸"} 🖼️`, "success");
    return true;
  } catch (e) {
    if (!silent) toast("获取在线壁纸失败: " + e.message, "error");
    return false;
  }
}

// ---------------- 顶部按钮 + 弹层 ----------------

export function initBackgroundUI() {
  const btn = document.getElementById("bg-toggle");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = getPopover();
    // 打开本弹层前先收起其它顶部弹层 (背景/外观互斥, 避免重叠)
    document.querySelectorAll(".bg-popover").forEach((p) => { if (p !== pop) p.classList.add("hidden"); });
    pop.classList.toggle("hidden");
    if (!pop.classList.contains("hidden")) refreshPopoverState(pop);
  });
  // 点击弹层内部不关闭 (与外观设置弹层一致); 点击外部或再次点击按钮才关闭
  document.addEventListener("click", (e) => {
    if (popoverEl && !popoverEl.contains(e.target)) popoverEl.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popoverEl) popoverEl.classList.add("hidden");
  });
}

function getPopover() {
  if (popoverEl) return popoverEl;
  const pop = el("div", { class: "bg-popover hidden", id: "bg-popover" });

  const title = el("div", { class: "bg-title", text: "🖼️ 自定义背景" });

  // ---- 单张图片 ----
  const singleBox = el("div", { class: "field" }, [el("label", { text: "🖼️ 单张图片 (拖入即替换)" })]);
  const singleName = el("span", { class: "file-chip", text: "未设置" });
  const singleBtn = el("button", { class: "btn btn-sm btn-file", text: "选择图片" });
  const singleClear = el("button", { class: "btn btn-sm btn-clear-file", text: "✖" });
  singleClear.title = "清除单张背景";
  const singleFile = el("input", { type: "file", accept: "image/*", style: "display:none;" });
  async function singleUpload(list) {
    if (!list || !list.length) return;
    try {
      const res = await uploadFiles([...list]);
      if (!res.length) return;
      bgState.single = res[0].path;
      bgState.folder = null;
      bgState.api = false;
      rotationList = [];
      stopRotation();
      stopApiRotation();
      await saveState();
      applyBackground();
      refreshPopoverState(pop);
      toast("背景已更新 🖼️", "success");
    } catch (e) {
      toast("背景上传失败: " + e.message, "error");
    }
  }
  singleBtn.addEventListener("click", async () => {
    try {
      const { pickFile } = await import("./api.js");
      const path = await pickFile();
      if (path) {
        bgState.single = path;
        bgState.folder = null;
        bgState.api = false;
        rotationList = [];
        stopRotation();
        stopApiRotation();
        await saveState();
        applyBackground();
        refreshPopoverState(pop);
        toast("背景已更新 🖼️", "success");
      }
    } catch (e) { toast("选择文件失败: " + e.message, "error"); }
  });
  singleClear.addEventListener("click", () => {
    bgState.single = null;
    saveState();
    applyBackground();
    refreshPopoverState(pop);
  });
  singleFile.addEventListener("change", () => singleUpload(singleFile.files));
  enableDrop(pop, { onFiles: (f) => singleUpload(f) });
  singleBox.append(el("div", { class: "file-pick-row" }, [singleName, singleBtn, singleClear]), singleFile);
  pop.append(singleBox);

  // ---- 在线壁纸 (API 随机换图): Bing 每日精选 / Picsum, 后端代理下载 ----
  const apiBox = el("div", { class: "field bg-api-auto" }, [el("label", { text: "🌐 在线壁纸 (选择图片来源)" })]);
  // 壁纸源选择: Bing 每日精选 / ACG 随机动漫
  const srcGroup = el("div", { class: "opt-group bg-api-src" }, [
    el("label", { class: "opt-item" + (bgState.apiSource !== "acg" ? " selected" : ""), text: "Bing 每日精选" }),
    el("label", { class: "opt-item" + (bgState.apiSource === "acg" ? " selected" : ""), text: "ACG 动漫" }),
  ]);
  srcGroup.addEventListener("click", (e) => {
    const item = e.target instanceof Element ? e.target.closest(".opt-item") : null;
    if (!item) return;
    bgState.apiSource = item.textContent.includes("ACG") ? "acg" : "bing";
    [...srcGroup.children].forEach((x) => x.classList.toggle("selected", x === item));
    saveState();
    toast(`壁纸来源已切换: ${item.textContent} 🖼️`, "info");
  });
  const apiBtn = el("button", { class: "btn btn-sm", style: "width:100%;", type: "button", text: "🎲 立即随机换一张" });
  // 点击 "立即随机换一张" 即开启自动轮换 (按下方切换间隔, 无需再手动操作)
  apiBtn.addEventListener("click", async () => {
    apiBtn.disabled = true;
    const oldText = apiBtn.textContent;
    apiBtn.textContent = "⏳ 正在获取壁纸...";
    bgState.api = true;
    bgState.folder = null;
    rotationList = [];
    stopRotation();
    await saveState();
    const ok = await fetchApiWallpaper();
    startApiRotation();
    apiBtn.disabled = false;
    apiBtn.textContent = oldText;
    refreshPopoverState(pop);
    if (ok) toast(`在线壁纸自动轮换已开启 (每 ${savedInterval()} 秒) 🎠`, "success");
  });
  apiBox.append(srcGroup, apiBtn);
  pop.append(apiBox);

  // ---- 文件夹轮播: 选择后立即展示一张, 之后按间隔自动切换 ----
  const folderBox = el("div", { class: "field" }, [el("label", { text: "📁 文件夹轮播 (选择后立即生效)" })]);
  const folderPick = el("button", { class: "btn btn-sm", style: "width:100%;", type: "button", text: "📁 选择文件夹" });
  const folderInfo = el("div", { class: "muted bg-folder-info" });
  folderPick.addEventListener("click", async () => {
    try {
      const { pickFolder } = await import("./api.js");
      const p = await pickFolder();
      if (!p) return;
      const res = await post("/api/bg/list", { path: p });
      if (!res.files || !res.files.length) { toast("文件夹中没有图片", "warning"); return; }
      bgState.api = false;
      stopApiRotation();
      setFolder(res.files);
      refreshPopoverState(pop);
      toast(`已载入 ${res.files.length} 张图片, 立即生效并按间隔轮播 🎠`, "success");
    } catch (e) { toast("选择文件夹失败: " + e.message, "error"); }
  });
  folderBox.append(folderPick, folderInfo);
  pop.append(folderBox);

  // ---- 切换间隔 ----
  const intBox = el("div", { class: "field" }, [el("label", { text: "⏱️ 切换间隔 (秒)" })]);
  const intervalInput = el("input", { type: "number", min: 10, max: 3600, step: 1, value: savedInterval() });
  intervalInput.addEventListener("change", () => {
    let v = parseInt(intervalInput.value, 10);
    if (!Number.isFinite(v) || v < 10) v = 10;
    intervalInput.value = v;
    bgState.interval = v;
    saveState();
    startRotation();
    if (bgState.api) startApiRotation();
    toast(`切换间隔已设为 ${v} 秒`, "info");
  });
  intBox.append(intervalInput);
  pop.append(intBox);

  // ---- 操作 ----
  const resetBtn = el("button", { class: "btn btn-sm btn-danger", text: "🗑️ 恢复默认背景" });
  resetBtn.addEventListener("click", async () => {
    bgState.single = null;
    bgState.folder = null;
    bgState.api = false;
    rotationList = [];
    stopRotation();
    stopApiRotation();
    await saveState();
    applyBackground();
    refreshPopoverState(pop);
    toast("已恢复默认背景", "info");
  });
  pop.append(el("div", { class: "bg-actions" }, [resetBtn]));

  popoverEl = pop;
  document.body.append(pop);
  return pop;
}

function refreshPopoverState(pop) {
  const singleName = pop.querySelector(".file-chip");
  const folderInfo = pop.querySelector(".bg-folder-info");
  const pathInput = pop.querySelector('input[type="text"]');
  singleName.textContent = bgState.single ? bgState.single.split("/").pop() : "未设置";
  singleName.title = bgState.single || "";
  if (bgState.api) {
    folderInfo.textContent = `当前: 在线壁纸自动轮换 (每 ${savedInterval()} 秒)`;
  } else if (bgState.folder && bgState.folder.length) {
    folderInfo.textContent = `轮播中: ${bgState.folder.length} 张, 间隔 ${savedInterval()} 秒`;
  } else {
    folderInfo.textContent = bgState.single ? "当前: 单张背景" : "未设置背景";
  }
  if (pathInput && !pathInput.value) pathInput.value = "";
  const intervalInput = pop.querySelector('input[type="number"]');
  if (intervalInput) intervalInput.value = savedInterval();
  const apiAuto = pop.querySelector(".bg-api-auto input[type='checkbox']");
  if (apiAuto) apiAuto.checked = !!bgState.api;
}
