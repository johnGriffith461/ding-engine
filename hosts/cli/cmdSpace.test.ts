import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cmdSpace } from "./cmdSpace";
import { createSpaceStore } from "../../engine/adapters/spaceStore";
import { rolesIn } from "../../engine/core/space";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { chatSessionId, type LogInput } from "../../engine/core/events";

/**
 * **`ding space`：团队空间的本机入口**（V5-3 的产品面）。
 *
 * 这一组不测"输出好不好看"，测**账本真的被改了**：发码进账本、兑码后名册里多一个人
 * 且拿到口令、改角色/移除（口令一并作废）、共享与指定持有人、账本与审计读的是**真会话库**。
 *
 * 为什么必须有它：这一族之前只有服务端路由（`/v1/space/*`），
 * 而"本机直接改账本"是另一条写路径 —— 两条路径的规矩（谁不能改自己、一码一人、
 * 移除要连口令一起删）**必须一模一样**（都来自 `engine/core/space.ts` 那几个纯函数）。
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为（Windows） */
    }
  }
});
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-cli-space-"));
  dirs.push(dir);
  return dir;
};

/** 跑一条子命令，收它的 stdout。 */
async function run(dataDir: string, args: string[], flags: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    const code = await cmdSpace(
      { command: "space", args, flags: new Map(Object.entries(flags).map(([k, v]) => [k, [v]])) } as never,
      dataDir,
    );
    return { code, out: lines.join("") };
  } finally {
    spy.mockRestore();
  }
}

/** 从"配对码：XXXX"那一行取码。 */
const codeOf = (out: string): string => /配对码：([0-9A-Z]{8})/.exec(out)?.[1] ?? "";
/** 从"口令：sk-…"那一行取口令。 */
const tokenOf = (out: string): string => /口令：(sk-[A-Za-z0-9_-]+)/.exec(out)?.[1] ?? "";

/** 读当前账本（读不出来就抛 —— 测试里那不是合法状态）。 */
function spaceNow(dir: string) {
  const got = createSpaceStore(dir).read();
  if (got.status !== "ok") throw new Error(`空间账读不出来：${got.status}`);
  return got.space;
}

