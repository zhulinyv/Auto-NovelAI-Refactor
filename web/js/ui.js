// ============================================================
// UI 工具: DOM 创建、Toast、确认框、事件总线
// ============================================================

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    // textarea/input/select 的 value 必须用属性赋值 (setAttribute 对 textarea 无效)
    else if (k === "value" && (tag === "textarea" || tag === "input" || tag === "select")) node.value = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------- 文件选择器 (统一美化) ----------------

export function filePicker({ accept = "*", placeholder = "未选择文件", label = null } = {}) {
  const wrap = el("div", { class: "field" });
  if (label) wrap.append(el("label", { text: label }));
  const fileInput = el("input", { type: "file", style: "display:none" });
  fileInput.accept = accept;
  const nameBox = el("span", { class: "file-chip", text: placeholder });
  const btn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁 选择文件" });
  const clearBtn = el("button", { class: "btn btn-sm btn-clear-file", type: "button", text: "✖" });
  clearBtn.title = "清除选择";
  let current = "";
  btn.addEventListener("click", () => fileInput.click());
  clearBtn.addEventListener("click", () => {
    current = "";
    nameBox.textContent = placeholder;
  });
  // 统一上传: 拖入/选择都整体替换当前值 (不叠加)
  async function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    btn.disabled = true;
    btn.textContent = "⏳ 上传中...";
    try {
      const { uploadFiles } = await import("./api.js");
      const files = await uploadFiles([...fileList]);
      if (files.length) {
        current = files[0].path;
        nameBox.textContent = files[0].name;
        nameBox.title = files[0].path;
      }
    } catch (e) {
      toast("上传失败: " + e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "📁 选择文件";
      fileInput.value = "";
    }
  }
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  enableDrop(wrap, { onFiles: (files) => handleFiles(files), accept: accept === "*" ? "*" : accept });
  wrap.append(el("div", { class: "file-pick-row" }, [nameBox, btn, clearBtn]), fileInput);
  return {
    node: wrap,
    get: () => current,
    set: (v) => {
      current = v || "";
      nameBox.textContent = v ? v.split("/").pop() : placeholder;
      nameBox.title = v || "";
    },
  };
}

// ---------------- 矩形拖拽上传区 (单张图片) ----------------

/**
 * 矩形图片上传区: 单击选文件, 右上角 ✖ 清除, 支持拖拽替换。
 * 返回 { node, get, set, onChange, input }
 */
export function imageDropZone({ label = null, placeholder = "点击选择或拖入图片", value = "", onChange = null, zoneClass = "", native = false, dropNative = false } = {}) {
  const wrap = el("div", { class: "field" });
  if (label) wrap.append(el("label", { text: label }));
  const zone = el("div", { class: "img-drop-zone" + (zoneClass ? " " + zoneClass : "") });
  const empty = el("div", { class: "img-drop-empty", html: "🖼️<br>" + placeholder });
  const preview = el("img", { class: "img-drop-preview", style: "display:none;" });
  const close = el("button", { class: "img-drop-close", text: "✖", style: "display:none;" });
  close.title = "移除图片";
  const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none;" });
  let currentValue = "";

  const api = {
    node: wrap,
    get: () => currentValue,
    set: (v) => { currentValue = v || ""; render(); },
    onChange,
    input: fileInput,
  };

  function render() {
    if (currentValue) {
      import("./api.js").then(({ imageUrl }) => { preview.src = imageUrl(currentValue); });
      preview.style.display = "";
      empty.style.display = "none";
      close.style.display = "flex";
      zone.classList.add("has-image");
    } else {
      preview.style.display = "none";
      empty.style.display = "";
      close.style.display = "none";
      zone.classList.remove("has-image");
    }
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    try {
      const { uploadFiles } = await import("./api.js");
      const res = await uploadFiles([files[0]]);
      if (res.length) {
        currentValue = res[0].path;
        render();
        if (api.onChange) api.onChange(currentValue);
      }
    } catch (e) {
      toast("上传失败: " + e.message, "error");
    } finally {
      fileInput.value = "";
    }
  }

  async function nativePick() {
    try {
      const { pickFile } = await import("./api.js");
      const path = await pickFile();
      if (path) {
        currentValue = path;
        render();
        if (api.onChange) api.onChange(currentValue);
      }
    } catch (e) {
      toast("选择文件失败: " + e.message, "error");
    }
  }

  zone.addEventListener("click", (e) => {
    if (e.target.closest(".img-drop-close")) return;
    if (native) { nativePick(); } else { fileInput.click(); }
  });
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    currentValue = "";
    render();
    if (api.onChange) api.onChange("");
  });
  // dropNative: 拖入不上传, 改为打开系统文件选择框 (保持原始路径, 不复制文件)
  enableDrop(zone, {
    onFiles: (files) => {
      if (native && dropNative) { nativePick(); return; }
      handleFiles(files);
    },
  });

  zone.append(empty, preview, close, fileInput);
  wrap.append(zone);
  api.set(value);
  return api;
}


