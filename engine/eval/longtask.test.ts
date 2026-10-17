import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import { startFakeProvider, type EvalReply } from "./fakeProvider";
import type { TurnEvent } from "../runtime/loop";
import type { Engine } from "../index";

/**
 * 长任务评测（Phase 10.6）。
 *
 * 方案原文的验收：**"任务中途杀进程可续跑；成本不失控"**，另要"验证断点恢复、成本控制、
 * 失败模式（含崩溃注入与进程 chaos）"。
 *
 * ## 为什么单开一个文件，而不是塞进 `cases.ts`
 *
 * `cases.ts` 里的格子是"一条用例 = 一个回合脚本"，长度受脚本数组限制；
 * 而这一组要的是**装置级**的东西：50+ 步、上游半路断线、进程重启后接着跑、成本封顶。
 * 它们各自需要不同的收尾与断言方式 —— 硬塞进那个形状会为了"看起来统一"而丢掉判据。
 *
 * ## 四条各自挡什么
 *
 * | 格子 | 挡的坏 |
 * |---|---|
 * | 50+ 步 | 步数上限/循环在某个体量上悄悄不收敛（跑到一半就"完成"了） |
 * | 崩溃注入 | 上游半路没了时**挂住不返回**（用户看到永远转圈） |
 * | 断点恢复 | 重启用的是**新**引擎时状态丢一半（历史/待决/账本对不上） |
 * | 成本封顶 | 长任务把账本乘上几十倍（每一轮都重发全部历史 → 静默烧钱） |
 */

/** 一次性的临时工作目录（工具能碰的范围）。 */
function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* 收尾失败不影响判定 */
    }
  }
});

/** 起一个假 provider 并把 `strata` 指过去。 */
async function withProvider(replies: readonly EvalReply[], parentTurns: readonly string[]) {
  const provider = await startFakeProvider(replies, parentTurns);
  const prevBase = process.env.STRATA_BASE_URL;
  const prevKey = process.env.STRATA_API_KEY;
  process.env.STRATA_BASE_URL = provider.url;
  process.env.STRATA_API_KEY = "eval-key";
  cleanups.push(() => {
    if (prevBase === undefined) delete process.env.STRATA_BASE_URL;
    else process.env.STRATA_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.STRATA_API_KEY;
    else process.env.STRATA_API_KEY = prevKey;
  });
  cleanups.push(() => void provider.close());
  return provider;
}

/** 建一个引擎（带临时数据目录），并登记收尾。 */
async function engineOn(workDir: string, storeDir: string): Promise<Engine> {
  const built = await buildEngine([workDir], storeDir);
  cleanups.push(() => built.close());
  return built.engine;
}

/**
 * 同上，但把 `close` 也交出来。
 *
 * ⚠️ ③「断点恢复」要的是**模拟重启**：必须先关掉第一段的句柄再开第二个，
 * 否则测的是"同一进程里两个 SQLite 连接并开"（审计 G81）—— 那与重启是两回事，
 * WAL / 崩溃恢复那两条最要紧的失效它一条都碰不到。
 */
async function engineHandle(workDir: string, storeDir: string): Promise<{ engine: Engine; close: () => void }> {
  const built = await buildEngine([workDir], storeDir);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    built.close();
  };
  cleanups.push(close);
  return { engine: built.engine, close };
}

/** 跑一轮并收集事件。 */
async function run(
  engine: Engine,
  sessionId: string,
  text: string,
  maxSteps: number,
): Promise<{ ok: boolean; error?: string; aborted: boolean; events: TurnEvent[] }> {
  const events: TurnEvent[] = [];
  const out = await engine.run({
    sessionId,
    provider: "strata",
    model: "deepseek-flash",
    messages: [{ role: "user", content: text }],
    mode: "全部允许",
    useTools: true,
    maxSteps,
    onEvent: (e) => events.push(e),
  });
  return { ok: out.ok, ...(out.error ? { error: out.error } : {}), aborted: out.aborted, events };
}

