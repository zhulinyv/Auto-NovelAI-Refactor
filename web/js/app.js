// ============================================================
// 应用入口: 主题、日志、事件流、视图路由
// ============================================================
import { initTheme } from "./theme.js";
import { initBackground, initBackgroundUI } from "./background.js";
import { initLogConsole } from "./components.js";
import { initEmoji } from "./emoji.js";
import { initHitokoto } from "./hitokoto.js";
import { initQueueModal } from "./queueModal.js";
import { fetchState, post, get } from "./api.js";
import { $, $$, el, bus, toast, confirmDialog, choiceDialog, initFancySelects, powerIcon } from "./ui.js";

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
  // 本地访问用 SSE; 共享链接 (隧道域名) 下 Cloudflare 会缓冲 SSE 实时流 (实测 60s 零字节),
  // 退化为每 2 秒轮询 /api/live (增量日志 + 队列快照), 保证日志与任务状态可用
  const connDot = document.getElementById("conn-status");

  function handleEvent(ev) {
    switch (ev.type) {
      case "log":
        log.addLine(ev.level, ev.message, ev.exception);
        break;
      case "notice":
        // 后端主动推送的右上角消息通知 (用量提醒 / NAI5 任务跳过等)
        log.addLine(ev.level || "info", ev.message || "");
        toast(ev.message || "通知", ev.level === "error" ? "error" : ev.level === "success" ? "success" : "warning", 10000);
        break;
      case "anlas:update":
        // 剩余点数/用量快照更新 (启动查询 / 生成后按 Token 更新)
        bus.emit("anlas:update", ev);
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
  }

  const isLocalAccess = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  if (isLocalAccess) {
    const es = new EventSource("/api/events");
    es.onopen = () => { connDot.classList.add("online"); connDot.classList.remove("offline"); };
    es.onerror = () => { connDot.classList.add("offline"); connDot.classList.remove("online"); };
    es.onmessage = (e) => {
      let ev;
      try { ev = JSON.parse(e.data); } catch { return; }
      handleEvent(ev);
    };
  } else {
    connDot.classList.add("online");
    let lastLogSeq = 0;
    let lastNotifySeq = 0;
    let lastAnlasSeq = 0;
    async function pollLive() {
      try {
        const d = await get("/api/live?log_after=" + lastLogSeq + "&notify_after=" + lastNotifySeq + "&anlas_after=" + lastAnlasSeq);
        lastLogSeq = d.last ?? lastLogSeq;
        for (const ev of d.logs || []) handleEvent(ev);
        lastNotifySeq = d.notify_last ?? lastNotifySeq;
        for (const ev of d.notifications || []) handleEvent(ev);
        lastAnlasSeq = d.anlas_last ?? lastAnlasSeq;
        for (const ev of d.anlas || []) handleEvent(ev);
        lastQueue = d.queue || lastQueue;
        updateJobStatus();
      } catch { /* 后端忙, 下一轮重试 */ }
    }
    pollLive();
    setInterval(pollLive, 2000);
  }

  // ---- 加载应用状态 ----
  try {
    const [state] = await Promise.all([fetchState(), initBackground()]);  // 背景状态与应用状态并行加载
    appState = state;
    document.getElementById("version-badge").textContent = "v" + appState.version;
    if (appState.update?.available) document.getElementById("version-badge").textContent += " · 更新可用";
  } catch (e) {
    toast("无法连接后端服务: " + e.message, "error");
    return;
  }

  // 插件还在加载 (后端在启动时把插件放进后台线程加载, 共享开关切换后也会重载):
  // 页面上先只有静态视图, 等插件就绪后**就地补上侧栏**, 不再整页刷新 ——
  // 省掉一次完整页面加载 (以及那 800ms 轮询空等), 也不会把已填好的表单 / 已打开的画廊冲掉。
  if (appState.plugins_reload?.reloading) {
    toast("🧩 插件正在加载, 完成后会自动出现在侧栏...", "info", 6000);
    const reloadTimer = setInterval(async () => {
      try {
        const s = await get("/api/plugins/reload-status");
        if (!s.reloading) {
          clearInterval(reloadTimer);
          await adoptPlugins();
        }
      } catch { /* 后端忙, 继续等 */ }
    }, 800);
  }
  initBackgroundUI();
  initQueueModal(appState.queue || null);
  // 初始任务状态同步: 状态栏 + 标签页标题
  lastQueue = appState.queue || null;
  updateJobStatus();

  // ---- 电源按钮: 先选择 关闭/重启, 确认后执行 ----
  document.getElementById("app-close")?.addEventListener("click", async () => {
    const act = await choiceDialog({ icon: powerIcon(17), text: "电源菜单" }, "请选择要执行的操作:", [
      { icon: powerIcon(14), label: "关闭程序", value: "shutdown", danger: true },
      { label: "🔄 重启服务", value: "restart", primary: true },
    ]);
    if (act === "shutdown") {
      const ok = await confirmDialog("确定要退出 Auto-NovelAI-Refactor 吗?\n后端与终端进程将被结束, 浏览器页面将关闭。", { danger: true });
      if (!ok) return;
      toast("正在退出, 再见~ 👋", "warning");
      try { await post("/api/shutdown"); } catch { /* 后端正在退出, 忽略 */ }
      setTimeout(() => {
        window.close();
        // 部分浏览器不允许脚本关闭非脚本打开的页面: 兜底显示告别页
        document.body.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-size:18px;opacity:.75;">👋 已退出 Auto-NovelAI-Refactor, 可以关闭此页面了</div>';
      }, 900);
    } else if (act === "restart") {
      const ok = await confirmDialog("确定要重启服务吗?\n连接将短暂断开, 后端恢复后页面会自动刷新。", { danger: true });
      if (!ok) return;
      toast("🔄 正在重启 WebUI... 连接将短暂断开", "warning");
      try { await post("/api/settings/restart"); } catch { /* 连接断开即重启成功 */ }
      // 轮询后端恢复 (最多 12 秒), 恢复后刷新页面
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          const res = await fetch("/api/state");
          if (res.ok) { location.reload(); return; }
        } catch { /* 后端重启中 */ }
      }
      toast("后端未响应, 请检查服务状态", "error");
    }
  });

  // ---- 侧边导航: 静态视图 + 每个插件一个入口 ----
  buildPluginNav(appState.plugins || []);

  $$(".nav-item").forEach((item) => {
    if (item.closest("#plugin-nav-items")) return; // 插件入口的点击在 buildPluginNav 里绑定
    item.addEventListener("click", () => showView(item.dataset.view));
  });

  // 共享模式: 隐藏插件商店 (访客不可在线安装/管理插件)
  if (appState.settings?.share) {
    const storeNav = document.querySelector('.nav-item[data-view="plugins"]');
    if (storeNav) storeNav.style.display = "none";
  }

  // 挂件开关要在 initSidebarResize() 之前定下状态 (它内部会调 initSidebarCharm 摆位置)
  initCharmToggle();
  initHardReloadUI();
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

// ---------------- 插件侧栏: 插件就绪后就地接管 (不再整页刷新) ----------------

/** 重建侧栏中的插件入口 (每个已安装插件一个); 点击切换到对应插件页。 */
function buildPluginNav(plugins) {
  const navHolder = document.getElementById("plugin-nav-items");
  if (!navHolder) return;
  navHolder.replaceChildren(
    ...(plugins || []).map((plugin) => {
      const item = el("a", { class: "nav-item", "data-view": `plugin-${plugin.name}` }, [
        el("span", { class: "nav-icon", text: plugin.icon || "🧩" }),
        document.createTextNode(plugin.title || plugin.name),
      ]);
      item.addEventListener("click", () => showView(item.dataset.view));
      return item;
    })
  );
}

/** 当前侧栏里的插件名 (按顺序, 用于判断清单是否真的变了)。 */
function pluginNavNames() {
  return Array.from(document.querySelectorAll("#plugin-nav-items .nav-item")).map((n) =>
    (n.dataset.view || "").slice("plugin-".length)
  );
}

/**
 * 插件加载完成后就地接管 (替代原来的 location.reload())。
 *
 * 重新拉一次 /api/state 用新清单重建侧栏; 若用户正停在某个插件页, 顺手用新清单重建该页
 * (面板可能增删), 该插件已不存在则回退到文生图。清单没变时不弹提示, 避免每次启动都报一条。
 */
