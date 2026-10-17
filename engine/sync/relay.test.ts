import { describe, expect, it } from "vitest";

import { createSyncCursor, type CursorState } from "./cursor";
import { createSyncRelay, MAX_INLINE_BYTES, type PushEvent } from "./relay";

/**
 * 同步中继（V5-2 任务 2.1）：协议语义的机器证据。
 *
 * 三组，照着方案的验收写：
 *   ① **乱序 / 重复 / 断线重连**三态 fixture；
 *   ② **双端接管 fencing** 正确性；
 *   ③ **多实例竞态**（接管与写入交错时只有最新令牌能写）。
 */

const ev = (seq: number, text = `第 ${seq} 条`): PushEvent => ({ seq, type: "text", payload: { type: "text", text } });

function relayWithStream(id = "s-1") {
  const relay = createSyncRelay({ now: () => 1_700_000_000_000 });
  expect(relay.createStream(id)).toEqual({ ok: true });
  const claimed = relay.claim(id, "端-A");
  expect(claimed.ok).toBe(true);
  const epoch = claimed.ok ? claimed.epoch : 0;
  return { relay, id, epoch };
}

describe("2.1 · 三态：乱序 / 重复 / 断线重连", () => {
  it("⭐ 乱序（缺号）：整批拒绝并指出期望值 —— 不静默收下（缺一条就是缺一条）", () => {
    const { relay, id, epoch } = relayWithStream();
    expect(relay.push(id, { producerId: "p1", epoch, events: [ev(1)] }).ok).toBe(true);
    const jumped = relay.push(id, { producerId: "p1", epoch, events: [ev(3)] });
    expect(jumped.ok).toBe(false);
    if (!jumped.ok) {
      expect(jumped.code).toBe("gap");
      expect(jumped.expected).toBe(2);
    }
    /* 整批拒绝：那条合法的 1 号也没被收第二遍（流里还是 1 条） */
    expect(relay.state(id)?.nextOffset).toBe(2);
  });

  it("⭐ 重复（重发同一批）：幂等跳过，不产生第二条记录", () => {
    const { relay, id, epoch } = relayWithStream();
    const batch = [ev(1), ev(2)];
    const first = relay.push(id, { producerId: "p1", epoch, events: batch });
    expect(first).toMatchObject({ ok: true, accepted: 2, duplicates: 0, nextOffset: 3 });
    const again = relay.push(id, { producerId: "p1", epoch, events: batch });
    expect(again).toMatchObject({ ok: true, accepted: 0, duplicates: 2, nextOffset: 3 });
    /* 混着重发与新增：只收新的那条 */
    const mixed = relay.push(id, { producerId: "p1", epoch, events: [ev(1), ev(2), ev(3)] });
    expect(mixed).toMatchObject({ ok: true, accepted: 1, duplicates: 2, nextOffset: 4 });
    /* 读侧的 nextOffset = 最后拉到的那条的 offset；写侧的下一个才是 state().nextOffset */
    expect(relay.pull(id, { from: 0 })).toMatchObject({ nextOffset: 3 });
    expect(relay.state(id)?.nextOffset).toBe(4);
  });

  it("⭐ 断线重连：游标持久化 → 新游标接着推/拉，事件恰好一次、顺序不乱", () => {
    const { relay, id, epoch } = relayWithStream();
    /* 令牌是宿主从 claim 拿到的（`relayWithStream` 已经领过）—— 把现有状态交给游标 */
    const c1 = createSyncCursor(relay, {
      streamId: id,
      producerId: "p1",
      state: { streamId: id, producerId: "p1", epoch, pushedSeq: 0, pulledOffset: 0 },
    });
    expect(c1.push([{ type: "text", payload: { text: "甲" } }, { type: "text", payload: { text: "乙" } }]).ok).toBe(true);

    /* 「断线」：把游标存下来（epoch 也一起存 —— 它是"我还握着这把令牌"的凭据） */
    const saved: CursorState = c1.state();
    expect(saved).toEqual({ streamId: id, producerId: "p1", epoch, pushedSeq: 2, pulledOffset: 0 });

    /*
     * 重连（**同一个 epoch**）：这里把状态**故意退一格**（`pushedSeq: 0`）来模拟
     * 最凶的那种情况 —— "推成功了但 ack 丢了、本地只存到 0"。
     * 客户端重推 seq 1、2：中继按 `(producer, epoch, seq)` **精确去重**（不进流、不报错）✓
     */
    const c2 = createSyncCursor(relay, { streamId: id, producerId: "p1", state: { ...saved, pushedSeq: 0 } });
    expect(
      c2.push([{ type: "text", payload: { text: "甲" } }, { type: "text", payload: { text: "乙" } }]),
      "重推那批被当成新事件（ack 丢了就会重复）",
    ).toMatchObject({ ok: true, pushed: 0, duplicates: 2 });
    expect(c2.push([{ type: "text", payload: { text: "丙" } }]).ok).toBe(true);
    const pulled = c2.pull();
    expect("events" in pulled).toBe(true);
    if (!("events" in pulled)) return;
    expect(pulled.events.map((r) => r.offset)).toEqual([1, 2, 3]);
    expect(pulled.events.map((r) => (r.payload as { text: string }).text)).toEqual(["甲", "乙", "丙"]);
    expect(c2.state().pulledOffset, "拉完游标没前进").toBe(3);

    /* 再拉一次：空（游标就是"拉到哪儿了"） */
    const empty = c2.pull();
    if ("events" in empty) expect(empty.events).toEqual([]);
    /* 被接管之后才需要重新 claim（那是 fencing 那条路，见下面那组） */
    void epoch;
  });

  it("push 失败时游标不动（下一轮重推同一批，seq 一样 → 中继去重）", () => {
    const { relay, id, epoch } = relayWithStream();
    const cursor = createSyncCursor(relay, { streamId: id, producerId: "p1" });
    cursor.claim("端-A");
    /* 没 claim 过的游标没有 epoch → 必被 fence（模拟"重连后忘了重新拿令牌"） */
    const stale = createSyncCursor(relay, { streamId: id, producerId: "p2" });
    const failed = stale.push([{ type: "text", payload: { text: "x" } }]);
    expect(failed.ok).toBe(false);
    expect(stale.state().pushedSeq, "失败的推把游标推走了（下一轮会漏掉这条）").toBe(0);

    /*
     * 真拿令牌之后再推同一批：成功（被 fence 那批没进流，所以这是**首次**投放）。
     * ⚠️ 这里能看出"去重的身份"是什么：**同一件事的重推必须带同一个 `id`** ——
     * 只重复内容、不带 id 的第二次推送是一条**新事件**（我们的口径：内容相同不等于同一件事，
     * 用户完全可以故意说两遍一样的话）。
     */
    stale.claim("端-B");
    expect(stale.push([{ id: "e-1", type: "text", payload: { text: "x" } }])).toMatchObject({ ok: true, pushed: 1, duplicates: 0 });
    expect(stale.push([{ id: "e-1", type: "text", payload: { text: "x" } }])).toMatchObject({ ok: true, pushed: 0, duplicates: 1 });
    const pulled = relay.pull(id, { from: 0 });
    if (pulled.ok) expect(pulled.events).toHaveLength(1);
    void epoch;
  });

  it("大内容走引用通道：超限的内联载荷被拒（说清下一步），引用形态照收", () => {
    const { relay, id, epoch } = relayWithStream();
    const huge = { text: "x".repeat(MAX_INLINE_BYTES + 1) };
    const rejected = relay.push(id, { producerId: "p1", epoch, events: [{ seq: 1, type: "text", payload: huge }] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.code).toBe("too-large");
      expect(rejected.message).toContain("引用通道");
    }
    const ref = relay.push(id, {
      producerId: "p1",
      epoch,
      events: [{ seq: 1, type: "node.create", payload: { ref: { id: "blob-1", bytes: MAX_INLINE_BYTES * 10 } } }],
    });
    expect(ref.ok).toBe(true);
  });

  it("流不存在 / seq 不合法：明确拒绝（不静默建流、不静默改号）", () => {
    const relay = createSyncRelay();
    expect(relay.push("没这条", { producerId: "p", epoch: 1, events: [ev(1)] })).toMatchObject({ ok: false, code: "no-stream" });
    expect(relay.createStream("带 空格 的 id")).toMatchObject({ ok: false, code: "bad-id" });
    const { relay: r2, id, epoch } = relayWithStream("s-2");
    expect(r2.push(id, { producerId: "p", epoch, events: [{ seq: 0, type: "text", payload: {} }] })).toMatchObject({
      ok: false,
      code: "bad-seq",
    });
  });
});

