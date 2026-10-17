import { describe, expect, it } from "vitest";

import { createSyncRelay } from "./relay";
import { chatSessionId, type LogInput, type LogRecord } from "../core/events";
import { planMerge, frameOf, frameIdOf, myFrameIds } from "./merge";
import { createSqliteSessionStore } from "../adapters/sqliteStore";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * **同步的合并语义**（ADR-0017）：两端各推各的、各自合并回来，**谁都不多一份、也不少一份**。
 *
 * 这一组是"产品客户端"那半的证据（引擎侧）：两个真 SQLite（两台设备）+ 真中继，
 * 走一遍 push → pull → planMerge → append，判据是**两端的记录集合一致**（diff=0），
 * 且**再同步一次不会多出任何一条**（幂等）。
 */

/** 一台"设备"：自己的 SQLite + 自己的生产者 id + 自己的游标与已应用账本。 */
function device(sessionId: string, dir: string, producerId: string) {
  const store = createSqliteSessionStore(dir);
  let pushedSeq = 0;
  let pulledOffset = 0;
  let epoch = 0;
  const local = async (): Promise<LogRecord[]> => (await store.load(sessionId)).records;

  return {
    store,
    producerId,
    /** 把自己**还没推过**的记录推上去（出站队列口径：只推 pushedSeq 之后的）。 */
    async push(relay: ReturnType<typeof createSyncRelay>): Promise<number> {
      /*
       * ⚠️ 推之前**先 claim**（拿当前 epoch）：中继是"单一持有者 + fencing"语义 ——
       * 另一端接管之后我这边的 epoch 就过期了，直接推会拿到 `fenced`。
       * 真实客户端也该这么做：每次同步开头 claim 一次，epoch 用它给的。
       */
      const claimed = relay.claim(sessionId, producerId);
      if (!claimed.ok) throw new Error(`claim 失败：${claimed.code}`);
      epoch = claimed.epoch;
      const mine = (await local()).filter((r) => r.seq > pushedSeq);
      if (!mine.length) return 0;
      const events = mine.map((record, index) => ({ ...frameOf(sessionId, record), seq: pushedSeq + index + 1 }));
      const got = relay.push(sessionId, { producerId, epoch, events });
      if (!got.ok) throw new Error(`push 失败：${got.code}`);
      pushedSeq += events.length;
      return events.length;
    },
    /** 拉一页 → 算合并计划 → **按它 append**（幂等：已应用过的 id 不再应用）。 */
    async pullAndApply(relay: ReturnType<typeof createSyncRelay>): Promise<{ applied: number; mine: number; dup: number }> {
      const page = relay.pull(sessionId, { from: pulledOffset, limit: 200 });
      if (!page.ok) throw new Error(page.message);
      const plan = planMerge({ sessionId, local: await local(), pulled: page.events });
      if (plan.apply.length) {
        /* `at` 用记录自己的（不是"现在"）—— 另一端的历史不该被挤进这一刻 */
        await store.append(
          sessionId,
          plan.apply.map((a) => ({ ...(a.record as Record<string, unknown>), at: a.at })) as unknown as LogInput[],
        );
      }
      pulledOffset = page.nextOffset;
      return { applied: plan.apply.length, mine: plan.skippedMine, dup: plan.skippedApplied };
    },
  };
}