async function adoptPlugins() {
  const before = pluginNavNames();
  let next;
  try {
    next = await fetchState();
  } catch (e) {
    toast("🧩 插件列表获取失败, 请手动刷新页面: " + e.message, "error", 8000);
    return;
  }
  appState = next;
  setAppState(next);
  buildPluginNav(next.plugins || []);
  const after = pluginNavNames();
  const active = document.querySelector(".nav-item.active")?.dataset.view || "";
  if (active.startsWith("plugin-")) {
    showView(after.includes(active.slice("plugin-".length)) ? active : "generate");
  }
  if (before.join("|") !== after.join("|")) toast(`🧩 插件已就绪 (${after.length} 个)`, "success", 4000);
}

// ---------------- 任务状态栏 (按生图队列快照 + 本地任务计算) ----------------

let lastQueue = null;                 // 最近一次生图队列快照
const otherJobs = new Map();          // 非队列后台任务 (超分等): id -> name

function isQueueTask(jobId) {
  return !!lastQueue?.tasks?.some((t) => t.id === jobId);
}

// ---------------- 浏览器标签页标题 ----------------

const BASE_TITLE = "Auto-NovelAI-Refactor 💗";
const KAOMOJI = [
  "(≧▽≦)", "(´▽`ʃ♡ƪ)", "ヽ(´▽`)/", "(＾▽＾)", "(￣▽￣)ノ",
  "(๑•̀ㅂ•́)و✧", "(｡•ᴗ•｡)♡", "(´,,•ω•,,)♡", "ヾ(≧▽≦*)o", "(◕‿◕)",
  "٩(◕‿◕)۶", "(≧∇≦)ﾉ", "( ˶ᵔ ᵕ ᵔ˶ )", "(˶˃ ᵕ ˂˶)", "(っ˘ω˘ς)",
  "(ง •̀_•́)ง", "(¬‿¬)", "(=^･ω･^=)", "(ˆ⌣ˆ)", "ヾ(´︶`♡)ﾉ",
  "(●'◡'●)", "(◍•ᴗ•◍)", "(❁´◡`❁)", "(✿◠‿◠)", "( ˘ ³˘)♡",
];
const idleTitle = () => `${BASE_TITLE} ${KAOMOJI[Math.floor(Math.random() * KAOMOJI.length)]}`;

/** 任务进行时显示 "任务运行中...", 空闲时随机换一个颜文字; 仅在状态切换时更新 (快照每秒推送, 避免空闲标题乱跳) */
let lastTitleBusy = null;
function updateTitle(busy) {
  if (busy === lastTitleBusy) return;
  lastTitleBusy = busy;
  document.title = busy ? `${BASE_TITLE} 任务运行中...` : idleTitle();
}

let lastJobText = null;
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
  const status = busy ? parts.join(" · ") : "✅ 空闲";
  // 文本未变则不重写: textContent 赋值会销毁已解析的 emoji 图片并触发 MutationObserver 重新解析,
  // 每 2 秒轮询都重写会让状态栏 emoji 反复重绘闪动 (twemoji 解析后 textContent 也不等于原文, 用变量记忆比较)
  if (status !== lastJobText) {
    lastJobText = status;
    node.textContent = status;
  }
  node.classList.toggle("busy", busy);
  updateTitle(busy);
}