describe("2.1 · 双端接管：fencing（防脑裂）", () => {
  it("⭐ 接管换令牌：新令牌能写、旧令牌立刻被挡（明确拒绝，不是「收下没人看」）", () => {
    const { relay, id, epoch: e1 } = relayWithStream();
    expect(relay.push(id, { producerId: "p-A", epoch: e1, events: [ev(1)] }).ok).toBe(true);

    /* B 端接管：拿到更后的 epoch */
    const claimed = relay.claim(id, "端-B");
    expect(claimed.ok).toBe(true);
    const e2 = claimed.ok ? claimed.epoch : 0;
    expect(e2).toBeGreaterThan(e1);

    /* A 端还在用旧令牌写 —— 必须被 fence */
    const stale = relay.push(id, { producerId: "p-A", epoch: e1, events: [ev(2)] });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe("fenced");
      expect(stale.message).toMatch(/接管|epoch/);
    }
    /* 被挡的那批**没有进流**（不是"进去了但没人看"） */
    expect(relay.state(id)?.nextOffset).toBe(2);

    /* B 端拿新令牌写：正常（它是**新 producer**，seq 从 1 起） */
    expect(relay.push(id, { producerId: "p-B", epoch: e2, events: [ev(1)] }).ok).toBe(true);
    expect(relay.state(id)?.nextOffset).toBe(3);
    expect(relay.state(id)?.holder).toBe("端-B");
  });

  it("⚠️ 同一个 producer 换 epoch 之后去重账另算（新 epoch 的 seq 从头编，不是重复）", () => {
    const { relay, id, epoch: e1 } = relayWithStream();
    expect(relay.push(id, { producerId: "p-A", epoch: e1, events: [ev(1)] }).ok).toBe(true);
    const e2 = relay.claim(id, "端-A-重连");
    if (!e2.ok) return;
    /* 重连之后 seq 又从 1 开始：这是**新 epoch 的新账**，不该被当重复跳过 */
    const again = relay.push(id, { producerId: "p-A", epoch: e2.epoch, events: [ev(1)] });
    expect(again).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
    expect(relay.state(id)?.nextOffset).toBe(3);
    expect(relay.state(id)?.producers).toHaveLength(2);
  });
});

