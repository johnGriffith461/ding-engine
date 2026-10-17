/**
 * 「消耗」这个数的**唯一**说法（C5）。
 *
 * ## 必须先说清的一件事：本体那个数不是 token
 *
 * 实机读数记在 `docs/HANDOFF.md:1695`：
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 *
 * > | 额度消耗 | 「消耗 0.48」——**按额度计量，不是 token** |
 *
 * "额度"是本体账号体系里的东西。**本机版没有额度体系**，所以那个数**算不出来**，
 * 也不该假装算得出来。于是这里的口径是：
 *
 * 1. `fabricatedCost()` —— 我们显示的那个数：**按字数估的**，与本体单位不通用，
 *    只保证"同一套口径、可比较、单调"（说得越多它越大）。
 * 2. `usageNote()` —— 真实用量（provider 给的 tokens）**如实说出来**，
 *    并**明确标注上面那个数是估的**。
 *
 * 规矩（别踩）：**不许**把这个估算包装成"额度"的仿制品，也**不许**把单位悄悄换成
 * tokens 而界面文案还写着"消耗"——那是用一种编造替换另一种编造。
 *
 * ⚠️ 公式原来在 `src/workbench/store.ts` 里**抄了两份**（`regenerate` 与 `nextStep` 各一处），
 * 两处一旦漂移，"同一段话重跑一次"与"第一次跑"的消耗就对不上了。现在只有这一份。
 */

/** 本机版的估算单位（本体的"额度"不通用，这里只是让数字可读）。 */
export function fabricatedCost(text: string): number {
  /*
   * ⚠️ 2026-10-16（审计 G53.l）：这里原来套着一层 `Math.max(0.01, …)` —— 而公式里
   * 已经有 `+ 0.1` 的底座，`≥ 0.1 > 0.01` **恒成立**：那层夹紧是**死代码**
   * （测试里那条"有下限 0.01"因此也是恒真的）。按"要么被用要么被删"删掉，
   * 下限仍由 `+ 0.1` 保证（空文本 → 0.10，见 `cost.test.ts`）。
   */
  return Math.round(((String(text ?? "").length / 4) * 0.01 + 0.1) * 100) / 100;
}

/** 一步上记的真实用量。 */
export type StepUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** 未命中缓存的输入 tokens（provider 的 `inputTokenDetails.noCacheTokens`）。 */
  noCacheTokens?: number;
  /** 命中缓存、从缓存读回的输入 tokens（`cacheReadTokens`）。 */
  cacheReadTokens?: number;
  /** 写进缓存的那部分输入（`cacheWriteTokens`；不是每家 provider 都给）。 */
  cacheWriteTokens?: number;
  /** 这一轮**真的**花了多久（毫秒）—— 吞吐量的分母，由主进程实测（不是估的）。 */
  elapsedMs?: number;
};

/** 界面上的一行用量。 */
export type UsageRow = { key: string; label: string; value: string; note?: string };

/**
 * 四位数以上换成「万」，与实机那个「75.9万」的写法一致。
 *
 * 导出（Phase 13.3）：长回合的进度叙述（`第 3 步，已用 1.2万 token`）要用**同一个口径** ——
 * 各写一份格式化，界面上就会出现「75.9万」与「759412」两种写法。
 */
export function formatCount(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
}

/**
 * 把用量翻成界面上那几行 —— **口径只有这一处**。
 *
 * 规矩与 `costNote` 同源：**拿不到的行就不出现**（不编一个像用量的值）；
 * 能**推**出来的要标明是推的（`note`）。典型的那条：
 * 「未缓存输入」在 provider 只给总数与缓存读取时，由 `输入总数 − 缓存读取` 得出 ——
 * 这是 OpenAI 兼容接口的口径（`prompt_tokens` **含**缓存那部分）。
 *
 * @param usage 一步的真实用量（可能只有一部分字段）
 * @returns 有值可显示的行（顺序：缓存读取 / 未缓存输入 / 缓存命中 / 缓存写入 / 输出 / 吞吐量）
 */
