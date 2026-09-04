// ============================================================
// 支持鸣谢视图 (侧边栏独立页面):
//   PPT 式翻页: 当前区域仅显示一页, 底部按钮上/下翻页, 翻页后另一页不显示
//     第 1 页: 鸣谢项目使用到的开源项目    第 2 页: 加群交流    第 3 页: 赞助收款码
// ============================================================
import { el, clear } from "../ui.js";

export async function render(container, ctx) {
  clear(container);
  container.append(
    el("h2", {}, ["🙏 支持鸣谢", el("span", { class: "sub", text: "鸣谢项目使用到的开源项目 · 加群交流 · 请作者喝杯奶茶" })]),
  );

  function sponsorItem(src, label, href) {
    const item = el("div", { class: "sponsor-item" }, [
      el("div", { class: "sponsor-qr" }, [el("img", { src, alt: label, loading: "lazy" })]),
      el("div", { class: "sponsor-label", text: label }),
    ]);
    if (href) {
      const link = el("a", { class: "sponsor-qr-link", href, target: "_blank", rel: "noopener", title: "点击打开加群链接" }, [item]);
      return link;
    }
    return item;
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

  // 加群页: QQ 群二维码 + 加群链接
  const joinCard = el("div", { class: "card pager-card" }, [
    el("div", { class: "card-title", text: "👥 加群交流" }),
    el("p", { class: "muted", style: "margin:4px 0 14px;line-height:1.8;", text: "欢迎加入 QQ 交流群: 一起玩转 AI 绘图, 交流使用心得、反馈问题与建议 ~ 点击下方二维码或按钮即可加群 💬" }),
    el("div", { class: "join-grid" }, [
      sponsorItem("assets/sponsor/qq_group.png", "📱 扫码加入 QQ 群", "https://qm.qq.com/cgi-bin/qm/qr?k=704064019"),
      el("a", { class: "btn btn-primary join-btn", href: "https://qm.qq.com/cgi-bin/qm/qr?k=704064019", target: "_blank", rel: "noopener" }, ["🚀 一键加群"]),
    ]),
  ]);

  // 鸣谢页: 项目使用的开源项目与在线服务
  const ackProjects = [
    ["🏷️ SmilingWolf/wd-tagger", "图片反推提示词 (自动打码)", "https://huggingface.co/spaces/SmilingWolf/wd-tagger"],
    ["📝 novelai-image-metadata", "读取与修改图片元数据", "https://github.com/NovelAI/novelai-image-metadata"],
    ["🔬 realcugan-ncnn-vulkan", "超分降噪 · Real-CUGAN", "https://github.com/nihui/realcugan-ncnn-vulkan"],
    ["🎬 Anime4KCPP", "超分降噪 · Anime4K", "https://github.com/TianZerL/Anime4KCPP"],
    ["☕ waifu2x-caffe", "超分降噪 · waifu2x", "https://github.com/lltcggie/waifu2x-caffe"],
    ["🧩 sd-webui-prompt-all-in-one", "Wildcards 弹窗与内置提示词库参考", "https://github.com/Physton/sd-webui-prompt-all-in-one"],
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
    el("p", { class: "muted", style: "margin:4px 0 10px;line-height:1.8;", text: "本项目站立在众多优秀开源项目与在线服务的肩膀之上, 向以下项目的作者与贡献者致以诚挚的感谢!" }),
    el("div", { class: "ack-body" }, [
      el("div", { class: "ack-group" }, [
        el("div", { class: "ack-title", text: "开源项目" }),
        el("div", { class: "ack-grid" }, ackProjects.map(ackCardItem)),
      ]),
      el("div", { class: "ack-group" }, [
        el("div", { class: "ack-title", text: "在线服务与数据来源" }),
        el("div", { class: "ack-grid" }, ackServices.map(ackCardItem)),
      ]),
    ]),
  ]);

  // PPT 式翻页: 当前区域仅显示一页, 上/下翻页切换 (鸣谢第 1 页, 加群第 2 页, 赞助第 3 页)
  const pagerViewport = el("div", { class: "pager-viewport" });
  const pageAck = el("div", { class: "pager-page active" }, [ackCard]);
  const pageJoin = el("div", { class: "pager-page" }, [joinCard]);
  const pageSponsor = el("div", { class: "pager-page" }, [sponsorCard]);
  pagerViewport.append(pageAck, pageJoin, pageSponsor);

  const prevBtn = el("button", { class: "btn btn-sm", type: "button", text: "▲ 上一页", disabled: true });
  const nextBtn = el("button", { class: "btn btn-sm", type: "button", text: "▼ 下一页" });
  const dots = [el("span", { class: "pager-dot active" }), el("span", { class: "pager-dot" }), el("span", { class: "pager-dot" })];
  const indicator = el("span", { class: "pager-indicator", text: "1 / 3" });
  const nav = el("div", { class: "pager-nav" }, [prevBtn, ...dots, indicator, nextBtn]);

  const pagerPages = [pageAck, pageJoin, pageSponsor];
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
    indicator.textContent = pagerIdx + 1 + " / " + pagerPages.length;
  }
  prevBtn.addEventListener("click", () => gotoPage(pagerIdx - 1));
  nextBtn.addEventListener("click", () => gotoPage(pagerIdx + 1));

  // 鼠标滚轮翻页: 悬停在页卡上滚动即上/下翻页 (节流防抖, 且当页面内部自身可滚动时优先滚动内容)
  let wheelLock = false;
  let wheelReset = null;
  container.addEventListener("wheel", (e) => {
    if (e.deltaY === 0) return;
    // 页面内容自身还有未显示完的滚动空间时, 优先滚动内容 (如鸣谢页小屏溢出)
    const inner = pagerPages[pagerIdx]?.firstElementChild;
    if (inner && inner.scrollHeight > inner.clientHeight + 2) {
      const atTop = inner.scrollTop <= 0;
      const atBottom = inner.scrollTop + inner.clientHeight >= inner.scrollHeight - 2;
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) return;
    }
    e.preventDefault();
    if (wheelLock) return;   // 惯性滚动节流: 一轮连续滚动只翻一页
    wheelLock = true;
    gotoPage(pagerIdx + (e.deltaY > 0 ? 1 : -1));
    clearTimeout(wheelReset);
    wheelReset = setTimeout(() => { wheelLock = false; }, 600);
  }, { passive: false });

  container.append(el("div", { class: "sponsor-pager" }, [pagerViewport, nav]));
}

export function onShow() {}