/**
 * 边缘滚动: 隐藏横向滚动条, 用左右渐变按钮滚动。
 * 悬停持续慢滚, 点击快速翻页。返回包裹容器。
 * @param {HTMLElement} scrollEl 需要横向滚动的元素
 */
export function edgeScroll(scrollEl) {
  const wrap = el("div", { class: "edge-scroll" });
  if (scrollEl.parentNode) scrollEl.parentNode.insertBefore(wrap, scrollEl);
  wrap.appendChild(scrollEl);
  scrollEl.classList.add("edge-scroll-track");
  const left = el("button", { class: "edge-btn edge-left", type: "button", html: "‹", title: "向左滚动" });
  const right = el("button", { class: "edge-btn edge-right", type: "button", html: "›", title: "向右滚动" });
  wrap.append(left, right);

  let hoverTimer = null;
  const speed = 7;
  function stopHover() { if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; } }
  function startHover(dir) {
    stopHover();
    hoverTimer = setInterval(() => { scrollEl.scrollLeft += dir * speed; }, 16);
  }
  left.addEventListener("mouseenter", () => startHover(-1));
  right.addEventListener("mouseenter", () => startHover(1));
  left.addEventListener("mouseleave", stopHover);
  right.addEventListener("mouseleave", stopHover);
  // 点击快速翻页 (约 3/4 屏)
  left.addEventListener("click", () => scrollEl.scrollBy({ left: -scrollEl.clientWidth * 0.75, behavior: "smooth" }));
  right.addEventListener("click", () => scrollEl.scrollBy({ left: scrollEl.clientWidth * 0.75, behavior: "smooth" }));

  function update() {
    const max = scrollEl.scrollWidth - scrollEl.clientWidth;
    left.classList.toggle("off", scrollEl.scrollLeft <= 0);
    right.classList.toggle("off", scrollEl.scrollLeft >= max - 1);
  }
  scrollEl.addEventListener("scroll", update, { passive: true });
  update();
  try { new ResizeObserver(update).observe(scrollEl); } catch {}
  return wrap;
}

/**
 * 输出信息处理: 短消息用右上角 toast, 长消息写入输出区 info-box。
 * @param {HTMLElement} infoEl 输出区的 info-box 元素
 * @param {string} message 消息文本
 */
export function showResult(infoEl, message) {
  if (!message) { if (infoEl) infoEl.textContent = ""; return; }
  const isShort = message.length <= 120 && !message.includes("\n");
  if (isShort) {
    if (infoEl) infoEl.textContent = "";
    let type = "info";
    if (message.includes("✅")) type = "success";
    else if (message.includes("❌")) type = "error";
    else if (message.includes("⚠️") || message.includes("🚀")) type = "info";
    toast(message, type);
  } else if (infoEl) {
    infoEl.textContent = message;
  }
}