export function showView(name) {
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === name));
  $$(".view").forEach((v) => { v.style.display = "none"; });

  // 插件视图: 每个已安装插件一个独立页面
  if (name.startsWith("plugin-")) {
    const pluginName = name.slice("plugin-".length);
    const target = document.getElementById("view-plugin-page");
    if (!target) return Promise.resolve();
    target.style.display = "block";
    // renderPluginPage 内部先 flushPendingSaves 再清空容器重建 DOM, 是异步的。
    // 把 Promise 返回出去, 让"跳转到某个插件面板"的调用方能 await 完再操作目标 DOM,
    // 否则会在重建前的残留 DOM 上操作 (点了旧页签, 重建后又回到第一个面板)。
    return pluginsView.renderPluginPage(pluginName, target, { app: appState });
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

// ---------------- 侧边栏挂件 (晴天娃娃) ----------------

// 挂在 #app (position: relative) 下, 不放进 .sidebar: 侧边栏 overflow: hidden, 而挂件顶端要正好落在
// 顶栏 (深色底面) 的下沿, 放里面会被裁掉。
// 位置:
//   top        = 顶栏底边 (需求: 贴靠标题所在的整个深色底面的底部边缘 —— 不是标题文字的底边,
//                那样挂件会有一截伸进顶栏那一行);
//   left+width = **贴着右侧**: 右缘固定在「侧边栏右边缘 - CHARM_RIGHT_MARGIN」, 左缘与导航文字右缘
//                至少留 CHARM_TEXT_GAP。第一版是"在空档里居中", 用户回了一句"离文字太近而离侧边栏
//                右边缘太远", 所以改成贴右 (需求原话是"放到各个功能选项的右边、文字和滚动条中间";
//                居中会贴着文字那一侧, 看着像粘在字上)。
//                它压在导航项右侧的空白上 —— 不占位、不顶开导航。
// 挂件的**固有宽度**: 拖动侧边栏时它既不缩也不涨 (需求原话: "调整宽度时晴天娃娃会跟着缩小,
// 改成晴天娃娃不缩小")。既然挂件尺寸不跟着容器走, "放得下挂件"这条约束就得由侧边栏让出来 ——
// sync() 会算出所需宽度写回 sidebar 的 min-width, 拖拽钳位也用它 (见 sidebarMinWidth())。
const CHARM_W = 80;
const CHARM_RIGHT_MARGIN = 6; // 挂件右缘距侧边栏右边缘的余量
const CHARM_TEXT_GAP = 14; // 挂件左缘距导航文字右缘的最小余量
// 没有挂件时侧边栏的最小宽度 —— 就是"加挂件之前"的那个值 (与 app.css 的 .sidebar min-width 一致)
const SIDEBAR_MIN_W = 145;

// initSidebarCharm() 把自己的 sync 存进来, 供折叠/展开之后重新摆位 (见 scheduleCharmSync)
let sidebarCharmSync = null;

// 挂件可见时"刚好放得下它"的侧边栏宽度: charm 的 sync() 每次算完写进来,
// 供拖拽钳位 (sidebarMinWidth) 与写回 sidebar.style.minWidth 用。
let charmMinSidebarW = 0;

/** 侧边栏的最小宽度: 挂件可见时是"刚好容得下它"的那个宽度, 否则回到加挂件之前的 145px。 */
function sidebarMinWidth() {
  return charmEnabled && charmMinSidebarW > 0 ? Math.ceil(charmMinSidebarW) : SIDEBAR_MIN_W;
}

// 折叠/展开之后调一次。为什么必须单独调: .nav-item 有 `transition: all 0.18s`, 展开的**那一瞬间**
// font-size 还是 0, 量到的文字宽度是 0 —— sync 会以为"量不到文字"而掉到兜底位置 (挂件左移一大截,
// 压住导航标签); 更麻烦的是此后侧边栏尺寸已经稳定, ResizeObserver 不会再触发, 那个错位置就一直留着。
// transitionend 更准, 但被切换过 display 的元素未必会派发, 所以再兜一个定时器 (0.18s 过渡 + 余量)。
function scheduleCharmSync() {
  if (!sidebarCharmSync) return;
  requestAnimationFrame(sidebarCharmSync);
  setTimeout(sidebarCharmSync, 260);
}

// ---------------- 顶栏「晴天娃娃」开关 ----------------

// 图标用内联 SVG (feather 风), 不用 emoji: 本地 web/assets/emoji/72x72/ 里没有"玩偶/晴天娃娃"
// 这类码位 (1f9f8 玩偶熊等都没有), 缺字形时在 Win 上会显示成方框。
// 关闭态 = 同一张图 + 一道斜杠 (与全屏按钮换图标同一套做法)。
const CHARM_ICON_ON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2.6"/><circle cx="12" cy="9.2" r="4.6"/><path d="M9.1 13 7.4 21.5h9.2L14.9 13"/></svg>';
const CHARM_ICON_OFF = CHARM_ICON_ON.replace("</svg>", '<path d="M3.2 20.8 20.8 3.2"/></svg>');

// 开关要"重启后也维持": 真源放后端 (与外观设置共用 outputs/bg_state.json, 见 /api/bg/state)。
// 只靠 localStorage 不行 —— 端口是随机的, 换个端口就是换个 origin, 本地值全没了;
// 换浏览器同理。这正是外观设置当初也要存后端一份的原因。
const CHARM_KEY = "anr-charm";
let charmEnabled = true;

function renderCharmToggle() {
  const btn = document.getElementById("charm-toggle");
  if (!btn) return;
  btn.innerHTML = charmEnabled ? CHARM_ICON_ON : CHARM_ICON_OFF;
  btn.classList.toggle("off", !charmEnabled);
  btn.title = charmEnabled ? "隐藏晴天娃娃" : "显示晴天娃娃";
  btn.setAttribute("aria-label", btn.title);
}

async function saveCharmEnabled() {
  try { await post("/api/bg/state", { charm: charmEnabled }); } catch { /* 静默: 本地还留了一份 */ }
}

/** 应用开关状态 (不落盘 —— save 由调用方决定, 免得把"刚从后端读到的值"又写回去) */
function setCharmEnabled(on) {
  charmEnabled = !!on;
  try { localStorage.setItem(CHARM_KEY, charmEnabled ? "1" : "0"); } catch { /* 无痕模式 */ }
  renderCharmToggle();
  if (sidebarCharmSync) sidebarCharmSync(); // 立刻显/隐, 并重算位置
  resetCharmInteraction(); // 挂件都藏起来了, 气泡不该还留着; 连点计数也一并清零
}

async function initCharmToggle() {
  // 先用本地值定状态, 免得等后端请求回来时挂件先闪一下再消失
  setCharmEnabled(localStorage.getItem(CHARM_KEY) !== "0");

  document.getElementById("charm-toggle")?.addEventListener("click", () => {
    setCharmEnabled(!charmEnabled);
    saveCharmEnabled();
    toast(charmEnabled ? "晴天娃娃已显示" : "晴天娃娃已隐藏", "success");
  });

  try {
    const s = await get("/api/bg/state");
    if (typeof s?.charm === "boolean") setCharmEnabled(s.charm);
    else await saveCharmEnabled(); // 后端还没这个字段: 把本地值迁上去
  } catch { /* 后端未就绪: 用本地值 */ }
}

function initSidebarCharm() {
  const app = document.getElementById("app");
  const sidebar = document.getElementById("sidebar");
  const charm = document.getElementById("sidebar-charm");
  const topbar = document.querySelector(".topbar");
  const nav = document.getElementById("sidebar-nav");
  if (!app || !sidebar || !charm || !topbar) return;

  // 上一次量到的"导航文字右缘"。展开侧边栏的瞬间 .nav-item 的 font-size 过渡 (0 -> 14px) 还没跑完,
  // 这时量到的文字宽度是 0 -> navTextRight() 返回 null -> 会误判成"量不到文字"而掉到兜底位置。
  // 导航项是 white-space: nowrap + 左对齐, 文字右缘不随侧边栏宽度变化, 所以沿用旧值一定是安全的。
  let lastTextRight = null;

  // 导航项里文字的实际右边缘 (取最靠右的那个) —— 挂件的左边界, 保证不会压到任何一个标签
  const navTextRight = () => {
    if (!nav) return null;
    let right = -Infinity;
    nav.querySelectorAll(".nav-item").forEach((item) => {
      const t = [...item.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!t) return;
      const rg = document.createRange();
      rg.selectNodeContents(t);
      const rc = rg.getBoundingClientRect();
      if (rc.width > 0) right = Math.max(right, rc.right);
    });
    return Number.isFinite(right) ? right : null;
  };

  const sync = () => {
    // 用户用顶栏按钮关掉了挂件, 或者侧边栏收起成 50px 图标栏 (那时会缩成一团, 也没了空档)
    if (!charmEnabled || sidebar.classList.contains("collapsed")) {
      charm.hidden = true;
      // 挂件不在 -> 侧边栏的最小宽度回到"加挂件之前"的 145px。
      // (收起态由 collapse 自己写 50px, 所以这里别去动它, 否则收起会被顶回 145px)
      if (!sidebar.classList.contains("collapsed")) sidebar.style.minWidth = "";
      return;
    }
    const cs = getComputedStyle(sidebar);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const clientLeft = sidebar.clientLeft || 0;

    // 量不到时沿用上一次的有效值 (展开瞬间 font-size 过渡没跑完, 文字实测宽度是 0)
    const measured = navTextRight();
    if (measured != null) lastTextRight = measured;
    const textRight = measured != null ? measured : lastTextRight;

    // 左界 (导航文字右缘) 距侧边栏左边缘的距离; 真的一次都量不到就退回内容盒左缘
    const leftInset = textRight == null
      ? clientLeft + padL
      : textRight - sidebar.getBoundingClientRect().left;

    // 挂件宽度固定 -> "容得下它"必须由侧边栏让出来: 把最小宽度顶到刚好放得下
    // 「左界 + CHARM_TEXT_GAP + 挂件宽 + 右余量 + 右边框」。
    // (反过来说: 侧边栏被拖到再窄也不会把挂件压小 —— 它会被这条 min-width 挡住。)
    charmMinSidebarW = leftInset + CHARM_TEXT_GAP + CHARM_W + CHARM_RIGHT_MARGIN + clientLeft;
    sidebar.style.minWidth = Math.ceil(charmMinSidebarW) + "px";

    // 写完 min-width 再量: 侧边栏可能刚被顶宽 (读 style 会触发同步重排, 所以下面读到的已是新宽度)
    const barBox = sidebar.getBoundingClientRect();
    const appBox = app.getBoundingClientRect();
    // 右界 = 侧边栏右边缘往内留 CHARM_RIGHT_MARGIN (需求: 别离侧边栏右边缘太远)
    const rightBound = barBox.right - clientLeft - CHARM_RIGHT_MARGIN;
    const leftBound = barBox.left + leftInset;
    // 正常情况下余量恰好 == CHARM_W (最小宽度刚把它撑满)。保留这个 min() 是兜底:
    // 万一 min-width 没生效 (比如被别处的 !important 盖掉), 也宁可压小, 也别越界压到标签。
    const w = Math.max(0, Math.min(CHARM_W, rightBound - leftBound - CHARM_TEXT_GAP));

    charm.hidden = false;
    charm.style.width = w + "px";
    charm.style.left = Math.round(rightBound - w - appBox.left) + "px";
    charm.style.top = Math.round(topbar.getBoundingClientRect().bottom - appBox.top) + "px";
  };

  sync();
  // 折叠/展开之后要重新摆一次 (见 scheduleCharmSync)
  sidebarCharmSync = sync;
  // 图片没加载完时高度是 0, 会让量算偏; 加载完再量一次
  const img = charm.querySelector("img");
  if (img && !img.complete) img.addEventListener("load", sync, { once: true });
  window.addEventListener("resize", sync);
  // 侧边栏被拖动 / 折叠 / 恢复保存宽度, 顶栏换行, 导航文字改变都会动这些尺寸, 统一在这里跟一次
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(sync);
    ro.observe(sidebar);
    ro.observe(topbar);
    if (nav) ro.observe(nav);
  }
}

// ---------------- 挂件「回到顶部」(按住拉长绳子, 松手回弹) ----------------

/** 把右侧内容区滚回顶部。挂件长在侧边栏那一侧, 但要滚的是内容区 (#main)。 */
function scrollMainToTop() {
  // 尊重"减少动态效果": 平滑滚动会让晕动症用户不适
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduce ? "auto" : "smooth";
  const main = document.getElementById("main");
  if (main) main.scrollTo({ top: 0, behavior });
  // 兜底: 万一某个视图把滚动条留在了文档上 (body 没锁滚动), 一起归位
  const doc = document.scrollingElement;
  if (doc && doc !== main && doc.scrollTop > 0) doc.scrollTo({ top: 0, behavior });
}

/**
 * 挂件 = 「回到顶部」按钮: 按住时绳子拉长、挂件下落, 松手回弹并把内容区滚回顶部。
 *
 * 视觉反馈 (pulling 类) 与真正的动作 (滚动) 刻意分开: 动作只挂在 click 上 ——
 * 鼠标、程序化 element.click() 都会派发 click, 而 pointer 事件不会。
 * 于是"按住不放"只会看到绳子变长, 不会误触发滚动; 真点一下才滚。
 * 键盘得自己补: div[role=button] 不像原生 <button> 那样会替我们派发 click。
 */
function initCharmTop() {
  const charm = document.getElementById("sidebar-charm");
  if (!charm) return;
  const setPulling = (on) => charm.classList.toggle("pulling", on);
  const activate = () => {
    setPulling(false);
    scrollMainToTop();
  };

  charm.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; // 只认左键 / 触摸
    setPulling(true);
    // 捕获指针: 拖到挂件外面再松手也能收到 pointerup, 绳子不会一直挂着
    try {
      charm.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持指针捕获时靠 pointercancel / blur 兜底 */
    }
  });
  const release = () => setPulling(false);
  charm.addEventListener("pointerup", release);
  charm.addEventListener("pointercancel", release); // 被系统抢走 (切窗口 / 右键菜单)
  charm.addEventListener("blur", release); // 按住时窗口失焦

  // 键盘: Enter / Space 按住给同样的视觉反馈; 松开时自己触发动作 (没有原生 click)
  charm.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.key === " ") e.preventDefault(); // 免得 Space 顺手把内容区往下滚
    setPulling(true);
  });
  charm.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === " ") activate();
  });

  charm.addEventListener("click", activate);
}

