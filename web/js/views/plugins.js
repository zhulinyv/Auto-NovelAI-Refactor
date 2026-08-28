// ============================================================
// 插件视图: 插件商店 + 单个插件的独立页面
// ============================================================
import { $, $$, el, clear, toast, bus, makeField, closeToastNode } from "../ui.js";
import { post, imageUrl, openDir } from "../api.js";
import { gallery } from "../components.js";
import { drawBetaChart } from "../dist_chart.js";

let S = null;

// 跨面板字段注册表: 支持 show_if 引用其他面板的字段 (如随机画风的模型 -> Furry 模式)
const fieldRegistry = new Map();
// 动作元信息: 任务名 -> {setField, showOutput} (用于还原类动作把结果写回字段)
const actionMeta = new Map();
// 任务启动 toast: job_id -> toast 节点 (任务结束时先关闭它, 避免与结果通知重复)
const startToasts = new Map();
// 各面板的 show_if 求值函数: 任意字段变化时统一刷新所有面板 (处理跨面板联动)
let showIfFns = [];
function runAllShowIf() {
  for (const fn of showIfFns) { try { fn(); } catch {} }
}
// 分布图重绘函数集: 主题切换 (data-theme) 时全部重绘
const chartRedrawAll = [];
let chartThemeBound = false;
function bindChartThemeObserver() {
  if (chartThemeBound) return;
  chartThemeBound = true;
  new MutationObserver(() => {
    if (!chartRedrawAll.length) return;
    chartRedrawAll.forEach((fn) => { try { fn(); } catch {} });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

// Konami 彩蛋: 上上下下左右左右BABA 解锁隐藏字段 (如 naiv4vibebundle)
let konamiUnlocked = false;
const KONAMI_SEQ = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a", "b", "a"];
let konamiIdx = 0;
window.addEventListener("keydown", (e) => {
  const key = e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === KONAMI_SEQ[konamiIdx]) {
    konamiIdx++;
    if (konamiIdx === KONAMI_SEQ.length) {
      konamiIdx = 0;
      if (!konamiUnlocked) {
        konamiUnlocked = true;
        toast("🎉 隐藏选项已解锁!", "success");
        runAllShowIf();
      }
    }
  } else {
    konamiIdx = key === KONAMI_SEQ[0] ? 1 : 0;
  }
});

// 插件表单值持久化: 记录各面板"待保存"函数, 切换页面前统一 flush, 防止内容丢失
const pendingSaves = new Set();
async function flushPendingSaves() {
  const fns = [...pendingSaves];
  pendingSaves.clear();
  await Promise.allSettled(fns.map((fn) => fn()));
}

// 任务事件 (模块级注册一次, 避免重复导航后多次绑定)
bus.on("job:event", (ev) => {
  if (ev.name !== "preview") return;
  const target = document.getElementById(`plugin-preview-${ev.id}`);
  if (!target) return;
  const p = target.querySelector(".preview-prompt");
  if (p && ev.prompt !== undefined) p.textContent = ev.prompt;
  const img = target.querySelector("img");
  if (img && ev.image) { img.src = imageUrl(ev.image); target.classList.remove("hidden"); }
});
bus.on("job:done", (ev) => {
  if (!ev.name?.startsWith("plugin:")) return;
  // 任务名格式: plugin:{插件}/{面板}/{动作} -> 输出区 id 为 plugin-output-{面板}-{动作}
  const parts = ev.name.split("/");
  const key = parts.length >= 3 ? parts[1] + "-" + parts[2] : (parts[1] || "");
  const target = document.getElementById(`plugin-output-${key}`);
  const msg = ev.message || ev.text || "";
  // 任务结束: 先关闭"任务已启动"通知, 避免与结果通知同时出现
  const startNode = startToasts.get(ev.id);
  if (startNode) { try { closeToastNode(startNode); } catch {} startToasts.delete(ev.id); }
  // 还原类动作 (如还原文件): 把返回内容直接写入指定字段, 并自动保存一次
  const meta = actionMeta.get(ev.name);
  if (meta && meta.setField && ev.content !== undefined) {
    const ctrl = fieldRegistry.get(meta.setField);
    if (ctrl) {
      try { ctrl.setValue(ev.content); } catch {}
      ctrl.node.querySelectorAll("input, select, textarea").forEach((el_) => {
        el_.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }
  const info = target ? target.querySelector(".info-box") : null;
  if (info) {
    // 无论有无消息都更新输出区, 避免一直停留在 "🚀 正在执行..."
    info.textContent = "✅ " + (msg || "处理完成");
  }
  if (msg && !info) {
    // 无输出区 (如配置保存) 时用右上角通知展示结果
    toast("✅ " + msg, "success");
  }
  // 生成结束: 移除边框闪烁动画
  const previewBox = document.getElementById(`plugin-preview-${ev.id}`);
  if (previewBox) previewBox.classList.remove("generating");
  // 实时预览容器也展示最终图 (无输出框的动作, 如随机画风生成)
  if (ev.image && previewBox) {
    const pvImg = previewBox.querySelector("img");
    if (pvImg) { pvImg.src = imageUrl(ev.image); previewBox.classList.remove("hidden"); }
  }
  if (target) {
    if (ev.images?.length) {
      const gal = target.querySelector(".gallery");
      if (gal) gallery(gal, ev.images);
    }
    if (ev.image) {
      const img = target.querySelector(".preview-img");
      if (img) { img.src = imageUrl(ev.image); img.style.display = ""; }
    }
    // 动作结果带保存目录时 (如"仅整理"/"压缩并整理"), 显示"打开保存目录"按钮
    if (ev.dir) {
      const box = target.querySelector(".plugin-out-actions");
      if (box) {
        let btn = box.querySelector(".open-save-dir-btn");
        if (!btn) {
          btn = el("button", {
            class: "btn btn-sm btn-file open-save-dir-btn",
            type: "button",
            text: "📂 打开保存目录",
          });
          btn.addEventListener("click", async () => {
            try { await openDir(btn.dataset.dir || ""); } catch {}
          });
          box.append(btn);
        }
        btn.dataset.dir = ev.dir;
      }
    }
  }
});
// 任务失败: 有输出区则更新输出区, 否则用右上角通知提示
bus.on("job:failed", (ev) => {
  if (!ev.name?.startsWith("plugin:")) return;
  const parts = ev.name.split("/");
  const key = parts.length >= 3 ? parts[1] + "-" + parts[2] : (parts[1] || "");
  const target = document.getElementById(`plugin-output-${key}`);
  // 任务失败: 先关闭"任务已启动"通知, 只保留一条错误通知
  const startNode = startToasts.get(ev.id);
  if (startNode) { try { closeToastNode(startNode); } catch {} startToasts.delete(ev.id); }
  // 移除生成中边框动画
  const previewBox = document.getElementById(`plugin-preview-${ev.id}`);
  if (previewBox) previewBox.classList.remove("generating");
  if (target) {
    const info = target.querySelector(".info-box");
    if (info) info.textContent = "❌ " + (ev.error || "任务失败");
  } else {
    toast("❌ " + (ev.error || "任务失败"), "error");
  }
});

// ============================================================
// 插件商店
// ============================================================

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["🛒 插件商店", el("span", { class: "sub", text: "在线安装 / 卸载 / 启停插件" })]),
  );

  const outBox = el("div", { class: "info-box", style: "margin-bottom:12px;" });

  const table = el("table", { class: "store-table" }, [
    el("thead", {}, [el("tr", {}, ["插件", "描述", "作者", "状态", "操作"].map((h) => el("th", { text: h })))]),
    el("tbody"),
  ]);
  const tbody = table.querySelector("tbody") || table.children[1];

  // 待应用状态: name -> "disabled" | "enabled" (点击启停后暂存, 点"应用"才生效)
  const pendingMap = new Map();

  function renderRows() {
    clear(tbody);
    (S.app.plugin_rows || []).forEach((r) => {
      const pend = pendingMap.get(r.name);
      const disp = pend === "disabled" ? "已禁用" : pend === "enabled" ? "已启用" : r.status;
      const pill = el("span", { class: `pill ${pend ? "pending" : statusClass(r.status)}`, text: disp + (pend ? " ⏳" : "") });
      const tr = el("tr", {}, [
        el("td", { text: r.name }),
        el("td", { html: markdownToHtml(r.description || "-") }),
        el("td", { html: markdownToHtml(r.author || "-") }),
        el("td", {}, [pill]),
        el("td", {}, [actionButtons(r, outBox)]),
      ]);
      tbody.append(tr);
    });
    const applyBtn = document.getElementById("store-apply-btn");
    if (applyBtn) {
      const hasPending = pendingMap.size > 0;
      applyBtn.disabled = !hasPending;
      applyBtn.textContent = hasPending ? `🔄 应用更改 (${pendingMap.size})` : "🔄 应用更改";
    }
  }

  function actionButtons(row, outBox) {
    const wrap = el("div", { class: "row-actions" });
    const status = row.status;
    if (status === "未安装") {
      wrap.append(el("button", { class: "btn btn-sm btn-primary", text: "⬇️ 安装", onclick: () => storeAction("/api/plugins/install", row.name, outBox) }));
    } else {
      const effDisabled = pendingMap.get(row.name) === "disabled" || (pendingMap.get(row.name) !== "enabled" && status === "已禁用");
      wrap.append(el("button", { class: "btn btn-sm", text: "🔄 更新", onclick: () => storeAction("/api/plugins/install", row.name, outBox) }));
      wrap.append(el("button", { class: "btn btn-sm btn-danger", text: "🗑️ 删除", onclick: () => storeAction("/api/plugins/uninstall", row.name, outBox) }));
      wrap.append(el("button", { class: "btn btn-sm", text: effDisabled ? "✅ 启用" : "🔀 禁用", onclick: () => toggleRow(row, outBox, effDisabled) }));
      if (pendingMap.has(row.name)) {
        wrap.append(el("button", { class: "btn btn-sm btn-primary", text: "🔄 应用", onclick: () => applyChanges(outBox) }));
      }
    }
    return wrap;
  }

  async function toggleRow(row, outBox, currentlyDisabled) {
    // 快速切换: 只改本地期望状态, 不重启后端
    pendingMap.set(row.name, currentlyDisabled ? "enabled" : "disabled");
    renderRows();
    try {
      const res = await post("/api/plugins/toggle", { name: row.name });
      outBox.textContent = res.message;
      toast(res.message, "info");
    } catch (e) {
      pendingMap.delete(row.name);
      renderRows();
      outBox.textContent = "❌ " + e.message;
      toast(e.message, "error");
    }
  }

  async function applyChanges(outBox) {
    try {
      const res = await post("/api/plugins/apply", {});
      outBox.textContent = res.message;
      toast("后端重启中, 正在刷新界面...", "info");
    } catch (e) {
      outBox.textContent = "❌ " + e.message;
      toast(e.message, "error");
    }
    let back = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const r = await fetch("/api/state");
        if (r.ok) { back = true; break; }
      } catch { /* 等待后端重启完成 */ }
    }
    if (!back) toast("后端未响应, 请检查服务状态", "error");
    location.reload();
  }

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-title", style: "display:flex;align-items:center;justify-content:space-between;gap:10px;" }, [
        el("span", { text: "🧩 插件管理" }),
        el("button", { id: "store-apply-btn", class: "btn btn-sm btn-primary", text: "🔄 应用更改", onclick: () => applyChanges(outBox) }),
      ]),
      outBox,
      table,
    ])
  );
  renderRows();
}

