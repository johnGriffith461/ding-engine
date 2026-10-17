import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCursorJournal } from "../adapters/syncCursorJournal";
import { closeKv, kvWrite } from "../adapters/kvStore";
import { createSqliteSessionStore } from "../adapters/sqliteStore";
import { chatSessionId, type LogRecord } from "../core/events";
import { createSyncCursor, type CursorState } from "./cursor";
import { eventIdOf, outboxOf, resumeMatches } from "./outbox";
import { createSyncRelay } from "./relay";

/**
 * **离线续传**（V5-2 任务 2.6）：杀进程重连之后接着推，中继那条流与本地记录
 * **逐条一致（diff=0）**。
 *
 * 这一组用真的 SQLite 本地库 + 真的中继 + 真的游标账本跑一遍"进程死掉"：
 *
 * ```
 * ① 一轮正常推（游标落账）
 * ② 「进程被杀」：内存里的一切丢掉，只剩本地库与账本
 * ③ 重连：账本读回游标 → 从**本地记录**重建出站队列（不另存队列）→ 接着推
 * ④ 判据：中继那条流 == 本地记录（条数/顺序/内容逐条相等）
 * ```
 *
 * ⚠️ 这一组的价值在于它挡的是"两套账"：队列若单独存一份，就会与本地记录漂移
 * （少推、重推、顺序乱），而"本地 SQLite 是权威"这条不变量正是为了不让那种事发生。
 */

let dir: string;
let opened: { close(): void }[] = [];

function openStore() {
  const store = createSqliteSessionStore(dir);
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-resume-"));
  opened = [];
});

afterEach(() => {
  for (const store of opened) store.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows 占用是一次性冲突，别把它判成失败 */
  }
});

const req = (text: string) =>
  ({
    requestId: "r1",
    type: "request",
    provider: "p",
    model: "m",
    messages: [{ role: "user", content: text }],
  }) as never;

describe("2.6 · 出站队列从本地记录推出来（不另存一份账）", () => {
  it("游标没推过 → 全推；推过 → 只推新的那一段；事件 id 由（会话 id, 本地 seq）拼成", () => {
    const records = [
      { seq: 1, at: 1, requestId: "r", type: "text", text: "甲" },
      { seq: 2, at: 2, requestId: "r", type: "text", text: "乙" },
      { seq: 3, at: 3, requestId: "r", type: "text", text: "丙" },
    ] as unknown as LogRecord[];
    expect(outboxOf("task-1", records, null).map((e) => e.id)).toEqual(["task-1#1", "task-1#2", "task-1#3"]);
    const pending = outboxOf("task-1", records, { pushedSeq: 2 });
    expect(pending.map((e) => e.id)).toEqual(["task-1#3"]);
    expect(pending[0]?.type).toBe("text");
    /* payload 是记录本体**去掉 seq**（seq 属于本地编号，不搬到对端当身份） */
    expect(pending[0]?.payload).toEqual({ at: 3, requestId: "r", type: "text", text: "丙" });
  });

  it("id 唯一一份拼法（别处手抄会漂）", () => {
    expect(eventIdOf("task-9", 12)).toBe("task-9#12");
  });
});

