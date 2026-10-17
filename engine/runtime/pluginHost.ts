import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { jsonSchema } from "ai";

import type { ToolEntry } from "./registry";
import {
  grantedCapabilities,
  pluginToolName,
  type HookName,
  type PluginPermission,
} from "./plugins";
import { manifestDrifted, readManifestFromDir, type InstalledPlugin } from "../adapters/pluginStore";
import { checkManifest } from "./plugins";
import type { HooksPort } from "../ports/hooks";

/**
 * **插件的装载与运行**（Phase 8.3）。
 *
 * ## 一个插件长什么样（作者写的那一面）
 *
 * ```js
 * // index.mjs
 * export const tools = {
 *   hello: {
 *     description: "打个招呼",
 *     inputSchema: { type: "object", properties: {} },
 *     run: async (input, ctx) => ({ ok: true, text: "你好" }),
 *   },
 * };
 * export const hooks = {
 *   "turn:end": async (payload) => { /* 观察，不改变任何东西 *\/ },
 * };
 * ```
 *
 * ## 三条边界（v1 如实说清）
 *
 * 1. **进程内执行**：插件与宿主**同进程、同权限**。所以 `fs:read` / `net` / `exec`
 *    这类权限在 v1 **拦不住**（见 `plugins.ts` 文件头那张表）—— 它们的作用是
 *    "让用户知情"，不是"限制"。真正的隔离（Worker / 容器）列 v2。
 * 2. **钩子是"只看不改"**：钩子的返回值**一律忽略**。钩子能改行为的话，
 *    一个坏插件就能悄悄改掉工具参数或拦下工具调用 —— 而那种改动
 *    在留痕里看不出来（"模型说它调了 A，结果执行的是 B"）。
 * 3. **名字带前缀**（`plugin__<插件>__<工具>`）：插件顶不掉内置工具，
 *    而"谁提供的能力"在留痕里一眼可辨（与 MCP 的 `mcp__` 同一个道理）。
 *
 * ## 权限在这里**真的**生效
 *
 * `tools:register` / `hooks:register` 没被批准 → 那条线**不接**：
 * 工具不进注册表、钩子不会被调用。这是 v1 里两类权限中能真拦的那一类。
 */

/**
 * 藏在编译背后的动态 `import`（`new Function` 让它不被 TS 改写成 `require`）。
 */
const compiledImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PluginModule>;

/**
 * **加载一个插件模块**（两种宿主都要能跑，所以两条路都留着）。
 *
 * | 宿主 | 直接写 `import()` 会怎样 | 用 `compiledImport` 会怎样 |
 * |---|---|---|
 * | 桌面主进程（**CJS**） | TS 把它编译成 `require()` → **加载不了 ESM** | ✅ 真正的动态 import |
 * | vitest（ESM） | ✅ | ❌ 报 "A dynamic import callback was not specified"（不在模块图里） |
 *
 * 所以：先走 `compiledImport`（桌面那条路必需），**只在它报"环境不支持"时**回落到普通
 * `import()`（vitest 那条路必需）。删掉任何一条，都会有半边宿主炸 ——
 * 而这半边炸的时候，错误信息离原因很远（`Cannot find module 'file:///…'`
 * 那个格式其实是 **require** 的，不是 ESM 的）。
 *
 * @param url 模块 URL
 * @returns 模块
 */
async function loadModule(url: string): Promise<PluginModule> {
  try {
    return await compiledImport(url);
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    // 只在这类"这个环境里没有动态 import 回调"的错误上回落，别把插件自己的报错吞了
    if (!/dynamic import callback|import\(\) is not a function|Cannot use import statement/i.test(message)) throw error;
    return (await import(url)) as PluginModule;
  }
}

/** 插件工具的运行体。 */
export type PluginToolRun = (input: unknown, ctx: { sessionId?: string }) => Promise<unknown> | unknown;

