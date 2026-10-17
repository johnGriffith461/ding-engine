import { splitTurns, type LogRecord } from "./events";
import { pendingGates, type GateRequest } from "./gates";

/**
 * 崩溃恢复（Phase 12.2）。
 *
 * 方案原文：「意外退出后一键恢复进行中的回合与待决审批（事件流 resume 已有，
 * 补桌面端与 CLI 双入口）」。
 *
 * ## "进行中的回合"怎么认出来
 *
 * 日志是**事件流**，所以"这一轮跑完了没有"不需要额外的状态位 —— 看有没有终止记录：
 *
 * | 终止记录 | 含义 |
 * |---|---|
 * | `done` | 正常收尾 |
 * | `error` | 报错收尾（**包括**"已中止"那条：中止也是收尾） |
 * | 都没有 | **被打断了**（进程被杀 / 断电） |
 *
 * 这个判据完全来自已有的事件类型，不需要新协议 —— 这正是事件溯源的好处：
 * "当时发生了什么"本来就在日志里，恢复只是把它读出来。
 *
 * ## 为什么要有它（而不是"反正重启后界面上看着还行"）
 *
 * 打断的回合在**数据库里是半截的**：请求记录在、工具调用可能在、答案不在。
 * 没有这一步，用户看到的是"这句话我明明发过，它怎么没回"，而系统**没有任何提示** ——
 * 那是最伤信任的一种表现。有了它，两端都能说一句"上次有一轮被打断了，要继续吗"。
 */

/** 一轮被打断的回合。 */
export type InterruptedTurn = {
  requestId: string;
  /** 那一轮用户说的是什么（从 `request` 记录里取第一条 user 消息）。 */
  userMessage: string;
  /** 开始时间（`request` 记录的 `at`）。 */
  startedAt: number;
  /** 日志里已经跑到了哪一步（给用户看"它当时做到哪了"）。 */
  stepsDone: number;
  /** 已经留下的最后一句话（如果有 —— 让用户看出"它当时说到半句"）。 */
  lastText: string;
};

/**
 * **收尾记录**的两类：`done`（正常收尾）与 `error`（报错收尾，**包括"已中止"那条**）。
 *
 * 词表只此一份：`interruptedTurns` 判"有没有收尾"用它，别处再写一遍
 * `type === "done" || type === "error"` 就是第二个口径 —— 加第三种收尾记录时
 * 只会改到手边那一处。
 */
export const TERMINAL_RECORD_TYPES = ["done", "error"] as const;

/**
 * 这一条记录算不算**这一轮的收尾**。
 *
 * @param record 一条记录（只用到 `type`；坏数据也照样答 false，不抛）
 * @returns 是收尾记录吗
 */
export function isTerminalRecord(record: { type?: unknown }): boolean {
  return TERMINAL_RECORD_TYPES.includes(record.type as (typeof TERMINAL_RECORD_TYPES)[number]);
}

/**
 * 桌面**任务模型**里，那一轮是不是**该重发**的那种（审计 P139 / P211）。
 *
 * ## 为什么这个判据住在引擎里，而不是 `src/workbench/task.ts`
 *
 * 「被打断」只有一条判据：**这一轮有请求、但没有收尾记录**。两侧材料不同，问的是同一件事：
 *
 * | 材料 | 还没收尾 | 收尾了 |
 * |---|---|---|
 * | 日志（引擎） | 请求之后没有 `done`/`error`（`interruptedTurns`） | 有 `done`/`error` |
 * | 任务模型（桌面） | 落盘的 `stage` 是 `running` 或 `awaiting` | `done` / `failed` |
 *
 * ⚠️ 「还没收尾」在这一格上有**两种**人话，别混成一种：
 *
 * · `running`：进程被杀 / 断电 —— **没有人可问**，该做的是把那一轮重发（桌面那颗「继续」
 *   按钮、CLI 的 `--continue`）。**这个函数的答案就是它**；
 * · `awaiting`：停在闸门 / 澄清卡上 —— 有东西在**等人决定**（引擎侧那栏叫 `pending`，
 *   见 `pendingGates`）。此时重发一轮是**错的**：用户该做的是回答那张卡。
 *   `taskPersist.normalizeTask` 早先正是把两者一起判死，导致重启后澄清卡再也不出现
 *   （§179），所以这一格必须排除掉。
 *
 * 因此两侧真正共享的是**这条排除规则**（"在等人的不算"）：桌面端拿它算真值落盘，
 * 「继续」按钮只认真值；引擎侧同一格由 `pending` 表达。判据只写在这里一处 ——
 * 两边各写一遍时漂移的代价很具体：provider 报一句「连接被中断」（说的是网络断了）
 * 也会长出一颗「继续」按钮，点下去又花一次钱。
 *
 * @param stage 落盘的任务阶段（不可信：认不出来的值一律当「没被打断」）
 * @returns 这一轮该当成"被打断、可以重发"吗
 */
