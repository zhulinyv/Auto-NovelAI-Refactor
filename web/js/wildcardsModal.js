// ============================================================
// Wildcards 全屏编辑弹窗:
//   顶部: 提示词标签块编辑器 (参考 sd-webui-prompt-all-in-one)
//     - 提示词按英文逗号 / 换行 / "句点+空格" 拆分为可点击的标签块 (换行本身也占一个"⏎ 换行"块,
//       拼回文本时还原成真正的换行), 悬停可 删除/编辑/增减权重
//     - 双击空白处或点 ✏️ 切回文本输入 (手动输入保留, 自动补全可用)
//     - 卡片库中多选的卡片可拖拽进编辑器, 或点 "➕ 添加选中" 批量加入
//     - NAI 新版权重块 1.5::内容:: 整体算一个标签 (块内逗号不拆分)
//     - ⚖️ 权重模式可切换: 新版权重 (1.5::标签::) / 通用权重 ((标签:1.5)), 影响 ▲▼ 加权与新增权重的写法
//     - 所有编辑实时同步回原输入框
//   下方: Wildcards 面板全部功能 (views/wildcards.js)
// 触发按钮由 ui.js 的 wildcardsButton() 创建 (.wc-open-btn),
// 此处在 document 上做一次全局点击委托统一打开弹窗。
// ============================================================
import { $, $$, el, clear, toast, bus, wireAutocomplete } from "./ui.js";
import { post } from "./api.js";
import { renderPanel, cardSelection, cardDrag, promptSelection, vibeSelection, activeLib } from "./views/wildcards.js";
import { builtinPromptGroups } from "./data/builtinPrompts.js";
import { appState } from "./app.js";

let modalOpen = false;

/** 把弹窗输入框的值写回原输入框 (单行 input 会把换行合并为逗号), 并派发 input 事件联动保存/联动逻辑 */
function syncToSource(source, value) {
  if (!source || !source.isConnected) return;
  let v = value ?? "";
  if (source.tagName !== "TEXTAREA") v = v.replace(/\s*[\r\n]+\s*/g, ", ").replace(/,\s*$/, "");
  if (source.value === v) return;
  source.value = v;
  source.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------------- 提示词 ⇄ 标签块 解析 ----------------

/** 换行在标签数组里单独占一项 (渲染成 "⏎ 换行" 块), 这样切块再拼回文本时不会丢行 */
const BREAK = "\n";
const isBreak = (t) => t === BREAK;

/**
 * 按英文逗号 / 换行 / "句点+空格"(. ) 拆分为标签 (括号/方括号/花括号/尖括号内的分隔符不拆分;
 * NAI 权重块 数字::内容:: 内的分隔符不拆分, 支持嵌套)。
 * 句点必须紧跟一个半角空格才算分隔符, 单个 "1.5" 这类小数点原样保留。
 * 换行本身会作为一项 BREAK 保留在结果里 (连续 N 个换行 = N 项), 首尾换行丢弃。
 */
function splitTags(value) {
  const out = [];
  let buf = "";
  let depth = 0;    // () [] {} <> 括号深度
  let wDepth = 0;   // NAI 权重块 数字:: ... :: 嵌套深度
  const s = String(value ?? "").replace(/\r\n?/g, "\n");
  const openRe = /^\d*\.?\d+::/;   // "数字::" 视为权重块开始
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // 权重块开始: 数字:: (含 1.5:: / .5:: 等), 块内逗号不拆分
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      const m = openRe.exec(s.slice(i));
      if (m) { wDepth++; buf += m[0]; i += m[0].length - 1; continue; }
    }
    // 权重块结束: 不带数字前缀的 ::
    if (wDepth > 0 && ch === ":" && s[i + 1] === ":") { wDepth--; buf += "::"; i++; continue; }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth = Math.max(0, depth - 1);
    // 句点+空格 也算分隔 (只认 ". " 这一对, 单独一个 "." 留在标签里)
    const dotSep = ch === "." && s[i + 1] === " ";
    if ((ch === "," || ch === "\n" || dotSep) && depth === 0 && wDepth === 0) {
      out.push(buf);
      if (ch === "\n") out.push(BREAK);
      if (dotSep) i++;   // 连空格一起吃掉, 下一块不以空格开头
      buf = "";
    } else buf += ch;
  }
  out.push(buf);
  // 去空白: BREAK 原样保留, 其余 trim 后丢弃空项
  const tags = out.map((t) => (isBreak(t) ? t : t.trim())).filter((t) => t !== "");
  const res = [];
  for (const t of tags) {
    if (isBreak(t) && !res.length) continue;   // 开头的空行没有意义, 丢掉
    res.push(t);                                // 连续换行按原样保留 (N 个换行 = N 个换行块)
  }
  while (res.length && isBreak(res[res.length - 1])) res.pop();   // 结尾空行同理
  return res;
}

