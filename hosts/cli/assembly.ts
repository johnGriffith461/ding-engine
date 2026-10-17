import { createEngine, type Engine } from "../../engine/index";
import { createSqliteSessionStore, type OpenOptions } from "../../engine/adapters/sqliteStore";
import type { ToolExecutor } from "../../engine/ports/executor";
import { buildToolSet, createToolRegistry, type ToolEntry, type ToolRegistry } from "../../engine/runtime/registry";
import { loadEnabledPlugins, pluginHooks, pluginToolEntries } from "../../engine/runtime/pluginHost";
import { resolveSecret } from "../../engine/runtime/credentials";
import { pluginPaths, readLedger } from "../../engine/adapters/pluginStore";
import type { ConfirmMode } from "../../shared/ipc";
import { createCliExecutor } from "./tools";

/**
 * CLI 宿主的**装配**（从 `ding.ts` 拆出来，2026-10-15）。
 *
 * ## 为什么拆
 *
 * 装配这段（"端口接哪、工具能碰哪些目录、插件从哪来"）原来长在 `ding.ts` 里，
 * 而 Phase 10 的评测器**必须用同一份装配**跑：
 * 评测器自己拼一套端口就等于绕开了产品那条路 ——
 * 那样测出来的"通过率"不能代表产品（数据记错地方、工具少了白名单都会漏掉）。
 *
 * 拆出来之后：`ding.ts` 与 `engine/eval` 的测试都从这里拿引擎，装配只有一份。
 * （这跟内核那边"装配只有一份"是同一条理由，见 `engine/index.ts` 的头注。）
 */

/** 内置工具里**限本宿主能跑**的那批。 */
export const CLI_TOOLS = [
  "list_files",
  "read_file",
  "write_file",
  "list_dir",
  "search_files",
  "edit_file",
  "run_command",
  "spawn_agent",
  "spawn_agents",
] as const;

export type BuiltEngine = {
  engine: Engine;
  close: () => void;
  plugins: string[];
  /**
   * **工具执行体**（V5 收尾加；加法，不动既有调用方）。
   *
   * 谁要它：服务端替**远端成员**执行那一次被拦下的调用（C3 3.7b —— 成员点了批准，
   * 工具要在会话所在的那一端真的跑一次，见 `hosts/server/approvalApi.ts`）。
   * 桌面那条路走的是自己的 `runToolOnce`（它绑着界面的 store），服务端只能用这一份。
   */
  executor: ToolExecutor;
};

/**
 * 建一个供一次运行使用的引擎。
 *
 * ⚠️ 每一个端口都在这里**显式**给：数据在哪、工具能碰哪些目录、健康账本记不记
 * （CLI **不记**：跑一轮就退出，"下次启动时界面显示谁验证过"这件事在 CLI 里不存在）。
 *
 * 装配顺序有个环要绕：注册表要执行体、执行体要注册表（`spawn_agent` 要造子级工具集）。
 * 所以先给执行体一个**取值函数**，等注册表建好再把它填上 —— 环在装配期解开，
 * 运行期没有 null 检查。
 *
 * @param dirs 授权目录（工具能碰的范围）
 * @param dataDir 会话数据目录（默认由调用方给 `dataDir()`；评测器会给一个临时目录）
 * @param open 会话库的打开选项（目前只有 `protectBefore`：服务态拿它挡住
 *   "外部流量挤掉用户历史"那条，见 `sqliteStore.ts` 的 `OpenOptions`）
 */
export async function buildEngine(
  dirs: readonly string[],
  dataDir: string,
  open: OpenOptions = {},
): Promise<BuiltEngine> {
  const store = createSqliteSessionStore(dataDir, "sessions.db", {}, open);

  let makeTools:
    | ((mode: ConfirmMode, depth: number, provider: string, signal?: AbortSignal, only?: readonly string[]) => ReturnType<typeof buildToolSet>)
    | null = null;
  const executor: ToolExecutor = createCliExecutor({
    dirs,
    makeTools: (mode, depth, provider, signal, only) => {
      if (!makeTools) throw new Error("工具集还没装配好（不应该发生）");
      return makeTools(mode, depth, provider, signal, only);
    },
  });

  /*
   * 插件（Phase 8.3）：把台账里**开着**的装载起来，它们的工具与内置工具进**同一个注册表**。
   *
   * ⚠️ 装载失败**不拦着跑**：一个坏插件不该让 CLI 起不来（`problems` 打出来给用户看）。
   */
  const paths = pluginPaths(dataDir);
  const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
  const plugins = loaded.flatMap((p) => (p.problems.length ? p.problems.map((x) => `${p.name}：${x}`) : []));
  const pluginEntries = pluginToolEntries();

  /*
   * 注册表带**两个来源**：内置（`include` 限定的那批）+ 插件。
   * ⚠️ 插件走 `include` 会被滤掉（它只筛内置），所以必须显式并进来 ——
   * 这正是"三个来源统一注册"的落点（builtin / mcp / plugin 都在这张表里）。
   */
  const registry: ToolRegistry = createToolRegistry({ include: CLI_TOOLS, extra: pluginEntries });
  makeTools = (mode, depth, provider, signal, only) =>
    buildToolSet({
      registry,
      mode,
      executor,
      ctx: { mode, provider, depth, ...(signal ? { signal } : {}) },
      ...(only ? { only } : {}),
    });

  /*
   * 两个 IO 端口（V5-4 4.1）显式注入：凭据库与插件钩子都在 Node 这一侧 ——
   * 内核不认它们，只认 `SecretPort` / `HooksPort` 两个形状。
   */
  const engine = createEngine({
    store,
    executor,
    include: CLI_TOOLS,
    tools: pluginEntries as readonly ToolEntry[],
    secret: resolveSecret,
    hooks: pluginHooks,
  });
  return { engine, close: () => store.close(), plugins, executor };
}
