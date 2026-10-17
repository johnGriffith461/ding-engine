import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { LogRecord } from "../../engine/core/events";
import { renderRecords } from "./renderRecords";

/**
 * 渲染只有一份（2026-10-16，审计 P217 / NEW-N7-26）。
 *
 * 这文件头一直写着"再写一份怎么显示必然漂"，而事实上**就是有两份**：
 * `ding.ts` 的 `render()` 与这里的 `renderRecords()`，且 `ding recipe run`
 * 用的是后者 —— 差别里最要命的一条是**它完全不打 `view.error`**：
 * 一轮报错的结果在 `ding recipe run` 里只留下正文，用户看到"跑完了"，
 * 而那一轮其实失败了。
 *
 * 这里的判据是"**错误必须出现在输出里**"，加上一条源码守卫钉住
 * "渲染不许再有第二份"（谁在 `ding.ts` 里重新写一个 `render()`，守卫就红）。
 */

/** 造几条落盘形态的记录（`seq`/`at` 是存储编的，这里给固定值）。 */
const ask = (text: string): LogRecord => ({
  seq: 1,
  at: 1,
  type: "request",
  requestId: "r1",
  provider: "strata",
  model: "m",
  messages: [{ role: "user", content: text }],
  tools: [],
});
const boom = (message: string): LogRecord => ({ seq: 2, at: 2, type: "error", requestId: "r1", message });
const call = (toolCallId: string, toolName: string): LogRecord => ({
  seq: 2,
  at: 2,
  type: "tool-call",
  requestId: "r1",
  toolCallId,
  toolName,
  input: {},
});
const result = (toolCallId: string, toolName: string, output: unknown): LogRecord => ({
  seq: 3,
  at: 3,
  type: "tool-result",
  requestId: "r1",
  toolCallId,
  toolName,
  output,
});
const done = (usage: { inputTokens?: number; outputTokens?: number }): LogRecord => ({
  seq: 4,
  at: 4,
  type: "done",
  requestId: "r1",
  usage,
});

describe("renderRecords —— 单一渲染口径", () => {
  it("⭐ 一轮带 error：错误出现在输出里（老 renderRecords 把它吞了）", () => {
    const text = renderRecords([ask("跑一下"), boom("连接被对端切断")]);
    expect(text, "这一轮的 error 被吞了 —— 用户会以为跑完了").toContain("连接被对端切断");
    expect(text, "用户那一轮的问题没打出来").toContain("跑一下");
  });

  it("⏸ / ✓ / ✗ 三种留痕标记都在（原来与 ding.ts 的口径不一致）", () => {
    const text = renderRecords([ask("看文件"), call("c1", "read_file"), result("c1", "read_file", "ok"), done({ inputTokens: 3, outputTokens: 4 })]);
    expect(text).toContain("✓");
    expect(text).toContain("用量");
    expect(text).toContain("↑3");
  });

  it("空的记录：只回一个换行，不抛", () => {
    expect(renderRecords([])).toBe("\n");
  });
});

/**
 * ⭐ 守卫：渲染**只有一处实现**。
 *
 * 判据是源码级的两条：
 *   ① 两个宿主（`ding.ts` / `cmdRecipe.ts`）都从 `./renderRecords` 取渲染；
 *   ② `ding.ts` 里不再有自己那份 `function render(`。
 * 退回修复（在 `ding.ts` 里重新写一份 render）→ ②立刻红。
 */
describe("守卫：渲染口径不许有第二份（P217 的落点）", () => {
  const read = (rel: string): string => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

  it("ding.ts 与 cmdRecipe.ts 都走 renderRecords，且 ding.ts 没有自己的 render()", () => {
    const ding = read("hosts/cli/ding.ts");
    const recipe = read("hosts/cli/cmdRecipe.ts");
    expect(ding, "ding.ts 没用共用的渲染").toContain('from "./renderRecords"');
    expect(recipe, "cmdRecipe.ts 没用共用的渲染").toContain('from "./renderRecords"');
    expect(/function\s+render\s*\(/.test(ding), "ding.ts 里又长出一份自己的 render()").toBe(false);
    // 投影的唯一出口是 renderRecords：ding.ts 不该再直接 import splitTurns 自己排版
    expect(/import\s*\{[^}]*splitTurns/.test(ding), "ding.ts 又自己拿投影排版了").toBe(false);
  });
});
