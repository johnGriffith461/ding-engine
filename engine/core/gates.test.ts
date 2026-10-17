import { describe, expect, it } from "vitest";

import { splitTurns, type LogRecord } from "./events";
import { approvalRecord, approversOf, authorizeApprover, canDecide, decidedByOf, pendingGates } from "./gates";

/**
 * 审批闸门的语义（Phase 1 D5 尾部）。
 *
 * ## 这组断言挡的是什么
 *
 * "一次被拦下的调用"这件事，界面、日志、恢复三条路都要给出**同一个答案**。
 * 它们各自实现一遍时，最典型的失效是"界面给了按钮、点了没用"（假待办）
 * 与"批过了但留痕是个空壳"（决策记录漏带结果）—— 两种都不报错，只让用户困惑。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/** 一轮：调用 `write_file`、被闸门拦下（`pending: true`），用户还没处置。 */
function blockedTurn(): LogRecord[] {
  return [
    { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [{ role: "user", content: "写个文件" }] },
    { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.md", content: "x" } },
    { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true, notice: "等确认" } },
    { seq: 4, at: T(4), requestId: "r1", type: "done" },
  ] as unknown as LogRecord[];
}

describe("待办清单（pendingGates）", () => {
  it("⭐ 被拦下的调用带参数进清单（参数丢了就只能重问用户一次）", () => {
    const gates = pendingGates(splitTurns(blockedTurn()));
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ toolCallId: "c1", name: "write_file" });
    expect(gates[0].input).toEqual({ path: "a.md", content: "x" });
  });

  it("⭐ 已批过的不再是待办（从**收尾后**的留痕挑，不是从原始事件挑）", () => {
    const records = [
      ...blockedTurn(),
      // 用户在这一轮结束之后才点「允许」
      { seq: 5, at: T(5), type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "✎ 写文件：已完成" },
    ] as unknown as LogRecord[];
    expect(pendingGates(splitTurns(records))).toEqual([]);
  });

  it("没被拦下的调用不进清单（正常执行完的不该在待办里）", () => {
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } },
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { ok: true } },
      { seq: 4, at: T(4), requestId: "r1", type: "done" },
    ] as unknown as LogRecord[];
    expect(pendingGates(splitTurns(records))).toEqual([]);
  });
});

describe("决策记录（approvalRecord）", () => {
  it("⭐ 批准：把结果一起记（只记'批过了'的话，重启后那条留痕是个空壳）", () => {
    const record = approvalRecord({
      toolCallId: "c1",
      name: "memory_save",
      approved: true,
      result: { ok: true, output: { count: 3 } },
      line: "⚙ 记忆：已保存，当前 3 条",
    });
    expect(record).toMatchObject({
      type: "approval",
      toolCallId: "c1",
      name: "memory_save",
      approved: true,
      ok: true,
      output: { count: 3 },
      line: "⚙ 记忆：已保存，当前 3 条",
    });
  });

  it("拒绝：**不带结果**（拒绝不执行，带上就成了「跑过但失败」）", () => {
    const record = approvalRecord({ toolCallId: "c1", name: "write_file", approved: false, line: "已拒绝" });
    expect(record.approved).toBe(false);
    expect("ok" in record).toBe(false);
    expect("output" in record).toBe(false);
    expect("error" in record).toBe(false);
  });

  it("批准但结果里有错误：`error` 与 `ok: false` 都要在", () => {
    const record = approvalRecord({
      toolCallId: "c1",
      name: "run_command",
      approved: true,
      result: { ok: false, error: "命令超时" },
      line: "⚙ 跑命令：超时",
    });
    expect(record).toMatchObject({ approved: true, ok: false, error: "命令超时" });
  });

  it("拒绝即使传了 result 也不记结果（避免把「拒绝」写成「执行过」）", () => {
    const record = approvalRecord({
      toolCallId: "c1",
      name: "write_file",
      approved: false,
      result: { ok: true, output: { anything: 1 } },
      line: "已拒绝",
    });
    expect("output" in record).toBe(false);
  });
});

/**
 * 待决审批的**裁决权**（C3，V5-1 3.7；ADR-008）。
 *
 * 这一组是 C3 的机器证据：待决项带"待谁批"、谁有权处置有明确判定、
 * 重复处置是 `stale`（不是又执行一次）、授权他人批是一条有前提的流转。
 * 最后一条是 3.7b 的验收（A 发起 → 授权 B → B 批准 → 事件留痕）——
 * 以**记录进、记录出**的形式跑（界面级流程属 V5-3 的团队空间）。
 */

