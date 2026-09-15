// ============================================================
// 一言 (数据来源 hitokoto.cn): 标题栏随机句子
//   自动切换时间与背景图片切换间隔同步 (background.effectiveIntervalSec):
//   轮播中 (文件夹/在线) = 用户设置的切换间隔; 单张/默认背景 = 默认间隔
//   间隔变化经 bus("bg-interval") 即时重排程; 点击立即换一句; 获取失败静默保留当前句
// ============================================================
import { get } from "./api.js";
import { bus } from "./ui.js";
import { effectiveIntervalSec } from "./background.js";

let box = null;
let timer = null;

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

/** 按当前生效的图片切换间隔排下一次切换 (自重排 setTimeout, 每次取最新值) */
function schedule() {
  if (timer) clearTimeout(timer);
  const sec = Math.max(10, Number(effectiveIntervalSec()) || 120);
  timer = setTimeout(() => { refresh().then(schedule); }, sec * 1000);
}

export function initHitokoto() {
  box = document.getElementById("hitokoto");
  if (!box) return;
  // 手动点击换一句后重置排程, 避免刚换完又紧跟一次自动切换
  box.addEventListener("click", () => { refresh().then(schedule); });
  refresh();
  schedule();
  // 背景开始/停止轮播、切换间隔修改 → 立即跟随重排
  bus.on("bg-interval", schedule);
}
