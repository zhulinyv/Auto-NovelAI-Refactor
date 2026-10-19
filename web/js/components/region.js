// ============================================================
// 角色区域选择器: 共享一块与分辨率同比例的区域
// ============================================================
import { el } from "../ui.js";
import { get } from "../api.js";

// ---------------- 角色区域选择器 (共享一块与分辨率同比例的区域) ----------------

const POS_DOT_COLORS = ["#a78bfa", "#f43f5e", "#22c55e", "#f59e0b", "#06b6d4", "#a855f7", "#84cc16", "#ef4444", "#3b82f6", "#14b8a6"];

/** 网格标签 (A1-E5) -> 归一化坐标 (x,y, 0-1), 与后端 position_to_float 一致 */
function gridLabelToXY(label) {
  const col = label.charCodeAt(0) - 65; // A=0, E=4
  const row = parseInt(label[1], 10) - 1; // 1=0, 5=4
  return { x: +(0.1 + col * 0.2).toFixed(2), y: +(0.1 + row * 0.2).toFixed(2) };
}

/** 归一化坐标 -> 最近网格标签, 与后端 float_to_position 一致 */
function xyToGridLabel(x, y) {
  const opts = [0.1, 0.3, 0.5, 0.7, 0.9];
  const near = (v) => { let bi = 0, bd = Infinity; opts.forEach((o, i) => { const d = Math.abs(o - v); if (d < bd) { bd = d; bi = i; } }); return bi; };
  return String.fromCharCode(65 + near(x)) + (near(y) + 1);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

/**
 * 共享角色位置选择器: 所有角色共用同一块与分辨率同比例的区域。
 * grid 模式 (v4/v4.5): 区域等分成 5x5 的 A1-E5 小格, 选中的角色点击格子即可放置。
 * free 模式 (v5): 区域内用可拖动的圆形图标表示角色, 自由拖动定位。
 */
export function characterRegionPicker({
  getSize = null,                 // () => {w,h} 读取当前分辨率
  onChange = null,                // (positions) => void 位置变化回调
} = {}) {
  const sizeFn = getSize || (() => ({ w: 832, h: 1216 }));
  const box = el("div", { class: "pos-picker" });
  const gridView = el("div", { class: "pos-picker-grid" });
  const freeView = el("div", { class: "pos-picker-free" });
  const info = el("div", { class: "pos-picker-info" });
  const node = el("div", { class: "field" }, [
    el("label", { text: "📍 角色位置" }),
    box,
    info,
  ]);
  box.append(gridView, freeView);

  let mode = "grid";               // grid | free
  let count = 0;                   // 角色数量
  let selected = -1;               // 当前选中的角色下标
  let chars = [];                  // chars[i] = { grid: "C3", xy: {x,y} }
  let dragging = null;             // { i, pid }

  // ---- 5x5 网格 (每个格子可放多个角色徽标) ----
  const cells = [];
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const labelText = String.fromCharCode(65 + c) + (r + 1);
      const badgeHolder = el("div", { class: "pos-cell-badges" });
      const cell = el("div", { class: "pos-picker-cell", title: labelText }, [
        el("span", { class: "pos-cell-label", text: labelText }),
        badgeHolder,
      ]);
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selected >= 0 && selected < count) {
          // 把选中的角色放到这个格子 (若原格不同则迁移)
          chars[selected].grid = labelText;
          chars[selected].xy = gridLabelToXY(labelText);
          render();
        }
      });
      cells.push({ label: labelText, cell, badges: badgeHolder });
      gridView.append(cell);
    }
  }

  // ---- 自由区域: 拖动圆形图标 / 点击放置选中角色 ----
  function xyFromEvent(e) {
    const rect = freeView.getBoundingClientRect();
    const x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    return { x: +(x).toFixed(2), y: +(y).toFixed(2) };
  }
  freeView.addEventListener("pointerdown", (e) => {
    const dotEl = e.target && e.target.closest ? e.target.closest(".pos-picker-dot") : null;
    if (dotEl) {
      const i = Number(dotEl.dataset.i);
      if (!Number.isFinite(i)) return;
      e.preventDefault();
      selected = i;
      dragging = { i, pid: e.pointerId };
      if (freeView.setPointerCapture) { try { freeView.setPointerCapture(e.pointerId); } catch (_) { /* 兼容旧浏览器 */ } }
      render();
    } else if (selected >= 0 && selected < count) {
      // 点击空白区域: 把选中的角色移到这里
      const xy = xyFromEvent(e);
      chars[selected].xy = xy; chars[selected].grid = xyToGridLabel(xy.x, xy.y);
      render();
    }
  });
  freeView.addEventListener("pointermove", (e) => {
    if (dragging && e.pointerId === dragging.pid) {
      e.preventDefault();
      const i = dragging.i;
      const xy = xyFromEvent(e);
      chars[i].xy = xy; chars[i].grid = xyToGridLabel(xy.x, xy.y);
      render();
    }
  });
  const endDrag = (e) => { if (dragging && e.pointerId === dragging.pid) dragging = null; };
  freeView.addEventListener("pointerup", endDrag);
  freeView.addEventListener("pointercancel", endDrag);

  // ---- 布局: 与分辨率同比例 ----
  function layout() {
    const { w, h } = sizeFn();
    const ar = w / h;
    const parentW = node.clientWidth ? node.clientWidth - 8 : 320;
    const maxW = Math.min(460, Math.max(180, parentW));
    const maxH = 380;
    let cw = maxW, ch = maxW / ar;
    if (ch > maxH) { ch = maxH; cw = maxH * ar; }
    box.style.width = Math.round(cw) + "px";
    box.style.height = Math.round(ch) + "px";
  }

  /** 新增角色的默认位置 (grid: 找第一个空格子; free: 均布错开) */
  function defaultEntry(i) {
    if (mode === "grid") {
      const used = new Set(chars.map((c) => c.grid));
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
        const g = String.fromCharCode(65 + c) + (r + 1);
        if (!used.has(g)) return { grid: g, xy: gridLabelToXY(g) };
      }
      return { grid: "C3", xy: gridLabelToXY("C3") };
    }
    const x = +(0.25 + (i % 3) * 0.25).toFixed(2);
    const y = +(0.25 + Math.floor(i / 3) * 0.25).toFixed(2);
    return { grid: xyToGridLabel(x, y), xy: { x, y } };
  }

  function ensureDots() {
    while (freeView.children.length < count) {
      const d = el("div", { class: "pos-picker-dot" });
      d.dataset.i = String(freeView.children.length);
      d.addEventListener("click", (e) => { e.stopPropagation(); selected = Number(d.dataset.i); render(); });
      freeView.append(d);
    }
    while (freeView.children.length > count) {
      freeView.lastChild.remove();
    }
  }

  function render() {
    ensureDots();
    // 网格徽标
    cells.forEach(({ cell, badges }) => {
      while (badges.firstChild) badges.removeChild(badges.firstChild);
      cell.classList.remove("occupied");
    });
    if (mode === "grid") {
      for (let i = 0; i < count; i++) {
        const holder = cells.find((c) => c.label === chars[i].grid);
        if (!holder) continue;
        holder.cell.classList.add("occupied");
        const b = el("div", {
          class: "pos-badge" + (selected === i ? " sel" : ""),
          text: String(i + 1),
          title: "角色 " + (i + 1),
        });
        b.style.background = POS_DOT_COLORS[i % POS_DOT_COLORS.length];
        b.addEventListener("click", (e) => { e.stopPropagation(); selected = i; render(); });
        holder.badges.append(b);
      }
    } else {
      for (let i = 0; i < count; i++) {
        const d = freeView.children[i];
        d.style.left = (chars[i].xy.x * 100) + "%";
        d.style.top = (chars[i].xy.y * 100) + "%";
        d.style.background = POS_DOT_COLORS[i % POS_DOT_COLORS.length];
        d.textContent = String(i + 1);
        d.classList.toggle("sel", selected === i);
      }
    }
    gridView.style.display = mode === "grid" ? "" : "none";
    freeView.style.display = mode === "free" ? "" : "none";
    // 提示文案
    if (count === 0) {
      info.textContent = "⬇️ 先在下方添加角色, 再回到这里设置位置";
    } else if (mode === "grid") {
      info.textContent = selected >= 0
        ? "📍 正在放置 角色 #" + (selected + 1) + " — 点击网格小格 (A1-E5) 确定位置"
        : "👆 点击左侧角色卡片选中后, 再点击网格小格 (A1-E5) 确定位置";
    } else {
      info.textContent = selected >= 0
        ? "📍 角色 #" + (selected + 1) + " 已选中 — 拖动圆形图标自由定位"
        : "🖐 点击/拖动圆形图标自由定位角色";
    }
  }

  function select(i) {
    if (i < -1 || i >= count) return;
    selected = i;
    render();
  }

  function setCount(n) {
    n = Math.max(0, n);
    count = n;
    while (chars.length < count) chars.push(defaultEntry(chars.length));
    if (chars.length > count) chars.length = count;
    if (selected >= count) selected = count - 1;
    render();
  }

  function setMode(m) {
    mode = m === "free" ? "free" : "grid";
    // 模型切换时把已有位置换算成当前模式的表达
    chars.forEach((c) => {
      if (mode === "grid") { c.grid = xyToGridLabel(c.xy.x, c.xy.y); c.xy = gridLabelToXY(c.grid); }
      else { c.xy = gridLabelToXY(c.grid); c.grid = xyToGridLabel(c.xy.x, c.xy.y); }
    });
    render();
  }

  function restore(arr) {
    (arr || []).slice(0, count).forEach((pos, i) => {
      if (pos == null || pos === "") return;
      const s = String(pos);
      if (s.includes(",")) {
        const [x, y] = s.split(",").map(parseFloat);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          chars[i].xy = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
          chars[i].grid = xyToGridLabel(chars[i].xy.x, chars[i].xy.y);
        }
      } else if (/^[A-E][1-5]$/i.test(s)) {
        chars[i].grid = s.toUpperCase();
        chars[i].xy = gridLabelToXY(chars[i].grid);
      }
    });
    render();
  }

  layout();
  render();

  return {
    node,
    get count() { return count; },
    /** 每个角色当前的位置字符串: grid 模式 A1-E5, free 模式 x,y */
    getPositions: () => chars.slice(0, count).map((c) =>
      mode === "grid" ? c.grid : c.xy.x.toFixed(2) + "," + c.xy.y.toFixed(2)),
    setCount,
    setMode,
    select,
    getSelected: () => selected,
    restore,
    refresh: layout,
  };
}
