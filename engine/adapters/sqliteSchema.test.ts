import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openSqlite } from "./sqliteDriver";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaDowngradeError,
  pendingMigrations,
  runMigrations,
  schemaLedger,
  type MigrationStep,
} from "./sqliteSchema";
import { createSqliteSessionStore } from "./sqliteStore";
import { chatSessionId, LEGACY_ACTOR } from "../core/events";

/**
 * 会话库的**版本化迁移链**（V5-1 任务 3.3a；ADR-005）。
 *
 * ## 这些断言要挡住什么
 *
 * 记住一句：**迁移出错不会崩，只会悄悄少东西或悄悄改写**。所以这里钉的是四件事：
 *   ① **三态**都要过：空库（建基线）/ 旧库（认领 + 补步）/ 已迁移库（幂等，一个字节不动）；
 *   ② **不可降级**：库比程序新 → 拒绝（把新结构按老口径解释 = 静默损坏）；
 *   ③ **迁移前后重放 diff=0**（§3.1 的熔断数据纪律）：老库里已有的记录，
 *      迁移后逐条读回来必须一模一样（含 `seq` / `at`）；
 *   ④ **失败回滚**：某一步炸了 → 库停在旧版本、那一步的副作用不留。
 */

let dir: string;
let opened: { close(): void }[] = [];

/** 本用例建过的 store（句柄没放之前临时目录删不掉 —— Windows 硬失败）。 */
function openStore(d = dir) {
  const store = createSqliteSessionStore(d);
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-schema-"));
  opened = [];
});

afterEach(() => {
  for (const store of opened) store.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 尽力而为：Windows 上的占用是一次性冲突，别让它把通过的用例判红 */
  }
});

/** 迁移链自己的形状：版本连续 1..N，`SCHEMA_VERSION` 就是最后一版（两者不许各说各话）。 */
describe("迁移链的账本形状", () => {
  it("版本号连续、且 SCHEMA_VERSION 等于最后一步（新增一步忘了改常量就会红）", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...Array(versions.length)].map((_, i) => i + 1));
    expect(SCHEMA_VERSION).toBe(versions[versions.length - 1]);
    for (const step of MIGRATIONS) expect(step.name.trim().length, `v${step.version} 没有名字`).toBeGreaterThan(0);
  });
});

