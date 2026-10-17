import { sumUsage, type StepUsage } from "../../shared/cost";
import { actorOf, type Actor } from "./actor";
import type { LogRecord } from "./events";

/**
 * **成本账本**（Phase 3.3）。
 *
 * ## 先立规矩：这里只记 provider 说过的话
 *
 * 账本里的每一个数都来自 provider 在那次请求的响应里**上报的** `usage`。
 * 拿不到就**不记这一条** —— 不按字数估、不按轮数乘、不补一个零。
 *
 * 为什么把这条放在最前面：一个"消耗"数字最坏的失效不是偏小，是**看起来精确**。
 * 界面/终端上一个 `↑10301 ↓854` 没人会怀疑，而它一旦是估出来的，
 * 后面所有"这个任务到底花不花得起"的判断都建在沙子上。
 *
 * （界面上那个**明确标注为估算**的"消耗"数是另一回事，口径在
 * `shared/cost.ts` 的 `fabricatedCost` —— 它从不说自己是 token。）
 *
 * ## 它是怎么算出来的
 *
 * 不新增任何存储：账本**从会话事件流里读**（`done` 事件带着 usage，`request` 事件带着
 * provider/model）。也就是说 —— 会话日志就是账本，两者不可能对不上。
 * 这一点是刻意的：另存一份"用量统计"文件，它迟早会与日志漂移（本项目的老毛病）。
 */

/** 一条入账（一轮 = 一条）。 */
export type LedgerEntry = {
  sessionId: string;
  /** 这一轮的 requestId（同一会话内唯一）。 */
  requestId: string;
  /** 落账时刻（`done` 事件的时间戳）。 */
  at: number;
  provider: string;
  model: string;
  /** provider 上报的用量（**一定存在**：没有它就不入账**）。 */
  usage: StepUsage;
  /**
   * **谁花的**（V5-3 3.4：三层身份里的"人"那一层）。
   *
   * 取自这条请求对应的 `request` 记录的 actor（C5）—— 老记录读回 `legacy`。
   * 账本**不新记一份**：钱是"那一轮花的"，而"谁发起的那一轮"日志里已经有了。
   */
  actor?: Actor;
  /**
   * **哪个账目/空间花的**（三层身份里的 account 那一层）。
   *
   * ⚠️ 由宿主在 `ledgerOf` 时注入（会话归属 / 空间），**不进记录** ——
   * 加记录字段是一次契约变更（ADR-0010 的门），而这一格是"账本怎么看"的事。
   */
  accountId?: string;
  /**
   * **外部渠道的终端用户**（三层身份里的 end_user：V5-3 3.6 的多渠道）。
   * 同样由宿主注入（渠道处理器知道是谁发的消息）。
   */
  endUserId?: string;
};

/**
 * 目录表里关于某个模型的信息（由调用方注入）。
 *
 * ⚠️ 账本**自己不去查目录表**：它在 `core/`（纯逻辑、零依赖），
 * 而目录表在 `runtime/`。让 core 去 import runtime 就把分层倒过来了。
 * 所以由调用方把"这个模型登记过没有、单价多少"作为**参数**传进来。
 */
export type ModelInfo = {
  /** 目录表里有没有这个模型。 */
  registered: boolean;
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
};

/** 汇总里的一行。 */
export type LedgerTotal = {
  key: string;
  /** 一句话的标签（会话标题 / 日期 / 模型名）。 */
  label: string;
  /** 入账了几轮。 */
  turns: number;
  /** 合计用量（逐项求和；一个数都没有时 undefined）。 */
  usage?: StepUsage;
  /** 输入 + 输出（provider 没给就 null —— **不编**）。 */
  totalTokens: number | null;
  /** 这个模型**没在目录表里登记**（成本账本要标出来，别让人以为价格是核过的）。 */
  unregistered?: boolean;
  /**
   * 按目录表单价**估算**的花费（美元）。
   *
   * ⚠️ 它是**估算**，名字里就带着 `estimated`：
   * - `usage` 是 provider 报的真值，但**单价**来自目录表，而目录表可能过期；
   * - 缓存读/写的计价口径各家不同，这里只按"输入/输出"两档粗算。
   * 所以它只用来"看量级"，不能当账单。拿不到单价时**不给数**（不编一个 0）。
   */
  estimatedCost?: number;
};

