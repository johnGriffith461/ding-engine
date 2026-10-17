import type { Actor } from "../core/actor";

/**
 * **同步中继**（V5-2 任务 2.1）：客户端 push/pull 事件，offset 游标，producer 去重，
 * 并发接管带 **fencing**（epoch 令牌）。
 *
 * ## 三句话的分工（V5 §4 的原文口径）
 *
 * · **中继 = 事件总线 + 协调器**（路由 / 隔离 / 取消 / 超时都归它）；
 * · **本地 SQLite 保持数据权威** —— 中继**不是数据主人**：它这一层只保证
 *   "事件按序、恰好一次地送达另一端"，落盘的真相始终在本机；
 * · **fencing**：接管要带 epoch 令牌，旧令牌的写入**被挡**（防脑裂 ——
 *   FastClaw 沙箱租约那条实测教训："10 pods → 10 e2b instances"就是因为没有这道闸）。
 *
 * ## 协议语义（对齐 Durable Streams 的口径）
 *
 * | 语义 | 这里怎么落 |
 * |---|---|
 * | append-only | 只有 `push` 追加、没有修改/删除；offset **永不复用** |
 * | offset 游标 | 每条记录在流里有一个从 1 起的 `offset`；`pull({from})` 是唯一读法 |
 * | exactly-once producer | 每条事件带 `(producerId, epoch, seq)`；重发**同一 seq** 是幂等（跳过） |
 * | 乱序 | seq 跳跃（缺号）→ **整批拒绝**并指出期望值（不静默收下 —— 缺一条就是缺一条） |
 * | fork | 见 `./fork`（2.5 的活）；本文件只保证"从头拉"能拉到完整序列 |
 * | 大内容 | **走引用通道**（3.2b）：载荷超过 `MAX_INLINE_BYTES` 一律拒收，告诉调用方改用 `{ref}` |
 *
 * ## 纯逻辑 + 可注入时钟
 *
 * 不 import fs/electron/node:*（引擎边界守卫盯着 `engine/core/**`；本文件在 `engine/sync/`
 * 同样保持无 IO —— 持久化/网络都在宿主那一侧，这样同一份实现能被 HTTP 中继、测试
 * 与将来的直连模式共用）。
 */

/** 流里的一条记录（追加不可变；进流之后只读）。 */
export type StreamRecord = {
  /** 在这条流里的位置（从 1 起，单调、**永不复用**）。 */
  offset: number;
  streamId: string;
  /** 事件类型（TurnEvent 的 `type` 等 —— 中继不解释它，只搬运）。 */
  type: string;
  /** 事件本体（原样；大内容应改用引用，见 `MAX_INLINE_BYTES`）。 */
  payload: unknown;
  /**
   * 事件自己的**稳定 id**（本地出站队列分配，可选）。
   *
   * 有它在，**跨 epoch 的重发也能去重**（换令牌之后 seq 从头编，光靠
   * `(producer, epoch, seq)` 认不出来"这是不是同一件事"）。没给的只能按三元组去重。
   */
  id?: string;
  /** 谁产的（去重的三元组；`seq` 是该 producer **在这个 epoch 里**的序号）。 */
  producer: { id: string; epoch: number; seq: number };
  /** 中继收到它的时刻（epoch ms）。 */
  at: number;
  /** 谁在写（C5 的 actor；中继透传，不解释）。 */
  actor?: Actor;
};

/** 大内容的**引用形态**（3.2b 的引用通道：流里只放这个，本体走别处）。 */
export type PayloadRef = { ref: { id: string; bytes: number; mime?: string } };

/**
 * 单条事件的**内联体积上限**（序列化后的字节数）。
 *
 * 为什么要有这道闸：事件流是"发生了什么"的索引，不是文件柜 ——
 * 一张 2~3MB 的生成图内联进来，一次 pull 就把它整条灌给每个端。
 * 超限**拒收**（说清"改用引用通道"），不静默截断也不静默接受。
 */
export const MAX_INLINE_BYTES = 64 * 1024;

/** push 的一条事件（seq 由 **producer** 负责在本 epoch 内连续编号）。 */
export type PushEvent = { seq: number; type: string; payload: unknown; actor?: Actor; id?: string };

