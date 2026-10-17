import { describe, expect, it } from "vitest";

import { allProviders } from "./providers";
import { findModel } from "./models";

/**
 * **provider 表与目录表必须一致**（**审计 P233**）。
 *
 * ## 缺陷形状
 *
 * `providers.ts` 的 `models` 列表就是界面上"这个通道能选哪些模型"的来源；
 * 而 `findModel` 是从快照生成的目录表（`models.generated.ts`）里查。
 * 两者**从来没有一条一致性检查**，实测已经漂了（登记在下面的 `KNOWN_GAPS`）——
 * 登记时（2026-10-16）跑出来 7 条，`gemini-3.5-flash` / `gemini-3.1-pro-preview` 只是审计点名的那两条。
 *
 * 后果不是"少一个模型"这么轻：用户选得到它 → `findModel` 返回 `undefined` →
 * 上下文按保守默认 20000 算（真实窗口大得多）、单价未知 → 成本账本把这笔花费
 * 并进「(未登记模型)」那一行，来源与单价永远追不回来。
 *
 * ## 这一条的口径：**棘轮**（已知的先记账，不许再多）
 *
 * 数据本身要改 `scripts/vendor-models.mjs` 的 SELECTION 与 `models.snapshot.json`
 * （都不在本工单的文件范围里），所以这里不假装已经修好，而是：
 *   ① 把**已知**的每一处写在下面；
 *   ② 出现**新的**不一致立刻红 —— 那说明有人往 provider 表里加了模型却没进目录。
 *
 * ⚠️ 名单里的 `deepseek/deepseek-reasoner` 有一点特别：它同时是 `budget.test.ts`
 * 里"**未登记模型**零漂移"那条断言的样本。所以"把它登记进目录"与"保留一个未登记样本"
 * 是两件事，不要顺手删。
 */
const KNOWN_GAPS = new Set([
  "deepseek/deepseek-reasoner",
  "apihub/deepseek-v3",
  "apihub/claude-3-5-sonnet",
  "qianwen/qwen-max",
  "qianwen/qwen-turbo",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-pro-preview",
]);

describe("provider 表 vs 目录表（P233）", () => {
  it("⭐ provider 表里可选的模型，目录表都得认（新漂一条就红）", () => {
    const missing: string[] = [];
    for (const p of allProviders()) {
      for (const m of p.models) {
        if (!findModel(m)) missing.push(`${p.id}/${m}`);
      }
    }
    expect(
      missing.sort(),
      "provider 表里这些模型目录表查不到 —— 界面选得到、单价与窗口却按「未登记」算",
    ).toEqual([...KNOWN_GAPS].sort());
  });

  it("已知的那些**确实还没修**（数据修好之后这条会红，那时把 KNOWN_GAPS 里对应的删掉）", () => {
    /* 反向断言：条目一旦被补进目录表，这条会红 —— 逼着把豁免删掉，不留空转的账 */
    for (const key of KNOWN_GAPS) {
      const bare = key.slice(key.indexOf("/") + 1);
      expect(findModel(bare), `${key} 已经被补进目录表了 —— 从 KNOWN_GAPS 里删掉它`).toBeUndefined();
    }
  });
});
