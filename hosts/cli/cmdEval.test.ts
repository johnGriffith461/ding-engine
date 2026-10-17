import { describe, expect, it, vi } from "vitest";

import { parseArgv } from "./args";
import { baselineUpdateAllowed, cmdEval } from "./cmdEval";

/**
 * `ding eval` 的基线棘轮（2026-10-16，审计 P160 / NEW-N3-21）。
 *
 * 基线是"**通过率与用例总数都不许往下掉**"的那个参照（`engine/eval/eval.test.ts` 会拿
 * `report.total >= baseline.total` 当门）。而 `--update-baseline` 把报告原样覆盖进
 * 同一份 `engine/eval/baseline.json`：用**子集**命令跑一次
 * （`ding eval 纯对话 --update-baseline`），基线就变成 `total: 9 / byCategory 只剩一类`，
 * 此后删掉另外 54 条用例也不会有任何门变红 —— 棘轮被削掉。
 *
 * 判据：只有**全量**才允许写基线；子集命令当场报错退出 2（且**不许真去跑那套评测**）。
 */
describe("ding eval --update-baseline（P160）", () => {
  it("全量允许；给了类别一律拒，并说清为什么", () => {
    expect(baselineUpdateAllowed(undefined)).toEqual({ ok: true });
    const got = baselineUpdateAllowed("纯对话");
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.message).toContain("纯对话");
      expect(got.message).toContain("基线");
    }
  });

  it("⭐ 子集 + --update-baseline：退出码 2，且**没跑**那套评测（否则基线真被写坏）", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const errs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      errs.push(String(chunk));
      return true;
    });
    try {
      const code = await cmdEval(parseArgv(["eval", "纯对话", "--update-baseline"]));
      expect(code).toBe(2);
      expect(errs.join("")).toContain("--update-baseline 只能在全量跑时用");
      // 拒得早：一行用例报告都不该打出来（打印报告就说明它已经跑过那套评测了）
      expect(writes.join("")).not.toContain("通过率");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
