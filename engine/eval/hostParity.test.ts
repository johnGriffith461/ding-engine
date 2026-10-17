import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import { AcpAgent } from "../../hosts/acp/agent";
import { startFakeProvider } from "./fakeProvider";
import { EVAL_CASES } from "./cases";
import type { RpcMessage } from "../../hosts/acp/agent";

/**
 * 「接入外部宿主后**评测集零漂移**」（Phase 17 的验收口径）。
 *
 * ## 为什么值得单开一条
 *
 * 方案把这句写在 Phase 17 的验收里。它有两种可能的读法：
 *   · **结构性的**：外部宿主走的是同一份装配 + 同一条 `engine.run`，所以不会漂；
 *   · **可验证的**：拿同一批用例分别从两条路跑，结果一字不差。
 *
 * 「结构性成立」是我写在注释里的主张 —— 主张要能被证伪，所以这里做第二种：
 * **同一批用例，一次走内核直连、一次走 ACP 协议**，比对模型实际看见的与吐出的东西。
 *
 * ## 比什么（2026-10-16，审计 G80 修）
 *
 * ACP 那条路的输出是 JSON-RPC 消息（多一层协议外壳），而直连那条是 TurnEvent 数组 ——
 * 比字节比的是外壳，不是行为。要比的是**行为**：
 *
 *   ① 模型**收到的用户消息**（从假 provider 收到的请求体里读，两条路逐条相等）；
 *   ② 模型**吐出的正文**（两边拼起来相等）；
 *   ③ **工具调用名与参数**（两边逐条相等 —— 参数也算，原来只比了名字）。
 *
 * ⚠️ 如实记一条边界：这一格量的是**内核直连 vs ACP** 两条路。
 * **桌面宿主那条路不在这一格里**（它要 Electron，vitest 里 import 不了）——
 * 所以对外只能说"直连与 ACP 一致"，不能说"桌面也验过"（CHANGELOG 的口径据此改）。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * 挑用例（2026-10-16，审计 G80 修）。
 *
 * ⚠️ 原来只挑 `纯对话` 那三条 —— 它们**一条都不调工具**，于是"工具调用名与参数"
 * 那一路永远是 `[] vs []`：比了个寂寞。现在**必须有调工具的**，再搭一条不调工具的。
 */
const TOOL_CASE_IDS = ["tool-read", "tool-multi-step"];
const CASES = [
  ...EVAL_CASES.filter((c) => TOOL_CASE_IDS.includes(c.id)),
  ...EVAL_CASES.filter((c) => c.category === "纯对话" && c.kind !== "core").slice(0, 1),
];

