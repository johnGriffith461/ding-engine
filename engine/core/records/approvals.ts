import { normalizeActor, type Actor } from "../actor";

/**
 * **两条审批相关的记录**（V5 收尾从 `events.ts` 搬出来）。
 *
 * 搬的理由只有一个：`events.ts` 顶着巨石守卫的天花板（900 行），而这两型加起来
 * 近百行注释 —— 它们要说清两件事：
 *   ① 决策**为什么必须进日志**（不给的话重启后"谁批的"查不到）；
 *   ② 授权**为什么不能复用决策记录**（用拒绝表达授权会让重放把那**条待决误判成已处置**，
 *      界面上它会凭空消失）。
 *
 * 搬法与 `actor.ts` 同一套：**既有 import 一律不变**（`events.ts` re-export 这两型）。
 */

/**
 * 日志里的**决策记录**（INV-3）：用户批了还是拒了、放行之后结果如何。
 *
 * ## 为什么它必须进日志
 *
 * 批准/拒绝原来是**纯渲染进程状态**（`chatStore.ts` / `store.ts` 里的 `resolveTool`），
 * 主进程压根不知道 —— 于是：
 * - 重启之后**看不出那条调用到底谁批的**（"等确认"那条会原样回到界面上，用户以为没批过）；
 * - 批准这件事只有放行那次会路过主进程（`ai:runTool`），**拒绝连 IPC 都不发**。
 *
 * 记下来之后：一条被拦下的调用在日志里是"**拦下 → 谁批的 → 结果**"三段，
 * 重放日志就能把界面恢复到那一刻的样子（F3 的聊天历史恢复靠的正是这一条）。
 */
export type ApprovalRecord = {
  /**
   * 哪一轮的调用。
   *
   * ⚠️ **可以不填**：批准往往发生在那一轮**结束之后**（用户看着「等你确认」想一会儿才点），
   * 那时渲染层已经拿不到 requestId 了。真正的配对依据是 `toolCallId`
   * —— 所以这里允许缺，而 `splitTurns` 会**回溯**把它应用到对应那一轮（见那里的注释）。
   */
  requestId?: string;
  seq: number;
  at: number;
  type: "approval";
  /**
   * 谁批的（C5）。
   *
   * ⚠️ 本机单用户阶段写的是 `LOCAL_USER`；**V5-1 3.7（C3）会把它换成"真正的裁决人"**
   * （审批人集合里的那一个成员）—— 那时这一格就是审计答案"谁批的"本身。
   */
  actor?: Actor;
  /** 针对哪一次调用（与 `tool-call` / `tool-result` 同一个 id）。 */
  toolCallId: string;
  /** **谁批的**（C3，3.7b；老记录没有这一格 → 读回按 `"legacy"` 兜底，不编名字）。 */
  decidedBy?: string;
  /** 当时**待谁批**（成员 id 集合；也是可选的，老记录没有）。 */
  approvers?: string[];
  name: string;
  /** 用户批了没有。 */
  approved: boolean;
  /** 放行执行的结果（拒绝时没有：拒绝不执行）。 */
  ok?: boolean;
  output?: unknown;
  error?: string;
  /** 界面上那一行（主进程生成，与放行时返回给界面的**同一句**）。 */
  line: string;
};

/**
 * **授权他人批**（C3 3.7b 的流转那一半，2026-10-17 补）。
 *
 * 与 `approval` 是一对：那条说"谁批了/拒了"，这条说"主人把自己的裁决权授给了谁"。
 * 为什么要进日志（而不是只更新审批索引表）：**"谁能批"必须可复盘** ——
 * 只写进索引表的话，从日志重放就说不清"当时他凭什么能批"，
 * 而那张表自己也只是投影（真相在日志里，见 `sqliteSchema.ts` v6 的说明）。
 *
 * 一条待决的有效审批人 = pending 载荷里的 `approvers` + 之后每一条授权的 `approvers`
 * （后写的覆盖前面的，口径在 `gates.ts` 的 `approversFor`）。
 */
export type ApprovalGrantRecord = {
  /** 哪一轮的调用（同 `ApprovalRecord`：可以不填，配对依据是 `toolCallId`）。 */
  requestId?: string;
  seq: number;
  at: number;
  type: "approval-grant";
  actor?: Actor;
  /** 哪条待决。 */
  toolCallId: string;
  /** 谁授的权（必须是**当时的审批人之一** —— 判定在 `authorizeApprover`）。 */
  by: string;
  /** 授给谁。 */
  target: string;
  /** **授权之后**的审批人集合（含原有的与新增的）。 */
  approvers: string[];
  /** 界面上那一行。 */
  line: string;
};

/**
 * 收窄一条**决策记录**（`parseLogLine` 的那一支）。
 *
 * ⚠️ 这两支**都不要求** `requestId`：批准与授权常常发生在那一轮**结束之后**
 * （用户看着「等你确认」想一会儿才点，或者主人过一会儿才把裁决权授给别人），
 * 那时渲染层手里已经没有 requestId 了。真正的配对依据是 `toolCallId`。
 *
 * @param raw 已经确认是对象的原始行（会被就地规整 actor）
 * @returns 记录；形状不够就是 null（读回时算"坏行"，跳过它自己）
 */
export function normalizeApprovalRecord(raw: Record<string, unknown>): ApprovalRecord | null {
  // id / 批没批 / 那一行 —— 少一样就不是一条能重放的记录
  if (typeof raw.toolCallId !== "string" || typeof raw.approved !== "boolean") return null;
  if (typeof raw.line !== "string" || typeof raw.name !== "string") return null;
  raw.actor = normalizeActor(raw.actor);
  /*
   * C3 的两格（谁批的 / 当时待谁批）**可选**，但形状坏掉的要收窄掉 ——
   * 留着 `decidedBy: 42` 会让读的人以为"有人批了"，而那个 id 谁都不是。
   */
  if (raw.decidedBy !== undefined && (typeof raw.decidedBy !== "string" || !raw.decidedBy.trim())) delete raw.decidedBy;
  if (raw.approvers !== undefined && (!Array.isArray(raw.approvers) || !raw.approvers.length)) delete raw.approvers;
  return raw as ApprovalRecord;
}

/**
 * 收窄一条**授权记录**（C3 3.7b）。
 *
 * @param raw 已经确认是对象的原始行
 * @returns 记录；形状不够就是 null
 */
export function normalizeApprovalGrantRecord(raw: Record<string, unknown>): ApprovalGrantRecord | null {
  if (typeof raw.toolCallId !== "string" || typeof raw.by !== "string" || typeof raw.target !== "string") return null;
  if (!Array.isArray(raw.approvers) || !raw.approvers.length) return null;
  if (typeof raw.line !== "string") return null;
  raw.actor = normalizeActor(raw.actor);
  return raw as ApprovalGrantRecord;
}
