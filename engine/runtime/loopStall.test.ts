import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STALL_TIMEOUT_DEFAULT_MS, runTurn, stallMessage, type TurnEvent } from "./loop";

/**
 * **卡住看门狗**（**审计 P37**）。
 *
 * ## 缺陷形状
 *
 * 一轮对话**没有任何整体/空闲超时**：provider 建了连接但一块数据都不吐
 * （网络黑洞、上游排队、代理挂住）时，`for await (result.fullStream)`
 * 会永远等下去 —— 界面上那个"正在生成"永远转圈，用户只能自己找到停止按钮。
 *
 * ## 判据
 *
 * 起一个**只写响应头、什么都不发**的假 provider，把 `stallTimeoutMs` 压到 300ms：
 *   · `runTurn` 必须在**秒级**返回（不是永远挂着）；
 *   · 结局是**失败** + 一句说得清的错（不是"已中止"—— 用户没点过停止）。
 *
 * 把 `armStall()` 那两处删掉（或不把 watchdog 的信号交给 `streamText`），
 * 这条会**挂住直到 vitest 的超时**——那就是这条守卫的变异实证。
 */
let port = 0;
let server: Server;
/** 这个开关决定假 provider 是"正常吐一句"还是"一个字都不吐"。 */
let stall = true;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (!stall) {
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "deepseek-flash",
            choices: [{ index: 0, delta: { content: "好" }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model: "deepseek-flash",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      /* 一个字都不写、也不 end —— 模拟"连接活着但上游不吐" */
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  process.env.STRATA_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.STRATA_API_KEY = "test-key";
});

afterAll(async () => {
  delete process.env.STRATA_BASE_URL;
  delete process.env.STRATA_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("provider 卡住时不再永远转圈（P37）", () => {
  it("⭐ 一块数据都不来时，看门狗在超时后把人话报出来（而不是永远等）", async () => {
    stall = true;
    const events: TurnEvent[] = [];
    const started = Date.now();
    const outcome = await runTurn(
      {
        provider: "strata",
        system: "用例 stall",
        messages: [{ role: "user", content: "你好" }],
        stallTimeoutMs: 300,
      },
      (e) => events.push(e),
    );
    const elapsed = Date.now() - started;
    expect(elapsed, "卡住时没有在超时后返回 —— 看门狗没接上").toBeLessThan(15_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.aborted, "用户没点停止，不能报成「已中止」").toBe(false);
    expect(outcome.error ?? "").toContain("没有任何输出");
    expect(events.some((e) => e.type === "error")).toBe(true);
  }, 30_000);

  it("默认口径是有限的（不是「关掉」）", () => {
    expect(STALL_TIMEOUT_DEFAULT_MS).toBeGreaterThan(30_000);
    expect(STALL_TIMEOUT_DEFAULT_MS).toBeLessThan(10 * 60 * 1000);
    expect(stallMessage(3000)).toContain("3 秒");
  });

  it("正常吐字的一轮**不受**看门狗影响（不误杀）", async () => {
    stall = false;
    const outcome = await runTurn(
      {
        provider: "strata",
        system: "用例 ok",
        messages: [{ role: "user", content: "你好" }],
        stallTimeoutMs: 300,
      },
      () => {},
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.aborted).toBe(false);
  }, 30_000);
});
