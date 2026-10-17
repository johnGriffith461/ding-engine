import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { runCommandForModel } from "./execTool";

/**
 * `run_command` 的**中止信号**（**审计 P35**）。
 *
 * ## 缺陷形状
 *
 * `runCommandForModel` 原来**没有 signal 参数**（签名是 `(input, dirs, spawnImpl)`）：
 * 点停止之后，命令**连它的孙进程一起**继续跑到超时（`timeout:0` 时跑到天荒地老），
 * 而契约 `engine/ports/executor.ts` 明写着「用户点停时，工具内部（子智能体、跑命令）也得停」。
 *
 * ## 判据（两条，缺一条就说明没接上）
 *
 * 1. 信号一响，`runCommandForModel` **很快返回**（不是等命令自己跑完）；
 * 2. 结果里 `aborted: true` 且**与 `timedOut` 分开** —— 给模型的建议不一样
 *    （超时该调大 timeout；中止是用户的意思，重试要问）。
 *
 * 把一个**睡 60 秒**的子进程交给它，`AbortController.abort()` 之后：
 * 把它改回"没有 signal"（或把 `onAbort` 摘掉），这条会**挂到 60 秒**或断言失败 ——
 * 那就是这条守卫的变异实证。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dh-exec-abort-"));
const sleepScript = path.join(tmp, "sleep.js");
fs.writeFileSync(sleepScript, "setTimeout(() => {}, 60000);\n", "utf8");

beforeEach(() => {
  /* 每个用例都用同一个脚本；没有共享状态，这里只是留个位置 */
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const dirs = () => [tmp];

describe("run_command 接中止信号（P35）", () => {
  it("⭐ 信号一响就回来，并且如实标 aborted（不是 timedOut）", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const p = runCommandForModel(
      { command: `node "${sleepScript}"`, signal: controller.signal },
      dirs(),
    );
    /* 200ms 后中止（脚本要睡 60 秒，没有这条信号它会一直等下去） */
    setTimeout(() => controller.abort(), 200);
    const r = await p;
    expect(Date.now() - started, "没有在信号之后很快回来 —— 中止没接上").toBeLessThan(20_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.aborted, "结果里必须带 aborted").toBe(true);
    expect(r.timedOut, "用户中止不是超时（两者给模型的建议不同）").toBe(false);
    expect(r.output).toContain("中止");
  }, 40_000);

  it("已经中止的信号：根本不起进程（直接拒绝并说清）", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runCommandForModel(
      { command: `node "${sleepScript}"`, signal: controller.signal },
      dirs(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("中止");
  });
});