describe("2.1 · 换 epoch 之后的重发：有 id 的事件跨 epoch 也去重", () => {
  it("⭐ 接管 → 拿新令牌重发在途那条（带 id）：不会变成第二件事", () => {
    const { relay, id } = relayWithStream();
    const a1 = createSyncCursor(relay, { streamId: id, producerId: "p-A" });
    a1.claim("端-A");
    /* 本地出站队列给每件事一个稳定 id（这才是"同一件事"的身份） */
    expect(a1.push([{ id: "ev-1", type: "text", payload: { text: "在途的那条" } }])).toMatchObject({ ok: true, pushed: 1 });

    /* 另一端接管（B 拿到更后的 epoch），A 的旧令牌被 fence */
    const b = createSyncCursor(relay, { streamId: id, producerId: "p-B" });
    const claimed = b.claim("端-B");
    expect(claimed.ok).toBe(true);
    expect(a1.push([{ id: "ev-2", type: "text", payload: { text: "旧令牌写的" } }])).toMatchObject({ ok: false, code: "fenced" });

    /* A 重新接管（拿新 epoch），seq 从头编 —— 但同一条 ev-1 带着 id 重发 */
    expect(a1.claim("端-A").ok).toBe(true);
    expect(a1.state().pushedSeq, "换 epoch 之后 seq 没归零（会与中继的新账对不上）").toBe(0);
    expect(a1.push([{ id: "ev-1", type: "text", payload: { text: "在途的那条" } }])).toMatchObject({
      ok: true,
      pushed: 0,
      duplicates: 1,
    });
    const pulled = relay.pull(id, { from: 0 });
    if (pulled.ok) {
      expect(pulled.events.map((r) => r.id)).toEqual(["ev-1"]);
      expect(pulled.events, "同一条在途事件进了两次").toHaveLength(1);
    }
  });
});

