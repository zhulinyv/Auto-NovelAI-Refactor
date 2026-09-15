// ============================================================
// 自定义背景: 单张图片 / 文件夹轮播 (跨端口/浏览器持久化)
//   状态保存在后端 outputs/bg_state.json, 首次启动时自动从 localStorage 迁移
// ============================================================
import { el, toast, enableDrop, bus } from "./ui.js";
import { imageUrl, uploadFiles, get, post } from "./api.js";

const KEY_SINGLE = "anr-bg";
const KEY_FOLDER = "anr-bg-folder";
const KEY_INTERVAL = "anr-bg-interval";

let rotationList = [];
let rotationIdx = 0;
let rotationTimer = null;
let popoverEl = null;
let pidBadge = null;
let bgState = { single: null, folder: null, interval: 120, api: false, apiSource: "bing", art: null };

export const DEFAULT_INTERVAL_SEC = 120;

function savedInterval() {
  return Number.isFinite(bgState.interval) && bgState.interval >= 10 ? bgState.interval : DEFAULT_INTERVAL_SEC;
}

/** 对外: 当前实际生效的图片切换间隔 (秒) ——
 *  文件夹轮播 / 在线自动轮换进行中用用户设置值; 单张图片与默认背景无轮播, 用默认值 */
export function effectiveIntervalSec() {
  return (rotationTimer || apiTimer) ? savedInterval() : DEFAULT_INTERVAL_SEC;
}

/** 轮播启停/间隔变化后广播, 供一言等跟随者重新排程 */
function notifyInterval() { bus.emit("bg-interval", effectiveIntervalSec()); }

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
  notifyInterval();
}

function stopRotation() {
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; notifyInterval(); }
}

function setFolder(files) {
  rotationList = files;
  rotationIdx = 0;
  bgState.folder = files;
  bgState.single = null;
  bgState.art = null;
  updatePidBadge();
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
      art: bgState.art || null,
    });
    return true;
  } catch { return false; }
}

async function loadState() {
  try {
    const res = await get("/api/bg/state");
    if (res && res.single) bgState.single = res.single;
    bgState.api = !!res.api;
    if (res.api_source) bgState.apiSource = res.api_source;
    if (res.art && res.art.pid) bgState.art = res.art;
    if (res && Array.isArray(res.folder) && res.folder.length) bgState.folder = res.folder;
    if (res && Number.isFinite(res.interval) && res.interval >= 3) bgState.interval = res.interval;
    // 旧默认 90 秒迁移到新默认 120 秒
    if (bgState.interval === 90) {
      bgState.interval = 120;
      saveState();
    }

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
      if (migrated) {
        const ok = await saveState();
        // 已成功写入后端后清除 localStorage 旧数据: 否则其中的失效路径
        // 会在每次启动时被重新迁移, 导致反复提示"背景图片已失效"
        if (ok) {
          localStorage.removeItem(KEY_SINGLE);
          localStorage.removeItem(KEY_FOLDER);
          localStorage.removeItem(KEY_INTERVAL);
        }
      }
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
    probe.onerror = async () => {
      bgState.single = null;
      const ok = await saveState();
      // 后端已写回默认后, 一并清除 localStorage 中可能的旧迁移源,
      // 避免下次启动再次迁移同一条失效路径 (后端不可达时保留回退数据)
      if (ok) localStorage.removeItem(KEY_SINGLE);
      applyBackground();
      toast("背景图片已失效, 已恢复默认", "warning");
    };
    probe.src = imageUrl(bgState.single);
  }
}

// ---------------- 在线壁纸: 获取与按切换间隔自动轮换 ----------------

let apiTimer = null;

function stopApiRotation() {
  if (apiTimer) { clearInterval(apiTimer); apiTimer = null; notifyInterval(); }
}

function startApiRotation() {
  stopApiRotation();
  if (!bgState.api) return;
  apiTimer = setInterval(async () => {
    await fetchApiWallpaper({ silent: true });
  }, Math.max(10, savedInterval()) * 1000);
  notifyInterval();
}

/** 从 /api/bg/random 获取一张在线壁纸并应用; silent=true 时不弹通知 (自动轮换) */
async function fetchApiWallpaper({ silent = false } = {}) {
  try {
    const res = await post("/api/bg/random", { source: bgState.apiSource || "bing" });
    bgState.single = res.path;
    bgState.folder = null;
    rotationList = [];
    stopRotation();
    bgState.art = res.pid ? { pid: res.pid, title: res.title || "", author: res.author || "" } : null;
    await saveState();
    applyBackground();
    updatePidBadge();
    if (popoverEl) refreshPopoverState(popoverEl);
    if (!silent) toast(`背景已更新: ${res.source || "在线壁纸"} 🖼️`, "success");
    return true;
  } catch (e) {
    if (!silent) toast("获取在线壁纸失败: " + e.message, "error");
    return false;
  }
}