// ---------------- 挂件彩蛋 (单击说句话 / 连点 4 次闪屏盖图) ----------------

// 单击挂件时气泡里随机蹦一句 —— 都很短, 且尽量丧 (需求原话: "极度悲伤消极, 最好简短")。
// 只写"自怨自艾 / 被遗忘 / 多余"这一档情绪, 不碰自伤自杀那类说法, 免得看起来像在诱导。
const CHARM_BUBBLE_LINES = [
  "没有人会记得我。",
  "我好像不该存在。",
  "算了, 反正没人看。",
  "又只剩我一个了。",
  "我只是个多余的摆件。",
  "天亮也不会变好。",
  "我连难过都打扰别人。",
  "从来没有人回头看我。",
  "对不起, 我什么都做不好。",
  "反正最后都会被丢掉。",
  "我的存在毫无意义。",
  "就算掉下去也没人发现。",
  "谁都不会为我停下来。",
  "我只配挂在角落里。",
  "你也不开心么。"
];

const CHARM_BUBBLE_MS = 2200; // 气泡停留时长
const CHARM_BUBBLE_GAP = 12; // 气泡与挂件之间的空隙
const CHARM_STREAK = 4; // 连点几下触发彩蛋 (需求: 4 次)
const CHARM_STREAK_MS = 1650; // 两次点击间隔超过它就重新数 —— 需求是"连续", 不是累计
const CHARM_FLASH_MS = 1200; // 闪烁段时长 (与 app.css 的 charm-egg-blink 一致)
const CHARM_HOLD_MS = 4000; // 图盖满整窗且不闪动的时长 (最初需求 2 秒, 后来要求"延长一点" -> 4 秒)
const CHARM_FADE_MS = 400; // 淡出时长 (与 .charm-egg 的 transition 一致)

// 彩蛋音乐 (web/assets/charm/charm-egg-climax-{early,mid,late}.mp3):
//   三段都从《Story Of A Poor Blue Rabbit》里截的高潮段, 各 8.5 秒, 每次触发随机挑一段 (见 pickCharmEggTrack)。
//   响度已经互相对齐 (RMS 都是 -15.05 dBFS, 峰值 -2.3 ~ -1.2 dBFS), 所以随机换段不会忽大忽小。
//   淡入淡出和左右交替都交给 Web Audio 实时做, 不烙进文件 —— 改时长只要动这几个常量, 不用重切音频。
const CHARM_EGG_AUDIO_MS = 8500; // 片段总长 (须与 mp3 实际时长一致)
const CHARM_EGG_FADE_IN_MS = CHARM_FLASH_MS; // 淡入与闪烁段等长: 图盖满的那一刻音量刚好到顶
const CHARM_EGG_FADE_OUT_MS = 3000; // 淡出时长
// 彩蛋本身 5.6 秒就恢复原样了 (闪 1.2 + 盖 4.0 + 淡出 0.4), 音乐比它多响 2.9 秒 —— 需求要的就是这个尾巴。
// 注意 CHARM_HOLD_MS 一动, 上面这两个秒数都得跟着改。

// 左右交替 (auto-pan / ping-pong): 只在"图盖满整个窗口"那一段生效 —— 闪烁一结束就开始甩,
// 彩蛋收工 (图彻底消失) 的那一刻停下, 前后各留 CHARM_EGG_PAN_RAMP_MS 过渡。
// 时间点由 playCharmEggAudio 按实际闪烁时长算, 不写死在这里 (开了"减少动态效果"时闪烁是 0)。
const CHARM_EGG_PAN_PERIOD_MS = 600; // 一个完整来回 (左→右→左) 的时长; 4.4 秒的窗口里甩 7 个多来回
const CHARM_EGG_PAN_RAMP_MS = 150; // 进出这段的过渡时长, 免得左右甩硬切进来

// 满屏血字轮换的节奏: 每隔这么久换掉一批段落 (每段自己还有更快的忽明忽暗, 见 animateCharmEggWord)。
// 这个间隔管的是"构图多久变一次", 不是"字多久闪一次" —— 太快会变成整屏在抖, 太慢又会显死。
const CHARM_EGG_CHURN_MIN_MS = 1500;
const CHARM_EGG_CHURN_MAX_MS = 2600;

let charmLineIndex = -1; // 上一句的下标 (避免连着两次蹦同一句)
let charmBubbleTimer = null;
let charmStreak = 0; // 当前"连续点击"计数 —— 靠计时器清零, 不累计
let charmStreakTimer = null;
let charmEggPlaying = false;
// 彩蛋音乐的状态 (Web Audio 链路懒建, 见 charmEggAudioGraph)
let charmEggCtx = null;
let charmEggGain = null;
let charmEggAudioTimer = null;
let charmEggRampId = 0; // 兜底淡入淡出的代号: 重播/收工都会 +1, 让上一轮的 rAF 自己退出
let charmEggPan = null; // 左右交替那几个节点 (见 charmEggAudioGraph)
let charmEggGraphDead = false; // 建链路失败过就不再重试, 免得每触发一次都白建一堆节点
let charmEggTrackIndex = -1; // 上一段素材的下标 (避免连着两次响同一段)
let charmEggChaosTimer = null; // 满屏血字的"轮换"计时器 (见 startCharmEggChaos)
let charmEggStyle = null; // 本轮触发的整屏气质参数 (见 newCharmEggStyleSet)

/** 收掉气泡 + 把连点计数清零 (挂件显隐变化、窗口尺寸变化时调) */
function resetCharmInteraction() {
  if (charmBubbleTimer) {
    clearTimeout(charmBubbleTimer);
    charmBubbleTimer = null;
  }
  const bubble = document.getElementById("charm-bubble");
  if (bubble) bubble.classList.add("hidden");
  if (charmStreakTimer) {
    clearTimeout(charmStreakTimer);
    charmStreakTimer = null;
  }
  charmStreak = 0;
}

/** 随机挑一句 (不与上一句重复) */
function pickCharmLine() {
  if (CHARM_BUBBLE_LINES.length < 2) return CHARM_BUBBLE_LINES[0] || "";
  let i = charmLineIndex;
  while (i === charmLineIndex) i = Math.floor(Math.random() * CHARM_BUBBLE_LINES.length);
  charmLineIndex = i;
  return CHARM_BUBBLE_LINES[i];
}

/**
 * 把气泡摆到挂件右侧 (右边放不下就翻到左侧), 顶端与挂件对齐。
 * 气泡是 position: fixed 且挂在 body 下, 所以位置得自己按挂件的实测矩形算。
 * 先归零 left/top 再量: 气泡宽度随文案变, 不归零量出来的是上一次的位置。
 */
function placeCharmBubble(bubble, charm) {
  const cb = charm.getBoundingClientRect();
  bubble.style.left = "0px";
  bubble.style.top = "0px";
  const bb = bubble.getBoundingClientRect();
  const vw = window.innerWidth;
  let left = cb.right + CHARM_BUBBLE_GAP;
  let flipped = false;
  if (left + bb.width > vw - 8) {
    left = cb.left - CHARM_BUBBLE_GAP - bb.width; // 右边放不下 -> 翻到挂件左侧
    flipped = true;
  }
  if (left < 8) left = Math.max(8, vw - 8 - bb.width); // 两边都挤不下: 贴着右边, 至少不出屏
  bubble.classList.toggle("left", flipped);
  bubble.style.left = Math.round(left) + "px";
  bubble.style.top = Math.round(cb.top + 6) + "px";
}

/** 挂件说一句话 (单击触发; 再点一次就换一句并重新计时) */
function sayCharmLine() {
  const bubble = document.getElementById("charm-bubble");
  const charm = document.getElementById("sidebar-charm");
  if (!bubble || !charm || charm.hidden) return;
  bubble.textContent = pickCharmLine();
  bubble.classList.remove("hidden");
  placeCharmBubble(bubble, charm);
  if (charmBubbleTimer) clearTimeout(charmBubbleTimer);
  charmBubbleTimer = setTimeout(() => {
    charmBubbleTimer = null;
    bubble.classList.add("hidden");
  }, CHARM_BUBBLE_MS);
}

// ---------------- 彩蛋音乐 (连点 4 次时响起的那段高潮) ----------------