describe("2.6 · 杀进程重连 → 续传 diff=0（真 SQLite + 真中继 + 真账本）", () => {
  it("⭐ 推一半被杀 → 账本读回游标 → 从本地记录接着推 → 流与本地逐条一致", async () => {
    const sid = chatSessionId("resume");
    const store = openStore();
    await store.append(sid, [req("第一句")]);
    await store.append(sid, [
      { requestId: "r1", type: "text", text: "回一" } as never,
      { requestId: "r1", type: "text", text: "回二" } as never,
    ]);
    const local = (await store.load(sid)).records;
    expect(local).toHaveLength(3);

    const relay = createSyncRelay({ now: () => 1_700_000_000_000 });
    relay.createStream(sid);
    const journal = createCursorJournal(dir);

    /* ① 第一个"进程"：接管 + 推前两条 + 把游标落账 */
    {
      const claimed = relay.claim(sid, "手机");
      const epoch = claimed.ok ? claimed.epoch : 0;
      const cursor = createSyncCursor(relay, {
        streamId: sid,
        producerId: "手机-p1",
        state: { streamId: sid, producerId: "手机-p1", epoch, pushedSeq: 0, pulledOffset: 0 },
      });
      const pending = outboxOf(sid, local.slice(0, 2), cursor.state());
      expect(cursor.push(pending)).toMatchObject({ ok: true, pushed: 2 });
      journal.save(cursor.state());
      expect(relay.state(sid)?.nextOffset).toBe(3);
    }

    /* ② 「进程被杀」：这个作用域里的 cursor 对象没有了 —— 只剩本地库与账本 */

    /* ③ 重连：账本读回游标 → 出站队列从**本地记录**重建 → 接着推 */
    const restored = journal.load(sid);
    expect(restored.status).toBe("ok");
    if (restored.status !== "ok") return;
    expect(restored.cursor).toMatchObject({ pushedSeq: 2, pulledOffset: 0 });

    const cursor2 = createSyncCursor(relay, {
      streamId: sid,
      producerId: "手机-p1",
      state: restored.cursor,
    });
    /* 重连之后**先把欠账推完**（`at` 与 id 都由本地记录给 —— 崩几次都是同一批 id） */
    const again = outboxOf(sid, local, cursor2.state());
    expect(again.map((e) => e.id)).toEqual([eventIdOf(sid, 3)]);
    expect(cursor2.push(again), "重连后推不上去（token 过期？游标没读回？）").toMatchObject({ ok: true, pushed: 1 });
    journal.save(cursor2.state());

    /* ④ 判据：中继那条流与本地记录**逐条一致**（续传 diff=0） */
    const pulled = relay.pull(sid, { from: 0 });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    expect(resumeMatches(sid, local, pulled.events), "续传之后流与本地不一致").toBe(true);
    expect(pulled.events).toHaveLength(3);

    /* 顺带：本地又长了一条 → 再推只推新的那条（游标在，不重发） */
    await store.append(sid, [{ requestId: "r1", type: "done" } as never]);
    const grown = (await store.load(sid)).records;
    const more = outboxOf(sid, grown, cursor2.state());
    expect(more.map((e) => e.id)).toEqual([eventIdOf(sid, 4)]);
    expect(cursor2.push(more)).toMatchObject({ ok: true, pushed: 1 });
    const finalPage = relay.pull(sid, { from: 0 });
    if (finalPage.ok) expect(resumeMatches(sid, grown, finalPage.events)).toBe(true);
  });

  it("⭐ 中继**换了一个实例**（进程重启）：客户端从游标接着推，不重发已送达的（ADR-0016 第 1 条）", async () => {
    /*
     * 这条是"中继**保持不持久化**"那个决定要的证据：会丢东西的场景不是"客户端崩"，
     * 而是"中继重启/换实例" —— 而客户端那一侧有落盘的游标 + 从本地记录推出来的出站队列，
     * 所以它能接着推。**代价也一起钉住**：新中继上只有"游标之后"的那一段
     * （重启前已经送达、进了老中继内存的那些，在新实例上没有了 —— 那要从另一端或本地库补）。
     */
    /*
     * ⚠️ 用本文件既有的装置（`dir` + `opened` + afterEach 统一收）：Windows 上
     * 自己 `rmSync` 会因为库/账本的句柄还开着而 EPERM —— 那是装置的事，不是被测的事。
     */
    dir = mkdtempSync(path.join(tmpdir(), "dh-sync-restart-"));
    {
      const sid = chatSessionId("relay-restart");
      const store = openStore();
      for (let i = 0; i < 4; i += 1) await store.append(sid, [{ requestId: "r1", type: "text", text: `第 ${i} 条` } as never]);
      const local = (await store.load(sid)).records;
      const journal = createCursorJournal(dir);

      /* ① 老中继：接管 + 推前两条 + 游标落账 */
      const relayA = createSyncRelay({ now: () => 1_700_000_000_000 });
      relayA.createStream(sid);
      const claimedA = relayA.claim(sid, "手机");
      const epochA = claimedA.ok ? claimedA.epoch : 0;
      const cursorA = createSyncCursor(relayA, {
        streamId: sid,
        producerId: "手机-p1",
        state: { streamId: sid, producerId: "手机-p1", epoch: epochA, pushedSeq: 0, pulledOffset: 0 },
      });
      expect(cursorA.push(outboxOf(sid, local.slice(0, 2), cursorA.state()))).toMatchObject({ ok: true, pushed: 2 });
      journal.save(cursorA.state());
      expect(relayA.pull(sid, { from: 0 })).toMatchObject({ ok: true });

      /* ② 老中继"进程结束"（对象直接丢掉 —— 它本来就不落盘） */
      expect(journal.load(sid)).toMatchObject({ status: "ok", cursor: { pushedSeq: 2 } });

      /* ③ 新中继：建流 + 重新接管（epoch 会前进 —— fencing 语义照旧） */
      const relayB = createSyncRelay({ now: () => 1_700_000_000_000 });
      relayB.createStream(sid);
      const claimedB = relayB.claim(sid, "手机");
      expect(claimedB.ok).toBe(true);
      const epochB = claimedB.ok ? claimedB.epoch : 0;
      /*
       * ⚠️ 新实例的 epoch **从头开始**（这是内存中继的必然：它不记得上一次谁接管过）。
       * 这条如实钉住 —— 它是"中继不持久化"的**代价之一**：重启那一刻的 fencing 只剩
       * "本机库的归属校验 + 单一中继"这层保护（真的多实例部署时，epoch 必须落盘，
       * 那正是"该持久化中继"的触发条件，写进 ADR-0016）。
       */
      expect(epochB, "新实例的 epoch 从头开始（内存中继不记得上一次接管）").toBe(1);
      void epochA;

      const restored = journal.load(sid);
      if (restored.status !== "ok") throw new Error("游标没读回来");
      const cursorB = createSyncCursor(relayB, {
        streamId: sid,
        producerId: "手机-p1",
        state: { ...restored.cursor, epoch: epochB },
      });

      /*
       * ⭐ **关键一步**：换流之后拿旧游标直接推，中继会回 `gap`
       * （新流的起点是 1，而游标说 3）—— 这是**设计好的信号**：这条流不认识你的进度了。
       * 客户端要做的是"从这条流的头重推"（事件 id 稳定，另一端按 id 去重），
       * 而不是放弃。第一版这里我直接推 3..4，于是拿到 `gap` 并红了 —— 那条红是对的：
       * 它把"中继不持久化之后到底怎么恢复"这件事逼出了一个明确的写法（`restartStream`）。
       */
      const naive = cursorB.push(outboxOf(sid, local.slice(2), cursorB.state()));
      expect(naive, "拿旧游标往新流推：中继该说 gap（跳号）").toMatchObject({ ok: false, code: "gap" });

      cursorB.restartStream({ epoch: epochB });
      expect(cursorB.state()).toMatchObject({ epoch: epochB, pushedSeq: 0 });
      const all = outboxOf(sid, local, cursorB.state());
      expect(all.map((e) => e.id), "重推是**整条流从头**（id 不变 → 另一端按 id 去重）").toEqual([
        eventIdOf(sid, 1),
        eventIdOf(sid, 2),
        eventIdOf(sid, 3),
        eventIdOf(sid, 4),
      ]);
      expect(cursorB.push(all), "重置之后推不上去").toMatchObject({ ok: true, pushed: 4 });

      /* ④ 判据：新中继那条流与本地记录**逐条一致（diff=0）** —— 这才是"能恢复"的真判据 */
      const pulled = relayB.pull(sid, { from: 0 });
      expect(pulled.ok).toBe(true);
      if (!pulled.ok) return;
      expect(resumeMatches(sid, local, pulled.events), "换实例 + 从头重推之后，流与本地仍不一致").toBe(true);
      closeKv(dir);
    }
  });

  it("⭐ ack 丢了（崩在「推成功但没落账」之后）：重推同一批被去重，流里不出现两次", async () => {
    const sid = chatSessionId("lost-ack");
    const store = openStore();
    await store.append(sid, [req("一句话"), { requestId: "r1", type: "text", text: "回一" } as never]);
    const local = (await store.load(sid)).records;

    const relay = createSyncRelay();
    relay.createStream(sid);
    const claimed = relay.claim(sid, "手机");
    const epoch = claimed.ok ? claimed.epoch : 0;

    /* 推成功，但"落账"那一步没发生（模拟崩在两句之间） */
    const cursor = createSyncCursor(relay, {
      streamId: sid,
      producerId: "p1",
      state: { streamId: sid, producerId: "p1", epoch, pushedSeq: 0, pulledOffset: 0 },
    });
    expect(cursor.push(outboxOf(sid, local, null))).toMatchObject({ ok: true, pushed: 2 });

    /* 重连：账本里还是旧的（pushedSeq 0）→ 重推同一批 → **幂等去重** */
    const stale: CursorState = { streamId: sid, producerId: "p1", epoch, pushedSeq: 0, pulledOffset: 0 };
    const cursor2 = createSyncCursor(relay, { streamId: sid, producerId: "p1", state: stale });
    expect(cursor2.push(outboxOf(sid, local, stale))).toMatchObject({ ok: true, pushed: 0, duplicates: 2 });

    const pulled = relay.pull(sid, { from: 0 });
    if (pulled.ok) {
      expect(pulled.events, "重推在流里出现了两次").toHaveLength(2);
      expect(resumeMatches(sid, local, pulled.events)).toBe(true);
    }
  });
});

