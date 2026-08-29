// ============================================================
// 可复用组件: 页签、画廊、日志、图片编辑器
// ============================================================
import { $, $$, el, clear, toast, sliderRow, enableDrop, edgeScroll, imageDropZone, wireAutocomplete, wildcardsButton } from "./ui.js";
import { imageUrl, uploadFiles, get } from "./api.js";

// ---------------- 页签 ----------------

export function renderTabs(tabs, container) {
  clear(container);
  const bar = el("div", { class: "tabs" });
  const bodies = [];
  tabs.forEach((tab, i) => {
    const btn = el("button", { class: "tab-btn" + (i === 0 ? " active" : ""), text: tab.title });
    const body = el("div", { class: "tab-content" + (i === 0 ? " active" : "") });
    btn.addEventListener("click", () => {
      $$(".tab-btn", bar).forEach((b) => b.classList.remove("active"));
      bodies.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      body.classList.add("active");
      if (tab.onShow) tab.onShow(body);
    });
    bar.append(btn);
    bodies.push(body);
    if (tab.render) tab.render(body);
  });
  container.append(edgeScroll(bar), ...bodies);
}

// ---------------- 全窗口看图 (Lightbox) ----------------

let _closeLightbox = null;

export function openLightbox(src, name = "") {
  if (_closeLightbox) _closeLightbox();   // 已有灯箱时先关闭, 避免叠加 (快速连点/双击会触发多次)
  const overlay = el("div", { class: "lightbox" });
  let zoomed = false;
  const img = el("img", { src: src, alt: name });
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomed = !zoomed;
    overlay.classList.toggle("zoomed", zoomed);
  });
  const close = () => { _closeLightbox = null; document.removeEventListener("keydown", onKey); overlay.remove(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.append(
    el("button", { class: "lightbox-close", text: "✖", onclick: (e) => { e.stopPropagation(); close(); } }),
    name ? el("div", { class: "lightbox-name", text: name }) : null,
    img,
  );
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  _closeLightbox = close;
}

// ---------------- 画廊 ----------------

export function gallery(container, images, { onSelect, zoomOnClick = false } = {}) {
  clear(container);
  container.classList.add("gallery");
  ["count-1", "count-2", "count-3", "count-4"].forEach((c) => container.classList.remove(c));
  const n = images ? images.length : 0;
  if (n >= 1 && n <= 4) container.classList.add("count-" + n);
  if (!images || images.length === 0) {
    container.append(el("div", { class: "gallery-empty", text: "🌸 还没有图片, 去生成一张吧~" }));
    return;
  }
  images.forEach((path) => {
    const name = path.split("/").pop();
    const viewBtn = el("div", { class: "gallery-zoom", title: "全窗口查看" }, [el("span", { text: "🔍" })]);
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLightbox(imageUrl(path), name);
    });
    const item = el("div", { class: "gallery-item" }, [
      el("img", { src: imageUrl(path), loading: "lazy", alt: name }),
      el("div", { class: "gallery-name", text: name }),
      viewBtn,
    ]);
    item.addEventListener("click", () => {
      $$(".gallery-item", container).forEach((x) => x.classList.remove("selected"));
      item.classList.add("selected");
      if (onSelect) onSelect(path);
      // zoomOnClick: 单击即放大展示 (图片生成输出区), 关闭放大后图片保持选中
      if (zoomOnClick) openLightbox(imageUrl(path), name);
    });
    item.addEventListener("dblclick", () => openLightbox(imageUrl(path), name));
    container.append(item);
  });
}

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

  // ---- 系统状态行: 系统版本 + CPU/内存/GPU 占用 ----
  // 刷新间隔 10 秒: 采样 (尤其 nvidia-smi 子进程) 有开销, 不宜过短
  const sysStats = el("span", { class: "sys-stats", id: "sys-stats", title: "系统资源占用 (每 1 秒刷新)" });
  document.querySelector(".log-header span")?.after(sysStats);
  const STATS_MS = 1 * 1000;
  const fmtGb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + "G" : Math.round(mb) + "M");
  async function refreshStats() {
    try {
      const d = await get("/api/system/stats");
      const parts = [d.os, `💻 CPU ${Math.round(d.cpu_percent)}%`,
        `🧠 内存 ${Math.round(d.mem_percent)}% (${d.mem_used_gb}/${d.mem_total_gb}G)`];
      if (d.gpu) parts.push(`🎮 GPU ${Math.round(d.gpu.util)}% (${fmtGb(d.gpu.mem_used)}/${fmtGb(d.gpu.mem_total)})`);
      sysStats.textContent = parts.join(" │ ");
      sysStats.title = (d.gpu ? `GPU: ${d.gpu.name}\n` : "") +
        `CPU ${d.cpu_cores} 线程 · 内存 ${d.mem_total_gb}G · ${d.arch}\n每 ${STATS_MS / 1000} 秒自动刷新`;
    } catch { /* 读取失败静默, 保留上一次内容 */ }
  }
  refreshStats();
  setInterval(refreshStats, STATS_MS);

  // 全量日志缓冲: 导出时包含启动至今的所有日志 (DOM 只保留最近若干条)
  const logBuffer = [];
  const DOM_MAX = 2000;

  function addLine(level, message, exception) {
    const time = new Date().toLocaleTimeString();
    logBuffer.push({ time, level, message: message ?? "", exception: exception || "" });
    if (count > DOM_MAX) {
      while (body.firstChild && count > DOM_MAX - 500) {
        body.removeChild(body.firstChild);
        count--;
      }
    }
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
    body.append(line);
    count++;
    if (autoScrollInput.checked) body.scrollTop = body.scrollHeight;
  }

  document.getElementById("log-clear").addEventListener("click", () => { clear(body); count = 0; });
  document.getElementById("log-toggle").addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    document.getElementById("log-toggle").textContent = collapsed ? "展开" : "收起";
    // 展开时保证足够高度能看到日志 (避免拖拽后残留过小高度)
    if (!collapsed && panel.offsetHeight < 150) {
      panel.style.height = "220px";
      localStorage.setItem("anr-log-height", "220");
    }
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
    const head = `Auto-NovelAI-WebUI 运行日志\n共 ${logBuffer.length} 条 | 导出时间: ${new Date().toLocaleString()}\n${"=".repeat(60)}\n\n`;
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

