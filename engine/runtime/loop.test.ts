import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { humanError, resolveTurnTarget, runTurn, effectiveMaxSteps, type TurnEvent } from "./loop";
import { createToolRegistry, buildToolSet } from "./registry";
import { getProvider } from "./providers";
import type { HealthStore } from "../ports/health";
import type { ToolExecutor } from "../ports/executor";
import { z } from "zod";

/**
 * 主循环的**端到端**测试 —— 但**不连真模型、不烧一分钱**。
 *
 * ## 怎么做到的
 *
 * `runTurn` 真正做的事是"把 OpenAI 兼容的 SSE 流翻成 TurnEvent"。所以这里在
 * `127.0.0.1` 上起一个**假 provider**：收 POST、按 OpenAI 的 chunk 格式吐 SSE。
 * 于是被测的是**真代码路径**（真 SDK、真流解析、真工具往返），而不是一个替身。
 *
 * 这条之所以能成立，是因为 `engine/runtime/providers.ts` 的 baseURL 改成了**惰性**读环境变量
 * （见那个文件头的说明）—— 在那之前，模块一 import 就把 baseURL 定死了，测不了。
 *
 * ⚠️ 判据全是**可证伪的行为**：事件顺序、参数有没有原样到达执行体、
 * 工具报错会不会中断整轮、中止时会不会把 provider 判死。
 */

/** 假 provider 的端口（`beforeAll` 里绑，绑在 0 上由系统分配）。 */
let port = 0;
let server: Server;
/** 收到过的请求体（按到达顺序）。 */
let bodies: unknown[] = [];
/** 造一份响应：**由请求体自己决定**（见下面的说明）。 */
let script: (reqBody: unknown) => object[] = () => [];

/**
 * ⚠️ 假 provider 必须**无状态** —— 这条是踩出来的。
 *
 * 第一版用一个共享的"第几次请求"计数器来选分支，于是**跨用例串了**：
 * 上一个用例的迟到请求（循环在步数上限处停下时，最后一次请求可能还在飞）
 * 会涨到下一个用例的计数器上，让它拿到错误的那一支 ——
 * 表现为"同样的代码，一次红一次绿"（实测：同一份测试连跑两次，一次 3 红一次全绿）。
 *
 * 现在响应只由**请求体**决定（体里带没带工具结果），于是迟到请求落在哪个用例里
 * 都只会拿到"它自己该拿的"那一支。断言也按用例的**独有 token** 过滤，不看总数。
 */
function bodyText(body: unknown): string {
  return JSON.stringify(body ?? "");
}

/** 请求体里有没有工具结果（有 = 模型已经看过工具输出，该收尾了）。 */
function hasToolResult(body: unknown): boolean {
  return bodyText(body).includes('"role":"tool"');
}

/** 用例 token（每条请求的 system 里都带上，用它把"我的请求"和迟到请求分开）。 */
let token = "";
/** 本用例真正打到假 provider 的请求数。 */
function hitsOf(t: string): number {
  return bodies.filter((b) => bodyText(b).includes(t)).length;
}

/**
 * "第一轮这样回、之后那样回"（**按请求体判断**，不按计数器）。
 *
 * ⚠️ 这个帮手是必须的：多步循环里 SDK 会**再发一次请求**（把工具结果带上），
 * 而一个每次都吐同一套 chunk 的假 provider 会让模型"无限重复调同一个工具" ——
 * 那是**假 provider 的行为**，不是被测代码的问题。
 */
function scriptOnce(first: object[], then: object[]): (reqBody: unknown) => object[] {
  return (body) => (hasToolResult(body) ? then : first);
}

/** 一帧 chunk 的公共字段。 */
const CHUNK_BASE = { id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };

/** 增量文本。 */
const text = (t: string) => ({ ...CHUNK_BASE, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
/** 收尾（`stop` / `tool_calls`）。 */
const finish = (reason: string) => ({ ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
/** 用量（OpenAI 把它放在一个 choices 为空的帧里）。 */
const usage = (p: number, c: number) => ({
  ...CHUNK_BASE,
  choices: [],
  usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
});
/** 工具调用（第一帧带 id/name，后续帧只带 arguments 片段 —— 与真 provider 同形）。 */
const toolChunk = (id: string | null, name: string | null, args: string) => ({
  ...CHUNK_BASE,
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            ...(id ? { id, type: "function" } : {}),
            function: { ...(name ? { name } : {}), arguments: args },
          },
        ],
      },
      finish_reason: null,
    },
  ],
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += String(d);
    });
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* 请求体不合法也照吐（这一轮测的不是它） */
      }
      bodies.push(parsed);
      const chunks = script(parsed);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // 把 `strata`（那个本来就指本机的 provider）指到这个假服务上
  process.env.STRATA_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.STRATA_API_KEY = "test-key";
});