function closeToastNode(node) {
  if (node.dataset.closing) return;
  node.dataset.closing = "1";
  node.classList.add("toast-out");
  node.addEventListener("animationend", () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 350); // 兜底
}

export function toast(message, type = "info", _duration = 0) {
  const box = document.getElementById("toasts");
  const node = el("div", { class: `toast ${type}` });
  const text = el("span", { class: "toast-text", text: message });
  const close = el("button", { class: "toast-close", type: "button", text: "✕", title: "关闭" });
  close.addEventListener("click", () => closeToastNode(node));
  node.append(text, close);
  box.append(node);
  // 10 秒后自动关闭 (也可手动点击 ✕)
  setTimeout(() => closeToastNode(node), 10000);
  return node;
}

// ---------------- 确认框 ----------------

export function confirmDialog(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = el("div", {
      style: "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:2000;display:flex;align-items:center;justify-content:center;",
    });
    const box = el("div", {
      class: "card",
      style: "width:340px;animation:pop-in 0.2s ease;",
    }, [
      el("div", { class: "card-title", text: danger ? "⚠️ 确认操作" : "💭 请确认" }),
      el("p", { style: "margin-bottom:16px;font-size:13.5px;", text: message }),
      el("div", { style: "display:flex;gap:10px;justify-content:flex-end;" }, [
        el("button", { class: "btn btn-sm", text: "取消", onclick: () => { overlay.remove(); resolve(false); } }),
        el("button", {
          class: danger ? "btn btn-sm btn-danger" : "btn btn-sm btn-primary",
          text: "确定",
          onclick: () => { overlay.remove(); resolve(true); },
        }),
      ]),
    ]);
    overlay.append(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
    document.body.append(overlay);
  });
}

// ---------------- 事件总线 ----------------

class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, []);
    this.map.get(name).push(fn);
  }
  off(name, fn) {
    const list = this.map.get(name) || [];
    this.map.set(name, list.filter((f) => f !== fn));
  }
  emit(name, payload) {
    for (const fn of this.map.get(name) || []) {
      try { fn(payload); } catch (e) { console.error("bus handler error", e); }
    }
  }
}

export const bus = new Bus();

// ---------------- 拖拽上传 (替换, 不叠加) ----------------

/**
 * 给元素挂拖拽上传: 拖入的图片文件会整体替换当前内容。
 * zone: 拖放目标; opts.onFiles(files): 收到文件后的处理 (单文件场景取 files[0])
 */
export function enableDrop(zone, { onFiles, accept = "image/*" } = {}) {
  let depth = 0;
  const ok = (f) => {
    if (accept === "image/*") return f.type.startsWith("image/") || /.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
    return true;
  };
  zone.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; zone.classList.add("drop-active"); });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; });
  zone.addEventListener("dragleave", () => { depth--; if (depth <= 0) { depth = 0; zone.classList.remove("drop-active"); } });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove("drop-active");
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    const imgs = files.filter(ok);
    if (!imgs.length) { toast("请拖入图片文件", "warning"); return; }
    onFiles(imgs);
  });
}


/**
 * 通用文件选择区域: 点击或拖拽选择单个文件 (accept 过滤), 上传后取回真实路径。
 * 返回 { node, get(), set(v) }。
 */
