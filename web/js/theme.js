// ============================================================
// 主题管理: 亮色/暗色切换 + 自定义主题色 + 模糊度调节
// 持久化到后端 outputs/bg_state.json (跨浏览器保留), localStorage 作兜底
// ============================================================
import { copyText, el, toast } from "./ui.js";
import { get, post } from "./api.js";

const KEY = "anr-theme";
const COLOR_KEY = "anr-color";
const BLUR_KEY = "anr-blur";
const THEMES = ["light", "dark"];

// 主题色预设 (亮/暗模式下通用)
const PRESETS = [
  { name: "紫罗兰", primary: "#8b5cf6", secondary: "#6366f1", accent: "#ec4899" },
  { name: "海洋蓝", primary: "#3b82f6", secondary: "#06b6d4", accent: "#22d3ee" },
  { name: "翡翠绿", primary: "#10b981", secondary: "#14b8a6", accent: "#f59e0b" },
  { name: "落日橙", primary: "#f97316", secondary: "#fb923c", accent: "#ec4899" },
  { name: "玫瑰粉", primary: "#ec4899", secondary: "#f472b6", accent: "#8b5cf6" },
  { name: "青瓷", primary: "#14b8a6", secondary: "#2dd4bf", accent: "#6366f1" },
  { name: "石墨", primary: "#64748b", secondary: "#94a3b8", accent: "#f43f5e" },
];

// ---------------- 颜色工具 ----------------

function hexToRgb(hex) {
  let h = (hex || "#000000").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function mixColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return "rgb(" + mix(a[0], b[0], t) + ", " + mix(a[1], b[1], t) + ", " + mix(a[2], b[2], t) + ")";
}

function lighten(hex, t) {
  return mixColor(hex, "#ffffff", t);
}

// ---------------- 应用设置 ----------------

function applyColor(color) {
  const root = document.documentElement;
  if (!color) {
    root.style.removeProperty("--primary");
    root.style.removeProperty("--primary-2");
    root.style.removeProperty("--secondary");
    root.style.removeProperty("--accent");
    localStorage.removeItem(COLOR_KEY);
    return;
  }
  root.style.setProperty("--primary", color.primary);
  root.style.setProperty("--primary-2", lighten(color.primary, 0.28));
  root.style.setProperty("--secondary", color.secondary || mixColor(color.primary, color.accent || "#ffffff", 0.5));
  root.style.setProperty("--accent", color.accent || color.primary);
  localStorage.setItem(COLOR_KEY, JSON.stringify(color));
}

function applyBlur(bg) {
  const root = document.documentElement;
  root.style.setProperty("--bg-blur", bg + "px");
  localStorage.setItem(BLUR_KEY, JSON.stringify({ bg }));
}

// ---------------- 服务器端持久化 (跨浏览器) ----------------

function currentColor() {
  try { return JSON.parse(localStorage.getItem(COLOR_KEY)); } catch { return null; }
}

function currentBlur() {
  try { return JSON.parse(localStorage.getItem(BLUR_KEY)); } catch { return null; }
}

let saveTimer = null;

/** 把当前颜色 + 模糊度保存到后端 (节流, 与背景共用 bg_state.json)。 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAppearance, 250);
}

async function saveAppearance() {
  try {
    await post("/api/bg/state", { color: currentColor(), blur: currentBlur() });
  } catch { /* 静默失败 */ }
}

/** 加载外观设置: 服务器优先, 本地 localStorage 作兜底并迁移到服务器。 */
async function loadSaved() {
  let server = null;
  try { server = await get("/api/bg/state"); } catch { /* 后端未就绪 */ }

  let color = server && server.color ? server.color : null;
  if (!color) {
    try {
      const c = localStorage.getItem(COLOR_KEY);
      if (c) color = JSON.parse(c);
    } catch { /* ignore */ }
  }
  if (color && color.primary) applyColor(color);

  let blur = server && server.blur ? server.blur : null;
  if (!blur) {
    try {
      const b = localStorage.getItem(BLUR_KEY);
      if (b) {
        const v = JSON.parse(b);
        blur = { bg: Number.isFinite(v.bg) ? v.bg : 4, panel: Number.isFinite(v.panel) ? v.panel : 12 };
      }
    } catch { /* ignore */ }
  }
  if (blur && Number.isFinite(blur.bg)) {
    applyBlur(blur.bg);
  }

  // 服务器缺少但本地有旧值时, 迁移到服务器 (换浏览器后不再丢失)
  if ((!server?.color && color) || (!server?.blur && blur)) {
    scheduleSave();
  }
}