// ---------------- 图片编辑器 (图生图/重绘) ----------------

export function imageEditor(container, { onChange } = {}) {
  clear(container);
  const state = {
    mode: "图生图",
    brushColor: "#000000",
    brushSize: 24,
    tool: "brush",
    drawing: false,
    image: null,
  };

  const wrap = el("div", { class: "img-editor-wrap" });

  // 画布区: 只显示合成画布 (背景 + 遮罩预览), 其余为工作层
  const canvasWrap = el("div", { class: "editor-canvas-wrap" });
  const bgCanvas = el("canvas", { style: "display:none;" });
  const maskCanvas = el("canvas", { style: "display:none;" });
  const doodleCanvas = el("canvas", { style: "display:none;" });
  const compositeCanvas = el("canvas");
  const ctx = (c) => c.getContext("2d");
  const placeholder = el("div", { class: "editor-placeholder", html: "🖼️ 上传基础图片后开始编辑<br/><span class='muted'>支持图生图 / 局部重绘 / 涂鸦重绘</span>" });
  canvasWrap.append(placeholder);

  function setupCanvases(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    [bgCanvas, maskCanvas, doodleCanvas, compositeCanvas].forEach((c) => {
      c.width = w;
      c.height = h;
    });
    ctx(bgCanvas).drawImage(img, 0, 0);
    ctx(maskCanvas).clearRect(0, 0, w, h);
    ctx(doodleCanvas).clearRect(0, 0, w, h);
    clear(canvasWrap);
    canvasWrap.append(compositeCanvas, removeOverlayBtn);
    renderComposite();
    updateRemoveBtn();
  }

  function renderComposite() {
    const w = bgCanvas.width, h = bgCanvas.height;
    ctx(compositeCanvas).clearRect(0, 0, w, h);
    ctx(compositeCanvas).drawImage(bgCanvas, 0, 0);
    if (state.mode === "涂鸦重绘") {
      ctx(compositeCanvas).drawImage(doodleCanvas, 0, 0);
    } else if (state.mode === "局部重绘") {
      ctx(compositeCanvas).globalAlpha = 0.4;
      ctx(compositeCanvas).drawImage(maskCanvas, 0, 0);
      ctx(compositeCanvas).globalAlpha = 1;
    }
  }

  function drawStroke(canvas, x, y) {
    const c = ctx(canvas);
    c.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
    c.strokeStyle = state.tool === "eraser" ? "#000" : state.brushColor;
    c.lineWidth = state.brushSize;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 0.01, y + 0.01);
    c.stroke();
  }

  function getPos(e) {
    const rect = compositeCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (compositeCanvas.width / rect.width),
      y: (e.clientY - rect.top) * (compositeCanvas.height / rect.height),
    };
  }

  function startStroke(e) {
    if (!state.image) return;
    e.preventDefault();
    state.drawing = true;
    const { x, y } = getPos(e);
    const target = state.mode === "涂鸦重绘" ? doodleCanvas : maskCanvas;
    drawStroke(target, x, y);
    renderComposite();
  }

  function moveStroke(e) {
    if (!state.drawing || !state.image) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    const target = state.mode === "涂鸦重绘" ? doodleCanvas : maskCanvas;
    const c = ctx(target);
    c.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
    c.strokeStyle = state.tool === "eraser" ? "#000" : state.brushColor;
    c.lineWidth = state.brushSize;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.lineTo(x, y);
    c.stroke();
    renderComposite();
  }

  function endStroke() { state.drawing = false; }

  compositeCanvas.addEventListener("pointerdown", startStroke);
  compositeCanvas.addEventListener("pointermove", moveStroke);
  compositeCanvas.addEventListener("pointerup", endStroke);
  compositeCanvas.addEventListener("pointerleave", endStroke);

  // ---- 工具面板 (分区布局: 上传 / 模式 / 画笔 / 操作) ----
  const tools = el("div", { class: "editor-tools" });

  const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none;" });
  // 空状态点击区域即可上传; 拖拽上传保留; 右上角 ✖ 移除图片
  placeholder.style.cursor = "pointer";
  placeholder.addEventListener("click", () => fileInput.click());
  // 统一加载: 选择/拖入都整体替换当前图片
  function loadFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const file = fileList[0];
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.image = img;
      setupCanvases(img);
      updateRemoveBtn();
      if (onChange) onChange();
      toast("基础图片已加载 🌸");
    };
    img.src = url;
    fileInput.value = "";
  }
  fileInput.addEventListener("change", () => loadFiles(fileInput.files));
  enableDrop(canvasWrap, { onFiles: (files) => loadFiles(files) });

  // 右上角移除图片按钮 (仅在加载图片后显示)
  const removeOverlayBtn = el("button", { class: "editor-remove-btn", text: "✖", style: "display:none;" });
  removeOverlayBtn.title = "移除图片并清空绘制";
  removeOverlayBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearImage();
  });

  function updateRemoveBtn() {
    removeOverlayBtn.style.display = state.image ? "flex" : "none";
  }

  function clearImage() {
    state.image = null;
    [bgCanvas, maskCanvas, doodleCanvas].forEach((c) => ctx(c).clearRect(0, 0, c.width, c.height));
    clear(canvasWrap);
    canvasWrap.append(placeholder, removeOverlayBtn);
    updateRemoveBtn();
    if (onChange) onChange();
  }

  // 分段选择器 (等宽胶囊组)
  function segGroup(options, cur, onPick) {
    const group = el("div", { class: "opt-group ed-seg" });
    options.forEach((m) => {
      const item = el("label", { class: "opt-item" + (m === cur ? " selected" : ""), text: m });
      item.addEventListener("click", () => {
        $$(".opt-item", group).forEach((x) => x.classList.remove("selected"));
        item.classList.add("selected");
        onPick(m);
      });
      group.append(item);
    });
    return group;
  }

  // 模式分段
  let brushSec = null;
  const modeGroup = segGroup(["图生图", "局部重绘", "涂鸦重绘"], state.mode, (m) => {
    state.mode = m;
    renderComposite();
    updateBrushSection();
    if (onChange) onChange();
  });

  // 画笔/橡皮分段 + 大小滑条 + 颜色 (与 ANR 一致: 局部重绘只画遮罩不需要颜色, 涂鸦重绘需要)
  const toolGroup = segGroup(["🖌️ 画笔", "🧽 橡皮"], "🖌️ 画笔", (m) => {
    state.tool = m.includes("橡皮") ? "eraser" : "brush";
  });
  const colorInput = el("input", { type: "color", value: state.brushColor });
  colorInput.addEventListener("input", () => { state.brushColor = colorInput.value; });
  const colorRow = el("div", { class: "ed-color-row" }, [el("span", { class: "ed-color-label", text: "颜色" }), colorInput]);
  // 大小滑条: 同时控制画笔和橡皮的粗细
  const sizeCtl = sliderRow({ min: 4, max: 120, step: 1, value: state.brushSize });
  sizeCtl.input.addEventListener("input", () => { state.brushSize = sizeCtl.get(); });
  sizeCtl.node.style.flex = "1";
  sizeCtl.node.style.minWidth = "0";
  brushSec = el("div", { class: "ed-sec ed-brush-sec" }, [
    el("div", { class: "ed-sec-title", text: "🖍️ 画笔 / 橡皮" }),
    toolGroup,
    el("div", { class: "ed-size-row" }, [el("span", { class: "ed-color-label", text: "大小" }), sizeCtl.node]),
    colorRow,
  ]);
  function updateBrushSection() {
    // 图生图不需要绘制, 整块隐藏; 局部重绘不需要画笔颜色, 仅涂鸦重绘显示颜色
    brushSec.classList.toggle("hidden", state.mode === "图生图");
    colorRow.classList.toggle("hidden", state.mode !== "涂鸦重绘");
  }

  const clearBtn = el("button", { class: "btn btn-sm btn-ghost", text: "🗑️ 清空绘制" });
  clearBtn.addEventListener("click", () => {
    ctx(maskCanvas).clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx(doodleCanvas).clearRect(0, 0, doodleCanvas.width, doodleCanvas.height);
    renderComposite();
  });

  // 全屏编辑: 使用覆盖整个页面的遮罩层 (不依赖 Fullscreen API, 更可靠)
  const fullscreenBtn = el("button", { class: "btn btn-sm", text: "⛶ 全屏编辑" });
  let overlay = null;

  function closeFullscreen() {
    if (!overlay) return;
    // 把画布和工具栏移回原位
    wrap.append(canvasWrap, tools);
    overlay.remove();
    overlay = null;
    document.body.style.overflow = "";
  }

  function openFullscreen() {
    if (overlay) return;
    overlay = el("div", { class: "editor-overlay" });
    const header = el("div", { class: "overlay-header" }, [
      el("span", { class: "overlay-title", text: "🎨 全屏编辑" }),
      el("button", { class: "btn btn-sm btn-danger", text: "✖ 关闭", onclick: closeFullscreen }),
    ]);
    const bodyRow = el("div", { class: "overlay-body" });
    overlay.append(header, bodyRow);
    // 把画布和工具栏移入遮罩层
    bodyRow.append(canvasWrap, tools);
    document.body.append(overlay);
    document.body.style.overflow = "hidden";
  }

  fullscreenBtn.addEventListener("click", () => {
    if (overlay) closeFullscreen(); else openFullscreen();
  });

  // Esc 关闭
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFullscreen();
  });

  updateBrushSection();
  updateRemoveBtn();
  tools.append(
    el("div", { class: "ed-sec" }, [el("div", { class: "ed-sec-title", text: "🎨 重绘模式" }), modeGroup]),
    brushSec,
    el("div", { class: "ed-actions" }, [clearBtn, fullscreenBtn]),
  );
  wrap.append(canvasWrap, tools);
  container.append(wrap);

  // 导出: 上传三张图, 返回路径
  async function exportImages() {
    if (!state.image) return null;
    const blob = (c) => new Promise((resolve) => c.toBlob(resolve, "image/png"));
    const bgBlob = await blob(bgCanvas);
    const maskBlob = await blob(maskCanvas);
    const compBlob = await blob(compositeCanvas);
    const files = await uploadFiles([
      new File([bgBlob], "background.png"),
      new File([maskBlob], "mask.png"),
      new File([compBlob], "composite.png"),
    ]);
    const get = (name) => (files.find((f) => f.name === name) || {}).path;
    return {
      enabled: true,
      mode: state.mode,
      background_path: get("background.png"),
      mask_path: get("mask.png"),
      composite_path: get("composite.png"),
    };
  }

  // 从路径加载图片 (用于"发送到图生图")
  async function loadImage(path) {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      setupCanvases(img);
      if (onChange) onChange();
      toast("已加载到图生图编辑器 🎨", "success");
    };
    img.onerror = () => toast("图片加载失败", "error");
    const { imageUrl } = await import("./api.js");
    img.src = imageUrl(path);
  }

  return {
    node: wrap,
    getMode: () => state.mode,
    hasImage: () => !!state.image,
    exportImages,
    loadImage,
  };
}

