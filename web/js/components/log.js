// ============================================================
// 运行日志面板: 自动滚动 / 高度拖拽 / 导出 / 系统状态行
// ============================================================
import { el, clear, toast } from "../ui.js";
import { get } from "../api.js";

// ---------------- 日志 ----------------

export function initLogConsole() {
  const body = document.getElementById("log-body");
  const panel = document.getElementById("log-panel");
  panel.classList.add("collapsed");
  let count = 0;
  // 自动滚动开关: 勾选后始终停留在最新日志位置, 取消后需手动滚动
  const autoScroll = el("label", { class: "log-autoscroll" }, [
    el("input", { type: "checkbox" }),
    document.createTextNode("自动滚动"),
  ]);
  const autoScrollInput = autoScroll.querySelector("input");
  autoScrollInput.checked = true;
  const logActions = document.querySelector(".log-actions");
  if (logActions) logActions.prepend(autoScroll);

  // ---- 系统状态行: 系统版本 + Python 版本 + CPU/内存/GPU 占用 ----
  // 刷新间隔 10 秒: GPU 那路要 fork nvidia-smi 子进程, 不宜过密;
  // 后端 _gpu_stats 另有 8 秒 TTL 去重 (server/routes/misc.py), 二者不要互相"对齐"成同一个数
  const sysStats = el("span", { class: "sys-stats", id: "sys-stats", title: "系统资源占用" });
  document.querySelector(".log-header span")?.after(sysStats);
  const STATS_MS = 10 * 1000;
  const fmtGb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + "G" : Math.round(mb) + "M");
  async function refreshStats() {
    try {
      const d = await get("/api/system/stats");
      // 顺序即「环境 → 资源」; 图标: 🖥️ 本机系统 / 🐍 Python / ⚙️ 处理器 / 🧠 记忆(内存) / 🎮 显卡
      const parts = [`🖥️ ${d.os}`, d.python && `🐍 Python ${d.python}`, `⚙️ CPU ${Math.round(d.cpu_percent)}%`,
        `🧠 内存 ${Math.round(d.mem_percent)}% (${d.mem_used_gb}/${d.mem_total_gb}G)`].filter(Boolean);
      if (d.gpu) parts.push(`🎮 GPU ${Math.round(d.gpu.util)}% (${fmtGb(d.gpu.mem_used)}/${fmtGb(d.gpu.mem_total)})`);
      sysStats.textContent = parts.join(" │ ");
      sysStats.title = (d.gpu ? `GPU: ${d.gpu.name}\n` : "") +
        `CPU ${d.cpu_cores} 线程 · 内存 ${d.mem_total_gb}G · ${d.arch}`;
    } catch { /* 读取失败静默, 保留上一次内容 */ }
  }
  refreshStats();
  // 只在页面可见时轮询: 日志面板收起或标签页在后台时不必每 10 秒打一次 /api/system/stats
  // (该接口会 fork nvidia-smi 子进程)。用 setTimeout 自调度, 每次检查可见性。
  let statsTimer = null;
  const scheduleStats = () => {
    statsTimer = setTimeout(() => {
      if (document.visibilityState === "visible") refreshStats();
      scheduleStats();
    }, STATS_MS);
  };
  scheduleStats();

  // 全量日志缓冲: 导出时包含启动至今的所有日志 (DOM 只保留最近若干条)
  const logBuffer = [];
  const DOM_MAX = 2000;

  // 日志按帧合批写 DOM。
  //
  // 生成一批图时后端会连续推几十上百条日志, 每条都是一次 body.append + 一次
  // 全量 MutationObserver 回调 (emoji 与 fancy-select 两个 observer 都挂在 body 上)。
  // 攒到下一帧一次性插入 DocumentFragment, 插入次数与重排次数都降到 1。
  let pendingLines = [];
  let flushScheduled = false;

  function flushLines() {
    flushScheduled = false;
    const lines = pendingLines;
    pendingLines = [];
    if (!lines.length) return;
    // 一次性批量裁掉超出部分: 原先逐条 removeChild 会在每条新日志上触发多次重排。
    if (count > DOM_MAX) {
      const drop = count - (DOM_MAX - 500);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < drop && body.firstChild; i++) frag.appendChild(body.firstChild);
      count -= drop;
      // 片段被丢弃即完成移除 (不插入文档, 直接释放)
    }
    const frag = document.createDocumentFragment();
    for (const line of lines) frag.append(line);
    body.append(frag);
    count += lines.length;
    if (autoScrollInput.checked) body.scrollTop = body.scrollHeight;
  }

  function addLine(level, message, exception) {
    const time = new Date().toLocaleTimeString();
    logBuffer.push({ time, level, message: message ?? "", exception: exception || "" });
    // 级别徽标 (与终端一致, 按级别着色)
    const badge = el("span", { class: `badge badge-${level || "info"}`, text: (level || "info").toUpperCase() });
    const line = el("div", { class: `log-line log-${level || "info"}` }, [
      el("span", { class: "t", text: time }),
      badge,
      document.createTextNode(message),
    ]);
    if (exception) {
      // 默认完整展开错误堆栈 (与终端显示一致); 点击可折叠
      const exc = el("div", { class: "log-exception", text: exception });
      exc.addEventListener("click", () => exc.classList.toggle("collapsed"));
      line.append(exc);
    }
    pendingLines.push(line);
    if (!flushScheduled) {
      flushScheduled = true;
      requestAnimationFrame(flushLines);
    }
  }

  document.getElementById("log-clear").addEventListener("click", () => {
    pendingLines = [];   // 还没插进 DOM 的也一并丢掉, 否则下一帧会被补回来
    clear(body);
    count = 0;
  });
  document.getElementById("log-toggle").addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    document.getElementById("log-toggle").textContent = collapsed ? "展开" : "收起";
    // 展开时保证足够高度能看到日志 (避免拖拽后残留过小高度)
    if (!collapsed && panel.offsetHeight < 150) {
      panel.style.height = "220px";
      localStorage.setItem("anr-log-height", "220");
    }
    // 展开时默认滚动到最新日志
    body.scrollTop = body.scrollHeight;
  });
  document.getElementById("log-toggle").textContent = "展开";

  // 拖拽调整日志面板高度
  const resizer = document.getElementById("log-resizer");
  if (resizer) {
    const savedH = localStorage.getItem("anr-log-height");
    if (savedH) panel.style.height = savedH + "px";
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      resizer.classList.add("active");
      // 拖拽时自动展开 (取消折叠)
      if (panel.classList.contains("collapsed")) {
        panel.classList.remove("collapsed");
        document.getElementById("log-toggle").textContent = "收起";
      }
      const startY = e.clientY;
      const startH = panel.offsetHeight;
      const onMove = (ev) => {
        const h = Math.min(window.innerHeight - 80, Math.max(80, startH + (startY - ev.clientY)));
        panel.style.height = h + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        resizer.classList.remove("active");
        localStorage.setItem("anr-log-height", String(panel.offsetHeight));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // 导出全部日志 (启动至今)
  document.getElementById("log-export").addEventListener("click", () => {
    const pad = (s, n) => String(s).padEnd(n, " ");
    const lines = logBuffer.map((l) => {
      let txt = `[${l.time}] [${pad(l.level.toUpperCase(), 7)}] ${l.message}`;
      if (l.exception) txt += "\n    " + l.exception.replace(/\n/g, "\n    ");
      return txt;
    });
    const head = `Auto-NovelAI-Refactor 运行日志\n共 ${logBuffer.length} 条 | 导出时间: ${new Date().toLocaleString()}\n${"=".repeat(60)}\n\n`;
    const blob = new Blob([head + lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `ANR-logs-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${logBuffer.length} 条日志 📜`, "success");
  });

  return { addLine };
}
