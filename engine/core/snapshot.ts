import { splitTurns, type LogRecord, type TurnChunk } from "./events";

/**
 * 快照：**一段会话的投影**，用来做"行为不变"的验收（Phase 1 D6 的快照设施）。
 *
 * ## 它要替代什么
 *
 * 原来的回归手段是 99 条**点击**验收（`.verify/accept-*.mjs`）：启 Electron、
 * 点界面、量 DOM。那类验收有两个治不好的毛病：
 *   · **偶发**（等 300ms 不够就红），于是红了先怀疑测试而不是代码；
 *   · **量不到投影**（界面长什么样被量了，"这一轮到底投影出了什么"没有）。
 *
 * 事件流是确定性的：同样的记录进去，`splitTurns` 必须给出同样的东西。
 * 所以把"投影"本身当成被测对象 —— 这就是快照。
 *
 * ```
 * 旧版录一份 fixture（记录 + 当时的投影）
 * 新版拿同一份记录重放 → 逐轮 diff
 * ```
 *
 * ⚠️ **diff 为零才是通过**（不是"差不多"）。差出来了就是行为漂移，
 * 要么修代码，要么明确承认"这一处行为变了"再更新 fixture —— 并写清为什么。
 */

/** 一份快照。 */
export type Snapshot = {
  /** 格式版本（将来形状变了要能认出来，而不是把它当坏数据）。 */
  version: 1;
  sessionId: string;
  /** 录制的时刻（epoch ms）。 */
  recordedAt: number;
  /** 原始记录 —— **重放的输入**。 */
  records: LogRecord[];
  /** 录制时的投影 —— **重放的期望**。 */
  turns: TurnChunk[];
};

/**
 * 录一份快照（纯函数：给记录，给投影）。
 *
 * @param sessionId 会话 id
 * @param records 整段会话的记录
 * @param at 录制时刻（默认现在；测试里给固定值，好让 fixture 可比）
 * @returns 快照
 */
export function snapshotOf(sessionId: string, records: readonly LogRecord[], at = Date.now()): Snapshot {
  return { version: 1, sessionId, recordedAt: at, records: [...records], turns: splitTurns(records) };
}

/** 一份 diff 报告。 */
export type SnapshotDiff = {
  /** 逐轮比下来完全一致。 */
  equal: boolean;
  /** 给人看的差异（空数组 = 一致）。 */
  differences: string[];
};

/**
 * 稳定序列化：**对象键排序**之后再 JSON。
 *
 * 为什么要它：指纹比对的是"内容一样不一样"。若直接 `JSON.stringify`，
 * 两条内容相同的对象只因**键的插入顺序**不同就会给出不同的串 —— 那是假漂移，
 * 而假漂移会让人开始不信这个设施（本仓反复踩过"守卫假红也是缺陷"）。
 */
function stable(value: unknown): string {
  if (value === undefined) return "-";
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        );
      }
      return v;
    });
  } catch {
    /* 循环引用之类：退化成 String（总比静默变成 "-" 强 —— 至少还能看出是同一份东西） */
    return String(value);
  }
}

/**
 * 把一轮投影压成可比的短串（**比对的是内容，不是对象引用**）。
 *
 * ⚠️ 2026-10-16（审计 **P232**）：这条指纹原来**只取五个字段**
 * （`toolCallId` / `name` / `ok` / `pending` / `line`），于是下面这些漂移**全都不被看见**：
 *   · 工具留痕的 **`input` / `output` / `error`** 丢了 —— `events.test.ts` 记过一条真缺陷：
 *     重放恢复出来的 `input` 是空的，重启后点「允许」报
 *     `Cannot read properties of undefined`。**指纹照样判「零漂移」**；
 *   · **委派（`delegations`）** 整体丢了（团队进展在重放后空掉）；
 *   · **这一轮的 request 正文**（provider/model/policy/下发的工具/消息）变了。
 *
 * 而"零漂移"正是这套快照设施存在的全部理由 —— 它看不见的东西，等于没人验。
 * 现在把上面三样一起纳入指纹（时间戳与 `requestId` 仍然**刻意排除**：
 * 同一个行为发生在不同时刻不算漂移，这条口径没变）。
 */
function turnSignature(chunk: TurnChunk): string {
  const view = chunk.view;
  const traces = view.traces.map((t) =>
    [
      t.toolCallId,
      t.name,
      t.ok ? "ok" : "fail",
      t.pending ? "pending" : "-",
      t.error ?? "-",
      `in=${stable(t.input)}`,
      `out=${stable(t.output)}`,
      t.line,
    ].join("|"),
  );
  const delegations = (view.delegations ?? []).map((d) =>
    [
      d.delegationId,
      d.agent,
      d.status,
      d.ok === undefined ? "-" : d.ok ? "ok" : "fail",
      d.steps ?? "-",
      d.error ?? "-",
      d.summary ?? "-",
      d.task,
    ].join("|"),
  );
  const usage = view.usage ? `${view.usage.inputTokens ?? "-"}/${view.usage.outputTokens ?? "-"}` : "-";
  const request = chunk.request
    ? [
        `${chunk.request.provider}/${chunk.request.model}`,
        `policy=${chunk.request.toolPolicy ?? "-"}`,
        `useTools=${chunk.request.useTools === undefined ? "-" : chunk.request.useTools}`,
        `tools=${(chunk.request.tools ?? []).join(",")}`,
        `system=${stable(chunk.request.system)}`,
        `messages=${stable(chunk.request.messages)}`,
      ].join(" ")
    : "-";
  return [
    `request=${request}`,
    `text=${JSON.stringify(view.text)}`,
    `done=${view.done}`,
    `error=${view.error ?? "-"}`,
    `usage=${usage}`,
    `traces=[${traces.join(" ; ")}]`,
    `delegations=[${delegations.join(" ; ")}]`,
  ].join(" ");
}

/**
 * 比两份快照。
 *
 * ⚠️ 比的是**记录数 + 逐轮投影**，不是"文件字节相同"：
 * 记录里带着时间戳与 `requestId`，字节比对会把"同一个行为、不同的时间"判成漂移。
 *
 * @param expected 期望（fixture）
 * @param actual 实际（重放出来的）
 * @returns 结论与差异清单
 */
export function diffSnapshot(expected: Snapshot, actual: Snapshot): SnapshotDiff {
  const differences: string[] = [];

  if (expected.records.length !== actual.records.length) {
    differences.push(`记录条数：期望 ${expected.records.length}，实际 ${actual.records.length}`);
  }
  if (expected.turns.length !== actual.turns.length) {
    differences.push(`轮数：期望 ${expected.turns.length}，实际 ${actual.turns.length}`);
  }

  const n = Math.min(expected.turns.length, actual.turns.length);
  for (let i = 0; i < n; i += 1) {
    const want = turnSignature(expected.turns[i]!);
    const got = turnSignature(actual.turns[i]!);
    if (want !== got) differences.push(`第 ${i + 1} 轮：\n    期望 ${want}\n    实际 ${got}`);
  }

  return { equal: differences.length === 0, differences };
}