describe("三态：空库 / 旧库 / 已迁移库", () => {
  it("⭐ 空库：建基线 + 全链跑完 + 账本从 v1 记到 SCHEMA_VERSION", () => {
    const file = path.join(dir, "sessions.db");
    const db = openSqlite(file);
    const report = runMigrations(db, 1_700_000_000_000);

    expect(report).toMatchObject({ from: 0, to: SCHEMA_VERSION, applied: MIGRATIONS.map((m) => m.version), adopted: [] });
    expect(schemaLedger(db).map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
    /* 记账时间用的是传进去的那个时刻（可复现） */
    expect(schemaLedger(db)[0]!.appliedAt).toBe(new Date(1_700_000_000_000).toISOString());
    /* PRAGMA 与账本**同口径**（老程序只认 PRAGMA，降级保护靠它） */
    const pragma = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0);
    expect(pragma).toBe(SCHEMA_VERSION);
    /* 基线真的建出来了 */
    for (const t of ["sessions", "events", "schema_version"]) {
      expect(Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(t)), `没有 ${t} 表`).toBeTruthy();
    }
    db.close();
  });

  it("⭐ 旧库（两表在、没有 body 列、没有任何版本记录）：认领 v1 + 补 v2，且新旧账分开记", () => {
    const file = path.join(dir, "sessions.db");
    const now = Date.now();
    const raw = openSqlite(file);
    /* 造一份**当年那份**形状的库：没有 body 列、没有 schema_version、user_version = 0 */
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE INDEX idx_events_session ON events(session_id, seq);
    `);
    const sid = chatSessionId("legacy");
    const p1 = JSON.stringify({ seq: 1, at: now, requestId: "r1", type: "request", messages: [{ role: "user", content: "三个月前聊过预算" }] });
    const p2 = JSON.stringify({ seq: 2, at: now, requestId: "r1", type: "text", text: "收到，先看预算表。" });
    raw.prepare("INSERT INTO events(session_id, seq, at, type, payload) VALUES(?,?,?,?,?)").run(sid, 1, now, "request", p1);
    raw.prepare("INSERT INTO events(session_id, seq, at, type, payload) VALUES(?,?,?,?,?)").run(sid, 2, now, "text", p2);
    raw.prepare("INSERT INTO sessions(id, kind, title, updated_at, bytes) VALUES(?,?,?,?,?)").run(sid, "chat", "", now, 0);

    /*
     * 表在 = 基线（v1）已经应用过（最老那代连 `user_version` 都没写）——
     * 所以待跑只剩它之后的每一步；v1 属于"认领"，不算这次跑的。
     */
    const afterBaseline = MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version);
    expect(pendingMigrations(raw).map((m) => m.version), "只该剩 v1 之后的每一步（v1 = 基线已在）").toEqual(afterBaseline);
    const report = runMigrations(raw, now);
    expect(report.adopted, "v1 是认领来的（上线前就已应用），不该说成这次跑的").toEqual([1]);
    expect(report.applied, "只有 v1 之后的那些是这次真跑的").toEqual(afterBaseline);
    expect(report).toMatchObject({ from: 1, to: SCHEMA_VERSION });
    /* 补了列、回填了正文（external-content 的 FTS 不会自动索引老行 —— 这一格就是 P101 那件事） */
    const body = String((raw.prepare("SELECT body FROM events WHERE session_id = ? AND seq = 1").get(sid) as { body?: string })?.body ?? "");
    expect(body).toContain("预算");
    raw.close();

    /* 表结构补齐之后，正常打开的 store 能读回老记录（下一条用例是逐条 diff） */
    const after = openSqlite(file);
    expect(pendingMigrations(after)).toEqual([]);
    after.close();
  });

  it("⭐ v6 的三张表在（画布事件 / 画布归属 / 审批索引），且旧库里的待决会被回填", () => {
    const file = path.join(dir, "sessions.db");
    const now = Date.now();
    const raw = openSqlite(file);
    /* 造一个**停在 v5** 的库：跑前五步，再塞进一条待决与一条决策 */
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT 'local', forked_from TEXT);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT 'legacy', actor_kind TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY (session_id, seq));
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    `);
    for (const step of MIGRATIONS.filter((m) => m.version <= 5)) {
      raw.prepare("INSERT INTO schema_version(version, name, applied_at) VALUES(?,?,?)").run(step.version, step.name, new Date(now).toISOString());
    }
    const sid = chatSessionId("v5-with-pending");
    const pending = JSON.stringify({
      seq: 1,
      at: now,
      requestId: "r1",
      type: "tool-result",
      toolCallId: "c1",
      toolName: "write_file",
      output: { pending: true, notice: "等确认", approvers: ["local"] },
    });
    raw.prepare("INSERT INTO events(session_id, seq, at, type, payload) VALUES(?,?,?,?,?)").run(sid, 1, now, "tool-result", pending);
    raw.prepare("INSERT INTO sessions(id, kind, title, updated_at, bytes, owner) VALUES(?,?,?,?,?,?)").run(sid, "chat", "", now, 0, "local");

    expect(pendingMigrations(raw).map((m) => m.version), "停 v5 的库只该剩 v6 待跑").toEqual([6]);
    const report = runMigrations(raw, now);
    expect(report).toMatchObject({ from: 5, to: SCHEMA_VERSION, applied: [6] });

    /* 三张表都在 */
    for (const table of ["canvases", "canvas_events", "approvals"]) {
      expect(Boolean(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)), `缺表：${table}`).toBe(true);
    }
    /* 回填：旧库里那条待决进了索引（审批人照原样，不编） */
    const row = raw.prepare("SELECT state, approvers FROM approvals WHERE session_id = ? AND tool_call_id = ?").get(sid, "c1") as
      | { state?: string; approvers?: string }
      | undefined;
    expect(row?.state).toBe("pending");
    expect(JSON.parse(String(row?.approvers))).toEqual(["local"]);
    raw.close();
  });

  it("⭐ 已迁移库：再跑一次**一个字节都不动**（幂等 —— 每次打开都会跑它）", async () => {
    /*
     * ⚠️ 自己建、自己关（不进 `opened` —— afterEach 会再关一次，第二次是
     * "database is not open"；`sqliteStore.test.ts` 里同一条坑有更早的记录）
     */
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId("a"), [
      { seq: 1, at: Date.now(), requestId: "r", type: "request", messages: [{ role: "user", content: "写一句" }] } as never,
    ]);
    store.close();

    const db = openSqlite(path.join(dir, "sessions.db"));
    const before = schemaLedger(db);
    const report = runMigrations(db, 1);
    expect(report.applied).toEqual([]);
    expect(report.adopted, "账本已经在，就不该再认领一遍").toEqual([]);
    expect(schemaLedger(db), "重跑把 applied_at 重写了（记账不再可信）").toEqual(before);
    db.close();
  });
});