// markdown 链接 -> HTML 链接 (作者 / 描述字段)
function markdownToHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function statusClass(status) {
  if (status === "已安装") return "installed";
  if (status === "更新可用") return "update";
  if (status === "已禁用") return "disabled";
  return "not-installed";
}

async function storeAction(url, name, outBox) {
  if (!name) { toast("请选择插件", "warning"); return; }
  try {
    const res = await post(url, { name });
    outBox.textContent = res.message;
    toast(res.message, "info");
  } catch (e) {
    outBox.textContent = "❌ " + e.message;
    toast(e.message, "error");
  }
  // 插件增删/启停后后端可能重启: 等待后端恢复后刷新前端
  toast("后端正在处理, 即将刷新界面...", "info");
  let back = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const r = await fetch("/api/state");
      if (r.ok) { back = true; break; }
    } catch { /* 等待重启完成 */ }
  }
  if (!back) toast("后端未响应, 请检查服务状态", "error");
  location.reload();
}

// ============================================================
// 单个插件页面
// ============================================================

export async function renderPluginPage(pluginName, container, ctx) {
  S = ctx;
  // 先落盘上次未保存的表单值, 再重建页面, 避免切换视图后内容丢失
  await flushPendingSaves();
  // 重置跨面板注册表与 show_if 求值函数 (konami 解锁状态保留)
  fieldRegistry.clear();
  actionMeta.clear();
  showIfFns = [];
  chartRedrawAll.length = 0;
  // 清理残留的图表悬停气泡
  const oldTip = document.getElementById("__chartTip");
  if (oldTip) oldTip.remove();
  clear(container);
  const plugin = (S.app.plugins || []).find((p) => p.name === pluginName);
  if (!plugin) {
    container.append(el("div", { class: "card" }, [
      el("div", { class: "card-title", text: "❌ 插件不存在" }),
      el("p", { class: "muted", text: `找不到插件: ${pluginName}` }),
    ]));
    return;
  }

  container.append(
    el("h2", {}, [plugin.icon || "🧩", " ", plugin.title || plugin.name, el("span", { class: "sub", text: plugin.name })]),
  );
  if (plugin.description) container.append(el("p", { class: "muted", style: "margin-bottom:12px;", text: plugin.description }));

  // 面板页签
  const panelBar = el("div", { class: "tabs" });
  const panelBodies = [];
  plugin.panels.forEach((panel, pi) => {
    const btn = el("button", { class: "tab-btn" + (pi === 0 ? " active" : ""), text: (panel.icon || "🌸") + " " + panel.title });
    const pbody = el("div", { class: "tab-content" + (pi === 0 ? " active" : "") });
    btn.addEventListener("click", () => {
      [...panelBar.children].forEach((b) => b.classList.remove("active"));
      panelBodies.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      pbody.classList.add("active");
    });
    panelBar.append(btn);
    panelBodies.push(pbody);
    renderPanel(plugin, panel, pbody);
  });
  container.append(panelBar, ...panelBodies);
  // 所有面板渲染完成后统一求值一次条件显示 (处理跨面板依赖, 如模型 -> Furry 模式)
  runAllShowIf();
}