// ---------------- 动态角色列表 ----------------

export function roleList(container, {
  title,
  fields, // [{id, label, type, options, default, min, max, step, rows}]
  grid = null, // 可选布局: 二维数组按单元格放字段 id, 空值/null 为占位 (默认按顺序流入 grid-2)
  min = 0,
  max = 32,
  maxCountMsg,
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
      case "position": {
        // 位置: 网格坐标 (A1-E5) 或 自由坐标 (X/Y 0-1)
        const select = el("select", {}, (f.options || []).map((o) => el("option", { value: o, text: o })));
        select.value = f.default ?? f.options?.[0] ?? "A1";
        const xInput = el("input", { type: "number", min: 0, max: 1, step: 0.01, value: "0.5" });
        const yInput = el("input", { type: "number", min: 0, max: 1, step: 0.01, value: "0.5" });
        const gridWrap = el("div", { class: "field" }, [el("label", { text: f.label }), select]);
        const freeWrap = el("div", { class: "field" }, [
          el("label", { text: "📍 位置 X/Y (0-1)" }),
          el("div", { style: "display:flex;gap:6px;" }, [xInput, yInput]),
        ]);
        let mode = "grid";
        function applyMode(m) {
          mode = m;
          gridWrap.style.display = m === "grid" ? "" : "none";
          freeWrap.style.display = m === "free" ? "" : "none";
        }
        applyMode("grid");
        return {
          node: el("div", {}, [gridWrap, freeWrap]),
          get: () => {
            if (mode === "free") {
              const x = parseFloat(xInput.value), y = parseFloat(yInput.value);
              if (!Number.isFinite(x) || !Number.isFinite(y)) return "0.50,0.50";
              return `${x.toFixed(2)},${y.toFixed(2)}`;
            }
            return select.value;
          },
          set: (v) => {
            if (v && String(v).includes(",")) {
              const [x, y] = String(v).split(",").map(parseFloat);
              if (Number.isFinite(x) && Number.isFinite(y)) { xInput.value = String(x); yInput.value = String(y); applyMode("free"); return; }
            }
            if (v && (f.options || []).includes(String(v))) select.value = v;
          },
          applyMode,
        };
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
    fields.forEach((f) => {
      const ctrl = buildControl(f);
      controls[f.id] = ctrl;
    });
    if (grid && grid.length) {
      // 显式布局: [{id, r, c, rs?}] — r/c 为网格行列, rs 为跨行数
      grid.forEach((cell) => {
        if (!cell || typeof cell !== "object" || !cell.id) return;
        const ctrl = controls[cell.id];
        if (!ctrl) return;
        ctrl.node.style.gridRow = cell.r + (cell.rs && cell.rs > 1 ? " / span " + cell.rs : "");
        ctrl.node.style.gridColumn = String(cell.c);
        body.append(ctrl.node);
      });
    } else {
      fields.forEach((f) => body.append(controls[f.id].node));
    }
    card.append(head, body);
    items.push({ card, controls });
    return card;
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

  function render() {
    // 先保存当前值, 重建后恢复, 避免添加/删除/限制数量时已填内容丢失
    const saved = snapshot();
    clear(container);
    items.length = 0; // 每次重建时清空, 防止重复累积
    const notify = () => { if (onChange) onChange(state.count); };
    const btnRow = el("div", { style: "display:flex;gap:8px;margin-bottom:10px;" }, [
      el("button", { class: "btn btn-sm", text: "➕ 添加", onclick: () => { if (state.count < state.max) { state.count++; render(); notify(); } else toast(maxCountMsg || ("最多 " + state.max + " 个"), "warning"); } }),
      el("button", { class: "btn btn-sm btn-ghost", text: "➖ 删除", onclick: () => { if (state.count > min) { state.count--; render(); notify(); } } }),
    ]);
    container.append(btnRow);
    for (let i = 0; i < state.count; i++) {
      container.append(createItem());
    }
    restore(saved);
  }

  render();

  return {
    positionMode: (m) => items.forEach((it) => {
      const ctrl = it.controls["position"];
      if (ctrl && ctrl.applyMode) ctrl.applyMode(m);
    }),
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
  };
}
