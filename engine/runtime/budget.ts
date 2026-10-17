import { KEEP_RECENT_TOKENS } from "../core/context";
import { UNKNOWN_MODEL_BUDGET, describeModel, findModel, isStale } from "./models";

/**
 * **上下文预算策略**（Phase 5.1 收敛后：数据归数据、策略归策略）。
 *
 * 目录表本体在 `engine/runtime/models.ts`（协议、能力、来源、过期）；
 * 这个文件只回答一个问题：**这一轮给历史留多少额度**。
 *
 * ## 为什么未登记模型走的是原来那个数
 *
 * 未登记 → `keepTokens` 用**换代前那个固定值**（`KEEP_RECENT_TOKENS`），
 * 并在账本/界面上标"未登记模型"。这是刻意的：对未登记的情况，
 * **行为与换代前一模一样**（零漂移），而不是"换了个更大的数、没人知道为什么"。
 * 想让它变更大，正确做法是把那个模型**登记进来**（带来源），不是调默认值。
 */

/**
 * 保留额度的下限（防止"额度小到等于没有"）。
 *
 * ⚠️ 它是一个**上限受模型窗口约束**的下限（2026-10-16，审计 P54）：
 * 窗口小到放不下这个下限时，实际用的是"窗口的一半"，不是这个常数 ——
 * 否则额度会**超过模型容量**（额度算得比它的窗口还大 = 没有预算）。
 * 见 `keepTokensFor`。
 */
export const KEEP_RECENT_TOKENS_MIN = 2_000;

/** 历史最多占上限的比例。 */
export const KEEP_RATIO = 0.5;

/**
 * 保留额度的**上限**：`KEEP_RECENT_TOKENS`（换代前那个固定值）。
 *
 * ## 为什么不跟着模型一路放大（这一条是刻意的，别当 bug 改掉）
 *
 * "上限 × 比例"这条规则如果**只**看模型能力，会得到一个很危险的结果：
 * 1M 上限的模型按一半算就是每轮发 **50 万 token 历史**。
 *
 * ⚠️ 每轮都要把历史**重发一遍** —— 上下文额度直接乘在**每一轮的钱**上。
 * 从 2 万涨到 50 万是**单轮成本 ×25**，而且是**静默**发生的：
 * 用户只会看到账单变贵，看不出是这次改的。
 *
 * 所以这条规则的用法是**双向**的：
 * - **往下**跟着模型走（上限小的模型少留一点，别顶爆）—— 这一半立刻生效；
 * - **往上封顶**在我们自己定的额度上（花钱换连续性是个**决定**，不该由默认值替用户做）。
 *
 * 想留更多历史：把这里调大（Phase 9 的 `~/.ding/config` 已经能配）。那时它是个**明示**的选择。
 */
export const MAX_KEEP_TOKENS = KEEP_RECENT_TOKENS;

/**
 * 查一次预算的结果。
 *
 * ⚠️ `registered: false` 是**一等结果**（不是"没找到就 undefined"）：
 * 调用方必须显式处理"这个模型我们不知道"这件事 —— 要么走保守默认，要么标注出来。
 * 给 `undefined` 的话，最自然的写法是 `?.` 一路空过，
 * 于是"不知道"与"知道但没上限"就混在一起了。
 */
export type BudgetLookup =
  | { registered: true; contextWindow: number; stale: boolean }
  | { registered: false; contextWindow: number; stale: false };

/**
 * 按模型 id 查预算。
 *
 * @param modelId 模型 id
 * @param now 现在（测试里给固定值）
 */
export function budgetOf(modelId: string | undefined, now: number = Date.now()): BudgetLookup {
  const spec = findModel(modelId);
  if (!spec) return { registered: false, contextWindow: UNKNOWN_MODEL_BUDGET.contextWindow, stale: false };
  return { registered: true, contextWindow: spec.contextWindow, stale: isStale(spec, now) };
}

/**
 * 这一轮**该给历史留多少额度**。
 *
 * 两种情形：
 * - **登记过的模型**：上限的 `KEEP_RATIO`，再按 `MAX_KEEP_TOKENS` 封顶、按下限托底；
 * - **没登记**：`KEEP_RECENT_TOKENS`（换代前那个固定值）—— 行为零漂移，并标注"未登记模型"。
 *
 * ⚠️ 返回的数是**我们自己定的额度**，不是"模型的上限"（见 `core/context.ts` 文件头）。
 *
 * @param modelId 模型 id
 * @param now 现在（测试用）
 */
export function keepTokensFor(modelId: string | undefined, now: number = Date.now()): number {
  const found = budgetOf(modelId, now);
  if (!found.registered) return KEEP_RECENT_TOKENS;
  const byModel = Math.floor(found.contextWindow * KEEP_RATIO);
  /*
   * ⭐ 下限也要**按这个模型自己的窗口压**（2026-10-16，审计 P54）。
   *
   * 原来直接 `Math.max(KEEP_RECENT_TOKENS_MIN, min(byModel, MAX))`：下限 2000 是**绝对**的。
   * 小窗口模型（或用 `--model` 指到一个我们登记了但窗口很小的本地模型）上，
   * 这个 `max` 会把额度**顶到超过模型真实上限** —— 额度算得比它的窗口还大，等于没有预算；
   * 而这条"硬下限"是按大模型的经验定的，它不该对 1k/4k 的模型生效。
   *
   * 现在：下限取「2000」与「这个模型窗口的四分之一」里更小的那个 ——
   * 窗口够大时与原来**逐字一致**，窗口小时不会越界。
   */
  const floor = Math.min(KEEP_RECENT_TOKENS_MIN, Math.floor(found.contextWindow / 4));
  return Math.max(floor, Math.min(byModel, MAX_KEEP_TOKENS));
}

/**
 * 给界面/CLI 的一句话（**如实**：登记过没有、来源是什么、过期没有、我们按多少留）。
 *
 * @param modelId 模型 id
 * @param now 现在（测试用）
 */
export function describeBudget(modelId: string | undefined, now: number = Date.now()): string {
  const found = budgetOf(modelId, now);
  if (!found.registered) return describeModel(modelId);
  return `${describeModel(modelId)}；我们按 ${keepTokensFor(modelId, now)} token 保留历史（封顶 ${MAX_KEEP_TOKENS}）`;
}