export function fileDropZone({ label = null, placeholder = "点击选择或拖入文件", accept = "", value = "", onChange = null } = {}) {
  const wrap = el("div", { class: "field" });
  if (label) wrap.append(el("label", { text: label }));
  const zone = el("div", { class: "img-drop-zone" });
  const empty = el("div", { class: "img-drop-empty", html: "📄<br>" + placeholder });
  const preview = el("div", { class: "file-drop-preview", style: "display:none;" });
  const close = el("button", { class: "img-drop-close", text: "✖", style: "display:none;" });
  close.title = "移除文件";
  const fileInput = el("input", { type: "file", accept, style: "display:none;" });
  let currentValue = "";

  const api = {
    node: wrap,
    get: () => currentValue,
    set: (v) => { currentValue = v || ""; render(); },
    onChange,
    input: fileInput,
  };

  function render() {
    if (currentValue) {
      preview.textContent = "📄 " + currentValue.split(/[\\/]/).pop();
      preview.style.display = "flex";
      empty.style.display = "none";
      close.style.display = "flex";
      zone.classList.add("has-image");
    } else {
      preview.style.display = "none";
      empty.style.display = "";
      close.style.display = "none";
      zone.classList.remove("has-image");
    }
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    try {
      const { uploadFiles } = await import("./api.js");
      const res = await uploadFiles([files[0]]);
      if (res.length) {
        currentValue = res[0].path;
        render();
        if (api.onChange) api.onChange(currentValue);
      }
    } catch (e) {
      toast("上传失败: " + e.message, "error");
    } finally {
      fileInput.value = "";
    }
  }

  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  enableDrop(zone, { onFiles: (fs) => handleFiles(fs), accept: accept || "*" });
  zone.addEventListener("click", () => fileInput.click());
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    api.set("");
    if (api.onChange) api.onChange("");
  });
  render();
  wrap.append(zone);
  zone.append(empty, preview, close);
  return api;
}


// ---------------- 提示词自动补全 (插入时补逗号) ----------------

let suggestTimer = null;

function insertSuggestion(textarea, suggestion) {
  const value = textarea.value;
  const parts = value.split(",");
  if (value.endsWith(",")) {
    parts.push(suggestion.split(",")[0]);
  } else {
    parts[parts.length - 1] = suggestion.split(",")[0];
  }
  // 末尾补逗号, 方便继续输入下一个标签
  textarea.value = parts.join(", ") + ", ";
  textarea.dispatchEvent(new Event("input"));
}

/** 为提示词输入框接入 /api/suggest 自动补全 (TAB 快速插入, ↑/↓ 切换, Enter 确认, Esc 关闭)。 */
export function wireAutocomplete(textarea, wrap) {
  const list = el("div", { class: "suggest-list hidden", style: "left:0;right:0;" });
  wrap.append(list);
  let items = [];
  let active = -1;

  function hide() { list.classList.add("hidden"); active = -1; }
  function setActive(i) {
    active = i;
    $$(".suggest-item", list).forEach((it, idx) => it.classList.toggle("active", idx === i));
    const act = $(".suggest-item.active", list);
    if (act) act.scrollIntoView({ block: "nearest" });
  }
  function renderItems(suggestions) {
    items = suggestions;
    active = -1;
    list.innerHTML = "";
    suggestions.forEach((s, i) => {
      const item = el("div", { class: "suggest-item", text: s });
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        insertSuggestion(textarea, s);
        hide();
      });
      item.addEventListener("mousemove", () => setActive(i));
      list.append(item);
    });
    list.classList.remove("hidden");
  }
  function insertActive() {
    if (active < 0) active = 0;
    const s = items[active];
    if (s) { insertSuggestion(textarea, s); hide(); }
  }

  textarea.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const text = textarea.value;
      if (!text.trim()) { hide(); return; }
      try {
        const { post } = await import("./api.js");
        const res = await post("/api/suggest", { text });
        if (!res.suggestions?.length) { hide(); return; }
        renderItems(res.suggestions);
      } catch { hide(); }
    }, 250);
  });

  textarea.addEventListener("blur", () => setTimeout(hide, 200));

  // 键盘: TAB 快速插入 tag, ↑/↓ 切换候选, Enter 确认, Esc 关闭
  textarea.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden")) return;
    if (e.key === "Tab") {
      e.preventDefault();
      insertActive();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1 < items.length ? active + 1 : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1 >= 0 ? active - 1 : items.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      insertActive();
    } else if (e.key === "Escape") {
      hide();
    }
  });
}


