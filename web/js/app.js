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
}

boot();