describe("2.6 · 游标账本（engine/adapters/syncCursorJournal.ts）", () => {
  it("三态如实：没有 / 有 / 坏了（坏了**不当没有**，带一句说明）", () => {
    const journal = createCursorJournal(dir);
    expect(journal.load("task-x")).toEqual({ status: "missing" });

    const cursor: CursorState = { streamId: "task-x", producerId: "p", epoch: 1, pushedSeq: 5, pulledOffset: 4 };
    journal.save(cursor);
    expect(journal.load("task-x")).toEqual({ status: "ok", cursor });

    /* 另一段会话的游标互不影响 */
    journal.save({ ...cursor, streamId: "task-y", pushedSeq: 9 });
    expect(journal.all()).toHaveLength(2);
    expect(journal.load("task-x")).toMatchObject({ status: "ok", cursor: { pushedSeq: 5 } });

    /* 账本文件被手改坏 → corrupt（带说明），而不是静默当空 */
    kvWrite(dir, path.join(dir, "sync-cursors.json"), { 这不是账本: true });
    const broken = journal.load("task-x");
    expect(broken.status).toBe("corrupt");
    if (broken.status === "corrupt") expect(broken.note, "坏账的说明要能看出是「读不出/形状不对」").toMatch(/读不出来|形状不对/);
  });
});