/**
 * 统一滑条控件: 左侧 range, 右侧可直接键入数值。
 * 返回 { node, input(range), num(number input), get(), set(v) }
 */
export function sliderRow(spec) {
  const min = spec.min ?? 0;
  const max = spec.max ?? 100;
  const step = spec.step ?? 1;
  const value = spec.value ?? 0;
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  const clampSnap = (v) => {
    if (!Number.isFinite(v)) return null;
    v = Number(Math.min(max, Math.max(min, v)).toFixed(decimals));
    if (decimals === 0) v = Math.round(v);
    return v;
  };
  const range = el("input", { type: "range", min: min, max: max, step: step, value: value });
  const num = el("input", { type: "number", class: "slider-num", min: min, max: max, step: step });
  num.value = String(value);
  range.addEventListener("input", () => { num.value = range.value; });
  const commitNum = () => {
    const v = clampSnap(parseFloat(num.value));
    if (v === null) { num.value = range.value; return; }
    range.value = v;
    num.value = String(v);
  };
  num.addEventListener("input", () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) range.value = v;
  });
  num.addEventListener("change", commitNum);
  num.addEventListener("blur", commitNum);
  num.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commitNum(); num.blur(); }
  });
  return {
    node: el("div", { class: "slider-row" }, [range, num]),
    input: range,
    num: num,
    get: () => Number(range.value),
    set: (v) => {
      const n = clampSnap(Number(v));
      if (n === null) return;
      range.value = n;
      num.value = String(n);
    },
  };
}

// ---------------- 自绘下拉 (替换原生弹层, 全局自动生效) ----------------

const fsApi = new WeakMap();

export function initFancySelects() {
  if (initFancySelects._installed || typeof MutationObserver === "undefined") return;
  initFancySelects._installed = true;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes && m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if (n.tagName === "SELECT") enhanceSelect(n);
        else if (n.querySelectorAll) n.querySelectorAll("select").forEach(enhanceSelect);
      });
      if (m.type === "childList" && m.target.tagName === "SELECT" && fsApi.has(m.target)) {
        fsApi.get(m.target).rebuild();
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function enhanceSelect(sel) {
  if (!sel || sel.dataset.fancy) return;
  sel.dataset.fancy = "1";
  const wrapDiv = document.createElement("div");
  wrapDiv.className = "fs-wrap";
  sel.parentNode.insertBefore(wrapDiv, sel);
  wrapDiv.append(sel);
  sel.classList.add("fs-hidden");
  const txt = el("span", { class: "fs-text" });
  const ctrl = el("button", { type: "button", class: "fs-control" }, [txt, el("span", { class: "fs-caret" })]);
  const list = el("div", { class: "fs-list" });
  wrapDiv.append(ctrl, list);

  function syncText() {
    const opt = sel.options[sel.selectedIndex];
    txt.textContent = opt ? opt.textContent : "";
  }
  function buildItems() {
    clear(list);
    [...sel.options].forEach((opt) => {
      const item = el("div", { class: "fs-item", text: opt.textContent });
      item.dataset.value = opt.value;
      if (opt.selected) item.classList.add("active");
      item.addEventListener("click", () => {
        if (String(sel.value) !== String(opt.value)) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncText();
        markActive();
        setOpen(false);
      });
      list.append(item);
    });
  }
  function markActive() {
    $$(".fs-item", list).forEach((it) => it.classList.toggle("active", String(it.dataset.value) === String(sel.value)));
  }
  function setOpen(open) {
    wrapDiv.classList.toggle("open", open);
    if (open) {
      // 关掉其它已打开的下拉
      $$(".fs-wrap.open").forEach((w) => { if (w !== wrapDiv) w.classList.remove("open"); });
      requestAnimationFrame(() => {
        const act = $(".fs-item.active", list);
        if (act) act.scrollIntoView({ block: "nearest" });
      });
    }
  }
  ctrl.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!wrapDiv.classList.contains("open"));
  });
  if (!initFancySelects._docBound) {
    initFancySelects._docBound = true;
    document.addEventListener("click", () => {
      $$(".fs-wrap.open").forEach((w) => w.classList.remove("open"));
    });
  }
  sel.addEventListener("change", () => { syncText(); markActive(); });
  // 拦截程序化赋值 (xxx.set(v)), 同步显示
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(sel, "value", {
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); syncText(); markActive(); },
    });
  } catch { /* 老浏览器忽略 */ }
  fsApi.set(sel, { rebuild: () => { buildItems(); syncText(); markActive(); } });
  fsApi.get(sel).rebuild();
}

