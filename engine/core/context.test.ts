import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@shared/ipc";
import {
  KEEP_RECENT_TOKENS,
  calibrationOf,
  estimateTokens,
  omittedNote,
  planContext,
  shouldCompact,
  totalTokens,
} from "@engine/core/context";

/**
 * C3：上下文窗口的**唯一负责人**（计量 + 切分）。
 *
 * ## 为什么这些断言必须存在
 *
 * "留多少历史给模型"原来被两处各管一段：工作台先硬截断 20 条、再对剩下的按 2 万 token 切；
 * 聊天侧**全量发**。于是"该压就压"这条判定几乎永远不触发（20 条短消息远不到 2 万 token），
 * 而聊天那条路迟早顶爆上下文。
 *
 * 现在只有这一份：`planContext`。它的规矩必须被钉住 ——
 * 尤其是"**窗口永不清空**"那条（第一版把它写成"清空"，单测直接红）。
 */

const msg = (role: "user" | "assistant", content: string): ChatMessage => ({ role, content });
/** 造一条大约 `tokens` 个 token 的中文消息（中文一字≈1 token）。 */
const zh = (tokens: number) => "字".repeat(tokens);

describe("计量（唯一一份）", () => {
  it("中文按字算、英文按 4 字符算、空串是 0", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("你好abcd")).toBe(3); // 2 + ceil(4/4)
  });

  it("一组消息的总量是各自之和（判定用它）", () => {
    expect(totalTokens([msg("user", "你好"), msg("assistant", "abcd")])).toBe(3);
  });

  it("是否该压：超过额度才压（正好等于不算 —— 边界不许来回抖）", () => {
    const keep = 100;
    expect(shouldCompact([msg("user", zh(100))], keep)).toBe(false);
    expect(shouldCompact([msg("user", zh(101))], keep)).toBe(true);
  });
});

describe("planContext（唯一切分）", () => {
  const keep = 100;

  it("短历史全留下（没有要压的）", () => {
    const { older, recent } = planContext([msg("user", "甲"), msg("assistant", "乙")], keep);
    expect(older).toEqual([]);
    expect(recent.map((m) => m.content)).toEqual(["甲", "乙"]);
  });

  it("超额度时留**最新**的那批，切掉更早的（额度 100、每条约 60 → 只放得下最后一条）", () => {
    const messages = [msg("user", zh(60)), msg("assistant", zh(60)), msg("user", zh(60))];
    const { older, recent } = planContext(messages, keep);
    expect(recent.map((m) => m.content)).toEqual([zh(60)]); // 最后一条
    expect(older).toHaveLength(2); // 更早的两条
  });

  it("⭐ 切完两端拼起来不丢不重（older + recent = 原数组）", () => {
    const messages = [msg("user", zh(40)), msg("assistant", zh(40)), msg("user", zh(40)), msg("assistant", zh(40))];
    const { older, recent } = planContext(messages, keep);
    expect([...older, ...recent].map((m) => m.content)).toEqual(messages.map((m) => m.content));
  });

  it("⭐ 最后一条无论多大都留下（那是刚说的话）", () => {
    const { recent } = planContext([msg("user", zh(50)), msg("assistant", zh(9999))], keep);
    expect(recent[recent.length - 1]?.content).toBe(zh(9999));
  });

  it("⭐⭐ 窗口**永不清空**：只有一条助手消息吃满额度时也留着它", () => {
    /* 发一个空历史 = 模型以为这是全新对话，比"以助手开头"更坏。 */
    const { recent } = planContext([msg("assistant", zh(9999))], keep);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.role).toBe("assistant");
  });

  it("保留段尽量以 user 开头（把开头那几条 assistant 挪去 older）", () => {
    const messages = [msg("user", zh(40)), msg("assistant", zh(40)), msg("user", zh(40)), msg("assistant", zh(40))];
    const { older, recent } = planContext(messages, keep);
    expect(recent[0]?.role).toBe("user");
    expect(older.map((m) => m.content)).toEqual([zh(40), zh(40)]);
  });

  it("空历史给两个空数组", () => {
    expect(planContext([], keep)).toEqual({ older: [], recent: [] });
  });

  it("默认额度就是那个常量（改它要改这里，逼一次「想清楚」）", () => {
    expect(KEEP_RECENT_TOKENS).toBe(20000);
  });
});

describe("切掉时的说明（两条路共用同一句）", () => {
  it("直接丢掉说「已省略」；压成摘要说「已压缩为摘要」", () => {
    expect(omittedNote("trimmed")).toContain("更早的对话已省略");
    expect(omittedNote("summarized")).toContain("已压缩为摘要");
  });

  it("⭐ 都不许写条数（条数不是判据 —— 同样 20 条，短消息与长消息差几十倍）", () => {
    expect(omittedNote("trimmed")).not.toContain("条消息");
    expect(omittedNote("summarized")).not.toContain("条消息");
  });
});

describe("真实用量校准（补完④）", () => {
  const msg = (role: "user" | "assistant", content: string): ChatMessage => ({ role, content });

  it("系数 = 真实 ÷ 估算；拿不到真值/估不出来时给 1（**不编**）", () => {
    expect(calibrationOf(100, 150)).toBeCloseTo(1.5);
    expect(calibrationOf(100, 50)).toBeCloseTo(0.5);
    expect(calibrationOf(100, undefined)).toBe(1);
    expect(calibrationOf(100, 0)).toBe(1);
    expect(calibrationOf(0, 100)).toBe(1);
    expect(calibrationOf(Number.NaN, 100)).toBe(1);
  });

  it("⭐ 夹在 0.5–2：真实口径不该与估算差出一倍以上（差太多说明估错对象了）", () => {
    expect(calibrationOf(100, 1000)).toBe(2); // 想给 10 也不给
    expect(calibrationOf(100, 1)).toBe(0.5);
  });

  it("⭐⭐ 低估（factor>1）就少留历史、高估（factor<1）就多留 —— 只调额度，不改内容", () => {
    const messages = Array.from({ length: 4 }, (_, i) => msg(i % 2 ? "assistant" : "user", "字".repeat(60)));
    // 额度 100：不校准时留一条（后两条 120 超了）
    const plain = planContext(messages, 100);
    expect(plain.recent).toHaveLength(1);
    // 我们低估了一半（真实是估算的 2 倍）→ 实际只该留半额度的东西
    const low = planContext(messages, 100, { factor: 2 });
    expect(low.recent).toHaveLength(1);
    // 我们高估了（真实只有估算的一半）→ 可以多留
    const high = planContext(messages, 100, { factor: 0.5 });
    expect(high.recent.length).toBeGreaterThan(plain.recent.length);
  });

  it("系数非法（0/负数/NaN）时按 1 处理（不许把额度算成 0 或负数）", () => {
    const messages = [msg("user", "甲"), msg("assistant", "乙")];
    expect(planContext(messages, 100, { factor: 0 }).recent).toHaveLength(2);
    expect(planContext(messages, 100, { factor: -3 }).recent).toHaveLength(2);
    expect(planContext(messages, 100, { factor: Number.NaN }).recent).toHaveLength(2);
  });
});
