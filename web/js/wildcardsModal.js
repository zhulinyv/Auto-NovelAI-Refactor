// ============================================================
// Wildcards 全屏编辑弹窗:
//   顶部展示触发弹窗的那个提示词输入框 (大尺寸, 实时双向同步),
//   下方保留 Wildcards 页签的全部功能 (新建/搜索/编辑卡片等),
//   提供 "添加到当前输入框" 把卡片写回触发弹窗的输入框。
// 触发按钮由 ui.js 的 wildcardsButton() 创建 (.wc-open-btn),
// 此处在 document 上做一次全局点击委托统一打开弹窗。
// ============================================================
import { $, el, clear, toast, wireAutocomplete } from "./ui.js";
import { post } from "./api.js";
import { renderPanel } from "./views/wildcards.js";
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

/**
 * 打开 Wildcards 全屏弹窗。
 * @param {HTMLTextAreaElement|HTMLInputElement} source 触发弹窗的提示词输入框
 * @param {object} opts { title: 弹窗中显示的输入框名称 }
 */
export function openWildcardsModal(source, { title = "提示词" } = {}) {
  if (modalOpen || !source) return;
  modalOpen = true;
  const initialValue = source.value ?? "";

  const overlay = el("div", { class: "wc-modal" });
  const box = el("div", { class: "wc-modal-box" });

  // ---- 头部 ----
  const closeBtn = el("button", { class: "btn btn-sm btn-danger", type: "button", text: "✖ 关闭" });
  const header = el("div", { class: "wc-modal-header" }, [
    el("div", { class: "wc-modal-title" }, [
      "🃏 Wildcards",
      el("span", { class: "wc-modal-sub", text: title }),
    ]),
    closeBtn,
  ]);

  // ---- 顶部: 对应的提示词输入框 (自动补全与主界面一致) ----
  const ta = el("textarea", { rows: 6, placeholder: source.placeholder || "在此输入提示词..." });
  ta.value = initialValue;
  const taBox = el("div", { class: "ta-box" }, [ta]);
  const promptSec = el("div", { class: "wc-modal-prompt" }, [
    el("div", { class: "wc-modal-prompt-head" }, [
      el("span", { class: "wc-modal-prompt-label", text: "📝 " + title }),
      el("span", { class: "muted", text: "此处的编辑实时同步回原输入框, 可直接生成" }),
    ]),
    taBox,
  ]);
  wireAutocomplete(ta, taBox);

  // ---- 下方: Wildcards 页签全部功能 ----
  const body = el("div", { class: "wc-modal-body" });
  body.append(el("div", { class: "muted wc-modal-loading", text: "🌸 正在加载 Wildcards..." }));

  // 卡片面板的 "添加到当前输入框": 以弹窗输入框为准, 写回后同步原输入框
  const addTarget = {
    get: () => ta.value,
    set: (v) => {
      ta.value = v ?? "";
      syncToSource(source, ta.value);
      try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 非表单元素忽略 */ }
    },
  };

  function close() {
    if (!modalOpen) return;
    modalOpen = false;
    if (ta.value !== initialValue) {
      syncToSource(source, ta.value);
      try { source.dispatchEvent(new Event("change", { bubbles: true })); } catch { /* 非表单元素忽略 */ }
    }
    document.removeEventListener("keydown", onKey);
    overlay.remove();
    document.body.style.overflow = "";
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  ta.addEventListener("input", () => syncToSource(source, ta.value));
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  overlay.append(box);
  box.append(header, promptSec, body);
  document.body.append(overlay);
  document.body.style.overflow = "hidden";

  renderPanel(body, { app: appState || null }, { addTarget }).catch((e) => {
    clear(body);
    body.append(el("div", { class: "card" }, [el("div", { class: "muted", text: "Wildcards 加载失败: " + e.message })]));
  });
}

// 全局委托: 所有 .wc-open-btn 按钮 (ui.js wildcardsButton 创建) 点击打开弹窗
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest(".wc-open-btn") : null;
  if (!btn || !btn._wcTarget) return;
  e.preventDefault();
  openWildcardsModal(btn._wcTarget, { title: btn._wcTitle || "提示词" });
});
