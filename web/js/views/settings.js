// ============================================================
// 配置设置视图
// ============================================================
import { $, el, clear, toast, confirmDialog, sliderRow } from "../ui.js";
import { post, get, imageUrl } from "../api.js";
import { renderTabs } from "../components.js";


let S = null;
let fields = {};

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["⚙️ 配置设置", el("span", { class: "sub", text: "修改后立即生效, 无需重启 · 界面主题请使用右上角按钮切换" })]),
  );

  const settings = S.app.settings;

  const tabsWrap = el("div");
  container.append(tabsWrap);

  // ---- 选项卡 1: 基本配置 ----
  const basicBody = el("div");
  const card = el("div", { class: "card settings-card" });
  const grid = el("div", { class: "grid grid-2", style: "padding-top:34px;" });

  function tf(label, key, type = "text", hint = "") {
    const input = el("input", { type, value: settings[key] ?? "" });
    const f = el("div", { class: "field" }, [
      el("label", {}, [document.createTextNode(label), hint ? el("span", { class: "hint", text: hint }) : null]),
      input,
    ]);
    fields[key] = input;
    grid.append(f);
  }

  function cf(label, key, hint = "") {
    const input = el("input", { type: "checkbox" });
    input.checked = !!settings[key];
    const f = el("div", { class: "field" }, [
      el("label", { class: "checkline" }, [input, document.createTextNode(label)]),
      hint ? el("div", { class: "muted", text: hint }) : null,
    ]);
    fields[key] = input;
    grid.append(f);
  }

  function sf(label, key, min, max, step, hint = "") {
    const s = sliderRow({ min, max, step, value: settings[key] ?? min });
    grid.append(el("div", { class: "field" }, [
      el("label", { text: label }),
      s.node,
      hint ? el("div", { class: "muted", text: hint }) : null,
    ]));
    fields[key] = { get: () => s.get() };
  }

  tf("🔑 Token", "token", "text", "NovelAI 账号 Token (必填)");
  tf("🌐 代理地址", "proxy", "text", "本地代理格式: http://127.0.0.1:xxx");
  tf("📁 自定义路径", "custom_path", "text", "支持 <类型> <日期> <种子> <随机字符> <编号>");
  tf("🔢 端口号", "port", "number", "理论范围 1 - 65535");
  cf("🔊 启动提示音", "start_sound");
  cf("🎉 完成提示音", "finish_sound");
  cf("🔄 启动时检查更新", "check_update");
  cf("📝 格式化输入", "format_input", "删除多余空格和逗号或添加缺少的空格和逗号");
  cf("⚡ 跳过剩余点数计算", "skip_inquire_anlas");
  cf("🚫 删除 nsfw 标签", "remove_nsfw");
  cf("🔄 429 自动重试", "retry_429", "遇到 429 限流时无上限自动重试; 未开启时出错最多自动重试 3 次 (每次等待 5 秒, 仍失败则跳过该张继续生成)");
  cf("🧩 禁用全部插件", "disable_all_plugins");
  sf("⏱️ 冷却时间 (秒)", "cool_time", 1, 600, 1, "会上下浮动 1 秒");
  sf("📧 SMTP 触发数量", "smtp_num", 0, 9999, 1, "超过该数量时生成结束发送邮件, 0 为关闭");
  tf("📧 QQ 邮箱", "smtp_mail", "text", "发送/接收邮件的 QQ 邮箱");
  tf("🔐 SMTP TOKEN", "smtp_token", "text", "QQ 邮箱 SMTP 授权码");

  // 操作按钮 (卡片右上角)
  const actions = el("div", { class: "settings-actions" });
  const saveBtn = el("button", { class: "btn btn-primary btn-sm", text: "💾 保存" });
  const restartBtn = el("button", { class: "btn btn-sm", text: "🔄 重启" });
  const updateBtn = el("button", { class: "btn btn-sm", text: "⬆️ 更新" });
  const outBox = el("div", { class: "info-box", style: "margin-top:12px;" });
  actions.append(saveBtn, restartBtn, updateBtn);
  card.append(el("div", { class: "card-title", text: "⚙️ 基本配置" }), actions, grid);
  basicBody.append(card, outBox);

  // ---- 选项卡 2: 赞助一下 (PPT 式翻页: 赞助页 / 鸣谢页) ----
  const sponsorBody = el("div");

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

  const pager = el("div", { class: "sponsor-pager" }, [pagerViewport, nav]);
  sponsorBody.append(pager);

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

  renderTabs([
    { title: "⚙️ 基本配置", render: (body) => body.append(basicBody) },
    { title: "💰 赞助一下", render: (body) => body.append(sponsorBody) },
  ], tabsWrap);


  function collect() {
    const data = {};
    for (const [key, f] of Object.entries(fields)) {
      if (f.get) data[key] = f.get();
      else if (f.type === "checkbox") data[key] = f.checked;
      else data[key] = f.value;
    }
    return data;
  }

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const res = await post("/api/settings", collect());
      outBox.textContent = "✅ " + res.message;
      toast(res.message, "success");
    } catch (e) {
      outBox.textContent = "❌ " + e.message;
      toast(e.message, "error");
    } finally {
      saveBtn.disabled = false;
    }
  });

  restartBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("确定要重启服务吗?", { danger: true });
    if (!ok) return;
    // 重启前右上角通知 (手动关闭, 不自动消失)
    toast("🔄 正在重启 WebUI... 连接将短暂断开", "warning");
    try { await post("/api/settings/restart"); } catch { /* 连接断开即重启成功 */ }
    // 等待后端恢复后刷新原窗口 (不再打开新窗口)
    let back = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const r = await fetch("/api/state");
        if (r.ok) { back = true; break; }
      } catch { /* 后端重启中 */ }
    }
    if (!back) toast("后端未响应, 请检查服务状态", "error");
    location.reload();
  });

  updateBtn.addEventListener("click", async () => {
    updateBtn.disabled = true;
    try {
      const res = await post("/api/settings/update-repo");
      outBox.textContent = res.message;
      toast(res.message, "info");
    } catch (e) {
      outBox.textContent = "❌ " + e.message;
    } finally {
      updateBtn.disabled = false;
    }
  });
}

export function onShow() {}