function renderPanel(plugin, panel, body) {
  const controls = {};
  // 布局: 右列是否需要 (column="right" 字段 或 有输出框的动作)
  const hasRightCol = panel.fields.some((f) => f.column === "right") || panel.actions.some((a) => a.show_output);
  const useGrid = hasRightCol && !panel.inline_actions;

  // 左列: 表单字段; 右列: 输出/图表/说明 (字段通过 column 属性指定)
  const fieldBox = el("div", { class: "card", style: "margin:0;" });
  const outContainer = el("div", { style: "min-width:0;" });
  const wrap = el("div", { class: useGrid ? "grid grid-2" : "" });
  if (useGrid) {
    wrap.append(fieldBox, outContainer);
    body.append(wrap);
  } else if (panel.fields.length) {
    wrap.append(fieldBox);
    body.append(wrap);
  }

  // 表单值持久化: 变更后保存到后端 (换浏览器/刷新仍保留)
  // 文件类参数 (filearea/path/image) 不持久化: 重启 WebUI 后文件路径/上传文件可能失效, 统一清空
  const FILE_FIELD_TYPES = new Set(["filearea", "path", "image"]);
  let saveTimer = null;
  const doSave = async () => {
    const payload = {};
    panel.fields.forEach((f) => {
      if (FILE_FIELD_TYPES.has(f.type)) return;
      payload[f.id] = controls[f.id]?.getValue();
    });
    try { await post(`/api/plugin/${plugin.name}/${panel.id}/values`, { values: payload }); } catch {}
  };
  // 输入类 (打字/拖动滑块): 节流保存, 防止高频请求
  const saveValues = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 250);
  };
  // 提交类 (选择文件/下拉/释放滑块): 立即保存; 同时纳入切换页面前的统一 flush
  const saveNow = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    doSave();
  };
  pendingSaves.add(doSave);

  // row_group 缓冲: 相邻同组字段渲染到同一行 (如 variety 与 decrisp 并排)
  let rowBuffer = [];
  let currentRowGroup = "";
  const flushRow = () => {
    if (!rowBuffer.length) return;
    const row = el("div", { class: "field-row" });
    rowBuffer.forEach((ctrl) => row.append(ctrl.node));
    fieldBox.append(row);
    rowBuffer = [];
  };
  panel.fields.forEach((f) => {
    const ctrl = makeField(f, {});
    controls[f.id] = ctrl;
    fieldRegistry.set(f.id, ctrl);
    if (!f.corner_of) {
      if (f.row_group) {
        // 同组字段进入缓冲行
        if (f.row_group !== currentRowGroup) { flushRow(); currentRowGroup = f.row_group; }
        rowBuffer.push(ctrl);
      } else {
        flushRow(); currentRowGroup = "";
        const parent = (f.column === "right" && useGrid) ? outContainer : fieldBox;
        parent.append(ctrl.node);
      }
    }
    // 原生控件: 打字/拖动节流保存, 提交类立即保存, 并联动条件显示
    ctrl.node.querySelectorAll("input, select, textarea").forEach((el_) => {
      el_.addEventListener("input", saveValues);
      el_.addEventListener("change", saveNow);
      el_.addEventListener("input", runAllShowIf);
      el_.addEventListener("change", runAllShowIf);
    });
    // radio / checkbox_group: 点击选项时立即保存 + 联动条件显示
    ctrl.node.querySelectorAll(".opt-item").forEach((item) => {
      item.addEventListener("click", saveNow);
      item.addEventListener("click", runAllShowIf);
    });
  });
  flushRow();

  // 角标下拉: 附加到目标字段的标题行右侧按钮组 (如提示词预设挂在输入框右上角, Wildcards 按钮左边)
  panel.fields.forEach((f) => {
    if (!f.corner_of) return;
    const ctrl = controls[f.id];
    const target = controls[f.corner_of];
    if (!ctrl || !target) return;
    const head = target.node.querySelector(".prompt-head");
    if (head) (head.querySelector(".prompt-head-right") || head).append(ctrl.node);
  });

  // 分辨率预设 -> 宽高联动 (sync="WxH" 的字段选中 "宽x高" 选项时写入 inputs 字段)
  panel.fields.forEach((f) => {
    if (f.sync !== "WxH") return;
    const ctrl = controls[f.id];
    const targets = (f.inputs || []).map((id) => controls[id]).filter(Boolean);
    if (!ctrl || targets.length < 2) return;
    const sel = ctrl.node.querySelector("select");
    if (!sel) return;
    sel.addEventListener("change", () => {
      const m = /^(\d+)x(\d+)$/.exec(ctrl.getValue() || "");
      if (!m) return;
      try { targets[0].setValue(parseInt(m[1], 10)); targets[1].setValue(parseInt(m[2], 10)); } catch {}
      saveNow();
    });
  });

  // 模型联动采样器/调度器 (与 ANR 原插件一致: ddim_v3 仅 nai-3; native 仅 nai-3; nai-5 固定 karras)
  let applyModelOptions = null;
  {
    const modelCtrl = controls["model"];
    const samplerCtrl = controls["sampler"];
    const noiseCtrl = controls["noise_schedule"];
    if (modelCtrl && samplerCtrl && noiseCtrl) {
      const ALL_SAMPLERS = ["k_euler", "k_euler_ancestral", "k_dpmpp_2s_ancestral", "k_dpmpp_2m", "k_dpmpp_sde", "k_dpmpp_2m_sde", "ddim_v3", "随机"];
      const ALL_NOISES = ["native", "karras", "exponential", "polyexponential", "随机"];
      const setOptions = (ctrl, opts) => {
        const sel = ctrl.node.querySelector("select");
        if (!sel) return;
        const cur = ctrl.getValue();
        sel.innerHTML = "";
        opts.forEach((o) => sel.append(new Option(o, o)));
        sel.value = opts.includes(cur) ? cur : (opts[0] || "");
      };
      applyModelOptions = () => {
        const m = modelCtrl.getValue();
        const nai3 = m === "nai-diffusion-3" || m === "nai-diffusion-furry-3";
        const nai5 = m === "nai-diffusion-5-full" || m === "nai-diffusion-5-curated";
        setOptions(samplerCtrl, nai3 ? ALL_SAMPLERS : ALL_SAMPLERS.filter((s) => s !== "ddim_v3"));
        if (nai5) noiseCtrl.setValue("karras");
        else setOptions(noiseCtrl, nai3 ? ALL_NOISES : ALL_NOISES.filter((n) => n !== "native"));
      };
      modelCtrl.node.querySelectorAll("select").forEach((s) => s.addEventListener("change", applyModelOptions));
      applyModelOptions();
    }
  }

  // 输出区: 每个 show_output 动作一个
  const outputMap = {};
  panel.actions.forEach((action) => {
    if (!action.show_output) return;
    const outBox = el("div", { id: `plugin-output-${panel.id}-${action.id}`, class: "card", style: "margin:0 0 12px 0;" }, [
      el("div", { class: "card-title", text: "📤 " + (action.label || "输出") }),
    ]);
    const gal = el("div", { class: "gallery" });
    const previewImg = el("img", { class: "preview-img", style: "display:none;max-width:100%;max-height:360px;border-radius:12px;border:2px solid var(--border);" });
    const infoBox = el("div", { class: "info-box" });
    const outActions = el("div", { class: "plugin-out-actions" });
    outBox.append(gal, previewImg, infoBox, outActions);
    outContainer.append(outBox);
    outputMap[action.id] = { gal, previewImg, infoBox, outActions };
  });

  // 内联动作面板 (无右列): 输出区由下方 stage 容器统一放置

  // 实时分布图: 监听 inputs 指定的参数变化并重绘 canvas (requestAnimationFrame 合并, 避免高频重绘)
  const chartRedraws = [];
  panel.fields.forEach((f) => {
    const ctrl = controls[f.id];
    if (!ctrl || !ctrl.canvas) return;
    const ids = ctrl.inputs || [];
    let rafPending = false;
    const redraw = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        const params = {};
        ids.forEach((id) => { params[id] = fieldRegistry.get(id)?.getValue(); });
        try { drawBetaChart(ctrl.canvas, params); } catch {}
      });
    };
    ids.forEach((id) => {
      const c = fieldRegistry.get(id);
      if (!c) return;
      c.node.querySelectorAll("input, select").forEach((el_) => {
        el_.addEventListener("input", redraw);
        el_.addEventListener("change", redraw);
      });
    });
    chartRedraws.push(redraw);
    chartRedrawAll.push(redraw);
    redraw();
  });
  bindChartThemeObserver();

  // 恢复上次使用的表单值 (服务器端持久化, 换浏览器仍生效)
  (async () => {
    try {
      const res = await fetch(`/api/plugin/${plugin.name}/${panel.id}/values`);
      const data = await res.json();
      const saved = data.values || {};
      panel.fields.forEach((f) => {
        // 文件类参数不恢复 (重启后清空)
        if (FILE_FIELD_TYPES.has(f.type)) return;
        if (saved[f.id] !== undefined && controls[f.id]) {
          try { controls[f.id].setValue(saved[f.id]); } catch {}
        }
      });
      // 恢复的模型值也要同步采样器/调度器选项
      if (applyModelOptions) { try { applyModelOptions(); } catch {} }
      chartRedraws.forEach((fn) => fn());
      runAllShowIf();
    } catch {}
  })();

  // 动作按钮行
  let previewTarget = body; // 实时预览容器附加目标 (内联动作面板为 stage)
  const actRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;" });
  panel.actions.forEach((action) => {
    actionMeta.set(`plugin:${plugin.name}/${panel.id}/${action.id}`, { setField: action.set_field || "", showOutput: action.show_output });
    const btn = el("button", { class: "btn btn-primary", text: "▶️ " + action.label });
    btn.addEventListener("click", async () => {
      const payload = {};
      // 跨面板取值: 动作可能引用其他面板的字段 (如生成按钮引用模型/提示词等)
      for (const id of action.inputs || []) payload[id] = fieldRegistry.get(id)?.getValue();
      const out = outputMap[action.id];
      btn.disabled = true;
      if (out) out.infoBox.textContent = "🚀 正在执行...";
      try {
        const res = await post(`/api/plugin/${plugin.name}/${panel.id}/${action.id}`, { values: payload });
        // 实时预览容器 (供生成器类动作逐张推送预览, 如随机画风)
        const previewId = `plugin-preview-${res.job_id}`;
        let pvBox = document.getElementById(previewId);
        if (!pvBox) {
          pvBox = el("div", { id: previewId, class: "plugin-preview hidden" });
          const pvImg = el("img", { class: "plugin-preview-img", alt: "预览" });
          // 双击最大化查看
          pvImg.addEventListener("dblclick", () => {
            if (!pvImg.src) return;
            const overlay = el("div", { class: "img-max-overlay" }, [
              el("img", { class: "img-max-content", src: pvImg.src, alt: "预览" }),
            ]);
            overlay.addEventListener("click", () => overlay.remove());
            document.body.append(overlay);
          });
          pvBox.append(pvImg, el("div", { class: "muted preview-prompt" }));
          previewTarget.append(pvBox);
        }
        // 长时任务: 边框闪烁动画 + 右上角通知 (任务结束时会自动关闭该通知)
        if (action.stop !== false) {
          pvBox.classList.add("generating");
          const startNode = toast(`任务已启动: ${res.job_id}`, "success");
          startToasts.set(res.job_id, startNode);
        }
      } catch (e) {
        if (out) out.infoBox.textContent = "❌ " + e.message;
        toast(e.message, "error");
        btn.disabled = false;
      }
      setTimeout(() => { btn.disabled = false; }, 2000);
    });
    actRow.append(btn);
  });

  // 停止按钮 (仅当存在需停止的耗时动作时显示)
  if (panel.actions.some((a) => a.stop !== false)) {
    const stopBtn = el("button", { class: "btn btn-danger", text: "⏹ 停止" });
    stopBtn.addEventListener("click", async () => {
      toast("正在停止生成...", "warning");
      try { await post("/api/stop"); } catch {}
    });
    actRow.append(stopBtn);
  }

  // 还原默认参数按钮
  if (panel.reset_defaults) {
    const resetBtn = el("button", { class: "btn btn-file", text: "🔄 还原默认参数" });
    resetBtn.addEventListener("click", () => {
      panel.fields.forEach((f) => {
        const ctrl = controls[f.id];
        if (!ctrl) return;
        try { ctrl.setValue(f.default); } catch {}
      });
      chartRedraws.forEach((fn) => fn());
      runAllShowIf();
      saveNow();
      toast("已还原为默认参数", "success");
    });
    actRow.append(resetBtn);
  }

  // 放置按钮行: 内联动作面板 -> 按钮放实底(舞台)外部的工具条; 其他 -> 顶栏 view-head
  if (actRow.children.length) {
    if (panel.inline_actions) {
      const btnBar = el("div", { class: "plugin-stage-toolbar" }, [actRow]);
      body.append(btnBar);
      const stage = el("div", { class: "plugin-stage" });
      if (outContainer.children.length) stage.append(outContainer);
      body.append(stage);
      previewTarget = stage;
    } else {
      body.prepend(el("div", { class: "view-head" }, [actRow]));
    }
  }

  // show_if 条件显示: 支持单条规则或规则数组(全部满足), 运算符 equals/not_equals/contains/in/not_in
  function evalShowIf() {
    panel.fields.forEach((f) => {
      const ctrl = controls[f.id];
      if (!ctrl) return;
      // hidden 字段默认隐藏, 彩蛋解锁后显示
      let visible = !(f.hidden && !konamiUnlocked);
      if (visible && f.show_if) {
        const rules = Array.isArray(f.show_if) ? f.show_if : [f.show_if];
        for (const rule of rules) {
          if (!rule || !rule.field) continue;
          const other = fieldRegistry.get(rule.field)?.getValue();
          if (rule.equals !== undefined && other !== rule.equals) { visible = false; break; }
          if (rule.not_equals !== undefined && other === rule.not_equals) { visible = false; break; }
          if (rule.contains !== undefined) {
            const has = Array.isArray(other) ? other.includes(rule.contains) : String(other || "").includes(rule.contains);
            if (!has) { visible = false; break; }
          }
          if (rule.in !== undefined && !(Array.isArray(rule.in) && rule.in.includes(other))) { visible = false; break; }
          if (rule.not_in !== undefined && (Array.isArray(rule.not_in) && rule.not_in.includes(other))) { visible = false; break; }
        }
      }
      ctrl.node.style.display = visible ? "" : "none";
    });
  }
  showIfFns.push(evalShowIf);
  evalShowIf();
}

export function onShow() {}
