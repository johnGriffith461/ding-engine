import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEngine, type EnginePorts, type EngineRunRequest } from "./index";
import type { Actor, LogInput, LogRecord } from "./core/events";
import type { SessionStore } from "./ports/store";

/**
 * 内核 `run()` 的四件事（**审计 P36 / P38 / P126 / P127**）。
 *
 * ## 为什么这一组必须存在
 *
 * 这四条都是"引擎该做而没做"的形状，而它们**都落在 `run()` 这一个函数里**，
 * 所以用一张假的 `SessionStore` + 一个只回一句话的假 provider 就能真跑：
 *
 * | 条目 | 缺陷 | 这里的判据 |
 * |---|---|---|
 * | P38 | `void record()` 落盘失败 = unhandled rejection（CLI 侧会打死进程） | 落盘抛错时 `run()` **照样 resolve**，且把原因带回 `recordErrors` |
 * | P36 | 中止路径只记日志、**不发终态事件** | 中止时宿主的 `onEvent` 收到一条终态事件（不再永远转圈） |
 * | P126 | Recipe 的 `tools` 白名单**一行都没接** | 给了 `only` 之后，路由到模型的工具集就是白名单那几件 |
 * | P127 | `--continue` 没有任何历史（凭空重跑） | 给了 `history` 之后，`request` 记录里就是"历史 + 这一轮" |
 */
let port = 0;
let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "好" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
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

/** 假的会话库：记在内存里；可以按开关让 `append` 抛错（P38 要它）。 */
function memoryStore(opts: { failAppend?: boolean } = {}): SessionStore & { all(): LogRecord[]; ownerOf(id: string): string | undefined } {
  const log: LogRecord[] = [];
  const owners = new Map<string, string>();
  let seq = 0;
  return {
    append: async (sessionId: string, records: readonly LogInput[], appendOpts?: { owner?: string }) => {
      if (opts.failAppend) throw new Error("磁盘满了（测试造）");
      /*
       * C1 的口径照实现抄一份（首次写入定归属 + 冲突拒绝）——
       * 这条假库要能替真库回答"内核有没有把 owner 传下来"。
       */
      if (appendOpts?.owner) {
        const existing = owners.get(sessionId);
        if (existing !== undefined && existing !== appendOpts.owner) throw new Error(`会话归属冲突：${sessionId}`);
        owners.set(sessionId, appendOpts.owner);
      } else if (!owners.has(sessionId)) {
        owners.set(sessionId, "local");
      }
      const stored = records.map((r) => ({ ...r, seq: (seq += 1), at: Date.now() }) as LogRecord);
      log.push(...stored);
      return stored;
    },
    load: async (sessionId: string, loadOpts?: { owner?: string }) => {
      const owner = owners.get(sessionId);
      if (loadOpts?.owner && owner !== undefined && owner !== loadOpts.owner) {
        return { records: [], skipped: 0, denied: "owner" as const };
      }
      return { records: log, skipped: 0 };
    },
    search: async () => [],
    list: async () => [],
    prune: async () => ({ deleted: [], kept: 0 }),
    close: () => {},
    all: () => log,
    ownerOf: (id: string) => owners.get(id),
  };
}

const executor = { run: async () => ({ ok: true }) };

function engineWith(store: SessionStore) {
  return createEngine({ store, executor } as EnginePorts);
}

const baseRequest = (sessionId: string): EngineRunRequest => ({
  sessionId,
  provider: "strata",
  messages: [{ role: "user", content: "你好" }],
  mode: "全部允许",
  useTools: true,
});

describe("P38：落盘失败不许变成 unhandled rejection", () => {
  it("⭐ `append` 抛错时 run() 仍然 resolve，并把原因带回 recordErrors", async () => {
    const store = memoryStore({ failAppend: true });
    const out = await engineWith(store).run(baseRequest("p38-session"));
    expect(out.recordErrors?.length, "落盘失败必须被如实带回来（不能静默）").toBeGreaterThan(0);
    expect(out.recordErrors?.[0]).toContain("磁盘满了");
  }, 20_000);
});

describe("P36：中止要有终态事件", () => {
  it("⭐ 中止时宿主收到一条终态事件（不然界面上永远在转圈）", async () => {
    const store = memoryStore();
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];
    const out = await engineWith(store).run({
      ...baseRequest("p36-session"),
      abortSignal: controller.signal,
      onEvent: (e) => events.push(e.type),
    });
    expect(out.aborted).toBe(true);
    expect(events, "中止路径没有给宿主任何终态事件").toContain("error");
    expect(
      store.all().some((r) => (r as { message?: string }).message === "已中止"),
      "日志里那条中止记录还要在（事件与记录同一出口）",
    ).toBe(true);
  }, 20_000);
});

describe("P126：模板的 tools 白名单真的接上", () => {
  it("⭐ 给了 only 之后，下发给模型的就是那几件（`request` 记录为证）", async () => {
    const store = memoryStore();
    await engineWith(store).run({ ...baseRequest("p126-session"), only: ["read_file"] });
    const request = store.all().find((r) => (r as { type?: string }).type === "request") as
      | { tools?: string[] }
      | undefined;
    expect(request?.tools, "request 记录里没有 tools 字段").toBeTruthy();
    expect(request!.tools, "白名单没生效：记录里工具不止 read_file").toEqual(["read_file"]);
  }, 20_000);
});

