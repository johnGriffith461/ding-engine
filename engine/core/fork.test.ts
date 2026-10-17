import { describe, expect, it } from "vitest";

import { forkNote, forkReplaysEqual, forkSession } from "./fork";
import { logLine, parseLogLine, type LogRecord } from "./events";

/**
 * fork 语义（V5-2 任务 2.5）。
 *
 * 两条判据（方案的验收）+ 一条纪律：
 *   ① **重放一致**：副本与原会话的逐轮投影相同（"分叉那一刻一模一样"）；
 *   ② **副作用警示随行**：那句白话要说清"回看不产生副作用、接着跑会"；
 *   ③ 源记录**一个字都不改**（分叉是复制，不是搬迁）。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/** 一段像真的会话：一轮请求 + 一次工具调用（写盘）+ 结果 + 收尾 + 一条审批留痕。 */
function sourceRecords(): LogRecord[] {
  const lines = [
    logLine(
      { requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "写个文件" }] } as never,
      1,
      T(1),
    ),
    logLine({ requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.md" } } as never, 2, T(2)),
    logLine({ requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true } } as never, 3, T(3)),
    logLine({ requestId: "r1", type: "text", text: "等你确认。" } as never, 4, T(4)),
    logLine({ requestId: "r1", type: "done" } as never, 5, T(5)),
    logLine({ type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "已保存", decidedBy: "local" } as never, 6, T(6)),
  ];
  return lines.map((line) => parseLogLine(line)!).filter(Boolean);
}

describe("2.5 · fork 为独立副本", () => {
  it("⭐ 重放一致：副本与原会话逐轮投影相同（分叉那一刻一模一样）", () => {
    const source = sourceRecords();
    const plan = forkSession(source, { source: { sessionId: "task-1" }, into: { sessionId: "task-1-fork" } });
    expect(plan.records).toHaveLength(source.length);
    const forked = plan.records.map((r, i) => ({ ...r, seq: i + 1 }) as LogRecord);
    expect(forkReplaysEqual(source, forked), "副本重放出来的东西与原会话不同").toBe(true);
  });

  it("副本记录**保留 `at`、剥掉 `seq`**（时刻是「当时说的」：新会话自己发号）", () => {
    const source = sourceRecords();
    const plan = forkSession(source, { source: { sessionId: "task-1" }, into: { sessionId: "f" } });
    expect(plan.records.map((r) => r.at)).toEqual(source.map((r) => r.at));
    for (const record of plan.records) expect((record as { seq?: number }).seq).toBeUndefined();
  });

  it("⭐ 源记录**一个字都不改**（分叉是复制，不是搬迁）", () => {
    const source = sourceRecords();
    const before = JSON.stringify(source);
    forkSession(source, { source: { sessionId: "task-1" }, into: { sessionId: "f" } });
    expect(JSON.stringify(source)).toBe(before);
  });

  it("⭐ 副作用警示随行：说清「回看不产生副作用、接着跑会」（数了带着几次调用/几条留痕）", () => {
    const note = forkNote("task-1", "task-1-fork", sourceRecords());
    expect(note).toContain("task-1");
    expect(note).toContain("task-1-fork");
    expect(note, "没数清副本里带着什么").toContain("1 次工具调用");
    expect(note).toContain("1 条审批留痕");
    expect(note, "没说清回看与接着跑的区别").toMatch(/回看.*不产生/);
    expect(note).toMatch(/接着跑|重跑/);
    expect(note).toContain("写盘");
  });

  it("空会话也能分叉（警示里不编「含 N 次调用」）", () => {
    const empty: LogRecord[] = [];
    const plan = forkSession(empty, { source: { sessionId: "a" }, into: { sessionId: "b" } });
    expect(plan.records).toEqual([]);
    expect(plan.note).not.toContain("次工具调用");
  });
});
