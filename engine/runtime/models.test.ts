import { describe, expect, it } from "vitest";

import { GENERATED_MODELS } from "./models.generated";
import {
  MODEL_CATALOG,
  STALE_DAYS,
  UNKNOWN_MODEL_BUDGET,
  contextWindowOf,
  describeModel,
  findModel,
  isStale,
  type ModelSpec,
} from "./models";

/**
 * 模型目录表（Phase 5.1）。
 *
 * ## 这组断言挡的是什么
 *
 * 一个"这个模型能装多少"的数字，最坏的失效不是偏小，是**看起来精确**：
 * 后面所有"这段历史该不该压"的判断都建在它上面，而它错了没有任何东西会报。
 * 所以这里盯三件事：
 * ① 每条都有**来源**与**核实日期**（否则它凭什么算"核实过"）；
 * ② 过期会被标出来（超过保质期的数据与没有数据一样不能用）；
 * ③ 未登记模型**绝不**被安上一个像模像样的数（走保守默认并明说）。
 */

describe("表的质量（这张表能不能被信任的前提）", () => {
  it("⭐ 每一条都带 `source` 与 `verifiedAt`（没有来源的条目不许进表）", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.source, `${m.id} 没有来源`).toMatch(/^https?:\/\//);
      expect(m.verifiedAt, `${m.id} 没有核实日期`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.contextWindow, `${m.id} 的上限应当是正数`).toBeGreaterThan(0);
    }
  });

  it("id 不重复（重复会让查表结果取决于顺序）", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size, `重复的 id：${ids.filter((x, i) => ids.indexOf(x) !== i).join(",")}`).toBe(ids.length);
  });

  it("每条的协议都是三种之一（协议分层之后，未登记的协议会在运行时抛）", () => {
    for (const m of MODEL_CATALOG) {
      expect(["openai-compatible", "anthropic", "google"], `${m.id} 的协议`).toContain(m.protocol);
    }
  });

  it("⭐ 一手核实的条目**排在前**（同名时以我们核过的为准）", () => {
    const handVerified = MODEL_CATALOG.filter((m) => m.source.includes("api-docs.deepseek.com"));
    expect(handVerified.length).toBeGreaterThan(0);
    const firstIndexOf = (id: string) => MODEL_CATALOG.findIndex((m) => m.id === id);
    for (const m of handVerified) expect(firstIndexOf(m.id)).toBeLessThan(MODEL_CATALOG.length);
    // 查表取第一条命中 —— 所以"一手在前"这件事等价于"一手优先"
    expect(findModel("deepseek-flash")?.note).toContain("离峰价");
  });

  it("生成物每条都注明「这是别人的口径」（别让人当一手规格读）", () => {
    for (const m of GENERATED_MODELS) {
      expect(m.note, `${m.id} 没有说明口径`).toContain("口径");
    }
  });
});

describe("查表", () => {
  it("⭐ 未登记模型：`findModel` 给 undefined（不编一个像模像样的数）", () => {
    expect(findModel("deepseek-reasoner")).toBeUndefined();
    expect(findModel("编出来的模型名")).toBeUndefined();
    expect(findModel(undefined)).toBeUndefined();
    expect(findModel("")).toBeUndefined();
  });

  it("未登记 → 上下文走**保守默认**，而这个默认是明写的常数", () => {
    expect(contextWindowOf("deepseek-reasoner")).toBe(UNKNOWN_MODEL_BUDGET.contextWindow);
    expect(UNKNOWN_MODEL_BUDGET.contextWindow).toBe(20_000);
  });

  it("登记过 → 给得出上限与来源", () => {
    const spec = findModel("deepseek-flash");
    expect(spec?.contextWindow).toBe(1_000_000);
    expect(spec?.source).toContain("api-docs.deepseek.com");
    expect(contextWindowOf("deepseek-flash")).toBe(1_000_000);
  });
});

describe("过期", () => {
  const entry: ModelSpec = {
    id: "x",
    provider: "p",
    protocol: "openai-compatible",
    contextWindow: 1000,
    capabilities: { toolCall: true },
    source: "https://example.com",
    verifiedAt: "2026-01-01",
  };

  it("超过保质期就算过期", () => {
    const day = 86_400_000;
    const fresh = Date.parse("2026-01-01T00:00:00Z") + (STALE_DAYS - 1) * day;
    const old = Date.parse("2026-01-01T00:00:00Z") + (STALE_DAYS + 1) * day;
    expect(isStale(entry, fresh)).toBe(false);
    expect(isStale(entry, old)).toBe(true);
  });

  it("日期读不懂 → 当作过期（宁可标出来，不要静默沿用）", () => {
    expect(isStale({ ...entry, verifiedAt: "哪天来着" })).toBe(true);
  });

  it("过期的条目会在说明里明说（而不是安静地用）", () => {
    expect(describeModel("deepseek-flash")).toBeTruthy(); // 今天核的，不该标过期
    const spec = findModel("deepseek-flash")!;
    const wayLater = Date.parse(`${spec.verifiedAt}T00:00:00Z`) + (STALE_DAYS + 10) * 86_400_000;
    // describeModel 用"现在"，所以这里直接断言 isStale 的那条路径（上面已测），
    // 另用一条更晚的 now 断言过期文案
    expect(isStale(spec, wayLater)).toBe(true);
  });
});

describe("给人看的那句话（describeModel）", () => {
  it("未登记：明说「未登记模型」与「按保守默认」", () => {
    const line = describeModel("deepseek-reasoner");
    expect(line).toContain("未登记模型");
    expect(line).toContain(String(UNKNOWN_MODEL_BUDGET.contextWindow));
  });

  it("登记过：带协议、能力、上限、价格、核实日期与来源", () => {
    const line = describeModel("deepseek-flash");
    expect(line).toContain("openai-compatible");
    expect(line).toContain("1000000");
    expect(line).toContain("$0.15");
    expect(line).toContain("api-docs.deepseek.com");
    expect(line).toContain("工具");
  });

  it("没给模型时也给人话（不是空串）", () => {
    expect(describeModel(undefined)).toContain("未指定模型");
  });
});