export function usageRows(usage?: StepUsage): UsageRow[] {
  const rows: UsageRow[] = [];
  if (!usage) return rows;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;

  const derivedNoCache =
    typeof inputTokens === "number" && typeof cacheReadTokens === "number"
      ? Math.max(0, inputTokens - cacheReadTokens)
      : undefined;
  const noCache = typeof usage.noCacheTokens === "number" ? usage.noCacheTokens : derivedNoCache;
  const isDerived = typeof usage.noCacheTokens !== "number" && typeof noCache === "number";

  if (typeof cacheReadTokens === "number") {
    rows.push({ key: "cacheRead", label: "缓存读取", value: formatCount(cacheReadTokens) });
  }
  if (typeof noCache === "number") {
    rows.push({
      key: "noCache",
      label: "未缓存输入",
      value: formatCount(noCache),
      ...(isDerived ? { note: "输入总数减缓存读取" } : {}),
    });
  }
  if (typeof cacheReadTokens === "number" && typeof noCache === "number" && cacheReadTokens + noCache > 0) {
    rows.push({
      key: "cacheHit",
      label: "缓存命中",
      value: `${Math.round((cacheReadTokens / (cacheReadTokens + noCache)) * 100)}%`,
    });
  }
  if (typeof cacheWriteTokens === "number") {
    rows.push({ key: "cacheWrite", label: "缓存写入", value: formatCount(cacheWriteTokens) });
  }
  if (typeof outputTokens === "number") {
    rows.push({ key: "output", label: "输出", value: formatCount(outputTokens) });
  }
  if (typeof outputTokens === "number" && typeof usage.elapsedMs === "number" && usage.elapsedMs > 0) {
    rows.push({
      key: "tps",
      label: "吞吐量",
      value: `${(outputTokens / (usage.elapsedMs / 1000)).toFixed(1)} tok/s`,
    });
  }
  return rows;
}

/**
 * 把一步/这一轮的 token 总量（输入 + 输出）—— 给"按钮上那个数"用。
 *
 * @param usage 真实用量
 * @returns 总量；一个数都没有时 null（界面就不显示数，而不是显示 0）
 */
export function usageTotal(usage?: StepUsage): number | null {
  if (!usage) return null;
  const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  return input + output > 0 ? input + output : null;
}

/** 合计时要逐项相加的字段（顺序无关）。 */
const SUM_KEYS = [
  "inputTokens",
  "outputTokens",
  "noCacheTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "elapsedMs",
] as const;

/**
 * 把若干步的用量加成一份（"这次对话一共用了多少"）。
 *
 * 逐项求和即可：**吞吐量不用单独合计** —— `usageRows` 会拿"总输出 ÷ 总耗时"现算，
 * 那比"各步 tok/s 取平均"更诚实（后者会被短步骤带偏）。
 *
 * @param list 各步的用量（可能一堆 undefined —— 没有用量的步很常见）
 * @returns 合计；一个数都没有时 undefined（界面就不出现这个数）
 */
export function sumUsage(list: readonly (StepUsage | undefined)[]): StepUsage | undefined {
  const out: Record<string, number> = {};
  let any = false;
  for (const u of list) {
    if (!u) continue;
    for (const key of SUM_KEYS) {
      const v = u[key];
      if (typeof v === "number") {
        out[key] = (out[key] ?? 0) + v;
        any = true;
      }
    }
  }
  return any ? (out as StepUsage) : undefined;
}

/**
 * 那个数 hover 时要说的话（**如实**：它是估的、本体不是这么算的、真值是多少）。
 *
 * @param cost 界面显示的那个数（估的）
 * @param usage 真实用量（拿不到就不提这一句 —— **不编**）
 * @returns 给 `title` 的一句话
 */
export function costNote(cost: number, usage?: StepUsage): string {
  const parts = [
    `本机版按字数估算：${cost.toFixed(2)}（可比较，但不是本体的"额度"——本机没有额度体系）`,
  ];
  if (usage) {
    const input = usage.inputTokens;
    const output = usage.outputTokens;
    if (typeof input === "number" || typeof output === "number") {
      parts.push(`真实用量：${input ?? "?"} 输入 / ${output ?? "?"} 输出 tokens`);
    }
  }
  return parts.join("；");
}