/** 三段备选素材 (index.html 里那三个 <audio class="charm-egg-audio">) */
function charmEggAudioEls() {
  return $$("audio.charm-egg-audio");
}

/** 随机挑一段 (不与上一段重复; 只有一段时就没得挑) */
function pickCharmEggTrack(els) {
  if (!els.length) return null;
  if (els.length < 2) return els[0];
  let i = charmEggTrackIndex;
  while (i === charmEggTrackIndex) i = Math.floor(Math.random() * els.length);
  charmEggTrackIndex = i;
  return els[i];
}

/**
 * 建好 (或复用) 彩蛋音乐的 Web Audio 链路: 三段 <audio> -> 左右交替 -> 总音量 -> 扬声器。
 * 用 GainNode 而不是逐帧推 <audio>.volume: linearRampToValueAtTime 是采样级平滑的, 淡入淡出
 * 不会留下"台阶声"; 链路建一次就够, 之后每次触发只是重排一遍音量包络。
 *
 * AudioContext 必须在用户手势里创建/恢复 (自动播放策略), 而彩蛋本来就是"连点 4 次"点出来的,
 * 天然满足 —— 所以这里懒建, 不在页面加载时建, 免得平白挂一个被浏览器挂起的音频上下文。
 * 返回 null 表示这条路走不通 (没有 AudioContext / 建链路抛错), 调用方退回逐帧推 volume。
 */
function charmEggAudioGraph() {
  if (charmEggGain) return charmEggGain;
  if (charmEggGraphDead) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const els = charmEggAudioEls();
  if (!els.length) return null;
  try {
    if (!charmEggCtx) charmEggCtx = new Ctx();
    const ctx = charmEggCtx;

    const out = ctx.createGain();
    out.gain.value = 0; // 总音量 (淡入淡出), 先哑着等 playCharmEggAudio 排包络

    // 左右交替: 把两个声道拆开, 各过一只增益, 再让一正一反两只探针推着它们此消彼长。
    // 这里刻意**不用 StereoPannerNode** —— 它处理立体声时, 硬甩到一侧会把 L+R 相加;
    // 而这段音乐左右相关度 0.93 (几乎是单声道), 实测那样峰值会从 -1.2 dBFS 冲到 +4.5 dBFS 直接削波。
    // 拆开各管各的就没有任何相加:
    //   左增益 = base + depthL * sin   (depthL 为正)
    //   右增益 = base + depthR * sin   (depthR 为负 -> 反相)
    // 一个涨另一个就落。base 与 depth 绝对值始终相加为 1, 所以两只增益永远落在 [0, 1] 里,
    // 峰值不可能超过原始电平, 削波从数学上就不可能发生 (见 scheduleCharmEggPan)。
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const gainL = ctx.createGain();
    const gainR = ctx.createGain();
    gainL.gain.value = 1; // 未生效时 = 原样直通
    gainR.gain.value = 1;
    const depthL = ctx.createGain();
    const depthR = ctx.createGain();
    depthL.gain.value = 0; // 深度 0 = 探针不起作用
    depthR.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 1000 / CHARM_EGG_PAN_PERIOD_MS;
    lfo.connect(depthL).connect(gainL.gain);
    lfo.connect(depthR).connect(gainR.gain);
    splitter.connect(gainL, 0).connect(merger, 0, 0); // 左声道 -> merger 第 0 路
    splitter.connect(gainR, 1).connect(merger, 0, 1); // 右声道 -> merger 第 1 路
    merger.connect(out).connect(ctx.destination);
    // 探针一直转着, 由 depth 的包络决定它什么时候起作用。相位是自由的, 但 depth 每次都从 0 爬起来,
    // 所以每一遍都是从中间往外甩, 听不出差别。
    lfo.start();

    // 每个 <audio> 只能 createMediaElementSource 一次 (再来一次抛 InvalidStateError),
    // 所以放最后一步: 前面都成了才动它们; 万一抛了, 元素照旧按 volume 播, 兜底还能用。
    // 三段素材全并到同一个 splitter 上: 每次触发只有被挑中的那段在播, 另外两段静着,
    // 于是三段共用同一条淡入淡出 + 左右交替链路, 不用为每段各建一套。
    for (const el of els) ctx.createMediaElementSource(el).connect(splitter);

    charmEggPan = { lfo, gainL, gainR, depthL, depthR };
    charmEggGain = out;
    if (ctx.state === "suspended") ctx.resume();
    return charmEggGain;
  } catch {
    charmEggGraphDead = true; // 别再重试: 半截链路已经建出来了, 重试只会再漏一堆节点
    return null;
  }
}

