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

  // 鸣谢页: 项目使用到的开源项目 (据仓库 README 与依赖整理)
  const ackProjects = [
    ["🌸 Auto-NovelAI (原版)", "本项目的前身, 全部功能的实现基础", "https://github.com/zhulinyv/Auto-NovelAI-Refactor"],
    ["⚡ FastAPI", "高性能 Web 后端框架", "https://github.com/tiangolo/fastapi"],
    ["🦄 Uvicorn", "ASGI 服务器", "https://github.com/encode/uvicorn"],
    ["📝 Loguru", "优雅的日志库", "https://github.com/Delgan/loguru"],
    ["🎨 Rich", "终端美化输出", "https://github.com/Textualize/rich"],
    ["🖼️ Pillow", "图像处理", "https://github.com/python-pillow/Pillow"],
    ["🔢 NumPy", "科学计算基础库", "https://github.com/numpy/numpy"],
    ["📡 Requests", "HTTP 请求库", "https://github.com/psf/requests"],
    ["🐍 GitPython", "插件与更新管理", "https://github.com/gitpython-developers/GitPython"],
    ["⚡ ujson", "高性能 JSON 解析", "https://github.com/ultrajson/ultrajson"],
    ["🧷 pydantic", "配置与数据校验", "https://github.com/pydantic/pydantic"],
    ["🗑️ Send2Trash", "删除文件进回收站", "https://github.com/arsenetar/send2trash"],
    ["🤗 Gradio Client", "与原版保持兼容", "https://github.com/gradio-app/gradio"],
    ["😀 Twemoji", "跨平台统一 Emoji", "https://github.com/twitter/twemoji"],
    ["🏷️ a1111-sd-webui-tagcomplete", "标签数据与别名来源", "https://github.com/DominikDoom/a1111-sd-webui-tagcomplete"],
    ["🀄 Danbooru Tag 中英对照表", "标签中文翻译来源", "https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table"],
  ];
  const ackCard = el("div", { class: "card pager-card" }, [
    el("div", { class: "card-title", text: "🙏 鸣谢" }),
    el("p", { class: "muted", style: "margin:4px 0 14px;line-height:1.8;", text: "本项目站立在众多优秀开源项目的肩膀之上, 向以下项目的作者与贡献者致以诚挚的感谢! 点击卡片可访问对应项目主页。" }),
    el("div", { class: "ack-grid" }, ackProjects.map(([name, desc, url]) =>
      el("a", { class: "ack-item", href: url, target: "_blank", rel: "noopener" }, [
        el("div", { class: "ack-name", text: name }),
        el("div", { class: "ack-desc", text: desc }),
      ])
    )),
    el("p", { class: "muted", style: "font-size:12px;margin-top:12px;", text: "* 壁纸数据来源: Bing 每日壁纸 · Picsum · api.yppp.net (acg-api)" }),
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
