import type { ToolSet } from "ai";

import type { ConfirmMode } from "../../shared/ipc";
import type { HealthStore } from "../ports/health";
import { type AgentSpec, agentNames, findAgent, resolveAgentMode } from "./agents";
import { runSubagent } from "./subagent";
import type { SubagentBlocked, SubagentReport } from "../../shared/agentTools";

/**
 * **coordinator / specialist 协作**（Phase 7.2）。
 *
 * ## 它是什么
 *
 * 一个 coordinator（就是主对话的那个 agent）把一件事**拆成几件**，
 * 每件交给一个持有自己 AgentSpec 的 specialist，**并行**办完，
 * 最后由 coordinator 把几份要点**汇合**成一句话回答用户。
 *
 * ```
 *   coordinator ──┬─→ researcher ─→ 要点 ─┐
 *                 ├─→ researcher ─→ 要点 ─┤─→ 汇合 → 用户
 *                 └─→ runner     ─→ 要点 ─┘
 * ```
 *
 * ## 四件必须做对的事（都有对应的实现与断言）
 *
 * | 要求 | 怎么落 |
 * |---|---|
 * | **并行** | `Promise.all` —— 三个专家同时跑，不是排队 |
 * | **各自独立上下文** | 每个只拿到自己那条任务与背景，看不到父对话 |
 * | **闸门不穿透** | 每个 specialist 的工具集都过**同一张闸门表**，且档位**只能更严**（`resolveAgentMode`） |
 * | **成本上卷** | 每个的 token 用量汇总回父级（`describeToolResult` 会写进留痕） |
 *
 * ## 进度要**能看见**（这是与"只回一份报告"的区别）
 *
 * 并行意味着"三个专家在跑"这件事有**期间状态**：跑了一半被停、某一个跑砸了、
 * 某一个被闸门拦下了 —— 这些如果只体现在最后那份报告里，用户在中途什么都看不到。
 * 所以每次开始/结束都上报一条 `onDelegation`（宿主把它记成 `delegation` 事件）。
 *
 * ⚠️ 一条边界（如实）：**失败不中断整队**。一个专家跑砸了，其余照跑，
 * 报告里如实写"这一个失败了 + 原因"。这与"错误即结果"同一个口径 ——
 * 整队因为一个成员失败而全丢，等于把一个可救的情况变成不可救。
 */

/** 交给一个 specialist 的一件事。 */
export type TeamTask = {
  /** 用哪个 agent（`engine/runtime/agents.ts` 里的名字）。 */
  agent: string;
  /** 自包含的任务说明。 */
  task: string;
  /** 背景材料（可选）。 */
  context?: string;
};

/** 造工具集的方法（宿主给的：注册表 + 闸门 + 白名单）。 */
export type MakeTools = (
  mode: ConfirmMode,
  depth: number,
  provider: string,
  signal: AbortSignal | undefined,
  /** 只要这些工具（agent 的白名单）；省略 = 不限制。 */
  only?: readonly string[],
) => ToolSet;

/** 一条进度（宿主据此记 `delegation` 事件）。 */
export type TeamProgress = {
  /** 这一次派活的 id（同一个专家的开始与结束配对用）。 */
  delegationId: string;
  agent: string;
  task: string;
  status: "started" | "finished";
  /** 只在该专家结束时才有。 */
  ok?: boolean;
  summary?: string;
  steps?: number;
  error?: string;
};

/** 一个 specialist 的产出。 */
export type TeamMemberResult = {
  agent: string;
  task: string;
  ok: boolean;
  /** 要点报告（失败时为空串）。 */
  summary: string;
  steps: number;
  /** 调过哪些工具（如实记，失败时也记）。 */
  toolCalls: string[];
  /** 被闸门拦下的调用（父级与用户都该看得见"它想做但没被批准"）。 */
  blocked: SubagentBlocked[];
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
};

/** 整队的产出。 */
export type TeamReport = {
  ok: boolean;
  /** 汇合后的报告（coordinator 读这一段就够）。 */
  summary: string;
  members: TeamMemberResult[];
  /** 成本上卷：全队 token 合计（一个数都没有时 undefined —— **不编**）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 全队被拦下的调用合计。 */
  blocked: SubagentBlocked[];
  /** 有几个成员失败（如实报，不掩盖）。 */
  failed: number;
};

/**
 * 跑一支小队。
 *
 * @param input 见 `TeamRunInput`
 * @returns 整队报告
 */
