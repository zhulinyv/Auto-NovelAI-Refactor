// ============================================================
// 动态角色 / 参考图列表
// ============================================================
import {
    el,
    clear,
    toast,
    sliderRow,
    imageDropZone,
    wireAutocomplete,
    wildcardsButton,
} from "../ui.js";
import { get } from "../api.js";

// ---------------- 动态角色列表 ----------------

export function roleList(container, {
  title,
  fields, // [{id, label, type, options, default, min, max, step, rows}]
  grid = null, // 可选布局: 二维数组按单元格放字段 id, 空值/null 为占位 (默认按顺序流入 grid-2)
  min = 0,
  max = 32,
  maxCountMsg,
  selectable = false, // 点击卡片选中 (配合共享位置区域), 触发 onSelect(index)
  onSelect = null, // (index) => void
  headCheckbox = null, // { id, label, default } 头部复选框 (角色列表的"启用"移到头部)
  onChange = null, // (count) => void, 添加/删除/设置后回调
}) {
  clear(container);
  const items = []; // { card, controls: {id: {get, set}} }
  const state = { count: 0, max };

  function buildControl(f) {
    switch (f.type) {
      case "checkbox": {
        const input = el("input", { type: "checkbox" });
        input.checked = !!f.default;
        const label = el("label", { class: "checkline" }, [input, document.createTextNode(f.label)]);
        return { node: label, get: () => input.checked, set: (v) => { input.checked = !!v; } };
      }
      case "select": {
        const select = el("select", {}, (f.options || []).map((o) => el("option", { value: o, text: o })));
        select.value = f.default ?? f.options?.[0] ?? "";
        return { node: el("div", { class: "field" }, [el("label", { text: f.label }), select]), get: () => select.value, set: (v) => { select.value = v; } };
      }
      case "slider": {
        const s = sliderRow({ min: f.min ?? 0, max: f.max ?? 1, step: f.step ?? 0.05, value: f.default ?? 0 });
        return { node: el("div", { class: "field" }, [el("label", { text: f.label }), s.node]), get: () => s.get(), set: (v) => s.set(v) };
      }
      case "image": {
        // 图片输入区域: 单击选择 / 拖拽放入
        const dz = imageDropZone({
          label: f.label,
          placeholder: "点击选择或拖入图片",
          native: true,
        });
        return { node: dz.node, get: () => dz.get(), set: (v) => { dz.set(v || ""); } };
      }
      case "textarea":
      default: {
        const input = el("textarea", { rows: f.rows || 2, placeholder: f.placeholder || "", value: f.default ?? "" });
        const box = el("div", { class: "ta-box" });
        box.append(input);
        wireAutocomplete(input, box);
        // 提示词输入框: 标签行右侧放 Wildcards 图标按钮 (空间小, 只显示图标)
        const label = el("label", { text: f.label });
        if (f.type === "textarea" || f.wildcards) {
          label.append(wildcardsButton(input, { title: f.label || "提示词" }));
        }
        return { node: el("div", { class: "field" }, [label, box]), get: () => input.value, set: (v) => { input.value = v || ""; } };
      }
    }
  }

  function createItem() {
    const idx = items.length;
    const card = el("div", { class: "role-card", "data-idx": idx });
    const head = el("div", { class: "role-head" }, [
      el("span", { class: "role-num", text: `${title} #${idx + 1}` }),
    ]);
    const body = el("div", { class: "grid grid-2" });
    const controls = {};
    // 头部复选框 (角色列表的"启用"移到头部, 与"角色 #n"并排)
    if (headCheckbox) {
      const input = el("input", { type: "checkbox" });
      input.checked = !!headCheckbox.default;
      const cb = el("label", { class: "checkline" }, [input, document.createTextNode(headCheckbox.label || "启用")]);
      head.append(cb);
      controls[headCheckbox.id] = { node: cb, get: () => input.checked, set: (v) => { input.checked = !!v; } };
    }
    fields.forEach((f) => {
      const ctrl = buildControl(f);
      controls[f.id] = ctrl;
    });
    if (selectable) {
      // 点击卡片任意处选中该角色 (配合共享位置区域)
      card.addEventListener("click", () => selectCard(idx));
      card.classList.add("role-selectable");
    }
    if (grid && grid.length) {
      // 显式布局: [{id, r, c, rs?, cs?}] — r/c 为网格行列, rs 为跨行数, cs 为跨列数
      grid.forEach((cell) => {
        if (!cell || typeof cell !== "object" || !cell.id) return;
        const ctrl = controls[cell.id];
        if (!ctrl) return;
        ctrl.node.style.gridRow = cell.r + (cell.rs && cell.rs > 1 ? " / span " + cell.rs : "");
        ctrl.node.style.gridColumn = cell.c + (cell.cs && cell.cs > 1 ? " / span " + cell.cs : "");
        body.append(ctrl.node);
      });
    } else {
      fields.forEach((f) => body.append(controls[f.id].node));
    }
    card.append(head, body);
    items.push({ card, controls });
    return card;
  }

  /** 高亮选中的卡片 (配合共享位置区域) */
  function selectCard(i) {
    items.forEach((it, k) => it.card.classList.toggle("selected", k === i));
    if (onSelect) onSelect(i);
  }

  /** 快照当前所有控件的值 */
  function snapshot() {
    return items.map((it) => {
      const obj = {};
      for (const [id, ctrl] of Object.entries(it.controls)) obj[id] = ctrl.get();
      return obj;
    });
  }
  /** 把值数组填回当前控件 (仅设置存在的字段) */
  function restore(valsArr) {
    valsArr.forEach((vals, i) => {
      const it = items[i];
      if (!it) return;
      for (const [id, ctrl] of Object.entries(it.controls)) {
        if (vals[id] !== undefined) ctrl.set(vals[id]);
      }
    });
  }

  // 增量渲染: 卡片是重量级 DOM (每个含多个控件), 原实现每次增删都全量销毁重建
  // 并对所有控件做一次 snapshot/restore。现在只增删差异部分, 已填内容天然保留。
  const btnRow = el("div", { style: "display:flex;gap:8px;margin-bottom:10px;" });
  const notify = () => { if (onChange) onChange(state.count); };
  btnRow.append(
    el("button", { class: "btn btn-sm", text: "➕ 添加", onclick: () => { if (state.count < state.max) { state.count++; render(); notify(); } else toast(maxCountMsg || ("最多 " + state.max + " 个"), "warning"); } }),
    el("button", { class: "btn btn-sm btn-ghost", text: "➖ 删除", onclick: () => { if (state.count > min) { state.count--; render(); notify(); } } }),
  );

  let mounted = false;
  function render() {
    if (!mounted) {
      container.append(btnRow);
      mounted = true;
    }
    // 多了就删尾部卡片, 少了就补新卡片 —— 中间已有的卡片原样保留
    while (items.length > state.count) {
      const removed = items.pop();
      removed.card.remove();
    }
    while (items.length < state.count) {
      container.append(createItem());
    }
  }

  render();

  return {
    getItems: () => items.map((it) => {
      const obj = {};
      for (const [id, ctrl] of Object.entries(it.controls)) obj[id] = ctrl.get();
      return obj;
    }),
    setCount: (n) => {
      state.count = Math.max(min, Math.min(state.max, n));
      render();
      if (onChange) onChange(state.count);
    },
    getCount: () => state.count,
    // 动态调整上限 (nai5 32, 其余 6), 超出时自动裁剪
    setMax: (n) => {
      state.max = Math.max(min, n);
      if (state.count > state.max) { state.count = state.max; render(); }
      if (onChange) onChange(state.count);
    },
    // 用值数组重建并填充控件 (用于法术解析回填等)
    setItems: (arr) => {
      state.count = Math.max(min, Math.min(state.max, arr.length));
      render();
      restore(arr);
      if (onChange) onChange(state.count);
    },
    selectCard,
  };
}
