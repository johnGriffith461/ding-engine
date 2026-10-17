import { isPendingOutput, splitTurns, type ApprovalGrantRecord, type ApprovalRecord, type LogRecord, type TurnChunk } from "./events";

/**
 * **审批闸门的语义**（Phase 1 D5 尾部）。
 *
 * ## 它统一了什么
 *
 * 换代之前，"一次被拦下的调用"这件事的语义散在两处：
 *
 * | 问题 | 原来 | 现在 |
 * |---|---|---|
 * | 现在有哪些待办？ | `resumeSession` 里一段 for 循环自己挑 `trace.pending` | `pendingGates()` |
 * | 用户批了之后记什么？ | 宿主（`electron/ipc/ai.ts`）里**两个对象字面量**各拼一遍 | `approvalRecord()` |
 *
 * 第二个是真正的问题：批准与拒绝那两条分支**手抄了同一个形状**，
 * 抄漏一个字段（比如 `output`）不会报错 —— 只会表现为"重启后那条留痕变成一个没有内容的空壳"。
 * 收成一处之后，"决策记录长什么样"只有这个文件能改。
 *
 * ## ⚠️ 一处刻意的**不做**
 *
 * 方案里写过"pending 从消息上的一条 trace 升级为**独立的 gate 事件类型**"。
 * 这里**没有**新增事件类型，理由是可验证的：
 *
 * - 目的（重启后能还原待决列表、决策可审计、旧日志可读）**已经由现有记录形状满足** ——
 *   `tool-result` 里的 `{pending:true}` + `approval` 记录 + 回溯应用，
 *   三条合起来就是一份完整的"拦下 → 谁批的 → 结果"；
 * - 新增一个事件类型意味着**旧日志里没有它**，于是"读旧日志"的每条路径都要多一个分支 ——
 *   而它换来的可观测性增量是零（同样的信息已经在流里）。
 *
 * 所以这一层做的是**把语义收拢并命名**，不是改格式。哪天真需要"闸门本身"成为一个
 * 可查询的一等实体（比如按闸门统计人类响应时长），那时再引入事件类型，
 * 并把它当作一次**带迁移的格式变更**来做。
 */

/**
 * 一次「被拦下、还没处置」的调用。
 *
 * ⚠️ 带上 `input` 是因为放行时要**原样执行**那份参数（主进程不接受前端改过的参数）。
 * 参数丢了就只能重问用户一次 —— 那条路实测踩过
 * （`Cannot read properties of undefined (reading 'text')`）。
 */
export type GateRequest = {
  toolCallId: string;
  name: string;
  input?: unknown;
  /**
   * **待谁批**（C3，V5-1 3.7a）：审批人集合（成员 id）。
   *
   * 缺省 = `[DEFAULT_APPROVER]`（本机单用户；这段会话的 owner 就是那个用户）。
   * 取值口径见 `pendingGates` —— 拦下来那一刻写在 pending 载荷里（`approvers`），
   * 不在读的时候现编（"谁能批"是**拦下时就该定**的事实，与"当时谁在场"无关）。
   */
  approvers: string[];
};

/**
 * 本机单用户那个审批人的 id（与 `LOCAL_USER.id` 同一个人，两处都写 `local` 是刻意的：
 * 一个是"谁说的"、一个是"谁能批"，V5-3 团队空间接进来之前它们落到同一个身份上）。
 */
export const DEFAULT_APPROVER = "local";

/**
 * 现在有哪些待办（按发生顺序）。
 *
 * ⚠️ 从**收尾后**的留痕里挑，而不是从原始事件流里挑：决策记录会**回溯**应用到它对应的
 * 那一轮（用户可能在那轮结束很久之后才点允许），所以"已经批过的那条"在留痕里
 * 已经不是 pending 了。从原始事件挑会挑出一堆"其实早就批过"的假待办 ——
 * 界面会给用户一个假的按钮，而他点了之后什么都不会发生。
 *
 * @param turns 按轮切好的会话（`splitTurns` 的输出）
 * @returns 待办清单
 */
export function pendingGates(turns: readonly TurnChunk[]): GateRequest[] {
  const out: GateRequest[] = [];
  for (const chunk of turns) {
    for (const trace of chunk.view.traces) {
      if (trace.pending !== true) continue;
      out.push({
        toolCallId: trace.toolCallId,
        name: trace.name,
        ...(trace.input === undefined ? {} : { input: trace.input }),
        approvers: approversOf(trace.output),
      });
    }
  }
  return out;
}

/**
 * 从 pending 载荷里取审批人集合（读路径的**唯一口径**）。
 *
 * 三种来源，按优先级：
 *   ① 载荷里带 `approvers`（拦下那一刻定的，2026-10-17 之后新产生的都带）；
 *   ② 老载荷（没有这个字段）→ 默认 `[DEFAULT_APPROVER]` —— 兼容矩阵口径
 *      （"旧审批（无审批人集合）→ 默认审批人=owner"，V5 §3.1）。
 *   ③ 形状坏掉（不是字符串数组）→ 同 ②（**不**把它当"没人能批"：
 *      那会让一条本来能处置的待办永远卡住）。
 *
 * @param payload 工具结果载荷（`{pending:true, approvers?}`）或留痕上的 output
 * @returns 审批人 id（去重、保序；恒非空）
 */
