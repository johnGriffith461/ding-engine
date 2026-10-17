import type { StreamRecord } from "./relay";

/**
 * **同步的合并语义**（V5-2 的客户端那半；ADR-0017）。
 *
 * ## 为什么同步的单位是**记录**，不是事件
 *
 * `TurnEvent` 是**界面投影**（它没有 `requestId`、没有 `at`），而落到另一端要的是
 * "能直接 append 的那一条"。这个项目的立场一直是"**日志即真相**"——所以两端搬的是
 * **记录**（`LogInput` + 它自己的 `at`），不是事件的形状。
 *
 * 一句话：**中继搬的是日志，不是投影。**
 *
 * ## 三条合并规则（每一条都对应一类会静默坏掉的事）
 *
 * | 规则 | 不做会怎样 |
 * |---|---|
 * | **跳过自己的**（id 等于本地某条记录的 `eventIdOf(sessionId, seq)`） | 自己推上去的记录会原样拉回来，本地多一份副本（日志里同一次动作出现两次） |
 * | **跳过已应用的**（id 在本地账本里） | 断线重连/重复 pull 会把同一批远端记录再 append 一遍 |
 * | **`at` 用记录自己的**（不用"现在"） | 另一端的历史会被挤进"我拉到它的那一刻"——账本按天、会话里"什么时候说的"全散（P14/P31 的老教训） |
 *
 * ## 归属（C1）不在这一层判
 *
 * 合并只回答"哪些该 append"。**能不能写这段会话**是宿主的门
 * （服务端 `canWriteSession`、桌面/CLI 的归属校验）——这一层不重复判一次，
 * 那种"两处各判一次"的写法迟早给出两种答案。
 */

/** 一条同步帧的载荷（**记录本体 + 它自己的时刻**）。 */
export type SyncPayload = { record: unknown; at: number };

/**
 * 把一条本地记录包成同步帧（推给中继的那一份）。
 *
 * @param sessionId 会话（本机版的流 id 就是它）
 * @param record 本地记录（带 `seq`/`at`）
 * @param producerId 谁在推（去重三元组的一半；也是 id 的作用域，见 `frameIdOf`）
 */
export function frameOf(sessionId: string, record: { seq: number; at: number }): {
  id: string;
  type: "record";
  payload: SyncPayload;
} {
  return { id: frameIdOf(sessionId, record), type: "record", payload: { record, at: record.at } };
}

/**
 * 一条同步帧的稳定 id：**内容寻址**。
 *
 * ```
 * id = sync#<会话 id>#<FNV-1a(canonical(记录去掉 seq))>
 * ```
 *
 * ## 为什么不是 `(生产者, 本地 seq)`
 *
 * 第一版就是那么拼的，测试当场推翻：**B 把 A 的记录合并进自己库里、再推出去时**，
 * 那些帧带着 B 的 `(本地 seq)` —— A 拉回来看到的是一个"B 的" id，
 * 认不出"这是我的内容"，于是**又 append 一遍**（一端的记录在多跳之后变成两份）。
 * 换 id 拼法救不了这种"转手"：中转站**不可能**知道原本该用哪个编号。
 *
 * 内容寻址把这件事变简单：**id 是内容的函数** —— 一份内容不管走了几跳、由谁推，
 * id 都一样（一端认得出自己的、中转站推出去也不改名）。
 *
 * ## 为什么去掉 `seq`、留着 `at`
 *
 * · `seq` 是**本机编号**（同一件事在两台设备上编号不同）→ 必须去掉；
 * · `at` 是**事实**（"什么时候说的"），而且两端互传时它被原样保留
 *   → 留着它 id 才稳定。两条内容相同但时刻不同的记录（比如两次一模一样的
 *   `done`）因此**不会**被误当同一件事。
 *
 * ⚠️ FNV-1a 不是密码学哈希（不必是：它只用来去重，不承担防篡改 ——
 * 防篡改是签名与 E2EE 那一层的事）。零依赖、确定性，够用。
 */
export function frameIdOf(sessionId: string, record: unknown): string {
  const { seq: _seq, ...rest } = (record ?? {}) as Record<string, unknown>;
  return `sync#${sessionId}#${fnv1a(canonicalJson(rest))}`;
}

/** 键排序的规范化 JSON：同一份内容只有一种写法（否则 id 会因键序不同而不同）。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a（32 位，十六进制）—— 只用来去重，不是密码学哈希。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 一句人话（CLI 与界面共用 —— 两处各写一遍必然漂）。 */
export function appliedNote(plan: MergePlan): string {
  const bits = [`合并 ${plan.apply.length} 条`];
  if (plan.skippedMine) bits.push(`跳过自己的 ${plan.skippedMine} 条`);
  if (plan.skippedApplied) bits.push(`跳过已应用的 ${plan.skippedApplied} 条`);
  if (plan.skippedBadShape) bits.push(`形状不认的 ${plan.skippedBadShape} 条（没吞掉，这里如实计数）`);
  return bits.join("；");
}

/** 一次合并计划。 */
export type MergePlan = {
  /** 要 append 的那些（按中继给的顺序）—— 每条都带着"它自己的时刻"与稳定 id。 */
  apply: Array<{ id: string; record: unknown; at: number; offset: number }>;
  /** 跳过：我自己的（id 与本地某条记录的 id 相同）。 */
  skippedMine: number;
  /** 跳过：之前已经应用过的（账本里有）。 */
  skippedApplied: number;
  /** 跳过：载荷形状认不出来（**如实计数，不静默吞**）。 */
  skippedBadShape: number;
};

/**
 * 定一次合并计划（纯函数：给本地、账本、拉回来的一页，说清该 append 哪几条）。
 *
 * @param input.sessionId 会话（本机版的流 id）
 * @param input.local 本地这一段的记录（**内容**决定"是不是我的"；见 `frameIdOf` 的说明）
 * @param input.pulled 中继给的一页
 */
export function planMerge(input: {
  sessionId: string;
  local: readonly unknown[];
  pulled: readonly StreamRecord[];
}): MergePlan {
  /*
   * "是不是我的"= **本地库里有没有这份内容**（内容寻址的直接好处）：
   * 自己的、以及**经别人转手回来的自己的**，id 都一样 → 一并跳过。
   * 不需要单独的"已应用账本"：应用过的内容就在本地库里。
   */
  const mine = new Set(input.local.map((record) => frameIdOf(input.sessionId, record)));
  const already = new Set<string>();
  const plan: MergePlan = { apply: [], skippedMine: 0, skippedApplied: 0, skippedBadShape: 0 };

  for (const event of input.pulled) {
    const id = typeof event.id === "string" && event.id ? event.id : "";
    if (!id) {
      /* 没有稳定 id 的帧**不应用**：它去不了重，重连一次就会多一份 */
      plan.skippedBadShape += 1;
      continue;
    }
    if (mine.has(id)) {
      plan.skippedMine += 1;
      continue;
    }
    if (already.has(id)) {
      plan.skippedApplied += 1;
      continue;
    }
    const payload = event.payload as SyncPayload | null | undefined;
    const record = payload?.record;
    if (!record || typeof record !== "object" || typeof payload?.at !== "number") {
      plan.skippedBadShape += 1;
      continue;
    }
    plan.apply.push({ id, record, at: payload.at, offset: event.offset });
  }
  return plan;
}

/** 一段会话里本地这些记录对应的帧 id（宿主推之前算一遍，与 `planMerge` 同一套）。 */
export function myFrameIds(sessionId: string, local: readonly unknown[]): string[] {
  return local.map((record) => frameIdOf(sessionId, record));
}
