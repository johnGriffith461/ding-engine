import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { approversFor, grantRecord, pendingFor } from "../core/gates";
import { chatSessionId, type LogInput } from "../core/events";
import { createSqliteSessionStore } from "./sqliteStore";
import { createApprovalsIndex } from "./sqliteApprovals";

/**
 * **审批索引的投影一致性**（v6；C3 3.7b）。
 *
 * 索引表是**投影**（真相是会话日志里的三条记录：`tool-result(pending)` / `approval` /
 * `approval-grant`）。这一组测的就是那条纪律：
 *
 *   ① **索引 = 从日志现算**（待决、决策、授权三种变化各验一遍）；
 *   ② 已经批过的那条**不会**被后面重发的 pending 载荷复活（那会让界面上又冒出一个假按钮）；
 *   ③ `list` 按会话与状态查（服务端那条路的口径）；
 *   ④ N=50 名成员的待决查询 ≤50ms（V5 §8 ⑥ 的那条数字 —— 它当初就是因为"没有审批表"
 *      才一直没测，ADR-0008 把这件事记成了 follow-up）。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为（Windows） */
    }
  }
});
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-approvals-"));
  dirs.push(dir);
  return dir;
};

/** 造一条待决（工具被拦下的那一对记录：tool-call + tool-result(pending)）。 */
const pendingRecords = (toolCallId: string, approvers: string[]): LogInput[] =>
  [
    { requestId: "r1", type: "tool-call", toolCallId, toolName: "write_file", input: { path: "x.md" } },
    { requestId: "r1", type: "tool-result", toolCallId, toolName: "write_file", output: { pending: true, notice: "等确认", approvers } },
  ] as LogInput[];

describe("审批索引（v6 投影）", () => {
  it("① 索引 = 从日志现算：待决 → 决策 → 授权三种变化都对得上", async () => {
    const dir = tmpDir();
    const store = createSqliteSessionStore(dir);
    const index = createApprovalsIndex(dir);
    try {
      const sessionId = chatSessionId("approvals-a");
      await store.append(sessionId, pendingRecords("c1", ["local"]));

      /* 待决：索引里有，且状态是 pending；日志现算的待决也在 */
      const row = index.get(sessionId, "c1");
      expect(row?.state).toBe("pending");
      expect(row?.name).toBe("write_file");
      expect(row?.approvers).toEqual(["local"]);
      const records = (await store.load(sessionId)).records;
      expect(pendingFor(records, "c1")?.approvers).toEqual(["local"]);
      expect(index.list({ sessionIds: [sessionId], state: "pending" })).toHaveLength(1);

      /* 授权：索引里的审批人跟着变，**日志现算的也变**（同一口径） */
      await store.append(sessionId, [
        { ...grantRecord({ toolCallId: "c1", by: "local", target: "bob", approvers: ["local", "bob"], line: "local 把裁决权授给了 bob" }) } as LogInput,
      ]);
      const afterGrant = (await store.load(sessionId)).records;
      expect(index.get(sessionId, "c1")?.approvers).toEqual(["local", "bob"]);
      expect(approversFor(afterGrant, "c1")).toEqual(["local", "bob"]);
      /* 授权不是决策：那条待决仍然开着 */
      expect(index.get(sessionId, "c1")?.state).toBe("pending");

      /* 决策：索引置成 approved + 谁批的 */
      await store.append(sessionId, [
        { type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "已保存", decidedBy: "bob", approvers: ["local", "bob"] } as LogInput,
      ]);
      const decided = index.get(sessionId, "c1");
      expect(decided?.state).toBe("approved");
      expect(decided?.decidedBy).toBe("bob");
      expect(index.list({ sessionIds: [sessionId], state: "pending" })).toHaveLength(0);
    } finally {
      index.close();
      store.close();
    }
  });

  it("② 已经批过的那条不会被后面重发的 pending 复活（界面上不会冒假按钮）", async () => {
    const dir = tmpDir();
    const store = createSqliteSessionStore(dir);
    const index = createApprovalsIndex(dir);
    try {
      const sessionId = chatSessionId("approvals-b");
      await store.append(sessionId, pendingRecords("c2", ["local"]));
      await store.append(sessionId, [
        { type: "approval", toolCallId: "c2", name: "write_file", approved: false, line: "已拒绝", decidedBy: "local" } as LogInput,
      ]);
      /* 同一段会话里重发一遍那条待决（重试/重放都会产生这种形状） */
      await store.append(sessionId, pendingRecords("c2", ["local"]));
      expect(index.get(sessionId, "c2")?.state).toBe("rejected");
    } finally {
      index.close();
      store.close();
    }
  });

  it("③ list：按会话集合与状态查，别的会话不串进来", async () => {
    const dir = tmpDir();
    const store = createSqliteSessionStore(dir);
    const index = createApprovalsIndex(dir);
    try {
      const mine = chatSessionId("approvals-mine");
      const other = chatSessionId("approvals-other");
      await store.append(mine, pendingRecords("m1", ["alice"]));
      await store.append(other, pendingRecords("o1", ["bob"]));
      const rows = index.list({ sessionIds: [mine] });
      expect(rows.map((r) => r.toolCallId)).toEqual(["m1"]);
      expect(rows[0]?.approvers).toEqual(["alice"]);
      /* 空集合：不发查询（也不报错） */
      expect(index.list({ sessionIds: [] })).toEqual([]);
    } finally {
      index.close();
      store.close();
    }
  });

  it("⭐ 会话收口时清掉**已决**的行、**待决的留着**（ADR-0016 第 7 条）", async () => {
    const dir = tmpDir();
    const store = createSqliteSessionStore(dir);
    const index = createApprovalsIndex(dir);
    try {
      const decided = chatSessionId("approvals-prune-a");
      const stillOpen = chatSessionId("approvals-prune-b");
      await store.append(decided, pendingRecords("c1", ["local"]));
      await store.append(decided, [
        { type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "已保存", decidedBy: "local" } as LogInput,
      ]);
      await store.append(stillOpen, pendingRecords("c2", ["local"]));

      const removed = index.pruneWith([decided, stillOpen]);
      expect(removed, "只该删掉那一条已决的").toBe(1);
      expect(index.get(decided, "c1"), "已决的行该跟着会话一起走").toBeUndefined();
      expect(index.get(stillOpen, "c2")?.state, "**待决的不能删** —— 那是用户的待办").toBe("pending");
      expect(index.pruneWith([])).toBe(0);
    } finally {
      index.close();
      store.close();
    }
  });

  it("④ 50 名成员的待决查询 ≤50ms（V5 §8 ⑥ 的那条数字）", async () => {
    const dir = tmpDir();
    const store = createSqliteSessionStore(dir);
    const index = createApprovalsIndex(dir);
    try {
      /* 50 个成员各一段会话，每段一条待决（真实形状：成员一多就是这么多行） */
      const sessionIds: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        const sessionId = chatSessionId(`member-${i}`);
        sessionIds.push(sessionId);
        await store.append(sessionId, pendingRecords(`c${i}`, [`member-${i}`]), { owner: `member-${i}` });
      }

      /* 预热一次（第一次查询要把页缓存读热 —— 那不算查询本身的开销） */
      index.list({ sessionIds, state: "pending" });
      const started = performance.now();
      const rows = index.list({ sessionIds, state: "pending" });
      const ms = performance.now() - started;

      expect(rows).toHaveLength(50);
      expect(ms, `50 名成员的待决查询用了 ${ms.toFixed(1)}ms（预算 50ms）`).toBeLessThan(50);
    } finally {
      index.close();
      store.close();
    }
  });
});