describe("P127：history 真的进这一轮（不再是凭空重跑）", () => {
  it("⭐ 历史 + 这一轮都进 request 记录（不变量 1：记的就是模型看见的）", async () => {
    const store = memoryStore();
    await engineWith(store).run({
      ...baseRequest("p127-session"),
      history: [
        { role: "user", content: "上一轮我说了什么" },
        { role: "assistant", content: "你说了 A" },
      ],
      messages: [{ role: "user", content: "那接着做 B" }],
    });
    const request = store.all().find((r) => (r as { type?: string }).type === "request") as
      | { messages?: Array<{ role: string; content: string }> }
      | undefined;
    expect(request?.messages?.map((m) => m.content)).toEqual([
      "上一轮我说了什么",
      "你说了 A",
      "那接着做 B",
    ]);
  }, 20_000);

  it("不给 history 时行为与从前一致（只有这一轮）", async () => {
    const store = memoryStore();
    await engineWith(store).run(baseRequest("p127-none"));
    const request = store.all().find((r) => (r as { type?: string }).type === "request") as
      | { messages?: Array<{ content: string }> }
      | undefined;
    expect(request?.messages?.map((m) => m.content)).toEqual(["你好"]);
  }, 20_000);
});

/**
 * C5：事件 actor 维度（V5-1 3.4）。
 *
 * 判据是"**新写入全带**"（V5 §3.1 的口径）：`request` 那条 = 发起人，
 * 这一轮里 agent 写的事件 = 主循环；标注发生在内核的**记录出口那一处**
 * （每个 emit 点各标一次迟早会漏 —— 那正是这条用例要挡住的方式）。
 */
describe("C5：actor 维度（谁写的）", () => {
  it("⭐ 默认：request → 本机用户；这一轮的事件全 → 主循环 agent", async () => {
    const store = memoryStore();
    await engineWith(store).run(baseRequest("c5-default"));
    const all = store.all();
    expect(all.length, "这一轮一条记录都没有？").toBeGreaterThan(1);

    const request = all.find((r) => r.type === "request") as { actor?: Actor } | undefined;
    expect(request?.actor, "request 记录没带 actor").toEqual({ id: "local", kind: "user" });

    const events = all.filter((r) => r.type !== "request");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect((event as { actor?: Actor }).actor, `事件 ${event.type} 没带 actor`).toEqual({ id: "main", kind: "agent" });
    }
  }, 20_000);

  it("宿主给了 actor 就用它（request 那条）——将来接成员身份就是从这里进去的", async () => {
    const store = memoryStore();
    await engineWith(store).run({ ...baseRequest("c5-custom"), actor: { id: "u-42", kind: "user" } });
    const request = store.all().find((r) => r.type === "request") as { actor?: Actor } | undefined;
    expect(request?.actor).toEqual({ id: "u-42", kind: "user" });
  }, 20_000);

  it("⭐ 体积预算（V5 §8）：一条记录的 actor 字段 ≤ 40 字节（三种标准形状实测）", () => {
    const shapes: Actor[] = [
      { id: "local", kind: "user" },
      { id: "main", kind: "agent" },
      { id: "system", kind: "system" },
    ];
    for (const actor of shapes) {
      /* 与落盘形态同一口径：记录被 JSON.stringify 时 actor 增了多少字节 */
      const base = JSON.stringify({ seq: 1, at: 0, requestId: "r", type: "text", text: "" });
      const withActor_ = JSON.stringify({ seq: 1, at: 0, requestId: "r", type: "text", text: "", actor });
      const delta = Buffer.byteLength(withActor_) - Buffer.byteLength(base);
      expect(delta, `actor=${JSON.stringify(actor)} 让每条记录胖了 ${delta} 字节`).toBeLessThanOrEqual(40);
    }
  });
});

/**
 * C1（V5-1 3.5）：会话归属。
 *
 * 这一层只管**两件接线**（校验本身在存储与 resume 的纯逻辑里，各有各的用例）：
 *   · `run()` 把 `ownerActor` 传给存储（新会话的归属从这一刻定下来）；
 *   · `resume(sessionId, {owner})` 把存储回的 `denied` **翻成"空会话 + 说清原因"**，
 *     而不是让调用方以为"这段历史是空的"。
 */
describe("C1：会话归属（ownerActor / resume 校验）", () => {
  it("⭐ run 给了 ownerActor：存储收到它（新会话的归属）", async () => {
    const store = memoryStore();
    await engineWith(store).run({ ...baseRequest("c1-owned"), ownerActor: { id: "alice", kind: "user" } });
    expect(store.ownerOf("c1-owned"), "ownerActor 没有传到存储 —— 新会话的归属就丢了").toBe("alice");
  });

  it("不给 ownerActor：老路径照旧（存储按兼容口径落 local）", async () => {
    const store = memoryStore();
    await engineWith(store).run(baseRequest("c1-default"));
    expect(store.ownerOf("c1-default")).toBe("local");
  });

  it("⭐ resume 跨 owner：不返回内容，并如实标 denied（不是「这段历史是空的」）", async () => {
    const store = memoryStore();
    const engine = engineWith(store);
    await engine.run({ ...baseRequest("c1-read"), ownerActor: { id: "alice", kind: "user" } });

    const alien = await engine.resume("c1-read", { owner: "bob" });
    expect(alien.turns, "陌生 owner 拿到了内容").toEqual([]);
    expect(alien.denied).toBe("owner");

    /* 本主与老路径（不给 owner）都读得到 */
    expect((await engine.resume("c1-read", { owner: "alice" })).turns.length).toBeGreaterThan(0);
    expect((await engine.resume("c1-read")).denied).toBeUndefined();
  });
});
