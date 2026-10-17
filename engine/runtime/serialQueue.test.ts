import { describe, expect, it } from "vitest";

import { createSerialQueue } from "./serialQueue";

/**
 * 串行队列（**审计 P42**）。
 *
 * ## 判据为什么长这样
 *
 * 缺陷是"读-改-写两段交错 → 后者盖掉前者"。所以判据必须**同时**看到两件事：
 *   · 第二段开始**早于**第一段结束（一旦交错就红）；
 *   · 段与段之间不重入（用一个"正在跑"的旗标数重入次数）。
 * 把 `tail.then(task)` 改成直接 `task()`（去掉排队），这一组立刻红。
 */
describe("createSerialQueue", () => {
  it("⭐ 两段不交错：第二段在**第一段结束之后**才开始", async () => {
    const q = createSerialQueue();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const step = (name: string, delay: number) =>
      q(async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        log.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delay));
        log.push(`${name}:end`);
        running -= 1;
      });
    await Promise.all([step("a", 30), step("b", 1), step("c", 1)]);
    expect(maxRunning, "有两段同时在跑 —— 读-改-写会互相覆盖").toBe(1);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("排队顺序 = 调用顺序（后调的不许插队）", async () => {
    const q = createSerialQueue();
    const done: number[] = [];
    const tasks = [1, 2, 3, 4].map((n, i) =>
      q(async () => {
        await new Promise((r) => setTimeout(r, 10 - i * 2));
        done.push(n);
      }),
    );
    await Promise.all(tasks);
    expect(done).toEqual([1, 2, 3, 4]);
  });

  it("⭐ 一段失败**不堵住**后面的人（失败本身照常抛给调用方）", async () => {
    const q = createSerialQueue();
    const boom = q(async () => {
      throw new Error("第一段坏了");
    });
    const after = q(async () => "第二段照跑");
    await expect(boom).rejects.toThrow("第一段坏了");
    await expect(after).resolves.toBe("第二段照跑");
  });

  it("返回值原样穿过排队（调用方拿到的是任务自己的结果）", async () => {
    const q = createSerialQueue();
    await expect(q(async () => 42)).resolves.toBe(42);
  });
});
