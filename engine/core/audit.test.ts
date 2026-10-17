import { describe, expect, it } from "vitest";

import { auditOf, auditQuery, auditSummary } from "./audit";
import { logLine, parseLogLine, type LogRecord } from "./events";

/**
 * 审计（V5-3 任务 3.3）：**成员操作全留痕**的查询面。
 *
 * 这一层薄是刻意的（留痕早在 C5 就有了）：它只把记录按人捞出来。
 * 判据三条：① 人的动作进账（发起一轮 / 批准 / 拒绝）；② agent 的自言自语**默认不混**；
 * ③ 按人/时间/条数查得动，而且老记录（actor=legacy）算"人那一侧"（它是人写的）。
 */

const T = (n: number) => 1_700_000_000_000 + n;

function records(): LogRecord[] {
  const lines = [
    logLine(
      { requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "把周报写一下" }], actor: { id: "alice", kind: "user" } } as never,
      1,
      T(1),
    ),
    logLine({ requestId: "r1", type: "text", text: "好的", actor: { id: "main", kind: "agent" } } as never, 2, T(2)),
    logLine({ requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", actor: { id: "main", kind: "agent" } } as never, 3, T(3)),
    logLine(
      { type: "approval", toolCallId: "c1", name: "write_file", approved: true, line: "已保存", actor: { id: "alice", kind: "user" } } as never,
      4,
      T(4),
    ),
    /* 一条**老记录**（actor 维度上线之前）：它是人写的，审计里算人那一侧 */
    `${JSON.stringify({ seq: 5, at: T(5), requestId: "r2", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "老话一句" }] })}\n`,
  ];
  return lines.map((line) => parseLogLine(line)!).filter(Boolean);
}

describe("3.3 · 审计（成员操作全留痕）", () => {
  it("⭐ 人的动作进账：发起一轮 / 批准；agent 的自言自语**默认不混**", () => {
    const entries = auditOf("task-1", records());
    expect(entries.map((e) => e.action)).toEqual(["发起一轮", "批准 write_file", "发起一轮"]);
    expect(entries.every((e) => e.sessionId === "task-1")).toBe(true);
    /* 细节：用户说的那句（截断）与那行结论 */
    expect(entries[0]?.detail).toBe("把周报写一下");
    expect(entries[1]?.detail).toBe("已保存");
  });

  it("老记录（actor=legacy）算人那一侧（它是人写的）", () => {
    const entries = auditOf("task-1", records());
    const legacy = entries.find((e) => e.actor.id === "legacy");
    expect(legacy?.action).toBe("发起一轮");
    expect(legacy?.detail).toBe("老话一句");
  });

  it("拒绝也是账（写清拒了谁）；`includeAgent` 时才把 agent 的动作收进来", () => {
    const rejected = parseLogLine(
      logLine({ type: "approval", toolCallId: "c2", name: "run_command", approved: false, line: "你已拒绝", actor: { id: "bob", kind: "user" } } as never, 1, T(1)),
    )!;
    expect(auditOf("s", [rejected])[0]?.action).toBe("拒绝 run_command");

    const withAgent = auditOf("task-1", records(), { includeAgent: true });
    expect(withAgent.length).toBeGreaterThan(auditOf("task-1", records()).length);
    expect(withAgent.some((e) => e.actor.kind === "agent")).toBe(true);
  });

  it("⭐ 查得动：按人 / 按时间 / 按条数（新的在前）", () => {
    const entries = auditOf("task-1", records());
    expect(auditQuery(entries, { member: "alice" }).map((e) => e.at)).toEqual([T(4), T(1)]);
    expect(auditQuery(entries, { since: T(2) }).map((e) => e.at)).toEqual([T(5), T(4)]);
    expect(auditQuery(entries, { limit: 1 })).toHaveLength(1);
    /* 默认新的在前（看的人在追最近发生的事） */
    const all = auditQuery(entries);
    expect(all[0]!.at).toBeGreaterThan(all[all.length - 1]!.at);
  });

  it("按人汇总：每人一条、条数降序（「这台机器上谁做过多少事」）", () => {
    const entries = [...auditOf("a", records()), ...auditOf("b", records())];
    const summary = auditSummary(entries);
    const alice = summary.find((x) => x.actor.id === "alice");
    /* 两个会话里各 2 条（发起一轮 + 批准）；那条老记录算 legacy 的账，不是 alice 的 */
    expect(alice?.count).toBe(4);
    expect(summary.find((x) => x.actor.id === "legacy")?.count).toBe(2);
    expect(summary[0]!.count).toBeGreaterThanOrEqual(summary[summary.length - 1]!.count);
  });
});