export async function runTeam(input: {
  tasks: readonly TeamTask[];
  provider: string;
  model?: string;
  /** 调用方（用户）的档位 —— 每个 specialist 只能更严。 */
  callerMode: ConfirmMode;
  makeTools: MakeTools;
  signal?: AbortSignal;
  health?: HealthStore;
  /** 当前嵌套深度（父级的；本函数会 +1 传给 specialist）。 */
  depth?: number;
  onDelegation?: (event: TeamProgress) => void;
}): Promise<TeamReport> {
  const depth = (input.depth ?? 0) + 1;
  const tasks = input.tasks.filter((t) => String(t.task ?? "").trim());

  const members = await Promise.all(
    tasks.map(async (item, index): Promise<TeamMemberResult> => {
      const delegationId = `dlg-${index}-${Math.random().toString(36).slice(2, 8)}`;
      const spec: AgentSpec | undefined = findAgent(item.agent);
      /*
       * ⚠️ 不认识的 agent 名**不静默当成默认的**：那样 coordinator 写错一个名字，
       * 用户会得到一个"看起来跑了、其实跑错了角色"的结果（例如让 researcher 去写文件）。
       * 如实失败，并把它当可用的名字列出来。
       */
      if (!spec) {
        const error = `没有叫「${item.agent}」的 agent（可用：${agentNames().join(" / ")}）`;
        input.onDelegation?.({ delegationId, agent: item.agent, task: item.task, status: "finished", ok: false, error });
        return { agent: item.agent, task: item.task, ok: false, summary: "", steps: 0, toolCalls: [], blocked: [], error };
      }

      const mode = resolveAgentMode(input.callerMode, spec.mode);
      input.onDelegation?.({ delegationId, agent: spec.name, task: item.task, status: "started" });

      const { system, user } = promptFor(spec, item);
      let report: SubagentReport;
      try {
        report = await runSubagent({
          provider: input.provider,
          ...(input.model ? { model: input.model } : {}),
          system,
          user,
          tools: input.makeTools(mode, depth, input.provider, input.signal, spec.tools),
          maxSteps: spec.maxSteps,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.health ? { health: input.health } : {}),
        });
      } catch (error) {
        // 执行体抛错也要变成"这个成员失败了"，而不是把整队带崩（错误即结果）
        report = {
          ok: false,
          summary: "",
          steps: 0,
          toolCalls: [],
          blocked: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }

      input.onDelegation?.({
        delegationId,
        agent: spec.name,
        task: item.task,
        status: "finished",
        ok: report.ok,
        summary: report.summary.slice(0, 500),
        steps: report.steps,
        ...(report.error ? { error: report.error } : {}),
      });

      return {
        agent: spec.name,
        task: item.task,
        ok: report.ok,
        summary: report.summary,
        steps: report.steps,
        toolCalls: report.toolCalls,
        blocked: report.blocked,
        ...(report.usage ? { usage: report.usage } : {}),
        ...(report.error ? { error: report.error } : {}),
      };
    }),
  );

  return merge(members);
}

/**
 * 每个 specialist 的系统提示与用户消息。
 *
 * ⚠️ 系统提示按 **agent 自己的声明**给（不是所有专家共用一段）——
 * 那正是"数据化"的意义：researcher 的提示里写着"你没有写权限"，
 * 而它的工具集里**确实**没有写工具。两处一致，它才不会浪费时间试。
 */
function promptFor(spec: AgentSpec, item: TeamTask): { system: string; user: string } {
  const user = item.context?.trim() ? `${item.task.trim()}\n\n【背景】\n${item.context.trim()}` : item.task.trim();
  return { system: spec.systemPrompt, user };
}

/**
 * 汇合。
 *
 * 报告是给 **coordinator** 读的（它据此回答用户），所以：
 * 每个成员一小段、结论在前、失败的**照样写进去**（不静默丢）。
 */
function merge(members: readonly TeamMemberResult[]): TeamReport {
  const failed = members.filter((m) => !m.ok).length;

  const sections = members.map((m) => {
    const head = `【${m.agent}】${m.ok ? "" : "（失败）"}`;
    const body = m.ok ? m.summary.trim() || "（没有给出要点）" : `失败：${m.error ?? "原因不明"}`;
    const cost = m.usage ? `　[${(m.usage.inputTokens ?? 0) + (m.usage.outputTokens ?? 0)} tokens]` : "";
    const blocked = m.blocked.length ? `　[${m.blocked.length} 项等你确认]` : "";
    return `${head}${cost}${blocked}\n${body}`;
  });

  const withUsage = members.filter((m) => m.usage);
  const usage = withUsage.length
    ? {
        inputTokens: withUsage.reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0),
        outputTokens: withUsage.reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0),
      }
    : undefined;

  return {
    ok: failed === 0 && members.length > 0,
    summary: sections.join("\n\n"),
    members: [...members],
    ...(usage ? { usage } : {}),
    blocked: members.flatMap((m) => m.blocked),
    failed,
  };
}