describe("同步合并语义（ADR-0017）", () => {
  it("⭐ 两台设备各写各的 → 双向同步之后两边记录一致，且再同步一次一条都不多", async () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "dh-syncA-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "dh-syncB-"));
    const sid = chatSessionId("two-devices");
    const relay = createSyncRelay({ now: () => 1_700_000_000_000 });
    relay.createStream(sid);

    const a = device(sid, dirA, "p-A");
    const b = device(sid, dirB, "p-B");
    try {
      /* 两端各自先有一段历史（同一段会话在两台设备上都有） */
      await a.store.append(sid, [
        { requestId: "r1", type: "request", provider: "strata", model: "m", messages: [{ role: "user", content: "A 说的" }] },
        { requestId: "r1", type: "text", text: "A 答的" },
      ] as LogInput[]);
      await b.store.append(sid, [
        { requestId: "r1", type: "request", provider: "strata", model: "m", messages: [{ role: "user", content: "B 说的" }] },
        { requestId: "r1", type: "text", text: "B 答的" },
      ] as LogInput[]);

      /* A 推、B 拉+合并；B 推、A 拉+合并 */
      expect(await a.push(relay)).toBe(2);
      const bGot = await b.pullAndApply(relay);
      expect(bGot.applied).toBe(2);
      expect(await b.push(relay)).toBe(4); // B 自己的两条 + 刚从 A 合并来的两条
      const aGot = await a.pullAndApply(relay);
      expect(aGot.applied, "A 该只合并 B 那两条").toBe(2);
      expect(aGot.mine, "A 自己那两条不该被当成外来的").toBeGreaterThanOrEqual(2);

      /* 判据：两边的记录**内容一致**（按 requestId+type+text 比，不比 seq —— 那是本机的编号） */
      const sig = (records: readonly LogRecord[]) =>
        records.map((r) => JSON.stringify({ requestId: (r as { requestId?: string }).requestId, type: r.type, text: (r as { text?: string }).text ?? null })).sort();
      expect(sig((await a.store.load(sid)).records)).toEqual(sig((await b.store.load(sid)).records));
      expect((await a.store.load(sid)).records.length).toBe(4);

      /* 幂等：再同步一轮，两边都不该多出任何一条 */
      const againA = await a.pullAndApply(relay);
      const againB = await b.pullAndApply(relay);
      expect(againA.applied + againB.applied, "重复同步多出了记录").toBe(0);
      expect((await a.store.load(sid)).records.length).toBe(4);
      expect((await b.store.load(sid)).records.length).toBe(4);
    } finally {
      a.store.close();
      b.store.close();
      rmSync(dirA, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      rmSync(dirB, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("⭐ 帧 id 必须带生产者：两端各自的第 3 条**不能**撞成同一个 id（撞了另一端会被当重复丢掉）", () => {
    const sid = chatSessionId("id-collision");
    /* 内容不同 → id 不同（哪怕两端的本地编号一样） */
    const fromA = frameIdOf(sid, { seq: 3, at: 1, type: "text", text: "A 的第 3 条" });
    const fromB = frameIdOf(sid, { seq: 3, at: 1, type: "text", text: "B 的第 3 条" });
    expect(fromA).not.toBe(fromB);
    /* 内容相同、只是本地编号不同 → id **相同**（这就是"经别人转手回来也能认出"） */
    expect(frameIdOf(sid, { seq: 3, at: 1, type: "text", text: "同一句" })).toBe(frameIdOf(sid, { seq: 9, at: 1, type: "text", text: "同一句" }));
    /* 中继按 id 全局去重：两条都进得去（不会因为 id 相同少一条） */
    const relay = createSyncRelay();
    relay.createStream(sid);
    const claimA = relay.claim(sid, "p-A");
    expect(claimA.ok).toBe(true);
    const pushA = relay.push(sid, { producerId: "p-A", epoch: claimA.ok ? claimA.epoch : 0, events: [{ seq: 1, type: "record", id: fromA, payload: { a: 1 } }] });
    /* B 接管（epoch 前进）之后再推 —— 两个生产者各自的第 1 条都要进得去 */
    const claimB = relay.claim(sid, "p-B");
    expect(claimB.ok && claimB.epoch).toBeGreaterThan(claimA.ok ? claimA.epoch : 0);
    const pushB = relay.push(sid, { producerId: "p-B", epoch: claimB.ok ? claimB.epoch : 0, events: [{ seq: 1, type: "record", id: fromB, payload: { b: 1 } }] });
    expect(pushA).toMatchObject({ ok: true, accepted: 1 });
    expect(pushB, "两端的同号记录被当成重复吃掉了").toMatchObject({ ok: true, accepted: 1 });
    const page = relay.pull(sid, { from: 0 });
    expect(page.ok && page.events.length).toBe(2);
  });

  it("⭐ 形状认不出的帧如实计数（不静默吞）；自己推过的 id 用 `myFrameIds` 判得准", () => {
    const sid = chatSessionId("shapes");
    const local = [
      { seq: 1, at: 1, type: "text", text: "第一条" },
      { seq: 2, at: 2, type: "text", text: "第二条" },
      { seq: 3, at: 3, type: "text", text: "第三条" },
    ];
    const mine = myFrameIds(sid, local);
    expect(mine).toHaveLength(3);
    const plan = planMerge({
      sessionId: sid,
      local,
      pulled: [
        { offset: 1, streamId: sid, producer: { id: "p-A", epoch: 1, seq: 1 }, at: 1, type: "record", id: mine[2]!, payload: { record: { type: "text" }, at: 1 } }, // 我的
        { offset: 2, streamId: sid, producer: { id: "p-A", epoch: 1, seq: 1 }, at: 1, type: "record", payload: { record: { type: "text" }, at: 1 } }, // 没有 id
        { offset: 3, streamId: sid, producer: { id: "p-B", epoch: 1, seq: 1 }, at: 1, type: "record", id: "p-B#x#1", payload: { record: { type: "text" }, at: 1 } }, // 好的
        { offset: 4, streamId: sid, producer: { id: "p-B", epoch: 1, seq: 1 }, at: 1, type: "record", id: "p-B#x#2", payload: { nope: true } }, // 载荷不对
      ],
    });
    expect(plan.apply.map((a) => a.id)).toEqual(["p-B#x#1"]);
    /* 幂等：同一条记录在本地库里出现（内容寻址）→ 跳过 —— 不需要"已应用账本" */
    expect(plan.skippedMine).toBe(1);
    expect(plan.skippedBadShape, "形状坏的没被如实计数").toBe(2);
  });
});
