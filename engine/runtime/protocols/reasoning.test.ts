import { describe, expect, it } from "vitest";

import { EFFORT_LABEL, REASONING_EFFORTS, isReasoningEffort, reasoningProviderOptions } from "./reasoning";

/**
 * 思考强度的映射（2026-10-16）。
 *
 * 这一层的价值全在"**真的发得出去**"：档位 → 各家 SDK 的字段名，
 * 写错一个 key 会**静默失效**（AI SDK 按 provider 名认领 providerOptions，
 * 名字不对就当没给）。所以这里把三家的形状逐条钉住。
 */
describe("思考强度 → providerOptions", () => {
  it("三档都在，且都有中文名", () => {
    expect(REASONING_EFFORTS).toEqual(["low", "medium", "high"]);
    expect(EFFORT_LABEL.low).toBe("低");
    expect(EFFORT_LABEL.high).toBe("高");
  });

  it("openai-compatible：写成 reasoningEffort，key 是协议名而不是 provider id", () => {
    const got = reasoningProviderOptions("openai-compatible", "high");
    expect(got).toEqual({ openaiCompatible: { reasoningEffort: "high" } });
    /* ⚠️ 这条防"顺手写成别的名字"：真跑时 SDK 报过弃用警告，正确写法是驼峰的那个（见 reasoning.ts） */
    expect(Object.keys(got ?? {})).toEqual(["openaiCompatible"]);
  });

  it("anthropic：要的是 token 预算，不是档位名", () => {
    const low = reasoningProviderOptions("anthropic", "low");
    const high = reasoningProviderOptions("anthropic", "high");
    expect(low).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } });
    expect(high).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } } });
  });

  it("google：thinkingConfig.thinkingBudget", () => {
    expect(reasoningProviderOptions("google", "medium")).toEqual({
      google: { thinkingConfig: { thinkingBudget: 4096 } },
    });
  });

  it("⭐ 没选档位 → **什么都不发**（今天的行为与昨天一模一样）", () => {
    expect(reasoningProviderOptions("openai-compatible", undefined)).toBeUndefined();
    expect(reasoningProviderOptions("anthropic", undefined)).toBeUndefined();
    expect(reasoningProviderOptions("google", undefined)).toBeUndefined();
  });

  it("认不出来的值一律当没选（磁盘/参数来的脏值不许把它带进请求）", () => {
    expect(isReasoningEffort("ULTRA")).toBe(false);
    expect(isReasoningEffort(3)).toBe(false);
    expect(isReasoningEffort(undefined)).toBe(false);
    expect(isReasoningEffort("medium")).toBe(true);
    // 运行时即使拿到脏值（类型系统之外），也不能发出一个野生档位
    expect(reasoningProviderOptions("openai-compatible", "ULTRA" as never)).toBeUndefined();
  });
});
