// ============================================================
// 配置设置视图
// ============================================================
import { $, el, clear, toast, confirmDialog, sliderRow } from "../ui.js";
import { post, get } from "../api.js";


let S = null;
let fields = {};

export async function render(container, ctx) {
  S = ctx;
  clear(container);
  container.append(
    el("h2", {}, ["⚙️ 配置设置", el("span", { class: "sub", text: "修改后立即生效, 无需重启 · 界面主题请使用右上角按钮切换" })]),
  );

  const settings = S.app.settings;

  const card = el("div", { class: "card settings-card" });
  const grid = el("div", { class: "grid grid-2", style: "padding-top:34px;" });

  // 共享链接相关控件 (开关 + 链接展示), 供 applyShareUI 显隐
  let shareLinkBox = null;
  let shareLinkText = null;
  let otherFields = [];   // 除共享链接外的全部配置控件 (保存开启共享后隐藏, 关闭后恢复)

  function applyShareUI(on) {
    otherFields.forEach((f) => { f.style.display = on ? "none" : ""; });
    if (shareLinkBox) shareLinkBox.style.display = on ? "" : "none";
  }

  let sharePollTimer = null;
  function startSharePolling() {
    if (sharePollTimer) return;
    sharePollTimer = setInterval(async () => {
      // 共享关闭或链接区隐藏后自动停止
      if (!fields.share?.get?.() || !shareLinkBox || shareLinkBox.style.display === "none") {
        clearInterval(sharePollTimer);
        sharePollTimer = null;
        return;
      }
      try {
        const st = await get("/api/share");
        if (st.url) {
          shareLinkText.textContent = st.url;
          shareLinkText.href = st.url;
        } else if (st.error) {
          shareLinkText.textContent = "❌ " + st.error;
          shareLinkText.removeAttribute("href");
        } else if (!st.running) {
          shareLinkText.textContent = "隧道未运行, 请重新保存开启";
          shareLinkText.removeAttribute("href");
        }
      } catch { /* 后端不可用时保持原文案 */ }
    }, 2000);
  }

  async function refreshShareStatus() {
    if (!shareLinkBox || shareLinkBox.style.display === "none") return;
    try {
      const st = await get("/api/share");
      if (st.url) {
        shareLinkText.textContent = st.url;
        shareLinkText.href = st.url;
      } else if (st.running) {
        shareLinkText.textContent = "⏳ 正在建立隧道, 请稍候 (首次使用需下载隧道程序)...";
        shareLinkText.removeAttribute("href");
        startSharePolling();
      } else {
        shareLinkText.textContent = "保存开启后自动生成外网访问链接";
        shareLinkText.removeAttribute("href");
      }
    } catch { /* 后端不可用时保持原文案 */ }
  }

  function tf(label, key, type = "text", hint = "") {
    const input = el("input", { type, value: settings[key] ?? "" });
    const f = el("div", { class: "field" }, [
      el("label", {}, [document.createTextNode(label), hint ? el("span", { class: "hint", text: hint }) : null]),
      input,
    ]);
    fields[key] = input;
    otherFields.push(f);
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
    otherFields.push(f);
    grid.append(f);
  }

  function sf(label, key, min, max, step, hint = "") {
    const s = sliderRow({ min, max, step, value: settings[key] ?? min });
    const f = el("div", { class: "field" }, [
      el("label", { text: label }),
      s.node,
      hint ? el("div", { class: "muted", text: hint }) : null,
    ]);
    otherFields.push(f);
    grid.append(f);
    fields[key] = { get: () => s.get() };
  }

  // 多 Token: 每行一个, 数量 = 并行生图通道数 (旧的单 token 字段自动兼容)
  {
    const tokensValue = (settings.tokens && settings.tokens.length ? settings.tokens : (settings.token ? [settings.token] : [])).join("\n");
    const area = el("textarea", { rows: 3, placeholder: "pst-xxxx... (每行一个 Token)", spellcheck: "false" });
    area.value = tokensValue;
    const f = el("div", { class: "field" }, [
      el("label", {}, [document.createTextNode("🔑 Token (每行一个)"), el("span", { class: "hint", text: "多 Token 可并行生成" })]),
      area,
      el("div", { class: "muted", text: "Token 数量 = 同时执行的生图任务数; 修改保存后立即生效 (正在执行的任务不受影响)" }),
    ]);
    fields.tokens = { get: () => area.value.split("\n").map((s) => s.trim()).filter(Boolean) };
    otherFields.push(f);
    grid.append(f);
  }
  tf("🌐 代理地址", "proxy", "text", "本地代理格式: http://127.0.0.1:xxx");
  tf("📁 自定义路径", "custom_path", "text", "支持 <类型> <日期> <种子> <随机字符> <编号>");
  tf("🔢 端口号", "port", "number", "理论范围 1 - 65535");
  cf("🔊 启动提示音", "start_sound");
  cf("🎉 完成提示音", "finish_sound");
  cf("🔄 启动时检查更新", "check_update");
  cf("📝 格式化输入", "format_input", "删除多余空格和逗号或添加缺少的空格和逗号");
  cf("⚡ 跳过剩余点数/用量计算", "skip_inquire_anlas");
  cf("🚫 删除 nsfw 标签", "remove_nsfw");
  cf("🔄 429 自动重试", "retry_429", "遇到 429 限流时无上限自动重试; 未开启时出错最多自动重试 3 次 (每次等待 5 秒, 仍失败则跳过该张继续生成)");
  cf("🧩 禁用全部插件", "disable_all_plugins");
  cf("🖥️ 隐藏终端启动", "hide_terminal", "通过 run.bat 启动时自动隐藏并关闭终端窗口, 退出请用右上角电源按钮");
  // 共享链接: 开关 + 外网链接展示 (占位高度与普通字段一致, 开关切换不跳动)
  {
    const box = el("input", { type: "checkbox" });
    box.checked = !!settings.share;
    shareLinkBox = el("div", { class: "field share-link-field" }, [
      el("div", { class: "muted" }, ["🌐 外网链接: ", (shareLinkText = el("a", { class: "share-link", text: settings.share_url || "保存开启后自动生成外网访问链接" }))]),
      el("div", { class: "muted", text: "他人通过此链接即可访问本 WebUI 并使用已配置的 Token 生成图片, 请勿泄露; 关闭共享后链接立即失效; 远程访问时日志为 2 秒轮询刷新" }),
    ]);
    shareLinkText.addEventListener("click", (e) => {
      if (!shareLinkText.getAttribute("href")) e.preventDefault();
      else if (shareLinkText.textContent) {
        navigator.clipboard?.writeText(shareLinkText.textContent).then(() => toast("外网链接已复制 📋", "success")).catch(() => {});
      }
    });
    fields.share = { get: () => box.checked };
    const shareField = el("div", { class: "field" }, [
      el("label", { class: "checkline" }, [box, document.createTextNode("🌍 共享链接")]),
      el("div", { class: "muted", text: "通过公网隧道生成一条外网可访问的链接; 保存开启后隐藏本页其它全部配置" }),
      shareLinkBox,
    ]);
    grid.append(shareField);
  }
  sf("⏱️ 冷却时间 (秒)", "cool_time", 1, 600, 1, "会上下浮动 1 秒");
  sf("📧 SMTP 触发数量", "smtp_num", 0, 9999, 1, "超过该数量时生成结束发送邮件, 0 为关闭");
  tf("📧 QQ 邮箱", "smtp_mail", "text", "发送/接收邮件的 QQ 邮箱");
  tf("🔐 SMTP TOKEN", "smtp_token", "text", "QQ 邮箱 SMTP 授权码");

  // 全部控件创建完毕: 按"已保存"的共享开关状态显隐 (仅勾选不生效, 保存后才应用)
  applyShareUI(!!settings.share);
  refreshShareStatus();

  // 操作按钮 (卡片右上角)
  const actions = el("div", { class: "settings-actions" });
  const saveBtn = el("button", { class: "btn btn-primary btn-sm", text: "💾 保存" });
  const restartBtn = el("button", { class: "btn btn-sm", text: "🔄 重启" });
  const updateBtn = el("button", { class: "btn btn-sm", text: "⬆️ 更新" });
  actions.append(saveBtn, restartBtn, updateBtn);
  card.append(el("div", { class: "card-title", text: "⚙️ 基本配置" }), actions, grid);
  container.append(card);


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
      if (res.ok === false) {
        toast(res.message, "error");
        return;
      }
      toast(res.message, "success");
      // 检测端口 / 隐藏终端变更, 额外提示重启事项
      if (res.port_changed) {
        toast("端口修改需重启后重新绑定", "warning", 6000);
      }
      if (res.hide_terminal_changed) {
        toast("隐藏/显示终端启动需关闭程序后重新启动", "warning", 6000);
      }
      // 共享链接切换: 保存成功后切换其它配置的显隐, 并按方向自动跳转对应链接
      // (跳转即整页刷新, 后端已重载插件, 插件商店等变动随之生效)
      if (res.share_changed) {
        applyShareUI(fields.share.get());
        if (fields.share.get()) {
          toast("🌍 共享链接开启中, 正在生成外网链接, 生成后自动跳转...", "info", 8000);
          shareLinkText.textContent = "⏳ 正在建立隧道, 请稍候 (首次使用需下载隧道程序)...";
          shareLinkText.removeAttribute("href");
          let n = 0;
          const timer = setInterval(async () => {
            try {
              const st = await get("/api/share");
              if (st.url) { clearInterval(timer); location.href = st.url; return; }
              if (st.error) {
                clearInterval(timer);
                refreshShareStatus();
                toast(st.error, "error", 10000);
                return;
              }
            } catch { /* 后端忙, 继续等 */ }
            if (++n >= 300) {
              clearInterval(timer);
              toast("外网链接生成超时, 请检查网络后重新保存", "error", 8000);
            }
          }, 2000);
        } else {
          // 关闭共享: 本地页直接刷新恢复全部配置显示; 隧道页跳回本地后再刷新
          toast("共享链接已关闭, 正在刷新页面...", "info");
          if (["127.0.0.1", "localhost", "[::1]"].includes(location.hostname)) {
            location.reload();
          } else {
            location.href = "http://127.0.0.1:" + (settings.port || 11451);
          }
        }
      }
    } catch (e) {
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
      toast(res.message, "info");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      updateBtn.disabled = false;
    }
  });
}

export function onShow() {}