// ---------------- 顶部按钮 + 弹层 ----------------

/** 右上角 PID 徽标: 当前背景来自 Lolicon/Pixiv 时展示, 点击打开作品页 */
function updatePidBadge() {
  if (!pidBadge) return;
  const art = bgState.art;
  if (!art || !art.pid) {
    pidBadge.classList.add("hidden");
    return;
  }
  pidBadge.textContent = "PID " + art.pid;
  const info = [art.title, art.author].filter(Boolean).join(" · ");
  pidBadge.title = (info ? info + "\n" : "") + "点击查看 Pixiv 作品页";
  pidBadge.classList.remove("hidden");
}

export function initBackgroundUI() {
  const btn = document.getElementById("bg-toggle");
  if (!btn) return;
  // PID 徽标放在壁纸按钮左侧 (仅 API 壁纸时显示)
  pidBadge = document.getElementById("bg-pid");
  if (!pidBadge) {
    pidBadge = el("span", { class: "pixiv-pid hidden", id: "bg-pid" });
    pidBadge.addEventListener("click", () => {
      const pid = bgState.art?.pid;
      if (pid) window.open(`https://www.pixiv.net/artworks/${pid}`, "_blank", "noopener");
    });
    btn.before(pidBadge);
  }
  updatePidBadge();
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
  pop.append(title);

  // ---- 选项卡: 图片 / 在线 / 文件夹 (三种背景方式互斥; 打开时默认停在当前生效方式所在页) ----
  const tabImg = el("button", { class: "bg-tab", type: "button", text: "🖼️ 图片" });
  const tabApi = el("button", { class: "bg-tab", type: "button", text: "🌐 在线" });
  const tabFolder = el("button", { class: "bg-tab", type: "button", text: "📁 文件夹" });
  const tabBar = el("div", { class: "bg-tabs" }, [tabImg, tabApi, tabFolder]);
  const panelImg = el("div", { class: "bg-panel" });
  const panelApi = el("div", { class: "bg-panel hidden" });
  const panelFolder = el("div", { class: "bg-panel hidden" });
  pop.append(tabBar, panelImg, panelApi, panelFolder);
  function switchTab(which) {
    tabImg.classList.toggle("active", which === "img");
    tabApi.classList.toggle("active", which === "api");
    tabFolder.classList.toggle("active", which === "folder");
    panelImg.classList.toggle("hidden", which !== "img");
    panelApi.classList.toggle("hidden", which !== "api");
    panelFolder.classList.toggle("hidden", which !== "folder");
    intBox.classList.toggle("hidden", which === "img"); // 单张图片不轮播, 无需切换间隔
  }
  // 点页签 = 立即切换到该背景方式并生效 (未设置内容时仅提示, 不动当前背景)
  function activateTab(which) {
    switchTab(which);
    if (which === "api") { fetchApiWallpaper(); return; }
    if (which === "img") {
      if (bgState.single) applySingleMode();
      else toast("尚未设置单张背景图片 🖼️", "warning");
      return;
    }
    if (bgState.folder && bgState.folder.length) setFolder(bgState.folder);
    else toast("尚未选择背景图片文件夹 📁", "warning");
  }
  tabImg.addEventListener("click", () => activateTab("img"));
  tabApi.addEventListener("click", () => activateTab("api"));
  tabFolder.addEventListener("click", () => activateTab("folder"));

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
      bgState.art = null;
      updatePidBadge();
      await saveState();
      applyBackground();
      refreshPopoverState(pop);
      switchTab("img");
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
        bgState.art = null;
        updatePidBadge();
        await saveState();
        applyBackground();
        refreshPopoverState(pop);
        switchTab("img");
        toast("背景已更新 🖼️", "success");
      }
    } catch (e) { toast("选择文件失败: " + e.message, "error"); }
  });
  singleClear.addEventListener("click", () => {
    bgState.single = null;
    bgState.art = null;
    updatePidBadge();
    saveState();
    applyBackground();
    refreshPopoverState(pop);
  });
  singleFile.addEventListener("change", () => singleUpload(singleFile.files));
  enableDrop(pop, { onFiles: (f) => singleUpload(f) });
  singleBox.append(el("div", { class: "file-pick-row" }, [singleName, singleBtn, singleClear]), singleFile);
  panelImg.append(singleBox);
  // 切换到"图片"页签: 立即以当前单张图为背景 (停掉文件夹轮播与在线轮换)
  async function applySingleMode() {
    bgState.folder = null;
    bgState.api = false;
    rotationList = [];
    stopRotation();
    stopApiRotation();
    bgState.art = null;
    updatePidBadge();
    await saveState();
    applyBackground();
    refreshPopoverState(pop);
    toast("背景已切换为单张图片 🖼️", "success");
  }

  // ---- 在线: 两个来源选项 (Bing 每日精选 / Lolicon 动漫), 后端代理下载 ----
  const apiBox = el("div", { class: "field" }, [el("label", { text: "🌐 图片来源" })]);
  const srcGroup = el("div", { class: "opt-group bg-api-src" }, [
    el("label", { class: "opt-item" + (bgState.apiSource !== "acg" ? " selected" : ""), text: "Bing 每日精选", "data-src": "bing" }),
    el("label", { class: "opt-item" + (bgState.apiSource === "acg" ? " selected" : ""), text: "Lolicon 动漫", "data-src": "acg" }),
  ]);
  srcGroup.addEventListener("click", (e) => {
    const item = e.target instanceof Element ? e.target.closest(".opt-item") : null;
    if (!item) return;
    bgState.apiSource = item.dataset.src === "acg" ? "acg" : "bing";
    [...srcGroup.children].forEach((x) => x.classList.toggle("selected", x === item));
    saveState();
    toast(`壁纸来源已切换: ${item.textContent} 🖼️`, "info");
    fetchApiWallpaper();   // 切换后立即换一张新来源的壁纸
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
  const apiInfo = el("div", { class: "muted bg-api-info" });
  apiBox.append(srcGroup, apiBtn, apiInfo);
  panelApi.append(apiBox);

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
      switchTab("folder");
      toast(`已载入 ${res.files.length} 张图片, 立即生效并按间隔轮播 🎠`, "success");
    } catch (e) { toast("选择文件夹失败: " + e.message, "error"); }
  });
  const folderShuffleBtn = el("button", { class: "btn btn-sm", type: "button", text: "🎲 立即随机换一张" });
  folderShuffleBtn.style.marginTop = "8px";
  folderShuffleBtn.addEventListener("click", () => {
    const list = rotationList.length ? rotationList : (bgState.folder || []);
    if (!list.length) { toast("尚未选择背景图片文件夹 📁", "warning"); return; }
    if (!rotationList.length) setFolder(list); // 已保存过文件夹但列表未装载 (如当前为在线模式) → 先装载进入轮播
    rotationIdx = Math.floor(Math.random() * rotationList.length);
    applyBackground();
    stopRotation();
    startRotation();   // 从这张开始按间隔继续轮播
    toast("已随机换了一张文件夹壁纸 🎲", "info");
  });
  folderBox.append(folderPick, folderInfo, folderShuffleBtn);
  panelFolder.append(folderBox);

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
    bgState.art = null;
    updatePidBadge();
    await saveState();
    applyBackground();
    refreshPopoverState(pop);
    switchTab("img");
    toast("已恢复默认背景", "info");
  });
  pop.append(el("div", { class: "bg-actions" }, [resetBtn]));

  // 初始页签 = 当前生效方式 (放在末尾: switchTab 依赖 intBox 已声明)
  switchTab(bgState.api ? "api" : (bgState.folder && bgState.folder.length ? "folder" : "img"));
  refreshPopoverState(pop);

  popoverEl = pop;
  document.body.append(pop);
  return pop;
}

function refreshPopoverState(pop) {
  const singleName = pop.querySelector(".file-chip");
  const folderInfo = pop.querySelector(".bg-folder-info");
  const apiInfo = pop.querySelector(".bg-api-info");
  const srcName = bgState.apiSource === "acg" ? "Lolicon 动漫" : "Bing 每日精选";
  if (singleName) {
    singleName.textContent = bgState.single ? bgState.single.split("/").pop() : "未设置";
    singleName.title = bgState.single || "";
  }
  if (apiInfo) {
    apiInfo.textContent = bgState.api
      ? `自动轮换中: ${srcName}, 每 ${savedInterval()} 秒换一张 🎠`
      : `未开启 · 当前来源: ${srcName}, 点上方按钮立即换一张并开始自动轮换`;
  }
  if (folderInfo) {
    folderInfo.textContent = (bgState.folder && bgState.folder.length)
      ? `轮播中: ${bgState.folder.length} 张, 间隔 ${savedInterval()} 秒 🎠`
      : "未选择文件夹";
  }
  const intervalInput = pop.querySelector('input[type="number"]');
  if (intervalInput) intervalInput.value = savedInterval();
}
