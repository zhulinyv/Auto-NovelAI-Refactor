// ============================================================
// 插件视图: 插件商店 + 单个插件的独立页面
// ============================================================
import { $, $$, el, clear, toast, bus, makeField } from "../ui.js";
import { post, imageUrl, openDir } from "../api.js";
import { gallery } from "../components.js";

let S = null;

// 任务事件 (模块级注册一次, 避免重复导航后多次绑定)
bus.on("job:event", (ev) => {
  if (ev.name !== "preview") return;
  const target = document.getElementById(`plugin-preview-${ev.id}`);
  if (!target) return;
  const p = target.querySelector(".preview-prompt");
  if (p && ev.prompt !== undefined) p.textContent = ev.prompt;
  const img = target.querySelector("img");
  if (img && ev.image) { img.src = imageUrl(ev.image); target.style.display = ""; }
});
bus.on("job:done", (ev) => {
  if (!ev.name?.startsWith("plugin:")) return;
  const key = ev.name.split("/")[1];
  const target = document.getElementById(`plugin-output-${key}`);
  const msg = ev.message || ev.text || "";
  if (msg) {
    if (target) {
      const info = target.querySelector(".info-box");
      if (info) info.textContent = "✅ " + msg;
    } else {
      // 无输出区 (如配置保存) 时用右上角通知展示结果
      toast("✅ " + msg, "success");
    }
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
            try {
              const res = await openDir(btn.dataset.dir || "");
              toast("已打开目录: " + res.path, "success");
            } catch (e) {
              toast("打开目录失败: " + e.message, "error");
            }
          });
          box.append(btn);
        }
        btn.dataset.dir = ev.dir;
      }
    }
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
}

function renderPanel(plugin, panel, body) {
  const controls = {};
  const wrap = el("div", { class: "grid grid-2" });

  // 字段 (实底卡片)
  const fieldBox = el("div", { class: "card", style: "margin:0;" });
  // 表单值持久化: 变更后延迟保存到后端 (换浏览器/刷新仍保留)
  let saveTimer = null;
  const saveValues = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const payload = {};
      panel.fields.forEach((f) => { payload[f.id] = controls[f.id]?.getValue(); });
      try { await post(`/api/plugin/${plugin.name}/${panel.id}/values`, { values: payload }); } catch {}
    }, 400);
  };
  panel.fields.forEach((f) => {
    const ctrl = makeField(f, {});
    controls[f.id] = ctrl;
    fieldBox.append(ctrl.node);
    // 原生控件: input / change 时保存
    ctrl.node.querySelectorAll("input, select, textarea").forEach((el_) => {
      el_.addEventListener("input", saveValues);
      el_.addEventListener("change", saveValues);
    });
    // radio / checkbox_group: 点击选项时保存
    ctrl.node.querySelectorAll(".opt-item").forEach((item) => {
      item.addEventListener("click", saveValues);
    });
  });
  wrap.append(fieldBox);

  // 输出区: 每个动作一个 (show_output=false 时不渲染, 结果用右上角通知展示)
  const outputCol = el("div", { style: "min-width:0;" });
  const outputMap = {};
  if (panel.show_output !== false) {
    panel.actions.forEach((action) => {
      const outBox = el("div", { id: `plugin-output-${action.id}`, class: "card", style: "margin:0 0 12px 0;" }, [
        el("div", { class: "card-title", text: "📤 " + (action.label || "输出") }),
      ]);
      const gal = el("div", { class: "gallery" });
      const previewImg = el("img", { class: "preview-img", style: "display:none;max-width:100%;max-height:360px;border-radius:12px;border:2px solid var(--border);" });
      const infoBox = el("div", { class: "info-box" });
      const outActions = el("div", { class: "plugin-out-actions" });
      outBox.append(gal, previewImg, infoBox, outActions);
      outputCol.append(outBox);
      outputMap[action.id] = { gal, previewImg, infoBox, outActions };
    });
  }
  wrap.append(outputCol);
  body.append(wrap);

  // 恢复上次使用的表单值 (服务器端持久化, 换浏览器仍生效)
  (async () => {
    try {
      const res = await fetch(`/api/plugin/${plugin.name}/${panel.id}/values`);
      const data = await res.json();
      const saved = data.values || {};
      panel.fields.forEach((f) => {
        if (saved[f.id] !== undefined && controls[f.id]) {
          try { controls[f.id].setValue(saved[f.id]); } catch {}
        }
      });
      evalShowIf();
    } catch {}
  })();

  // 动作按钮
  const actRow = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;" });
  panel.actions.forEach((action) => {
    const btn = el("button", { class: "btn btn-primary", text: "▶️ " + action.label });
    btn.addEventListener("click", async () => {
      const payload = {};
      for (const id of action.inputs || []) payload[id] = controls[id]?.getValue();
      const out = outputMap[action.id];
      btn.disabled = true;
      if (out) out.infoBox.textContent = "🚀 正在执行...";
      try {
        const res = await post(`/api/plugin/${plugin.name}/${panel.id}/${action.id}`, { values: payload });
        // 实时预览容器 (供生成器类动作逐张推送预览, 如随机画风)
        const previewId = `plugin-preview-${res.job_id}`;
        if (!document.getElementById(previewId)) {
          const h = el("div", { id: previewId, class: "hidden" });
          h.append(
            el("img", { style: "max-width:100%;max-height:360px;border-radius:12px;border:2px solid var(--border);" }),
            el("div", { class: "muted preview-prompt", style: "margin-top:8px;white-space:pre-wrap;" }),
          );
          body.append(h);
        }
        toast(`任务已启动: ${res.job_id}`, "success");
      } catch (e) {
        if (out) out.infoBox.textContent = "❌ " + e.message;
        toast(e.message, "error");
        btn.disabled = false;
      }
      setTimeout(() => { btn.disabled = false; }, 2000);
    });
    actRow.append(btn);
  });
  const stopBtn = el("button", { class: "btn btn-danger", text: "⏹ 停止" });
  stopBtn.addEventListener("click", async () => { try { await post("/api/stop"); } catch {} });
  actRow.append(stopBtn);
  body.prepend(el("div", { class: "view-head" }, [actRow]));

  // show_if 条件显示
  function evalShowIf() {
    panel.fields.forEach((f) => {
      const ctrl = controls[f.id];
      if (!ctrl || !f.show_if) return;
      const rule = f.show_if;
      let visible = true;
      if (rule.field) {
        const other = controls[rule.field]?.getValue();
        if (rule.equals !== undefined) visible = other === rule.equals;
        if (rule.contains !== undefined) visible = Array.isArray(other) ? other.includes(rule.contains) : String(other || "").includes(rule.contains);
        if (rule.not_equals !== undefined) visible = other !== rule.not_equals;
      }
      ctrl.node.style.display = visible ? "" : "none";
    });
  }
  panel.fields.forEach((f) => {
    const ctrl = controls[f.id];
    if (!ctrl) return;
    // select / text / slider 等原生控件
    const fieldInput = ctrl.node.querySelector("input,select,textarea");
    if (fieldInput) {
      fieldInput.addEventListener("change", evalShowIf);
      fieldInput.addEventListener("input", evalShowIf);
    }
    // radio / checkbox_group 没有原生 input, 点击选项时也要触发条件显示
    ctrl.node.querySelectorAll(".opt-item").forEach((item) => {
      item.addEventListener("click", evalShowIf);
    });
  });
  evalShowIf();
}

export function onShow() {}