describe("不可降级（ADR-005 的闸门）", () => {
  it("⭐ 库比程序新：拒绝，并把两个版本号都说出来", () => {
    const file = path.join(dir, "sessions.db");
    const db = openSqlite(file);
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, kind TEXT, title TEXT, updated_at INTEGER, bytes INTEGER)");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 41}`);
    expect(() => runMigrations(db)).toThrow(SchemaDowngradeError);
    try {
      runMigrations(db);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(`v${SCHEMA_VERSION + 41}`);
      expect(message).toContain(`v${SCHEMA_VERSION}`);
    }
    db.close();
  });

  it("账本写着新版本（PRAGMA 被抹掉也算数）：一样拒绝", () => {
    const file = path.join(dir, "sessions.db");
    const db = openSqlite(file);
    runMigrations(db);
    db.prepare("INSERT INTO schema_version(version, name, applied_at) VALUES(?,?,?)").run(SCHEMA_VERSION + 7, "未来的一步", "2999-01-01T00:00:00.000Z");
    db.exec("PRAGMA user_version = 0");
    expect(() => runMigrations(db)).toThrow(SchemaDowngradeError);
    db.close();
  });
});

describe("熔断数据纪律：迁移前后重放 diff=0（§3.1）", () => {
  it("⭐ 老库里已有的记录，迁移后逐条读回来一模一样（含 seq/at），只多了一列正文", async () => {
    const file = path.join(dir, "sessions.db");
    const now = Date.now();
    const raw = openSqlite(file);
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
    `);
    const sid = chatSessionId("diff");
    const payloads = [
      JSON.stringify({ seq: 1, at: now - 5000, requestId: "r9", type: "request", provider: "deepseek", model: "deepseek-chat", messages: [{ role: "user", content: "迁移前写下的一句" }] }),
      JSON.stringify({ seq: 2, at: now - 4000, requestId: "r9", type: "text", text: "迁移前写下的回答" }),
      JSON.stringify({ seq: 3, at: now - 3000, requestId: "r9", type: "done", usage: { inputTokens: 3, outputTokens: 5 } }),
    ];
    payloads.forEach((payload, i) => {
      raw.prepare("INSERT INTO events(session_id, seq, at, type, payload) VALUES(?,?,?,?,?)").run(sid, i + 1, now - 5000 + i * 1000, i === 0 ? "request" : "text", payload);
    });
    raw.prepare("INSERT INTO sessions(id, kind, title, updated_at, bytes) VALUES(?,?,?,?,?)").run(sid, "chat", "迁移前的标题", now, 0);
    raw.close();

    const store = openStore();
    const { records } = await store.load(sid);
    /*
     * 迁移把老记录**逐条原样**读回来 —— 除了 `actor`：那是 C5 的读兼容口径
     * （老记录没有这个字段 → 读回时填 legacy，磁盘上那份没被改，见 events.test.ts）。
     */
    expect(records, "迁移把老记录改写了（或漏了）").toEqual(payloads.map((p) => ({ ...JSON.parse(p), actor: LEGACY_ACTOR })));
    /* 列表/标题也不受迁移影响 */
    expect((await store.list()).map((x) => x.conversationId)).toEqual(["diff"]);
  });

  it("库文件在跑链之前被留了一份 `.pre-migrate.bak`（V5 §3.1 的「迁移前自动快照」）", () => {
    const file = path.join(dir, "sessions.db");
    const raw = openSqlite(file);
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
    `);
    raw.close();

    openStore(); /* 打开 = 跑链（这份库有 pending） */
    expect(readdirSync(dir).some((f) => f.endsWith(".pre-migrate.bak")), "迁移前没有留备份").toBe(true);

    /* 已迁移的库再打开一次：不重复备份（备份只该在"真的要动结构"那一刻发生） */
    const stale = readdirSync(dir).filter((f) => f.endsWith(".pre-migrate.bak")).length;
    openStore();
    expect(readdirSync(dir).filter((f) => f.endsWith(".pre-migrate.bak")).length).toBe(stale);
  });
});

