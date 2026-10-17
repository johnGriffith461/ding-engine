import { describe, expect, it } from "vitest";

import { apiUrl, connectOptions, normalizeBaseUrl, parseSse } from "./cmdConnect";

/**
 * 远端客户端（Phase 17 的另一半）—— 这里只钉**纯逻辑**那几件：
 * 地址规范化、SSE 分帧。真正的端到端由 `scripts/verify-remote.mjs` 起一个真服务来跑。
 *
 * ⚠️ SSE 那条是重点：**一次 TCP 分段里可能有多帧、也可能只有半帧**。
 * 按 `\n\n` 切而不留缓冲的写法在真网络上必现 bug（本地回环快、几乎不暴露）——
 * 所以这里专门喂一次"半帧"，断它不会被当成一条事件吃进去。
 */
describe("ding connect 的地址与分帧", () => {
  it("地址补 scheme、去尾斜杠", () => {
    expect(normalizeBaseUrl("127.0.0.1:8899")).toBe("http://127.0.0.1:8899");
    expect(normalizeBaseUrl("http://box.local:8899/")).toBe("http://box.local:8899");
    expect(normalizeBaseUrl("https://a/b/")).toBe("https://a/b");
    expect(apiUrl("box:1", "/v1/info")).toBe("http://box:1/v1/info");
  });

  it("参数：url + 任务（任务可以是多个词）", () => {
    const opts = connectOptions({
      command: "connect",
      args: ["127.0.0.1:1", "把", "这份", "整理一下"],
      flags: new Map([["token", ["t"]]]),
    });
    expect(opts.url).toBe("127.0.0.1:1");
    expect(opts.message).toBe("把 这份 整理一下");
    expect(opts.token).toBe("t");
    expect(opts.listSessions).toBeUndefined();
  });

  it("没有任务 = 只连一下看看对面是谁（不报错）", () => {
    const opts = connectOptions({ command: "connect", args: ["box:1"], flags: new Map() });
    expect(opts.message).toBeUndefined();
    expect(opts.url).toBe("box:1");
  });

  it("解一帧事件", () => {
    const got = parseSse('event: event\ndata: {"type":"text","text":"你好"}\n\n');
    expect(got.events).toEqual([{ event: "event", data: { type: "text", text: "你好" } }]);
    expect(got.rest).toBe("");
  });

  it("一次收到多帧：都要解出来", () => {
    const two =
      'event: event\ndata: {"type":"text","text":"A"}\n\n' + 'event: done\ndata: {"ok":true}\n\n';
    const got = parseSse(two);
    expect(got.events).toHaveLength(2);
    expect(got.events[1]).toEqual({ event: "done", data: { ok: true } });
  });

  it("⭐ 半帧要留着继续攒，不能被当成一条事件", () => {
    const half = 'event: event\ndata: {"type":"text","text":"半';
    const first = parseSse(half);
    expect(first.events).toHaveLength(0);
    expect(first.rest).toBe(half);
    // 后半截到了 → 这时候才解出完整的那一帧
    const second = parseSse(first.rest + '半"}\n\n');
    expect(second.events).toEqual([{ event: "event", data: { type: "text", text: "半半" } }]);
    expect(second.rest).toBe("");
  });

  it("坏 JSON 不当场炸（丢掉这一帧、后面的照收）", () => {
    const got = parseSse('event: event\ndata: {不是 JSON\n\nevent: done\ndata: {"ok":true}\n\n');
    expect(got.events).toHaveLength(2);
    expect(got.events[1]).toEqual({ event: "done", data: { ok: true } });
  });
});