export function approversOf(payload: unknown): string[] {
  const raw = (payload as { approvers?: unknown } | null | undefined)?.approvers;
  if (!Array.isArray(raw)) return [DEFAULT_APPROVER];
  const got = [...new Set(raw.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))];
  return got.length ? got : [DEFAULT_APPROVER];
}

/** 一次裁决请求的核对结果（C3 状态机的**纯函数**那一半）。 */
export type DecisionCheck =
  | { ok: true }
  | {
      ok: false;
      /**
       * `stale`：这条已经不是待决了（已经处置过）；
       * `not-approver`：这个人不在审批人集合里（**没有裁决权**）。
       */
      code: "stale" | "not-approver";
      /** 给人看的一句话（直接可以显示/回注）。 */
      message: string;
    };

/**
 * **谁有裁决权 + 这条还开着吗**（C3，ADR-008）。
 *
 * 对齐 DeepSeek-Bot `approvals.js` 的两条机制（源码级参照记在 ADR-008）：
 *   · **幂等 answer + stale 报错**（"这条审批已经不再开着"`bot/stale`）——
 *     重复点、两个窗口同时点，第二次拿到的是明确的话，而不是"又执行一次"；
 *   · **归属决定谁来批**（那边是 sessionId/botId/roomId 三元组 → approver 集合，
 *     这里是 pending 载荷里的 `approvers`）。
 *
 * @param input.approvers 这条待决的审批人集合
 * @param input.actorId 现在要处置的人
 * @param input.alreadyDecided 这条是否已经被处置过（调用方从日志查，见 `decidedByOf`）
 * @returns 能不能处置；不能的话给出代码与人话
 */
export function canDecide(input: {
  approvers: readonly string[];
  actorId: string;
  alreadyDecided: boolean;
}): DecisionCheck {
  if (input.alreadyDecided) {
    return {
      ok: false,
      code: "stale",
      message: "这条待确认已经处置过了（重复点不会执行第二次）。刷新一下就能看到结论。",
    };
  }
  if (!input.approvers.includes(input.actorId)) {
    return {
      ok: false,
      code: "not-approver",
      message: `这条待确认不归你批（待批的人：${input.approvers.join(" / ")}）—— 请让有裁决权的人处理，或请他们把裁决权授给你。`,
    };
  }
  return { ok: true };
}

/**
 * **授权他人批**（C3，3.7b）：把 target 加进这条待决的审批人集合。
 *
 * 规矩（ADR-008）：只有**现有审批人**能授权（不能自己挤进一张不属于自己的单子）、
 * 目标必须是个非空 id、重复授权如实说"已经在名单里"（幂等，不算错）。
 *
 * @param input.approvers 现有集合
 * @param input.byActorId 谁在授权
 * @param input.targetId 授权给谁
 * @returns 新的集合或拒绝原因
 */
export function authorizeApprover(input: {
  approvers: readonly string[];
  byActorId: string;
  targetId: string;
}): { ok: true; approvers: string[]; added: boolean } | { ok: false; code: "not-approver" | "invalid-target"; message: string } {
  const target = String(input.targetId ?? "").trim();
  if (!target) return { ok: false, code: "invalid-target", message: "要授权给谁？成员 id 是空的。" };
  if (!input.approvers.includes(input.byActorId)) {
    return {
      ok: false,
      code: "not-approver",
      message: `你不是这条待确认的审批人（待批的人：${input.approvers.join(" / ")}），不能把裁决权转给别人。`,
    };
  }
  if (input.approvers.includes(target)) {
    return { ok: true, approvers: [...input.approvers], added: false };
  }
  return { ok: true, approvers: [...input.approvers, target], added: true };
}

/** 一次决策的输入。 */
export type GateDecision = {
  toolCallId: string;
  /** 决策针对哪个工具（留痕要按名字找它）。 */
  name: string;
  approved: boolean;
  /**
   * 放行执行的结果。
   *
   * ⚠️ **批准时要把结果一起记进去**（拒绝时没有）：重放日志时要能还原成
   * "已保存，当前 N 条"那一行 —— 只记"批过了"的话，重启后那条留痕是个没有内容的空壳。
   */
  result?: { ok: boolean; output?: unknown; error?: string };
  /** 界面上那一行（主进程生成，与放行时返回给界面的**同一句**）。 */
  line: string;
  /**
   * **谁批的**（C3，3.7b）：成员 id。老路径（不传）= 不记 decidedBy
   * —— 兼容矩阵口径：老决策记录没有这一格，读回来按 `legacy` 兜底（见 `decidedByOf`）。
   */
  decidedBy?: string;
  /** 当时的审批人集合（记下来，"当时待谁批"才可复盘）。 */
  approvers?: readonly string[];
};

/**
 * 把一次决策拼成**日志记录**（落盘形态由 store 补 `seq`/`at`）。
 *
 * @param decision 见 `GateDecision`
 * @returns 决策记录
 */