describe("失败回滚：某一步炸了，库停在旧版本", () => {
  it("⭐ 抛错 + 已跑的不回退 + 没跑到的副作用不留 + 版本号不前进", () => {
    const file = path.join(dir, "sessions.db");
    const db = openSqlite(file);
    const failing: MigrationStep = {
      version: SCHEMA_VERSION + 1,
      name: "故意炸的一步",
      apply: (d) => {
        d.exec("CREATE TABLE IF NOT EXISTS half_done(x TEXT)");
        d.exec("INSERT INTO half_done(x) VALUES('应该被回滚掉')");
        throw new Error("这一步故意炸");
      },
    };

    expect(() => runMigrations(db, Date.now(), [...MIGRATIONS, failing])).toThrow(
      new RegExp(`迁移 v${SCHEMA_VERSION + 1}（故意炸的一步）失败`),
    );
    const pragma = Number((db.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0);
    expect(pragma, "失败的迁移把版本号推上去了").toBe(SCHEMA_VERSION);
    expect(schemaLedger(db).map((r) => r.version), "失败的那一步被记进了账本").toEqual(MIGRATIONS.map((m) => m.version));
    /*
     * SQLite 的 DDL 是事务性的：那一步建的表**整个被回滚掉**（比"表在但空"更干净）。
     * 判据问 sqlite_master，不问"表里有没有行"。
     */
    const leftover = db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get();
    expect(leftover, "失败步骤建的半张表留下了").toBeUndefined();
    db.close();
  });
});

/** 备份文件不该在全新库上出现（没有任何东西可保）。 */
describe("顺带：全新库不产生备份", () => {
  it("空目录直接开 store：没有 .pre-migrate.bak", () => {
    openStore();
    expect(existsSync(path.join(dir, "sessions.db"))).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".pre-migrate.bak"))).toEqual([]);
  });
});

/**
 * C5（V5-1 3.4）：v3 那一步给 `events` 加的 actor 两列。
 *
 * 为什么要有**列**（payload 里已经有 actor 了）：审计要问"某人做过什么"，
 * 不该把每行 JSON 解一遍。口径：两列与 payload **同一口径**（缺字段 = legacy）。
 */
