// ============================================================
// 组件汇总 (barrel): 保持 from "./components.js" 的既有 import 不变
// ============================================================
// 原先这里是 2411 行的单文件, 现在按功能拆到 components/ 下:
//   tabs.js     页签条
//   lightbox.js 全窗口看图
//   gallery.js  图片网格
//   log.js      运行日志面板
//   editor.js   图生图画布编辑器 (~1700 行, 最大的一块)
//   region.js   角色区域选择器
//   roles.js    动态角色列表
// 各视图仍然 import 本文件即可, 不需要改调用方。

export { renderTabs } from "./components/tabs.js";
export { openLightbox } from "./components/lightbox.js";
export { gallery } from "./components/gallery.js";
export { initLogConsole } from "./components/log.js";
export { imageEditor } from "./components/editor.js";
export { characterRegionPicker } from "./components/region.js";
export { roleList } from "./components/roles.js";