export function approvalRecord(decision: GateDecision): Omit<ApprovalRecord, "seq" | "at"> {
  const { result } = decision;
  return {
    type: "approval",
    toolCallId: decision.toolCallId,
    name: decision.name,
    approved: decision.approved,
    ...(decision.decidedBy ? { decidedBy: decision.decidedBy } : {}),
    ...(decision.approvers?.length ? { approvers: [...decision.approvers] } : {}),
    ...(decision.approved && result
      ? {
          ok: result.ok,
          ...(result.output === undefined ? {} : { output: result.output }),
          ...(result.error ? { error: result.error } : {}),
        }
      : {}),
    line: decision.line,
  };
}

/**
 * **一条待决的授权记录**（`authorizeApprover` 通过之后要落的那条，C3 3.7b）。
 *
 * 与 `approvalRecord` 分开两个工厂：一个记"批了/拒了"，一个记"把裁决权授出去了"。
 * 合成一个的话，"授权"会被读成一次决策（`approved: true/false` 没有对应的语义），
 * 而重放时那条待决会被误判成已处置。
 *
 * @param input.toolCallId 哪条待决
 * @param input.by 谁授的权（必须是**当时**的审批人之一 —— 判定由 `authorizeApprover` 做）
 * @param input.target 授给谁
 * @param input.approvers **授权之后**的集合
 * @param input.line 界面上那一行
 * @returns 记录（落盘形态由 store 补 `seq`/`at`）
 */
export function grantRecord(input: {
  toolCallId: string;
  by: string;
  target: string;
  approvers: readonly string[];
  line: string;
}): Omit<ApprovalGrantRecord, "seq" | "at"> {
  return {
    type: "approval-grant",
    toolCallId: input.toolCallId,
    by: input.by,
    target: input.target,
    approvers: [...input.approvers],
    line: input.line,
  };
}

/**
 * **授权那一行**（界面与 HTTP 回执共用一句 —— 两处各写一遍必然漂）。
 *
 * @param input.by 谁授的权
 * @param input.target 授给谁
 */
export function grantLine(input: { by: string; target: string }): string {
  return `🔑 ${input.by} 把裁决权授给了 ${input.target}`;
}

/** 「这个人已经在名单里」的回执（重复授权**不算错**，但也不会再记一条 —— 幂等）。 */
export const GRANT_ALREADY_NOTE = "这个人已经在审批人名单里（重复授权不算错，也没有再记一条）";

/**
 * **这条待决现在归谁批**（C3 3.7b：pending 载荷 + 之后的授权记录）。
 *
 * 读路径的唯一口径，两条来源按顺序叠加：
 *   ① pending 载荷里的 `approvers`（拦下那一刻定的；老载荷落默认，见 `approversOf`）；
 *   ② 之后每一条 `approval-grant` 记录的 `approvers`（后写的覆盖前面的 —— 授权是累加的，
 *      而记录下来的那一份就是"授权之后"的完整集合）。
 *
 * ⚠️ 与 `pendingGates`（按轮切好之后的留痕）**不是一回事**：那个给界面看"有哪些待办"，
 * 这个回答"谁能批"（含运行期授权）—— 后者只有日志能回答（授权记录不属于任何一轮的正文）。
 *
 * @param records 整段会话日志（按 seq）
 * @param toolCallId 哪次调用
 * @returns 审批人 id（去重、保序；恒非空）
 */
export function approversFor(records: readonly LogRecord[], toolCallId: string): string[] {
  let current: string[] | null = null;
  for (const record of records) {
    if (record.type !== "tool-result") continue;
    if ((record as { toolCallId?: string }).toolCallId !== toolCallId) continue;
    if (!isPendingOutput((record as { output?: unknown }).output)) continue;
    current = approversOf((record as { output?: unknown }).output);
  }
  for (const record of records) {
    if (record.type !== "approval-grant") continue;
    if (record.toolCallId !== toolCallId) continue;
    const list = [...new Set(record.approvers.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))];
    if (list.length) current = list;
  }
  return current ?? [DEFAULT_APPROVER];
}

/**
 * 从日志里找某一次调用**还没处置**的那条待决（C3 的宿主接线用）。
 *
 * @param records 整段会话日志（按 seq）
 * @param toolCallId 哪次调用
 * @returns 那条待决（含"待谁批"）；不在待决里（已批过 / 日志被截过）→ null
 */
export function pendingFor(records: readonly LogRecord[], toolCallId: string): GateRequest | null {
  return pendingGates(splitTurns(records)).find((g) => g.toolCallId === toolCallId) ?? null;
}

/**
 * 这条待决**已经处置过了吗**（`canDecide` 的 stale 判据从日志来）。
 *
 * @param records 整段会话日志（按 seq）
 * @param toolCallId 哪次调用
 * @returns 处置过 → 谁批的（老记录没记 `decidedBy` 时给 `"legacy"`）；没处置过 → null
 */
export function decidedByOf(records: readonly ApprovalRecord[], toolCallId: string): string | null {
  const hit = records.find((r) => r.type === "approval" && r.toolCallId === toolCallId);
  if (!hit) return null;
  return hit.decidedBy?.trim() || "legacy";
}
