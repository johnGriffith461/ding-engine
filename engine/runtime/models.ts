/**
 * **模型目录表**（Phase 5.1）。
 *
 * ## 它是什么
 *
 * 每个模型一条记录：它属于哪家、**说哪种协议**、上下文上限多少、什么价、有什么能力，
 * 以及 —— 最要紧的 —— 这些数据**从哪来、什么时候核的**。
 *
 * ## 三条硬规矩
 *
 * 1. **每条都要有 `source` 与 `verifiedAt`**。没有来源的条目不许进表：
 *    一个"看起来精确"的上下文上限会让后面所有"这段历史该不该压"的判断建在沙子上，
 *    而那种错**没有任何东西会报**（测试全绿、界面正常，只是账单和截断都不对）。
 * 2. **过期要标出来**（`STALE_DAYS`）：模型的上下限与价格会变。超期时
 *    `describeModel()` 明说"可能过期"，而不是安静地沿用一条两年前的记录。
 * 3. **没登记就老实说没登记**（`findModel()` 返回 undefined，调用方走
 *    `UNKNOWN_MODEL_BUDGET` 这个**保守默认**并标注）。
 *
 * ## 为什么现在只有几条（如实记）
 *
 * 2026-10-14 拿数据时撞到的现实：
 * - DeepSeek 官方文档当天只列 `deepseek-flash` 与 `deepseek-v4-pro`（各 1M）
 *   —— 我们 provider 表里默认用的 `deepseek-chat` / `deepseek-reasoner` **官方已不列**；
 * - 阿里帮助中心那页抓不到 qwen 的具体数值；
 * - models.dev 的聚合表（`api.json`，带 `limit.context`）在本机网络下**反复下断**
 *   （三次尝试，最大 2.7MB 后连接重置）。
 *
 * 所以表里只放**核过实**的那几条。要补全就走 `scripts/vendor-models.mjs`
 * （Phase 5.1 的 vendor 流程：拉 models.dev 快照 → 生成这张表 → 带来源与日期落进仓库），
 * 而不是靠印象手写。
 */

import { GENERATED_MODELS } from "./models.generated";

import type { ModelInfo } from "../core/ledger";

/**
 * 这一家说哪种协议。
 *
 * ⚠️ 它是**线路格式**（请求怎么发、流怎么读），不是"哪家公司的模型"。
 * 中转站（relay）把 claude 用 OpenAI 格式转出来，那它的协议就是 `openai-compatible`。
 */
export type Protocol = "openai-compatible" | "anthropic" | "google";

/** 一个模型的能力（给"要不要给工具/要不要读图"这类判断用）。 */
export type ModelCapabilities = {
  /** 支持工具调用。 */
  toolCall: boolean;
  /** 支持思考/推理（有的家会另给 reasoning 内容）。 */
  reasoning?: boolean;
  /** 能读图/文件（多模态输入）。 */
  attachment?: boolean;
};

/** 目录表里的一条。 */
export type ModelSpec = {
  /** 模型 id（与 provider 表里的写法一致）。 */
  id: string;
  /** 原生提供方（信息用；实际发给谁由 provider 决定）。 */
  provider: string;
  /** 这个模型**原生**说哪种协议（加新 provider 时照着它选协议）。 */
  protocol: Protocol;
  /** 上下文窗口（输入+输出的总上限，token）。 */
  contextWindow: number;
  /** 单价（美元 / 100 万 token）。给不出就不写 —— 不编。 */
  priceIn?: number;
  priceOut?: number;
  /** 命中缓存的读价。 */
  priceCacheRead?: number;
  /** 能力。 */
  capabilities: ModelCapabilities;
  /** 数据来源（URL）。 */
  source: string;
  /** 核实日期（`YYYY-MM-DD`）。 */
  verifiedAt: string;
  /** 备注（离峰价、别名之类的如实说明）。 */
  note?: string;
}

/** 数据保质期（天）。超期就在界面上标"可能过期"。 */
export const STALE_DAYS = 90;

/**
 * **未登记模型的保守默认**。
 *
 * ⚠️ 这两个数**不是任何模型的上限**，是本项目自己定的保守额度：
 * 上下文档位沿用换代前那个固定值（20K），单价**不填**（填 0 会让人以为免费）。
 * 这样未登记模型的行为与换代前一模一样 —— **零漂移**，
 * 而"我们并不知道它的上限"这件事由 `describeModel()` 如实说出来。
 */
export const UNKNOWN_MODEL_BUDGET = {
  contextWindow: 20_000,
  priceIn: undefined,
  priceOut: undefined,
} as const;