/** 没有 Web Audio 时的兜底: 用 rAF 按同一条包络逐帧推 <audio>.volume */
function rampCharmEggVolume(audio) {
  const id = ++charmEggRampId;
  const t0 = performance.now();
  audio.volume = 0;
  const step = () => {
    if (id !== charmEggRampId) return; // 已经被重播/收工叫停, 这一轮自己退出
    const el = performance.now() - t0;
    let v;
    if (el < CHARM_EGG_FADE_IN_MS) v = el / CHARM_EGG_FADE_IN_MS;
    else if (el < CHARM_EGG_AUDIO_MS - CHARM_EGG_FADE_OUT_MS) v = 1;
    else v = (CHARM_EGG_AUDIO_MS - el) / CHARM_EGG_FADE_OUT_MS;
    audio.volume = Math.min(1, Math.max(0, v));
    if (el < CHARM_EGG_AUDIO_MS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 立刻收掉彩蛋音乐 (重播前 / 到点都在用) */
function stopCharmEggAudio() {
  charmEggRampId += 1;
  if (charmEggAudioTimer) {
    clearTimeout(charmEggAudioTimer);
    charmEggAudioTimer = null;
  }
  if (charmEggGain && charmEggCtx) {
    const t = charmEggCtx.currentTime;
    charmEggGain.gain.cancelScheduledValues(t);
    charmEggGain.gain.setValueAtTime(0, t); // 先掐成静音再 pause, 免得漏出一点尾巴
  }
  // 三段一起收: 同时只有一段在播, 一起收拾最省心, 也顺手把挑中的那段倒回开头
  for (const audio of charmEggAudioEls()) {
    try {
      audio.pause();
    } catch { /* 忽略 */ }
    try {
      audio.currentTime = 0;
    } catch { /* 元数据还没到时赋值会抛, 不影响下次从头播 */ }
    audio.volume = 1; // 还原, 免得下次走兜底时从一个奇怪的值起步
  }
}

/**
 * 排"左右交替"的音量包络。窗口 = [flashMs, flashMs + 按住 + 淡出] —— 正好是图盖满整个窗口那段:
 * 闪烁结束的那一刻开始甩, 彩蛋收工 (图彻底消失) 的那一刻停, 前后各留 CHARM_EGG_PAN_RAMP_MS 过渡。
 *
 * 四条包络一起走 (gainL / gainR 是静态值, depthL / depthR 是探针深度):
 *   gainL:  1 ─> 0.5 ─> 1        depthL: 0 ─> +0.5 ─> 0
 *   gainR:  1 ─> 0.5 ─> 1        depthR: 0 ─> -0.5 ─> 0
 * 于是 gainL = base + depthL*sin, gainR = base + depthR*sin。base 与 |depth| 一起爬, 两者之和
 * 恒为 1, 所以任何时刻两只增益都落在 [0, 1] 内 —— 峰值不超过原始电平, 不会削波。
 */
function scheduleCharmEggPan(t0, flashMs) {
  const pan = charmEggPan;
  if (!pan || !charmEggCtx) return;
  const ramp = CHARM_EGG_PAN_RAMP_MS / 1000;
  const from = t0 + flashMs / 1000;
  const to = t0 + (flashMs + CHARM_HOLD_MS + CHARM_FADE_MS) / 1000;
  // 每条都按 "直通值 ->(过渡) 生效值 ->(保持) ->(过渡) 直通值" 排一遍
  const plan = [
    [pan.gainL.gain, 1, 0.5], // 左声道静态增益
    [pan.gainR.gain, 1, 0.5], // 右声道静态增益
    [pan.depthL.gain, 0, 0.5], // 左声道探针深度
    [pan.depthR.gain, 0, -0.5], // 右声道探针深度 (负 -> 与左声道反相)
  ];
  for (const [param, idle, active] of plan) {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(idle, t0);
    param.setValueAtTime(idle, from);
    param.linearRampToValueAtTime(active, from + ramp);
    param.setValueAtTime(active, Math.max(from + ramp, to - ramp)); // 窗口比两段过渡还短时不倒挂
    param.linearRampToValueAtTime(idle, to);
  }
}

/**
 * 随机挑一段素材, 从头播一遍: 淡入 -> 满音量 -> 淡出, 中间"图盖满窗口"那段左右交替。
 * 包络时刻 (相对触发那一刻):
 *   0 ─[淡入 CHARM_EGG_FADE_IN_MS]─> 满音量 ─> 5.5s 起淡出 ─> 8.5s 收干净
 *   1.2s ─[左右交替 CHARM_HOLD_MS + CHARM_FADE_MS]─> 5.6s 停 (见 scheduleCharmEggPan)
 * 淡入和闪烁同时开始, 所以闪烁结束、图刚盖满窗口的那一刻音量正好到顶。
 *
 * flashMs 是闪烁的**实际**时长 (开了"减少动态效果"时是 0): 左右交替的起止以它为准,
 * 这样不管闪不闪, 交替都老老实实卡在"图盖满窗口"那一段里。
 *
 * 视觉彩蛋 5.6 秒就结束了, 这段时间里挂件可以再次被连点 (charmEggPlaying 只管视觉那一段),
 * 所以这里先 stopCharmEggAudio(): 上一遍还没放完就直接掐掉重头来, 不会两条音乐叠在一起。
 * 兜底计时器按总长 +300ms 收尾 —— 淡出理论上刚好归零, 但后台标签页里定时器会被节流,
 * 不能指望 ramp 一定跑完。
 */
function playCharmEggAudio(flashMs = CHARM_FLASH_MS) {
  const audio = pickCharmEggTrack(charmEggAudioEls());
  if (!audio) return;
  stopCharmEggAudio(); // 它会把挑中的那段倒回 0 秒, 下面 play() 就是从头发声
  const gain = charmEggAudioGraph();
  if (gain) {
    const t0 = charmEggCtx.currentTime;
    gain.gain.cancelScheduledValues(t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(1, t0 + CHARM_EGG_FADE_IN_MS / 1000);
    // 满音量保持到淡出起点 (常量保证 淡入+淡出 < 总长, 两个斜坡不会打架)
    gain.gain.setValueAtTime(1, t0 + (CHARM_EGG_AUDIO_MS - CHARM_EGG_FADE_OUT_MS) / 1000);
    gain.gain.linearRampToValueAtTime(0, t0 + CHARM_EGG_AUDIO_MS / 1000);
    scheduleCharmEggPan(t0, flashMs); // 左右交替只作用在"图盖满窗口"那一段
  } else {
    // 兜底: 逐帧推 volume, 淡入淡出一样, 只是精度差些; 左右交替得拆声道, 这条路上做不了, 直接跳过
    rampCharmEggVolume(audio);
  }
  // play() 会从头播; 被自动播放策略拦下时静默放弃, 彩蛋的视觉部分照常
  audio.play().catch(() => { /* 忽略 */ });
  charmEggAudioTimer = setTimeout(stopCharmEggAudio, CHARM_EGG_AUDIO_MS + 300);
}

// ---------------- 彩蛋遮罩里的"病态文字深渊" ----------------

// 词库按字号分三档 (照搬素材页的分法): 字越大 -> 词越核心越病态。
// 只写"偏执 / 占有欲 / 被抛弃"这一档情绪, 不碰具体自伤自杀的说法, 免得看起来像在诱导。
const CHARM_EGG_WORDS_BIG = [
  "你是我的", "永远在一起", "不许离开", "只能看我", "我比他们更爱你",
  "把你关起来", "找到你了", "我们是什么关系", "求求你不要离开我",
  "死", "血", "恨", "囚禁", "宝宝", "别想跑", "只属于我",
];
const CHARM_EGG_WORDS_MID = [
  "为什么不回消息", "你哪里做错了我可以改", "眼里只能有我",
  "你离我不开我", "我永远不会抛弃你", "不要无视我的爱", "我好想你",
  "别甩掉我", "你只能看着我一人", "你为什么不喜欢我", "回我消息",
];
const CHARM_EGG_WORDS_SMALL = [
  "等你好久了", "我在看着你", "别离开我", "只爱我一个人好不好",
  "你害怕了吗", "不要背叛我", "永远不许逃", "我只有你了",
  "你为什么看别人", "把你的眼睛挖出来", "我们融为一体吧",
];

/** [a, b) 之间的随机数 —— 下面满屏掷点用得太频繁, 单独包一层省得到处写 Math.random */
function charmEggRand(a, b) {
  return a + Math.random() * (b - a);
}

/** 从数组里随机取一个 */
function charmEggPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 把整屏血字从头重排一遍。
 *
 * **每一遍都要重新掷"全局"参数**, 这是"随机"的关键 —— 不能只随机每个字的位置就完事,
 * 那样每次触发看起来还是同一屏。这里连: 节点数量、色相漂移、倾角范围、模糊概率、
 * 四档字号的阈值、背景光晕的位置, 全都是每遍现掷的, 所以两次触发的气质会明显不同。
 *
 * 只用 documentFragment 拼好再一次挂上去: 逐个 appendChild 会让浏览器反复重排。
 */
/** 掷一套"整屏气质"参数: 配色、倾角、模糊比例、字号分位都由它定, 一次触发掷一次 */
function newCharmEggStyleSet() {
  return {
    hueBase: charmEggRand(-14, 20), // 偏纯红 -> 偏橙红, 负值带一点洋红
    tiltMax: charmEggRand(35, 78), // 倾角上限 (度)
    blurChance: charmEggRand(0.4, 0.8), // 多大的比例是失焦的
    cutBig: charmEggRand(0.90, 0.96), // 以下三档是字号分位
    cutMid: charmEggRand(0.70, 0.85),
    cutSmall: charmEggRand(0.32, 0.62),
  };
}

/**
 * 造一段话 (还没挂进 DOM, 也还没上动画)。
 * 气质参数由调用方传入: 轮换时补进来的新段落会沿用**当前这一套**, 免得新旧两批的
 * 配色和倾角范围对不上, 一眼就看出是后来补的。
 */
function buildCharmEggWord(set) {
  const el = document.createElement("div");
  el.className = "charm-egg-word";
  // 位置故意放到 -4% ~ 104%: 让字能压出画面边缘, 四边不会留出一圈干净的空白
  el.style.left = charmEggRand(-4, 104).toFixed(2) + "%";
  el.style.top = charmEggRand(-4, 104).toFixed(2) + "%";
  el.style.color =
    "hsl(" + Math.round(set.hueBase + charmEggRand(-8, 12)) + " " +
    Math.round(charmEggRand(70, 100)) + "% " + Math.round(charmEggRand(16, 54)) + "%)";
  el.style.opacity = charmEggRand(0.15, 0.85).toFixed(2);
  const rot = (Math.random() - 0.5) * 2 * set.tiltMax;
  // 偶尔横向或纵向挤扁一下, 像字被拉扯过
  const sx = Math.random() > 0.8 ? charmEggRand(0.6, 1.4) : 1;
  const sy = Math.random() > 0.8 ? charmEggRand(0.6, 1.4) : 1;
  el.style.transform = "translate(-50%, -50%) rotate(" + rot.toFixed(1) + "deg) scale(" + sx.toFixed(2) + ", " + sy.toFixed(2) + ")";
  if (Math.random() < set.blurChance) el.style.filter = "blur(" + charmEggRand(0.4, 3.4).toFixed(1) + "px)";
  el.style.letterSpacing = charmEggRand(0, 5).toFixed(1) + "px";
  // 字号分档: 字越大越靠前, 小字密密麻麻铺在后面当底噪
  const r = Math.random();
  if (r > set.cutBig) {
    el.style.fontSize = charmEggRand(5, 9).toFixed(2) + "rem";
    el.style.fontWeight = "900";
    el.style.zIndex = 100;
    el.textContent = charmEggPick(CHARM_EGG_WORDS_BIG);
  } else if (r > set.cutMid) {
    el.style.fontSize = charmEggRand(2.5, 4.5).toFixed(2) + "rem";
    el.style.fontWeight = "bold";
    el.style.zIndex = 50;
    el.textContent = charmEggPick(Math.random() < 0.75 ? CHARM_EGG_WORDS_MID : CHARM_EGG_WORDS_BIG);
  } else if (r > set.cutSmall) {
    el.style.fontSize = charmEggRand(1.2, 2.7).toFixed(2) + "rem";
    el.style.fontWeight = "600";
    el.style.zIndex = 10;
    el.textContent = charmEggPick(Math.random() < 0.7 ? CHARM_EGG_WORDS_MID : CHARM_EGG_WORDS_SMALL);
  } else {
    el.style.fontSize = charmEggRand(0.8, 1.6).toFixed(2) + "rem";
    el.style.fontWeight = "400";
    el.style.zIndex = 1;
    el.textContent = charmEggPick(CHARM_EGG_WORDS_SMALL);
  }
  return el;
}

/** 铺满一屏 (触发时调一次); 之后由 churnCharmEggWords 按段落轮换 */
function renderCharmEggChaos(box) {
  if (!box) return;
  charmEggStyle = newCharmEggStyleSet(); // 本轮的整屏气质, 轮换补新段落时继续沿用
  const count = Math.round(charmEggRand(90, 150)); // 密度也随机 (每段自己会忽明忽暗, 不用铺那么满)
  const frag = document.createDocumentFragment();
  const words = [];
  for (let i = 0; i < count; i++) {
    const el = buildCharmEggWord(charmEggStyle);
    words.push(el);
    frag.appendChild(el);
  }
  box.appendChild(frag);
  // 挂进 DOM 之后才上动画: 动画要拿渲染时掷好的 opacity 当"底色", 再在上面忽明忽暗
  for (const el of words) animateCharmEggWord(el);
}

/**
 * 给一段话上"活"的动画。恐怖感的来源不是整屏一起淡进淡出 (那太整齐, 像转场), 而是
 * **每一段各自忽闪、抽搐、到点自己灭掉** —— 观众会不自觉地去找"下一段什么时候动"。
 *
 * 逐段现掷的东西:
 *   1. 闪法: 有的硬闪 (steps, 像接触不良的灯管), 有的软呼吸 (ease, 像在喘)
 *   2. 抖动量: 位置、旋转、大小各自轻微游走, 幅度和方向都随机
 *   3. 寿命: 每段活多久完全不等, 短的不到 1 秒就灭, 长的撑满全场
 *   4. 明暗节奏: 周期取 0.5~3 倍"基频", 于是整屏永远对不齐拍子, 不会同起同落
 *
 * 全部用 Web Animations 的迭代 + 随机 duration/delay, 不写 CSS keyframes —— 每段的曲线都不同,
 * 写死了反而会看出规律。
 */
function animateCharmEggWord(el) {
  const base = parseFloat(el.style.opacity) || 0.5; // 渲染时掷好的基准亮度
  const hardBlink = Math.random() < 0.35; // 硬闪 vs 软呼吸
  const flickAmp = charmEggRand(0.35, 1); // 忽明忽暗的幅度
  const dim = Math.max(0.02, base * (1 - flickAmp));
  const bright = Math.min(1, base * (1 + flickAmp * 0.6));
  // 段落原本的 transform 里已经含了 translate/rotate/scale, 动画只在其上叠很小的位移,
  // 免得把摆好的构图甩飞
  const jx = charmEggRand(-6, 6), jy = charmEggRand(-6, 6);
  const jr = charmEggRand(-3, 3), js2 = charmEggRand(0.94, 1.06);

  // 明暗: 硬闪用 steps 做"啪"地切换, 软呼吸用正弦似的 ease
  const frames = hardBlink
    ? [{ opacity: bright }, { opacity: dim }, { opacity: bright }]
    : [{ opacity: bright }, { opacity: dim }, { opacity: bright }];
  el.animate(frames, {
    duration: charmEggRand(420, 2400),
    iterations: Infinity,
    easing: hardBlink ? "steps(2, end)" : "ease-in-out",
    direction: hardBlink ? "normal" : "alternate",
  });
  // 抽动: 位置 + 角度 + 轻微缩放**合成一条 transform 动画**。
  // 不能拆成两条 (一条改 transform、一条改 scale) —— 它们动的是同一个属性, 后者会把前者整个顶掉,
  // 抖动就会无声地失效。这里把缩放并进 translate/rotate 里一起写。
  const wobble = Math.random() < 0.4; // 少数才有大小起伏, 多了整屏像在飘
  const s = wobble ? js2.toFixed(3) : 1;
  el.animate(
    [
      { transform: el.style.transform + " translate(0px, 0px) rotate(0deg) scale(1)" },
      { transform: el.style.transform + " translate(" + jx.toFixed(1) + "px, " + jy.toFixed(1) + "px) rotate(" + jr.toFixed(2) + "deg) scale(" + s + ")" },
    ],
    { duration: charmEggRand(180, 900), iterations: Infinity, direction: "alternate", easing: "ease-in-out" }
  );
  // 寿命: 短的自己灭掉, 长的撑到最后。灭的时候用 steps 硬切, 不留渐隐的余地
  if (Math.random() < 0.55) {
    el.animate([{ opacity: bright }, { opacity: 0 }], {
      duration: charmEggRand(260, 1600),
      delay: charmEggRand(600, 4200),
      easing: "steps(3, end)",
      fill: "forwards",
    });
  }
}

/**
 * 每次触发重掷一次底色光晕 (位置 + 扩散范围), 让整屏构图换一副气质。
 * 只在触发时掷, **不跟翻涌走** —— 底色是整屏最大的一块面积, 跟着每遍换会显得整页在闪,
 * 反而盖过了血字本身的翻涌。
 */
function randomizeCharmEggGlow() {
  const egg = document.getElementById("charm-egg");
  if (!egg) return;
  egg.style.backgroundImage =
    "radial-gradient(circle at " + charmEggRand(20, 80).toFixed(0) + "% " + charmEggRand(20, 80).toFixed(0) + "%, #1f0000 0%, #000000 " + charmEggRand(55, 82).toFixed(0) + "%)";
}

/**
 * 换掉一批话: 挑一部分已经亮够久的段落, 让它们**各自**抽搐着灭掉, 再从别处冒出新的一批。
 *
 * 这里刻意不做"整屏换一版"。整屏换 (哪怕是交叉溶接) 本质上是同步的 —— 所有字同起同落,
 * 看久了就露出"转场"的痕迹, 太整齐、太礼貌, 跟恐怖感正好相反。改成按段落轮换之后,
 * 屏上的构图是一直在变但又从不整个断掉, 视线永远抓不住规律。
 *
 * 灭的时候不是淡出, 而是"抖着灭": opacity 用 steps 硬切几下再归零, 同时位置抽两下,
 * 像被掐断的信号。新段落则从很暗的地方不规则地闪起来。
 */
function churnCharmEggWords() {
  const host = document.getElementById("charm-egg-words");
  if (!host) return;
  const living = Array.from(host.querySelectorAll(".charm-egg-word"));
  // 每次换掉 12%~28% 的段落: 太少看不出动静, 太多等于重铺
  const swapCount = Math.max(4, Math.round(living.length * charmEggRand(0.12, 0.28)));
  const shuffled = living.sort(() => Math.random() - 0.5).slice(0, swapCount);
  for (const el of shuffled) killCharmEggWord(el);
  // 补上等量的新段落, 挂在同一个宿主里 —— 新旧自然混在一起, 分不出批次。
  // 这里直接拿 buildCharmEggWord 的返回值, 不靠 "最后 N 个" 去猜: 旧段落还在抖着灭,
  // DOM 顺序不保证新的一定排在末尾。
  const fresh = [];
  for (let i = 0; i < swapCount; i++) {
    const el = buildCharmEggWord(charmEggStyle);
    fresh.push(el);
    host.appendChild(el);
  }
  for (const el of fresh) animateCharmEggWord(el); // 只给新来的上动画, 老段落继续跑自己那条
}

/** 让一段话抖着灭掉, 动画结束再摘掉节点 */
function killCharmEggWord(el) {
  if (el.dataset.dying) return; // 已经在灭了, 别重复派发
  el.dataset.dying = "1";
  const base = parseFloat(el.style.opacity) || 0.5;
  const jx = charmEggRand(-4, 4), jy = charmEggRand(-4, 4);
  el.animate(
    [
      { opacity: base, transform: el.style.transform + " translate(0px, 0px)" },
      { opacity: 0, transform: el.style.transform + " translate(" + jx.toFixed(1) + "px, " + jy.toFixed(1) + "px)" },
    ],
    { duration: charmEggRand(120, 420), easing: "steps(3, end)", fill: "forwards" }
  ).finished.then(() => el.remove()).catch(() => el.remove());
}

/** 铺满一屏血字, 然后在整个彩蛋期间不停轮换 (每段各自活, 而不是整屏一起换) */
function startCharmEggChaos(reduceMotion) {
  const host = document.getElementById("charm-egg-words");
  if (!host) return;
  stopCharmEggChaos();
  randomizeCharmEggGlow();
  renderCharmEggChaos(host);
  // 开了"减少动态效果"的用户只铺一遍: 画面本身还在, 只是不再翻涌
  if (reduceMotion) return;
  const step = () => {
    churnCharmEggWords();
    charmEggChaosTimer = setTimeout(step, charmEggRand(CHARM_EGG_CHURN_MIN_MS, CHARM_EGG_CHURN_MAX_MS));
  };
  charmEggChaosTimer = setTimeout(step, charmEggRand(CHARM_EGG_CHURN_MIN_MS, CHARM_EGG_CHURN_MAX_MS));
}

/** 停止重排 (内容留着, 好让它跟着遮罩一起淡出) */
function stopCharmEggChaos() {
  if (charmEggChaosTimer) {
    clearTimeout(charmEggChaosTimer);
    charmEggChaosTimer = null;
  }
}

/** 停止重排并清空节点 (淡出结束后一定要调, 别让两三百个带模糊/发光的节点留在底下白占内存) */
function clearCharmEggChaos() {
  stopCharmEggChaos();
  const host = document.getElementById("charm-egg-words");
  if (host) host.textContent = "";
}

/**
 * 彩蛋: **连续**点挂件 CHARM_STREAK 次 -> 整个窗口闪几下 -> 用满屏血字盖满整个窗口 -> 4 秒后恢复原样。
 *
 * 时序全在这一个函数里 (不让 CSS 动画去管"什么时候结束"):
 *   0 ──[.flash 动画闪 CHARM_FLASH_MS]──> 保持盖满 CHARM_HOLD_MS ──[淡出 CHARM_FADE_MS]──> 复原
 * 闪烁那段交给 app.css 的 charm-egg-blink: 它结束帧停在 opacity 1, 所以撤掉 .flash 时画面不跳。
 * 给开了"减少动态效果"的用户省掉闪烁, 直接盖住 (内容一样, 只是没有那几下频闪),
 * 同时血字也只铺一遍不再翻涌 (见 startCharmEggChaos)。
 */
function playCharmEgg() {
  const egg = document.getElementById("charm-egg");
  if (!egg || charmEggPlaying) return;
  charmEggPlaying = true;
  resetCharmInteraction(); // 气泡别跟彩蛋叠在一起
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const flashMs = reduce ? 0 : CHARM_FLASH_MS;
  // 音乐与闪烁同一时刻起: 淡入正好铺满闪烁段, 图盖满时音量到顶;
  // 闪烁实际时长一并传过去, 左右交替的起止才跟得上"图真正盖满窗口"那一刻
  playCharmEggAudio(flashMs);
  egg.classList.remove("hidden");
  egg.classList.add("on");
  startCharmEggChaos(reduce); // 铺满血字, 并在整个彩蛋期间不停重排
  // 下一帧再加 .flash: 元素刚从 display: none 变成可见, 在同一个任务里加动画未必跑得起来
  if (flashMs) requestAnimationFrame(() => egg.classList.add("flash"));
  setTimeout(() => {
    egg.classList.remove("flash");
    setTimeout(() => {
      egg.classList.remove("on"); // 淡出 (transition: opacity 0.4s)
      stopCharmEggChaos(); // 先别翻了, 让最后那一屏血字跟着一起淡出
      setTimeout(() => {
        egg.classList.add("hidden");
        clearCharmEggChaos(); // 淡完了才清节点: 两三百个带模糊和发光的 div 别留在底下
        charmEggPlaying = false;
      }, CHARM_FADE_MS);
    }, CHARM_HOLD_MS);
  }, flashMs);
}

/**
 * 挂件的两个彩蛋都挂在 click 上:
 *   1. 每点一次 -> 气泡里随机说一句丧气话;
 *   2. 连点 CHARM_STREAK 次 -> playCharmEgg()。
 * "连续"由 charmStreakTimer 保证: 每点一次就重排那只清零计时器, 隔超过 CHARM_STREAK_MS 再点
 * 是从 0 数起 (所以慢慢点八下也不会触发, 不是累计)。
 */
function initCharmEgg() {
  const charm = document.getElementById("sidebar-charm");
  if (!charm) return;
  charm.addEventListener("click", () => {
    if (charmEggPlaying) return;
    sayCharmLine();
    charmStreak += 1;
    if (charmStreakTimer) {
      clearTimeout(charmStreakTimer);
      charmStreakTimer = null;
    }
    if (charmStreak >= CHARM_STREAK) {
      charmStreak = 0;
      playCharmEgg();
      return;
    }
    charmStreakTimer = setTimeout(() => {
      charmStreakTimer = null;
      charmStreak = 0; // 隔太久 -> 重新数
    }, CHARM_STREAK_MS);
  });
  // 彩蛋期间点一下屏幕 -> 整屏血字立刻重洗一遍 (素材页原本就有点击重排, 顺手留着)。
  // 遮罩此时 pointer-events: auto, 所以点不到下面的界面, 也不会把这下算进连点计数。
  const eggBox = document.getElementById("charm-egg");
  if (eggBox) {
    eggBox.addEventListener("click", () => {
      if (!charmEggPlaying) return;
      churnCharmEggWords(); // 走和自动轮换同一条路径: 抽换一批段落, 不整屏重铺
    });
  }
  // 挂件被挪走 (窗口 resize / 拖侧边栏) 或藏起来时, 气泡会孤零零飘在空处 -> 直接收掉
  window.addEventListener("resize", () => {
    const bubble = document.getElementById("charm-bubble");
    if (bubble && !bubble.classList.contains("hidden")) resetCharmInteraction();
  });
}

// ---------------- 顶栏「强制刷新」(Ctrl+F5) ----------------

// 只刷 CSS/JS/favicon: 这正是 Ctrl+F5 关心的"代码有没有更新"。
// 页面里还有上百个 emoji <img>, 全部 cache:"reload" 一遍纯属浪费。
const HARD_RELOAD_SEL = 'link[rel="stylesheet"][href], link[rel="icon"][href], script[src]';

function initHardReloadUI() {
  const btn = document.getElementById("hard-reload");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    toast("正在强制刷新 (绕过缓存)…", "warning");
    try {
      // fetch 的 cache:"reload" 会跳过 HTTP 缓存强制回源, 并把新响应写回缓存;
      // 文档本身交给 location.reload() —— 按规范 reload 导航对主文档就是绕过缓存的。
      const urls = new Set();
      document.querySelectorAll(HARD_RELOAD_SEL).forEach((n) => {
        const u = n.href || n.src;
        if (u && u.startsWith(location.origin)) urls.add(u);
      });
      await Promise.race([
        Promise.allSettled([...urls].map((u) => fetch(u, { cache: "reload" }))),
        new Promise((r) => setTimeout(r, 2500)), // 个别资源卡住也不能让页面一直不刷新
      ]);
    } catch { /* 刷新本身不依赖这些请求成功 */ }
    location.reload();
  });
}

// ---------------- 侧边栏拖拽调整宽度 ----------------

function initSidebarResize() {
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("sidebar-resizer");
  const collapseBtn = document.getElementById("sidebar-collapse");
  if (!sidebar) return;
  // 键名带 -v4: 默认宽度放宽到 200px (给右侧挂件留出空档), 沿用旧键名会让历史保存值覆盖掉新默认值
  const saved = localStorage.getItem("anr-sidebar-width-v4");
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
        // 最小宽度: 有挂件时 = "刚好容得下它"的宽度 (挂件不跟着缩, 见 sidebarMinWidth);
        // 没挂件时回到加挂件之前的 145px。上限 340 与 CSS .sidebar max-width 一致。
        const minW = sidebar.classList.contains("collapsed") ? 50 : sidebarMinWidth();
        const w = Math.min(340, Math.max(minW, startW + (ev.clientX - startX)));
        sidebar.style.width = w + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        resizer.classList.remove("active");
        localStorage.setItem("anr-sidebar-width-v4", String(sidebar.offsetWidth));
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
        const w = parseInt(sidebar.dataset.prevWidth, 10) || parseInt(saved, 10) || 200;
        sidebar.style.width = w + "px";
        sidebar.style.minWidth = "";
        localStorage.setItem("anr-sidebar-collapsed", "0");
      }
      // font-size 的过渡跑完之前量到的文字宽是 0, 要等它结束再摆一次, 否则挂件会停在兜底位置
      scheduleCharmSync();
    });
  }

  // 宽度 / 折叠状态都恢复好了再摆挂件 (它要量侧边栏的内容盒)
  initSidebarCharm();
  // 挂件同时是「回到顶部」按钮 (按住拉长绳子, 松手回弹并滚回顶部)
  initCharmTop();
  // 挂件的两个彩蛋: 单击说句话; 连点 4 次闪屏 + 用图盖住整个窗口 (见 initCharmEgg)
  initCharmEgg();
}

boot();