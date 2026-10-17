import { describe, expect, it } from "vitest";

import { diffSnapshot, snapshotOf } from "./snapshot";
import type { LoggedEvent, TurnRequest } from "./events";

/**
 * 快照设施**本身**要能看见漂移（2026-10-16，审计 P232）。
 *
 * ## 为什么这条必须存在
 *
 * `snapshotOf` + `diffSnapshot` 是"换代行为不变"的**唯一**机器判据：差出来的就是行为漂移。
 * 但它靠一份**指纹**（`turnSignature`）来比 —— 指纹里没取的字段，
 * 丢了也**判不出来**，而结论照样是那句最危险的话："零漂移"。
 *
 * P232 实测的盲区有三个：
 *   ① 工具留痕的 `input` / `output` / `error`（`events.test.ts` 记过真缺陷：
 *      重放恢复出来的 `input` 是空的，重启后点「允许」报 `Cannot read properties of undefined`）；
 *   ② 委派进展 `delegations`（团队进展在重放后整体空掉）；
 *   ③ 这一轮的 request 正文（provider / model / 档位 / 下发的工具 / 消息）。
 *
 * ## 变异实证
 *
 * 把 `turnSignature` 退回"只取 toolCallId/name/ok/pending/line"那五字段版 →
 * 下面标 ⭐ 的三个用例全红（第 5 个"时间戳不算漂移"的会照旧绿 —— 那是刻意对另一半的约束）。
 */

const REQ = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  requestId: "r1",
  seq: 1,
  at: 1_000,
  type: "request",
  provider: "p1",
  model: "m1",
  messages: [{ role: "user", content: "把那个文件读一下" }],
  ...over,
});

const CALL = (input: unknown, seq = 2): LoggedEvent => ({
  requestId: "r1",
  seq,
  at: 1_001,
  type: "tool-call",
  toolCallId: "c1",
  toolName: "read_file",
  input,
});

const RESULT = (output: unknown, seq = 3): LoggedEvent => ({
  requestId: "r1",
  seq,
  at: 1_002,
  type: "tool-result",
  toolCallId: "c1",
  toolName: "read_file",
  output,
});

const DELEG: LoggedEvent = {
  requestId: "r1",
  seq: 4,
  at: 1_003,
  type: "delegation",
  delegationId: "d1",
  agent: "探索",
  task: "查一下这份规格",
  status: "finished",
  ok: true,
  steps: 2,
};

describe("快照指纹的覆盖面（P232）", () => {
  it("同样的记录 → 零漂移（先保证这条设施本身没坏）", () => {
    const records = [REQ(), CALL({ path: "/a.md" }), RESULT("正文"), DELEG];
    const diff = diffSnapshot(snapshotOf("s", records), snapshotOf("s", records.map((r) => ({ ...r }))));
    expect(diff.differences).toEqual([]);
    expect(diff.equal).toBe(true);
  });

  it("⭐ 工具留痕的 input 丢了 —— 必须算漂移（P232 的主症状）", () => {
    const want = snapshotOf("s", [REQ(), CALL({ path: "/a.md" }), RESULT("正文")]);
    // 重放丢了参数（真发生过：重启后点「允许」报 Cannot read properties of undefined）
    const got = snapshotOf("s", [REQ(), CALL(undefined), RESULT("正文")]);
    const diff = diffSnapshot(want, got);
    expect(diff.equal, "参数丢了却判「零漂移」—— 那这条设施就白设了").toBe(false);
    expect(diff.differences.join("\n")).toContain("c1");
  });

  it("⭐ 工具留痕的 output 丢了 —— 也算漂移", () => {
    const want = snapshotOf("s", [REQ(), CALL({ path: "/a.md" }), RESULT({ text: "正文" })]);
    const got = snapshotOf("s", [REQ(), CALL({ path: "/a.md" }), RESULT(undefined)]);
    expect(diffSnapshot(want, got).equal).toBe(false);
  });

  it("⭐ 委派进展整体丢了 —— 也算漂移（团队进展在重放后空掉）", () => {
    const want = snapshotOf("s", [REQ(), DELEG]);
    const got = snapshotOf("s", [REQ()]);
    const diff = diffSnapshot(want, got);
    expect(diff.equal).toBe(false);
    expect(diff.differences.join("\n")).toContain("d1");
  });

  it("⭐ 这一轮的 request 正文变了 —— 也算漂移", () => {
    const want = snapshotOf("s", [REQ({ messages: [{ role: "user", content: "甲" }] })]);
    const got = snapshotOf("s", [REQ({ messages: [{ role: "user", content: "乙" }] })]);
    expect(diffSnapshot(want, got).equal).toBe(false);
    // 下发的工具清单变了同样是漂移（"注入正确"要可断言）
    const noTools = snapshotOf("s", [REQ({ tools: ["read_file"] })]);
    const withTools = snapshotOf("s", [REQ({ tools: ["read_file", "write_file"] })]);
    expect(diffSnapshot(noTools, withTools).equal).toBe(false);
  });

  it("另一半约束：时间戳 / requestId / 记录编号**不算**漂移（否则全是假红）", () => {
    const want = snapshotOf("s", [REQ(), CALL({ path: "/a.md" }), RESULT("正文")], 1_000);
    const got = snapshotOf(
      "s",
      [
        REQ({ requestId: "另一个-id", seq: 91, at: 777_777 }),
        { ...CALL({ path: "/a.md" }, 92), at: 777_778 },
        { ...RESULT("正文", 93), at: 777_779 },
      ],
      999_999,
    );
    expect(diffSnapshot(want, got).differences).toEqual([]);
  });

  it("⭐ C5 的 actor **不算**漂移（V5 §3.1：新字段不进投影 diff 比较集）", () => {
    /*
     * 为什么这条是硬要求：actor 是元数据（谁写的），不改变"发生了什么"。
     * 若它进了比较集，**所有历史快照**都会在 actor 落地那一刻齐刷刷报漂移 ——
     * 而那会让"零漂移"这个门禁失去意义（假红也叫狼来了）。
     * 老快照（记录里没有 actor）与新记录（带 actor）必须比出 diff=0。
     */
    const old = snapshotOf("s", [REQ(), CALL({ path: "/a.md" }), RESULT("正文")]);
    const withActors = snapshotOf("s", [
      { ...REQ(), actor: { id: "local", kind: "user" } },
      { ...CALL({ path: "/a.md" }), actor: { id: "main", kind: "agent" } },
      { ...RESULT("正文"), actor: { id: "main", kind: "agent" } },
    ]);
    expect(diffSnapshot(old, withActors).differences, "actor 进了投影指纹 —— 历史快照会集体假红").toEqual([]);
  });
});
