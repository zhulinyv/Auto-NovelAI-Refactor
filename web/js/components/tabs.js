// ============================================================
// 页签条: 切换 + edgeScroll 横向滚动
// ============================================================
import { el, clear, edgeScroll, $$ } from "../ui.js";

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
