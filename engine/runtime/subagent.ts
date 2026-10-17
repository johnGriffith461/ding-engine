import type { ToolSet } from "ai";

import type { HealthStore } from "../ports/health";

import { applyEvent, emptyTurn, finishTurn } from "../core/events";
import type { SubagentBlocked, SubagentReport } from "../../shared/agentTools";
import { runTurn } from "./loop";

/**
 * 子智能体（§150）。
 *
 * ## 它是什么
 *
 * 一个**有自己一份上下文**的独立工作单元：父级把一件自包含的事交给它，
 * 它自己用工具办完，**只回一份要点报告**（不是它整段对话）。
 *
 * 依据 cline 的 `spawn_agent`；四件必须做对的事：
 *
 * | 要求 | 这一版怎么落 |
 * |---|---|
 * | 独立上下文 | 自己的 `messages`（只有任务与背景，看不到父对话） |
 * | 汇合并行 | 每个子智能体各跑各的，父级拿到的是它那份**摘要** |
 * | **成本上卷** | 把 token 用量回给父级，留痕里写出来（`describeToolResult`） |
 * | **审批穿透** | 子智能体拿的是**同一张闸门表**（同一个 `mode`）—— 它绕不过去 |
 *
 * ## 审批穿透具体是什么样
 *
 * 子智能体里的工具同样过闸门：`ask` 档下**不执行**，回一条"要看用户确认"。
 * 于是它能自由做只读的事，而**凡是会改东西的动作都办不成**，
 * 但**会如实写进报告**（`blocked`）—— 父级与用户都看得见"它想做但没被批准"。
 *
 * ⚠️ v1 的取舍（如实）：**子智能体里的 `ask` 没有"当场点允许"的按钮** ——
 * 那些动作要由父级（或用户）另起一次调用才会出现确认按钮。
 * 这比"子智能体静默地绕过了闸门"好得多：**宁可办不成，不能不问就办**。
 *
 * ── C2-3（2026-10-13）：主循环收进 `engine/runtime/loop.ts`（曾名 `./runTurn`）──
 *
 * 这里原来自己写了一份 `streamText` + `fullStream` 循环，于是它**少了父级有的四样**：
 * 中止信号、`tool-error` 分支、provider 健康标记、模型可用性校验。
 * 现在两条路都是 `runTurn`，差别只剩**参数**（子智能体 `maxSteps: 6`、父级 4 —— 各自的经验值，不许顺手统一）。
 *
 * ⚠️ 报告的**收集**也换成投影（`shared/sessionLog.ts` 的 `applyEvent`）：
 * 正文、调过哪些工具、哪些被拦下 —— 原来是手写的三个累加变量，现在只有一份算法。
 */

/**
 * 跑一个子智能体。
 *
 * @param input.task 自包含的任务说明
 * @param input.context 背景材料
 * @param input.provider 主请求用的 provider（沿用同一个，不另配渠道）
 * @param input.model 主请求用的模型
 * @param input.system 子智能体的系统提示词（`subagentPrompt` 生成，由调用方传进来）
 * @param input.user 子智能体的用户消息
 * @param input.tools **已经按同一个闸门档位建好的**工具集
 * @param input.maxSteps 最多几步（默认 6）
 * @param input.signal 父级的中止信号（用户点停时，子智能体也得停）
 * @returns 要点报告
 */
export async function runSubagent(input: {
  provider: string;
  model?: string;
  system: string;
  user: string;
  tools: ToolSet;
  maxSteps?: number;
  signal?: AbortSignal;
  /** 宿主的健康账本（沿父级那一份 —— 子智能体跑通/跑砸同样算这一家的健康）。 */
  health?: HealthStore;
}): Promise<SubagentReport> {
  /** 这一轮的事件（用投影收集报告：正文/工具/拦下的调用都在里面）。 */
  let turn = emptyTurn();
  let finishes = 0;

  const outcome = await runTurn(
    {
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      system: input.system,
      messages: [{ role: "user", content: input.user }],
      tools: input.tools,
      maxSteps: input.maxSteps ?? 6,
      ...(input.signal ? { abortSignal: input.signal } : {}),
    },
    (event) => {
      // 事件先过投影（与界面那两条路同一个函数），再按需要累计
      turn = applyEvent(turn, event);
      if (event.type === "step-finish") finishes += 1;
    },
    /* 健康账本沿父级那一份传下去：子智能体跑通/跑砸同样是在验这一家 provider。 */
    { ...(input.health ? { health: input.health } : {}) },
  );

  const view = finishTurn(turn);
  /**
   * 步数：优先用 `finish` 计数，拿不到就按"工具调用数 + 1"兜底（至少有一轮）。
   * ⚠️ 兜底那一支是原实现就有的（宁可给个保守数，也不要报 0 步）。
   */
  const steps = Math.max(finishes, view.traces.length + 1);
  /** 被闸门拦下的调用：**结构化**（工具名 + 参数都要留下，父级才能就地放行）。 */
  const blocked: SubagentBlocked[] = view.traces
    .filter((t) => t.pending)
    .map((t) => ({
      toolCallId: t.toolCallId,
      name: t.name,
      ...(t.input === undefined ? {} : { input: t.input }),
    }));

  const summary = view.text.trim();
  const base = {
    steps,
    toolCalls: view.traces.map((t) => t.name),
    blocked,
    ...(view.usage ? { usage: { inputTokens: view.usage.inputTokens, outputTokens: view.usage.outputTokens } } : {}),
  };

  if (!outcome.ok) {
    return { ok: false, summary: "", ...base, error: outcome.error ?? "子智能体没有跑完" };
  }
  /*
   * ⭐ **被中止要如实说"被中止"**（2026-10-16，审计 P36）。
   *
   * `runTurn` 在中止时返回 `{ok:true, aborted:true}` 且**一句话都没有**，
   * 而这里原来只看 `!outcome.ok` 与 `!summary` —— 于是用户点停止之后，
   * 父级收到的报告是「子智能体没有给出报告」（听起来像它坏了/偷懒），
   * 而它其实是**按你的意思停的**。同一件事在 ACP 宿主那边被单独补过一次，
   * 说明缺的这条就在内核里。
   */
  if (outcome.aborted) {
    return { ok: false, summary: "", ...base, error: "子智能体被中止了（这一轮是用户停的，不是它没给出报告）" };
  }
  if (!summary) {
    return { ok: false, summary: "", ...base, error: "子智能体没有给出报告" };
  }
  return { ok: true, summary, ...base };
}
