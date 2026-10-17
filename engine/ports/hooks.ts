import type { HookName } from "../runtime/plugins";

/**
 * **插件钩子端口**（V5-4 任务 4.1）。
 *
 * 钩子要装载并执行**外部**代码（模组文件、子进程）—— 那是宿主的事，不是内核的事。
 * 内核只留这一个口子：`run(hook, payload)` 一次调用一个钩子，返回值不看
 * （只看不改，理由在 `runtime/registry.ts` 的调用处）。
 *
 * 不给 = **没有钩子**：这正是最小嵌入面（`ding-engine-core`）的形态 ——
 * 一轮真实回合不需要插件也能跑完，"没装插件"与"没接线"在这里是同一件事。
 * Node 侧要插件能力时注入 `runtime/pluginHost.ts` 的 `pluginHooks`。
 */
export type HooksPort = {
  run: (hook: HookName, payload: unknown) => Promise<void>;
};

/** 没有钩子（默认）—— 用常量而不是 `undefined`，免得调用处到处 `?.`。 */
export const noopHooks: HooksPort = { run: async () => undefined };