/**
 * 从一段会话的记录里算出账本。
 *
 * ⚠️ 一次请求的用量挂在 **`done` 事件**上（`runTurn` 收尾时才拿得到真实 usage）。
 * 于是"这一轮用了多少"要靠 `requestId` 把 `request`（provider/model）与 `done`（usage）
 * 配起来。
 *
 * **配不上也入账**（provider/model 空着，汇总时归到「(未登记模型)」那一行）——
 * 这是一个刻意的取舍：用量是 provider **真的报过**的数，丢掉它会让总数偏小，
 * 而"偏小的账单"比"少一个标签的账单"坏得多。空着的那一格如实空着，不补。
 *
 * @param records 会话记录（按 `seq` 升序）
 * @param sessionId 会话 id（不给就从记录里推不出来，只有 provider/model 有意义）
 * @returns 入账清单（按发生顺序）
 */
export function ledgerOf(
  records: readonly LogRecord[],
  sessionId = "",
  opts: { accountId?: string; endUserId?: string } = {},
): LedgerEntry[] {
  /** requestId → 那次请求的落账信息（等 done 来配）。 */
  const pending = new Map<string, { at: number; provider: string; model: string; actor?: Actor }>();
  const out: LedgerEntry[] = [];

  for (const record of records) {
    if (record.type === "request") {
      /* 谁发起的那一轮（C5 的 actor）—— 账本按人汇总靠它，不另记一份 */
      pending.set(record.requestId, {
        at: record.at,
        provider: record.provider,
        model: record.model,
        actor: actorOf(record as { actor?: Actor }),
      });
      continue;
    }
    if (record.type !== "done") continue;
    const usage = (record as { usage?: StepUsage }).usage;
    // 没有上报用量 → 不入账（**不编**）
    if (!usage || (typeof usage.inputTokens !== "number" && typeof usage.outputTokens !== "number")) continue;
    const head = pending.get(record.requestId);
    out.push({
      sessionId,
      requestId: record.requestId,
      at: record.at,
      provider: head?.provider ?? "",
      model: head?.model ?? "",
      usage,
      ...(head?.actor ? { actor: head.actor } : {}),
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
      ...(opts.endUserId ? { endUserId: opts.endUserId } : {}),
    });
  }
  return out;
}

