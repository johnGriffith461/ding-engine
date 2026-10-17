import type { PushEvent, StreamRecord, SyncRelay } from "./relay";

/**
 * **同步游标**（V5-2 任务 2.1 的客户端那一半）：本地攒的事件推上去、拉到哪儿了记住。
 *
 * ## 两格游标，各管一头
 *
 * · `pushedSeq`：**推**到哪儿了（producer 侧 seq；重连之后从这里接着编号 —— 补发同一号是幂等的）；
 * · `pulledOffset`：**拉**到哪儿了（中继侧的 offset；断线重连的续传凭据就是它）。
 *
 * ⚠️ 两格都必须是**可以持久化的普通数字**（没有句柄、没有时间戳）——
 * 这一层的全部价值就是"进程死了、网断了，重启之后靠这两个数接着干"。
 * 宿主把 `state()` 存进本地库（V5-2 2.6 与崩溃恢复统一），下次 `restore()` 回来。
 *
 * ## 为什么不用"最后一条记录的 id"当游标
 *
 * offset 是**中继给的、单调的、永不复用的**位置；id 不是（重复投递时同一个 id 会来两次）。
 * 拿 id 当游标会在"重发"那条路上退化成线性扫描，而且没法回答"我漏了没有"。
 */

/** 游标的可持久化状态（**只有数字与 id**，没有句柄）。 */
export type CursorState = {
  streamId: string;
  producerId: string;
  /**
   * 当前的 epoch 令牌。
   *
   * ⚠️ **它必须一起持久化**（这一点在测试里被纠正过）：网络断了重连时，
   * 拿同一个 epoch + 接着编的 seq 重推，中继那侧能**精确去重**（不会因为
   * "重连 = 重新接管"而把在途事件变成新事件）。epoch 只有**被别人接管**时才变。
   */
  epoch: number;
  /** 已经推成功的最高 seq（**在本 epoch 内**的序号）。 */
  pushedSeq: number;
  /** 已经拉到的最高 offset（0 = 还没拉过）。 */
  pulledOffset: number;
};

/** 一次 push 的结果（失败时**游标不动** —— 下一轮重试同一批）。 */
export type CursorPushResult =
  | { ok: true; pushed: number; duplicates: number; nextOffset: number }
  | { ok: false; code: string; message: string };

export type SyncCursor = {
  /** 当前游标（宿主存它）。 */
  state(): CursorState;
  /** 断线重连：从持久化的游标恢复（丢内存不丢进度）。 */
  restore(state: CursorState): void;
  /**
   * **换了一条流：从头重推**（ADR-0016 第 1 条：中继不持久化，重启后流是新的）——
   * 把 `pushedSeq` 清零、用新接管拿到的 `epoch`。
   *
   * ⚠️ 触发信号是**中继自己给的 `gap`**（"你推的 seq 对不上这条流的下一个位置"）：
   * 那不是"推失败"，是"这条流不认识你的进度了" —— 客户端该做的是从这条流的头重推
   * （事件 id 稳定，另一端按 id 去重），不是放弃这一轮。
   *
   * @param input.epoch 新接管的 epoch（`claim` 拿到的）
   * @returns 重置后的状态
   */
  restartStream(input: { epoch: number }): CursorState;
  /**
   * 推一批本地事件。
   *
   * seq 由游标自己编号（`pushedSeq + 1` 起，连续）—— 调用方不该自己编，
   * 否则"重试时编号变了"会让去重失效（同一件事进去两次）。
   *
   * @param events 事件（`{type, payload, id?}`；payload 通常是一个 `TurnEvent`）。
   *   **给了 `id` 的跨 epoch 也能去重**（本地出站队列该给每件事一个稳定 id）
   */
  push(events: readonly { type: string; payload: unknown; actor?: PushEvent["actor"]; id?: string }[]): CursorPushResult;
  /**
   * 从游标拉（一次最多 `limit` 条），拉完 `pulledOffset` 前进。
   *
   * @returns 拉到的事件（空数组 = 已经到头）；失败给 `{error}`
   */
  pull(limit?: number): { events: StreamRecord[]; hasMore: boolean } | { error: string };
  /** 拿到当前 epoch 令牌（接管之后要重新拿；见 relay 的 claim）。 */
  claim(holder: string): { ok: boolean; epoch?: number; error?: string };
};

