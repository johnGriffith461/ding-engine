import { describe, expect, it } from "vitest";

import {
  boundedSharedHistory,
  explicitTargets,
  MAX_PARALLEL,
  parseRouteDecision,
  routePrompt,
  SHARED_HISTORY_CHARS,
  SHARED_MESSAGE_CHARS,
  type RoutableMember,
} from "./routing";

/**
 * 任务路由（V5-3 任务 3.2）：**校验过的结构化输出**，不是关键词匹配。
 *
 * 三条要挡的：① 模型编一个不存在的成员 → 拒（别把活派给不存在的人）；
 * ② 形状/人数/自相矛盾 → 拒（回落到"不协调"）；③ 显式 @ → **不叫控制器**（人已经指了）。
 * 外加有界共享历史（48K/12K）：截断**不静默**。
 */

const roster: RoutableMember[] = [
  { id: "alice", displayName: "Alice", roles: ["admin"] },
  { id: "bob", displayName: "小博", roles: ["specialist"] },
  { id: "carol", displayName: "Carol" },
];

describe("3.2 · 路由决定（校验过的 JSON）", () => {
  it("⭐ 正常决定：single / parallel 都过，members 去重", () => {
    expect(parseRouteDecision({ mode: "single", members: ["alice"], reason: "她懂这个" }, roster)).toMatchObject({
      ok: true,
      mode: "single",
      members: ["alice"],
      reason: "她懂这个",
    });
    expect(parseRouteDecision({ mode: "parallel", members: ["alice", "bob", "alice"] }, roster)).toMatchObject({
      ok: true,
      members: ["alice", "bob"],
    });
  });

  it("⭐ 模型编一个不存在的成员 → unknown-member（不把活派给不存在的人）", () => {
    const got = parseRouteDecision({ mode: "single", members: ["dave"] }, roster);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.code).toBe("unknown-member");
      expect(got.message).toContain("dave");
    }
  });

  it("形状不对 / 人数越界 / 自相矛盾：一律拒（回落「不协调」），每种有自己的 code", () => {
    expect(parseRouteDecision({ mode: "单干", members: [] }, roster)).toMatchObject({ ok: false, code: "shape" });
    expect(parseRouteDecision([1, 2], roster)).toMatchObject({ ok: false, code: "shape" });
    expect(parseRouteDecision({ mode: "parallel", members: roster.map((m) => m.id).concat(["x"]) }, roster)).toMatchObject({ ok: false });
    expect(parseRouteDecision({ mode: "parallel", members: ["alice", "bob", "carol", "alice"] }, roster)).toMatchObject({ ok: true }); /* 去重后 3 人 */
    expect(parseRouteDecision({ mode: "single", members: ["alice", "bob"] }, roster)).toMatchObject({ ok: false, code: "too-many" });
    expect(parseRouteDecision({ mode: "none", members: ["alice"] }, roster)).toMatchObject({ ok: false, code: "contradiction" });
    expect(parseRouteDecision({ mode: "sequential", members: [] }, roster)).toMatchObject({ ok: false, code: "contradiction" });
    /* 并行上限就是常量本身（改上限要同时看这里）—— 得用**互不相同**的成员去撞它 */
    const big: RoutableMember[] = Array.from({ length: MAX_PARALLEL + 1 }, (_, i) => ({ id: `m${i}`, displayName: `M${i}` }));
    const tooMany = parseRouteDecision(
      { mode: "parallel", members: big.map((m) => m.id) },
      big,
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe("too-many");
  });

  it("控制器把 JSON 包在解释里（或代码围栏里）也认；压根没有 JSON → not-json", () => {
    const wrapped = '我觉得应该这样：\n```json\n{"mode":"single","members":["bob"]}\n```\n要快。';
    expect(parseRouteDecision(wrapped, roster)).toMatchObject({ ok: true, members: ["bob"] });
    expect(parseRouteDecision("我选不出来", roster)).toMatchObject({ ok: false, code: "not-json" });
    expect(parseRouteDecision("{不是 json}", roster)).toMatchObject({ ok: false, code: "not-json" });
  });

  it("none 是合法决定（「谁都不叫」）：不带人", () => {
    expect(parseRouteDecision({ mode: "none" }, roster)).toEqual({ ok: true, mode: "none", members: [] });
  });
});