/** 本地时区的 `YYYY-MM-DD`（按天分组用；**不**用 UTC —— 用户按自己的日期理解"今天花了多少"）。 */
export function localDay(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把入账清单按某个维度汇总。
 *
 * @param entries 入账清单
 * @param by `session`（会话）/ `day`（天）/ `model`（模型）
 * @param labelOf 会话维度的标签（会话标题在外层拿，这里不猜）
 * @returns 汇总行（按 totalTokens 降序；没有 token 的排在后面）
 */
export function rollup(
  entries: readonly LedgerEntry[],
  by: "session" | "day" | "model" | "member" | "account" | "endUser",
  labelOf: (key: string) => string = (k) => k,
  /**
   * 目录表查询（可选）。给了就在汇总行上标出"未登记模型"并估算花费。
   * 不给 = 只报 provider 报过的 token（那是**一定不编**的那部分）。
   */
  modelInfo?: (modelId: string) => ModelInfo,
): LedgerTotal[] {
  const groups = new Map<string, LedgerEntry[]>();
  const keyOf = (e: LedgerEntry): string => {
    if (by === "session") return e.sessionId || "(未知会话)";
    if (by === "day") return localDay(e.at);
    if (by === "member") return e.actor?.id || "(未署名)";
    if (by === "account") return e.accountId || "(未归属账目)";
    if (by === "endUser") return e.endUserId || "(本机对话)";
    return e.model || "(未登记模型)";
  };

  for (const entry of entries) {
    const key = keyOf(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const rows: LedgerTotal[] = [];
  for (const [key, list] of groups) {
    const usage = sumUsage(list.map((e) => e.usage));
    const totalTokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    /*
     * 目录表信息：按**这一组里的模型**取。按会话/按天汇总时一组里可能混着多个模型，
     * 那时只要有一个没登记就标出来（宁可多标，别让一个未登记的混过去）。
     */
    const infos = modelInfo ? list.map((e) => modelInfo(e.model || "")) : [];
    const unregistered = infos.length > 0 && infos.some((i) => !i.registered);
    const cost = estimateCost(list, modelInfo);
    rows.push({
      key,
      label: by === "session" ? labelOf(key) : key,
      turns: list.length,
      ...(usage ? { usage } : {}),
      totalTokens: totalTokens > 0 ? totalTokens : null,
      ...(unregistered ? { unregistered: true } : {}),
      ...(cost === undefined ? {} : { estimatedCost: cost }),
    });
  }
  return rows.sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1));
}

/**
 * 按目录单价估算花费。
 *
 * ⚠️ 规矩：**任何一项拿不到就整条不给数**。
 * 宁可没有这个数，也不要给一个"看起来像账单"的估算 —— 那种数最容易被当真。
 *
 * @param list 这一组里的入账
 * @param modelInfo 目录查询（没给就直接返回 undefined）
 * @returns 估算（美元，四位小数）；算不出来时 undefined
 */
function estimateCost(list: readonly LedgerEntry[], modelInfo?: (id: string) => ModelInfo): number | undefined {
  if (!modelInfo) return undefined;
  let total = 0;
  let any = false;
  for (const entry of list) {
    const info = modelInfo(entry.model || "");
    const inTokens = entry.usage.inputTokens;
    const outTokens = entry.usage.outputTokens;
    if (!info.registered || typeof info.priceIn !== "number" || typeof info.priceOut !== "number") continue;
    if (typeof inTokens !== "number" && typeof outTokens !== "number") continue;
    total += ((inTokens ?? 0) * info.priceIn + (outTokens ?? 0) * info.priceOut) / 1e6;
    any = true;
  }
  return any ? Math.round(total * 1e4) / 1e4 : undefined;
}

/**
 * 一行账目的人话（终端与未来的界面共用一份口径）。
 *
 * ⚠️ 缺失的字段写成 `-`，**不写成 0**：`0` 是"真的没花"，`-` 是"provider 没说"。
 * 这两种情况混起来之后，"这个模型是不是不要钱"就再也分不清了。
 *
 * @param row 汇总行
 * @returns 一句话
 */
export function formatTotal(row: LedgerTotal): string {
  const u = row.usage;
  const input = typeof u?.inputTokens === "number" ? String(u.inputTokens) : "-";
  const output = typeof u?.outputTokens === "number" ? String(u.outputTokens) : "-";
  const cache = typeof u?.cacheReadTokens === "number" ? ` 缓存读 ${u.cacheReadTokens}` : "";
  /*
   * ⚠️ 这三段尾巴的措辞是**刻意的**：
   * - "未登记模型" 明说"我们不知道它的价格"；
   * - "约 $x（按目录单价估）" 把"估"字带出来 —— 它是量级参考，不是账单。
   */
  const flag = row.unregistered ? "　（未登记模型：单价未知）" : "";
  const cost = typeof row.estimatedCost === "number" ? `　约 $${row.estimatedCost.toFixed(4)}（按目录单价估）` : "";
  return `${row.label}：${row.turns} 轮　↑${input} ↓${output}${cache}${cost}${flag}`;
}