/**
 * 建一个同步游标。
 *
 * @param relay 中继（同一份语义的内存实现或 HTTP 客户端实现）
 * @param opts 流 / producer 身份；`state` 给了就从它接着干（断线重连那条路）
 */
export function createSyncCursor(
  relay: SyncRelay,
  opts: { streamId: string; producerId: string; state?: CursorState },
): SyncCursor {
  const streamId = opts.streamId;
  const producerId = opts.producerId;
  let cursor: CursorState = opts.state ?? { streamId, producerId, epoch: 0, pushedSeq: 0, pulledOffset: 0 };
  let epoch = cursor.epoch;

  return {
    state: () => ({ ...cursor }),

    restartStream: ({ epoch: next }) => {
      epoch = next;
      cursor = { ...cursor, epoch: next, pushedSeq: 0 };
      return { ...cursor };
    },

    restore: (state) => {
      /* 只认同一条流、同一个 producer 的游标（换流/换人就是另一本账） */
      if (state.streamId !== streamId || state.producerId !== producerId) {
        throw new Error(`游标不属于这条流/这个 producer（${state.streamId}/${state.producerId}）`);
      }
      cursor = {
        streamId,
        producerId,
        epoch: Math.max(0, Math.floor(state.epoch ?? 0)),
        pushedSeq: Math.max(0, Math.floor(state.pushedSeq)),
        pulledOffset: Math.max(0, Math.floor(state.pulledOffset)),
      };
      epoch = cursor.epoch;
    },

    claim: (holder) => {
      const got = relay.claim(streamId, holder);
      if (!got.ok) return { ok: false, error: got.message };
      epoch = got.epoch;
      /*
       * ⚠️ **换了 epoch，seq 从头编**（中继那侧的去重账按 `(producer, epoch)` 分本）——
       * 所以这里把 `pushedSeq` 归零。**在途事件对账**（"换 epoch 之前那批到底进去没有"）
       * 靠两样东西：有 `id` 的事件由中继**跨 epoch 去重**；没 id 的先 pull 一遍核对
       * （offset 游标就是核对工具）。见 `./relay.ts` 的 `PushEvent.id`。
       */
      cursor = { ...cursor, epoch, pushedSeq: 0 };
      return { ok: true, epoch };
    },

    push: (events) => {
      if (!events.length) return { ok: true, pushed: 0, duplicates: 0, nextOffset: 0 };
      const numbered: PushEvent[] = events.map((event, i) => ({
        seq: cursor.pushedSeq + i + 1,
        type: event.type,
        payload: event.payload,
        ...(event.actor ? { actor: event.actor } : {}),
        ...(event.id ? { id: event.id } : {}),
      }));
      const got = relay.push(streamId, { producerId, epoch, events: numbered });
      if (!got.ok) {
        /* ⭐ 失败**不动游标**：下一轮重推同一批（seq 一样 → 中继那侧去重） */
        return { ok: false, code: got.code, message: got.message };
      }
      /*
       * ⚠️ 游标要按 **accepted + duplicates** 前进（这一点被测试纠过）：
       * 全是被去重的重发（accepted 0、duplicates 2）时，那两条**已经在中继里**了 ——
       * 只按 accepted 走，下一条会被编成 seq 1（早就收过）→ 被当成重复丢掉，
       * 于是"补完重发之后的新事件"永远推不上去。
       */
      cursor.pushedSeq += got.accepted + got.duplicates;
      return { ok: true, pushed: got.accepted, duplicates: got.duplicates, nextOffset: got.nextOffset };
    },

    pull: (limit) => {
      const got = relay.pull(streamId, { from: cursor.pulledOffset, ...(limit === undefined ? {} : { limit }) });
      if (!got.ok) return { error: got.message };
      cursor.pulledOffset = got.nextOffset;
      return { events: got.events, hasMore: got.hasMore };
    },
  };
}