// ---------------- 主题切换 (原有逻辑) ----------------

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  localStorage.setItem(KEY, theme);
}

export function initTheme() {
  const params = new URLSearchParams(location.search);
  let theme = params.get("__theme");
  if (!theme) theme = localStorage.getItem(KEY) || "light";
  if (!THEMES.includes(theme)) theme = "light";
  apply(theme);

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    apply(next);
  });

  loadSaved();
  initAppearanceUI();
  initFullscreenUI();
  initCopyLinkUI();
}

// ---------------- 全屏切换 (Fullscreen API: 托管 app 窗口与普通标签页通用) ----------------

const FS_ICON_EXPAND = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
const FS_ICON_SHRINK = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';

export function initFullscreenUI() {
  const btn = document.getElementById("fullscreen-toggle");
  if (!btn) return;
  const sync = () => {
    const on = !!document.fullscreenElement;
    btn.innerHTML = on ? FS_ICON_SHRINK : FS_ICON_EXPAND;
    btn.title = on ? "退出全屏" : "全屏显示";
    btn.setAttribute("aria-label", btn.title);
  };
  btn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    // localhost 属安全上下文, requestFullscreen 基本不会被策略拦截; 失败时静默 (F11 仍可用)
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  });
  document.addEventListener("fullscreenchange", sync);  // 覆盖 F11/Esc 等其他进出路径
  sync();
}

// ---------------- 复制访问链接 (共享链接开启且就绪时自动给可对外访问的隧道地址) ----------------

