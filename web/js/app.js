// ============================================================
// 应用入口: 主题、日志、事件流、视图路由
// ============================================================
import { initTheme } from "./theme.js";
import { initBackground, initBackgroundUI } from "./background.js";
import { initLogConsole } from "./components.js";
import { initEmoji } from "./emoji.js";
import { initHitokoto } from "./hitokoto.js";
import { initQueueModal } from "./queueModal.js";
import { fetchState } from "./api.js";
import { $, $$, el, bus, toast, initFancySelects } from "./ui.js";

import * as generateView from "./views/generate.js";
import * as directorView from "./views/director.js";
import * as upscaleView from "./views/upscale.js";
import * as pnginfoView from "./views/pnginfo.js";
import * as selectorView from "./views/selector.js";
import * as browseView from "./views/gallery.js";
import * as pluginsView from "./views/plugins.js";
import * as settingsView from "./views/settings.js";
import * as sponsorView from "./views/sponsor.js";
import "./wildcardsModal.js"; // Wildcards 全屏弹窗: 全局点击委托 + 按钮处理

const VIEWS = {
  generate: generateView,
  director: directorView,
  upscale: upscaleView,
  pnginfo: pnginfoView,
  selector: selectorView,
  browse: browseView,
  plugins: pluginsView,
  settings: settingsView,
  sponsor: sponsorView,
};

export let appState = null;

export function setAppState(next) { appState = next; }

// 自定义背景逻辑已移至 ./background.js

async function boot() {
  initTheme();
  initEmoji();
  initFancySelects();
  const log = initLogConsole();

  // ---- SSE 事件流 ----
  const es = new EventSource("/api/events");
  const connDot = document.getElementById("conn-status");
  es.onopen = () => { connDot.classList.add("online"); connDot.classList.remove("offline"); };
  es.onerror = () => { connDot.classList.add("offline"); connDot.classList.remove("online"); };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    switch (ev.type) {
      case "log":
        log.addLine(ev.level, ev.message, ev.exception);
        break;
      case "queue:update":
        lastQueue = ev.queue || null;
        updateJobStatus();
        bus.emit("queue:update", lastQueue);
        break;
      case "job:start":
        // 生图队列任务的状态由 queue:update 快照计算, 其余任务按旧逻辑显示
        if (!isQueueTask(ev.id)) { otherJobs.set(ev.id, ev.name); updateJobStatus(); }
        bus.emit("job:start", ev);
        break;
      case "job:done":
        otherJobs.delete(ev.id);
        updateJobStatus();
        bus.emit("job:done", ev);
        break;
      case "job:failed":
        otherJobs.delete(ev.id);
        updateJobStatus();
        bus.emit("job:failed", ev);
        // 插件任务失败由 plugins.js 统一弹通知, 避免重复; 其余任务在此统一提示
        if (!ev.name?.startsWith("plugin:")) toast(ev.error || "任务失败", "error", 6000);
        break;
      case "job:event":
        bus.emit("job:event", ev);
        break;
    }
  };

  // ---- 加载应用状态 ----
  try {
    const [state] = await Promise.all([fetchState(), initBackground()]);  // 背景状态与应用状态并行加载
    appState = state;
    document.getElementById("version-badge").textContent = "v" + appState.version;
  } catch (e) {
    toast("无法连接后端服务: " + e.message, "error");
    return;
  }
  initBackgroundUI();
  initQueueModal(appState.queue || null);

  // ---- 侧边导航: 静态视图 + 每个插件一个入口 ----
  const navHolder = document.getElementById("plugin-nav-items");
  (appState.plugins || []).forEach((plugin) => {
    const item = el("a", { class: "nav-item", "data-view": `plugin-${plugin.name}` }, [
      el("span", { class: "nav-icon", text: plugin.icon || "🧩" }),
      document.createTextNode(plugin.title || plugin.name),
    ]);
    navHolder.append(item);
  });

  $$(".nav-item").forEach((item) => {
    item.addEventListener("click", () => showView(item.dataset.view));
  });

  initSidebarResize();
  showView("generate");

  // ---- 非关键请求放到首屏渲染之后: 一言 (拉取慢/失败都不影响首屏) ----
  initHitokoto();
}

/** 视图首次访问时渲染 (加快启动); 已渲染过的直接复用 */
const renderedViews = new Set();

function ensureView(name) {
  const view = VIEWS[name];
  const container = document.getElementById(`view-${name}`);
  if (!view || !container || renderedViews.has(name)) return Promise.resolve();
  renderedViews.add(name);
  return view.render(container, { app: appState, store: makeStore(name) }).catch((e) => {
    console.error(`view ${name} render error`, e);
    renderedViews.delete(name);
    container.innerHTML = `<div class="card">视图 ${name} 渲染失败: ${e.message}</div>`;
  });
}