describe("3.2 · 显式 @ 绕过协调", () => {
  it("⭐ 点名了就不叫控制器：id 与显示名都认（中文名也认）", () => {
    expect(explicitTargets("@alice 你来看这个", roster)).toEqual(["alice"]);
    expect(explicitTargets("这事交给 @小博", roster)).toEqual(["bob"]);
    expect(explicitTargets("@alice @bob 你们俩一起", roster)).toEqual(["alice", "bob"]);
  });

  it("没点名 / 只是邮箱里的 @ → 空数组（那是要走控制器的）", () => {
    expect(explicitTargets("帮我看看这个", roster)).toEqual([]);
    expect(explicitTargets("发到 mailto:a@b.com", roster)).toEqual([]);
    expect(explicitTargets("@dave 你来看看", roster)).toEqual([]); /* 名册里没有这个人 → 不绕过 */
  });
});

describe("3.2 · 有界共享历史（48K / 12K）", () => {
  it("预算就是那两个门限常量（方案原文：48,000 字符、单条 12,000）", () => {
    expect(SHARED_HISTORY_CHARS).toBe(48_000);
    expect(SHARED_MESSAGE_CHARS).toBe(12_000);
  });

  it("⭐ 从最新往回取；单条超限截断**并标出来**；总数超限给「还有 N 条」", () => {
    const items = [
      { from: "alice", text: "最早的一句" },
      { from: "bob", text: "x".repeat(200) },
      { from: "alice", text: "刚才那句" },
    ];
    /* ① 单条超限、总预算够 → 截断**并标出来**（那条还在） */
    const kept = boundedSharedHistory(items, { totalChars: 400, perMessage: 60 });
    expect(kept.dropped).toBe(0);
    expect(kept.text).toContain("被截到 60 字");
    expect(kept.text).toContain("刚才那句");

    /* ② 总预算很小 → 从最早的开始丢，并如实说丢了几条（最新的那条必须在） */
    const tight = boundedSharedHistory(items, { totalChars: 40, perMessage: 60 });
    expect(tight.dropped).toBeGreaterThan(0);
    expect(tight.text).toContain("刚才那句");
    expect(tight.text).toMatch(/另有 \d+ 条较早的记录未展开/);
    expect(tight.text.length).toBeLessThanOrEqual(40 + 80); /* 上限 + 那句说明的长度余地 */
  });

  it("装得下就一字不动（也没那句说明）", () => {
    const got = boundedSharedHistory([{ from: "alice", text: "短" }]);
    expect(got.text).toBe("alice：短");
    expect(got.dropped).toBe(0);
  });
});

describe("3.2 · 控制器提示词", () => {
  it("只说三件事：可选成员、任务、输出格式（隔离调用 —— 不给工具/上下文）", () => {
    const prompt = routePrompt({ task: "把这份周报整理一下", roster, history: "alice：好的" });
    expect(prompt).toContain("alice（Alice，admin）");
    expect(prompt).toContain("小博");
    expect(prompt).toContain("把这份周报整理一下");
    expect(prompt).toContain('"mode":"single|parallel|sequential|none"');
    expect(prompt).toContain(`parallel 最多 ${MAX_PARALLEL} 人`);
    expect(prompt, "说了不该说的（给了工具？）").not.toContain("tools");
  });

  it("空名册如实说（让控制器回 none），不编一个成员", () => {
    const prompt = routePrompt({ task: "x", roster: [] });
    expect(prompt).toContain("名册是空的");
    expect(prompt).toContain("none");
  });
});