export function initCopyLinkUI() {
  const btn = document.getElementById("copy-link");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      let url = location.origin;
      let shared = false;
      try {
        // 真源在后端 (utils/tunnel.get_share_info): url 仅在隧道注册且端到端确认可达后才非空
        const s = await get("/api/share");
        shared = !!(s.share && s.url);
        if (shared) url = s.url;
      } catch { /* 状态查询失败按未共享处理, 至少复制本地地址 */ }
      if (!(await copyText(url))) throw new Error("浏览器拒绝了剪贴板写入");
      toast(shared ? "可共享链接已复制 📋" : "本地地址已复制 📋 (设置页开启共享链接后可复制对外访问的链接)", "success");
    } catch (e) {
      toast("复制失败: " + e.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------- 外观弹层 (颜色 + 模糊) ----------------

let popoverEl = null;

function getPopover() {
  if (popoverEl) return popoverEl;
  const pop = el("div", { class: "bg-popover appearance-popover hidden", id: "appearance-popover" });
  pop.append(el("div", { class: "bg-title", text: "🎨 外观设置" }));

  // ---- 主题色预设 ----
  const presetBox = el("div", { class: "field" }, [el("label", { text: "主题色预设" })]);
  const swatchRow = el("div", { class: "color-presets" });
  PRESETS.forEach((p, i) => {
    const sw = el("button", {
      class: "color-swatch",
      type: "button",
      title: p.name,
      style: "background:linear-gradient(135deg," + p.primary + "," + p.accent + ");",
    });
    sw.dataset.index = String(i);
    sw.addEventListener("click", () => {
      applyColor({ ...PRESETS[i] });
      syncPopover(pop);
      scheduleSave();
      toast("主题色已应用: " + p.name + " 🎨", "success");
    });
    swatchRow.append(sw);
  });
  const customSw = el("button", { class: "color-swatch color-swatch-custom", type: "button", title: "自定义颜色" });
  customSw.addEventListener("click", () => {
    const primary = pop.querySelector("#color-primary");
    const accent = pop.querySelector("#color-accent");
    applyColor({ primary: primary.value, secondary: mixColor(primary.value, accent.value, 0.5), accent: accent.value });
    syncPopover(pop);
    scheduleSave();
    toast("已应用自定义颜色 🎨", "success");
  });
  swatchRow.append(customSw);
  presetBox.append(swatchRow);
  pop.append(presetBox);

  // ---- 自定义颜色 ----
  const colorRow = el("div", { class: "color-row" });
  const primaryWrap = el("label", { class: "color-input-wrap" }, [
    document.createTextNode("主题色"),
    el("input", { type: "color", id: "color-primary", value: "#8b5cf6" }),
  ]);
  const accentWrap = el("label", { class: "color-input-wrap" }, [
    document.createTextNode("点缀色"),
    el("input", { type: "color", id: "color-accent", value: "#ec4899" }),
  ]);
  colorRow.append(primaryWrap, accentWrap);
  pop.append(el("div", { class: "field" }, [el("label", { text: "自定义颜色" }), colorRow]));

  const primaryInput = primaryWrap.querySelector("input");
  const accentInput = accentWrap.querySelector("input");
  primaryInput.addEventListener("input", (e) => {
    const accent = accentInput.value;
    applyColor({ primary: e.target.value, secondary: mixColor(e.target.value, accent, 0.5), accent });
    syncPopover(pop);
  });
  primaryInput.addEventListener("change", () => scheduleSave());
  accentInput.addEventListener("input", (e) => {
    const primary = primaryInput.value;
    applyColor({ primary, secondary: mixColor(primary, e.target.value, 0.5), accent: e.target.value });
    syncPopover(pop);
  });
  accentInput.addEventListener("change", () => scheduleSave());

  // ---- 模糊度 (组件模糊已随毛玻璃移除, 仅保留背景模糊; --panel-blur 管线已删) ----
  const blurBgWrap = sliderRow("背景模糊度", "blur-bg", 0, 40, 4);
  blurBgWrap.input.addEventListener("input", () => {
    applyBlur(Number(blurBgWrap.input.value));
    syncPopover(pop);
  });
  blurBgWrap.input.addEventListener("change", () => scheduleSave());
  pop.append(blurBgWrap.node);

  // ---- 操作 ----
  const resetBtn = el("button", { class: "btn btn-sm btn-danger", text: "♻️ 恢复默认外观" });
  resetBtn.addEventListener("click", () => {
    applyColor(null);
    applyBlur(4);
    syncPopover(pop);
    scheduleSave();
    toast("已恢复默认外观", "info");
  });
  pop.append(el("div", { class: "bg-actions" }, [resetBtn]));

  popoverEl = pop;
  document.body.append(pop);
  return pop;
}

/** 简单的滑块行构造 (label + range + 当前值) */
function sliderRow(label, id, min, max, value) {
  const input = el("input", { type: "range", id, min, max, step: 1, value });
  const val = el("span", { class: "blur-val" });
  const row = el("div", { class: "blur-row" }, [
    el("label", { text: label }),
    input,
    val,
  ]);
  const node = el("div", { class: "field" }, [row]);
  return { node, input, val };
}

function syncPopover(pop) {
  const rootStyle = getComputedStyle(document.documentElement);
  const curPrimary = rootStyle.getPropertyValue("--primary").trim() || "#8b5cf6";
  const curAccent = rootStyle.getPropertyValue("--accent").trim() || "#ec4899";

  const primaryInput = pop.querySelector("#color-primary");
  const accentInput = pop.querySelector("#color-accent");
  if (primaryInput) primaryInput.value = toHex(curPrimary) || "#8b5cf6";
  if (accentInput) accentInput.value = toHex(curAccent) || "#ec4899";

  const bgInput = pop.querySelector("#blur-bg");
  const bgBlur = parseFloat(rootStyle.getPropertyValue("--bg-blur")) || 4;
  if (bgInput) { bgInput.value = String(bgBlur); const v = bgInput.parentElement.querySelector(".blur-val"); if (v) v.textContent = bgBlur + "px"; }

  // 高亮当前预设
  const swatches = pop.querySelectorAll(".color-swatch[data-index]");
  swatches.forEach((sw) => {
    const p = PRESETS[Number(sw.dataset.index)];
    sw.classList.toggle("active", !!p && normalizeHex(p.primary) === normalizeHex(toHex(curPrimary)));
  });
}

/** rgb()/hex -> #rrggbb */
function toHex(color) {
  if (!color) return "";
  color = String(color).trim();
  if (color.startsWith("#")) {
    let h = color.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return "#" + h.toLowerCase();
  }
  const start = color.indexOf("(");
  const end = color.lastIndexOf(")");
  if (start < 0 || end < 0) return "";
  const parts = color.slice(start + 1, end).split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return "";
  return "#" + parts.slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("");
}

function normalizeHex(h) {
  return (h || "").toLowerCase();
}

export function initAppearanceUI() {
  const btn = document.getElementById("appearance-toggle");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = getPopover();
    // 打开本弹层前先收起其它顶部弹层 (外观/背景互斥, 避免重叠)
    document.querySelectorAll(".bg-popover").forEach((p) => { if (p !== pop) p.classList.add("hidden"); });
    pop.classList.toggle("hidden");
    if (!pop.classList.contains("hidden")) syncPopover(pop);
  });
  document.addEventListener("click", (e) => {
    if (popoverEl && !popoverEl.contains(e.target)) popoverEl.classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popoverEl) popoverEl.classList.add("hidden");
  });
}

export function setTheme(theme) {
  if (THEMES.includes(theme)) apply(theme);
}

export function currentTheme() {
  return document.documentElement.dataset.theme || "light";
}