describe("C5：actor 两列（迁移 v3）", () => {
  it("⭐ 新写入：payload 里的 actor 原样落到两列；没有 actor 的记录落 'legacy'", async () => {
    const store = openStore();
    const sid = chatSessionId("c5");
    await store.append(sid, [
      { seq: 1, at: Date.now(), requestId: "r", type: "request", messages: [{ role: "user", content: "我来" }] } as never,
    ]);
    await store.append(sid, [
      /* 带 actor 的事件（内核会这么写） */
      { requestId: "r", type: "text", text: "我来回", actor: { id: "main", kind: "agent" } } as never,
      /* 没有 actor 的（旧调用方 / 老记录）：两列必须是 legacy，payload 里不许被编出字段 */
      { requestId: "r", type: "text", text: "无主" } as never,
    ]);

    const db = openSqlite(path.join(dir, "sessions.db"));
    const rows = db.prepare("SELECT seq, actor_id, actor_kind, payload FROM events WHERE session_id = ? ORDER BY seq").all(sid) as {
      seq: number;
      actor_id: string;
      actor_kind: string;
      payload: string;
    }[];
    expect(rows.map((r) => [r.actor_id, r.actor_kind])).toEqual([
      ["legacy", "legacy"],
      ["main", "agent"],
      ["legacy", "legacy"],
    ]);
    /* payload 是真相，列只是索引：没标 actor 的那条**不许**被存储偷偷补上字段 */
    expect(rows[2]!.payload).not.toContain("actor");
    db.close();
  });

  it("v3 之前的库（老行）：两列补出来就是 'legacy'（补列即完整迁移，不需要搬值）", () => {
    const file = path.join(dir, "sessions.db");
    const raw = openSqlite(file);
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_id, seq));
    `);
    raw.prepare("INSERT INTO events(session_id, seq, at, type, payload, body) VALUES(?,?,?,?,?,?)").run(
      chatSessionId("old"),
      1,
      Date.now(),
      "text",
      JSON.stringify({ seq: 1, at: Date.now(), requestId: "r", type: "text", text: "老话" }),
      "老话",
    );
    runMigrations(raw);
    const row = raw.prepare("SELECT actor_id, actor_kind FROM events WHERE session_id = ?").get(chatSessionId("old")) as {
      actor_id: string;
      actor_kind: string;
    };
    expect([row.actor_id, row.actor_kind]).toEqual(["legacy", "legacy"]);
    raw.close();
  });
});

/**
 * C1（V5-1 3.5）：v4 那一步给 `sessions` 加的 `owner`。
 *
 * 兼容矩阵的明文口径：**旧会话零迁移可读** —— 补列即完整迁移，老会话按 `local` 读。
 */
describe("C1：sessions.owner（迁移 v4）", () => {
  it("⭐ 老库（没有 owner 列的会话行）：补列之后按 'local' 读，旧数据一字不动", async () => {
    const file = path.join(dir, "sessions.db");
    const raw = openSqlite(file);
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', PRIMARY KEY (session_id, seq));
    `);
    const now = Date.now();
    raw.prepare("INSERT INTO sessions(id, kind, title, updated_at, bytes) VALUES(?,?,?,?,?)").run(chatSessionId("legacy-owner"), "chat", "老会话", now, 10);
    raw.close();

    /* 打开 = 跑链（这份库有 pending） */
    const store = openStore();
    const row = (await store.list()).find((x) => x.sessionId === chatSessionId("legacy-owner"));
    expect(row?.owner, "老会话的归属不是兼容口径的 local").toBe("local");
    expect(row?.title, "补列把旧数据动了").toBe("老会话");
  });

  it("显式归属的新会话与老会话并存（迁移不碰新写入的归属）", async () => {
    const store = openStore();
    await store.append(chatSessionId("new-alice"), [
      { seq: 1, at: Date.now(), requestId: "r", type: "request", messages: [{ role: "user", content: "x" }] } as never,
    ], { owner: "alice" });
    await store.append(chatSessionId("new-default"), [
      { seq: 1, at: Date.now(), requestId: "r", type: "request", messages: [{ role: "user", content: "y" }] } as never,
    ]);
    const byId = new Map((await store.list()).map((x) => [x.sessionId, x.owner]));
    expect(byId.get(chatSessionId("new-alice"))).toBe("alice");
    expect(byId.get(chatSessionId("new-default"))).toBe("local");
  });
});