/** 推的结果。 */
export type PushResult =
  | {
      ok: true;
      /** 这次真正进流的条数。 */
      accepted: number;
      /** 因为 seq 已经收过而跳过的条数（幂等重发的正常结果）。 */
      duplicates: number;
      /** 推完之后流的下一个 offset（= 已收条数 + 1）。 */
      nextOffset: number;
    }
  | {
      ok: false;
      /** `no-stream` 流不存在；`fenced` epoch 过期；`gap` 序号跳跃；`too-large` 载荷过大；`bad-seq` 编号不合法。 */
      code: "no-stream" | "fenced" | "gap" | "too-large" | "bad-seq";
      /** 给人看的一句话（含"下一步怎么做"）。 */
      message: string;
      /** `gap` 时给出期望的 seq（调用方据此补发）。 */
      expected?: number;
    };

/** 一条流的状态（诊断与测试用）。 */
export type StreamState = {
  streamId: string;
  /** 当前 epoch（接管一次 +1）。 */
  epoch: number;
  /** 当前持令牌的那个人（没接管过就是 undefined）。 */
  holder?: string;
  /** 下一个 offset（= 已收条数 + 1）。 */
  nextOffset: number;
  /** 每个 producer 在这条流里的最高 seq（去重账）。 */
  producers: Array<{ id: string; epoch: number; seq: number }>;
};

/** 中继接口。 */
export type SyncRelay = {
  /** 建一条流（幂等：已存在也回 ok）。 */
  createStream(id: string): { ok: true } | { ok: false; code: "bad-id"; message: string };
  /**
   * **接管**：拿一个更新的 epoch 令牌（并发接管 = 谁后拿谁写，前一个立刻失效）。
   *
   * @returns 新 epoch（从 1 开始）
   */
  claim(id: string, holder: string): { ok: true; epoch: number } | { ok: false; code: "no-stream"; message: string };
  /** 追加一批事件（producer 必须带**当前** epoch；重发是幂等的）。 */
  push(
    id: string,
    input: { producerId: string; epoch: number; events: readonly PushEvent[] },
  ): PushResult;
  /** 从游标读（`from` = 想要的第一条的 offset；`0` = 从头）。 */
  pull(
    id: string,
    input: { from: number; limit?: number },
  ): { ok: true; events: StreamRecord[]; nextOffset: number; hasMore: boolean } | { ok: false; code: "no-stream"; message: string };
  /** 流的状态（不存在给 null）。 */
  state(id: string): StreamState | null;
};

