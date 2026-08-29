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

  // ---- 选项卡 2: 赞助一下 ----
  const sponsorBody = el("div");
  sponsorBody.append(
    el("div", { class: "card", style: "margin:0;" }, [
      el("div", { class: "card-title", text: "💰 赞助一下" }),
      el("p", { class: "muted", style: "margin:4px 0 14px;line-height:1.8;", text: "如果这个项目对你有帮助, 欢迎请作者喝杯奶茶 ~ 扫码时请备注昵称, 非常感谢每一份支持 💕" }),
      el("div", { class: "sponsor-grid" }, [
        sponsorItem("assets/sponsor/wechat.png", "💚 微信收款"),
        sponsorItem("assets/sponsor/alipay.png", "💙 支付宝收款"),
        sponsorItem("assets/sponsor/qq.png", "🧡 QQ 收款"),
      ]),
    ]),
  );

  function sponsorItem(src, label) {
    return el("div", { class: "sponsor-item" }, [
      el("div", { class: "sponsor-qr" }, [el("img", { src, alt: label, loading: "lazy" })]),
      el("div", { class: "sponsor-label", text: label }),
    ]);
  }

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
