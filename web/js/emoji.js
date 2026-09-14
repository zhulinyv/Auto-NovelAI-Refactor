// ============================================================
// 跨平台统一 emoji: 用本地 Twemoji SVG 替换系统 emoji,
// 保证不同设备 / 操作系统上显示完全一致。
// 图片加载失败 (如离线) 时自动还原为原生 emoji, 不出现裂图。
// ============================================================

// Twemoji 资源目录: web/assets/emoji/72x72/*.svg (URL: /assets/emoji/72x72/{icon}.svg)
const BASE = "/assets/emoji/";

function getTwemoji() {
  return window.twemoji || null;
}

function parseNode(node) {
  const tw = getTwemoji();
  if (!tw || !node) return;
  try {
    tw.parse(node, {
      base: BASE,
      ext: ".svg",
      size: "72x72",
      className: "twemoji",
      attributes: (raw, iconId) => ({
        loading: "lazy",
        decoding: "async",
      }),
      // 本地 SVG 缺失时的回退 (内置资源只覆盖界面常用 emoji, 用户文件名/路径里的 emoji 可能没有对应 SVG)。
      // 不能走 twemoji 默认 onerror: 它把失败图片替换回"纯文本节点", 而 MutationObserver 会把
      // 新增文本节点的父级再次 parse → 又生成图片 → 又 404 → 无限 img↔文本 替换循环 (emoji 闪动)。
      // 这里替换成带 native-emoji class 的 span, 观察者对这类节点已免疫, 一次回退即终止。
      onerror: function () {
        const img = this;
        if (!img.parentNode) return;
        const alt = img.alt || "";
        if (!alt) { img.remove(); return; }
        const span = document.createElement("span");
        span.className = "native-emoji";
        span.textContent = alt;
        img.replaceWith(span);
      },
    });
  } catch (e) {
    /* 解析失败不影响页面 */
  }
}

/**
 * 初始化全局 emoji 统一显示。
 * 通过 MutationObserver 自动处理动态渲染的内容 (视图 / 日志 / 插件面板等)。
 */
export function initEmoji() {
  const tw = getTwemoji();
  if (!tw) {
    // 库未加载: 直接返回, 保持系统原生 emoji
    return null;
  }
  parseNode(document.body);

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 跳过 twemoji 图片与加载失败的回退节点, 否则会重新 parse 形成无限替换循环 (闪烁跳动)
          if (node.classList && (node.classList.contains("twemoji") || node.classList.contains("native-emoji"))) continue;
          parseNode(node);
        } else if (node.nodeType === Node.TEXT_NODE && node.parentNode) {
          // 回退节点 (native-emoji) 的父级也不要再 parse, 否则同样会进入无限替换循环
          if (!node.parentNode.classList?.contains("native-emoji")) parseNode(node.parentNode);
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return mo;
}
