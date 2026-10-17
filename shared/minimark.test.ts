import { describe, expect, it } from "vitest";

import { parseMarkdown, toTableRows } from "@shared/minimark";

/**
 * `toTableRows` 的**多表口径**（2026-10-16，审计 P242）。
 *
 * 这条缺陷的形状是「一张看着正常的表」：`header` 只有一份，原先所有表的行都往第一张的
 * 表头下面摞，于是列数/列名不同的第二张表在 xlsx 里**串列**而不报错。
 * 判据必须带**两张不一样的表**（单表的话，对错两种实现输出一样）。
 *
 * 其余（解析、分节、`splitRow` 等）的老用例在 `src/workbench/minimark.test.ts`。
 *
 * ⚠️ 最终产品口径（多表同 sheet / 各自 sheet / 退回单列）还没定 ——
 * 这里断的是「不许把一张表的数据顶到别人的列名下面」这个保守不变量。
 */
const TWO_DIFFERENT = [
  "| 指标 | 数值 |",
  "| --- | --- |",
  "| 收入 | 120 |",
  "",
  "| 城市 | 人口 | 面积 |",
  "| --- | --- | --- |",
  "| 上海 | 2400 | 6340 |",
  "| 北京 | 2180 | 16410 |",
].join("\n");

describe("toTableRows 多张表不许合到别人的列结构里（P242）", () => {
  it("列数不同的第二张表另起一组：组间空行 + 它自己的表头", () => {
    const { header, rows } = toTableRows(parseMarkdown(TWO_DIFFERENT));
    expect(header).toEqual(["指标", "数值"]);
    expect(rows).toEqual([
      ["收入", "120"],
      [], // 组间空行：第二张表不顶着第一张的表头往上摞
      ["城市", "人口", "面积"], // 这一组自己的表头
      ["上海", "2400", "6340"],
      ["北京", "2180", "16410"],
    ]);
  });

  it("列名不同（列数一样）也另起一组", () => {
    const md = [
      "| 指标 | 数值 |",
      "| --- | --- |",
      "| 收入 | 120 |",
      "",
      "| 月份 | 销量 |",
      "| --- | --- |",
      "| 1月 | 30 |",
    ].join("\n");
    expect(toTableRows(parseMarkdown(md)).rows).toEqual([["收入", "120"], [], ["月份", "销量"], ["1月", "30"]]);
  });

  it("表头完全一致时照旧合并成一张（这条不是缺陷，别一起改坏）", () => {
    const md = ["| A | B |", "|---|---|", "| 1 | 2 |", "", "| A | B |", "|---|---|", "| 3 | 4 |"].join("\n");
    expect(toTableRows(parseMarkdown(md)).rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("不变量：任何一行数据都不长过它那一组的表头（列错位的形状）", () => {
    const { header, rows } = toTableRows(parseMarkdown(TWO_DIFFERENT));
    let groupWidth = header.length;
    let nextRowIsGroupHeader = false;
    for (const row of rows) {
      if (row.length === 0) {
        nextRowIsGroupHeader = true;
        continue;
      }
      if (nextRowIsGroupHeader) {
        groupWidth = row.length;
        nextRowIsGroupHeader = false;
        continue;
      }
      expect(row.length).toBeLessThanOrEqual(groupWidth);
    }
  });
});
