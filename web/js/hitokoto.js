// ============================================================
// 一言 (数据来源 hitokoto.cn): 标题栏随机句子
//   每 30 分钟自动切换; 点击立即换一句; 获取失败静默保留当前句子
// ============================================================
import { get } from "./api.js";

const REFRESH_MS = 30 * 60 * 1000;
let box = null;

/** 拉取一句话并渲染 (成功时带入场动画, 悬停显示出处) */
async function refresh() {
  if (!box) return;
  try {
    const d = await get("/api/hitokoto");
    if (!d.text) return;
    const src = [d.from, d.from_who].filter(Boolean).join(" · ");
    box.textContent = `「${d.text}」`;
    box.title = (src ? `${src}\n` : "") + "一言 · 点击换一句";
    // 重新触发入场动画
    box.classList.remove("swap");
    void box.offsetWidth;
    box.classList.add("swap");
  } catch { /* 网络失败静默, 保留当前句子 */ }
}

export function initHitokoto() {
  box = document.getElementById("hitokoto");
  if (!box) return;
  box.addEventListener("click", refresh);
  refresh();
  setInterval(refresh, REFRESH_MS);
}