/** 标签数组 -> 提示词文本: 普通标签用 ", " 连接, 遇到 BREAK 换成真正的换行 */
function joinTags(tags) {
  let text = "";
  let needSep = false;
  for (const tag of tags) {
    if (isBreak(tag)) { text += "\n"; needSep = false; continue; }
    text += (needSep ? ", " : "") + tag;
    needSep = true;
  }
  return text;
}

/** 解析标签权重: 支持 (内容:权重) 通用形式与 NAI 新版 数字::内容:: 形式 (未闭合的 数字::内容 也兼容), 无权重时 weight = 1 */
function parseWeight(raw) {
  let m = /^\((.+):(\d*\.?\d+)\)$/.exec(raw);
  if (m) return { content: m[1], weight: parseFloat(m[2]), style: "paren" };
  m = /^(\d*\.?\d+)::([\s\S]*)::$/.exec(raw);   // NAI 新版闭合: 1.5::内容:: (内容可含逗号)
  if (m) return { content: m[2], weight: parseFloat(m[1]), style: "nai" };
  m = /^(\d*\.?\d+)::([\s\S]+)$/.exec(raw);     // NAI 新版未闭合: 1.5::内容
  if (m) return { content: m[2], weight: parseFloat(m[1]), style: "nai" };
  return { content: raw, weight: 1, style: "plain" };
}

/** 按权重模式格式化: nai = 新版权重 (1.5::内容::) / paren = 通用权重 ((内容:1.5)); 权重为 1 时不加 */
const fmtTag = (content, weight, mode = "paren") =>
  weight === 1 ? content : mode === "nai" ? `${weight}::${content}::` : `(${content}:${weight})`;

// 权重模式: "paren" = 通用权重 (默认, 兼容原行为) / "nai" = 新版权重; 选择持久化到 localStorage
const WEIGHT_MODE_KEY = "anr-wc-weight-mode";
let weightMode = "paren";
try {
  const savedMode = localStorage.getItem(WEIGHT_MODE_KEY);
  if (savedMode === "nai" || savedMode === "paren") weightMode = savedMode;
} catch { /* localStorage 不可用时使用默认值 */ }

/**
 * 打开 Wildcards 全屏弹窗。
 * @param {HTMLTextAreaElement|HTMLInputElement} source 触发弹窗的提示词输入框
 * @param {object} opts { title: 弹窗中显示的输入框名称 }
 */
