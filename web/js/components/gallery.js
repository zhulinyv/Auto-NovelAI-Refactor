// ============================================================
// 图片网格画廊: 选中 / 双击放大
// ============================================================
import { el, clear } from "../ui.js";
import { imageUrl } from "../api.js";
import { openLightbox } from "./lightbox.js";

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