export function interruptedFromStage(stage: unknown): boolean {
  return stage === "running";
}

/** 一段会话的恢复视图。 */
export type RecoveryView = {
  interrupted: InterruptedTurn[];
  /** 待决审批（`gates.ts` 的口径：投影出来的，不是另存的状态位）。 */
  pending: GateRequest[];
  /** 有没有需要用户处理的（`interrupted` 或 `pending` 任一非空）。 */
  needsAttention: boolean;
};

/**
 * 从记录里算出"要不要告诉用户点什么"。
 *
 * @param records 一段会话的全部记录（按 seq 升序）
 * @returns 恢复视图
 */
export function recoveryViewOf(records: readonly LogRecord[]): RecoveryView {
  const interrupted = interruptedTurns(records);
  const pending = pendingGates(splitTurns(records));
  return { interrupted, pending, needsAttention: interrupted.length > 0 || pending.length > 0 };
}

/**
 * 认出被打断的回合。
 *
 * ⚠️ 判据是"**请求没有终止记录**"，不是"最后一条请求没跑完"：
 * 一段会话里可能有多个请求（一问一答多轮），中间某个被打断、后面又正常的也应当认出来。
 *
 * @param records 记录
 * @returns 被打断的那些回合（按时间升序）
 */
export function interruptedTurns(records: readonly LogRecord[]): InterruptedTurn[] {
  /** requestId → 它到现在为止的材料。 */
  const open = new Map<string, { userMessage: string; startedAt: number; steps: number; lastText: string }>();
  const closed = new Set<string>();
  const order: string[] = [];

  for (const r of records) {
    if (r.type === "request") {
      open.set(r.requestId, {
        userMessage: userMessageOf(r),
        startedAt: typeof r.at === "number" ? r.at : 0,
        steps: 0,
        lastText: "",
      });
      if (!order.includes(r.requestId)) order.push(r.requestId);
      continue;
    }
    const rid = r.requestId;
    const slot = rid ? open.get(rid) : undefined;
    if (!slot) continue;

    if (r.type === "text") slot.lastText = r.text;
    /*
     * 步数用**工具调用次数**近似（LogRecord 里没有 step-finish —— 它不落盘，见 engine/index.ts）。
     * 这不是"另算一份步数"：这里只是给用户看"它当时做到哪了"，不是权威数字。
     */
    else if (r.type === "tool-call") slot.steps += 1;
    /* 收尾那两类走 `isTerminalRecord`（词表只有一份，见它的说明） */
    else if (isTerminalRecord(r) && typeof r.requestId === "string") closed.add(r.requestId);
  }

  const out: InterruptedTurn[] = [];
  for (const requestId of order) {
    if (closed.has(requestId)) continue;
    const slot = open.get(requestId);
    if (!slot) continue;
    out.push({
      requestId,
      userMessage: slot.userMessage,
      startedAt: slot.startedAt,
      stepsDone: slot.steps,
      lastText: slot.lastText,
    });
  }
  return out;
}

/** 从 `request` 记录里取用户那句原话（第一条 user 消息）。 */
function userMessageOf(r: LogRecord): string {
  const messages = (r as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  if (!Array.isArray(messages)) return "";
  for (const m of messages) {
    if (!m) continue;
    const content = m.content;
    if (m.role === "user" && typeof content === "string" && content) return content;
  }
  // 有些请求没有 user 消息（起标题那种附带请求）：给最后一条有内容的当代表
  const last = messages[messages.length - 1];
  return last && typeof last.content === "string" ? last.content : "";
}

