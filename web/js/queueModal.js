// ============================================================
// 生图队列浮动窗口: 查看通道状态 / 排队任务, 取消 / 调整顺序 / 停止
// 数据来源: SSE queue:update 事件 (app.js 转发到 bus), 打开时主动拉取一次
// ============================================================
import { get, post } from "./api.js";
import { bus, el, toast } from "./ui.js";

let snapshot = null;      // 最近一次队列快照
let overlay = null;       // 当前弹窗 DOM
let isOpen = false;

const STATUS_TEXT = {
  pending: "⏳ 排队中",
  running: "▶️ 生成中",
  done: "✅ 完成",
  failed: "❌ 失败",
  cancelled: "🚫 已取消",
};

function fmtAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return s + " 秒前";
  if (s < 3600) return Math.round(s / 60) + " 分钟前";
  return Math.round(s / 3600) + " 小时前";
}

// ---------------- 徽标 ----------------

export function updateBadge(q) {
  const badge = document.getElementById("queue-badge");
  if (!badge) return;
  const tasks = q?.tasks || [];
  const pending = tasks.filter((t) => t.status === "pending").length;
  const running = tasks.filter((t) => t.status === "running").length;
  const total = pending + running;
  badge.textContent = String(total);
  badge.classList.toggle("hidden", total === 0);
  badge.classList.toggle("has-running", running > 0);
}

// ---------------- 通道状态行 ----------------

function laneNode(w) {
  const statusMap = {
    running: ["🟢", "生成中"],
    cooling: ["❄️", `冷却中 ${(w.cooldown_left || 0).toFixed(1)}s`],
    idle: ["💤", "空闲"],
  };
  const [icon, text] = statusMap[w.status] || ["·", w.status];
  const runningTask = (snapshot?.tasks || []).find((t) => t.id === w.task_id && t.status === "running");
  const desc = runningTask ? `: ${runningTask.label}` : "";
  return el("div", { class: `queue-lane lane-${w.status}` }, [
    el("span", { class: "queue-lane-icon", text: icon }),
    el("span", { class: "queue-lane-name", text: `通道 ${w.index + 1}` }),
    el("span", { class: "queue-lane-token", text: w.token || "未配置 Token" }),
    el("span", { class: "queue-lane-status", text: text + desc }),
  ]);
}

// ---------------- 任务行 ----------------

function pendingTaskNode(t, idx, total) {
  const btns = [];
  btns.push(el("button", { class: "qbtn", text: "⬆", title: "上移", disabled: idx === 0 ? "true" : null, onclick: () => reorder(t.id, "up") }));
  btns.push(el("button", { class: "qbtn", text: "⬇", title: "下移", disabled: idx === total - 1 ? "true" : null, onclick: () => reorder(t.id, "down") }));
  btns.push(el("button", { class: "qbtn qbtn-top", text: "⤒", title: "移到最前", disabled: idx === 0 ? "true" : null, onclick: () => reorder(t.id, "top") }));
  btns.push(el("button", { class: "qbtn qbtn-danger", text: "✖", title: "取消任务", onclick: () => cancelTask(t.id) }));
  return el("div", { class: "queue-task" }, [
    el("span", { class: "queue-task-pos", text: String(idx + 1) }),
    el("div", { class: "queue-task-main" }, [
      el("div", { class: "queue-task-label", text: t.label, title: t.label }),
      el("div", { class: "queue-task-meta", text: `${t.name} · 已等待 ${Math.round(t.waited || 0)} 秒` }),
    ]),
    el("div", { class: "queue-task-btns" }, btns),
  ]);
}

function runningTaskNode(t) {
  return el("div", { class: "queue-task running" }, [
    el("span", { class: "queue-task-pos", text: "▶" }),
    el("div", { class: "queue-task-main" }, [
      el("div", { class: "queue-task-label", text: t.label, title: t.label }),
      el("div", { class: "queue-task-meta", text: `${t.name} · 通道 ${(t.worker ?? 0) + 1} · ${fmtAgo(t.started_at)}开始` }),
    ]),
    el("div", { class: "queue-task-btns" }, [
      el("button", { class: "qbtn qbtn-danger", text: "⏹", title: "停止该任务", onclick: () => stopTask(t.id) }),
    ]),
  ]);
}

function historyNode(t) {
  const icon = STATUS_TEXT[t.status] || t.status;
  const meta = [t.name, fmtAgo(t.finished_at)];
  if (t.error) meta.push(String(t.error).slice(0, 80));
  return el("div", { class: `queue-task history st-${t.status}` }, [
    el("span", { class: "queue-task-pos", text: "·" }),
    el("div", { class: "queue-task-main" }, [
      el("div", { class: "queue-task-label", text: t.label, title: t.label }),
      el("div", { class: "queue-task-meta", text: `${icon} · ${meta.join(" · ")}` }),
    ]),
  ]);
}

