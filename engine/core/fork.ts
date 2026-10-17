import { splitTurns, type LogRecord, type TurnChunk } from "./events";
import type { LogInputAt } from "../ports/store";

/**
 * **fork 语义**（V5-2 任务 2.5）：会话/画布 fork 为**独立副本**（fork-for-review）。
 *
 * ## 一句话的语义
 *
 * 分叉出来的是一份**独立的记录副本**：它与源会话此后的变化**互不影响**
 * （两边各自追加、各自演化），而分叉那一刻的内容**一模一样**（重放一致）。
 *
 * ## 为什么 fork-for-review 要配一句"副作用警示"
 *
 * fork 的典型用途是"拿去评阅/试跑"：副本带着**当时的全部记录**（包括已经执行过的
 * 工具调用、审批留痕）。记录本身是惰性的（回放它不产生任何副作用），但**接着跑**就会 ——
 * 副本里那条 `write_file` 的请求一旦重跑就是又一次真实的写盘。
 *
 * 所以这一层给两样东西：
 *   ① `forkSession(...)`：产出副本的记录（**`at` 原样保留** —— 那是"当时说的"，
 *      不是"现在复制的"；`seq` 由存储重新发号，与前缀无关）；
 *   ② `forkNote(...)`：一句随行的白话警示（界面上要显示的那句）。
 *
 * ## 纯逻辑
 *
 * 不碰磁盘、不碰 store：宿主拿记录进来、拿记录出去。画布那一侧的类型与载荷在
 * `./canvasContract.ts`（`fork` 事件带 `source: {canvasId, revision}`）。
 */

/** 一次分叉的产物。 */
export type ForkPlan = {
  /**
   * 副本的记录（可直接交给 `store.append(newId, records)`）。
   *
   * ⚠️ `at` **保留**源记录的时刻（它们是"当时发生的事"，不是"复制那一刻发生的事"）；
   * `seq` 已经剥掉（由存储按新会话重新发号）。
   */
  records: LogInputAt[];
  /** 随行的副作用警示（界面上要显示的那句）。 */
  note: string;
};

/**
 * 把一段会话的记录复制成**独立副本**。
 *
 * @param sourceRecords 源会话的记录（按 seq 升序；`load()` 的产物）
 * @param opts.source.sessionId 源会话 id（写进警示里，让人知道从哪儿分出来的）
 * @param opts.into.sessionId 副本的会话 id
 * @returns 副本的记录 + 警示；源记录**一个字都不改**
 */
export function forkSession(
  sourceRecords: readonly LogRecord[],
  opts: { source: { sessionId: string }; into: { sessionId: string } },
): ForkPlan {
  const records: LogInputAt[] = sourceRecords.map((record) => {
    /* 剥 `seq`（新会话重新发号）、留 `at`（见文件头） */
    const { seq: _seq, ...rest } = record as LogRecord & { seq?: number };
    return { ...rest, at: record.at } as LogInputAt;
  });
  return { records, note: forkNote(opts.source.sessionId, opts.into.sessionId, sourceRecords) };
}

/**
 * 那句随行的警示（**只讲事实**，不吓人也不含糊）。
 *
 * 三件事说清：从哪儿分出来的、它带着什么、接着跑会发生什么。
 * 最后一句是这一段存在的理由：**副本里的请求不是"待办"，是"历史"** ——
 * 回放不产生副作用，接着跑才会。
 *
 * @param sourceSessionId 源会话
 * @param intoSessionId 副本
 * @param records 副本的记录（用它数"带着几次调用/几次决策"）
 * @returns 一句白话
 */
export function forkNote(
  sourceSessionId: string,
  intoSessionId: string,
  records: readonly LogRecord[],
): string {
  const calls = records.filter((r) => r.type === "tool-call").length;
  const approvals = records.filter((r) => r.type === "approval").length;
  const detail = calls ? `（含 ${calls} 次工具调用${approvals ? `、${approvals} 条审批留痕` : ""}）` : "";
  return (
    `这是 ${sourceSessionId} 在分叉那一刻的独立副本 ${intoSessionId}${detail}：` +
    `两边此后的变化互不影响；**回看**这些记录不产生任何副作用，` +
    `但**接着跑**（或重跑其中某一轮）会真的再执行一次 —— 涉及写盘、发消息、跑命令的那些调用尤其注意。`
  );
}

/**
 * 分叉之后两份副本的 turns **应当逐轮相同**（"重放一致"的判据，也是验收那条）。
 *
 * ```ts
 * forkReplaysEqual(source, plan.records) // → true
 * ```
 *
 * ⚠️ 比的是**投影**（`splitTurns` 的轮），不是记录字节：`seq` 与 `requestId` 在两边
 * 本来就不同（存储重新发号），而"用户看到的"必须一样。
 *
 * @param source 源记录
 * @param forked 副本记录
 * @returns 逐轮投影相同为 true
 */
export function forkReplaysEqual(source: readonly LogRecord[], forked: readonly LogRecord[]): boolean {
  const sig = (turns: readonly TurnChunk[]): string =>
    JSON.stringify(
      turns.map((t) => ({
        view: t.view,
        request: t.request ? { provider: t.request.provider, model: t.request.model, messages: t.request.messages } : null,
      })),
    );
  return sig(splitTurns(source)) === sig(splitTurns(forked));
}