function makeStore(name) {
  const key = `anr-form-${name}`;
  return {
    load() {
      try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
    },
    save(data) {
      try { localStorage.setItem(key, JSON.stringify(data)); } catch {}
    },
  };
}

// ---------------- 任务状态栏 (按生图队列快照 + 本地任务计算) ----------------

let lastQueue = null;                 // 最近一次生图队列快照
const otherJobs = new Map();          // 非队列后台任务 (超分等): id -> name

function isQueueTask(jobId) {
  return !!lastQueue?.tasks?.some((t) => t.id === jobId);
}

function updateJobStatus() {
  const node = document.getElementById("job-status");
  if (!node) return;
  // 队列快照晚于 job:start 到达时, 运行中队列任务可能被误记为本地任务, 在此剔除
  for (const id of [...otherJobs.keys()]) {
    if (isQueueTask(id)) otherJobs.delete(id);
  }
  const parts = [];
  const q = lastQueue;
  if (q) {
    const tasks = q.tasks || [];
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = tasks.filter((t) => t.status === "pending").length;
    const cooling = (q.workers || []).some((w) => w.status === "cooling");
    if (running) parts.push(`⏳ 生图 ${running}/${q.worker_count ?? "?"}`);
    if (pending) parts.push(`📋 排队 ${pending}`);
    if (!running && cooling) parts.push("❄️ 冷却中");
  }
  if (otherJobs.size) parts.push(`🛠️ 本地任务 ${otherJobs.size}`);
  const busy = parts.length > 0;
  node.textContent = busy ? parts.join(" · ") : "✅ 空闲";
  node.classList.toggle("busy", busy);
}

export function showView(name) {
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
  $$(".view").forEach((v) => { v.style.display = "none"; });

  // 插件视图: 每个已安装插件一个独立页面
  if (name.startsWith("plugin-")) {
    const pluginName = name.slice("plugin-".length);
    const target = document.getElementById("view-plugin-page");
    if (!target) return;
    target.style.display = "block";
    pluginsView.renderPluginPage(pluginName, target, { app: appState });
    return;
  }

  const target = document.getElementById(`view-${name}`);
  if (target) {
    target.style.display = "block";
    const view = VIEWS[name];
    if (view) {
      // 首次访问异步渲染, 完成后再调 onShow; 再次访问只调 onShow。
      // 返回渲染完成的 Promise, 供跨视图跳转后需要立即操作目标视图组件的调用方 await。
      return ensureView(name).then(() => {
        try { view.onShow?.(); } catch { /* 忽略 onShow 异常 */ }
      });
    }
  }
}

export function refreshState() {
  return fetchState().then((s) => { appState = s; return s; });
}

// ---------------- 侧边栏拖拽调整宽度 ----------------

function initSidebarResize() {
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebar-resizer");
  const collapseBtn = document.getElementById("sidebar-collapse");
  if (!sidebar) return;
  const saved = localStorage.getItem("anr-sidebar-width");
  if (saved) sidebar.style.width = saved + "px";

  // 恢复折叠状态
  if (localStorage.getItem("anr-sidebar-collapsed") === "1") {
    sidebar.classList.add("collapsed");
    sidebar.style.width = "50px";
    sidebar.style.minWidth = "50px";
    if (collapseBtn) collapseBtn.textContent = "▶";
  }

  if (resizer) {
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (sidebar.classList.contains("collapsed")) return;
      resizer.classList.add("active");
      const startX = e.clientX;
      const startW = sidebar.offsetWidth;
      const onMove = (ev) => {
        const w = Math.min(340, Math.max(160, startW + (ev.clientX - startX)));
        sidebar.style.width = w + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        resizer.classList.remove("active");
        localStorage.setItem("anr-sidebar-width", String(sidebar.offsetWidth));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // 折叠/展开: 隐藏文字只留图标, 右侧获得更多宽度
  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      const collapsed = sidebar.classList.toggle("collapsed");
      collapseBtn.textContent = collapsed ? "▶" : "◀ 收起";
      if (collapsed) {
        sidebar.dataset.prevWidth = sidebar.offsetWidth;
        sidebar.style.width = "50px";
        sidebar.style.minWidth = "50px";
        localStorage.setItem("anr-sidebar-collapsed", "1");
      } else {
        const w = parseInt(sidebar.dataset.prevWidth, 10) || parseInt(saved, 10) || 170;
        sidebar.style.width = w + "px";
        sidebar.style.minWidth = "";
        localStorage.setItem("anr-sidebar-collapsed", "0");
      }
    });
  }
}

boot();