// ---------------- 渲染 ----------------

function render() {
  if (!overlay || !isOpen) return;
  const body = overlay.querySelector(".queue-modal-body");
  if (!body) return;
  const q = snapshot || { workers: [], tasks: [], history: [], worker_count: 0, token_count: 0 };

  body.innerHTML = "";
  body.append(
    el("div", { class: "queue-section-title", text: `🛤 执行通道 (Token ${q.token_count ?? 0} 个 → 通道 ${q.worker_count ?? 0} 条)` }),
  );
  if ((q.workers || []).length) {
    const lanes = el("div", { class: "queue-lanes" });
    q.workers.forEach((w) => lanes.append(laneNode(w)));
    body.append(lanes);
  } else {
    body.append(el("div", { class: "muted", style: "padding:4px 2px 8px;", text: "尚未启动通道" }));
  }

  const tasks = q.tasks || [];
  const running = tasks.filter((t) => t.status === "running");
  const pending = tasks.filter((t) => t.status === "pending");

  body.append(el("div", { class: "queue-section-title", text: `⚙️ 运行中 (${running.length}) / 排队 (${pending.length})` }));
  if (!running.length && !pending.length) {
    body.append(el("div", { class: "queue-empty", text: "队列为空 🌸 提交生图任务后会显示在这里" }));
  } else {
    running.forEach((t) => body.append(runningTaskNode(t)));
    pending.forEach((t, i) => body.append(pendingTaskNode(t, i, pending.length)));
    if (pending.length) {
      body.append(
        el("div", { class: "queue-clear-row" }, [
          el("button", { class: "btn btn-sm btn-danger", text: "🗑 清空排队", onclick: clearQueue }),
        ]),
      );
    }
  }

  const history = (q.history || []).slice(0, 8);
  if (history.length) {
    body.append(el("div", { class: "queue-section-title", text: "🕘 最近任务" }));
    history.forEach((t) => body.append(historyNode(t)));
  }
}

// ---------------- 操作 ----------------

async function apply(fn, okMsg) {
  try {
    const q = await fn();
    if (q && q.tasks) snapshot = q;
    updateBadge(snapshot);
    render();
    if (okMsg) toast(okMsg, "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

const reorder = (id, direction) => apply(() => post("/api/queue/reorder", { id, direction }));
const cancelTask = (id) => apply(() => post("/api/queue/cancel", { id }), "已取消该任务");
const stopTask = (id) => apply(() => post("/api/queue/stop", { id }), "已发送停止信号");
const clearQueue = () => apply(() => post("/api/queue/clear", {}), "已清空排队任务");
const refresh = () => apply(() => get("/api/queue"));

// ---------------- 弹窗开关 ----------------

function open() {
  if (isOpen) return;
  isOpen = true;
  overlay = el("div", { class: "queue-overlay" });
  const modal = el("div", { class: "card queue-modal" }, [
    el("div", { class: "card-title queue-modal-title" }, [
      document.createTextNode("🚦 生图队列"),
      el("div", { style: "margin-left:auto;display:flex;gap:6px;" }, [
        el("button", { class: "mini-btn", text: "刷新", onclick: refresh }),
        el("button", { class: "mini-btn", text: "✕", onclick: close }),
      ]),
    ]),
    el("div", { class: "queue-modal-body" }, [el("div", { class: "queue-empty", text: "加载中..." })]),
    el("div", { class: "queue-modal-foot muted", text: "仅 NovelAI 生成类任务进入队列 (生图 / 导演工具 / 插件生图); 每个任务完成后该通道独立冷却设置中的冷却时间" }),
  ]);
  overlay.append(modal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.body.append(overlay);
  refresh();
}

function close() {
  isOpen = false;
  overlay?.remove();
  overlay = null;
}

export function toggleQueueModal() {
  if (isOpen) close();
  else open();
}

// ---------------- 初始化 ----------------

export function initQueueModal(initialSnapshot) {
  if (initialSnapshot) snapshot = initialSnapshot;
  updateBadge(snapshot);
  document.getElementById("queue-toggle")?.addEventListener("click", toggleQueueModal);
  // SSE 队列快照: app.js 已把 ev 转发到 bus
  bus.on("queue:update", (q) => {
    snapshot = q;
    updateBadge(q);
    render();
  });
}