describe("2.1 · 中继多实例竞态：两个端同时接管，只有一个能写", () => {
  it("⭐ 连续接管（A→B→A）：epoch 严格递增，只有最后一个能写", () => {
    const { relay, id } = relayWithStream();
    const eA1 = relay.claim(id, "A");
    const eB = relay.claim(id, "B");
    const eA2 = relay.claim(id, "A");
    if (!eA1.ok || !eB.ok || !eA2.ok) throw new Error("claim 失败");
    expect([eA1.epoch, eB.epoch, eA2.epoch]).toEqual([2, 3, 4]);

    /* 前三个令牌全过期（含 A 自己第一把） */
    for (const epoch of [eA1.epoch, eB.epoch]) {
      expect(relay.push(id, { producerId: "p", epoch, events: [ev(1)] })).toMatchObject({ ok: false, code: "fenced" });
    }
    expect(relay.push(id, { producerId: "p", epoch: eA2.epoch, events: [ev(1)] }).ok).toBe(true);
    expect(relay.state(id)).toMatchObject({ epoch: 4, holder: "A", nextOffset: 2 });
  });

  it("两个 producer 交错推（同一 epoch）：offset 连续、两条都在、按推入顺序", () => {
    const { relay, id, epoch } = relayWithStream();
    expect(relay.push(id, { producerId: "p-1", epoch, events: [ev(1, "甲一")] }).ok).toBe(true);
    expect(relay.push(id, { producerId: "p-2", epoch, events: [ev(1, "乙一")] }).ok).toBe(true);
    expect(relay.push(id, { producerId: "p-1", epoch, events: [ev(2, "甲二")] }).ok).toBe(true);
    const pulled = relay.pull(id, { from: 0 });
    if (!pulled.ok) return;
    expect(pulled.events.map((r) => r.offset)).toEqual([1, 2, 3]);
    expect(pulled.events.map((r) => r.producer.id)).toEqual(["p-1", "p-2", "p-1"]);
    /* 两条 producer 各自的 seq 账互不干扰 */
    expect(relay.state(id)?.producers.map((p) => `${p.id}:${p.seq}`)).toEqual(["p-1:2", "p-2:1"]);
  });

  it("pull 分页：limit 生效，nextOffset 是「下一条该从哪读」", () => {
    const { relay, id, epoch } = relayWithStream();
    relay.push(id, { producerId: "p", epoch, events: [ev(1), ev(2), ev(3)] });
    const page1 = relay.pull(id, { from: 0, limit: 2 });
    if (!page1.ok) return;
    expect(page1.events.map((r) => r.offset)).toEqual([1, 2]);
    expect(page1).toMatchObject({ nextOffset: 2, hasMore: true });
    const page2 = relay.pull(id, { from: page1.nextOffset, limit: 2 });
    if (!page2.ok) return;
    expect(page2.events.map((r) => r.offset)).toEqual([3]);
    expect(page2).toMatchObject({ nextOffset: 3, hasMore: false });
  });
});