describe("长任务评测（Phase 10.6）", () => {
  it("① 50+ 步的长任务：走得完、步数对得上、每步都留痕", async () => {
    const workDir = tmp("dh-long-work-");
    const storeDir = tmp("dh-long-store-");
    cleanups.push(() => fs.rmSync(workDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(storeDir, { recursive: true, force: true }));

    /*
     * 脚本：前 50 步每步列一次目录，第 51 次收尾。
     * 注意**不能 50 步都吐同一帧** —— 那会让假 provider 与真模型的行为不同
     * （真模型看到重复的工具结果会改口）。所以工具名在两步之间交替，
     * 模拟"它在真的往前走"。
     */
    const steps = 50;
    const replies: EvalReply[] = [];
    for (let i = 0; i < steps; i += 1) {
      replies.push(
        i % 2 === 0
          ? { call: [{ name: "list_dir", args: { path: workDir, depth: 1 } }] }
          : { call: [{ name: "list_files", args: {} }] },
      );
    }
    replies.push({ say: "五十步之后收尾。" });

    await withProvider(replies, ["跑一个很长的任务"]);
    const engine = await engineOn(workDir, storeDir);
    const out = await run(engine, "long-1", "跑一个很长的任务", 60);

    const stepCount = out.events.filter((e) => e.type === "step-finish").length;
    expect(out.ok, `长任务没跑完：${out.error ?? "(没有错误信息)"}`).toBe(true);
    expect(stepCount, `步数只有 ${stepCount}（期望 ≥50 —— 少了说明循环没走到位）`).toBeGreaterThanOrEqual(50);

    /*
     * 每步都要留痕：`tool-result` 数量应当与工具调用数一致（50 次调用 → 50 条结果）。
     * 这一条挡的是"跑了很多步但日志里只有几条" —— 那种情况事后完全查不清。
     */
    const calls = out.events.filter((e) => e.type === "tool-call").length;
    const results = out.events.filter((e) => e.type === "tool-result").length;
    expect(calls).toBeGreaterThanOrEqual(steps);
    expect(results, `${calls} 次调用只回了 ${results} 条结果`).toBe(calls);

    // 账本：50 步的用量要真的记下来（不是只记最后一步）
    const usageEvents = out.events.filter((e) => e.type === "done" && e.usage);
    expect(usageEvents.length, "一整轮跑完却没有带用量的 done 事件").toBeGreaterThan(0);
  }, 180_000);

  it("② 崩溃注入：上游半路断线时必须**报错收尾**，不能挂在那里等", async () => {
    const workDir = tmp("dh-crash-work-");
    const storeDir = tmp("dh-crash-store-");
    cleanups.push(() => fs.rmSync(workDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(storeDir, { recursive: true, force: true }));

    /*
     * 第 1 次请求正常回一个工具调用；第 2 次（带上工具结果那次）**直接掐线**。
     * 于是"上游死在第 2 步"这个场景是可重复的。
     */
    await withProvider(
      [{ call: [{ name: "list_dir", args: { path: workDir, depth: 1 } }] }, { crash: true }],
      ["上游会半路断掉"],
    );
    const engine = await engineOn(workDir, storeDir);

    /*
     * ⚠️ 用一个**超时哨兵**：这一条要验的正是"不会挂住"，
     * 所以不能只 await —— 真挂住的话测试会一直等到 vitest 的整案超时，
     * 那时的报错是"测试超时"，看不出是产品挂住了。
     */
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 60_000));
    const raced = await Promise.race([run(engine, "crash-1", "上游会半路断掉", 6), timeout]);
    if (raced === "timeout") throw new Error("上游断线之后这一轮挂住了（60 秒没返回）");

    expect(raced.ok, "上游断线却报成功 —— 那等于把失败说成成功").toBe(false);
    expect(String(raced.error ?? "").length, "报错了但没给原因（用户不知道发生了什么）").toBeGreaterThan(0);

    // 失败也要收尾：不能在界面上留一个"永远在转"的回合
    const types = raced.events.map((e) => e.type);
    expect(types.includes("done") || types.includes("error"), `既没有 done 也没有 error：${types.join(" → ")}`).toBe(true);
  }, 120_000);

  it("③ 断点恢复：换一个引擎（模拟重启）接着同一段会话跑，状态不丢", async () => {
    const workDir = tmp("dh-resume-work-");
    const storeDir = tmp("dh-resume-store-");
    cleanups.push(() => fs.rmSync(workDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(storeDir, { recursive: true, force: true }));

    /* 第一段：跑两轮，然后"进程死掉"（把引擎丢掉，只留磁盘上的库） */
    await withProvider(
      [
        { call: [{ name: "list_dir", args: { path: workDir, depth: 1 } }] },
        { say: "第一轮完了。" },
        { say: "第二轮完了。" },
      ],
      ["第一段任务", "第二段任务"],
    );
    const firstHandle = await engineHandle(workDir, storeDir);
    await run(firstHandle.engine, "resume-1", "第一段任务", 4);
    await run(firstHandle.engine, "resume-1", "第二段任务", 4);

    const before = await firstHandle.engine.resume("resume-1");
    expect(before.turns.length, "第一段跑完却读不到任何回合").toBeGreaterThan(0);

    /*
     * ⭐ **真的重启**（审计 G81）：先关掉第一段的句柄 —— 原来第一段全程不关，
     * 两个引擎同时开着同一个 SQLite 文件，测的是"两个连接并开"，
     * 而"重启后历史还在不在（WAL / 收尾 / 落盘时机）"恰恰是它漏掉的那一类。
     */
    firstHandle.close();

    /* 第二段：**新引擎**（同一个 store 目录、第一个句柄已关）—— 这就是"重启" */
    await withProvider([{ say: "重启之后接着跑。" }], ["重启之后接着跑"]);
    const second = await engineOn(workDir, storeDir);
    const resumed = await second.resume("resume-1");

    expect(resumed.turns.length, "重启之后历史丢了").toBe(before.turns.length);
    expect(resumed.pending.length, "待决审批在重启后变了").toBe(before.pending.length);

    // 接着跑第三轮：应当接在同一段会话上（而不是开一段新的）
    await run(second, "resume-1", "重启之后接着跑", 2);
    const after = await second.resume("resume-1");
    expect(after.turns.length, "第三轮没有接在同一段会话上").toBeGreaterThan(resumed.turns.length);

    /*
     * 账本也要跨重启：成本是用户的钱，重启不该把它抹掉。
     * 这里只断言"还能读到用量"，具体数字由 `ding sessions --cost` 那条路保证。
     */
    const encoded = JSON.stringify(after);
    expect(/inputTokens|outputTokens/.test(encoded), "重启之后账本读不出来了").toBe(true);
  }, 120_000);

  it("④ 成本不失控：长任务的每一步都带用量，且总量随步数**线性**增长（不是平方）", async () => {
    const workDir = tmp("dh-cost-work-");
    const storeDir = tmp("dh-cost-store-");
    cleanups.push(() => fs.rmSync(workDir, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(storeDir, { recursive: true, force: true }));

    const steps = 12;
    const replies: EvalReply[] = [];
    for (let i = 0; i < steps; i += 1) replies.push({ call: [{ name: "list_files", args: {} }] });
    replies.push({ say: "完了。" });

    const provider = await withProvider(replies, ["数一数成本"]);
    const engine = await engineOn(workDir, storeDir);
    const out = await run(engine, "cost-1", "数一数成本", steps + 2);

    const doneWithUsage = out.events.filter((e) => e.type === "done" && e.usage);
    expect(doneWithUsage.length).toBeGreaterThan(0);

    const stepCount = out.events.filter((e) => e.type === "step-finish").length;
    expect(stepCount, `步数 ${stepCount} 与脚本 ${steps} 差太远`).toBeGreaterThanOrEqual(steps);

    /*
     * ⭐ 成本这一格的**真判据**（2026-10-16，审计 G82）。
     *
     * 原来只有"有 usage""步数够"两条 —— 一个成本数字都没断；而假 provider 的用量
     * 当时是与请求体无关的常数（100 + index*10），所以"每轮重发全部历史"这件事
     * **结构上量不出来**。现在假 provider 按请求体字节报用量，于是下面两条真的能断：
     *
     *   ① **账本记的就是真发出去的**：每一步的 `inputTokens` 与那一次请求的
     *      原始字节数（÷4）对得上 —— 挡"用量是编的 / 是赋值不是累加"；
     *   ② **历史是"每步加一段"，不是重发多份**：每次请求的 `messages` 条数
     *      随步号增长，而且不会暴涨（挡"整段历史被塞两遍"这类静默翻倍）。
     */
    const bodies = provider.bodies as Array<{ messages?: unknown[] }>;
    const stepUsages = out.events
      .filter((e): e is { type: "step-finish"; usage?: { inputTokens?: number } } => e.type === "step-finish")
      .map((e) => e.usage?.inputTokens ?? 0);
    expect(bodies.length, "假 provider 收到的请求数少于步数").toBeGreaterThanOrEqual(steps);
    const zipped = Math.min(bodies.length, stepUsages.length);
    for (let i = 0; i < zipped; i += 1) {
      const expected = Math.max(1, Math.round(Buffer.byteLength(JSON.stringify(bodies[i]), "utf8") / 4));
      const got = stepUsages[i] ?? 0;
      expect(Math.abs(got - expected), `第 ${i + 1} 步的 inputTokens ${got} 与真发的字节（约 ${expected}）对不上`).toBeLessThanOrEqual(2);
    }
    const counts = bodies.map((b) => (Array.isArray(b.messages) ? b.messages.length : 0));
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i], `第 ${i + 1} 次请求的 messages 没有增长（历史被丢了？）`).toBeGreaterThan(counts[i - 1] ?? 0);
    }
    expect(
      counts.at(-1) ?? 0,
      `最后一次请求带了 ${counts.at(-1)} 条 messages —— 比"每步加两条"多太多（历史被重复塞了？）`,
    ).toBeLessThanOrEqual(counts.length * 2 + 2);

    /*
     * 时钟也要有界：这条长任务不该跑到分钟级。
     * （假 provider 是本地的，所以这里量的其实是内核自己的编排开销。）
     *
     * ⚠️ 2026-10-16（审计 G83）：原来第二段打在**同一个 provider 实例**上，
     * 而它那边的脚本已经消费到末尾 → 第二段其实只有 1 步，
     * `30 秒` 量的是"一次空回合"。现在换一个 provider 实例（同体量：又是 12 步），
     * 并且顺手断一下它确实走了那么多步。
     */
    const secondProvider = await withProvider(replies, ["数一数成本"]);
    const started = Date.now();
    const second = await run(engine, "cost-2", "数一数成本", steps + 2);
    expect(second.events.length).toBeGreaterThan(0);
    const secondSteps = second.events.filter((e) => e.type === "step-finish").length;
    expect(secondSteps, `第二段只有 ${secondSteps} 步 —— 那不是"同样体量的一轮"`).toBeGreaterThanOrEqual(steps);
    expect(
      secondProvider.bodies.length,
      "第二段用的还是上一个 provider 实例（脚本早被吃完了）",
    ).toBeGreaterThanOrEqual(steps);
    expect(Date.now() - started, "同样体量的一轮跑了 30 秒以上（编排开销失控）").toBeLessThan(30_000);
  }, 120_000);
});
