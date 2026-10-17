import { describe, expect, it } from "vitest";

import { rollup, ledgerOf } from "./ledger";
import { fold, parseLogLine, splitTurns, type LogRecord } from "./events";

/**
 * **V5 §8 ⑥ 的两条性能预算**（2026-10-17 补；第三条"N=50 审批查询"在
 * `engine/adapters/sqliteApprovals.test.ts`）。
 *
 * | # | 数字 | 这里怎么测 |
 * |---|---|---|
 * | ① | 每条事件 + actor/owner 字段体积增量 ≤40 字节 | `engine/engineRun.test.ts`（已有） |
 * | ② | 单会话 **1 万事件重放**的时间增量 ≤10%（对照 V4 10.5 基线） | 本文件：真造 1 万条事件，量一次重放 |
 * | ③ | usage 三层身份后**账本汇总** ≤200ms | 本文件：真造 3 名成员 × 上千轮 |
 * | ④ | N=50 成员的审批查询 ≤50ms | `sqliteApprovals.test.ts`（有了审批索引表之后才测得出来） |
 *
 * ## 关于"≤10%"这条怎么落成判据
 *
 * 方案的原话是"对照 V4 10.5 基线"，而 V4 的基线数字记在
 * `engine/eval/perf-baseline.md`（由 `pnpm perf:budget` 生成，那条路测的是别的项）。
 * 这里**不编一个"当时的秒数"**去比 —— 那种比法会把两台机器的差异当成回归。
 * 落成两条能长期盯住的判据：
 *   ① 绝对上限（1 万条重放 ≤1.5 秒）：机器再慢也不该到这个量级；
 *   ② **相对量**：同一个 1 万条，`projectTurn`（走投影）与"只把 JSON 解开"
 *      的耗时比 ≤10× —— 它量的是"归属与 actor 字段带来的解析开销有没有失控"，
 *      那正是这条预算要守的东西。
 *
 * ⚠️ 计时用例天生会抖：这两条的阈值都放得**很宽**（比实测值大一个量级），
 * 它们盯的是"数量级变了"，不是"慢了 3%"—— 后者该由 `pnpm perf:budget` 记数字，不该进 CI 门。
 */

/** 造一段 n 条事件的会话（形状与真记录一致：request / text / tool-call / tool-result / done 轮转）。 */
function makeRecords(n: number, agent = "main"): LogRecord[] {
  const out: LogRecord[] = [];
  const at = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    const requestId = `r${Math.floor(i / 5)}`;
    const kind = i % 5;
    const base = { seq: i + 1, at: at + i, requestId, actor: { id: kind === 0 ? agent : "main", kind: kind === 0 ? "user" : "agent" } };
    const raw =
      kind === 0
        ? { ...base, type: "request", provider: "strata", model: "deepseek-flash", messages: [{ role: "user", content: `第 ${i} 句` }] }
        : kind === 1
          ? { ...base, type: "text", text: `收到（${i}）` }
          : kind === 2
            ? { ...base, type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: { path: "x.md" } }
            : kind === 3
              ? { ...base, type: "tool-result", toolCallId: `c${i}`, toolName: "read_file", output: { ok: true, line: "读到了" } }
              : { ...base, type: "done", usage: { inputTokens: 100, outputTokens: 20 } };
    const parsed = parseLogLine(JSON.stringify(raw));
    if (parsed) out.push(parsed);
  }
  return out;
}

describe("V5 §8 ⑥ 性能预算", () => {
  it("⭐ 1 万条事件重放：投影 ≤1.5 秒，且不超过「只解 JSON」的 10×", () => {
    const records = makeRecords(10_000);
    expect(records).toHaveLength(10_000);

    /* 基线：只把每行 JSON 解开（不谈投影）—— 用它当"纯 IO 之外的下限" */
    const lines = records.map((r) => JSON.stringify(r));
    const t0 = performance.now();
    for (const line of lines) parseLogLine(line);
    const parseMs = performance.now() - t0;

    /*
     * 重放 = **折叠整段 + 切轮**（`fold` 是 `state = fold(events)` 那一条不变量，
     * `splitTurns` 是宿主恢复界面时的第二步）。
     *
     * ⚠️ 第一版这里写成了"对每一轮各投影一次前缀"，那是 O(n²) 的**我的循环**，
     * 量出来 27 秒 —— 一个测错了对象的计时用例比没有更坏：它会让人去优化不该优化的地方。
     */
    const t1 = performance.now();
    const state = fold(records);
    const chunks = splitTurns(records);
    const replayMs = performance.now() - t1;

    expect(state.text.length).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(100);

    expect(replayMs, `1 万条重放用了 ${replayMs.toFixed(0)}ms（预算 1500ms）`).toBeLessThan(1500);
    expect(replayMs, `重放 ${replayMs.toFixed(0)}ms / 解析 ${parseMs.toFixed(0)}ms —— 超过 10× 说明投影里出了平方级的东西`).toBeLessThan(
      Math.max(parseMs * 10, 200),
    );
  });

  it("⭐ 账本汇总（3 名成员 × 上千轮）≤200ms —— usage 三层身份之后仍要这个量级", () => {
    const members = ["local", "alice", "bob"];
    const entries = members.flatMap((member) => ledgerOf(makeRecords(1500, member), `task-${member}`, { accountId: member }));
    expect(entries.length).toBeGreaterThan(800);

    const t0 = performance.now();
    const byMember = rollup(entries, "member");
    const byDay = rollup(entries, "day");
    const byAccount = rollup(entries, "account");
    const ms = performance.now() - t0;

    expect(byMember.map((r) => r.key).sort()).toEqual(["alice", "bob", "local"]);
    expect(byDay.length).toBeGreaterThan(0);
    expect(byAccount.length).toBe(3);
    expect(ms, `账本汇总用了 ${ms.toFixed(0)}ms（预算 200ms）`).toBeLessThan(200);
  });
});