// ---------------- 分组渲染 ----------------

/** 简单可复用的小组件: 返回 {node, getValue, setValue} */
export function makeField(spec, state) {
  const wrap = el("div", { class: "field", "data-field": spec.id });
  const label = el("label", {}, [
    document.createTextNode(spec.label || spec.id),
    spec.description ? el("span", { class: "hint", text: spec.description }) : null,
  ]);

  const inputId = `fld-${Math.random().toString(36).slice(2, 8)}`;
  let input;

  switch (spec.type) {
    case "textarea": {
      input = el("textarea", {
        id: inputId,
        rows: spec.rows || 3,
        placeholder: spec.placeholder || "",
        value: spec.default ?? "",
      });
      wrap.append(label, input);
      if (spec.autocomplete) wireAutocomplete(input, wrap);
      return {
        node: wrap,
        getValue: () => input.value,
        setValue: (v) => { input.value = v; },
      };
    }
    case "text": {
      input = el("input", { id: inputId, type: "text", placeholder: spec.placeholder || "", value: spec.default ?? "" });
      wrap.append(label, input);
      if (spec.autocomplete) wireAutocomplete(input, wrap);
      return {
        node: wrap,
        getValue: () => input.value,
        setValue: (v) => { input.value = v; },
      };
    }
    case "number": {
      input = el("input", { id: inputId, type: "number", value: spec.default ?? 0 });
      break;
    }
    case "slider": {
      const s = sliderRow({ min: spec.min ?? 0, max: spec.max ?? 100, step: spec.step ?? 1, value: spec.default ?? 0 });
      wrap.append(label, s.node);
      return {
        node: wrap,
        getValue: () => s.get(),
        setValue: (v) => s.set(v),
      };
    }
    case "checkbox": {
      input = el("input", { id: inputId, type: "checkbox" });
      input.checked = !!spec.default;
      wrap.append(el("label", { class: "checkline", for: inputId }, [input, document.createTextNode(spec.label)]));
      return {
        node: wrap,
        getValue: () => input.checked,
        setValue: (v) => { input.checked = !!v; },
      };
    }
    case "checkbox_group":
    case "radio":
    case "select": {
      const options = spec.options || [];
      if (spec.type === "select") {
        input = el("select", { id: inputId }, options.map((o) =>
          el("option", { value: o, text: o, selected: o === (spec.default ?? options[0]) })
        ));
        wrap.append(label, input);
        return {
          node: wrap,
          getValue: () => input.value,
          setValue: (v) => { input.value = v; },
        };
      }
      // radio / checkbox_group
      const group = el("div", { class: "opt-group" });
      const opts = options.map((o) => {
        const item = el("label", { class: "opt-item", "data-value": o }, [
          o,
        ]);
        item.addEventListener("click", () => {
          if (spec.type === "radio") {
            $$(".opt-item", group).forEach((x) => x.classList.remove("selected"));
            item.classList.add("selected");
          } else {
            item.classList.toggle("selected");
          }
          if (input.onchange) input.onchange();
        });
        return item;
      });
      group.append(...opts);
      // 记录选中状态
      input = { value: null, onchange: null };
      const selectDefaults = () => {
        const defs = spec.type === "radio"
          ? [String(spec.default ?? options[0])]
          : (spec.default || []).map(String);
        $$(".opt-item", group).forEach((x) => {
          x.classList.toggle("selected", defs.includes(x.dataset.value));
        });
      };
      selectDefaults();
      wrap.append(label, group);
      return {
        node: wrap,
        getValue: () => {
          const sel = $$(".opt-item.selected", group).map((x) => x.dataset.value);
          return spec.type === "radio" ? (sel[0] ?? null) : sel;
        },
        setValue: (v) => {
          if (spec.type === "radio") {
            $$(".opt-item", group).forEach((x) => x.classList.toggle("selected", x.dataset.value === v));
          } else {
            $$(".opt-item", group).forEach((x) => x.classList.toggle("selected", (v || []).includes(x.dataset.value)));
          }
        },
      };
    }
    case "color": {
      input = el("input", { id: inputId, type: "color", value: spec.default || "#ff8fab" });
      wrap.append(label, input);
      return { node: wrap, getValue: () => input.value, setValue: (v) => { input.value = v; } };
    }
    case "image": {
      // 图片: 只能点击选择 (插件直接处理传入的原始文件地址, 不上传; 拖入同样打开系统选择框)
      const dz = imageDropZone({
        label: spec.label,
        placeholder: spec.placeholder || "点击选择图片",
        value: spec.default || "",
        native: true,
        dropNative: true,
      });
      return {
        node: dz.node,
        getValue: () => dz.get(),
        setValue: (v) => dz.set(v),
      };
    }
    case "filearea": {
      // 文件: 拖拽/点击选择区域 (accept 过滤), 直接上传到服务器取回真实路径
      const zone = fileDropZone({
        label: spec.label,
        placeholder: spec.placeholder || "点击选择或拖入文件",
        accept: spec.accept || "",
        value: spec.default || "",
      });
      return {
        node: zone.node,
        getValue: () => zone.get(),
        setValue: (v) => zone.set(v),
      };
    }
    case "path": {
      // 路径: 可手动输入, 也可用原生对话框选择文件夹或文件 (直接填真实路径, 不上传)
      const pathInput = el("input", { type: "text", placeholder: spec.placeholder || "输入或选择路径", value: spec.default || "" });
      const buttons = [];
      let currentValue = spec.default || "";
      pathInput.addEventListener("input", () => { currentValue = pathInput.value.trim(); });
      async function setPath(p) { if (p) { currentValue = p; pathInput.value = p; } }
      if (spec.folder !== false) {
        const dirBtn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁 文件夹", title: "选择文件夹" });
        dirBtn.addEventListener("click", async () => {
          try { const { pickFolder } = await import("./api.js"); setPath(await pickFolder()); }
          catch (e) { toast("选择文件夹失败: " + e.message, "error"); }
        });
        buttons.push(dirBtn);
      }
      if (spec.file !== false) {
        const fileBtn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "🖼️ 文件", title: "选择文件" });
        fileBtn.addEventListener("click", async () => {
          try { const { pickFile } = await import("./api.js"); setPath(await pickFile()); }
          catch (e) { toast("选择文件失败: " + e.message, "error"); }
        });
        buttons.push(fileBtn);
      }
      const row = el("div", { class: "file-pick-row" }, [pathInput, ...buttons]);
      wrap.append(label, row);
      return {
        node: wrap,
        getValue: () => currentValue,
        setValue: (v) => {
          currentValue = v || "";
          pathInput.value = v || "";
        },
      };
    }
    case "info":
    default: {
      wrap.append(label, el("div", { class: "info-box", html: spec.default || spec.label || "" }));
      return { node: wrap, getValue: () => null, setValue: () => {} };
    }
  }

  wrap.append(label, input);
  return {
    node: wrap,
    getValue: () => input.value,
    setValue: (v) => { input.value = v; },
  };
}
