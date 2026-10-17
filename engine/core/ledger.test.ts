import { describe, expect, it } from "vitest";

import { formatTotal, ledgerOf, localDay, rollup } from "./ledger";
import type { LogRecord } from "./events";

/**
 * 成本账本（Phase 3.3）。
 *
 * ## 这组断言真正防的是什么
 *
 * 一个"花了多少"的数字，最坏的失效不是偏小，是**看起来精确**。
 * 所以这里每一组断言都在问同一件事：**没拿到的数，有没有被悄悄补上**。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/** 造一轮（request + done）。 */
function turn(n: number, usage?: { inputTokens?: number; outputTokens?: number }, model = "deepseek-chat"): LogRecord[] {
  return [
    {
      seq: n,
      at: T(n),
      type: "request",
      requestId: `r${n}`,
      provider: "deepseek",
      model,
      messages: [{ role: "user", content: "x" }],
    },
    { seq: n + 1, at: T(n + 1), type: "done", requestId: `r${n}`, ...(usage ? { usage } : {}) },
  ] as unknown as LogRecord[];
}

describe("成本账本 · 入账", () => {
  it("⭐ 只记 provider 上报过的轮次（没有 usage 的那一轮不入账，也不记 0）", () => {
    const records = [...turn(1, { inputTokens: 100, outputTokens: 20 }), ...turn(3)];
    const book = ledgerOf(records, "cli-1");
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ model: "deepseek-chat", usage: { inputTokens: 100, outputTokens: 20 } });
  });

  it("provider/model 从那一轮的 `request` 配过来（不是猜的）", () => {
    const book = ledgerOf(turn(1, { inputTokens: 5, outputTokens: 5 }, "deepseek-reasoner"), "cli-1");
    expect(book[0]).toMatchObject({ provider: "deepseek", model: "deepseek-reasoner", sessionId: "cli-1" });
  });

  it("配不上 request 的 done（日志被截过）**照样入账**，只是 provider/model 空着", () => {
    const orphan = [{ seq: 9, at: T(9), type: "done", requestId: "r404", usage: { inputTokens: 7, outputTokens: 1 } }] as unknown as LogRecord[];
    const book = ledgerOf(orphan, "cli-1");
    // 用量是 provider 真报过的数 —— 丢掉它会让总数偏小，那比"少一个标签"坏得多
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ model: "", usage: { inputTokens: 7, outputTokens: 1 } });
    // 汇总时它落到"未登记模型"那一行，一眼能看出是缺标签而不是缺钱
    expect(rollup(book, "model")[0]?.key).toBe("(未登记模型)");
  });

  it("缓存明细一并入账（provider 给了就带上）", () => {
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [] },
      {
        seq: 2,
        at: T(2),
        type: "done",
        requestId: "r1",
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, noCacheTokens: 20 },
      },
    ] as unknown as LogRecord[];
    expect(ledgerOf(records, "s")[0]?.usage).toMatchObject({ cacheReadTokens: 80, noCacheTokens: 20 });
  });
});

