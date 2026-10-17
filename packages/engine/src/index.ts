/**
 * `ding-engine` 的公开面（Node 侧 / 完整能力面）。
 *
 * 这一份是**声明**，不是实现：实现全在 `engine/` 与 `hosts/cli/`（与产品用的是同一份代码）。
 * 它存在的理由只有一个 —— **公开面要有唯一一处落脚点**：
 * API 冻结清单（V5-4 4.2）指着它，第三方示例（4.3）只从它这里 import，
 * 于是"给外面看的东西"不会随着内部重构漂。
 *
 * 分层（与 `ding-engine-core` 的关系）：
 *
 * ```
 * ding-engine-core   事件 + 主循环（无 IO）
 *      ▲
 *      │ 完整能力面 = 最小面 + 下面这些"要 IO 的"：
 * ding-engine        SQLite 存储 / 工具执行体 / 凭据库 / 插件装载 / 装配（buildEngine）
 * ```
 */

/* ── 引擎本身（与最小面同一份实现，这里只是再导出） ───────────────── */
export {
  createEngine,
  type Engine,
  type EnginePorts,
  type EngineRunRequest,
  type EngineRunResult,
} from "../../../engine/index";

/* ── 装配：一个工作目录 + 一个数据目录，得到一个能跑的引擎 ────────── */
export { buildEngine, CLI_TOOLS, type BuiltEngine } from "../../../hosts/cli/assembly";

/* ── 存储（SQLite：会话记录与归属） ───────────────────────────────── */
export { createSqliteSessionStore } from "../../../engine/adapters/sqliteStore";
export type { SessionStore } from "../../../engine/ports/store";
export type { SessionSummary } from "../../../shared/ipc";

/* ── 工具执行体（把内置工具接到磁盘上） ───────────────────────────── */
export { createCliExecutor, type MakeTools } from "../../../hosts/cli/tools";
export { buildToolSet, createToolRegistry, type ToolEntry, type ToolRegistry } from "../../../engine/runtime/registry";

/* ── 凭据与插件（Node 侧的两个 IO 端口实现） ─────────────────────── */
export { resolveSecret, invalidateCredentialCache, credentialsPath } from "../../../engine/runtime/credentials";
export { pluginHooks, pluginToolEntries, loadEnabledPlugins, runHooks } from "../../../engine/runtime/pluginHost";
export { pluginPaths, readLedger } from "../../../engine/adapters/pluginStore";

/* ── provider 目录（列可用性时要带上自己那套凭据解析） ────────────── */
export { allProviders, getProvider, listProviders, firstAvailableProvider } from "../../../engine/runtime/providers";

/* ── 档位词表（跨进程契约里那一份） ──────────────────────────────── */
export { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../../shared/ipc";