/** 一个插件导出的东西（作者写的形状）。 */
export type PluginModule = {
  tools?: Record<string, { description?: string; inputSchema?: unknown; run?: PluginToolRun }>;
  hooks?: Partial<Record<HookName, (payload: unknown) => unknown>>;
};

/** 装载结果。 */
export type LoadedPlugin = {
  name: string;
  version: string;
  dir: string;
  /** 可以进注册表的条目（已带前缀）。 */
  entries: ToolEntry[];
  /** 实际接上的钩子。 */
  hooks: Partial<Record<HookName, (payload: unknown) => unknown>>;
  /** 被扣下的能力（用户没批的注入类权限）—— 界面上要说出来。 */
  withheld: PluginPermission[];
  /** 装载过程中发现的问题（**报出来而不是吞掉**：插件少了一个工具，用户该知道）。 */
  problems: string[];
};

/**
 * 插件给的参数说明收窄成一份合法的 JSON Schema。
 *
 * ⚠️ 它可能什么都没有（作者偷懒）或者不是对象（写错了）—— 两种都退回
 * "一个空对象 schema"，而不是把坏东西交给 SDK（那会在建工具集时炸，
 * 而炸的位置离原因很远）。**"没有参数说明"与"参数说明是垃圾"都不该让插件装不上**：
 * 工具照样能用，只是模型对参数更糊涂一点。
 */
function normalizeSchema(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return { type: "object", properties: {} };
}

/** 已装载的工具运行体（键是带前缀的完整名字）。 */
const runners = new Map<string, PluginToolRun>();

/** 当前装载的插件（宿主从这里取条目与钩子）。 */
let loaded: LoadedPlugin[] = [];

/** 当前装载的所有插件。 */
export function loadedPlugins(): readonly LoadedPlugin[] {
  return loaded;
}

/** 注册表条目：所有已装载插件的工具（与 `mcpToolEntries()` 对称）。 */
export function pluginToolEntries(): ToolEntry[] {
  return loaded.flatMap((p) => p.entries);
}

/** 全部被扣下的能力（界面上"它申请了但你没批"那段）。 */
export function withheldCapabilities(): { plugin: string; permissions: PluginPermission[] }[] {
  return loaded.filter((p) => p.withheld.length).map((p) => ({ plugin: p.name, permissions: p.withheld }));
}

/**
 * 跑一个插件工具。
 *
 * @param name 带前缀的完整名字
 * @param input 模型给的参数
 * @returns 原样返回插件的结果；插件抛错则如实抛出（由执行体那条统一的路翻成 tool result）
 */
export async function runPluginTool(name: string, input: unknown): Promise<unknown> {
  const run = runners.get(name);
  if (!run) throw new Error(`没有这个插件工具：${name}（插件可能被卸载或关掉了）`);
  return run(input, {});
}

/**
 * 装载一个已安装的插件。
 *
 * ⚠️ 装载失败**不抛**：一个坏插件不该让整个应用起不来。
 * 失败原因进 `problems`，由调用方决定怎么显示。
 *
 * @param plugin 台账里的一条
 * @returns 装载结果（可能带 problems、也可能什么都没有）
 */