describe("宿主一致性：内核直连 vs ACP（Phase 17 的「评测集零漂移」）", () => {
  it("同一批用例走两条路：用户消息、模型回复、工具调用都一致", async () => {
    expect(CASES.length, "没挑到用例（纯对话那类是不是被改了？）").toBeGreaterThan(0);

    let toolCallingCases = 0;
    for (const c of CASES) {
      const workDir = tmp(`dh-parity-${c.id}-`);
      const storeDir = tmp(`dh-parity-store-${c.id}-`);
      /*
       * ⚠️ **两条路各起一个假 provider**：它按"本实例收到第几个请求"取脚本，
       * 共用一个的话第一段会把脚本吃到最后一条，第二段就只能拿到重复的那条 ——
       * 那报出来的是"两条路正文不一样"，而真相是**测试装置串台**（第一版就是这么误报的）。
       */
      const prev = { base: process.env.STRATA_BASE_URL, key: process.env.STRATA_API_KEY };
      const directProvider = await startFakeProvider((c.replies ?? []).flat(), c.turns ?? []);
      let acpProvider: Awaited<ReturnType<typeof startFakeProvider>> | null = null;

      try {
        /* ① 直连：与评测集同一条路 */
        process.env.STRATA_BASE_URL = directProvider.url;
        process.env.STRATA_API_KEY = "parity-key";
        const direct = await buildEngine([workDir], storeDir);
        const events: Array<{ type: string; text?: string; toolName?: string }> = [];
        for (const turn of c.turns ?? []) {
          await direct.engine.run({
            sessionId: `parity-direct-${c.id}`,
            provider: "strata",
            model: "deepseek-flash",
            messages: [{ role: "user", content: turn }],
            mode: c.mode ?? "按需确认",
            /* ⚠️ 按用例声明来（审计 G87：原来写死 true，`chat-no-tools` 那条被静默改掉） */
            ...(c.useTools === false ? { useTools: false } : { useTools: true }),
            maxSteps: c.maxSteps ?? 4,
            onEvent: (e) => events.push(e as { type: string; text?: string; toolName?: string }),
          });
        }
        direct.close();

        /* ② ACP：同一批用例从协议那头走一遍（**另一个 provider 实例 + 另一个 store 目录**） */
        acpProvider = await startFakeProvider((c.replies ?? []).flat(), c.turns ?? []);
        process.env.STRATA_BASE_URL = acpProvider.url;
        const acpStoreDir = tmp(`dh-parity-acp-${c.id}-`);
        const sent: RpcMessage[] = [];
        const agent = new AcpAgent({
          makeEngine: async (cwd: string) => buildEngine([cwd], acpStoreDir),
          mode: c.mode ?? "按需确认",
          provider: "strata",
          model: "deepseek-flash",
          send: (m) => sent.push(m),
        });
        await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: workDir, mcpServers: [] } }));
        const sessionId = String((sent.find((m) => m.id === 1)?.result as { sessionId: string }).sessionId);
        let promptId = 2;
        for (const turn of c.turns ?? []) {
          /* ⚠️ 每轮一个**新 id**（审计 G87：原来两轮复用同一个 id —— 拼错了也看不出来） */
          await agent.handleLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: promptId,
              method: "session/prompt",
              params: { sessionId, prompt: [{ type: "text", text: turn }] },
            }),
          );
          promptId += 1;
        }

        /* ③ 比对：模型吐出的正文与调用的工具 */
        const directText = events.filter((e) => e.type === "text").map((e) => e.text ?? "").join("");
        const acpText = sent
          .filter((m) => m.method === "session/update")
          .map((m) => (m.params as { update: { sessionUpdate: string; content?: { text?: string } } }).update)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => u.content?.text ?? "")
          .join("");
        expect(acpText, `${c.id}：两条路的正文不一样`).toBe(directText);

        const directTools = events.filter((e) => e.type === "tool-call").map((e) => e.toolName ?? "");
        const acpTools = sent
          .filter((m) => m.method === "session/update")
          .map((m) => (m.params as { update: { sessionUpdate: string; title?: string } }).update)
          .filter((u) => u.sessionUpdate === "tool_call")
          .map((u) => u.title ?? "");
        expect(acpTools, `${c.id}：两条路的工具调用不一样`).toEqual(directTools);
        /*
         * 工具这一路**至少要有用例真的用上它**（原来三条纯对话 → 恒 [] vs []）。
         * 对不调工具的用例（`chat-single`）不硬要求有调用，但整批里必须有。
         */
        const expectsTools = (c.expect?.events ?? []).includes("tool-call");
        if (expectsTools) {
          expect(directTools.length, `${c.id}：用例要求有工具调用，实际一次都没调`).toBeGreaterThan(0);
        }

        /*
         * ③ 工具调用的**参数**也要一样（审计 G80：原来只比了名字）。
         * 形状：OpenAI 兼容请求体里助手消息的 `tool_calls[].function` = 名字 + 参数字符串。
         */
        type WireMessage = {
          role?: string;
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
        const toolCallsOf = (list: unknown[]): string[] =>
          list
            .flatMap((b) => (b as { messages?: WireMessage[] }).messages ?? [])
            .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
            .flatMap((m) => (m.tool_calls ?? []).map((t) => `${t.function?.name}(${t.function?.arguments})`));
        const directArgs = toolCallsOf(directProvider.bodies);
        const acpArgs = toolCallsOf(acpProvider.bodies);
        if (expectsTools) expect(acpArgs.length, `${c.id}：两条路的工具参数都没抓到（判据失效）`).toBeGreaterThan(0);
        expect(acpArgs, `${c.id}：两条路的工具调用参数不一样`).toEqual(directArgs);

        /* 整批至少有一条是"真的用了工具"的 —— 否则这一格又退化成空比空 */
        toolCallingCases += expectsTools ? 1 : 0;

        /* ① 模型收到的**用户消息**：两条路的请求体逐条相等 */
        const userMessages = (list: unknown[]): string[] =>
          list
            .flatMap((b) => ((b as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []))
            .filter((m) => m.role === "user")
            .map((m) => String(m.content));
        expect(userMessages(acpProvider.bodies), `${c.id}：两条路发给模型的用户消息不一样`).toEqual(
          userMessages(directProvider.bodies),
        );
      } finally {
        await directProvider.close();
        if (acpProvider) await acpProvider.close();
        if (prev.base === undefined) delete process.env.STRATA_BASE_URL;
        else process.env.STRATA_BASE_URL = prev.base;
        if (prev.key === undefined) delete process.env.STRATA_API_KEY;
        else process.env.STRATA_API_KEY = prev.key;
      }
    }
    expect(toolCallingCases, "这批用例一条都不调工具 —— 工具那一路等于没比").toBeGreaterThan(0);
  }, 120_000);
});