/** 建一个中继（内存实现；同一份语义将来可换持久化实现，见文件头）。 */
export function createSyncRelay(opts: { now?: () => number } = {}): SyncRelay {
  const now = opts.now ?? (() => Date.now());
  /** 流 id 的形状（与 sessionId 同一套：它会被放进 URL 与日志）。 */
  const ID_OK = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

  type Stream = {
    records: StreamRecord[];
    epoch: number;
    holder?: string;
    /** `(producerId, epoch)` → 已收到的最高 seq。 */
    producers: Map<string, number>;
    /** 见过的**事件 id**（跨 epoch 去重：换令牌之后 seq 从头编，靠 id 认出"同一件事"）。 */
    seenIds: Set<string>;
  };
  const streams = new Map<string, Stream>();

  /** 序列化后的字节数（算不出来就当"巨大"—— 宁可拒收也不静默放行）。 */
  function payloadBytes(payload: unknown): number {
    try {
      const text = JSON.stringify(payload);
      return typeof text === "string" ? text.length : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY; // 循环引用之类：本来也传不出去
    }
  }

  /** 这是个引用（而不是内联内容）吗 —— 引用本身很小，不受内联上限约束。 */
  function isRef(payload: unknown): boolean {
    const ref = (payload as { ref?: unknown } | null | undefined)?.ref;
    return Boolean(ref && typeof ref === "object" && typeof (ref as { id?: unknown }).id === "string");
  }

  return {
    createStream: (id) => {
      const clean = String(id ?? "").trim();
      if (!ID_OK.test(clean)) {
        return { ok: false, code: "bad-id", message: `流 id 形状不对（${ID_OK.source}）：${JSON.stringify(id)}` };
      }
      if (!streams.has(clean)) streams.set(clean, { records: [], epoch: 0, producers: new Map(), seenIds: new Set() });
      return { ok: true };
    },

    claim: (id, holder) => {
      const stream = streams.get(id);
      if (!stream) return { ok: false, code: "no-stream", message: `没有这条流：${id}（先 createStream）` };
      stream.epoch += 1;
      stream.holder = String(holder ?? "").trim() || undefined;
      return { ok: true, epoch: stream.epoch };
    },

    push: (id, input) => {
      const stream = streams.get(id);
      if (!stream) return { ok: false, code: "no-stream", message: `没有这条流：${id}（先 createStream）` };
      if (input.epoch !== stream.epoch) {
        /*
         * ⭐ **fencing**：旧 epoch 的写入一律挡（防脑裂）。
         * 这是"接管之后老那一端还在写"的唯一屏障 —— 它的消息必须被**明确拒绝**，
         * 而不是"收下但没人看"（后者会让两端都以为自己成功了）。
         */
        return {
          ok: false,
          code: "fenced",
          message: `epoch 过期（你带的是 ${input.epoch}，当前是 ${stream.epoch}）：这条流已经被接管，请重新 claim 拿新令牌。`,
        };
      }

      const key = `${input.producerId}#${input.epoch}`;
      let last = stream.producers.get(key) ?? 0;

      /* 先整批校验（要么全收，要么不收 —— 部分收下会让调用方的游标与本机账目对不上） */
      const fresh: PushEvent[] = [];
      let duplicates = 0;
      for (const event of input.events) {
        if (!Number.isInteger(event.seq) || event.seq <= 0) {
          return { ok: false, code: "bad-seq", message: `seq 必须是正整数（收到 ${String(event.seq)}）` };
        }
        if (!isRef(event.payload) && payloadBytes(event.payload) > MAX_INLINE_BYTES) {
          return {
            ok: false,
            code: "too-large",
            message: `这条事件载荷 ${payloadBytes(event.payload)} 字节，超过内联上限 ${MAX_INLINE_BYTES}：大内容走引用通道（payload 传 {ref:{id,bytes}}），不要塞进事件流。`,
          };
        }
        if (event.id && stream.seenIds.has(event.id)) {
          duplicates += 1; // 同一件事的 id 见过（哪怕换了 epoch）→ 幂等跳过
          continue;
        }
        if (event.seq <= last) {
          duplicates += 1; // 幂等：这批是重发
          continue;
        }
        if (event.seq !== last + fresh.length + 1) {
          const expected = last + fresh.length + 1;
          return {
            ok: false,
            code: "gap",
            message: `序号跳跃：期望 ${expected}，收到 ${event.seq}（缺的事件补上再推，中继不猜）`,
            expected,
          };
        }
        fresh.push(event);
      }

      /* 到这里才动状态（校验全过） */
      const at = now();
      for (const event of fresh) {
        stream.records.push({
          offset: stream.records.length + 1,
          streamId: id,
          type: event.type,
          payload: event.payload,
          ...(event.id ? { id: event.id } : {}),
          producer: { id: input.producerId, epoch: input.epoch, seq: event.seq },
          at,
          ...(event.actor ? { actor: event.actor } : {}),
        });
        if (event.id) stream.seenIds.add(event.id);
        last = event.seq;
      }
      if (fresh.length) stream.producers.set(key, last);
      else if (!stream.producers.has(key)) stream.producers.set(key, last);

      return { ok: true, accepted: fresh.length, duplicates, nextOffset: stream.records.length + 1 };
    },

    pull: (id, input) => {
      const stream = streams.get(id);
      if (!stream) return { ok: false, code: "no-stream", message: `没有这条流：${id}（先 createStream）` };
      const from = Math.max(0, Math.floor(input.from));
      const limit = Math.max(1, Math.floor(input.limit ?? 200));
      const events = stream.records.filter((r) => r.offset > from).slice(0, limit);
      const nextOffset = events.length ? events[events.length - 1]!.offset : from;
      return { ok: true, events, nextOffset, hasMore: nextOffset < stream.records.length };
    },

    state: (id) => {
      const stream = streams.get(id);
      if (!stream) return null;
      return {
        streamId: id,
        epoch: stream.epoch,
        ...(stream.holder ? { holder: stream.holder } : {}),
        nextOffset: stream.records.length + 1,
        producers: [...stream.producers.entries()].map(([key, seq]) => {
          const [producerId, epoch] = key.split("#");
          return { id: producerId ?? "", epoch: Number(epoch ?? 0), seq };
        }),
      };
    },
  };
}
