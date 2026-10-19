// ============================================================
// 全窗口看图 (Lightbox): 单击缩放, 点空白或 Esc 关闭
// ============================================================
import { el } from "../ui.js";

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
