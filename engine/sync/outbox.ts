import type { LogRecord } from "../core/events";
import type { CursorState } from "./cursor";

/**
 * **出站队列**（V5-2 任务 2.6）：本地还有哪些事件没推上去。
 *
 * ## 关键决定：队列**不单独存**，从本地记录推出来
 *
 * 本地 SQLite 是数据权威（V4 不变量）。所以"待推的事件"不需要另一份持久化的队列 ——
 * 它就是**本地记录里 seq 大于游标的那一段**。进程被杀、网断了、机器重启：
 * 只要游标在（见 `engine/adapters/syncCursorJournal.ts`）与本地记录在，
 * 待推的那一段**自己就回来了**。这就是"与崩溃恢复统一"的落点：
 * 恢复靠的是同一样东西（本地记录），不是两套账。
 *
 * ## 事件 id：`<会话 id>#<本地 seq>`（**必须稳定**）
 *
 * 重连之后重推时，id 必须与上次是同一个 —— 中继按 id **跨 epoch 去重**（见
 * `./relay.ts` 的 `PushEvent.id`）。本地 seq 是单调的、由存储发的号，
 * 它天然稳定：崩一次回来还是那个号。**不要**用 `Date.now()` 之类做 id
 * （重推时它变了，去重就失效 —— 同一件事会进去两次）。
 */

/** 一条待推事件（`type` 给中继看，`payload` 是事件本体，`id` 是去重身份）。 */
export type OutboxEvent = { id: string; type: string; payload: unknown };

/** 会话 id → 事件 id 的分隔符（`#` 不在会话 id 的合法字符里，见 `safeSessionId`）。 */
const ID_SEP = "#";

/** 一条本地记录的去重 id（**唯一一份拼法**）。 */
export function eventIdOf(sessionId: string, seq: number): string {
  return `${sessionId}${ID_SEP}${seq}`;
}

/**
 * 从本地记录里取出**推给中继的**那一段（`seq > cursor.pushedSeq`）。
 *
 * @param sessionId 这段会话的 id（进事件 id）
 * @param records 本地记录（`load()` 的产物，按 seq 升序）
 * @param cursor 当前游标（`null` = 还没推过任何东西 → 全推）
 * @returns 待推的事件（顺序与记录一致；空数组 = 没有欠账）
 */
export function outboxOf(
  sessionId: string,
  records: readonly LogRecord[],
  cursor: Pick<CursorState, "pushedSeq"> | null,
): OutboxEvent[] {
  const pushed = cursor?.pushedSeq ?? 0;
  return records
    .filter((record) => record.seq > pushed)
    .map((record) => {
      const { seq, ...rest } = record as LogRecord & { seq: number };
      return {
        id: eventIdOf(sessionId, seq),
        type: record.type,
        payload: rest as unknown,
      };
    });
}

/**
 * 续传是否**一致**（验收那条"杀进程重连后续传 diff=0"的判据函数）。
 *
 * 比的是"中继那条流里的**内容**"与"本地记录的内容"：条数相同、顺序相同、
 * 逐条等价（id 由 `eventIdOf` 拼）。⚠️ **不比 `at`**：那是本地搬过去的元数据，
 * 中继那侧有自己的接收时刻（`StreamRecord.at`），两者本来就不同 ——
 * 拿它去比会产生假红，而假红会让这个判据被无视。
 *
 * @param sessionId 会话 id
 * @param local 本地记录
 * @param stream 中继那条流里的记录（按 offset 升序）
 * @returns 一致为 true
 */
export function resumeMatches(
  sessionId: string,
  local: readonly LogRecord[],
  stream: readonly { id?: string; type: string; payload: unknown }[],
): boolean {
  if (local.length !== stream.length) return false;
  for (let i = 0; i < local.length; i += 1) {
    const record = local[i]!;
    const pushed = stream[i]!;
    if (pushed.id !== eventIdOf(sessionId, record.seq)) return false;
    if (pushed.type !== record.type) return false;
    const { seq: _seq, ...rest } = record as LogRecord & { seq: number };
    if (JSON.stringify(pushed.payload) !== JSON.stringify(rest)) return false;
  }
  return true;
}