afterAll(async () => {
  delete process.env.STRATA_BASE_URL;
  delete process.env.STRATA_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bodies = [];
  script = () => [];
  token = `tk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
});

/**
 * 跑一轮（provider 固定为指向假服务的 strata）。
 *
 * system 里带上本用例的 token —— 断言据此只数**自己的**请求，
 * 上一个用例的迟到请求不会再冒充成这一次的。
 */
async function run(
  onEvent: (e: TurnEvent) => void,
  extra: Partial<Parameters<typeof runTurn>[0]> = {},
  deps: Parameters<typeof runTurn>[2] = {},
) {
  return runTurn(
    { provider: "strata", system: `用例 ${token}`, messages: [{ role: "user", content: "你好" }], ...extra },
    onEvent,
    deps,
  );
}

describe("主循环 · 文本与用量", () => {
  it("⭐ 文本按到达顺序成为事件，收尾给出真实用量", async () => {
    script = () => [text("你"), text("好"), finish("stop"), usage(11, 4)];
    const events: TurnEvent[] = [];
    const outcome = await run((e) => events.push(e));

    expect(hitsOf(token)).toBe(1);
    expect(outcome).toMatchObject({ ok: true, aborted: false, provider: "strata", model: "deepseek-flash" });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text)).toEqual(["你", "好"]);
    expect(events.filter((e) => e.type === "step-finish")).toHaveLength(1);
    const done = events.find((e) => e.type === "done") as { usage?: { inputTokens?: number; outputTokens?: number } };
    expect(done.usage?.inputTokens).toBe(11);
    expect(done.usage?.outputTokens).toBe(4);
  });

  it("provider 报错 → 事件里有 error 且结局 ok=false（错误不吞）", async () => {
    script = () => [text("半句"), { ...CHUNK_BASE, choices: [], error: { message: "boom", type: "server_error" } }];
    const events: TurnEvent[] = [];
    const outcome = await run((e) => events.push(e));
    // 无论是"SDK 抛错"还是"事件里带 error"，都必须以 ok=false 收场 —— 不许悄悄成功
    expect(outcome.ok).toBe(false);
    expect(events.some((e) => e.type === "error" || e.type === "text")).toBe(true);
  });
});

describe("主循环 · 工具往返", () => {
  /** 一个只记账、不干真事的执行体。 */
  function spyExecutor(result: { ok: boolean; output?: unknown; error?: string } = { ok: true, output: { line: "读到了" } }) {
    const calls: { name: string; input: unknown }[] = [];
    const executor: ToolExecutor = {
      run: async (name, input) => {
        calls.push({ name, input });
        return result;
      },
    };
    return { executor, calls };
  }

  /** 一个只有 `read_file` 的注册表（跑得快、判据清楚）。 */
  const registry = () =>
    createToolRegistry({
      extra: [],
    });

  it("⭐ 工具调用带参数到达执行体，结果作为 tool-result 回注", async () => {
    // 参数被 provider 切成两帧发（真 provider 就是这么干的）—— 拼不回来就说明流解析错了
    script = scriptOnce(
      [toolChunk("call_1", "read_file", '{"path":'), toolChunk(null, null, '"a.md"}'), finish("tool_calls")],
      [text("读完了"), finish("stop")],
    );
    const { executor, calls } = spyExecutor({ ok: true, output: { text: "内容" } });
    const tools = buildToolSet({
      registry: createToolRegistry(),
      mode: "全部允许",
      executor,
      ctx: { mode: "全部允许", provider: "strata" },
    });
    expect(Object.keys(tools)).toContain("read_file");

    const events: TurnEvent[] = [];
    await run((e) => events.push(e), { tools, maxSteps: 3 });

    expect(calls).toEqual([{ name: "read_file", input: { path: "a.md" } }]);
    const call = events.find((e) => e.type === "tool-call") as { toolName: string; toolCallId: string };
    expect(call.toolName).toBe("read_file");
    const result = events.find((e) => e.type === "tool-result") as { toolCallId: string; output?: unknown };
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.output).toEqual({ text: "内容" });
  });

  it("⭐ 执行体抛错 → 仍是一次 tool-result（错误即结果，整轮不中断）", async () => {
    script = scriptOnce([toolChunk("call_1", "read_file", '{"path":"a.md"}'), finish("tool_calls")], [text("知道了"), finish("stop")]);
    const executor: ToolExecutor = {
      run: async () => {
        throw new Error("磁盘炸了");
      },
    };
    const tools = buildToolSet({ registry: registry(), mode: "全部允许", executor, ctx: { mode: "全部允许", provider: "strata" } });
    const events: TurnEvent[] = [];
    const outcome = await run((e) => events.push(e), { tools, maxSteps: 3 });

    const result = events.find((e) => e.type === "tool-result") as { error?: string };
    expect(result.error).toContain("磁盘炸了");
    // 关键：这一轮**没有**被中断 —— 模型接着说完了话
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(outcome.ok).toBe(true);
  });

  it("⭐ 闸门拦下（按需确认）→ 回一条 pending，且**不执行**", async () => {
    script = scriptOnce([toolChunk("call_1", "write_file", '{"path":"a.md","content":"x"}'), finish("tool_calls")], [text("好"), finish("stop")]);
    const { executor, calls } = spyExecutor();
    // write_file 在策略表里是写 → 「按需确认」档必拦
    const tools = buildToolSet({ registry: registry(), mode: "按需确认", executor, ctx: { mode: "按需确认", provider: "strata" } });
    const events: TurnEvent[] = [];
    await run((e) => events.push(e), { tools, maxSteps: 3 });

    const result = events.find((e) => e.type === "tool-result") as { output?: { pending?: boolean } };
    expect(result.output?.pending).toBe(true);
    expect(calls).toHaveLength(0); // 写着"确认"却已经把事做完 —— 这是最不能接受的那种
  });

  it("深度到顶时 `spawn_agent` 根本不注入（模型看不到）", () => {
    const tools = buildToolSet({
      registry: createToolRegistry(),
      mode: "全部允许",
      executor: { run: async () => ({ ok: true }) },
      ctx: { mode: "全部允许", provider: "strata", depth: 1 },
    });
    expect(Object.keys(tools)).not.toContain("spawn_agent");
    // 同档位、未到顶时它在
    const top = buildToolSet({
      registry: createToolRegistry(),
      mode: "全部允许",
      executor: { run: async () => ({ ok: true }) },
      ctx: { mode: "全部允许", provider: "strata", depth: 0 },
    });
    expect(Object.keys(top)).toContain("spawn_agent");
  });
});

describe("主循环 · 步数上限是参数（Phase 3.2）", () => {
  it("⭐ 步数按 AI SDK 的**每步边界**数（不是整轮结束）", async () => {
    /*
     * ⚠️ 这条是 Phase 6 的 PoC 逮出来的：循环原来只认 `finish`（整轮结束），
     * 于是 maxSteps=3 的一轮也只发 1 个 step-finish —— 步数统计一直偏小。
     * 现在认 `finish-step`（每步一个）。判据用"工具调用数"与"step-finish 数"**双双**对齐，
     * 因为这两者在"每步一次工具调用"的假 provider 下必须相等。
     */
    let i = 0;
    script = () => [toolChunk(`s${(i += 1)}`, "read_file", '{"path":"a.md"}'), finish("tool_calls")];
    const tools = buildToolSet({
      registry: createToolRegistry(),
      mode: "全部允许",
      executor: { run: async () => ({ ok: true, output: { line: "ok" } }) },
      ctx: { mode: "全部允许", provider: "strata" },
    });
    const events: TurnEvent[] = [];
    await run((e) => events.push(e), { tools, maxSteps: 3 });
    const calls = events.filter((e) => e.type === "tool-call").length;
    const steps = events.filter((e) => e.type === "step-finish").length;
    expect(calls).toBe(3);
    expect(steps, "step-finish 应当每步一个").toBe(3);
  });

  it("⭐ 父 4 / 子 6：同一个循环，只有这个参数不同", async () => {
    /*
     * 假 provider **每次都回工具调用** —— 于是唯一的刹车就是步数上限。
     * 这条比"读源码断言 maxSteps: 4"强得多：它证明那个数**真的**在起作用
     * （4 与 6 各自的经验值不许被顺手统一，理由见 runTurn 的文件头）。
     */
    // 假 provider 每次都给一个工具调用（无状态）→ 唯一的刹车就是步数上限
    let n = 0;
    script = () => [toolChunk(`call_${(n += 1)}`, "read_file", '{"path":"a.md"}'), finish("tool_calls")];
    const tools = buildToolSet({
      registry: createToolRegistry(),
      mode: "全部允许",
      executor: { run: async () => ({ ok: true, output: { line: "ok" } }) },
      ctx: { mode: "全部允许", provider: "strata" },
    });

    const four: TurnEvent[] = [];
    await run((e) => four.push(e), { tools, maxSteps: 4 });
    expect(four.filter((e) => e.type === "tool-call"), "父级应当跑 4 步就停").toHaveLength(4);

    const six: TurnEvent[] = [];
    // 子智能体那条路（`runSubagent`）用的就是这个数
    await run((e) => six.push(e), { tools, maxSteps: 6 });
    expect(six.filter((e) => e.type === "tool-call"), "子智能体应当跑 6 步才停").toHaveLength(6);
  });

  it("⭐⭐ 坏的上限（NaN）不会拆掉刹车：退回默认 6 步就停（审计 P49）", async () => {
    /*
     * `ding run --steps`（漏值）原来会变成 `Number("true") = NaN`，而
     * `stepCountIs(NaN)` 的判据恒假 —— "最多跑几步"这道防失控闸**恒不成立**。
     * 假 provider 每次都回工具调用 ⇒ 没有刹车就是**死循环**。
     * 这条断言 6 步停下：把 `effectiveMaxSteps` 改坏（退回 `raw ?? 6`），
     * 这一条会**跑到超时变红** —— 那正是缺陷的形状。
     */
    let n = 0;
    script = () => [toolChunk(`call_${(n += 1)}`, "read_file", '{"path":"a.md"}'), finish("tool_calls")];
    const tools = buildToolSet({
      registry: createToolRegistry(),
      mode: "全部允许",
      executor: { run: async () => ({ ok: true, output: { line: "ok" } }) },
      ctx: { mode: "全部允许", provider: "strata" },
    });

    const events: TurnEvent[] = [];
    await run((e) => events.push(e), { tools, maxSteps: Number.NaN });
    expect(events.filter((e) => e.type === "tool-call"), "NaN 上限应当退回默认 6").toHaveLength(6);
  });
});

describe("步数上限的兜底换算（effectiveMaxSteps）", () => {
  it("没给就是 6；正常整数原样过", () => {
    expect(effectiveMaxSteps(undefined)).toBe(6);
    expect(effectiveMaxSteps(8)).toBe(8);
  });

  it("⭐ NaN / Infinity 退回 6（不许变成「恒不成立的上限」）", () => {
    expect(effectiveMaxSteps(Number.NaN)).toBe(6);
    expect(effectiveMaxSteps(Number.POSITIVE_INFINITY)).toBe(6);
    expect(effectiveMaxSteps(Number.NEGATIVE_INFINITY)).toBe(6);
  });

  it("0 / 负值抬到 1；小数取整", () => {
    expect(effectiveMaxSteps(0)).toBe(1);
    expect(effectiveMaxSteps(-5)).toBe(1);
    expect(effectiveMaxSteps(7.9)).toBe(7);
  });
});

describe("主循环 · 中止与健康账本", () => {
  it("⭐ 用户中止：aborted=true，**不判 provider 失败**，也不记成功", async () => {
    script = () => [text("一"), text("二"), text("三"), finish("stop")];
    const calls: string[] = [];
    const health: HealthStore = {
      markOk: (id) => calls.push(`ok:${id}`),
      markFailed: (id, note) => calls.push(`fail:${id}:${note}`),
    };
    const controller = new AbortController();
    const outcome = await run(
      (e) => {
        if (e.type === "text" && e.text === "一") controller.abort();
      },
      { abortSignal: controller.signal },
      { health },
    );

    expect(outcome.aborted).toBe(true);
    expect(calls).toEqual([]); // 中止是用户意图：既不算失败，也不是"跑通了"
  });

  it("跑通一次 → 记一次成功（健康账本只有这两个动作）", async () => {
    script = () => [text("嗨"), finish("stop"), usage(1, 1)];
    const calls: string[] = [];
    await run(() => undefined, {}, { health: { markOk: (id) => calls.push(`ok:${id}`), markFailed: (id) => calls.push(`fail:${id}`) } });
    expect(calls).toEqual(["ok:strata"]);
  });

  it("不给 health 也能跑（默认什么都不记）", async () => {
    script = () => [text("嗨"), finish("stop")];
    await expect(run(() => undefined)).resolves.toMatchObject({ ok: true });
  });
});

describe("主循环 · 前置校验与错误翻译", () => {
  it("未知 provider：给出错误事件，且**不发请求**", async () => {
    const events: TurnEvent[] = [];
    const outcome = await runTurn({ provider: "没有这家", messages: [{ role: "user", content: "hi" }] }, (e) => events.push(e));
    expect(outcome.ok).toBe(false);
    expect(events[0]).toMatchObject({ type: "error" });
    expect(hitsOf(token)).toBe(0);
  });

  it("模型名不在清单里就退回默认（不拿一个不存在的模型去请求）", () => {
    const target = resolveTurnTarget("strata", "不存在的模型");
    expect(target).toMatchObject({ ok: true, model: "deepseek-flash" });
  });

  it("⭐ `DSH_NO_REAL_MODEL` 是**真闸**：远程 provider 直接拒，本机照常放行", () => {
    /*
     * 这个变量在 CI 里写着、注释还承诺"会让真调模型的路径立刻失败"，
     * 而在此之前**没有任何代码读它**。这条断言就是那句承诺的兑现处 ——
     * 没有它，下一个人把闸门函数删掉也不会有东西喊。
     */
    const prev = process.env.DSH_NO_REAL_MODEL;
    try {
      process.env.DSH_NO_REAL_MODEL = "1";
      // 远程（deepseek 官方）→ 拒
      const remote = resolveTurnTarget("deepseek", "deepseek-chat");
      expect(remote.ok).toBe(false);
      expect(remote.ok ? "" : remote.error).toContain("DSH_NO_REAL_MODEL");
      // 本机（测试里的假 provider 就在 127.0.0.1）→ 放行，否则"不烧钱地测主循环"这条路也被堵死
      const local = resolveTurnTarget("strata", "deepseek-flash");
      expect(local.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.DSH_NO_REAL_MODEL;
      else process.env.DSH_NO_REAL_MODEL = prev;
    }
  });

  it("⭐ 闸门在**真跑那一轮**里也生效（不只是 resolveTurnTarget 里）", async () => {
    /*
     * ⚠️ 这条是补出来的：给 `resolveTurnTarget` 加了闸之后，CLI 真跑一次
     * **照打不误** —— 因为 `runTurn` 自己又写了一遍 provider 解析、没走那个函数。
     * 所以"闸门在判定函数里"不算数，得断言"真的没发请求"。
     */
    const prev = process.env.DSH_NO_REAL_MODEL;
    const fake = getProvider("strata")!;
    const remote = { ...fake, baseURL: "https://api.deepseek.com/v1" };
    try {
      process.env.DSH_NO_REAL_MODEL = "1";
      // 直接把 strata 的地址改成远程（只改进程环境不够，这里改的是 provider 表读到的值）
      process.env.STRATA_BASE_URL = remote.baseURL;
      const events: TurnEvent[] = [];
      const outcome = await run((e) => events.push(e));
      expect(outcome.ok).toBe(false);
      expect(events[0]).toMatchObject({ type: "error" });
      expect(hitsOf(token), "闸门没拦住：请求真打出去了").toBe(0);
    } finally {
      process.env.STRATA_BASE_URL = `http://127.0.0.1:${port}/v1`;
      if (prev === undefined) delete process.env.DSH_NO_REAL_MODEL;
      else process.env.DSH_NO_REAL_MODEL = prev;
    }
  });

  it("错误翻译：密钥 / 限流 / 网络 / 余额分别给人话，且每条都给出下一步", () => {
    /*
     * ⚠️ 文案在 Phase 13.1 改过：原来只说"发生了什么"（"密钥无效或已过期"），
     * 现在**每条都带下一步**（方案 10.4 的"人话清单"要求）—— 只说"出错了"
     * 等于把问题丢回给用户。措辞的单一来源在 `shared/errors.ts`，
     * 逐条清单由 `shared/errors.test.ts` 验；这里断的是**这条路真的走通了**。
     */
    expect(humanError(new Error("401 Unauthorized"))).toContain("密钥无效或已过期");
    expect(humanError(new Error("401 Unauthorized"))).toContain("检查");
    expect(humanError(new Error("429 rate limit exceeded"))).toContain("限流");
    expect(humanError(new Error("429 rate limit exceeded"))).toContain("稍后重试");
    expect(humanError(new Error("fetch failed"))).toContain("连不上");
    expect(humanError(new Error("Insufficient Balance"))).toContain("余额不足");
    expect(humanError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("已中止");
    // 认不出来时不编话：截断原文（用户至少能看到上游说了什么）
    expect(humanError(new Error("x".repeat(500)))).toHaveLength(200);
  });
});

describe("工具声明与执行的连线", () => {
  it("注册表里的 schema 真的会校验参数（schema 即说明，也是那道门）", () => {
    const spec = createToolRegistry().get("write_file");
    expect(spec?.source).toBe("builtin");
    // 声明来自 AGENT_TOOLS：这里能拿到 zod schema 本体
    expect((spec?.inputSchema as unknown as z.ZodTypeAny).safeParse({ path: "a.md", content: "x" }).success).toBe(true);
    expect((spec?.inputSchema as unknown as z.ZodTypeAny).safeParse({ path: 1 }).success).toBe(false);
  });
});