export function openWildcardsModal(source, { title = "提示词", only = null } = {}) {
  if (modalOpen || !source) return;
  modalOpen = true;
  const onlyVibes = only === "vibes";   // 只显示 Vibe 库: 不展示提示词编辑器与其它两个库
  const initialValue = source.value ?? "";

  const overlay = el("div", { class: "wc-modal" });
  const box = el("div", { class: "wc-modal-box" });

  // ---- 头部 ----
  const closeBtn = el("button", { class: "btn btn-sm btn-danger", type: "button", text: "✖ 关闭" });
  const header = el("div", { class: "wc-modal-header" }, [
    el("div", { class: "wc-modal-title" }, [
      onlyVibes ? "🎭 Vibe 库" : "🃏 Wildcards",
      onlyVibes ? null : el("span", { class: "wc-modal-sub", text: title }),
    ]),
    closeBtn,
  ]);
  // Vibe 模式下只留"添加选中 / 清除选择"两个按钮
  const vibeBar = el("div", { class: "wc-vibe-bar" });

  // ---- 顶部: 提示词标签块编辑器 (双模式) ----
  const ta = el("textarea", { rows: 6, placeholder: source.placeholder || "在此输入提示词..." });
  ta.value = initialValue;
  const taBox = el("div", { class: "ta-box hidden" }, [ta]);
  const chipsView = el("div", { class: "prompt-chips" });
  const editor = el("div", { class: "wc-prompt-editor" }, [chipsView, taBox]);
  // 文本编辑视图的补全同样挂到 overlay: 弹窗内的滚动容器会裁剪普通定位的下拉
  wireAutocomplete(ta, taBox, { portal: overlay });

  const addSelBtn = el("button", {
    class: "btn btn-sm btn-primary",
    type: "button",
    text: "➕ 添加选中",
    disabled: true,
    title: "把下方库中选中的项批量加入提示词 (卡片库: 点击卡片选中/取消, 可跨分类, 双击编辑, 也可直接拖入; 提示词库: 点击标签多选)",
  });
  const weightModeBtn = el("button", {
    class: "btn btn-sm",
    type: "button",
    title: "切换权重模式 — 影响 ▲▼ 加减权重与新增权重的写法\n新版权重: 1.5::标签:: (NovelAI 新语法)\n通用权重: (标签:1.5) (通用语法)",
  });
  const refreshWeightModeBtn = () => { weightModeBtn.textContent = weightMode === "nai" ? "⚖️ 新版权重" : "⚖️ 通用权重"; };
  weightModeBtn.addEventListener("click", () => {
    weightMode = weightMode === "nai" ? "paren" : "nai";
    try { localStorage.setItem(WEIGHT_MODE_KEY, weightMode); } catch { /* 存不进去也不影响本次会话 */ }
    refreshWeightModeBtn();
    toast(weightMode === "nai" ? "权重模式: 新版权重 — 加权重将使用 1.5::标签::" : "权重模式: 通用权重 — 加权重将使用 (标签:1.5)", "info");
  });
  refreshWeightModeBtn();
  const clearSelBtn = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "✖ 清除选择",
    disabled: true,
    title: "清除当前库中选中的项 (卡片/提示词)",
  });
  const modeBtn = el("button", { class: "btn btn-sm", type: "button", text: "✏️ 文本编辑", title: "在 标签块视图 / 文本输入 之间切换 (手动输入保留)" });
  const translateBtn = el("button", {
    class: "btn btn-sm",
    type: "button",
    text: "🌐 翻译",
    title: "在线翻译没有译文的标签 (多源免费接口: 爱词霸/搜狗/阿里/有道/彩云/腾讯/Google 等自动切换, 结果缓存)",
  });

  const promptSec = el("div", { class: "wc-modal-prompt" }, [
    el("div", { class: "wc-modal-prompt-head" }, [
      el("span", { class: "wc-modal-prompt-label", text: "📝 " + title }),
      el("span", { class: "muted wc-prompt-hint", text: "编辑实时同步回原输入框, 可直接生成" }),
      el("span", { class: "spacer" }),
      weightModeBtn,
      addSelBtn,
      clearSelBtn,
      translateBtn,
      modeBtn,
    ]),
    editor,
  ]);

  // ---- 标签块渲染与操作 ----
  let mode = "tags";
  let chipDragIdx = -1;   // 正在拖拽的标签块索引
  let chipDropIdx = -1;   // 拖拽悬停的目标插入索引 (-1 表示原位)
  const zhCache = new Map();   // 标签 -> 中文翻译 (会话内缓存)
  let translating = false;

  const zhKey = (content) => (content || "").trim().toLowerCase().replace(/\s+/g, "_");

  // 内置提示词库自带的译文: 先查这张本地表, 查不到才走在线翻译。
  // 库里的标签大多不在 13 MB Danbooru 词典里, 只靠 /api/suggest/translate 会拿不到译文
  // (表现为"库里明明有译文, 添加到提示词后译文消失")。
  // 同名标签在"负面"分组里另有一套压制语义的译法 (如 sketch 素描/草稿), 这里先到先得,
  // 保证正面标签显示的还是正向译文。
  const builtinZh = new Map();
  for (const group of builtinPromptGroups) {
    for (const [en, zh] of group.tags) {
      const key = zhKey(en);
      if (!builtinZh.has(key)) builtinZh.set(key, zh);
    }
  }
  /** 标签译文: 会话内翻译缓存 > 内置词表 > 空 */
  const zhOf = (content) => zhCache.get(zhKey(content)) || builtinZh.get(zhKey(content)) || "";
  /** 本地与内置都没有译文, 才值得再发一次在线翻译 */
  const needZh = (content) => !zhOf(content);

  /** 批量获取缺失的翻译 (PAI 风格双语标签), 拿到后重渲染一次 */
  async function fetchTranslations(contents) {
    const missing = [...new Set(contents.filter((c) => c && needZh(c)).map(zhKey))];
    if (!missing.length || translating) return;
    translating = true;
    try {
      const res = await post("/api/suggest/translate", { tags: missing });
      Object.entries(res.translations || {}).forEach(([tag, zh]) => zhCache.set(zhKey(tag), zh || ""));
      if (mode !== "tags" || !modalOpen) return;
      // 输入/编辑状态打开时不整体重渲染 (避免冲掉正在输入的内容), 改为就地更新翻译
      if (chipsView.querySelector(".p-chip-input")) {
        const tags = splitTags(ta.value);
        [...chipsView.querySelectorAll(".p-chip")].forEach((chip, i) => {
          if (tags[i] === undefined || isBreak(tags[i])) return;   // 换行块的副标题不是译文, 不要覆盖
          const zhEl = chip.querySelector(".p-chip-zh");
          if (zhEl) zhEl.textContent = zhOf(parseWeight(tags[i]).content);
        });
        return;
      }
      renderChips();
    } catch { /* 翻译获取失败静默处理, 标签块仍正常显示 */ }
    finally { translating = false; }
  }

  function renderChips() {
    clear(chipsView);
    const tags = splitTags(ta.value);
    if (!tags.length) {
      chipsView.append(el("div", { class: "p-chips-empty", text: "提示词为空 — 点下方 ＋标签 直接输入 (回车添加); 双击空白切文本输入; 也可从卡片库点选 / 拖拽 / 点 \"添加选中\"" }));
      chipsView.append(makeAddChip());   // 空提示词时也要能在标签视图里直接添加标签
      return;
    }
    tags.forEach((raw, i) => chipsView.append(makeChip(raw, i)));
    chipsView.append(makeAddChip());
    // 收集未翻译的普通标签, 批量查询 (通配符 <分类:卡片名> 不翻译)
    const need = tags.filter((raw) => !isBreak(raw))
      .map((raw) => parseWeight(raw).content).filter((c) => c && !c.startsWith("<"));
    if (need.some((c) => needZh(c))) fetchTranslations(need);
  }

  /** 末尾的 "＋标签" 块: 点击展开输入框, 回车添加标签 (参考 PAI 添加关键词, 支持自动补全) */
  function makeAddChip() {
    const chip = el("div", { class: "p-chip p-chip-add", title: "添加标签", text: "＋ 标签" });
    chip.addEventListener("click", () => startAdd());
    return chip;
  }

  function startAdd() {
    const anchor = chipsView.querySelector(".p-chip-add");
    const inputChip = el("div", { class: "p-chip p-chip-add-input" });
    const input = el("input", { class: "p-chip-input", placeholder: "输入标签后回车 (可逗号分隔多个, Esc 取消)" });
    // portal 到弹窗 overlay: 补全下拉不会被标签块视图的 overflow 裁剪容器挡住。
    // 必须先于宿主 keydown 注册: 补全列表打开时 Enter/Tab/Esc 归它消费 (stopImmediatePropagation)
    const ac = wireAutocomplete(input, inputChip, { portal: overlay, comma: false });
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      ac.list.remove();   // 挂到 overlay 的下拉要跟着输入框一起收走
      const parts = splitTags(input.value);
      if (parts.length) {
        applyTags([...splitTags(ta.value), ...parts]);
        const add = chipsView.querySelector(".p-chip-add");
        if (add) startAdd();  // 保持输入状态, 方便连续添加
      } else {
        renderChips();
      }
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ac.list.remove();
      renderChips();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) commit(); else cancel(); });
    inputChip.append(input);
    if (anchor) chipsView.replaceChild(inputChip, anchor);
    else chipsView.append(inputChip);
    input.focus();
  }

  function applyTags(tags) {
    ta.value = joinTags(tags);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  ta.addEventListener("input", () => {
    syncToSource(source, ta.value);
    if (mode === "tags") renderChips();
  });

  function setWeight(i, delta) {
    const tags = splitTags(ta.value);
    if (!tags[i]) return;
    const { content, weight } = parseWeight(tags[i]);
    const next = Math.min(10, Math.max(0.1, Math.round((weight + delta) * 10) / 10));
    tags[i] = fmtTag(content, next, weightMode);
    applyTags(tags);
  }

  function removeTag(i) {
    const tags = splitTags(ta.value);
    tags.splice(i, 1);
    applyTags(tags);
  }

  function startEdit(i) {
    const tags = splitTags(ta.value);
    const { content, weight, style } = parseWeight(tags[i] ?? "");
    const chip = chipsView.children[i];
    if (!chip) return;
    let done = false;
    clear(chip);
    chip.classList.add("editing");
    // 编辑态禁止拖动: 否则在输入框里划选文字会被当成拖标签 (HTML5 drag 会抢走选区)
    chip.draggable = false;
    const input = el("input", { class: "p-chip-input", value: content });
    // 双击编辑同样支持补全: 只替换当前标签本身, 不补逗号
    const ac = wireAutocomplete(input, chip, { portal: overlay, comma: false });
    const commit = () => {
      if (done) return;
      done = true;
      ac.list.remove();   // 挂到 overlay 的下拉要跟着编辑框一起收走
      const v = input.value.trim();
      const t = splitTags(ta.value);
      if (!v) t.splice(i, 1);
      else t[i] = fmtTag(v, weight, style);
      applyTags(t);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      ac.list.remove();
      renderChips();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.stopPropagation(); cancel(); }
    });
    input.addEventListener("blur", commit);
    chip.append(input);
    input.focus();
    input.select();
  }

  /** 拖动排序 (普通标签块与换行块共用) */
  function wireChipDrag(chip, raw, i) {
    chip.draggable = true;
    chip.addEventListener("dragstart", (e) => {
      chipDragIdx = i;
      chipDropIdx = -1;
      chip.classList.add("chip-dragging");
      try {
        e.dataTransfer.setData("text/plain", raw);
        e.dataTransfer.effectAllowed = "move";
      } catch { /* 忽略 */ }
    });
    chip.addEventListener("dragend", () => {
      chipDragIdx = -1;
      chipDropIdx = -1;
      chip.classList.remove("chip-dragging");
      $$(".p-chip.drop-before", chipsView).forEach((c) => c.classList.remove("drop-before"));
    });
  }

  /** 换行块: 只是分隔符, 没有权重与文本编辑, 只保留删除 (可拖动调整位置) */
  function makeBreakChip(i) {
    const chip = el("div", {
      class: "p-chip p-chip-break",
      title: "换行分隔: 生成时是比逗号更强的断句 (拖动可排序)",
    }, [
      el("div", { class: "p-chip-row" }, [el("span", { class: "p-chip-text", text: "⏎" })]),
      el("div", { class: "p-chip-zh", text: "换行" }),   // 副标题固定在译文行, 与普通标签块的排版一致
    ]);
    wireChipDrag(chip, BREAK, i);
    chip.append(el("div", { class: "p-chip-ops" }, [
      el("span", { class: "p-op p-op-danger", title: "删除这个换行", text: "×", onclick: () => removeTag(i) }),
    ]));
    return chip;
  }

  function makeChip(raw, i) {
    if (isBreak(raw)) return makeBreakChip(i);
    const { content, weight } = parseWeight(raw);
    const zh = zhOf(content);
    const chip = el("div", { class: "p-chip", title: "拖动可排序; 双击编辑 (Esc 取消); 悬停显示操作按钮" }, [
      el("div", { class: "p-chip-row" }, [
        el("span", { class: "p-chip-text", text: content }),
        weight !== 1 ? el("span", { class: "p-chip-w", text: "×" + weight }) : null,
      ]),
      el("div", { class: "p-chip-zh", text: zh }),  // 始终占位, 保证有/无翻译的标签等高
    ]);
    wireChipDrag(chip, raw, i);
    const ops = el("div", { class: "p-chip-ops" }, [
      el("span", { class: "p-op", title: "降低权重 (−0.1)", text: "▼", onclick: () => setWeight(i, -0.1) }),
      el("span", { class: "p-op", title: "增加权重 (+0.1)", text: "▲", onclick: () => setWeight(i, +0.1) }),
      el("span", { class: "p-op", title: "编辑", text: "✎", onclick: () => startEdit(i) }),
      el("span", { class: "p-op p-op-danger", title: "删除", text: "×", onclick: () => removeTag(i) }),
    ]);
    // 加权按钮连点会被浏览器判为 dblclick; 操作按钮区域不触发编辑
    ops.addEventListener("dblclick", (e) => e.stopPropagation());
    chip.append(ops);
    chip.addEventListener("dblclick", (e) => {
      if (e.target instanceof Element && e.target.closest(".p-chip-ops")) return;
      if (e.target instanceof HTMLInputElement) return;   // 已在编辑态: 双击只是选中文字, 别重置输入
      // 进编辑会把原节点换成 <input>, 事件冒到 chipsView 时 target 已脱离 .p-chip,
      // 会被当成"双击空白"切到文本视图; 这里直接掐断冒泡
      e.stopPropagation();
      startEdit(i);
    });
    return chip;
  }

  // 标签块拖动排序: dragover 计算插入位置 (按行列阅读顺序), drop 重排
  chipsView.addEventListener("dragover", (e) => {
    if (chipDragIdx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const chips = [...chipsView.querySelectorAll(".p-chip:not(.p-chip-add):not(.p-chip-add-input)")];
    let target = -1;
    for (let k = 0; k < chips.length; k++) {
      if (k === chipDragIdx) continue;
      const r = chips[k].getBoundingClientRect();
      const past = r.bottom <= e.clientY + 2
        || (e.clientY >= r.top && e.clientY <= r.bottom && r.left + r.width / 2 <= e.clientX);
      if (!past) { target = k; break; }
    }
    $$(".p-chip.drop-before", chipsView).forEach((c) => c.classList.remove("drop-before"));
    if (target < 0) {
      // 拖过所有标签: 追加到末尾
      chipDropIdx = splitTags(ta.value).length;
      const addChip = chipsView.querySelector(".p-chip-add");
      if (addChip) addChip.classList.add("drop-before");
    } else {
      chipDropIdx = target;
      if (target !== chipDragIdx) chips[target].classList.add("drop-before");
    }
  });
  chipsView.addEventListener("drop", (e) => {
    if (chipDragIdx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const from = chipDragIdx;
    const to = chipDropIdx;
    chipDragIdx = -1;
    chipDropIdx = -1;
    const tags = splitTags(ta.value);
    if (to < 0 || to === from) { renderChips(); return; }
    const [moved] = tags.splice(from, 1);
    if (to >= tags.length) tags.push(moved);
    else tags.splice(to > from ? to - 1 : to, 0, moved);
    applyTags(tags);
  });

  // ---- 在线翻译: 补齐没有译文的标签 (离线词表没有的也能翻) ----
  let onlineTranslating = false;
  translateBtn.addEventListener("click", async () => {
    if (onlineTranslating) return;
    const tags = [...new Set(splitTags(ta.value)
      .filter((raw) => !isBreak(raw))
      .map((raw) => parseWeight(raw).content)
      .filter((c) => c && !c.startsWith("<") && needZh(c)))];   // 空译文也重试
    if (!tags.length) { toast("所有标签都已有译文 ✨", "info"); return; }
    onlineTranslating = true;
    translateBtn.disabled = true;
    const oldText = translateBtn.textContent;
    translateBtn.textContent = "⏳ 翻译中...";
    try {
      let n = 0;
      // 每批 20 个提交 (后端 4 线程并发翻译): 回来一批就先刷新, 长列表不用等全部翻完
      for (let i = 0; i < tags.length; i += 20) {
        const res = await post("/api/translate", { tags: tags.slice(i, i + 20) });
        Object.entries(res.translations || {}).forEach(([tag, zh]) => {
          zhCache.set(zhKey(tag), zh || "");
          if (zh) n++;
        });
        renderChips();
      }
      toast(n ? `已翻译 ${n} 个标签 🌐` : "没有翻译出结果, 可稍后重试", n ? "success" : "warning");
    } catch (e) {
      toast("在线翻译失败: " + e.message, "error");
    } finally {
      onlineTranslating = false;
      translateBtn.disabled = false;
      translateBtn.textContent = oldText;
    }
  });

  function setMode(m) {
    mode = m;
    chipsView.classList.toggle("hidden", m !== "tags");
    taBox.classList.toggle("hidden", m !== "text");
    modeBtn.textContent = m === "tags" ? "✏️ 文本编辑" : "🏷️ 标签视图";
    if (m === "tags") renderChips();
    else ta.focus();
  }
  modeBtn.addEventListener("click", () => setMode(mode === "tags" ? "text" : "tags"));
  chipsView.addEventListener("dblclick", (e) => {
    if (!e.target.closest(".p-chip")) setMode("text");
  });

  // ---- 批量加入选中的卡片 (按钮 / 拖拽共用); batch: [{type, names}], 支持跨分类 ----
  async function addCardsBatch(batch) {
    const total = (batch || []).reduce((a, b) => a + (b.names?.length || 0), 0);
    if (!total) {
      toast("请先在卡片库点击选择卡片 (再次点击取消, 双击编辑, 可跨分类多选)", "warning");
      return;
    }
    let added = 0;
    for (const { type, names } of batch) {
      for (const name of names) {
        try {
          const res = await post("/api/wildcards/add-to-prompt", { prompt: ta.value, type, name });
          ta.value = res.prompt ?? ta.value;
          added++;
        } catch (e) {
          toast(`添加 <${type}:${name}> 失败: ` + e.message, "error");
        }
      }
    }
    if (!added) return;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    syncToSource(source, ta.value);
    try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 忽略 */ }
    toast(`已添加 ${added} 张卡片到提示词 🌸`, "success");
    cardSelection.set({});   // 跨分类选择全部清空
  }

  addSelBtn.addEventListener("click", () => {
    if (activeLib.lib === "prompts") {
      const tags = [...promptSelection.tags];
      if (!tags.length) { toast("请先在提示词库点击标签多选", "warning"); return; }
      const cur = (ta.value || "").trim().replace(/,\s*$/, "");
      addTarget.set(cur ? `${cur}, ${tags.join(", ")}` : tags.join(", "));
      promptSelection.clear();
      toast(`已添加 ${tags.length} 个提示词到提示词 🌸`, "success");
    } else if (activeLib.lib === "vibes") {
      // Vibe 库: 交给生成页加进"风格迁移"并直接启用 (两边共享同一个素材库)
      const ids = [...vibeSelection.ids];
      if (!ids.length) { toast("请先在 Vibe 库点击选中条目 (再点取消)", "warning"); return; }
      bus.emit("vibes:add", ids);
      vibeSelection.clear();
      toast("已添加 " + ids.length + " 个 Vibe 到风格迁移 🎭", "success");
      if (onlyVibes) close();
    } else {
      // 卡片库: 跨分类逐桶添加
      addCardsBatch(Object.entries(cardSelection.map).map(([type, names]) => ({ type, names: names || [] })));
    }
  });
  clearSelBtn.addEventListener("click", () => {
    if (activeLib.lib === "prompts") promptSelection.clear();
    else if (activeLib.lib === "vibes") vibeSelection.clear();
    else cardSelection.set({});
  });
  /** 共用按钮状态: 随当前库和各自选择数量刷新 */
  function refreshSelBtns() {
    if (!addSelBtn.isConnected) return;
    let n;
    if (activeLib.lib === "prompts") n = promptSelection.tags.length;
    else if (activeLib.lib === "vibes") n = vibeSelection.count();
    else n = cardSelection.count();
    addSelBtn.disabled = !n;
    addSelBtn.textContent = n ? `➕ 添加选中 (${n})` : "➕ 添加选中";
    clearSelBtn.disabled = !n;
  }
  cardSelection.onChange(refreshSelBtns);
  promptSelection.onChange(refreshSelBtns);
  vibeSelection.onChange(refreshSelBtns);
  activeLib.onChange(refreshSelBtns);

  // ---- 拖拽: 卡片库 -> 提示词编辑器 ----
  editor.addEventListener("dragover", (e) => {
    if (!cardDrag.names?.length) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    editor.classList.add("drag-over");
  });
  editor.addEventListener("dragleave", (e) => {
    if (!editor.contains(e.relatedTarget)) editor.classList.remove("drag-over");
  });
  editor.addEventListener("drop", (e) => {
    if (!cardDrag.names?.length) return;
    e.preventDefault();
    editor.classList.remove("drag-over");
    const names = [...cardDrag.names];
    const type = cardDrag.type;
    cardDrag.type = null;
    cardDrag.names = [];
    addCardsBatch([{ type, names }]);   // 拖拽: 单一分类的一批卡片
  });

  // ---- 下方: Wildcards 面板全部功能 ----
  const body = el("div", { class: "wc-modal-body" });
  body.append(el("div", { class: "muted wc-modal-loading", text: "🌸 正在加载 Wildcards..." }));

  // 卡片面板的 "添加到当前输入框": 以弹窗输入框为准, 写回后同步原输入框并刷新标签块
  const addTarget = {
    get: () => ta.value,
    set: (v) => {
      ta.value = v ?? "";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 忽略 */ }
    },
  };

  function close() {
    if (!modalOpen) return;
    modalOpen = false;
    if (ta.value !== initialValue) {
      syncToSource(source, ta.value);
      try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 忽略 */ }
    }
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    document.body.style.overflow = "";
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  overlay.append(box);
  if (onlyVibes) {
    // 把两个按钮从已构建好的 promptSec 里移到顶部工具条 (promptSec 本身不插入 DOM)
    vibeBar.append(addSelBtn, clearSelBtn);
    box.append(header, vibeBar, body);
  } else {
    box.append(header, promptSec, body);
  }
  document.body.append(overlay);
  document.body.style.overflow = "hidden";

  renderPanel(body, { app: appState || null }, { addTarget, only }).catch((e) => {
    clear(body);
    body.append(el("div", { class: "card" }, [el("div", { class: "muted", text: "Wildcards 加载失败: " + e.message })]));
  });
  setMode("tags");
}

// 全局委托: 所有 .wc-open-btn 按钮 (ui.js wildcardsButton 创建) 点击打开弹窗
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest(".wc-open-btn") : null;
  if (!btn || !btn._wcTarget) return;
  e.preventDefault();
  openWildcardsModal(btn._wcTarget, { title: btn._wcTitle || "提示词" });
});