export async function loadPlugin(plugin: InstalledPlugin): Promise<LoadedPlugin> {
  const empty: LoadedPlugin = {
    name: plugin.name,
    version: plugin.version,
    dir: plugin.dir,
    entries: [],
    hooks: {},
    withheld: [],
    problems: [],
  };
  if (!existsSync(plugin.dir)) return { ...empty, problems: ["插件目录不在了"] };

  /*
   * ⭐ **先比对清单**（这是权限声明能不能立住的地方）。
   *
   * 磁盘上的清单可能是插件装完之后改过的 —— 那时它要的东西
   * 已经**不是用户批准过的那一份**了。这种情况一律**不装载**，
   * 让用户重新确认一次（而不是替他决定"应该没问题"）。
   */
  const onDisk = readManifestFromDir(plugin.dir);
  if (!onDisk.raw) {
    return { ...empty, problems: [`读不到清单：${onDisk.note ?? "未知原因"}`] };
  }
  const checked = checkManifest(onDisk.raw);
  if (!checked.ok) return { ...empty, problems: [`磁盘上的清单不合法：${checked.errors.join("；")}`] };
  const drift = manifestDrifted(plugin.manifest, checked.manifest);
  if (drift) {
    return { ...empty, problems: [`它在安装之后被改过，已拒绝装载：${drift}。请卸载后重新安装并确认权限`] };
  }

  /** 授权与装载都以**批准时那份快照**为准（磁盘那份只用来比对）。 */
  const approved = plugin.manifest;
  const caps = grantedCapabilities(approved, plugin.granted);

  const entryFile = path.join(plugin.dir, approved.main ?? "index.mjs");
  if (!existsSync(entryFile)) return { ...empty, withheld: caps.withheld, problems: [`入口文件 ${approved.main ?? "index.mjs"} 不在了`] };

  let mod: PluginModule;
  try {
    /*
     * 动态 import：插件是**用户装的代码**，加载它等于执行它 —— 这正是 v1 的边界
     * （进程内、同权限）。`?v=<installedAt>` 是刻意的：改过插件之后重新装载
     * 不会被 Node 的模块缓存挡住（否则"改了没生效"会成为一个假 bug）。
     *
     * ⚠️⚠️ 必须用 `dynamicImport`（不是直接写 `import()`）：
     * TypeScript 在 **CommonJS 目标**下会把 `import(x)` **编译成 `require(x)`**，
     * 而 `require` 加载不了 ESM 插件 —— 桌面主进程正是 CJS（`tsconfig.electron.json`），
     * 于是同一段代码在 CLI（tsx/ESM）里好好的、在桌面里报
     * `Cannot find module 'file:///.../index.mjs'`（这个错误格式本身就是 require 的）。
     * 用 `new Function` 把 `import` 藏过编译，两种宿主都拿到**真正的**动态 import。
     */
    mod = await loadModule(`${pathToFileURL(entryFile).href}?v=${plugin.installedAt}`);
  } catch (error) {
    return { ...empty, withheld: caps.withheld, problems: [`装载失败：${error instanceof Error ? error.message : String(error)}`] };
  }

  const problems: string[] = [];
  const entries: ToolEntry[] = [];

  /*
   * ── 工具：声明与实现必须一致 ──
   *
   * 三种情况分别处理，都不静默：
   * · 声明了 + 导出了 → 接上；
   * · 声明了 + 没导出 → **报出来**（用户以为有这个能力，其实没有）；
   * · 导出了 + 没声明 → **不接**（未声明的能力不予注入），并报出来。
   */
  const declaredTools = new Set(approved.tools ?? []);
  const exportedTools = Object.keys(mod.tools ?? {});
  if (caps.tools) {
    for (const tool of declaredTools) {
      const def = mod.tools?.[tool];
      if (!def) {
        problems.push(`清单声明了工具 ${tool}，但代码里没有导出它`);
        continue;
      }
      if (typeof def.run !== "function") {
        problems.push(`工具 ${tool} 没有 run 函数`);
        continue;
      }
      const full = pluginToolName(plugin.name, tool);
      runners.set(full, def.run as PluginToolRun);
      entries.push({
        name: full,
        source: "plugin",
        description: typeof def.description === "string" && def.description ? def.description : `${plugin.name} 提供的 ${tool}`,
        /*
         * 插件给的是**纯 JSON Schema**（它不该依赖我们的 zod 版本）—— 与 MCP 那条同一个口径。
         *
         * ⚠️ 必须用 `jsonSchema()` 包一层：直接把这个普通对象交给 `tool({ inputSchema })`，
         * AI SDK 会把它当 schema 函数去调，然后在**真正建工具集时**报
         * `schema is not a function` —— 单测只查了条目的形状，是 CLI 真跑一轮才露出来的。
         */
        inputSchema: jsonSchema(normalizeSchema(def.inputSchema)),
      });
    }
    for (const exported of exportedTools) {
      if (!declaredTools.has(exported)) problems.push(`代码导出了工具 ${exported}，但清单里没声明它 —— 按"未声明不注入"处理`);
    }
  } else if (exportedTools.length) {
    problems.push(`导出了 ${exportedTools.length} 个工具，但没有 \`tools:register\` 权限（未批准或不申请）—— 一个都没接上`);
  }

  /*
   * ── 钩子：同理，声明之外的**不调用** ──
   */
  const declaredHooks = new Set(approved.hooks ?? []);
  const hooks: Partial<Record<HookName, (payload: unknown) => unknown>> = {};
  if (caps.hooks) {
    for (const hook of declaredHooks) {
      const fn = mod.hooks?.[hook];
      if (typeof fn !== "function") {
        problems.push(`清单声明了钩子 ${hook}，但代码里没有导出它`);
        continue;
      }
      hooks[hook] = fn;
    }
    for (const exported of Object.keys(mod.hooks ?? {})) {
      if (!declaredHooks.has(exported as HookName)) {
        problems.push(`代码导出了钩子 ${exported}，但清单里没声明它 —— 不会被调用`);
      }
    }
  } else if (Object.keys(mod.hooks ?? {}).length) {
    problems.push("导出了钩子，但没有 `hooks:register` 权限 —— 一个都不会被调用");
  }

  return { name: plugin.name, version: plugin.version, dir: plugin.dir, entries, hooks, withheld: caps.withheld, problems };
}

