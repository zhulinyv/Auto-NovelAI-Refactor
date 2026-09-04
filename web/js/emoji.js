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
    });
    // 离线 / 资源缺失时: 还原为原生 emoji, 避免出现裂图
    if (node.querySelectorAll) {
      node.querySelectorAll("img.twemoji").forEach((img) => {
        img.addEventListener(
          "error",
          () => {
            const alt = img.getAttribute("alt") || "";
            if (alt) {
              const span = document.createElement("span");
              span.className = "native-emoji";
              span.textContent = alt;
              img.replaceWith(span);
            } else {
              img.remove();
            }
          },
          { once: true },
        );
      });
    }
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