/** 一条带着"待谁批"的待决调用（新产生的 pending 载荷都长这样）。 */
function gatedTurn(approvers: string[]): LogRecord[] {
  return [
    { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [{ role: "user", content: "写个文件" }] },
    { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.md", content: "x" } },
    {
      seq: 3,
      at: T(3),
      requestId: "r1",
      type: "tool-result",
      toolCallId: "c1",
      toolName: "write_file",
      output: { pending: true, notice: "等确认", approvers },
    },
    { seq: 4, at: T(4), requestId: "r1", type: "done" },
  ] as unknown as LogRecord[];
}

describe("C3：待谁批（approversOf / pendingGates）", () => {
  it("载荷里带了就用它；老载荷（没有这个字段）与坏形状都落到默认审批人", () => {
    expect(approversOf({ pending: true, approvers: ["alice", "bob", "alice"] })).toEqual(["alice", "bob"]);
    expect(approversOf({ pending: true })).toEqual(["local"]);
    expect(approversOf({ pending: true, approvers: "alice" })).toEqual(["local"]);
    expect(approversOf({ pending: true, approvers: [""] })).toEqual(["local"]);
    expect(approversOf(undefined)).toEqual(["local"]);
  });

  it("⭐ 待办清单里带着「待谁批」（拦下时定的那一份，不在读的时候现编）", () => {
    const gates = pendingGates(splitTurns(gatedTurn(["alice"])));
    expect(gates).toHaveLength(1);
    expect(gates[0]?.approvers).toEqual(["alice"]);
    /* 老日志（pending 载荷里没有 approvers）→ 兼容口径：默认审批人 */
    expect(pendingGates(splitTurns(blockedTurn()))[0]?.approvers).toEqual(["local"]);
  });
});

describe("C3：裁决权与幂等（canDecide / decidedByOf）", () => {
  it("在审批人集合里 → 能处置", () => {
    expect(canDecide({ approvers: ["alice", "bob"], actorId: "bob", alreadyDecided: false })).toEqual({ ok: true });
  });

  it("不在集合里 → 明确拒绝（说清待批的是谁）", () => {
    const got = canDecide({ approvers: ["alice"], actorId: "carol", alreadyDecided: false });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.code).toBe("not-approver");
      expect(got.message).toContain("alice");
    }
  });

  it("⭐ 已经处置过 → `stale`（重复点不会执行第二次）", () => {
    const got = canDecide({ approvers: ["alice"], actorId: "alice", alreadyDecided: true });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.code).toBe("stale");
      expect(got.message).toMatch(/已经处置过/);
    }
  });

  it("decidedByOf：谁批的从日志读（老记录没记 decidedBy → legacy，不编一个名字）", () => {
    const decided = [
      { seq: 9, at: T(9), type: "approval", toolCallId: "c1", name: "write_file", approved: true, line: "已保存", decidedBy: "bob" },
      { seq: 10, at: T(10), type: "approval", toolCallId: "c2", name: "write_file", approved: false, line: "你已拒绝" },
    ] as unknown as Parameters<typeof decidedByOf>[0];
    expect(decidedByOf(decided, "c1")).toBe("bob");
    expect(decidedByOf(decided, "c2")).toBe("legacy");
    expect(decidedByOf(decided, "没这条")).toBeNull();
  });
});

describe("C3：授权他人批（authorizeApprover）", () => {
  it("现任审批人可以把裁决权加给别人", () => {
    const got = authorizeApprover({ approvers: ["alice"], byActorId: "alice", targetId: "bob" });
    expect(got).toEqual({ ok: true, approvers: ["alice", "bob"], added: true });
  });

  it("不是审批人 → 拒绝（不能自己挤进一张不属于自己的单子）", () => {
    const got = authorizeApprover({ approvers: ["alice"], byActorId: "carol", targetId: "carol" });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.code).toBe("not-approver");
  });

  it("重复授权是幂等的（added:false，不算错）；空目标是输入问题", () => {
    const again = authorizeApprover({ approvers: ["alice", "bob"], byActorId: "alice", targetId: "bob" });
    expect(again).toEqual({ ok: true, approvers: ["alice", "bob"], added: false });
    const empty = authorizeApprover({ approvers: ["alice"], byActorId: "alice", targetId: "  " });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("invalid-target");
  });
});

describe("C3 · 3.7b 验收：A 发起 → 授权 B → B 批准 → 事件留痕", () => {
  it("⭐ 全链路（记录进、记录出）：待批是 A、授权给 B、B 批得了、留痕记得下谁批的、待办清空", () => {
    /* ① A 发起 → 调用被拦下（待 A 批） */
    let records = gatedTurn(["alice"]);
    let gates = pendingGates(splitTurns(records));
    expect(gates[0]?.approvers).toEqual(["alice"]);

    /* ② A 授权给 B（也就是"授权他人批"那一格） */
    const authorized = authorizeApprover({ approvers: gates[0]!.approvers, byActorId: "alice", targetId: "bob" });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    gates = [{ ...gates[0]!, approvers: authorized.approvers }];

    /* ③ B 拿去批：裁决权过了（bob 在集合里） */
    expect(canDecide({ approvers: gates[0]!.approvers, actorId: "bob", alreadyDecided: false })).toEqual({ ok: true });

    /* ④ 决策落进日志（决定 + 结果 + 谁批的 + 当时待谁批） */
    records = [
      ...records,
      {
        seq: 5,
        at: T(5),
        type: "approval",
        toolCallId: "c1",
        name: "write_file",
        approved: true,
        ok: true,
        output: { bytes: 1 },
        line: "已保存，当前 1 条",
        decidedBy: "bob",
        approvers: gates[0]!.approvers,
      } as unknown as LogRecord,
    ];

    /* ⑤ 重放：待办清空（不再给假按钮）、留痕成了结论、谁批的查得到 */
    expect(pendingGates(splitTurns(records))).toEqual([]);
    const chunk = splitTurns(records)[0]!;
    const trace = chunk.view.traces.find((t) => t.toolCallId === "c1")!;
    expect(trace.pending, "批过之后还挂着 pending（重启会冒出假按钮）").toBeUndefined();
    expect(trace.line).toBe("已保存，当前 1 条");
    expect(decidedByOf(records.filter((r) => r.type === "approval") as never, "c1")).toBe("bob");
    /* 再点一次：stale，不会又执行一遍 */
    const again = canDecide({ approvers: gates[0]!.approvers, actorId: "bob", alreadyDecided: decidedByOf(records.filter((r) => r.type === "approval") as never, "c1") !== null });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("stale");
  });
});