describe("成本账本 · 汇总", () => {
  const entries = [
    ...ledgerOf(turn(1, { inputTokens: 100, outputTokens: 10 }, "a"), "s1"),
    ...ledgerOf(turn(3, { inputTokens: 200, outputTokens: 20 }, "b"), "s1"),
    ...ledgerOf(turn(5, { inputTokens: 50, outputTokens: 5 }, "a"), "s2"),
  ];

  it("⭐ 逐项求和（合计 = 各轮相加，不是取平均）", () => {
    const rows = rollup(entries, "session");
    const s1 = rows.find((r) => r.key === "s1");
    const s2 = rows.find((r) => r.key === "s2");
    expect(s1).toMatchObject({ turns: 2, totalTokens: 330 }); // 100+200 / 10+20
    expect(s1?.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    expect(s2).toMatchObject({ turns: 1, totalTokens: 55 });
    // 两行加起来 = 全部入账
    expect((s1?.totalTokens ?? 0) + (s2?.totalTokens ?? 0)).toBe(385);
  });

  it("按模型汇总：同名模型跨会话合并，未登记模型的轮次标出来", () => {
    const rows = rollup([...entries, ...ledgerOf(turn(7, { inputTokens: 1, outputTokens: 1 }, ""), "s3")], "model");
    // 按 token 降序：b(220) > a(110) > 未登记(2)
    expect(rows.map((r) => r.key)).toEqual(["b", "a", "(未登记模型)"]);
  });

  it("按天汇总用**本地时区**（用户按自己的日期理解「今天花了多少」）", () => {
    /*
     * ⚠️ 这条原来是 `expect(localDay(T(0))).toBe(localDay(T(0)))` —— 左右是**同一个调用**，
     * 把 `localDay` 改成 UTC 或彻底算错都照样过（审计 G102：用例名承诺钉"本地时区"，
     * 实际全仓没有一条断言钉它）。现在用本地构造的时刻去对本地渲染出的日期。
     */
    const localMidnightish = new Date(2026, 0, 2, 0, 30, 0).getTime();
    expect(localDay(localMidnightish)).toBe("2026-01-02");
    /* 本机时区的"日"与 UTC 不同时（绝大多数时区如此），再钉一次"不是 UTC 日" */
    const utcDay = new Date(localMidnightish).toISOString().slice(0, 10);
    if (utcDay !== "2026-01-02") expect(localDay(localMidnightish)).not.toBe(utcDay);

    const rows = rollup(entries, "day");
    expect(rows).toHaveLength(1); // 三条都在同一天（测试时间戳相邻）
    expect(rows[0]?.turns).toBe(3);
  });

  it("⭐ 未登记模型要标出来（别让人以为那个价格是核过的）", () => {
    const info = (id: string) => (id === "known" ? { registered: true, priceIn: 1, priceOut: 2 } : { registered: false });
    const rows = rollup([...ledgerOf(turn(1, { inputTokens: 10, outputTokens: 5 }, "known"), "s1"), ...ledgerOf(turn(3, { inputTokens: 10, outputTokens: 5 }, "mystery"), "s2")], "model", (k) => k, info);
    const known = rows.find((r) => r.key === "known")!;
    const mystery = rows.find((r) => r.key === "mystery")!;
    expect(known.unregistered).toBeUndefined();
    expect(mystery.unregistered).toBe(true);
    expect(formatTotal(mystery)).toContain("未登记模型");
  });

  it("⭐ 估算花费：只按目录单价算，且**标明是估的**", () => {
    const info = () => ({ registered: true, priceIn: 1, priceOut: 2 });
    const [row] = rollup(ledgerOf(turn(1, { inputTokens: 1_000_000, outputTokens: 500_000 }, "known"), "s1"), "model", (k) => k, info);
    // 100 万输入 × $1 + 50 万输出 × $2 = 1 + 1 = $2
    expect(row.estimatedCost).toBe(2);
    expect(formatTotal(row)).toContain("按目录单价估");
  });

  it("拿不到单价就**不给数**（不编一个像账单的 0）", () => {
    const info = () => ({ registered: false });
    const [row] = rollup(ledgerOf(turn(1, { inputTokens: 100, outputTokens: 10 }, "mystery"), "s1"), "model", (k) => k, info);
    expect(row.estimatedCost).toBeUndefined();
    expect(formatTotal(row)).not.toContain("$");
  });

  it("不给目录查询时只报 provider 报过的 token（那部分一定不编）", () => {
    const [row] = rollup(ledgerOf(turn(1, { inputTokens: 100, outputTokens: 10 }, "x"), "s1"), "model");
    expect(row.totalTokens).toBe(110);
    expect(row.estimatedCost).toBeUndefined();
    expect(row.unregistered).toBeUndefined();
  });

  it("缺失的字段写成 `-`，**不写成 0**（0 是真没花，- 是 provider 没说）", () => {
    const line = formatTotal({ key: "s", label: "s", turns: 1, usage: { outputTokens: 5 }, totalTokens: 5 });
    expect(line).toContain("↑-");
    expect(line).toContain("↓5");
  });
});

/**
 * 成本分摊（V5-3 任务 3.4）：**三层身份** + 按成员汇总（U8-4「花钱按人算得清」）。
 *
 * 关键口径：**账本不新记一份"谁花的"** —— 它取自那条 `request` 记录的 actor（C5）。
 * 另记一份的话，钱与人对不上时会分不清信哪份。account / end_user 两层由宿主注入
 * （会话归属 / 渠道发送者），不进记录（加记录字段是一次契约变更，见 ADR-0010 的门）。
 */
describe("3.4 · 成本分摊（按人算得清）", () => {
  /** 造一轮「某人花的钱」（request 记录带 actor）。 */
  function turnBy(n: number, actorId: string, usage: { inputTokens: number; outputTokens: number }, endUser?: string): LogRecord[] {
    return [
      {
        seq: n,
        at: T(n),
        type: "request",
        requestId: `r${n}`,
        provider: "deepseek",
        model: "deepseek-chat",
        messages: [{ role: "user", content: "x" }],
        actor: { id: actorId, kind: "user" },
      },
      {
        seq: n + 1,
        at: T(n + 1),
        type: "done",
        requestId: `r${n}`,
        usage,
        actor: { id: "main", kind: "agent" },
        ...(endUser ? {} : {}),
      },
    ] as unknown as LogRecord[];
  }

  it("⭐ 按成员汇总：每人一行，条数与 token 各自算对（不混账）", () => {
    const records = [
      ...turnBy(1, "alice", { inputTokens: 100, outputTokens: 10 }),
      ...turnBy(10, "bob", { inputTokens: 20, outputTokens: 2 }),
      ...turnBy(20, "alice", { inputTokens: 300, outputTokens: 30 }),
    ];
    const entries = ledgerOf(records, "task-1");
    const byMember = rollup(entries, "member");
    const map = new Map(byMember.map((r) => [r.key, r]));
    expect([...map.keys()].sort()).toEqual(["alice", "bob"]);
    expect(map.get("alice")?.turns).toBe(2);
    expect(map.get("alice")?.usage).toMatchObject({ inputTokens: 400, outputTokens: 40 });
    expect(map.get("bob")?.usage).toMatchObject({ inputTokens: 20, outputTokens: 2 });
    /* 总额 = 各人之和（账要平） */
    const total = byMember.reduce((n, r) => n + (r.usage?.inputTokens ?? 0), 0);
    expect(total).toBe(420);
  });

  it("老记录（actor=legacy）落「未署名」那一格 —— 不硬塞给某个人", () => {
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [{ role: "user", content: "x" }] },
      { seq: 2, at: T(2), type: "done", requestId: "r1", usage: { inputTokens: 5, outputTokens: 1 } },
    ] as unknown as LogRecord[];
    const byMember = rollup(ledgerOf(records, "s"), "member");
    /* 老记录读回 actor=legacy；那一格如实叫 legacy（不是"未署名" —— 它有自己的名字） */
    expect(byMember.map((r) => r.key)).toEqual(["legacy"]);
  });

  it("⭐ 三层身份：account（空间/账目）与 end_user（渠道发送者）由宿主注入", () => {
    const records = [...turnBy(1, "alice", { inputTokens: 10, outputTokens: 1 })];
    const entries = ledgerOf(records, "task-1", { accountId: "local", endUserId: "wecom:zhangsan" });
    expect(entries[0]?.accountId).toBe("local");
    expect(entries[0]?.endUserId).toBe("wecom:zhangsan");
    expect(rollup(entries, "account").map((r) => r.key)).toEqual(["local"]);
    expect(rollup(entries, "endUser").map((r) => r.key)).toEqual(["wecom:zhangsan"]);

    /* 不给这两格：如实落"未归属账目 / 本机对话"（不编一个值） */
    const bare = ledgerOf(records, "task-1");
    expect(rollup(bare, "account").map((r) => r.key)).toEqual(["(未归属账目)"]);
    expect(rollup(bare, "endUser").map((r) => r.key)).toEqual(["(本机对话)"]);
  });

  it("cache tokens 分列：sumUsage 把缓存读 / 写分开算（不进 input 那份重复计）", () => {
    const records = [
      {
        seq: 1,
        at: T(1),
        type: "request",
        requestId: "r1",
        provider: "p",
        model: "m",
        messages: [{ role: "user", content: "x" }],
        actor: { id: "alice", kind: "user" },
      },
      {
        seq: 2,
        at: T(2),
        type: "done",
        requestId: "r1",
        usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 },
      },
    ] as unknown as LogRecord[];
    const usage = rollup(ledgerOf(records, "s"), "member")[0]?.usage;
    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 });
  });
});
