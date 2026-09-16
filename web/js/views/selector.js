// ============================================================
// 图片筛选视图
// ============================================================
import { $, el, clear, toast, folderPickButton } from "../ui.js";
import { post, imageUrl } from "../api.js";
import { openLightbox } from "../components.js";

let S = null;
let currentPath = null;
let previewEl = null;
let infoEl = null;
let loadBtn = null;

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
  const pathBtn = folderPickButton(pathInput, { onPicked: (p) => selectorAction("/api/selector/load", { path: p }) });
  loadBtn = el("button", { class: "btn btn-primary btn-sm", text: "🔄 加载图片" });
  const dir1 = el("input", { type: "text", placeholder: "目录1 (移动/复制到此)", style: "flex:1;min-width:0;" });
  const dir2 = el("input", { type: "text", placeholder: "目录2 (移动/复制到此)", style: "flex:1;min-width:0;" });
  const dir1Btn = folderPickButton(dir1, { text: "📁", title: "选择目录1" });
  const dir2Btn = folderPickButton(dir2, { text: "📁", title: "选择目录2" });
  inCard.append(
    el("div", { style: "display:flex;gap:8px;margin-bottom:10px;" }, [pathInput, pathBtn, loadBtn]),
    el("div", { class: "grid grid-2" }, [
      el("div", { class: "field" }, [el("label", { text: "目录1" }), el("div", { style: "display:flex;gap:8px;" }, [dir1, dir1Btn])]),
      el("div", { class: "field" }, [el("label", { text: "目录2" }), el("div", { style: "display:flex;gap:8px;" }, [dir2, dir2Btn])]),
    ]),
  );

  const mainCard = el("div", { class: "card", style: "margin:0;" }, [
    el("div", { class: "card-title" }, ["🖼️ 预览"]),
  ]);
  previewEl = el("div", { style: "text-align:center;min-height:300px;display:flex;align-items:center;justify-content:center;color:var(--text-2);", text: "加载目录后显示图片" });
  infoEl = el("div", { class: "info-box", style: "margin-top:10px;" });
  mainCard.append(previewEl, infoEl);

  // 操作按钮
  const actCard = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, ["🎛️ 操作"]),
  ]);
  const actions = el("div", { style: "display:flex;flex-direction:column;gap:8px;" });
  const dirAction = (url, input) => {
    const dir = input.value.trim();
    if (!dir) { toast("请先填写目标目录 📂", "warning"); return; }
    selectorAction(url, { output_path: dir, current: currentPath });
  };
  const btnDefs = [
    ["↩️ 撤销", () => selectorAction("/api/selector/undo")],
    ["⏭️ 跳过", () => selectorAction("/api/selector/next")],
    ["📥 移动到目录1", () => dirAction("/api/selector/move", dir1)],
    ["📥 移动到目录2", () => dirAction("/api/selector/move", dir2)],
    ["📋 复制到目录1", () => dirAction("/api/selector/copy", dir1)],
    ["📋 复制到目录2", () => dirAction("/api/selector/copy", dir2)],
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

/** 放大查看当前正在筛选的图片 (共享 Lightbox: 单击图片切换原始大小/适应窗口, 点空白或 Esc 关闭) */
function zoomCurrent() {
  if (!currentPath) return;
  openLightbox(imageUrl(currentPath), String(currentPath).split(/[\\/]/).pop());
}

async function selectorAction(url, payload) {
  try {
    const res = await post(url, payload ?? { current: currentPath });
    // 后端报错 (没有可撤销 / 移动·复制·删除失败 / 目录没有图片): 只提示,
    // 保留当前预览与队列状态, 不能误显示成"已浏览完所有图片"
    if (res.error) { toast(res.error, "warning"); return; }
    if (res.current) {
      currentPath = res.current;
      clear(previewEl);
      const pic = el("img", {
        src: imageUrl(res.current),
        alt: "当前图片",
        title: "单击放大查看",
        style: "max-width:100%;max-height:640px;border-radius:var(--radius-sm);box-shadow:var(--shadow);cursor:zoom-in;",
      });
      pic.addEventListener("click", zoomCurrent);
      previewEl.append(pic);
      infoEl.textContent = "当前: " + res.current;
    } else {
      currentPath = null;
      clear(previewEl);
      previewEl.append(document.createTextNode("已浏览完所有图片 🎉"));
      infoEl.textContent = "";
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

export function onShow() {}