/**
 * 装载台账里**全部开着**的插件（每次启动一次；切换开关后重新调）。
 *
 * @param installed 台账里的条目
 * @returns 装载结果（顺序与入参一致）
 */
export async function loadEnabledPlugins(installed: readonly InstalledPlugin[]): Promise<LoadedPlugin[]> {
  runners.clear();
  const out: LoadedPlugin[] = [];
  for (const plugin of installed) {
    if (!plugin.enabled) continue;
    out.push(await loadPlugin(plugin));
  }
  loaded = out;
  return out;
}

/** 清空装载状态（测试与"关掉全部插件"用）。 */
export function resetPlugins(): void {
  runners.clear();
  loaded = [];
}

/**
 * 跑一个生命周期钩子（**只看不改**）。
 *
 * ⚠️ 三条都要做到：
 * 1. **不认识这个点就直接返回**（插件声明了没用过的点也不算错）；
 * 2. **一个钩子抛错不影响别的钩子**，也不影响这一轮 —— 插件的问题不该变成用户的故障；
 * 3. **返回值一律忽略**（见文件头第 2 条边界）。
 *
 * @param hook 生命周期点
 * @param payload 这一点的载荷（形状由各点自己定）
 */
export async function runHooks(hook: HookName, payload: unknown): Promise<void> {
  for (const plugin of loaded) {
    const fn = plugin.hooks[hook];
    if (!fn) continue;
    try {
      await fn(payload);
    } catch (error) {
      // 如实打出来，但不抛：插件坏了不该拖垮这一轮
      console.error(`[plugin] ${plugin.name} 的 ${hook} 钩子抛错：`, error instanceof Error ? error.message : error);
    }
  }
}

/**
 * 把这一份实现接到内核的钩子端口上（V5-4 4.1）。
 *
 * Node 侧的宿主（CLI / 桌面）在 `createEngine` 时注入它；最小嵌入面
 * （`ding-engine-core`）不注入 —— 那时内核用 `noopHooks`，
 * "没装插件"与"没有钩子能力"在那里是同一件事。
 */
export const pluginHooks: HooksPort = { run: runHooks };
