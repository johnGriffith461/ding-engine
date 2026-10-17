import { describe, expect, it } from "vitest";

import { extractCharts, parseOutline } from "@shared/reader";

/**
 * AI 阅读里**围栏口径**的判据（2026-10-16，审计 P243）。
 *
 * 为什么单独一份、以及为什么长这样：这条缺陷的形状是「同一份内容里两处口径相反」——
 * `parseOutline` 跳过代码围栏里的 `#`，`extractCharts` 却把围栏里的示例表格与示例图片
 * 当成这份内容真的有的图表（数量与页号都会进界面）。所以判据必须是**真假对照**：
 * 只喂围栏内容的话，「一张都没抽到」与「压根没实现」输出同一个东西，测不出对错。
 *
 * 其余（`findHits` / 折页 / 磁盘收窄等）的老用例在 `src/workbench/reader.test.ts`，
 * 这份文件只管围栏这一步。
 */
const FENCED_AND_REAL = [
  "# 季度报告",
  "",
  "下面这段是教人写表格的示例，别当数据：",
  "",
  "```markdown",
  "| 假指标 | 假数值 |",
  "| --- | --- |",
  "| 假的 | 0 |",
  "",
  "![假图](fake.png)",
  "```",
  "",
  "| 真指标 | 真数值 |",
  "| --- | --- |",
  "| 真的 | 120 |",
  "",
  "![真图](real.png)",
].join("\n");

describe("extractCharts 不看代码围栏 → 已改成同一套围栏口径（P243）", () => {
  it("围栏里像图表、围栏外是真图表：只抽到真的那条", () => {
    const got = extractCharts(FENCED_AND_REAL);
    expect(got.tables).toHaveLength(1);
    expect(got.tables[0]?.header).toEqual(["真指标", "真数值"]);
    expect(got.tables[0]?.rows).toBe(1);
    // 围栏里的 ![假图](fake.png) 也是代码，不是这张内容的图
    expect(got.images).toBe(1);
  });

  it("整份内容只有围栏里的示例时：表格与图片都是空的（界面自己说「没有表格或图片」）", () => {
    const onlyFence = ["```", "| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "![图](x.png)", "```"].join("\n");
    const got = extractCharts(onlyFence);
    expect(got.tables).toEqual([]);
    expect(got.images).toBe(0);
  });

  it("围栏收尾之后的内容照旧算数（别把 `inFence` 卡死成 true）", () => {
    const text = [
      "```",
      "# 围栏里的假标题",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "```",
      "",
      "# 真标题",
      "",
      "| c | d |",
      "| --- | --- |",
      "| 3 | 4 |",
      "",
      "![真图](r.png)",
    ].join("\n");
    expect(parseOutline(text).map((o) => o.text)).toEqual(["真标题"]);
    const got = extractCharts(text);
    expect(got.tables.map((t) => t.header)).toEqual([["c", "d"]]);
    expect(got.images).toBe(1);
  });
});
