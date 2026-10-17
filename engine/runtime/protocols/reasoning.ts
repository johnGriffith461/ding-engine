import type { JSONObject } from "@ai-sdk/provider";

import type { Protocol } from "../models";

/**
 * **思考强度**（2026-10-16）—— 输入区那颗「模型 · 思考」选择器的引擎侧。
 *
 * ## 为什么要有这一层
 *
 * 主人的话：「这是个假按钮吧，没法选择模型、也没法选择思考强度，这按钮是必须的呀。」
 * —— 对：本机版一直在用**各家的默认值**跑，用户想"这一句值得多想一会儿"或
 * "这点小事别费 token"都没有入口。这里把"强度"变成一个**真的会发出去**的参数。
 *
 * ## 它怎么变成请求
 *
 * 三家 SDK 的写法各不相同，所以映射只做一次（这个函数是**唯一的**映射点）：
 *
 * | 协议 | 写成什么 |
 * |---|---|
 * | `openai-compatible` | `reasoningEffort: "low" / "medium" / "high"` |
 * | `anthropic` | `thinking: { type: "enabled", budgetTokens: <预算> }` |
 * | `google` | `thinkingConfig: { thinkingBudget: <预算> }` |
 *
 * ⚠️ **不传 = 完全维持原行为**（`undefined`）：不发这个参数，走各家自己的默认。
 * 所以"没选"这条路上，今天的行为与昨天**一模一样** —— 这条是刻意的：
 * 本机版面对的是官方直连与一堆中转站，多塞一个字段就可能被某家 400 掉，
 * 只有用户**明确选了**才发。
 */

/** 三档。档位少是刻意的：这是"多想一会儿"的旋钮，不是调参面板。 */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** 界面上的写法。 */
export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

/** 这是不是一档认得出来的强度（来自磁盘/参数的值都要过这一道）。 */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/*
 * Anthropic 与 Google 要的是 **token 预算**，不是档位名。
 * 数字取的是常见档位量级（Anthropic 官方示例常用 1024 起步、Deep Think 用 2 万上下），
 * 不是拍脑袋：低档够"想一想"，高档留得住长链推理。改这三个数就等于改产品手感，
 * 所以它们只出现在这一处。
 */
const BUDGETS: Record<ReasoningEffort, number> = { low: 1_024, medium: 4_096, high: 16_384 };

/**
 * 把档位翻成 AI SDK 的 `providerOptions`。
 *
 * @param protocol 这家走哪种协议（`protocolOf(provider.id)`）
 * @param effort 用户选的档位；`undefined` / 认不出来 → 返回 `undefined`（**什么都不发**）
 * @returns 直接塞给 `streamText` 的 `providerOptions`；不用发时是 `undefined`
 */
export function reasoningProviderOptions(
  protocol: Protocol,
  effort: ReasoningEffort | undefined,
): Record<string, JSONObject> | undefined {
  /*
   * ⚠️ 用 `isReasoningEffort` 判而不是 `if (!effort)`：类型系统管不到运行时来的值
   * （localStorage / IPC / 旧配置文件都可能塞一个野生档位进去），
   * 而"发一个没人认识的 reasoningEffort" 在有些家是 400、有些家是静默忽略 —— 两种都很难查。
   */
  if (!isReasoningEffort(effort)) return undefined;
  if (protocol === "anthropic") {
    return { anthropic: { thinking: { type: "enabled", budgetTokens: BUDGETS[effort] } } };
  }
  if (protocol === "google") {
    return { google: { thinkingConfig: { thinkingBudget: BUDGETS[effort] } } };
  }
  /*
   * ⚠️ key 是 ****（驼峰）——不是协议名 、也不是 provider id。
   * 2026-10-16 真跑时 SDK 报了弃用警告才确定的：
   *      * 写错名字的后果是它**静默丢掉**（请求里根本没有那个字段）——所以这条别凭直觉改。
   */
  return { openaiCompatible: { reasoningEffort: effort } };
}
