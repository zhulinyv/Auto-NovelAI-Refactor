// ============================================================
// 图片筛选视图
// ============================================================
import { $, el, clear, toast } from "../ui.js";
import { post, imageUrl } from "../api.js";

let S = null;
let currentPath = null;
let previewEl = null;
let infoEl = null;
let loadBtn = null;
let fullBtn = null;

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["🗂️ 图片筛选", el("span", { class: "sub", text: "批量浏览并整理图片" })]),
  );

  const inCard = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, ["📂 输入"]),
  ]);
  const pathInput = el("input", { type: "text", placeholder: "图片目录路径, 例如: D:/images", style: "flex:1;min-width:0;" });
  const pathBtn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁 选择文件夹" });
  pathBtn.addEventListener("click", async () => {
    try {
      const res = await post("/api/pick-folder", {});
      if (res.path) {
        pathInput.value = res.path;
        toast("已选择目录: " + res.path + " 📂", "success");
        // 选择目录后自动加载图片
        await selectorAction("/api/selector/load", { path: res.path });
      }
    } catch (e) { toast(e.message, "error"); }
  });
  loadBtn = el("button", { class: "btn btn-primary btn-sm", text: "🔄 加载图片" });
  const dir1 = el("input", { type: "text", placeholder: "目录1 (移动/复制到此)", style: "flex:1;min-width:0;" });
  const dir2 = el("input", { type: "text", placeholder: "目录2 (移动/复制到此)", style: "flex:1;min-width:0;" });
  const dir1Btn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁" });
  dir1Btn.title = "选择目录1";
  dir1Btn.addEventListener("click", () => pickFolder(dir1));
  const dir2Btn = el("button", { class: "btn btn-sm btn-file", type: "button", text: "📁" });
  dir2Btn.title = "选择目录2";
  dir2Btn.addEventListener("click", () => pickFolder(dir2));
  inCard.append(
    el("div", { style: "display:flex;gap:8px;margin-bottom:10px;" }, [pathInput, pathBtn, loadBtn]),
    el("div", { class: "grid grid-2" }, [
      el("div", { class: "field" }, [el("label", { text: "目录1" }), el("div", { style: "display:flex;gap:8px;" }, [dir1, dir1Btn])]),
      el("div", { class: "field" }, [el("label", { text: "目录2" }), el("div", { style: "display:flex;gap:8px;" }, [dir2, dir2Btn])]),
    ]),
  );

  fullBtn = el("button", { class: "btn btn-sm btn-ghost", type: "button", text: "⛶ 全窗口", style: "display:none;" });
  fullBtn.title = "全窗口显示当前图片";
  fullBtn.addEventListener("click", () => openFullscreenPreview());
  const mainCard = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title", style: "display:flex;align-items:center;justify-content:space-between;width:100%;" }, [
      el("span", { text: "🖼️ 预览" }),
      fullBtn,
    ]),
  ]);
  previewEl = el("div", { style: "text-align:center;min-height:300px;display:flex;align-items:center;justify-content:center;color:var(--text-2);", text: "加载目录后显示图片" });
  infoEl = el("div", { class: "info-box", style: "margin-top:10px;" });
  mainCard.append(previewEl, infoEl);

  // 操作按钮
  const actCard = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, ["🎛️ 操作"]),
  ]);
  const actions = el("div", { style: "display:flex;flex-direction:column;gap:8px;" });
  const btnDefs = [
    ["↩️ 撤销", () => selectorAction("/api/selector/undo")],
    ["⏭️ 跳过", () => selectorAction("/api/selector/next")],
    ["📥 移动到目录1", () => selectorAction("/api/selector/move", { output_path: dir1.value, current: currentPath })],
    ["📥 移动到目录2", () => selectorAction("/api/selector/move", { output_path: dir2.value, current: currentPath })],
    ["📋 复制到目录1", () => selectorAction("/api/selector/copy", { output_path: dir1.value, current: currentPath })],
    ["📋 复制到目录2", () => selectorAction("/api/selector/copy", { output_path: dir2.value, current: currentPath })],
    ["🗑️ 删除", () => selectorAction("/api/selector/delete", { current: currentPath }), true],
  ];
  btnDefs.forEach(([text, fn, danger]) => {
    actions.append(el("button", { class: "btn btn-sm" + (danger ? " btn-danger" : ""), style: "width:100%;min-height:40px;font-size:14px;", text, onclick: fn }));
  });
  actCard.append(actions);

  // 左右结构: 左=预览, 右=输入+操作
  const layout = el("div", { class: "grid", style: "grid-template-columns:1.6fr 1fr;align-items:start;" });
  layout.append(mainCard, el("div", { style: "min-width:0;display:flex;flex-direction:column;gap:12px;" }, [inCard, actCard]));
  container.append(layout);

  loadBtn.addEventListener("click", async () => {
    if (!pathInput.value.trim()) { toast("请输入图片目录", "warning"); return; }
    await selectorAction("/api/selector/load", { path: pathInput.value.trim() });
  });
}

/** 弹出系统原生目录选择, 把真实路径填入输入框 (后端直接读取, 不上传)。 */
async function pickFolder(input) {
  try {
    const res = await post("/api/pick-folder", {});
    if (res.path) { input.value = res.path; toast(`已选择目录: ${res.path} 📂`, "success"); }
  } catch (e) { toast(e.message, "error"); }
}

function openFullscreenPreview() {
  const img = previewEl?.querySelector("img");
  if (!img) return;
  const overlay = el("div", { class: "fullscreen-preview", style: "position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;cursor:zoom-out;" });
  const big = el("img", { src: img.src, style: "max-width:96vw;max-height:94vh;border-radius:var(--radius-sm);box-shadow:var(--shadow-lg);" });
  const close = el("button", { text: "✕", style: "position:absolute;top:16px;right:20px;width:40px;height:40px;border-radius:var(--radius-sm);border:none;background:color-mix(in srgb,var(--panel-solid) 90%,var(--border));color:var(--text-1);font-size:18px;cursor:pointer;" });
  const closeAll = () => overlay.remove();
  overlay.append(big, close);
  overlay.addEventListener("click", closeAll);
  close.addEventListener("click", (e) => { e.stopPropagation(); closeAll(); });
  document.body.append(overlay);
}

async function selectorAction(url, payload) {
  try {
    const res = await post(url, payload ?? { current: currentPath });
    if (res.current) {
      currentPath = res.current;
      clear(previewEl);
      previewEl.append(el("img", { src: imageUrl(res.current), style: "max-width:100%;max-height:640px;border-radius:var(--radius-sm);box-shadow:var(--shadow);" }));
      fullBtn.style.display = "";
      infoEl.textContent = "当前: " + res.current;
    } else {
      currentPath = null;
      clear(previewEl);
      fullBtn.style.display = "none";
      previewEl.append(document.createTextNode("已浏览完所有图片 🎉"));
      infoEl.textContent = "";
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

export function onShow() {}
