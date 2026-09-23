// ============================================================
// 可复用组件: 页签、画廊、日志、图片编辑器
// ============================================================
import { $, $$, el, elSvg, clear, toast, sliderRow, enableDrop, edgeScroll, imageDropZone, wireAutocomplete, wildcardsButton } from "./ui.js";
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
  cropVisibleRect,
  expandCropRect,
  hitCropHandle,
  hitCropRect,
  innerCropRect as innerRect,
  normalizeCropRect as normalizeCrop,
} from "./cropRect.js";
import {
  BRUSH_DEFAULT,
  BRUSH_MAX,
  BRUSH_MIN,
  BRUSH_ROUND,
  BRUSH_SQUARE,
  MASK_CELL,
  brushCells,
  brushSpan,
  collectCells,
  cropToAlign64,
  snapToCellCenter,
  strokeCellSet,
  strokeCellSetDetailed,
} from "./maskGrid.js";

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
    brushSize: BRUSH_DEFAULT,   // 笔刷大小: **格数** (4~50), 边长 = 该值 × 8 像素
    tool: "brush",
    squareBrush: false,   // Square Brush: 勾选 = 方形笔刷, 取消 = 圆形笔刷 (对齐官网的 Square Brush)
    drawing: false,
    image: null,
    cropMode: false,      // 裁剪重绘是否启用 (选中「▣ 裁剪」置位, 仅局部重绘模式生效)
    cropInset: CROP_MIN_INSET,   // 内侧框相对外侧框的内缩像素 a
    cropRect: null,       // 外侧选框 {x, y, w, h} (图像像素, 64 的倍数); 只能存在一个
  };

  const wrap = el("div", { class: "img-editor-wrap" });

  // 滚轮缩放视图 (以鼠标指针为中心): scale 为相对"适应大小"的倍数, x/y 为平移 (CSS px)
  let view = { scale: 1, x: 0, y: 0 };
  const VIEW_MIN = 0.2, VIEW_MAX = 12;

  // 画布区: 只显示合成画布 (背景 + 遮罩预览), 其余为工作层
  // 画布区内的悬停预览/尺寸标签都是 absolute 定位, 依赖 canvasWrap 作为包含块。
  // CSS 里已写 position: relative, 这里再兜一道: 万一被别处的样式覆盖成 static,
  // 预览会整块跑到页面角落 (与画布脱开), 那种故障很难一眼看出原因。
  const canvasWrap = el("div", { class: "editor-canvas-wrap", style: "position:relative;" });
  const bgCanvas = el("canvas", { style: "display:none;" });
  const maskCanvas = el("canvas", { style: "display:none;" });
  const doodleCanvas = el("canvas", { style: "display:none;" });
  const compositeCanvas = el("canvas");
  const ctx = (c) => c.getContext("2d");
  const placeholder = el("div", { class: "editor-placeholder", html: "🖼️ 上传基础图片后开始编辑<br/><span class='muted'>支持图生图 / 局部重绘 / 涂鸦重绘</span>" });
  canvasWrap.append(placeholder);

  /** 纯计算: 某张图会被居中裁剪成什么尺寸 (与 setupCanvases 用同一套 cropToAlign64, 结果必然一致) */
  const cropResultOf = (img) => cropToAlign64(img.naturalWidth || img.width, img.naturalHeight || img.height);

  function setupCanvases(img) {
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    // 上传图片尺寸不是 64 的倍数时, 居中裁剪掉多余部分 (削得尽可能少, 只削到对齐为止)。
    // 这样画布边长必然是 64 的倍数, 而 64 = 8x8, 所以 8x8 网格一定能整除画布, 不会有残缺格子。
    const fit = cropToAlign64(srcW, srcH);
    const w = fit.dw;
    const h = fit.dh;
    [bgCanvas, doodleCanvas, compositeCanvas].forEach((c) => {
      c.width = w;
      c.height = h;
    });
    // 蒙版画布: 与画布同尺寸, 但绘制时只在 8x8 网格上落笔 (每个格子统一涂满/清空)。
    // 不再用 1/8 分辨率的小画布 —— 那样预览与导出之间会多一层放大, 做不到所见即所得。
    maskCanvas.width = w;
    maskCanvas.height = h;
    ctx(bgCanvas).drawImage(img, fit.sx, fit.sy, fit.sw, fit.sh, 0, 0, w, h);
    ctx(maskCanvas).clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    ctx(doodleCanvas).clearRect(0, 0, w, h);
    resetHistory();   // 换图后历史失效
    cropDrag = null;
    state.cropRect = null;   // 换图后旧选框的坐标不再成立
    clear(canvasWrap);
    canvasWrap.append(compositeCanvas, restoreBtn, removeOverlayBtn);
    renderComposite();
    updateRemoveBtn();
    // 换图复位缩放视图到默认位置与大小
    view = { scale: 1, x: 0, y: 0 };
    applyView();
  }

  function renderComposite() {
    const w = bgCanvas.width, h = bgCanvas.height;
    ctx(compositeCanvas).clearRect(0, 0, w, h);
    ctx(compositeCanvas).drawImage(bgCanvas, 0, 0);
    if (state.mode === "涂鸦重绘") {
      ctx(compositeCanvas).drawImage(doodleCanvas, 0, 0);
    } else if (state.mode === "局部重绘") {
      // 蒙版预览: 画布与蒙版同尺寸, 直接叠加即可 —— 画出来的格子就是送进模型的蒙版 (所见即所得)。
      // 蒙版本身只含 8x8 网格上的实心方块, 所以不需要关插值, 也不会有半透明过渡像素。
      const c = ctx(compositeCanvas);
      c.globalAlpha = 0.45;
      c.drawImage(maskCanvas, 0, 0);
      c.globalAlpha = 1;
    }
    // 裁剪重绘: 在最上层画"生成块 (外框自动外扩) + 外框 + 内缩 a 的内框"的闭环选框
    if (isCropActive()) drawCropOverlay();
  }

  // 说明: 这里刻意**不画** 8x8 网格线。
  // 网格线会让整张图看起来蒙了一层密密麻麻的格子 (尤其在全屏放大时), 而它对实际绘制没有帮助 ——
  // 画笔吸附到网格这件事由悬停预览的形状直接表达 (预览本身就是网格对齐的轮廓)。

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

  /**
   * 是否是"重绘"模式 (局部重绘 / 涂鸦重绘)。
   *
   * 两种模式共用同一套规则: 8x8 网格化画笔、笔刷形状、选区工具、裁剪重绘与自动扩展,
   * 唯一的区别是 —— 涂鸦层用用户选择的颜色绘制, 且送进模型的底图是合成图 (底图 + 涂鸦)。
   */
  function isPaintMode(mode) {
    const m = mode === undefined ? state.mode : mode;
    return m === "局部重绘" || m === "涂鸦重绘";
  }

  /**
   * 裁剪重绘是否生效: 开关打开且处于重绘模式 (局部重绘 / 涂鸦重绘; 图生图不适用)。
   *
   * 涂鸦重绘与局部重绘共用同一套自动扩展规则 —— 涂鸦只是"带颜色的遮罩",
   * 所以两者都可以框选区域并自动扩展生成块。
   */
  function isCropActive() {
    return state.cropMode && isPaintMode();
  }

  /** 当前内缩 a 对应的内侧框 (外框四边各向内缩 a 像素) */
  const innerCropRect = (r) => innerRect(r, state.cropInset);

  /** 内侧框尺寸文案: 图像装不下整圈时内框会算出负数, 界面上一律按 0 报 */
  const innerSizeText = (inner) => `${Math.max(0, inner.w)} × ${Math.max(0, inner.h)}`;

  /** 外侧选框合法化 (64 对齐 = 裁剪块即生成分辨率 / 只限面积 1024×1024, 单边不限 / 内框不设最小区域) */
  const normalizeCropRect = (x, y, w, h) =>
    normalizeCrop({ x, y, w, h }, { inset: state.cropInset, imageW: bgCanvas.width, imageH: bgCanvas.height });

  /** 生成块: 外框自动向外扩出来的裁剪范围 (尺寸 = 送进模型的生成分辨率), 与后端同一套算法 */
  const expandedCropRect = (r) => expandCropRect(r, { imageW: bgCanvas.width, imageH: bgCanvas.height });

  /** 画布显示缩放 (屏幕 CSS 像素 / 图像像素): 手柄半径按它换算, 屏幕上大小恒定 */
  function canvasScale() {
    // 取布局宽度 (clientWidth) 而不是 getBoundingClientRect().width: 后者会把祖先的 CSS
    // transform 也算进去 (全屏遮罩的 pop-in 动画是 scale(0.98)), 会让刚进全屏那一帧算错半径。
    const w = compositeCanvas.clientWidth || compositeCanvas.getBoundingClientRect().width;
    const base = w > 0 && compositeCanvas.width > 0 ? w / compositeCanvas.width : 1;
    // 再乘上当前滚轮缩放倍数 (view.scale), 让手柄半径/命中区与缩放后的显示保持一致
    return base * (view.scale || 1);
  }

  /** 应用滚轮缩放视图: 画布套一层 CSS transform, 缩放后重画手柄 (半径已含 view.scale) */
  function applyView() {
    compositeCanvas.style.transformOrigin = '0 0';
    compositeCanvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    if (state.image) {
      renderComposite();
    }
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
    // 外框伸出图片外时圆心会被钳到画布角上, 命中区必须用同一个圆心 (见 cropHandleCenter)
    return canDragHandle() && hitCropHandle(state.cropRect, x, y, canvasScale(), { w: bgCanvas.width, h: bgCanvas.height });
  }

  /**
   * 给各层框各画一枚尺寸标签 (胶囊底 + 彩色文字), 一个框只标自己的分辨率。
   *
   * 两条硬要求:
   *   1) 标签**不能落进内框边线以内** —— 那是画笔要涂的区域, 盖住就看不见画了什么;
   *   2) 各枚标签**互不遮挡**。
   *
   * 做法: 三个框是层层相套的, 所以"落在自己框之外"就等于"落在内框之外"。内框那枚先选, 外层后选,
   * 每枚依次尝试:
   *   1) 自己上边线之外 (首选) / 下边线之外 —— 先按原样, 原位放不下再按"夹进画布"补一次;
   *   2) 还不行就在同一行里横向挪开 (几枚标签挨着排开);
   *   3) 整行都没位置才退到左右两条侧带, 沿带子上下让;
   *   4) 最后才允许压住别的标签 —— 但**永远不许压进内框**。
   *
   * 第 1 步里"夹取版本必须在同一个方向上先补一次"是关键: 选框右侧贴住图片右缘时, 标签右缘正好
   * 等于画布宽度, 只差那 2px 留白 —— 若就此判这个位置不合格, 标签会一路掉到第 3 步去, 看起来
   * 就是"右侧贴边时标签莫名跑到左边竖直居中"。
   *
   * 字号必须让胶囊高度 + 间距 + 留白塞得进最窄的一条环带 (内缩 a 最小 32px), 所以夹在 11~16:
   * a=32 时胶囊 26px, 26 + 2 + 2 = 30 <= 32, 正好一圈放得下。
   *
   * @param {CanvasRenderingContext2D} c
   * @param {Array<{text:string, rect:{x:number,y:number,w:number,h:number}, color:string}>} frames
   *        由内到外排列 (内框 → 外框 → 生成块)
   * @param {number} W 画布宽
   * @param {number} H 画布高
   * @param {{x:number,y:number,w:number,h:number}} [innerBox] 内框 (画笔区域); 给了就谁都不许压进去
   */
  function drawFrameLabels(c, frames, W, H, innerBox) {
    if (!frames || !frames.length) return;
    const scale = Math.max(0.05, canvasScale() || 1);
    const fs = Math.max(11, Math.min(16, Math.round(13 / scale)));
    const GAP = 2;   // 标签与框线、标签与标签之间的距离
    const M = 2;     // 距画布边缘的最小留白

    c.save();
    c.font = `700 ${fs}px system-ui, "Segoe UI", sans-serif`;
    c.textAlign = "right";
    c.textBaseline = "middle";
    const bh = Math.round(fs * 1.6);
    const padX = fs * 0.55;

    const clampX = (x, bw) => Math.min(Math.max(x, M), Math.max(M, W - bw - M));
    const clampY = (y) => Math.min(Math.max(y, M), Math.max(M, H - bh - M));
    const fits = (b) => b.x >= M && b.y >= M && b.x + b.w <= W - M && b.y + b.h <= H - M;
    const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const clearOfInner = (b) => !innerBox
      || b.x + b.w <= innerBox.x || b.x >= innerBox.x + innerBox.w
      || b.y + b.h <= innerBox.y || b.y >= innerBox.y + innerBox.h;

    const placed = [];
    for (const f of frames) {
      const bw = c.measureText(f.text).width + padX * 2;
      const r = f.rect;
      const xr = r.x + r.w - bw;   // 与框右上角对齐
      // 上下两条边线之外优先 (最自然, 也最不容易互相挤); 左右两条边线之外只在环带够宽时才有位置
      const slots = [
        { x: xr, y: r.y - GAP - bh },
        { x: xr, y: r.y + r.h + GAP },
        { x: r.x - GAP - bw, y: r.y },
        { x: r.x + r.w + GAP, y: r.y },
      ];
      const mk = (x, y) => ({ x: clampX(x, bw), y: clampY(y), w: bw, h: bh });
      const free = (b) => clearOfInner(b) && !placed.some((p) => hits(p, b));

      let box = null;
      // 1) 先试上下两条边线之外: 原位放得下就用原位, 原位放不下而夹取确实挪动了它, 再用夹取版本。
      //    夹取版本必须在同一个方向上先补一次 —— 否则选框右侧贴住图片右缘时 (标签右缘正好 = 画布
      //    宽度, 只差那 2px 留白), 这个最该用的位置会被判不合格, 标签一路掉到左右两侧变成"左侧居中"。
      for (const k of [slots[0], slots[1]]) {
        const exact = { x: k.x, y: k.y, w: bw, h: bh };
        if (fits(exact)) {
          if (free(exact)) { box = exact; break; }
          continue;   // 放得下时夹取版本与它完全相同, 不必再试
        }
        const cl = mk(k.x, k.y);
        if ((cl.x !== exact.x || cl.y !== exact.y) && free(cl)) { box = cl; break; }
      }
      // 2) 这一行被占住了就沿着同一行横向挪开 (几枚标签挨着排开), 而不是立刻跳到左右两侧去
      if (!box) {
        for (const k of [slots[0], slots[1]]) {
          const y = clampY(k.y);
          for (const dir of [-1, 1]) {
            for (let n = 1; n <= 6; n++) {
              const x = xr + dir * n * (bw + GAP);
              if (x < M || x + bw > W - M) break;
              const b = { x, y, w: bw, h: bh };
              if (free(b)) { box = b; break; }
            }
            if (box) break;
          }
          if (box) break;
        }
      }
      // 3) 上下整行都没有位置 (内框几乎盖满画布) 时, 退到左右两条侧带, 沿带子依次往下/往上让
      if (!box) {
        for (const k of [slots[2], slots[3]]) {
          const x = clampX(k.x, bw);
          const y0 = clampY(k.y);
          for (const step of [1, -1]) {
            for (let y = step > 0 ? y0 : y0 - (bh + GAP); y >= M && y <= H - M - bh; y += step * (bh + GAP)) {
              const b = { x, y, w: bw, h: bh };
              if (free(b)) { box = b; break; }
            }
            if (box) break;
          }
          if (box) break;
        }
      }
      // 4) 兜底: 宁可压住别的标签, 也绝不压进内框; 连内框都避不开 (画布小到内框盖满) 时才照画
      if (!box) {
        for (const k of slots) {
          const b = mk(k.x, k.y);
          if (clearOfInner(b)) { box = b; break; }
        }
      }
      if (!box) box = mk(xr, r.y - GAP - bh);
      placed.push(box);

      c.beginPath();
      if (typeof c.roundRect === "function") c.roundRect(box.x, box.y, bw, bh, bh / 2);
      else c.rect(box.x, box.y, bw, bh);
      c.fillStyle = "rgba(0, 0, 0, 0.72)";
      c.fill();
      c.fillStyle = f.color;
      c.fillText(f.text, box.x + bw - padX, box.y + bh / 2);
    }
    c.restore();
  }

  /** 裁剪重绘选框: 生成块之外压暗, 生成块↔外框的自动扩展带 + 外框↔内框的内缩环带都标为"仅作重绘上下文", 内框虚线为画笔范围 */
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
    // 生成块 = 外框 + 自动向外扩出来的一圈 (后端真正拿去裁剪的范围, 尺寸就是生成分辨率)。
    // 扩出来那圈只是给模型的上下文 —— 蒙版上是黑的, 不重绘; 这里用淡绿标出来, 让用户看得见
    // "送进模型的其实是这么大一块", 而不是以为自己框的那块变大了。
    const grown = expandedCropRect(rect);
    const grew = grown.x !== rect.x || grown.y !== rect.y || grown.w !== rect.w || grown.h !== rect.h;
    c.save();
    // 生成块之外: 根本没被裁进生成图, 压得最暗
    c.fillStyle = "rgba(0, 0, 0, 0.45)";
    c.beginPath();
    c.rect(0, 0, W, H);
    c.rect(grown.x, grown.y, grown.w, grown.h);
    c.fill("evenodd");
    // 生成块 ↔ 外框: 自动扩展出来的上下文 (裁得进生成图, 但蒙版是黑的 —— 不会被重绘)
    if (grew) {
      c.fillStyle = "rgba(120, 255, 170, 0.16)";
      c.beginPath();
      c.rect(grown.x, grown.y, grown.w, grown.h);
      c.rect(rect.x, rect.y, rect.w, rect.h);
      c.fill("evenodd");
    }
    // 外框 ↔ 内框: 蓝色的闭环带 (会被裁进重绘图片, 但画笔涂不到); 内框为空时整块都是环带
    c.fillStyle = "rgba(96, 200, 255, 0.18)";
    c.beginPath();
    c.rect(rect.x, rect.y, rect.w, rect.h);
    if (hasInner) c.rect(inner.x, inner.y, inner.w, inner.h);
    c.fill("evenodd");
    // 生成块虚线 (淡绿) 排在外框之前画: 扩展不越过图片, 所以这四条边通常都落在画布里; 外框本来就
    // 伸到图片外的那几条边扩不动、生成块与它重合, 交给下面的琥珀色截断标记, 这里跳过不画。
    if (grew) {
      const gvis = cropVisibleRect(grown, { w: W, h: H });
      c.lineWidth = lw * 1.4;
      c.strokeStyle = "rgba(120, 255, 170, 0.95)";
      c.setLineDash([lw * 3, lw * 3]);
      c.beginPath();
      if (!gvis.cutTop) { c.moveTo(gvis.x, grown.y); c.lineTo(gvis.x + gvis.w, grown.y); }
      if (!gvis.cutBottom) { c.moveTo(gvis.x, grown.y + grown.h); c.lineTo(gvis.x + gvis.w, grown.y + grown.h); }
      if (!gvis.cutLeft) { c.moveTo(grown.x, gvis.y); c.lineTo(grown.x, gvis.y + gvis.h); }
      if (!gvis.cutRight) { c.moveTo(grown.x + grown.w, gvis.y); c.lineTo(grown.x + grown.w, gvis.y + gvis.h); }
      c.stroke();
      c.setLineDash([]);
    }
    // 外框实线 (+ 内框虚线; 内框为空就没有内侧框可画)。
    // 画布尺寸 = 图片尺寸, 所以外框伸到图片外的那一段没有地方画: 直接 strokeRect 的话, 伸出去的
    // 那几条边整个落在画布之外 —— 界面上看起来就是"外框不见了"(往左/上伸出时左边和上边全在画布外)。
    // 拆成两笔: 落在画布里的边照原坐标画白色实线; 被图片边界截断的边用琥珀色虚线标在画布边缘上。
    const vis = cropVisibleRect(rect, { w: W, h: H });
    c.lineWidth = lw * 1.8;
    c.strokeStyle = "rgba(255, 255, 255, 0.95)";
    c.beginPath();
    if (!vis.cutTop) { c.moveTo(vis.x, rect.y); c.lineTo(vis.x + vis.w, rect.y); }
    if (!vis.cutBottom) { c.moveTo(vis.x, rect.y + rect.h); c.lineTo(vis.x + vis.w, rect.y + rect.h); }
    if (!vis.cutLeft) { c.moveTo(rect.x, vis.y); c.lineTo(rect.x, vis.y + vis.h); }
    if (!vis.cutRight) { c.moveTo(rect.x + rect.w, vis.y); c.lineTo(rect.x + rect.w, vis.y + vis.h); }
    c.stroke();
    if (vis.cutLeft || vis.cutTop || vis.cutRight || vis.cutBottom) {
      c.strokeStyle = "rgba(255, 196, 92, 0.95)";   // 琥珀: 与白色实线 (r-b=0) 和蓝色环带 (b>r) 都分得开
      c.setLineDash([lw * 4, lw * 3]);
      c.beginPath();
      if (vis.cutLeft) { c.moveTo(0, vis.y); c.lineTo(0, vis.y + vis.h); }
      if (vis.cutRight) { c.moveTo(W, vis.y); c.lineTo(W, vis.y + vis.h); }
      if (vis.cutTop) { c.moveTo(vis.x, 0); c.lineTo(vis.x + vis.w, 0); }
      if (vis.cutBottom) { c.moveTo(vis.x, H); c.lineTo(vis.x + vis.w, H); }
      c.stroke();
      c.setLineDash([]);
    }
    if (hasInner) {
      c.lineWidth = lw * 1.4;
      c.strokeStyle = "rgba(96, 200, 255, 0.95)";
      c.setLineDash([lw * 5, lw * 4]);
      c.strokeRect(inner.x, inner.y, inner.w, inner.h);
      c.setLineDash([]);   // 手柄的描边不能是虚线
    }
    // 三个框各自的分辨率都标在自己框外 (见 drawFrameLabels): 生成块 (绿) / 外框 (白) / 内框 (蓝)。
    // 由内到外传进去, 内框那枚先占好位置, 外侧两枚再依次找空位; 并把内框作为硬约束传下去,
    // 保证任何一枚标签都不会压到画笔区域上。
    const labels = [];
    if (hasInner) labels.push({ text: `内框 ${inner.w}×${inner.h}`, rect: inner, color: "rgba(170, 225, 255, 0.98)" });
    labels.push({ text: `外框 ${rect.w}×${rect.h}`, rect, color: "rgba(255, 255, 255, 0.98)" });
    if (grew) labels.push({ text: `生成 ${grown.w}×${grown.h}`, rect: grown, color: "rgba(150, 255, 190, 0.98)" });
    drawFrameLabels(c, labels, W, H, hasInner ? inner : null);
    // 右下角调整手柄 (拖它 = 固定左上角改宽高): 半径按缩放换算, 屏幕上始终同样大小
    if (state.tool === "crop") {
      const hc = cropHandleCenter(rect, { w: W, h: H });
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

  // 说明: 这里没有"自由描线"的辅助函数了 —— 局部重绘与涂鸦重绘都走 paintStroke 的
  // 网格填充 (逐格 fillRect), 所以不需要 lineWidth / lineCap 那一套描线参数。
  // 画笔大小、笔刷形状 (圆/方) 的统一换算都在 maskGrid.js 的 brushCells 里。

  // ---- 裁剪重绘: 画笔/橡皮只能在内侧框内使用 ----
  // 网格填充路径下不再用 canvas 的 clip 状态 (填充时会逐格判定), 只保留"当前生效的内框"查询。

  /** 当前生效的内框 (裁剪重绘启用时), 否则 null —— 蒙版格子是否允许落笔由它判定 */
  function activeInnerRect() {
    return isCropActive() && state.cropRect ? innerCropRect(state.cropRect) : null;
  }

  /** 某个 8x8 格子是否落在允许绘制的范围内 (裁剪重绘时限定在内框里) */
  function cellAllowed(x, y) {
    const inner = activeInnerRect();
    if (!inner) return true;
    // 格子必须完整落在内框内 (格子的四条边都不能越界)
    return x >= inner.x && y >= inner.y && x + MASK_CELL <= inner.x + inner.w && y + MASK_CELL <= inner.y + inner.h;
  }

  /**
   * 允许绘制的格范围 (闭区间) —— 落笔的 cellAllowed 与预览的封边判定共用它。
   * 预览要用它来判断"某格是不是被画布/内框裁掉了": 被裁掉的那一侧不该封边,
   * 否则预览会在图片边缘画出实际并不存在的轮廓线。
   */
  function maskClipRange() {
    const inner = activeInnerRect();
    if (inner) {
      return {
        c0: Math.ceil(inner.x / MASK_CELL),
        r0: Math.ceil(inner.y / MASK_CELL),
        c1: Math.floor((inner.x + inner.w) / MASK_CELL) - 1,
        r1: Math.floor((inner.y + inner.h) / MASK_CELL) - 1,
      };
    }
    return {
      c0: 0,
      r0: 0,
      c1: Math.floor(compositeCanvas.width / MASK_CELL) - 1,
      r1: Math.floor(compositeCanvas.height / MASK_CELL) - 1,
    };
  }

  /**
   * 把一组格子按"涂上 / 擦除"写入当前绘制层 (遮罩层或涂鸦层)。整格填满, 不留半透明。
   *
   * 先 destination-out 清一遍再画: 同一格被重复涂抹时结果仍然一致 (幂等),
   * 不会因为反复叠加而出现深浅不一。
   *
   * 颜色: 涂鸦层用用户选择的颜色 (是给用户看的引导内容); 遮罩层固定灰色 —— 语义只看 alpha,
   * 后端会把 alpha != 0 的格子涂白、其余涂黑。
   */
  function fillCells(cells, erase = false) {
    if (!cells || !cells.length) return;
    const layer = activeLayer();
    const c = ctx(layer);
    c.save();
    // 1) 先把这些格子清干净 (幂等的前提)
    c.globalCompositeOperation = "destination-out";
    for (const cell of cells) {
      const x = cell.c * MASK_CELL, y = cell.r * MASK_CELL;
      if (!cellAllowed(x, y)) continue;
      c.fillRect(x, y, MASK_CELL, MASK_CELL);
    }
    if (!erase) {
      // 2) 再整格画回去
      c.globalCompositeOperation = "source-over";
      c.fillStyle = state.mode === "涂鸦重绘" ? state.brushColor : "#808080";
      for (const cell of cells) {
        const x = cell.c * MASK_CELL, y = cell.r * MASK_CELL;
        if (!cellAllowed(x, y)) continue;
        c.fillRect(x, y, MASK_CELL, MASK_CELL);
      }
    }
    c.restore();
  }

  /**
   * 一次笔迹覆盖的格子集合 (形状已按 state.squareBrush 应用)。
   * 仅供需要"格子列表"而非"直接落笔"的调用方使用。
   */
  /** 绘制层: 涂鸦重绘/局部重绘共用一套网格化绘制; 只有涂鸦层额外用用户选的颜色 */
  function activeLayer() {
    return state.mode === "涂鸦重绘" ? doodleCanvas : maskCanvas;
  }

  /** 当前生效的笔刷形状 (Square Brush 勾选 = 方, 否则是圆) */
  const brushShape = () => (state.squareBrush ? BRUSH_SQUARE : BRUSH_ROUND);

  function cellsForStroke(x0, y0, x1, y1) {
    const layer = activeLayer();
    return strokeCellSet(
      x0, y0, x1, y1,
      state.brushSize, layer.width, layer.height,
      brushShape(),
    );
  }

  /**
   * 在绘制层上落一次笔 (起点 -> 终点)。
   *
   * 用 strokeCellSet 拿到**已按笔刷形状筛选**的格子 (圆会切掉四角, 方铺满),
   * 逐格填充 —— 这是笔刷形状真正生效的地方。涂鸦层与遮罩层走同一条路径,
   * 区别只在于涂鸦层用用户选择的颜色、遮罩层固定用灰色 (语义只看 alpha)。
   */
  function paintStroke(x0, y0, x1, y1) {
    const cells = cellsForStroke(x0, y0, x1, y1);
    fillCells(cells, state.tool === "eraser");
  }

  /**
   * 客户区坐标 -> 图像坐标 / 屏幕缩放。
   *
   * 不直接用 getBoundingClientRect 当基准: canvasWrap 是 overflow:hidden, 画布被滚轮缩放
   * (CSS transform) 移出可视区时 rect 会被裁到 wrap 边缘, 拿它算会得到错的偏移 —— 这正是
   * "滚轮缩放后画笔预览漂移" 的根因 (绘制不受影响, 因为 getPos 早先就该用同一套正确基准)。
   *
   * 统一用: 包含块原点 + 画布布局位置(offsetLeft/Top) + transform 平移(view.x/y)。
   * 画布的 transform-origin 是 0 0, 所以可见左上角 = 布局位置 + translate。
   */
  function canvasFrame() {
    const wrapRect = canvasWrap.getBoundingClientRect();
    const boxLeft = wrapRect.left + canvasWrap.clientLeft;   // 包含块原点的屏幕 X (rect 含边框)
    const boxTop = wrapRect.top + canvasWrap.clientTop;
    const originLeft = boxLeft + compositeCanvas.offsetLeft + view.x;   // 画布可见左上角 (屏幕)
    const originTop = boxTop + compositeCanvas.offsetTop + view.y;
    // 屏幕缩放 = 布局缩放 × 视图缩放; 不用 rect.width (会被裁切, 不可靠)
    const layoutScale = compositeCanvas.clientWidth > 0
      ? compositeCanvas.clientWidth / compositeCanvas.width
      : 1;
    const scale = layoutScale * (view.scale || 1);
    return { originLeft, originTop, boxLeft, boxTop, scale };
  }

  function getPos(e) {
    const f = canvasFrame();
    return {
      x: (e.clientX - f.originLeft) / f.scale,
      y: (e.clientY - f.originTop) / f.scale,
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
    const layer = activeLayer();
    pushHistory([layer]);
    // 遮罩层与涂鸦层走同一条网格化路径: 落点吸附到 8x8 格子中心后整格填充。
    // tail 记录上一个落点, 拖动时用来连成连续笔迹。
    const p = snapToCellCenter(x, y);
    strokeTail = p;
    paintStroke(p.x, p.y, p.x, p.y);
    renderComposite();
  }

  function moveStroke(e) {
    if (!state.drawing || !state.image) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    // 裁剪框选拖拽: 实时合法化外框并预览 (含尺寸标签); 拖右下角手柄时左上角固定不动
    if (cropDrag) {
      // 裁剪框要能拖到图片外面 (外框最多每边外扩 a, 由 normalizeCropRect 收敛到合法值):
      // 指针跑出画布时不夹回来, 否则永远拖不出"外框伸到图外、内框贴着图片边缘"的框。
      cropDrag.cx = x;
      cropDrag.cy = y;
      cropDrag.mx = e.clientX;
      cropDrag.my = e.clientY;
      cropDrag.rect = cropDrag.kind === "handle" ? rectFromHandleDrag(cropDrag)
        : cropDrag.kind === "move" ? rectFromMoveDrag(cropDrag) : rectFromDrag(cropDrag);
      // 拖拽期间就把"外框/内框/生成块"尺寸刷新到选框右上角的标签上, 而不是等松手才更新
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
    // 遮罩层与涂鸦层统一: 从上一次落点连线到本次落点, 覆盖到的格子整格填充。
    // 落点吸附格心 => 指针在同一个格子内小幅移动时吸附结果不变, 自然不会重复填充 (幂等)。
    const p = snapToCellCenter(x, y);
    if (!strokeTail) strokeTail = p;
    if (p.x !== strokeTail.x || p.y !== strokeTail.y) {
      paintStroke(strokeTail.x, strokeTail.y, p.x, p.y);
      strokeTail = p;
    }
    renderComposite();
  }

  function endStroke() {
    if (cropDrag) { commitCrop(); return; }   // 裁剪框选: 松开时提交
    if (shapeDrag) { commitShape(); return; }   // 选区: 松开时提交
    strokeTail = null;
    state.drawing = false;
  }

  compositeCanvas.addEventListener("pointerdown", startStroke);
  compositeCanvas.addEventListener("pointermove", moveStroke);
  compositeCanvas.addEventListener("pointerup", endStroke);
  // 兜底: 指针捕获万一没生效 (setPointerCapture 抛错时只有 try/catch 吞掉), 松手又发生在画布外,
  // 拖拽就会卡在"进行中"; 窗口级再收一次 pointerup —— 画布上那次已经提交过的话 cropDrag 已是 null,
  // 这里什么也不做 (幂等)。
  window.addEventListener("pointerup", () => {
    if (cropDrag) endStroke();
  });
  // 指针移出画布: 画笔/橡皮/选区到此结束 (与原来一致); 但裁剪框拖拽不能就此提交 ——
  // 本功能就是要把外框拖到图片外面去, 一离开画布就提交等于永远拖不出去 (松手才算结束)。
  compositeCanvas.addEventListener("pointerleave", () => {
    if (cropDrag) return;
    endStroke();
  });

  // ---- 画笔/橡皮悬停区域提示 ----
  // 蒙版画笔的预览: 只画出"这一笔的轮廓" (不填充内部, 避免密密麻麻一片), 并**吸附到格心** ——
  // 指针在同一个格子内移动时预览纹丝不动, 直观表达"只在网格上落笔"。
  // 涂鸦层是自由绘制, 预览直接跟随指针。
  const brushCursor = el("div", { class: "brush-cursor" });
  const brushCursorCells = el("div", { class: "brush-cursor-cells" });
  brushCursor.append(brushCursorCells);
  let lastPointer = null;   // 最近一次悬停位置 (滑条调大小时原地刷新用)

  /**
   * 当前笔刷覆盖的格子偏移 (形状已应用)。
   * 直接复用 maskGrid 的 brushCells —— 预览与实际落笔必须是同一个函数, 否则"预览画的格子"和
   * "真正涂上的格子"会对不上。结果按 (大小, 形状) 缓存 (指针每动一次都会调用)。
   */
  let brushSpanCache = { key: "", cells: [] };
  function brushSpanCells() {
    const key = state.brushSize + "|" + state.squareBrush;
    if (key === brushSpanCache.key) return brushSpanCache.cells;
    const cells = brushCells(state.brushSize, state.squareBrush ? BRUSH_SQUARE : BRUSH_ROUND);
    brushSpanCache = { key, cells };
    return cells;
  }

  /**
   * 重建预览。只画**轮廓**: 每个格子在"与空格相邻的那几条边"上画一段线,
   * 内部相邻的边不画 —— 于是大笔刷也只有一圈边框, 不会出现密密麻麻的网格线。
   * 软圆的外圈用弱线区分。
   *
   * 格子集合直接来自 strokeCellSetDetailed —— 与落笔**同一个函数**, 所以预览的范围
   * (包括在画布边缘被裁掉的部分) 与真正涂上的区域逐格一致。
   *
   * @param {number} cellScreen 一格在屏幕上的边长
   * @param {Array<{c:number,r:number}>} cells 已夹取好的格子
   * @param {number} originC 容器左上角对应的格坐标
   * @param {number} originR 同上 (行)
   * @param {{c0:number,r0:number,c1:number,r1:number}} clip 画布/内框允许的格范围 (闭区间)
   */
  let brushPreviewKey = "";
  function rebuildBrushPreview(cellScreen, cells, originC, originR, clip) {
    // 缓存键必须包含"格子范围 + 容器基准 + 允许范围": 贴到画布/内框边缘时笔刷会被裁掉一部分,
    // 同样的笔刷大小/形状在不同位置画出的轮廓并不相同。只按大小/形状缓存的话,
    // 移动 (或进出裁剪重绘) 时轮廓不会重建 —— 预览会一直显示上一次的形状。
    const bc0 = cells.length ? Math.min(...cells.map((k) => k.c)) : 0;
    const br0 = cells.length ? Math.min(...cells.map((k) => k.r)) : 0;
    const bc1 = cells.length ? Math.max(...cells.map((k) => k.c)) : 0;
    const br1 = cells.length ? Math.max(...cells.map((k) => k.r)) : 0;
    const key = [cellScreen, state.brushSize, state.squareBrush, originC, originR,
                 bc0, br0, bc1, br1, clip.c0, clip.r0, clip.c1, clip.r1].join("|");
    if (key === brushPreviewKey) return;
    brushPreviewKey = key;
    clear(brushCursorCells);
    if (!cells.length) {
      brushCursorCells.style.width = "0px";
      brushCursorCells.style.height = "0px";
      return;
    }
    // 容器尺寸 = 实际画出的格范围 (贴边被裁时比 span 小)
    brushCursorCells.style.width = (bc1 - originC + 1) * cellScreen + "px";
    brushCursorCells.style.height = (br1 - originR + 1) * cellScreen + "px";

    const occupied = new Set(cells.map((c) => c.c + "," + c.r));
    // 允许范围之外的格一律视为"没有内容": 这样在范围边界处会正常封边 (开口),
    // 而范围外的格子本身已经被调用方过滤掉、不会被画出来 —— 两者配合才不会出现密集网格。
    const inRange = (c, r) => c >= clip.c0 && c <= clip.c1 && r >= clip.r0 && r <= clip.r1;
    const has = (c, r) => inRange(c, r) && occupied.has(c + "," + r);

    // 每个格子只补"外露"的边; 边用一个细条 div 画出来。
    const edge = (x, y, w, h) => {
      const e = el("div", { class: "brush-cursor-edge" });
      e.style.left = x + "px";
      e.style.top = y + "px";
      e.style.width = w + "px";
      e.style.height = h + "px";
      brushCursorCells.append(e);
    };
    const T = Math.max(1, Math.round(cellScreen / 8));   // 细线粗细 (随缩放略变, 最小 1px)
    for (const cell of cells) {
      const { c, r } = cell;
      const x = (c - originC) * cellScreen;
      const y = (r - originR) * cellScreen;
      if (!has(c, r - 1)) edge(x, y - T / 2, cellScreen, T);                    // 上
      if (!has(c, r + 1)) edge(x, y + cellScreen - T / 2, cellScreen, T);       // 下
      if (!has(c - 1, r)) edge(x - T / 2, y, T, cellScreen);                    // 左
      if (!has(c + 1, r)) edge(x + cellScreen - T / 2, y, T, cellScreen);       // 右
    }
  }

  /** 更新悬停预览 (仅画笔/橡皮; 选区/裁剪时隐藏) */
  function updateBrushCursor(clientX, clientY) {
    const brushLike = state.tool === "brush" || state.tool === "eraser";
    if (!state.image || state.mode === "图生图" || !brushLike) {
      brushCursor.style.display = "none";
      lastPointer = null;
      return;
    }
    // 与 getPos 共用 canvasFrame: 预览定位与"落笔换算"必须是同一套基准,
    // 否则缩放后两者会各偏各的 (预览漂移, 而实际绘制是对的)。
    const f = canvasFrame();
    const { boxLeft, boxTop, scale } = f;
    const bl = f.originLeft - boxLeft;    // 画布可见左上角 (相对包含块)
    const bt = f.originTop - boxTop;
    const cellScreen = Math.max(1, MASK_CELL * scale);   // 一个 8x8 格子在屏幕上的边长
    const imgX = (clientX - f.originLeft) / scale;
    const imgY = (clientY - f.originTop) / scale;
    brushCursor.classList.toggle("eraser", state.tool === "eraser");
    brushCursor.classList.toggle("square", state.squareBrush);
    brushCursor.classList.toggle("grid-mode", true);   // 遮罩层与涂鸦层都用网格轮廓预览

    {
      // 预览与落笔共用 strokeCellSetDetailed —— 同一套吸附/夹取规则,
      // 所以预览的范围 (含在画布边缘被裁掉的部分) 与真正涂上的格子逐格一致。遮罩层与涂鸦层一致。
      const layer = activeLayer();
      const detail = strokeCellSetDetailed(
        imgX, imgY, imgX, imgY,
        state.brushSize, layer.width, layer.height,
        brushShape(),
      );
      // 容器左上角 = 落点格 (anchor) 往左上退, 退到能容纳整个笔刷形状为止
      const { lo, span } = brushSpan(state.brushSize);
      // 先按"允许绘制的范围"(裁剪重绘下是内框, 否则是整张画布) 过滤掉越界的格子。
      //
      // 这一步是必须的: 落笔时 cellAllowed() 会跳过内框外的格子, 所以它们根本不会被涂上。
      // 如果预览仍然把它们画出来, 轮廓的"封边"判定 has() 又认为它们没有邻居 (因为不在范围内),
      // 就会给每个越界格子单独封 4 条边 —— 表现为内框边缘出现一片密密麻麻的网格。
      const clip = maskClipRange();
      const inClip = (k) => k.c >= clip.c0 && k.c <= clip.c1 && k.r >= clip.r0 && k.r <= clip.r1;
      const cells = detail.cells.filter(inClip);
      if (!cells.length) { brushCursor.style.display = "none"; lastPointer = null; return; }
      const minC = Math.min(...cells.map((k) => k.c));
      const minR = Math.min(...cells.map((k) => k.r));
      const maxC = Math.max(...cells.map((k) => k.c));
      const maxR = Math.max(...cells.map((k) => k.r));
      // 先把基准放到 minC/minR, 再确保容器右/下边界能包住 maxC/maxR (跨度不超过 span)
      const originC = Math.max(minC, Math.min(detail.anchorC + lo, maxC - span + 1));
      const originR = Math.max(minR, Math.min(detail.anchorR + lo, maxR - span + 1));
      rebuildBrushPreview(cellScreen, cells, originC, originR, clip);
      brushCursorCells.style.display = "block";
      brushCursor.style.width = "0px";
      brushCursor.style.height = "0px";
      brushCursor.style.left = (bl + originC * MASK_CELL * scale) + "px";
      brushCursor.style.top = (bt + originR * MASK_CELL * scale) + "px";
    }
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
  let strokeTail = null;  // 蒙版笔画的上一个落点 (已吸附格心), 用来把拖动连成连续笔迹
  const shapeSizeLabel = el("div", { class: "shape-size-label" });

  const clampX = (x) => Math.max(0, Math.min(compositeCanvas.width, x));
  const clampY = (y) => Math.max(0, Math.min(compositeCanvas.height, y));

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "255,255,255";
    const n = parseInt(m[1], 16);
    return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
  }

  /** 射线法: 点是否在多边形内 (套索选区用) */
  function pointInPolygon(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
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

  /**
   * 拖拽中的形状预览 (只画在合成画布上, 不提交)。
   *
   * 遮罩层与涂鸦层都**必须把预览量化到 8x8 网格**: 否则用户看到的是一条平滑的椭圆/套索边界,
   * 松手后却变成一堆方格 —— 那就不叫所见即所得了。涂鸦层只是额外用用户选的颜色填充。
   */
  function drawShapePreview() {
    const d = shapeDrag;
    if (!d) return;
    const c = ctx(compositeCanvas);
    const cells = shapeCells(d);
    if (cells.length) {
      c.save();
      // 涂鸦层用用户颜色, 遮罩层固定灰色
      c.fillStyle = state.mode === "涂鸦重绘"
        ? `rgba(${hexToRgb(state.brushColor)},0.45)` : "rgba(128,128,128,0.45)";
      for (const { c: col, r } of cells) {
        const x = col * MASK_CELL, y = r * MASK_CELL;
        if (cellAllowed(x, y)) c.fillRect(x, y, MASK_CELL, MASK_CELL);
      }
      c.restore();
    }
    // 再补一圈虚线轮廓, 说明"松手后覆盖的就是这些格子"
    c.save();
    shapePath(c, d);
    c.lineWidth = Math.max(1, compositeCanvas.width / 500);
    c.strokeStyle = state.mode === "涂鸦重绘"
      ? `rgba(${hexToRgb(state.brushColor)}, 0.95)` : "rgba(128,128,128, 0.9)";
    c.setLineDash([MASK_CELL, MASK_CELL]);
    c.stroke();
    c.restore();
    updateShapeSizeLabel();
  }

  /** 实时尺寸标签: 跟随鼠标显示选区当前宽 x 高 (图像像素); 裁剪框选额外显示内框与生成块尺寸 */
  function updateShapeSizeLabel() {
    const d = cropDrag || shapeDrag;
    if (!d) return;
    if (cropDrag) {
      const r = cropDrag.rect;
      const inner = innerCropRect(r);
      const grown = expandedCropRect(r);
      shapeSizeLabel.textContent =
        `外框 ${r.w} × ${r.h} · 内框 ${innerSizeText(inner)} · 内缩 ${state.cropInset} · 生成 ${grown.w} × ${grown.h}`;
    } else {
      const w = Math.round(Math.abs(d.cx - d.sx));
      const h = Math.round(Math.abs(d.cy - d.sy));
      shapeSizeLabel.textContent = w + " × " + h;
    }
    // 与画笔预览同一套基准: 相对 canvasWrap 的**包含块原点** (getBoundingClientRect 含边框, 要减掉)
    const wrapRect = canvasWrap.getBoundingClientRect();
    const boxL = wrapRect.left + canvasWrap.clientLeft, boxT = wrapRect.top + canvasWrap.clientTop;
    shapeSizeLabel.style.left = Math.min(d.mx - boxL + 14, wrapRect.width - shapeSizeLabel.offsetWidth - 6) + "px";
    shapeSizeLabel.style.top = Math.min(d.my - boxT + 18, wrapRect.height - 26) + "px";
    if (!canvasWrap.contains(shapeSizeLabel)) canvasWrap.append(shapeSizeLabel);
    shapeSizeLabel.style.display = "block";
  }

  function hideShapeSizeLabel() { shapeSizeLabel.style.display = "none"; }

  /**
   * 松开: 把选区形状填充到当前绘制层。
   *
   * 遮罩层与涂鸦层都走网格化填充 —— 逐格判断该格是否落在选区内, 整格涂满,
   * 所以选区边界也被量化到 8x8 网格, 与画笔的落笔规则一致 (所见即所得的前提)。
   */
  function commitShape() {
    const d = shapeDrag;
    shapeDrag = null;
    state.drawing = false;
    hideShapeSizeLabel();
    if (!d) return;
    const layer = activeLayer();
    pushHistory([layer]);
    fillCells(shapeCells(d), false);
    renderComposite();
  }

  /**
   * 选区 -> 覆盖的格子集合。判定用"格心是否落在形状内 (矩形/椭圆)"或"格心是否在多边形内 (套索)",
   * 这样边界格子不会被整片吞掉, 形状的轮廓仍能看出来。
   */
  function shapeCells(d) {
    if (d.tool === "rect") {
      const x0 = Math.min(d.sx, d.cx), y0 = Math.min(d.sy, d.cy);
      const x1 = Math.max(d.sx, d.cx), y1 = Math.max(d.sy, d.cy);
      return collectCells(
        (c, r, x, y, mx, my) => mx >= x0 && mx <= x1 && my >= y0 && my <= y1,
        maskCanvas.width, maskCanvas.height,
      );
    }
    if (d.tool === "ellipse") {
      const cx0 = (d.sx + d.cx) / 2, cy0 = (d.sy + d.cy) / 2;
      const rx = Math.abs(d.cx - d.sx) / 2, ry = Math.abs(d.cy - d.sy) / 2;
      if (rx <= 0 || ry <= 0) return [];
      return collectCells(
        (c, r, x, y, mx, my) => ((mx - cx0) / rx) ** 2 + ((my - cy0) / ry) ** 2 <= 1,
        maskCanvas.width, maskCanvas.height,
      );
    }
    // 套索: 射线法判断格心是否在多边形内 (顶点不足 3 个时不成面)
    const pts = d.points || [];
    if (pts.length < 3) return [];
    return collectCells(
      (c, r, x, y, mx, my) => pointInPolygon(mx, my, pts),
      maskCanvas.width, maskCanvas.height,
    );
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

  /**
   * 裁剪重绘: 丢弃内侧框之外的蒙版内容 (画笔只允许在内侧框里用, 之前在全图模式下画的要裁掉)。
   * 蒙版与画布同尺寸, 直接用 clearRect 清掉四块边带即可 —— 比 getImageData 搬移更快,
   * 而且天然保持"整格"语义 (内框坐标本身就是 8 的倍数)。
   */
  function clipMaskToInner() {
    const r = state.cropRect;
    if (!r) return;
    const layer = activeLayer();   // 裁剪重绘对两种模式都生效, 清的是当前绘制层
    const c = ctx(layer);
    const inner = innerCropRect(r);
    if (inner.w <= 0 || inner.h <= 0) {
      c.clearRect(0, 0, layer.width, layer.height);
      return;
    }
    // 四条边带: 左 / 右 / 上 / 下 (互不重叠, 中间的矩形原样保留)
    c.clearRect(0, 0, inner.x, layer.height);                                                   // 左
    c.clearRect(inner.x + inner.w, 0, layer.width - inner.x - inner.w, layer.height);            // 右
    c.clearRect(inner.x, 0, inner.w, inner.y);                                                   // 上
    c.clearRect(inner.x, inner.y + inner.h, inner.w, layer.height - inner.y - inner.h);          // 下
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
      // 通知外部: 画布尺寸已就绪 (分辨率自动对齐); 第二参给出居中裁剪的结果供提示用
      if (onImageLoad) onImageLoad(img, cropResultOf(img));
      if (onChange) onChange();
      toast("基础图片已加载 🌸");
    };
    img.src = url;
    fileInput.value = "";
  }
  fileInput.addEventListener("change", () => loadFiles(fileInput.files));
  enableDrop(canvasWrap, { onFiles: (files) => loadFiles(files) });

  // 右上角移除图片按钮 (仅在加载图片后显示)
  const removeOverlayBtn = el("button", { class: "editor-remove-btn", style: "display:none;" });
  // 叉号用内联 SVG 而非 ✖ 文字字形: 文字字形会被 Twemoji 转成黑色 emoji 图片,
  // 与右侧白色 ⟲ (内联 SVG / currentColor) 看着"一黑一白"; 统一成 SVG 即都为白。
  removeOverlayBtn.append(
    elSvg("svg", { viewBox: "0 0 24 24", width: 13, height: 13, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }, [
      elSvg("path", { d: "M3 3l18 18M21 3L3 21" }),
    ]),
  );
  removeOverlayBtn.title = "移除图片并清空绘制";
  removeOverlayBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearImage();
  });

  // 右上角还原按钮 (移除按钮左侧): 复位滚轮缩放的默认位置与大小
  const restoreBtn = el("button", { class: "editor-restore-btn", title: "还原默认位置和大小", style: "display:none;" });
  restoreBtn.append(
    elSvg("svg", { viewBox: "0 0 24 24", width: 13, height: 13, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }, [
      elSvg("path", { d: "M3 12a9 9 0 1 0 3-6.7L3 8" }),
      elSvg("path", { d: "M3 3v5h5" }),
    ]),
  );
  restoreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    view = { scale: 1, x: 0, y: 0 };
    applyView();
  });

  // 滚轮以鼠标指针为中心放大/缩小 (基础图片区与全屏编辑共用同一个画布, 自动生效)
  canvasWrap.addEventListener("wheel", (e) => {
    if (!state.image) return;
    e.preventDefault();
    const r = compositeCanvas.getBoundingClientRect();
    // 画布未变换时的左上角 = 视觉左 - 平移量; 指针相对该左上角的位置即缩放不动点
    const L = r.left - view.x;
    const T = r.top - view.y;
    const cx = e.clientX - L;
    const cy = e.clientY - T;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(VIEW_MAX, Math.max(VIEW_MIN, view.scale * factor));
    if (newScale === view.scale) return;
    const ratio = newScale / view.scale;
    view.x = cx - (cx - view.x) * ratio;
    view.y = cy - (cy - view.y) * ratio;
    view.scale = newScale;
    applyView();
  }, { passive: false });

  function updateRemoveBtn() {
    const show = state.image ? "flex" : "none";
    removeOverlayBtn.style.display = show;
    restoreBtn.style.display = show;
  }

  function clearImage() {
    state.image = null;
    hideBrushCursor();
    hideShapeSizeLabel();
    resetHistory();
    [bgCanvas, maskCanvas, doodleCanvas].forEach((c) => ctx(c).clearRect(0, 0, c.width, c.height));
    clear(canvasWrap);
    canvasWrap.append(placeholder, restoreBtn, removeOverlayBtn);
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
    // 裁剪工具在两种重绘模式下都成立; 切走时交还给画笔 (回来时若还开着裁剪重绘则自动选回「裁剪」)
    if (state.cropMode && isPaintMode(m)) setTool("crop");
    else if (state.tool === "crop") setTool("brush");
    renderComposite();
    updateBrushSection();
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
    [shapeGroup, "crop", "▣ 裁剪", "选中即启用裁剪重绘 (局部重绘 / 涂鸦重绘都可用): 拖拽框出重绘区域, 外框是画笔够不到的那一圈 (64 的倍数, 面积不超过 1024×1024, 长宽不限), 内框向内缩 a 像素为画笔范围 (不设最小区域); 只能框选一个。外框会自动向外扩展成「生成块」(按边各扩 64 像素, 面积扩到贴近 1024×1024 上限为止; 某条边贴到图片边界就继续扩其它边, 所以像 832×1216 这种整图不超上限的图片能扩到覆盖全图, 绿色虚线框就是它), 生成分辨率取生成块尺寸; 扩出来那圈只作重绘上下文, 蒙版上是黑的, 不会被重绘。外框每边还可以自己拖到图片外 a 像素 (那几条边用琥珀色虚线标在图片边缘, 也不会再向外扩展): 拖手柄放大到头, 就是内框的右下缘正好压在图片边缘上 (左上角固定不动)。框好后切到画笔涂画, 或拖右下角手柄调整大小; 改选矩形/椭圆/套索即关闭"],
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
    // 裁剪只在两种重绘模式下成立 (局部重绘 / 涂鸦重绘), 其它模式一律退回画笔
    if (t === "crop" && !isPaintMode()) t = "brush";
    // 提示圈只对画笔/橡皮有意义; 选区/裁剪时隐藏
    if (t === "crop") hideBrushCursor();
    state.tool = t;
    if (t === "crop") state.cropMode = true;
    else if (t !== "brush" && t !== "eraser") state.cropMode = false;   // 矩形/椭圆/套索 = 关闭裁剪重绘
    if (shapeDrag || cropDrag) cancelShape();   // 拖拽中切工具: 取消当前选区
    strokeTail = null;   // 笔画中途被切走 (未收到 pointerup) 时兜底断开笔迹, 防止下一笔从上一次的落点连过来
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
  }
  const colorInput = el("input", { type: "color", value: state.brushColor });
  colorInput.addEventListener("input", () => { state.brushColor = colorInput.value; });
  // 颜色只对涂鸦重绘有意义 (遮罩层固定灰色: 后端只看 alpha, 颜色不含语义)。
  // 这块不再单独占一行, 而是并进「Square Brush」那一行 (见下面的 shapeColorRow)。
  const colorWrap = el("label", { class: "ed-color-inline" }, [
    el("span", { class: "ed-color-label", text: "颜色" }),
    colorInput,
  ]);
  colorWrap.title = "涂鸦笔刷的颜色 (仅涂鸦重绘使用; 局部重绘的遮罩只看覆盖范围, 颜色无语义)";
  // 大小滑条: 同时控制画笔和橡皮。单位是**格数** (4~50), 边长 = 该值 × 8 像素 ——
  // 与官网一致: 大小 4 -> 32px, 大小 50 -> 400px。
  const sizeCtl = sliderRow({ min: BRUSH_MIN, max: BRUSH_MAX, step: 1, value: state.brushSize });
  const sizeRow = el("div", { class: "ed-size-row" }, [
    el("span", { class: "ed-color-label", text: "大小" }),
    sizeCtl.node,
  ]);
  const refreshSizeTip = () => {
    const n = state.brushSize;
    sizeRow.title = `笔刷大小 = ${n} 格, 即边长 ${n * MASK_CELL} × ${n * MASK_CELL} 像素 (取值范围 ${BRUSH_MIN}~${BRUSH_MAX})`;
  };
  refreshSizeTip();
  sizeCtl.input.addEventListener("input", () => {
    state.brushSize = sizeCtl.get();
    brushPreviewKey = "";      // 大小变了, 预览 DOM 要按新的形状重建
    refreshSizeTip();
    // 悬停中调整大小: 预览即时跟随
    if (lastPointer) updateBrushCursor(lastPointer.x, lastPointer.y);
  });
  sizeCtl.node.style.flex = "1";
  sizeCtl.node.style.minWidth = "0";
  // Square Brush: 勾选 = 方形笔刷 (边长同「大小」), 取消 = 圆形 (外接正方形挖掉四角)。
  const squareChk = el("input", { type: "checkbox" });
  squareChk.checked = state.squareBrush;
  squareChk.addEventListener("change", () => {
    state.squareBrush = squareChk.checked;
    brushPreviewKey = "";   // 形状变了, 预览的格子集合要重算重建
    if (lastPointer) updateBrushCursor(lastPointer.x, lastPointer.y);
  });
  // Square Brush 与「颜色」同一行: 左 = 笔刷形状开关, 右 = 涂鸦颜色 (局部重绘时隐藏)
  const shapeColorRow = el("div", { class: "ed-size-row ed-brush-opts" }, [
    el("label", { class: "ed-square-label" }, [squareChk, el("span", { text: "Square Brush" })]),
    colorWrap,
  ]);
  shapeColorRow.title = "Square Brush: 勾选 = 方形笔刷 (边长 = 大小 × 8 像素), 取消 = 圆形 (四角会随大小增大而挖掉更多格子)";
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
  });
  const cropInsetRow = el("div", { class: "ed-size-row ed-inset-row" }, [
    el("span", { class: "ed-color-label", text: "内缩" }),
    cropInsetCtl.node,
  ]);
  cropInsetRow.title = "内侧框相对外侧框向内缩进的像素数 a (32-96, 步长 8); 这段环带只作为重绘上下文, 画笔涂不到";

  // ---- 裁剪重绘 (选中「▣ 裁剪」即启用, 仅局部重绘模式): 沿外框裁剪重绘, 画笔只能在内缩 a 的内框里画 ----
  // 这一块 (标题 + 📏 选框尺寸提示行) 整体挂在 brushSec 里、「选区工具」下方: 选中裁剪后顺着往下就是
  // "内缩 a" 与它算出来的外框/内框尺寸, 一条线读下来, 不用回头看面板顶部。
  // 8x8 网格说明 + 上传图片被居中裁剪的提示 (每次都让用户知道"画布到底被动了什么")
  brushSec = el("div", { class: "ed-sec ed-brush-sec" }, [
    el("div", { class: "ed-sec-title", text: "🖍️ 画笔 / 橡皮 / 选区" }),
    toolGroup,
    sizeRow,        // 大小: 格数 (4~50), 边长 = 值 × 8 像素
    shapeColorRow,  // Square Brush + 颜色 (同一行; 颜色仅涂鸦重绘可见)
    shapeGroup,
    cropInsetRow,   // 内缩 a: 紧贴选区工具 (只在「▣ 裁剪」选中时出现)
  ]);

  // 说明: 裁剪选框的尺寸不再用面板提示行, 也不再用单个合并标签 ——
  // 三个框 (生成块 / 外框 / 内框) 各自把分辨率画在自己框外 (见 drawFrameLabels),
  // 这样"哪条线对应哪个分辨率"一眼就能对上, 而且跟着缩放/平移自动走 (画在 canvas 上);
  // 标签一律画在框外, 内框边线以内只留给画笔, 三枚标签也不会互相压住。

  function updateBrushSection() {
    const isI2I = state.mode === "图生图";
    const cropOn = isCropActive();
    // 图生图不需要绘制: 画笔区与操作按钮行全部隐藏
    brushSec.classList.toggle("hidden", isI2I);
    historyRow.classList.toggle("hidden", isI2I);
    actionsRow.classList.toggle("hidden", isI2I);
    // 颜色只对涂鸦重绘有意义 (遮罩层固定灰色); 隐藏的是颜色那一小块, Square Brush 仍在同一行里
    colorWrap.classList.toggle("hidden", state.mode !== "涂鸦重绘");
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
  tools.append(
    el("div", { class: "ed-sec" }, [el("div", { class: "ed-sec-title", text: "🎨 重绘模式" }), modeGroup]),
    brushSec,     // 画笔 / 橡皮 / 选区 + 内缩 a + ✂️ 裁剪重绘 (后两者仅局部重绘模式下、选中「▣ 裁剪」时可见)
    historyRow,
    actionsRow,
  );
  wrap.append(canvasWrap, tools);
  container.append(wrap);

  /**
   * 导出蒙版。绘制层 (遮罩 / 涂鸦) 与画布同尺寸, 且只含 8x8 网格上的实心方块,
   * 所以直接导出即可 —— 不再需要"1/8 小画布放大回来"那一步, 也就不存在放大带来的边界误差。
   *
   * 注意导出的是**当前绘制层**: 局部重绘是遮罩层, 涂鸦重绘是涂鸦层 (后端只看 alpha,
   * 所以涂鸦的颜色不影响遮罩语义)。两种模式共用同一套裁剪 / 自动扩展规则。
   */
  async function buildMaskBlob() {
    const layer = activeLayer();
    const c = document.createElement("canvas");
    c.width = layer.width;
    c.height = layer.height;
    c.getContext("2d").drawImage(layer, 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }

  /**
   * 导出合成图 = 底图 + 涂鸦层。
   *
   * 刻意**不用 compositeCanvas**: 那块画布上还叠着选框 (外框 / 内框 / 生成块) 与蒙版半透明预览,
   * 直接导出会把界面上的线条一起吃进模型输入里 (涂鸦重绘送的就是这张合成图)。
   * 这里用一块离屏画布重新合成, 只保留真正的图像内容。
   */
  async function buildCompositeBlob() {
    const c = document.createElement("canvas");
    c.width = bgCanvas.width;
    c.height = bgCanvas.height;
    const cx = c.getContext("2d");
    cx.drawImage(bgCanvas, 0, 0);
    cx.drawImage(doodleCanvas, 0, 0);   // 涂鸦层为空时就是干净底图
    return new Promise((resolve) => c.toBlob(resolve, "image/png"));
  }

  /** 当前绘制层上是否已有任何笔迹 (裁剪重绘判断"只框选没涂画"用) */
  function hasMaskContent() {
    const layer = activeLayer();
    const { data } = ctx(layer).getImageData(0, 0, layer.width, layer.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  }

  /** 裁剪重绘: 只框选而没有使用画笔时, 默认把整个内侧框按网格涂满 (逐格填充, 与手工涂抹一致) */
  function fillInnerCropAsMask() {
    const r = state.cropRect;
    if (!r) return;
    const inner = innerCropRect(r);
    if (inner.w <= 0 || inner.h <= 0) return;
    const layer = activeLayer();
    const cells = collectCells(
      (c, row, x, y) => cellAllowed(x, y),
      layer.width, layer.height,
    );
    fillCells(cells, false);
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
    const compBlob = await buildCompositeBlob();
    const files = await uploadFiles([
      new File([bgBlob], "background.png"),
      new File([maskBlob], "mask.png"),
      new File([compBlob], "composite.png"),
    ]);
    const get = (name) => (files.find((f) => f.name === name) || {}).path;
    const result = {
      enabled: true,
      // 裁剪重绘时 mode 记成 "裁剪重绘" (后端据此走裁剪管线); 否则就是当前重绘模式。
      // doodle 单独标记: 涂鸦重绘送进模型的底图是合成图 (底图 + 涂鸦) 而不是干净底图 ——
      // 裁剪时也要保留这个区别, 所以不能用 mode 兼任。
      mode: cropOn ? "裁剪重绘" : state.mode,
      doodle: state.mode === "涂鸦重绘",
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
      if (onImageLoad) onImageLoad(img, cropResultOf(img));   // 同上: 带上居中裁剪结果
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
    /**
     * 裁剪重绘是否已框选生效。
     * 外面用它来放宽分辨率上限: 裁剪重绘的成图尺寸是原图尺寸、真正送进模型的是生成块
     * (面积 ≤ 1024×1024), 所以面板分辨率超上限也不影响出图。
     */
    isCropActive: () => isCropActive() && !!state.cropRect,
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