/**
 * **我们自己核实过**的条目（一手来源：官方文档）。
 *
 * 它们**优先于**生成物（同名以这里的为准）—— 一手数据比别人的转售视图可信，
 * 这是这张表能被信任的次序。
 */
const HAND_VERIFIED: readonly ModelSpec[] = [
  {
    id: "deepseek-flash",
    provider: "deepseek",
    protocol: "openai-compatible",
    contextWindow: 1_000_000,
    priceIn: 0.15,
    priceOut: 0.6,
    priceCacheRead: 0.003,
    capabilities: { toolCall: true, reasoning: true },
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    verifiedAt: "2026-10-14",
    note: "官方标 1M；价格是**离峰价**（峰值翻倍）。官方同日只列它与本表另一条 v4-pro",
  },
  {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    protocol: "openai-compatible",
    contextWindow: 1_000_000,
    priceIn: 0.66,
    priceOut: 1.98,
    priceCacheRead: 0.022,
    capabilities: { toolCall: true, reasoning: true },
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    verifiedAt: "2026-10-14",
    note: "官方标 1M；离峰价。我们 provider 表里还没这个模型名 —— 先登记，供目录用",
  },
];

/**
 * 目录表 = 我们核过的 + vendor 来的。
 *
 * ⚠️ 同名时**以我们核过的为准**（`HAND_VERIFIED` 在前，查表取第一条命中）。
 * 生成的条目每条都带 `note` 说明它是"别人的转售口径"，别把它当一手规格读。
 */
export const MODEL_CATALOG: readonly ModelSpec[] = [...HAND_VERIFIED, ...GENERATED_MODELS];

/**
 * 给账本用的目录信息（Phase 5.1：未登记模型要在成本账本上**标出来**）。
 *
 * 放在这里而不是让 `core/ledger.ts` 自己查表：分层是 core ← runtime，
 * 反过来 import 就把方向倒了。所以账本要什么，我们在这里备好递过去。
 *
 * @param id 模型 id
 */
export function modelInfoOf(id: string): ModelInfo {
  const spec = findModel(id);
  if (!spec) return { registered: false };
  return {
    registered: true,
    ...(spec.priceIn === undefined ? {} : { priceIn: spec.priceIn }),
    ...(spec.priceOut === undefined ? {} : { priceOut: spec.priceOut }),
    ...(spec.priceCacheRead === undefined ? {} : { priceCacheRead: spec.priceCacheRead }),
  };
}

/** 按模型 id 查一条。 */
export function findModel(id: string | undefined): ModelSpec | undefined {
  if (!id) return undefined;
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** 这条记录过期了没有。日期读不懂也当过期（宁可标出来）。 */
export function isStale(spec: ModelSpec, now: number = Date.now()): boolean {
  const verified = Date.parse(`${spec.verifiedAt}T00:00:00Z`);
  if (!Number.isFinite(verified)) return true;
  return now - verified > STALE_DAYS * 86_400_000;
}

/**
 * 这一轮该按哪个上限算预算（未登记 → 保守默认）。
 *
 * @param id 模型 id
 * @returns 上下文档位（**可能是本项目的保守默认，不是模型上限**）
 */
export function contextWindowOf(id: string | undefined): number {
  return findModel(id)?.contextWindow ?? UNKNOWN_MODEL_BUDGET.contextWindow;
}

/**
 * 给界面/CLI 的一句话（**如实**：登记过没有、来源是什么、过期没有）。
 *
 * @param id 模型 id
 * @param now 现在（测试用）
 */
export function describeModel(id: string | undefined): string {
  const spec = findModel(id);
  if (!spec) {
    return `${id || "(未指定模型)"}：**未登记模型** —— 上下文按保守默认 ${UNKNOWN_MODEL_BUDGET.contextWindow}，单价未知（用量照实入账，成本按"未登记模型"标注）`;
  }
  const price =
    typeof spec.priceIn === "number" && typeof spec.priceOut === "number"
      ? `，$${spec.priceIn}/$${spec.priceOut} 每百万 token`
      : "，单价未记录";
  const caps = [
    spec.capabilities.toolCall ? "工具" : "",
    spec.capabilities.reasoning ? "思考" : "",
    spec.capabilities.attachment ? "读图" : "",
  ]
    .filter(Boolean)
    .join("/");
  const fresh = isStale(spec) ? `⚠️ 数据可能过期（${spec.verifiedAt} 核实）` : `${spec.verifiedAt} 核实`;
  return `${spec.id}（${spec.protocol}${caps ? `，支持${caps}` : ""}）：上下文 ${spec.contextWindow}${price}，${fresh}。来源 ${spec.source}`;
}
