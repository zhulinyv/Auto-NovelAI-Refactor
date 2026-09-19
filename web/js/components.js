// ============================================================
// 可复用组件: 页签、画廊、日志、图片编辑器
// ============================================================
import { $, $$, el, clear, toast, sliderRow, enableDrop, edgeScroll, imageDropZone, wireAutocomplete, wildcardsButton } from "./ui.js";
import { imageUrl, uploadFiles, get } from "./api.js";
import {
  CROP_INSET_STEP,
  CROP_MAX_INSET,
  CROP_MIN_INSET,
  cropHandleCenter,
  cropHandleRadius,
  cropRectFromAnchor,
  cropRectFromDrag,
  cropRectFromMove,
  hitCropHandle,
  hitCropRect,
  innerCropRect as innerRect,
  normalizeCropRect as normalizeCrop,
} from "./cropRect.js";

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
  // 刷新间隔 10 秒: GPU 那路要 fork nvidia-smi 子进程, 不宜过密;
  // 后端 _gpu_stats 另有 8 秒 TTL 去重 (server/routes/misc.py), 二者不要互相"对齐"成同一个数
  const sysStats = el("span", { class: "sys-stats", id: "sys-stats", title: "系统资源占用" });
  document.querySelector(".log-header span")?.after(sysStats);
  const STATS_MS = 10 * 1000;
  const fmtGb = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + "G" : Math.round(mb) + "M");
  async function refreshStats() {
    try {
      const d = await get("/api/system/stats");
      const parts = [d.os, `💻 CPU ${Math.round(d.cpu_percent)}%`,
        `🧠 内存 ${Math.round(d.mem_percent)}% (${d.mem_used_gb}/${d.mem_total_gb}G)`];
      if (d.gpu) parts.push(`🎮 GPU ${Math.round(d.gpu.util)}% (${fmtGb(d.gpu.mem_used)}/${fmtGb(d.gpu.mem_total)})`);
      sysStats.textContent = parts.join(" │ ");
      sysStats.title = (d.gpu ? `GPU: ${d.gpu.name}\n` : "") +
        `CPU ${d.cpu_cores} 线程 · 内存 ${d.mem_total_gb}G · ${d.arch}`;
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

// ---------------- 图片编辑器 (图生图/重绘) ----------------

export function imageEditor(container, { onChange, onImageLoad } = {}) {
  clear(container);
  const state = {
    mode: "图生图",
    brushColor: "#000000",
    brushSize: 24,
    tool: "brush",
    drawing: false,
    image: null,
    cropMode: false,      // 裁剪重绘是否启用 (选中「▣ 裁剪」置位, 仅局部重绘模式生效)
    cropInset: CROP_MIN_INSET,   // 内侧框相对外侧框的内缩像素 a
    cropRect: null,       // 外侧选框 {x, y, w, h} (图像像素, 64 的倍数); 只能存在一个
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
    [bgCanvas, doodleCanvas, compositeCanvas].forEach((c) => {
      c.width = w;
      c.height = h;
    });
    // 蒙版画布: 原图 1/8 尺寸 (每个蒙版像素对应 8x8 图像块, 预览即为方格)
    maskCanvas.width = Math.max(1, Math.round(w / 8));
    maskCanvas.height = Math.max(1, Math.round(h / 8));
    ctx(bgCanvas).drawImage(img, 0, 0);
    ctx(maskCanvas).clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx(doodleCanvas).clearRect(0, 0, w, h);
    resetHistory();   // 换图后历史失效
    cropDrag = null;
    state.cropRect = null;   // 换图后旧选框的坐标不再成立
    clear(canvasWrap);
    canvasWrap.append(compositeCanvas, removeOverlayBtn);
    renderComposite();
    updateRemoveBtn();
    updateCropInfo();
  }

  function renderComposite() {
    const w = bgCanvas.width, h = bgCanvas.height;
    ctx(compositeCanvas).clearRect(0, 0, w, h);
    ctx(compositeCanvas).drawImage(bgCanvas, 0, 0);
    if (state.mode === "涂鸦重绘") {
      ctx(compositeCanvas).drawImage(doodleCanvas, 0, 0);
    } else if (state.mode === "局部重绘") {
      // 半透明方格蒙版预览: 关闭平滑插值放大 1/8 蒙版, 白色 8x8 方格即实际重绘区域
      const c = ctx(compositeCanvas);
      c.imageSmoothingEnabled = false;
      c.globalAlpha = 0.45;
      c.drawImage(maskCanvas, 0, 0, w, h);
      c.globalAlpha = 1;
      c.imageSmoothingEnabled = true;
    }
    // 裁剪重绘: 在最上层画"外框 + 内缩 a 的内框"的闭环选框
    if (isCropActive()) drawCropOverlay();
  }

  // 画布的显示尺寸一变 (进/出全屏编辑、拖侧边栏、改窗口大小), 之前画进位图的手柄半径就过期了:
  // 它是按"屏幕上恒定 10px ÷ 当时的缩放"换算出来的, 缩放变了它就不再是 10px ——
  // 进全屏会突然变大、在全屏里框的选框退出后又变得很小, 而且手柄的命中区 (按实时缩放算)
  // 也会和画出来的圆对不上。显示尺寸一变就重画一次, 两边始终一致。
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (!state.image || !compositeCanvas.isConnected || compositeCanvas.clientWidth <= 0) return;
      renderComposite();
    }).observe(compositeCanvas);
  }

  // ---- 裁剪重绘: 选框几何 (纯函数在 cropRect.js, 这里绑定当前内缩 a 与画布尺寸) ----

  /** 裁剪重绘是否生效: 开关打开且处于局部重绘模式 (涂鸦重绘/图生图不适用) */
  function isCropActive() {
    return state.cropMode && state.mode === "局部重绘";
  }

  /** 当前内缩 a 对应的内侧框 (外框四边各向内缩 a 像素) */
  const innerCropRect = (r) => innerRect(r, state.cropInset);

  /** 内侧框尺寸文案: 图像装不下整圈时内框会算出负数, 界面上一律按 0 报 */
  const innerSizeText = (inner) => `${Math.max(0, inner.w)} × ${Math.max(0, inner.h)}`;

  /** 外侧选框合法化 (64 对齐 = 裁剪块即生成分辨率 / 只限面积 1024×1024, 单边不限 / 内框不设最小区域) */
  const normalizeCropRect = (x, y, w, h) =>
    normalizeCrop({ x, y, w, h }, { inset: state.cropInset, imageW: bgCanvas.width, imageH: bgCanvas.height });

  /** 画布显示缩放 (屏幕 CSS 像素 / 图像像素): 手柄半径按它换算, 屏幕上大小恒定 */
  function canvasScale() {
    // 取布局宽度 (clientWidth) 而不是 getBoundingClientRect().width: 后者会把祖先的 CSS
    // transform 也算进去 (全屏遮罩的 pop-in 动画是 scale(0.98)), 会让刚进全屏那一帧算错半径。
    const w = compositeCanvas.clientWidth || compositeCanvas.getBoundingClientRect().width;
    return w > 0 && compositeCanvas.width > 0 ? w / compositeCanvas.width : 1;
  }

  /** 选框几何的统一上下文 (当前内缩 a + 画布尺寸) */
  const cropCtx = () => ({ inset: state.cropInset, imageW: bgCanvas.width, imageH: bgCanvas.height });

  /** 拖拽中的鼠标位置 -> 合法化后的外框 (反向拖拽时取左上角为起点) */
  const rectFromDrag = (d) => cropRectFromDrag(d.sx, d.sy, d.cx, d.cy, cropCtx());

  /** 拖右下角手柄 -> 合法化后的外框 (左上角锚定在 d.sx/d.sy; 指针越过锚点只收到最小尺寸, 不翻转) */
  const rectFromHandleDrag = (d) => cropRectFromAnchor({ x: d.sx, y: d.sy }, d.cx, d.cy, cropCtx());

  /** 拖选框内部 -> 平移整个外框 (尺寸与内缩都不变, 只跟着指针的位移走; 越界贴边) */
  const rectFromMoveDrag = (d) => cropRectFromMove(d.orig, d.cx - d.sx, d.cy - d.sy, cropCtx());

  /**
   * 已有的选框能否被直接拖动编辑 (平移 / 拖手柄缩放): 必须处于「▣ 裁剪」工具。
   * 画笔/橡皮下刻意不接管指针 —— 选框内部正是要涂抹的区域, 一旦在涂画时误触
   * 就会挪动选框并丢弃内侧框外的笔迹, 代价太大。
   */
  function canEditCropRect() {
    return isCropActive() && state.tool === "crop" && !!state.cropRect;
  }

  /** 右下角手柄是否可用: 与平移同一前提, 只是命中区域不同 */
  const canDragHandle = canEditCropRect;

  /** 指针 (图像坐标) 是否压在右下角调整手柄上 */
  function isOnCropHandle(x, y) {
    return canDragHandle() && hitCropHandle(state.cropRect, x, y, canvasScale());
  }

  /** 裁剪重绘选框: 外框之外压暗, 外框↔内框之间的闭环带标为"仅作重绘上下文", 内框虚线为画笔范围 */
  function drawCropOverlay() {
    const d = cropDrag;
    const rect = (d && d.rect) || state.cropRect;
    if (!rect) return;
    const inner = innerCropRect(rect);
    // 内框允许退化到 0×0 (a=32 时的最小外框 64×64): 那时整个外框都是"只作重绘上下文"的环带。
    // 外框压暗 / 实线 / 手柄必须照画 —— 否则缩到最小值就整个看不见, 连手柄都没了、再想拖大都点不到。
    const hasInner = inner.w > 0 && inner.h > 0;
    const c = ctx(compositeCanvas);
    const W = compositeCanvas.width, H = compositeCanvas.height;
    const lw = Math.max(1, W / 500);
    c.save();
    // 外框之外: 不参与重绘
    c.fillStyle = "rgba(0, 0, 0, 0.45)";
    c.beginPath();
    c.rect(0, 0, W, H);
    c.rect(rect.x, rect.y, rect.w, rect.h);
    c.fill("evenodd");
    // 外框 ↔ 内框: 蓝色的闭环带 (会被裁进重绘图片, 但画笔涂不到); 内框为空时整块都是环带
    c.fillStyle = "rgba(96, 200, 255, 0.18)";
    c.beginPath();
    c.rect(rect.x, rect.y, rect.w, rect.h);
    if (hasInner) c.rect(inner.x, inner.y, inner.w, inner.h);
    c.fill("evenodd");
    // 外框实线 (+ 内框虚线; 内框为空就没有内侧框可画)
    c.lineWidth = lw * 1.8;
    c.strokeStyle = "rgba(255, 255, 255, 0.95)";
    c.strokeRect(rect.x, rect.y, rect.w, rect.h);
    if (hasInner) {
      c.lineWidth = lw * 1.4;
      c.strokeStyle = "rgba(96, 200, 255, 0.95)";
      c.setLineDash([lw * 5, lw * 4]);
      c.strokeRect(inner.x, inner.y, inner.w, inner.h);
      c.setLineDash([]);   // 手柄的描边不能是虚线
    }
    // 右下角调整手柄 (拖它 = 固定左上角改宽高): 半径按缩放换算, 屏幕上始终同样大小
    if (state.tool === "crop") {
      const hc = cropHandleCenter(rect);
      const hr = cropHandleRadius(canvasScale());
      c.beginPath();
      c.arc(hc.x, hc.y, hr, 0, Math.PI * 2);
      c.fillStyle = "rgba(96, 200, 255, 0.95)";
      c.fill();
      c.lineWidth = lw * 1.6;
      c.strokeStyle = "rgba(255, 255, 255, 0.95)";
      c.stroke();
    }
    c.restore();
  }

  /** 笔画参数: 蒙版画在 1/8 小画布上 (固定灰色, 线宽换算到蒙版坐标系; 后端只按 alpha 识别蒙版, 颜色不影响语义); 涂鸦画在全尺寸画布上 (用户颜色) */
  function strokeSetup(canvas) {
    const c = ctx(canvas);
    const isMask = canvas === maskCanvas;
    c.globalCompositeOperation = state.tool === "eraser" ? "destination-out" : "source-over";
    c.strokeStyle = isMask ? "#808080" : state.brushColor;
    c.lineWidth = isMask ? Math.max(1, state.brushSize * (canvas.width / compositeCanvas.width)) : state.brushSize;
    c.lineCap = "round";
    c.lineJoin = "round";
    return c;
  }

  // ---- 裁剪重绘: 画笔/橡皮只能在内侧框内使用 (给蒙版画布挂一个裁剪区) ----
  // 裁剪区是 canvas 状态, 一次笔画期间一直有效, 所以用 save/restore 成对进出,
  // 避免多次 clip 叠加 (clip 是求交集, 反复调用会把可画区域越缩越小)。
  let maskClipCtx = null;

  function enterMaskClip() {
    if (maskClipCtx || !isCropActive() || !state.cropRect) return;
    const inner = innerCropRect(state.cropRect);
    const c = ctx(maskCanvas);
    const sx = maskCanvas.width / compositeCanvas.width;
    const sy = maskCanvas.height / compositeCanvas.height;
    c.save();
    c.beginPath();
    // 内框退化到 0×0 时裁成空区域: 画笔什么也画不上去 (画到环带或框外才是真的越界)
    c.rect(inner.x * sx, inner.y * sy, Math.max(0, inner.w) * sx, Math.max(0, inner.h) * sy);
    c.clip();
    maskClipCtx = c;
  }

  function exitMaskClip() {
    if (!maskClipCtx) return;
    maskClipCtx.restore();
    maskClipCtx = null;
  }

  /** 二值化蒙版: alpha >= 128 的像素设为不透明灰色, 其余完全透明 (无半透明过渡像素) */
  function binarizeMask() {
    const c = ctx(maskCanvas);
    const data = c.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] >= 128) {
        px[i] = 128; px[i + 1] = 128; px[i + 2] = 128; px[i + 3] = 255;
      } else {
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
      }
    }
    c.putImageData(data, 0, 0);
  }

  function drawStroke(canvas, x, y) {
    const c = strokeSetup(canvas);
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
    // 指针捕获: 拖拽移出画布也持续接收事件, 松开才结束
    try { compositeCanvas.setPointerCapture(e.pointerId); } catch {}
    const { x, y } = getPos(e);
    // 裁剪重绘: 压在外框右下角的手柄上 -> 调整已有选框 (左上角固定), 而不是重新框一个
    if (isOnCropHandle(x, y)) {
      const r = state.cropRect;
      cropDrag = { kind: "handle", sx: r.x, sy: r.y, cx: x, cy: y, mx: e.clientX, my: e.clientY, rect: { ...r } };
      updateShapeSizeLabel();
      renderComposite();
      return;
    }
    // 裁剪重绘: 压在已有选框内部 -> 整体平移 (尺寸不变, 只挪位置); 手柄先判, 命中区在右下角重合
    if (canEditCropRect() && hitCropRect(state.cropRect, x, y)) {
      const r = state.cropRect;
      cropDrag = {
        kind: "move", sx: x, sy: y, cx: x, cy: y, mx: e.clientX, my: e.clientY,
        orig: { ...r }, rect: { ...r },
      };
      updateShapeSizeLabel();
      renderComposite();
      return;
    }
    // 裁剪框选: 在框外拖出"外框 + 内缩 a 的内框"的闭环选框, 松开时提交 (全局只能有一个外框)
    if (state.tool === "crop" && isCropActive()) {
      cropDrag = {
        kind: "new", sx: x, sy: y, cx: x, cy: y, mx: e.clientX, my: e.clientY,
        rect: normalizeCropRect(x, y, 0, 0),
      };
      updateShapeSizeLabel();
      renderComposite();
      return;
    }
    // 裁剪重绘: 画笔/橡皮只能在内侧框内使用, 还没框选就先提示 (否则会画到裁剪范围之外的蒙版上)
    if (isCropActive() && !state.cropRect && (state.tool === "brush" || state.tool === "eraser")) {
      state.drawing = false;
      toast("请先用「▣ 裁剪」框出重绘区域", "warning");
      return;
    }
    // 快速选区工具: 记下起点, 拖拽实时预览, 松开时提交填充
    if (state.tool === "rect" || state.tool === "ellipse" || state.tool === "lasso") {
      shapeDrag = { tool: state.tool, sx: x, sy: y, cx: x, cy: y, points: [{ x, y }], mx: e.clientX, my: e.clientY };
      renderComposite();
      drawShapePreview();
      return;
    }
    const target = state.mode === "涂鸦重绘" ? doodleCanvas : maskCanvas;
    const sx = target.width / compositeCanvas.width;
    const sy = target.height / compositeCanvas.height;
    if (target === maskCanvas) enterMaskClip();
    pushHistory([target]);
    drawStroke(target, x * sx, y * sy);
    if (target === maskCanvas) binarizeMask();
    renderComposite();
  }

  function moveStroke(e) {
    if (!state.drawing || !state.image) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    // 裁剪框选拖拽: 实时合法化外框并预览 (含尺寸标签); 拖右下角手柄时左上角固定不动
    if (cropDrag) {
      cropDrag.cx = clampX(x);
      cropDrag.cy = clampY(y);
      cropDrag.mx = e.clientX;
      cropDrag.my = e.clientY;
      cropDrag.rect = cropDrag.kind === "handle" ? rectFromHandleDrag(cropDrag)
        : cropDrag.kind === "move" ? rectFromMoveDrag(cropDrag) : rectFromDrag(cropDrag);
      renderComposite();
      updateShapeSizeLabel();
      return;
    }
    // 选区拖拽: 更新终点 / 套索顶点, 实时预览 + 尺寸标签
    if (shapeDrag) {
      shapeDrag.cx = clampX(x);
      shapeDrag.cy = clampY(y);
      shapeDrag.mx = e.clientX;
      shapeDrag.my = e.clientY;
      const lp = shapeDrag.points[shapeDrag.points.length - 1];
      if (shapeDrag.tool === "lasso" && (Math.abs(shapeDrag.cx - lp.x) > 2 || Math.abs(shapeDrag.cy - lp.y) > 2)) {
        shapeDrag.points.push({ x: shapeDrag.cx, y: shapeDrag.cy });
      }
      renderComposite();
      drawShapePreview();
      return;
    }
    const target = state.mode === "涂鸦重绘" ? doodleCanvas : maskCanvas;
    const sx = target.width / compositeCanvas.width;
    const sy = target.height / compositeCanvas.height;
    const c = strokeSetup(target);
    c.lineTo(x * sx, y * sy);
    c.stroke();
    if (target === maskCanvas) binarizeMask();
    renderComposite();
  }

  function endStroke() {
    if (cropDrag) { commitCrop(); return; }   // 裁剪框选: 松开时提交
    if (shapeDrag) { commitShape(); return; }   // 选区: 松开时提交
    exitMaskClip();
    state.drawing = false;
  }

  compositeCanvas.addEventListener("pointerdown", startStroke);
  compositeCanvas.addEventListener("pointermove", moveStroke);
  compositeCanvas.addEventListener("pointerup", endStroke);
  compositeCanvas.addEventListener("pointerleave", endStroke);

  // ---- 画笔/橡皮悬停区域提示 (跟随鼠标的圆圈, 直径 = 画笔大小 × 画布显示缩放) ----
  const brushCursor = el("div", { class: "brush-cursor" });
  let lastPointer = null;   // 最近一次悬停位置 (滑条调大小时原地刷新用)

  /** 更新悬停指示圈: 换算当前画笔在屏幕上的实际涂抹直径并定位到鼠标下方 (仅画笔/橡皮; 选区工具隐藏) */
  function updateBrushCursor(clientX, clientY) {
    const brushLike = state.tool === "brush" || state.tool === "eraser";
    if (!state.image || state.mode === "图生图" || !brushLike) {
      brushCursor.style.display = "none";
      lastPointer = null;
      return;
    }
    const rect = compositeCanvas.getBoundingClientRect();
    const wrapRect = canvasWrap.getBoundingClientRect();
    const scale = rect.width / compositeCanvas.width;   // 画布像素 -> 屏幕像素
    const d = Math.max(2, state.brushSize * scale);
    brushCursor.style.width = d + "px";
    brushCursor.style.height = d + "px";
    brushCursor.classList.toggle("eraser", state.tool === "eraser");
    brushCursor.style.left = clientX - wrapRect.left + "px";
    brushCursor.style.top = clientY - wrapRect.top + "px";
    // clear(canvasWrap) 重建画布后元素被移除, 这里自动补回
    if (!canvasWrap.contains(brushCursor)) canvasWrap.append(brushCursor);
    brushCursor.style.display = "block";
    lastPointer = { x: clientX, y: clientY };
  }

  function hideBrushCursor() {
    brushCursor.style.display = "none";
    lastPointer = null;
  }

  /**
   * 选框上的光标提示: 右下角手柄 -> ↖↘ 缩放, 外框内部 -> move (可整体拖动), 其余 -> 十字。
   * 两种拖动都只在「▣ 裁剪」工具下生效, 那时画笔圈本来就是隐藏的, 这里只是保证一致。
   */
  function updateCropHandleCursor(e) {
    if (!canEditCropRect()) {
      compositeCanvas.style.cursor = "";
      return;
    }
    const { x, y } = getPos(e);
    const onHandle = isOnCropHandle(x, y);
    const inBox = !onHandle && hitCropRect(state.cropRect, x, y);
    compositeCanvas.style.cursor = onHandle ? "nwse-resize" : inBox ? "move" : "";
    if (onHandle || inBox) hideBrushCursor();
  }

  compositeCanvas.addEventListener("pointerenter", (e) => {
    updateBrushCursor(e.clientX, e.clientY);
    updateCropHandleCursor(e);
  });
  compositeCanvas.addEventListener("pointermove", (e) => {
    updateBrushCursor(e.clientX, e.clientY);
    updateCropHandleCursor(e);
  });
  compositeCanvas.addEventListener("pointerleave", () => {
    hideBrushCursor();
    compositeCanvas.style.cursor = "";
  });

  // ---- 快速选区 (矩形 / 椭圆 / 套索): 拖拽实时预览, 松开时填充到蒙版或涂鸦层 ----
  let shapeDrag = null;   // { tool, sx, sy, cx, cy, points, mx, my }  画布坐标系 + 鼠标屏幕坐标
  let cropDrag = null;    // { kind:"new"|"handle", sx, sy, cx, cy, mx, my, rect }  裁剪重绘的外框拖拽状态
  const shapeSizeLabel = el("div", { class: "shape-size-label" });

  const clampX = (x) => Math.max(0, Math.min(compositeCanvas.width, x));
  const clampY = (y) => Math.max(0, Math.min(compositeCanvas.height, y));

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "255,255,255";
    const n = parseInt(m[1], 16);
    return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
  }

  /** 构建选区路径 (rect / ellipse / lasso 多边形) */
  function shapePath(c, d) {
    c.beginPath();
    if (d.tool === "rect") {
      c.rect(Math.min(d.sx, d.cx), Math.min(d.sy, d.cy), Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy));
    } else if (d.tool === "ellipse") {
      c.ellipse((d.sx + d.cx) / 2, (d.sy + d.cy) / 2, Math.abs(d.cx - d.sx) / 2, Math.abs(d.cy - d.sy) / 2, 0, 0, Math.PI * 2);
    } else {
      c.moveTo(d.points[0].x, d.points[0].y);
      for (let i = 1; i < d.points.length; i++) c.lineTo(d.points[i].x, d.points[i].y);
      if (d.points.length > 2) c.closePath();
    }
  }

  /** 拖拽中的半透明形状预览 (只画在合成画布上, 不提交到蒙版/涂鸦层) */
  function drawShapePreview() {
    const d = shapeDrag;
    if (!d) return;
    const rgb = state.mode === "涂鸦重绘" ? hexToRgb(state.brushColor) : "128,128,128";
    const c = ctx(compositeCanvas);
    c.save();
    shapePath(c, d);
    c.fillStyle = "rgba(" + rgb + ", 0.35)";
    c.fill();
    c.lineWidth = Math.max(1, compositeCanvas.width / 500);
    c.strokeStyle = "rgba(" + rgb + ", 0.95)";
    c.stroke();
    c.restore();
    updateShapeSizeLabel();
  }

  /** 实时尺寸标签: 跟随鼠标显示选区当前宽 x 高 (图像像素); 裁剪框选额外显示内框尺寸 */
  function updateShapeSizeLabel() {
    const d = cropDrag || shapeDrag;
    if (!d) return;
    if (cropDrag) {
      const r = cropDrag.rect;
      const inner = innerCropRect(r);
      shapeSizeLabel.textContent = `外框 ${r.w} × ${r.h} · 内框 ${innerSizeText(inner)} · 内缩 ${state.cropInset}`;
    } else {
      const w = Math.round(Math.abs(d.cx - d.sx));
      const h = Math.round(Math.abs(d.cy - d.sy));
      shapeSizeLabel.textContent = w + " × " + h;
    }
    const wrapRect = canvasWrap.getBoundingClientRect();
    shapeSizeLabel.style.left = Math.min(d.mx - wrapRect.left + 14, wrapRect.width - shapeSizeLabel.offsetWidth - 6) + "px";
    shapeSizeLabel.style.top = Math.min(d.my - wrapRect.top + 18, wrapRect.height - 26) + "px";
    if (!canvasWrap.contains(shapeSizeLabel)) canvasWrap.append(shapeSizeLabel);
    shapeSizeLabel.style.display = "block";
  }

  function hideShapeSizeLabel() { shapeSizeLabel.style.display = "none"; }

  /** 松开: 把选区形状填充到目标层 (蒙版固定灰色并二值化; 涂鸦用当前颜色) */
  function commitShape() {
    const d = shapeDrag;
    shapeDrag = null;
    state.drawing = false;
    hideShapeSizeLabel();
    if (!d) return;
    const target = state.mode === "涂鸦重绘" ? doodleCanvas : maskCanvas;
    const c = ctx(target);
    c.globalCompositeOperation = "source-over";
    c.fillStyle = target === maskCanvas ? "#808080" : state.brushColor;
    pushHistory([target]);
    // 选区坐标是全图坐标系: 蒙版画布为 1/8 尺寸, 提交时按比例缩放到蒙版坐标系
    c.save();
    c.scale(target.width / compositeCanvas.width, target.height / compositeCanvas.height);
    shapePath(c, d);
    c.fill();
    c.restore();
    if (target === maskCanvas) binarizeMask();
    renderComposite();
  }

  /** 取消当前选区/裁剪拖拽 (Esc) */
  function cancelShape() {
    if (cropDrag) {
      cropDrag = null;
      state.drawing = false;
      hideShapeSizeLabel();
      renderComposite();
      return;
    }
    if (!shapeDrag) return;
    shapeDrag = null;
    state.drawing = false;
    hideShapeSizeLabel();
    renderComposite();
  }

  /** 裁剪重绘: 丢弃内侧框之外的蒙版内容 (画笔只允许在内侧框里用, 之前在全图模式下画的要裁掉) */
  function clipMaskToInner() {
    const r = state.cropRect;
    if (!r) return;
    const c = ctx(maskCanvas);
    const inner = innerCropRect(r);
    const sx = maskCanvas.width / compositeCanvas.width;
    const sy = maskCanvas.height / compositeCanvas.height;
    // 内侧框与 1/8 蒙版对齐 (坐标都是 8 的倍数), 这里都是整数
    const ix = Math.round(inner.x * sx), iy = Math.round(inner.y * sy);
    const iw = Math.round(inner.w * sx), ih = Math.round(inner.h * sy);
    if (iw <= 0 || ih <= 0) {
      c.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      return;
    }
    const keep = c.getImageData(ix, iy, iw, ih);
    c.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    c.putImageData(keep, ix, iy);
  }

  /** 提交裁剪的原地改动: 手柄与平移都算; 在框外重新框选则是直接替换旧框 (选框只能有一个) */
  function commitCrop() {
    const d = cropDrag;
    cropDrag = null;
    state.drawing = false;
    hideShapeSizeLabel();
    if (!d || !d.rect) { renderComposite(); return; }
    const prev = state.cropRect;
    const untouched = prev
      && prev.x === d.rect.x && prev.y === d.rect.y && prev.w === d.rect.w && prev.h === d.rect.h;
    // 手柄/选框上只按了一下没拖动: 不算改动, 也就不用弹提示
    if (untouched && (d.kind === "handle" || d.kind === "move")) {
      renderComposite();
      return;
    }
    state.cropRect = d.rect;
    if (state.cropMode) clipMaskToInner();   // 内侧框之外的旧笔迹作废
    renderComposite();
    updateCropInfo();
    // 提示只报尺寸 (位置坐标只在后端日志里出现)
    const size = `${d.rect.w} × ${d.rect.h}`;
    const msg = d.kind === "handle" ? `✂️ 裁剪区域已调整为 ${size}`
      : d.kind === "move" ? `✥ 裁剪区域已移动 (尺寸仍是 ${size})`
        : `✂️ 裁剪区域 ${size}`;
    toast(msg, "info");
    if (onChange) onChange();
  }

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
      if (onImageLoad) onImageLoad(img);   // 通知外部: 基础图片尺寸就绪 (分辨率自动对齐)
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
    hideBrushCursor();
    hideShapeSizeLabel();
    resetHistory();
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
    // 裁剪工具只在"局部重绘"下成立; 切走时交还给画笔 (回来时若还开着裁剪重绘则自动选回「裁剪」)
    if (state.cropMode && m === "局部重绘") setTool("crop");
    else if (state.tool === "crop") setTool("brush");
    renderComposite();
    updateBrushSection();
    updateCropInfo();
    if (m === "图生图") hideBrushCursor();   // 图生图不需要绘制, 隐藏画笔提示圈
    if (onChange) onChange();
  });

  // 画笔/橡皮/选区分段 + 大小滑条 + 颜色 (与 ANR 一致: 局部重绘只画遮罩不需要颜色, 涂鸦重绘需要)
  const toolGroup = el("div", { class: "opt-group ed-seg" });
  // 选区工具 (四项单选): 矩形 / 椭圆 / 套索 / 裁剪 —— 选中「▣ 裁剪」即启用裁剪重绘, 不需要额外的开关
  const shapeGroup = el("div", { class: "opt-group ed-seg" });
  const TOOL_OPTIONS = [
    [toolGroup, "brush", "🖌️ 画笔", ""],
    [toolGroup, "eraser", "🧽 橡皮", ""],
    [shapeGroup, "rect", "▭ 矩形", "拖拽框选矩形区域, 拖拽时实时显示宽高"],
    [shapeGroup, "ellipse", "◯ 椭圆", "拖拽框选椭圆区域, 拖拽时实时显示宽高"],
    [shapeGroup, "lasso", "✎ 套索", "拖拽圈选任意形状区域 (Esc 取消)"],
    [shapeGroup, "crop", "▣ 裁剪", "选中即启用裁剪重绘: 拖拽框出重绘区域, 外框为裁剪/重绘范围 (64 的倍数 = 生成分辨率, 面积不超过 1024×1024, 长宽不限), 内框向内缩 a 像素为画笔范围 (不设最小区域); 只能框选一个。框好后切到画笔涂画, 或拖右下角手柄调整大小 (左上角固定); 改选矩形/椭圆/套索即关闭"],
  ];
  for (const [group, tool, label, tip] of TOOL_OPTIONS) {
    const item = el("label", {
      class: "opt-item" + (tool === state.tool ? " selected" : ""),
      text: label,
      "data-tool": tool,
      title: tip,
    });
    item.addEventListener("click", () => setTool(tool));
    group.append(item);
  }
  /**
   * 统一切换工具: 两组分段按钮单选同步。
   * 选区工具里选中「▣ 裁剪」= 启用裁剪重绘, 改选矩形/椭圆/套索 = 关掉它。
   * 画笔/橡皮刻意不动这个开关 —— 否则"框好选框再切去涂画"就没法用了
   * (「框选 → 涂画 → 生成」是裁剪重绘的主流程)。
   */
  function setTool(t) {
    // 裁剪只在"局部重绘"模式成立, 其它模式一律退回画笔
    if (t === "crop" && state.mode !== "局部重绘") t = "brush";
    // 提示圈只对画笔/橡皮有意义; 选区/裁剪时隐藏
    if (t === "crop") hideBrushCursor();
    state.tool = t;
    if (t === "crop") state.cropMode = true;
    else if (t !== "brush" && t !== "eraser") state.cropMode = false;   // 矩形/椭圆/套索 = 关闭裁剪重绘
    if (shapeDrag || cropDrag) cancelShape();   // 拖拽中切工具: 取消当前选区
    exitMaskClip();   // 笔画中途被切走 (未收到 pointerup) 时兜底解除内侧框裁剪, 防止裁剪状态残留
    $$(".opt-item", toolGroup).forEach((x) => x.classList.toggle("selected", x.dataset.tool === t));
    $$(".opt-item", shapeGroup).forEach((x) => x.classList.toggle("selected", x.dataset.tool === t));
    // 回到裁剪模式: 期间可能用矩形/椭圆/套索画过内框之外的蒙版, 那部分作废
    if (t === "crop" && state.cropRect) clipMaskToInner();
    // 悬停中切换工具: 指示圈实线(画笔)/虚线(橡皮)/隐藏(选区) 即时切换
    if (lastPointer) updateBrushCursor(lastPointer.x, lastPointer.y);
    // 手柄只在裁剪工具下可拖: 切工具后重画选框(手柄出现/消失), 并刷新分区显隐与提示文案
    compositeCanvas.style.cursor = "";
    updateBrushSection();
    renderComposite();
    updateCropInfo();
  }
  const colorInput = el("input", { type: "color", value: state.brushColor });
  colorInput.addEventListener("input", () => { state.brushColor = colorInput.value; });
  const colorRow = el("div", { class: "ed-color-row" }, [el("span", { class: "ed-color-label", text: "颜色" }), colorInput]);
  // 大小滑条: 同时控制画笔和橡皮的粗细
  const sizeCtl = sliderRow({ min: 4, max: 120, step: 1, value: state.brushSize });
  sizeCtl.input.addEventListener("input", () => {
    state.brushSize = sizeCtl.get();
    // 悬停中调整大小: 指示圈直径即时跟随
    if (lastPointer) updateBrushCursor(lastPointer.x, lastPointer.y);
  });
  sizeCtl.node.style.flex = "1";
  sizeCtl.node.style.minWidth = "0";
  // 内缩 a 滑条: 紧跟在选区工具 (矩形/椭圆/套索/裁剪) 下面, 选中「▣ 裁剪」后一眼就能看到
  const cropInsetCtl = sliderRow({ min: CROP_MIN_INSET, max: CROP_MAX_INSET, step: CROP_INSET_STEP, value: state.cropInset });
  cropInsetCtl.node.style.flex = "1";
  cropInsetCtl.node.style.minWidth = "0";
  cropInsetCtl.input.addEventListener("input", () => {
    state.cropInset = cropInsetCtl.get();
    // a 变化会改变外框的最小尺寸: 已有选框重新合法化 (越界时会被撑大/收敛)
    if (state.cropRect) {
      state.cropRect = normalizeCropRect(state.cropRect.x, state.cropRect.y, state.cropRect.w, state.cropRect.h);
      clipMaskToInner();   // 内侧框变小后, 越界的旧笔迹一并裁掉
    }
    renderComposite();
    updateCropInfo();
  });
  const cropInsetRow = el("div", { class: "ed-size-row ed-inset-row" }, [
    el("span", { class: "ed-color-label", text: "内缩" }),
    cropInsetCtl.node,
  ]);
  cropInsetRow.title = "内侧框相对外侧框向内缩进的像素数 a (32-96, 步长 8); 这段环带只作为重绘上下文, 画笔涂不到";

  // ---- 裁剪重绘 (选中「▣ 裁剪」即启用, 仅局部重绘模式): 沿外框裁剪重绘, 画笔只能在内缩 a 的内框里画 ----
  // 这一块 (标题 + 📏 选框尺寸提示行) 整体挂在 brushSec 里、「选区工具」下方: 选中裁剪后顺着往下就是
  // "内缩 a" 与它算出来的外框/内框尺寸, 一条线读下来, 不用回头看面板顶部。
  const cropSec = el("div", { class: "ed-sec ed-crop-sec" });
  const cropInfo = el("div", {
    class: "ed-crop-info",
    title: "拖框内部平移选框 · 拖右下角手柄缩放 · 在框外拖拽可以重新框选 (选框只能有一个)",
  });
  cropSec.append(
    el("div", { class: "ed-sec-title", text: "✂️ 裁剪重绘" }),
    cropInfo,
  );

  brushSec = el("div", { class: "ed-sec ed-brush-sec" }, [
    el("div", { class: "ed-sec-title", text: "🖍️ 画笔 / 橡皮 / 选区" }),
    toolGroup,
    el("div", { class: "ed-size-row" }, [el("span", { class: "ed-color-label", text: "大小" }), sizeCtl.node]),
    colorRow,
    shapeGroup,
    cropInsetRow,   // 内缩 a: 紧贴选区工具 (只在「▣ 裁剪」选中时出现)
    cropSec,        // ✂️ 裁剪重绘 (标题 + 📏 尺寸提示行): 同在选区工具下方, 排在"内缩"之后
  ]);

  /** 选框状态提示: 只报尺寸 (外框 + 内框); 用法看光标形状与右下角手柄, 坐标只在后端日志里 */
  function updateCropInfo() {
    if (!isCropActive()) {
      cropInfo.textContent = "";
      return;
    }
    const r = state.cropRect;
    if (!r) {
      cropInfo.textContent = "📏 在图片上拖拽框选重绘区域";
      return;
    }
    const inner = innerCropRect(r);
    // 这一行只说尺寸, 不夹带任何手势提示 —— 选中「▣ 裁剪」时光标是 move、右下角还有手柄, 用法已经够明显;
    // 切到画笔去涂画时更不该再冒出"选裁剪后可平移/拖手柄"这类跟当前操作无关的提示。
    // 用法说明统一收进悬停 title (见上面 cropInfo 的 title), 坐标只在后端日志
    // (generate_images.py 的 "裁剪重绘: 外框 w×h @ (x, y)")。
    cropInfo.textContent = `📏 外框 ${r.w} × ${r.h} · 内框 ${innerSizeText(inner)}`;
  }

  function updateBrushSection() {
    const isI2I = state.mode === "图生图";
    const cropOn = isCropActive();
    // 图生图不需要绘制: 画笔区与操作按钮行全部隐藏; 局部重绘不需要颜色, 仅涂鸦重绘显示颜色
    brushSec.classList.toggle("hidden", isI2I);
    historyRow.classList.toggle("hidden", isI2I);
    actionsRow.classList.toggle("hidden", isI2I);
    colorRow.classList.toggle("hidden", state.mode !== "涂鸦重绘");
    // 裁剪重绘的提示行只在「▣ 裁剪」选中时出现
    // (矩形/椭圆/套索/裁剪 是同一组单选, 一直都在, 互相切换时不隐藏彼此)
    cropSec.classList.toggle("hidden", !cropOn);
    // 内缩 a 滑条挪到了选区工具下面 (挂在 brushSec 里), 得单独按裁剪开关显隐, 否则切走以后它还留在那儿
    cropInsetRow.classList.toggle("hidden", !cropOn);
    if (cropOn && state.cropRect) state.cropRect = normalizeCropRect(state.cropRect.x, state.cropRect.y, state.cropRect.w, state.cropRect.h);
    if (!cropOn && state.tool === "crop") setTool("brush");
  }

  // ---- 撤销 / 恢复 (绘制历史: 每次操作前快照将被修改的画布) ----
  const undoStack = [];
  const redoStack = [];
  const HISTORY_MAX = 20;
  const snapshotCanvas = (c) => ctx(c).getImageData(0, 0, c.width, c.height);

  function updateHistoryBtns() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }
  function resetHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    if (undoBtn) updateHistoryBtns();
  }
  /** 记录一步操作: 传入本次将要修改的画布, 保存修改前快照 */
  function pushHistory(canvases) {
    undoStack.push(canvases.map((c) => ({ canvas: c, data: snapshotCanvas(c) })));
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;   // 有新操作后, 不可恢复
    updateHistoryBtns();
  }
  function undoHistory() {
    const entry = undoStack.pop();
    if (!entry) return;
    redoStack.push(entry.map((e) => ({ canvas: e.canvas, data: snapshotCanvas(e.canvas) })));
    for (const e of entry) ctx(e.canvas).putImageData(e.data, 0, 0);
    renderComposite();
    updateHistoryBtns();
  }
  function redoHistory() {
    const entry = redoStack.pop();
    if (!entry) return;
    undoStack.push(entry.map((e) => ({ canvas: e.canvas, data: snapshotCanvas(e.canvas) })));
    for (const e of entry) ctx(e.canvas).putImageData(e.data, 0, 0);
    renderComposite();
    updateHistoryBtns();
  }

  const undoBtn = el("button", { class: "btn btn-sm btn-ghost", text: "↩️ 撤销", title: "撤销上一步绘制 (Ctrl+Z)" });
  undoBtn.addEventListener("click", undoHistory);
  const redoBtn = el("button", { class: "btn btn-sm btn-ghost", text: "↪️ 恢复", title: "恢复被撤销的绘制 (Ctrl+Y)" });
  redoBtn.addEventListener("click", redoHistory);
  updateHistoryBtns();

  const clearBtn = el("button", { class: "btn btn-sm btn-ghost", text: "🗑️ 清空绘制" });
  clearBtn.addEventListener("click", () => {
    pushHistory([maskCanvas, doodleCanvas]);
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
    // 画布显示尺寸变了: 手柄半径按新缩放重画一遍 (否则退出全屏后看着会突然变小)
    renderComposite();
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
    // 同上: 进全屏后画布变大, 手柄半径按新缩放重画, 否则看着会突然变大
    renderComposite();
  }

  fullscreenBtn.addEventListener("click", () => {
    if (overlay) closeFullscreen(); else openFullscreen();
  });

  // Esc 关闭 (选区/裁剪框拖拽中先取消当前拖拽); Ctrl+Z / Ctrl+Y 撤销恢复
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (shapeDrag || cropDrag) { cancelShape(); return; }
      closeFullscreen();
      return;
    }
    if (!state.image) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    // 文本输入焦点时不拦截系统编辑快捷键
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undoHistory();
    } else if (key === "y" || (key === "z" && e.shiftKey)) {
      e.preventDefault();
      redoHistory();
    }
  });

  // 操作按钮两行 (撤销/恢复 + 清空/全屏): 图生图模式下与画笔区一并隐藏
  const historyRow = el("div", { class: "ed-actions" }, [undoBtn, redoBtn]);
  const actionsRow = el("div", { class: "ed-actions" }, [clearBtn, fullscreenBtn]);
  updateBrushSection();
  updateRemoveBtn();
  updateCropInfo();
  tools.append(
    el("div", { class: "ed-sec" }, [el("div", { class: "ed-sec-title", text: "🎨 重绘模式" }), modeGroup]),
    brushSec,     // 画笔 / 橡皮 / 选区 + 内缩 a + ✂️ 裁剪重绘 (后两者仅局部重绘模式下、选中「▣ 裁剪」时可见)
    historyRow,
    actionsRow,
  );
  wrap.append(canvasWrap, tools);
  container.append(wrap);

  /** 导出蒙版: 把 1/8 蒙版画布无损放大回原图尺寸 (关闭平滑插值, 保持 8x8 方格硬边与二值), 文件与原图同尺寸 */
  async function buildMaskBlob() {
    const c = document.createElement("canvas");
    c.width = bgCanvas.width;
    c.height = bgCanvas.height;
    const cx = c.getContext("2d");
    cx.imageSmoothingEnabled = false;
    cx.drawImage(maskCanvas, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }

  /** 蒙版上是否已有任何笔迹 (裁剪重绘判断"只框选没涂画"用) */
  function hasMaskContent() {
    const { data } = ctx(maskCanvas).getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  }

  /** 裁剪重绘: 只框选而没有使用画笔时, 默认画笔涂满整个内侧框 (外框内缩 a 的那块区域) */
  function fillInnerCropAsMask() {
    const r = state.cropRect;
    if (!r) return;
    const inner = innerCropRect(r);
    if (inner.w <= 0 || inner.h <= 0) return;
    const c = ctx(maskCanvas);
    const sx = maskCanvas.width / compositeCanvas.width;
    const sy = maskCanvas.height / compositeCanvas.height;
    c.save();
    c.globalCompositeOperation = "source-over";
    c.fillStyle = "#808080";
    c.fillRect(inner.x * sx, inner.y * sy, inner.w * sx, inner.h * sy);
    c.restore();
  }

  /** 提交前校验: 返回错误文案, 通过则返回 null */
  function validate() {
    if (isCropActive() && !state.cropRect) return "裁剪重绘需要先在图片上框选裁剪区域";
    return null;
  }

  // 导出: 上传三张图, 返回路径 (蒙版始终是整图尺寸, 裁剪重绘由后端按外框裁切)
  async function exportImages() {
    if (!state.image) return null;
    const cropOn = isCropActive();
    if (cropOn && !state.cropRect) throw new Error("裁剪重绘需要先在图片上框选裁剪区域");
    if (cropOn && !hasMaskContent()) {
      // 只框选没涂画: 默认重绘整个内侧框 (先落盘再渲染, 让预览与导出结果一致)
      fillInnerCropAsMask();
      renderComposite();
    }
    const blob = (c) => new Promise((resolve) => c.toBlob(resolve, "image/png"));
    const bgBlob = await blob(bgCanvas);
    const maskBlob = await buildMaskBlob();
    const compBlob = await blob(compositeCanvas);
    const files = await uploadFiles([
      new File([bgBlob], "background.png"),
      new File([maskBlob], "mask.png"),
      new File([compBlob], "composite.png"),
    ]);
    const get = (name) => (files.find((f) => f.name === name) || {}).path;
    const result = {
      enabled: true,
      mode: cropOn ? "裁剪重绘" : state.mode,
      background_path: get("background.png"),
      mask_path: get("mask.png"),
      composite_path: get("composite.png"),
    };
    if (cropOn) {
      // 外框 + 内缩 a: 后端按外框裁剪, 生成后再贴回原图
      result.crop = { x: state.cropRect.x, y: state.cropRect.y, w: state.cropRect.w, h: state.cropRect.h, inset: state.cropInset };
    }
    return result;
  }

  // 从路径加载图片 (用于"发送到图生图")
  async function loadImage(path) {
    const img = new Image();
    img.onload = () => {
      state.image = img;
      setupCanvases(img);
      if (onImageLoad) onImageLoad(img);   // 通知外部: 基础图片尺寸就绪 (分辨率自动对齐)
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
    /** 提交前校验 (如裁剪重绘未框选): 返回错误文案, 通过返回 null */
    validate,
    exportImages,
    loadImage,
  };
}

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
