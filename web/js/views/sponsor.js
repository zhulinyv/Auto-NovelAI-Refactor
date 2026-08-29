// ============================================================
// 赞助一下视图 (侧边栏独立页面):
//   PPT 式翻页: 当前区域仅显示一页, 底部按钮上/下翻页, 翻页后另一页不显示
//     第 1 页: 赞助收款码    第 2 页: 鸣谢项目使用到的开源项目
// ============================================================
import { el, clear } from "../ui.js";

export async function render(container, ctx) {
  clear(container);
  container.append(
    el("h2", {}, ["💰 赞助一下", el("span", { class: "sub", text: "请作者喝杯奶茶 · 鸣谢项目使用到的开源项目" })]),
  );

  function sponsorItem(src, label) {
    return el("div", { class: "sponsor-item" }, [
      el("div", { class: "sponsor-qr" }, [el("img", { src, alt: label, loading: "lazy" })]),
      el("div", { class: "sponsor-label", text: label }),
    ]);
  }
  const sponsorCard = el("div", { class: "card pager-card" }, [
    el("div", { class: "card-title", text: "💰 赞助一下" }),
    el("p", { class: "muted", style: "margin:4px 0 14px;line-height:1.8;", text: "如果这个项目对你有帮助, 欢迎请作者喝杯奶茶 ~ 扫码时请备注昵称, 非常感谢每一份支持 💕" }),
    el("div", { class: "sponsor-grid" }, [
      sponsorItem("assets/sponsor/wechat.png", "💚 微信收款"),
      sponsorItem("assets/sponsor/alipay.png", "💙 支付宝收款"),
      sponsorItem("assets/sponsor/qq.png", "🧡 QQ 收款"),
    ]),
  ]);

  // 鸣谢页: 项目使用的开源项目与在线服务
  const ackProjects = [
    ["🏷️ SmilingWolf/wd-tagger", "图片反推提示词 (自动打码)", "https://huggingface.co/spaces/SmilingWolf/wd-tagger"],
    ["📝 novelai-image-metadata", "读取与修改图片元数据", "https://github.com/NovelAI/novelai-image-metadata"],
    ["🔬 realcugan-ncnn-vulkan", "超分降噪 · Real-CUGAN", "https://github.com/nihui/realcugan-ncnn-vulkan"],
    ["🎬 Anime4KCPP", "超分降噪 · Anime4K", "https://github.com/TianZerL/Anime4KCPP"],
    ["☕ waifu2x-caffe", "超分降噪 · waifu2x", "https://github.com/lltcggie/waifu2x-caffe"],
    ["📮 Semi-Auto-NovelAI-to-Pixiv", "部分源代码参考", "https://github.com/zhulinyv/Semi-Auto-NovelAI-to-Pixiv"],
  ];
  const ackServices = [
    ["🎨 Lolicon API", "动漫随机壁纸 (Pixiv 收录)", "https://docs.api.lolicon.app"],
    ["💬 Hitokoto 一言", "标题栏随机一句话", "https://hitokoto.cn"],
    ["🌅 Bing 每日壁纸", "风景壁纸来源", "https://www.bing.com"],
    ["🖼️ Picsum", "随机壁纸兜底来源", "https://picsum.photos"],
  ];
  const ackCardItem = ([name, desc, url]) =>
    el("a", { class: "ack-item", href: url, target: "_blank", rel: "noopener" }, [
      el("div", { class: "ack-name", text: name }),
      el("div", { class: "ack-desc", text: desc }),
    ]);
  const ackCard = el("div", { class: "card pager-card" }, [
    el("div", { class: "card-title", text: "🙏 鸣谢" }),
    el("p", { class: "muted", style: "margin:4px 0 6px;line-height:1.8;", text: "本项目站立在众多优秀开源项目与在线服务的肩膀之上, 向以下项目的作者与贡献者致以诚挚的感谢! 点击卡片可访问对应主页。" }),
    el("div", { class: "ack-title", text: "开源项目" }),
    el("div", { class: "ack-grid" }, ackProjects.map(ackCardItem)),
    el("div", { class: "ack-title", text: "在线服务与数据来源" }),
    el("div", { class: "ack-grid" }, ackServices.map(ackCardItem)),
  ]);

  // PPT 式翻页: 当前区域仅显示一页, 上/下翻页切换
  const pagerViewport = el("div", { class: "pager-viewport" });
  const pageSponsor = el("div", { class: "pager-page active" }, [sponsorCard]);
  const pageAck = el("div", { class: "pager-page" }, [ackCard]);
  pagerViewport.append(pageSponsor, pageAck);

  const prevBtn = el("button", { class: "btn btn-sm", type: "button", text: "▲ 上一页", disabled: true });
  const nextBtn = el("button", { class: "btn btn-sm", type: "button", text: "▼ 下一页" });
  const dots = [el("span", { class: "pager-dot active" }), el("span", { class: "pager-dot" })];
  const indicator = el("span", { class: "pager-indicator", text: "1 / 2" });
  const nav = el("div", { class: "pager-nav" }, [prevBtn, ...dots, indicator, nextBtn]);

  const pagerPages = [pageSponsor, pageAck];
  let pagerIdx = 0;
  function gotoPage(i) {
    const dir = i > pagerIdx ? 1 : -1;
    pagerIdx = Math.max(0, Math.min(pagerPages.length - 1, i));
    pagerPages.forEach((p, k) => {
      p.classList.remove("active", "slide-in-up", "slide-in-down");
      if (k === pagerIdx) p.classList.add("active", dir === 1 ? "slide-in-up" : "slide-in-down");
    });
    prevBtn.disabled = pagerIdx === 0;
    nextBtn.disabled = pagerIdx === pagerPages.length - 1;
    dots.forEach((d, k) => d.classList.toggle("active", k === pagerIdx));
    indicator.textContent = `${pagerIdx + 1} / ${pagerPages.length}`;
  }
  prevBtn.addEventListener("click", () => gotoPage(pagerIdx - 1));
  nextBtn.addEventListener("click", () => gotoPage(pagerIdx + 1));

  container.append(el("div", { class: "sponsor-pager" }, [pagerViewport, nav]));
}

export function onShow() {}