describe("ding space（本机入口）", () => {
  it("⭐ 发码 → 入团 → 名册：账本真的变了，口令只给一次", async () => {
    const dir = tmpDir();
    /* 空账：先看一眼现状 */
    const empty = await run(dir, []);
    expect(empty.code).toBe(0);
    /* 空账 = 只有主人（名册里那一行是 `createRoster` 放的：不放进来的话他自己都发不了码） */
    expect(empty.out).toContain("空间主人：local");
    expect(empty.out).toContain("成员（1）");
    expect(empty.out).toContain("角色 owner");

    /* 发码（默认只读起步） */
    const invited = await run(dir, ["invite"]);
    expect(invited.code).toBe(0);
    const code = codeOf(invited.out);
    expect(code).toMatch(/^[0-9A-Z]{8}$/);
    expect(invited.out).toContain("viewer");
    /* 账本里真有这张码（没兑过） */
    expect(spaceNow(dir).roster.codes.length).toBe(1);

    /* 入团：拿到口令，名册里多一个人 */
    const joined = await run(dir, ["join", code], { as: "alice", name: "Alice" });
    expect(joined.code).toBe(0);
    const token = tokenOf(joined.out);
    expect(token).toMatch(/^sk-/);
    const after = spaceNow(dir);
    expect(rolesIn(after.roster, "alice")).toEqual(["viewer"]);
    expect(after.tokens.alice).toBe(token);
    /* 一码一人：同一张码再兑一次不行 */
    const again = await run(dir, ["join", code], { as: "bob" });
    expect(again.code, "一码一人：同一张码不该能兑第二次").toBe(1);

    const members = await run(dir, ["members"]);
    expect(members.out).toContain("alice");
  });

  it("⭐ 改角色 / 移除：不能动主人，移除要连口令一起作废", async () => {
    const dir = tmpDir();
    const code = codeOf((await run(dir, ["invite", "--roles", "viewer,admin"])).out);
    await run(dir, ["join", code], { as: "bob" });
    const promoted = await run(dir, ["roles", "bob", "specialist"]);
    expect(promoted.code).toBe(0);
    expect(rolesIn(spaceNow(dir).roster, "bob")).toEqual(["specialist"]);

    /* 主人不能被改（自己给自己升权是这类模型最经典的洞） */
    const self = await run(dir, ["roles", "local", "viewer"]);
    expect(self.code).toBe(1);

    const removed = await run(dir, ["remove", "bob"]);
    expect(removed.code).toBe(0);
    const after = spaceNow(dir);
    expect(after.roster.members.some((m) => m.id === "bob")).toBe(false);
    expect(after.tokens.bob, "口令要一并作废（不然移除只是「以后不行」）").toBeUndefined();
  });

  it("⭐ 共享 → 指定持有人：未共享时拒绝（先共享再接管那条规矩）", async () => {
    const dir = tmpDir();
    const code = codeOf((await run(dir, ["invite"])).out);
    await run(dir, ["join", code], { as: "alice" });
    const sessionId = chatSessionId("cli-space");

    /* 没共享就指定持有人：拒（"先共享再接管"那条规矩在 CLI 这条路上也成立） */
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    let tooEarly = 0;
    try {
      tooEarly = (await run(dir, ["takeover", sessionId], { as: "alice" })).code;
    } finally {
      spy.mockRestore();
    }
    expect(tooEarly).toBe(1);
    expect(errors.join("")).toContain("先 ding space share");

    const shared = await run(dir, ["share", sessionId]);
    expect(shared.code).toBe(0);
    const taken = await run(dir, ["takeover", sessionId], { as: "alice" });
    expect(taken.code).toBe(0);
    expect(spaceNow(dir).holders[sessionId]).toBe("alice");

    /* 取消共享：清单里没了 */
    await run(dir, ["unshare", sessionId]);
    expect(spaceNow(dir).shared).toEqual([]);
  });

  it("⭐ usage / audit 读的是**真会话库**（不是空账）", async () => {
    const dir = tmpDir();
    const store = createSqliteSessionStore(dir);
    const sessionId = chatSessionId("cli-space-usage");
    await store.append(sessionId, [
      { requestId: "r1", type: "request", provider: "strata", model: "deepseek-flash", messages: [{ role: "user", content: "你好" }], actor: { id: "alice", kind: "user" } } as LogInput,
      { requestId: "r1", type: "done", usage: { inputTokens: 120, outputTokens: 30 }, actor: { id: "main", kind: "agent" } } as LogInput,
    ]);
    store.close();

    const usage = await run(dir, ["usage", "--by", "member"]);
    expect(usage.code).toBe(0);
    expect(usage.out).toContain("1 轮");
    expect(usage.out).toContain("alice");

    const audit = await run(dir, ["audit"]);
    expect(audit.code).toBe(0);
    expect(audit.out).toContain("留痕");
    expect(audit.out).toContain("alice");
  });

  it("⭐ 房间：账本只存房间号、密钥在输出里给一次、--server 能拼出完整链接", async () => {
    const dir = tmpDir();
    const sessionId = chatSessionId("cli-space-room");
    /* 先共享（房间是给另一端进的） */
    expect((await run(dir, ["share", sessionId])).code).toBe(0);

    /* 没共享的会话建不了房间 */
    const tooEarly = await run(dir, ["room", chatSessionId("cli-space-other")], { server: "https://example.test" });
    expect(tooEarly.code).toBe(1);

    const made = await run(dir, ["room", sessionId], { server: "https://example.test" });
    expect(made.code).toBe(0);
    const roomId = /房间号：(r-[a-z0-9]+)/.exec(made.out)?.[1] ?? "";
    const key = /密钥：([A-Za-z0-9_-]+)/.exec(made.out)?.[1] ?? "";
    expect(roomId).toMatch(/^r-/);
    expect(key).not.toBe("");
    /* 链接：密钥在 **#** 之后（服务端收不到） */
    expect(made.out).toContain(`https://example.test/r/${roomId}#${key}`);

    /* 账本里只有房间号 —— 把整份账本序列化也找不到密钥 */
    const stored = JSON.stringify(spaceNow(dir));
    expect(stored).toContain(roomId);
    expect(stored.includes(key), "密钥落进账本了（零知识就没了）").toBe(false);

    /* 列出来看得到 */
    const listed = await run(dir, ["rooms"]);
    expect(listed.out).toContain(roomId);
  });

  it("不认识的子命令：退出码非零 + 把可用的列出来", async () => {
    const dir = tmpDir();
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    let code = 0;
    try {
      code = await cmdSpace({ command: "space", args: ["bogus"], flags: new Map() } as never, dir);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    expect(errors.join("")).toContain("不认识的子命令");
  });

  it("--json：给脚本用（结构化，不是人话）", async () => {
    const dir = tmpDir();
    const got = await run(dir, ["invite"], { json: "1" });
    const parsed = JSON.parse(got.out) as { code: string; roles: string[] };
    expect(parsed.code).toMatch(/^[0-9A-Z]{8}$/);
    expect(parsed.roles).toEqual(["viewer"]);
  });
});
