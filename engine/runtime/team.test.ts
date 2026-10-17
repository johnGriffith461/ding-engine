import { createServer, type Server } from "node:http";
import { listenReachable } from "../testing/localServer";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ToolSet } from "ai";
import { findAgent } from "./agents";
import { runTeam } from "./team";
import type { ConfirmMode } from "../../shared/ipc";

/**
 * coordinator / specialist 协作（Phase 7.2）。
 *
 * ## 这组断言挡的是什么
 *
 * 四件"必须做对"的事各自都可能悄悄做错，而且**错了也不报**：
 * 说是并行其实是排队（只是慢）、专家用了比调用方更松的档位（绕过用户审批）、
 * 白名单没生效（研究员拿到了写工具）、一个成员失败却把整队带崩。
 * 所以每一条都断言**可观察的后果**，而不是"函数被调过"。
 *
 * ⚠️ 全程打在本地假端点：不发一次真请求（可以随时重跑）。
 */

let server: Server;
let port = 0;
/** 每个请求的响应延迟（测并行用）。 */
let delayMs = 0;
/** 收到几次请求。 */
let hits = 0;
/** 同时在飞的请求数，以及历史峰值（**直接测并发**，不用挂钟时间猜）。 */
let inFlight = 0;
let maxInFlight = 0;

const CHUNK_BASE = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      hits += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ ...CHUNK_BASE, choices: [{ index: 0, delta: { content: "要点" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...CHUNK_BASE, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }, delayMs);
    });
  });
  /* 共用的"绑一个连得上的端口"（见 engine/testing/localServer.ts 的说明） */
  port = await listenReachable(server);
  process.env.STRATA_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.STRATA_API_KEY = "team-test";
});

afterAll(async () => {
  delete process.env.STRATA_BASE_URL;
  delete process.env.STRATA_API_KEY;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  delayMs = 0;
  hits = 0;
  inFlight = 0;
  maxInFlight = 0;
});

/** 记账用的假工具集提供者。 */
function spyMakeTools() {
  const seen: { mode: ConfirmMode; depth: number; only?: readonly string[] }[] = [];
  const make = (mode: ConfirmMode, depth: number, _provider: string, _signal: AbortSignal | undefined, only?: readonly string[]) => {
    seen.push({ mode, depth, ...(only ? { only } : {}) });
    return {} as ToolSet;
  };
  return { seen, make };
}

describe("并行", () => {
  it("⭐ 三个专家是**同时**跑的（不是排队）", async () => {
    delayMs = 150; // 每个请求 150ms，好让"同时在飞"这件事有窗口
    const { make } = spyMakeTools();
    const report = await runTeam({
      tasks: [
        { agent: "researcher", task: "甲" },
        { agent: "researcher", task: "乙" },
        { agent: "researcher", task: "丙" },
      ],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
    });
    expect(report.members).toHaveLength(3);
    expect(hits).toBe(3);
    /*
     * ⚠️ 判据是**服务端同时在飞的请求数**，不是耗时。
     *
     * 第一版用挂钟时间（"三个 150ms 的请求总耗时应当 < 300ms"）—— 单独跑过、
     * 全量跑就红：满负载时别的测试文件在抢 CPU，时间阈值必然抖。
     * 而"并行"这件事本来就有**直接**的度量：同时有几个请求在飞。
     * 改用它之后，机器再忙也不会误判（排队的话峰值只能是 1）。
     */
    expect(maxInFlight, `同时在飞的请求峰值只有 ${maxInFlight} —— 是排队不是并行`).toBeGreaterThanOrEqual(2);
  });
});

describe("闸门与白名单", () => {
  it("⭐ 每个专家拿到的都是**自己那份**工具白名单", async () => {
    const { seen, make } = spyMakeTools();
    await runTeam({
      tasks: [
        { agent: "researcher", task: "查" },
        { agent: "writer", task: "写" },
      ],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
    });
    const onlys = seen.map((s) => (s.only ?? []).join(","));
    expect(onlys).toContain((findAgent("researcher")!.tools ?? []).join(","));
    expect(onlys).toContain((findAgent("writer")!.tools ?? []).join(","));
    // 研究员那份里没有写工具
    const researcherOnly = seen.find((s) => (s.only ?? []).includes("search_files"))?.only ?? [];
    expect(researcherOnly).not.toContain("write_file");
  });

  it("⭐ 档位**只能更严**：调用方是「每步确认」时，专家拿到的也是「每步确认」", async () => {
    const { seen, make } = spyMakeTools();
    await runTeam({
      tasks: [{ agent: "writer", task: "写" }],
      provider: "strata",
      callerMode: "每步确认",
      makeTools: make,
    });
    expect(seen[0]?.mode).toBe("每步确认");
  });

  it("深度 +1 传给专家（他们不能再派小队）", async () => {
    const { seen, make } = spyMakeTools();
    await runTeam({
      tasks: [{ agent: "runner", task: "跑" }],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
      depth: 0,
    });
    expect(seen[0]?.depth).toBe(1);
  });
});

describe("汇合与上卷", () => {
  it("⭐ 成本上卷：每个专家的用量汇总到整队（一个数都没有时不给数 —— 不编）", async () => {
    const { make } = spyMakeTools();
    const report = await runTeam({
      tasks: [
        { agent: "researcher", task: "甲" },
        { agent: "researcher", task: "乙" },
      ],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
    });
    expect(report.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(report.summary).toContain("researcher");
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(true);
  });

  it("进度成对上报：每个专家一条 started + 一条 finished", async () => {
    const progress: { agent: string; status: string }[] = [];
    const { make } = spyMakeTools();
    await runTeam({
      tasks: [
        { agent: "researcher", task: "甲" },
        { agent: "writer", task: "乙" },
      ],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
      onDelegation: (e) => progress.push({ agent: e.agent, status: e.status }),
    });
    for (const agent of ["researcher", "writer"]) {
      expect(progress.filter((p) => p.agent === agent).map((p) => p.status).sort()).toEqual(["finished", "started"]);
    }
  });
});

describe("失败处理", () => {
  it("⭐ 不认识的 agent：**如实失败**，而且不把整队带崩", async () => {
    const { make } = spyMakeTools();
    const report = await runTeam({
      tasks: [
        { agent: "不存在的角色", task: "甲" },
        { agent: "researcher", task: "乙" },
      ],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
    });
    expect(report.failed).toBe(1);
    expect(report.ok).toBe(false);
    const bad = report.members.find((m) => m.agent === "不存在的角色")!;
    expect(bad.error).toContain("没有叫");
    // 另一个照常跑完（失败不中断整队）
    expect(report.members.find((m) => m.agent === "researcher")?.ok).toBe(true);
    expect(report.summary).toContain("失败");
  });

  it("空任务被丢掉（模型塞了一条空字符串进来，不该当一件活去跑）", async () => {
    const { make } = spyMakeTools();
    const report = await runTeam({
      tasks: [
        { agent: "researcher", task: "   " },
        { agent: "researcher", task: "真活" },
      ],
      provider: "strata",
      callerMode: "全部允许",
      makeTools: make,
    });
    expect(report.members).toHaveLength(1);
    expect(hits).toBe(1);
  });
});
