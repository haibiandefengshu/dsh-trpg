// dsh-trpg 的稳定入口（thin entry）。
//
// ── 为什么长这样 ──────────────────────────────────────────────────────────
// 这个包是 link 安装的，cordis 会用同一个 URL 反复 import 入口；Node 的 ESM
// 缓存按 URL 命中，所以「改完代码 → 关闭再打开 bundle」拿到的还是旧模块，
// 只能重启整个 DSH 才生效（2026-11-07 反复踩）。
//
// 现在入口只做一件事：**每次 apply 用一个新时间戳重新 import 真正的实现**。
// 实现里所有相对导入也带同一个时间戳（见各文件的 STAMP），于是整张依赖图
// 都是新的 —— 改完代码只要让插件重新 apply（bundle 关开一次）就生效。
//
// name / inject / Config 仍然在加载期给出，这几个字段不需要热更新。

const STAMP = Date.now().toString(36);
globalThis.__TRPG_STAMP__ = STAMP;

const impl = await import(`./impl.js?t=${STAMP}`);

export const name = impl.name;
export const inject = impl.inject;
export const Config = impl.Config;

export async function apply(ctx, config) {
  // 再刷一次时间戳：同一进程里多次 apply（bundle 关开 / 改配置）都拿到新代码
  const stamp = Date.now().toString(36);
  globalThis.__TRPG_STAMP__ = stamp;
  const fresh = await import(`./impl.js?t=${stamp}`);
  return fresh.apply(ctx, config);
}
