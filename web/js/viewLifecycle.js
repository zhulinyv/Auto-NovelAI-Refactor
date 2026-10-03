// ============================================================
// 视图生命周期: "离开视图时执行"的清理函数注册表
// ============================================================
// 单独成一个**无依赖的叶子模块**, 原因:
//   - app.js 会 import 各个视图, 而 gallery/settings 在**模块求值期**就调用 onViewLeave;
//     ESM 下被导入模块总是先于导入者求值, 所以这份状态不能放在 app.js 里 (会命中 TDZ,
//     抛 "Cannot access 'viewCleanups' before initialization" 并让整页白屏)。
//   - 放在这里后: views 只依赖本模块, 本模块不依赖任何东西, 不存在循环导入与求值顺序问题。
// 视图在 render 时登记清理函数 (定时器/轮询/全局监听), showView 在切走前统一调用。

const cleanups = new Map();

/** 登记"离开该视图时执行"的清理函数 (同一视图可登记多个)。 */
export function onViewLeave(viewName, fn) {
  if (typeof fn !== "function") return;
  const list = cleanups.get(viewName);
  if (list) list.push(fn);
  else cleanups.set(viewName, [fn]);
}

/** 执行并清空某视图的全部清理函数 (切换视图时由 app.js 调用)。 */
export function runViewCleanups(viewName) {
  const list = cleanups.get(viewName);
  if (!list || !list.length) return;
  cleanups.set(viewName, []);
  for (const fn of list) {
    try { fn(); } catch { /* 清理失败不影响切换 */ }
  }
}
