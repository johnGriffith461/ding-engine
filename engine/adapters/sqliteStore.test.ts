import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore, migrateJsonlSessions, type OpenOptions } from "./sqliteStore";
import { SQLITE_BUSY_TIMEOUT_MS, openSqlite, type SqliteDatabase } from "./sqliteDriver";
import { chatSessionId, logLine, resumeSession, taskSessionId, type LogInput } from "../core/events";
import { ledgerOf, localDay, rollup } from "../core/ledger";
import type { LogInputAt } from "../ports/store";

/**
 * SQLite 会话库（Phase 1 D1 的 PoC）。
 *
 * ## 这些断言要挡住的是什么
 *
 * 换存储是一次"全仓最不该出错"的改动：**出错不会崩，只会悄悄少东西**
 * （历史少了一轮、批准记录跑到它那一轮前面、某段会话列不出来）。
 * 所以这里断言的都是**可证伪的行为**：编号连不连、顺序对不对、
 * 迁过来的东西还能不能 `resume` 出一模一样的待办。
 */

let dir: string;
/** 本用例建过的 store：**结算时统一 close** —— 句柄没放之前临时目录删不掉（Windows 硬失败）。 */
let opened: { close(): void }[] = [];

/** 建一个 store 并记下来，省得每个用例都记得收尾。 */
function openStore(d = dir) {
  const store = createSqliteSessionStore(d);
  opened.push(store);
  return store;
}

/**
 * 用**指定的驱动**开一个 store（审计 P140/P144 要的环境在真机上造不出来）。
 *
 * `open.driver` 见 `OpenOptions.driver`：生产永远不传，只有这些用例包一层真驱动 ——
 * 用来构造"这台机器的 SQLite 没编 FTS5"与"数语句有没有被释放"。
 */
function openStoreWith(open: OpenOptions, d = dir) {
  const store = createSqliteSessionStore(d, "sessions.db", {}, open);
  opened.push(store);
  return store;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-sqlite-"));
  opened = [];
});

afterEach(() => {
  for (const store of opened) store.close();
  /*
   * ⚠️ 清理**尽力而为**，不让它把一个通过的用例判红。
   *
   * Windows 上 "文件被占用" 是一次性冲突（杀软扫刚写出的文件、句柄还没完全释放），
   * 表现为 EPERM —— 实测遇到过一次：一整轮里 6 条用例被 afterEach 的 rmSync 判红，
   * 而那 6 条断言**其实全过了**。这类"测试自己抖"的代价很实在：
   * 红了先怀疑测试，久了就没人看红了。
   *
   * 所以这里吞掉清理失败（临时目录由系统回收），而不是让它冒充"被测代码坏了"。
   */
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 占着就占着：系统会回收，不因此判红 */
  }
});

/**
 * 造一条流事件。
 *
 * ⚠️ `requestId` 不能省：`parseLogLine` 要求流事件带着它（那是 IPC 归并用的），
 * 少了就**不算一条合法记录** —— 第一次写这些用例时正是栽在这里
 * （`skipped` 报 3，而当时看代码"明明都写进去了"）。
 */
function ev(e: Omit<LogInput & { type: string }, "requestId"> | Record<string, unknown>): LogInput {
  return { requestId: "r1", ...(e as object) } as LogInput;
}

/** 造一条请求记录（会话的"一轮开始"）。 */
function request(text: string): LogInput {
  return {
    type: "request",
    requestId: "r1",
    provider: "deepseek",
    model: "deepseek-chat",
    messages: [{ role: "user", content: text }],
  } as LogInput;
}

describe("SQLite 会话库", () => {
  it("⭐ 追加 → 读回：序号连续、顺序不变、内容一字不差", async () => {
    const store = openStore();
    const sid = chatSessionId("abc");

    const first = await store.append(sid, [request("把散落的 md 整理成纪要")]);
    expect(first.map((r) => r.seq)).toEqual([1]);

    await store.append(sid, [ev({ type: "text", text: "好" }), ev({ type: "text", text: "的" }), ev({ type: "done" })]);

    const { records, skipped } = await store.load(sid);
    expect(skipped).toBe(0);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records.map((r) => r.type)).toEqual(["request", "text", "text", "done"]);
    const texts = records.filter((r) => r.type === "text").map((r) => (r as { text: string }).text);
    expect(texts.join("")).toBe("好的");
  });

  it("再追加一批接着上一批的序号（两个写入器不会撞号）", async () => {
    const store = openStore();
    const sid = chatSessionId("abc");
    // 模拟"同一会话被第二处写入"（用户点允许之后那次）：序号必须接着走
    await store.append(sid, [ev({ type: "text", text: "a" })]);
    const second = await store.append(sid, [ev({ type: "text", text: "b" })]);
    expect(second[0]?.seq).toBe(2);
  });

  it("列会话：只出聊天那一类，标题取第一条用户消息，最近的在前面", async () => {
    const store = openStore();
    await store.append(chatSessionId("c1"), [request("第一句话\n第二行")]);
    await new Promise((r) => setTimeout(r, 2));
    await store.append(chatSessionId("c2"), [request("第二条对话")]);
    // 工作台任务的日志写进同一个库，但不该混进聊天列表
    await store.append("task-t1", [request("任务日志")]);

    const chats = await store.list({ kind: "chat" });
    expect(chats.map((c) => c.conversationId)).toEqual(["c2", "c1"]);
    expect(chats[1]?.title).toBe("第一句话"); // 取第一行，不带换行
    expect(chats[0]?.title).toBe("第二条对话");
    expect(await store.list({ kind: "task" })).toHaveLength(1);
  });

  it("读一个不存在的会话：给空数组，不是报错", async () => {
    const store = openStore();
    expect(await store.load(chatSessionId("nope"))).toEqual({ records: [], skipped: 0 });
  });

  it("⭐ 迁移：旧 .jsonl 整段搬过来之后，resume 出来的待办与待办数量一致", async () => {
    // 造一份旧格式日志：一轮里有一次被闸门拦下的调用（pending），用户还没处置
    const legacy = mkdtempSync(path.join(tmpdir(), "dh-legacy-"));
    const sid = chatSessionId("old");
    const lines: string[] = [];
    let seq = 0;
    const put = (record: LogInput) => {
      seq += 1;
      lines.push(logLine(record, seq, 1_700_000_000_000 + seq));
    };
    put(request("帮我写个文件"));
    put(ev({ type: "tool-call", toolCallId: "t1", toolName: "write_file", input: { path: "a.md", content: "x" } }));
    put(ev({ type: "tool-result", toolCallId: "t1", toolName: "write_file", output: { pending: true, notice: "等确认" } }));
    put(ev({ type: "done" }));
    writeFileSync(path.join(legacy, `${sid}.jsonl`), lines.join(""), "utf8");

    const store = openStore();
    const got = await migrateJsonlSessions(legacy, store);
    expect(got).toMatchObject({ files: 1, records: 4, skipped: 0 });

    const { records } = await store.load(sid);
    expect(records).toHaveLength(4);

    // 迁移之后语义不变：那条被拦下的调用仍然是"待办"，参数还在（丢了就执行不了）
    const resumed = resumeSession(records);
    expect(resumed.pending).toHaveLength(1);
    expect(resumed.pending[0]).toMatchObject({ toolCallId: "t1", name: "write_file" });
    expect(resumed.pending[0]?.input).toEqual({ path: "a.md", content: "x" });

    // 旧文件**还在**（只读旧、写新、不删旧）
    expect(readdirSync(legacy).filter((n) => n.endsWith(".jsonl"))).toHaveLength(1);
    rmSync(legacy, { recursive: true, force: true });
  });

  it("迁移遇到坏行：只跳过坏的那一行，并把跳过数报出来", async () => {
    const legacy = mkdtempSync(path.join(tmpdir(), "dh-legacy-"));
    const sid = chatSessionId("bad");
    const ok = logLine(ev({ type: "text", text: "好" }), 1, 1);
    writeFileSync(path.join(legacy, `${sid}.jsonl`), `${ok}{坏掉的一行}\n`, "utf8");

    const store = openStore();
    const got = await migrateJsonlSessions(legacy, store);
    expect(got).toMatchObject({ records: 1, skipped: 1 });
    expect((await store.load(sid)).records).toHaveLength(1);
    rmSync(legacy, { recursive: true, force: true });
  });

  it("⭐ 保留策略：超条数从**最旧的整会话**淘汰（不是把一个会话截成半截）", async () => {
    /*
     * ⚠️ 收口发生在**打开时**（与 JSONL 那版"启动时清理"同一个时机），
     * 不在每次 append 之后 —— 所以这里显式调一次 `prune()`。
     * 开着应用跑一整天时，库会略微超过上限，下一次启动收回来；
     * 这与既有行为一致（JSONL 那版也不在每次写入后扫目录）。
     */
    const store = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 2 });
    for (const id of ["c1", "c2", "c3"]) {
      await store.append(chatSessionId(id), [request(`对话 ${id}`)]);
      await new Promise((r) => setTimeout(r, 3)); // 让 updated_at 拉开，好判"最旧"
    }
    expect((await store.list()).map((x) => x.conversationId)).toEqual(["c3", "c2", "c1"]);

    const got = await store.prune();
    expect(got.deleted, "淘汰的必须是最旧的那个（整会话）").toEqual([chatSessionId("c1")]);
    expect(got.kept).toBe(2);
    // 被淘汰的会话连事件一起走（不留孤儿行）
    expect((await store.load(chatSessionId("c1"))).records).toEqual([]);

    // 重开一次：再收一次口，仍然只有 2 个（不会因为重开而漂移）
    store.close();
    const again = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 2 });
    await again.prune();
    expect((await again.list()).map((x) => x.conversationId)).toEqual(["c3", "c2"]);
    again.close();
  });

  it("保留策略：容量超限时整会话淘汰（被淘汰的会话连事件一起走）", async () => {
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId("old"), [request("老的")]);
    await new Promise((r) => setTimeout(r, 3));
    await store.append(chatSessionId("new"), [request("新的")]);
    const rows = await store.list();
    const newestBytes = rows.find((r) => r.conversationId === "new")?.bytes ?? 0;

    // 只留得下"新的"那一个 → 收口一次就会把 old 整会话淘汰
    store.close();
    const tight = createSqliteSessionStore(dir, "sessions.db", { maxBytes: newestBytes + 10 });
    await tight.prune();
    expect((await tight.list()).map((x) => x.conversationId)).toEqual(["new"]);
    // 事件也一起删了（不是留下孤儿行）
    expect((await tight.load(chatSessionId("old"))).records).toEqual([]);
    tight.close();
  });

  it("保留策略：年龄超限删掉（maxAgeDays: 0 等价于'只留此刻之后写的'）", async () => {
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId("ancient"), [request("很久以前")]);
    store.close();
    const aggressive = createSqliteSessionStore(dir, "sessions.db", { maxAgeDays: 0 });
    await aggressive.prune();
    expect(await aggressive.list()).toEqual([]);
    aggressive.close();
  });

  it("⭐ 保护线（protectBefore）：外部流量收口不得淘汰用户自有会话", async () => {
    /*
     * 审计 P173：服务态**每来一个请求就打开一次库**（而"打开即收口"那件事
     * 已在 P125 里改成显式 `prune()`，所以这里必须自己调它才谈得上收口）。
     * 不带保护线时，能连上服务的人只要不停换 sessionId，就能把用户历史
     * 按"最旧的先删"整段挤掉 —— 不可逆的数据损失。
     */
    const seeded = createSqliteSessionStore(dir);
    await seeded.append(chatSessionId("mine-1"), [request("我的老会话 A")]);
    await new Promise((r) => setTimeout(r, 3));
    await seeded.append(chatSessionId("mine-2"), [request("我的老会话 B")]);
    seeded.close();

    const protectBefore = Date.now() + 1; // 服务启动时刻：上面两个都在它之前（都是"用户自己的"）
    await new Promise((r) => setTimeout(r, 3));

    /* 服务期间又被造了 3 个（上限 4：受保护 2 + 未受保护配额 2）→ 只淘汰最旧的那个未受保护的 */
    const serving = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 4 }, { protectBefore });
    for (const id of ["srv-1", "srv-2", "srv-3"]) {
      await serving.append(chatSessionId(id), [request(`服务态建的 ${id}`)]);
      await new Promise((r) => setTimeout(r, 3));
    }
    const got = await serving.prune();
    expect(got.deleted, "淘汰的必须只是服务期间建的那个").toEqual([chatSessionId("srv-1")]);
    expect((await serving.list()).map((x) => x.conversationId).sort()).toEqual(["mine-1", "mine-2", "srv-2", "srv-3"]);
    serving.close();

    /* 对照：**不带**保护线时同一份数据会被淘汰掉用户的两个 —— 说明拦住它的是保护线本身 */
    const plain = createSqliteSessionStore(dir, "sessions.db", { maxSessions: 2 });
    await plain.prune();
    const left = (await plain.list()).map((x) => x.conversationId);
    expect(left).not.toContain("mine-1");
    expect(left).not.toContain("mine-2");
    plain.close();
  });

  it("迁移一个不存在的目录：当成'没有旧数据'，不是错误", async () => {
    const store = openStore();
    mkdirSync(dir, { recursive: true });
    expect(await migrateJsonlSessions(path.join(dir, "nope"), store)).toEqual({
      files: 0,
      records: 0,
      skipped: 0,
    });
  });
});

describe('本地检索（Phase 12.4：FTS + LIKE 并集）', () => {
  it('中文按子串搜得到（FTS 的内置分词器对中文不分词 —— 靠 LIKE 那条兜底）', async () => {
    const store = openStore();
    await store.append(chatSessionId('cn'), [request('明天十点开会讨论预算')]);
    const hits = await store.search('预算');
    expect(hits.map((h) => h.sessionId)).toContain(chatSessionId('cn'));
    // 摘要是**正文**那一句（不是整行 JSON）
    expect(hits[0]?.excerpt).toContain('预算');
    expect(hits[0]?.excerpt).not.toContain('requestId');
  });

  it('英文搜得到，且只命中说过它的那段会话', async () => {
    const store = openStore();
    await store.append(chatSessionId('en'), [request('review the budget tomorrow')]);
    await store.append(taskSessionId('other'), [request('完全无关的一句话')]);
    const hits = await store.search('budget');
    expect(hits.map((h) => h.sessionId)).toEqual([chatSessionId('en')]);
  });

  it('搜不到的词给空数组（不是返回全部）', async () => {
    const store = openStore();
    await store.append(chatSessionId('x'), [request('一些内容')]);
    expect(await store.search('不存在的词')).toEqual([]);
  });

  it('空串 = 空结果：回车不该刷出所有会话', async () => {
    const store = openStore();
    await store.append(chatSessionId('x'), [request('一些内容')]);
    expect(await store.search('')).toEqual([]);
    expect(await store.search('   ')).toEqual([]);
  });

  it('⭐ 命中最多的会话排前面，且命中数是**真数**（中文只有 LIKE 命中，也不许恒为 1）', async () => {
    const store = openStore();
    /*
     * ⚠️ 这条用例原来是 `request('预算')` —— 正文**整句等于**关键词，FTS 那条路也命中
     * （于是把 3 条数成了 n=3），恰好盖住了「LIKE 路写死 `1 AS n`」这个真缺陷（审计 P135）。
     * 换成中文**子串**（FTS 对中文不分词 → 只有 LIKE 命中）之后，这条才真的在判。
     */
    await store.append(chatSessionId('many'), [
      request('明天十点开会讨论'),
      request('下午两点开会复盘'),
      request('晚上再开会对齐'),
    ]);
    await new Promise((r) => setTimeout(r, 3)); // 让 updated_at 拉开：错的话会按时间排
    await store.append(chatSessionId('one'), [request('周一早点开会')]);

    const hits = await store.search('开会');
    const many = hits.find((h) => h.sessionId === chatSessionId('many'));
    expect(many?.hits, '命中数恒为 1：命中多的排前面这个口径名存实亡').toBe(3);
    expect(hits[0]?.sessionId, '命中最多的会话没排前面').toBe(chatSessionId('many'));
    expect(hits[0]?.hits).toBeGreaterThan(hits[1]?.hits ?? 0);
  });

  it('用户打的 % 与 _ 是普通字符，不是通配符', async () => {
    const store = openStore();
    await store.append(chatSessionId('pct'), [request('折扣 50% 起')]);
    await store.append(chatSessionId('plain'), [request('折扣 500 起')]);
    const hits = await store.search('%');
    expect(hits.map((h) => h.sessionId)).toEqual([chatSessionId('pct')]);
  });
});

describe('检索只匹配**该匹配的字段**（审计 P136）', () => {
  it('⭐ 元数据（provider / model / 档位 / 字段名）不算正文：搜它们不许命中', async () => {
    const store = openStore();
    await store.append(chatSessionId('meta'), [request('今天天气不错')]);
    // 这条请求记录带着真实形状的元数据：provider / model / toolPolicy 全是"字段与策略值"
    await store.append(chatSessionId('policy'), [
      { ...(request('今天天气不错') as Record<string, unknown>), toolPolicy: '按需确认' } as LogInput,
    ]);

    expect(await store.search('deepseek'), 'provider 被当正文了').toEqual([]);
    expect(await store.search('requestId'), '字段名被当正文了').toEqual([]);
    expect(await store.search('按需确认'), '档位值被当正文了').toEqual([]);
    expect(await store.search('request'), 'type 字段名被当正文了').toEqual([]);

    // 对照：真正的正文照旧搜得到（收窄的是字段名，不是内容）
    expect((await store.search('天气')).map((h) => h.sessionId).sort()).toEqual([
      chatSessionId('meta'),
      chatSessionId('policy'),
    ]);
  });

  it('工具参数与结果里的**内容**照旧搜得到，摘要也不再是 JSON 噪声', async () => {
    const store = openStore();
    await store.append(chatSessionId('tool'), [
      ev({ type: 'tool-call', toolCallId: 't1', toolName: 'read_file', input: { path: '预算表.md' } }),
      ev({
        type: 'tool-result',
        toolCallId: 't1',
        toolName: 'read_file',
        output: { path: '预算表.md', content: '第三季度预算合计 12 万' },
      }),
    ]);
    const hits = await store.search('第三季度预算');
    expect(hits.map((h) => h.sessionId)).toEqual([chatSessionId('tool')]);
    expect(hits[0]?.excerpt).toContain('12 万');
    expect(hits[0]?.excerpt, '摘要摘到了 JSON 字段名').not.toContain('content');
  });
});

describe('FTS5 缺席时降级，而不是整个会话库打不开（审计 P140）', () => {
  /**
   * 「这台机器编的 SQLite 没有 FTS5」的驱动：任何用到 `fts5` 的语句都抛
   * （真实的报错就是 `no such module: fts5`）。
   */
  function noFtsDriver(file: string): SqliteDatabase {
    const db = openSqlite(file);
    let closed = false;
    const guard = (sql: string): void => {
      if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
    };
    return {
      exec: (sql: string) => {
        guard(sql);
        db.exec(sql);
      },
      prepare: (sql: string) => {
        guard(sql);
        return db.prepare(sql);
      },
      close: () => {
        if (!closed) {
          closed = true;
          db.close();
        }
      },
    };
  }

  it('⭐ 打不开的那个库现在打得开：检索退化到 LIKE，别的功能一概不受影响', async () => {
    const store = openStoreWith({ driver: noFtsDriver });
    await store.append(chatSessionId('cn'), [request('明天十点开会讨论预算')]);
    // 中文子串：本来就靠 LIKE
    expect((await store.search('预算')).map((h) => h.sessionId)).toEqual([chatSessionId('cn')]);
    // 英文/词形那条（FTS 的强项）也得搜得到 —— LIKE 那条路还在
    await store.append(chatSessionId('en'), [request('review the budget tomorrow')]);
    expect((await store.search('budget')).map((h) => h.sessionId)).toEqual([chatSessionId('en')]);
    // 读写/列举/收口都不受影响（降级不是"半残"）
    expect((await store.load(chatSessionId('cn'))).records.length).toBeGreaterThan(0);
    expect((await store.list()).length).toBe(2);
    await expect(store.prune()).resolves.toBeTruthy();
  });
});

describe('老库迁移：正文列与索引都要**搬**过来（审计 P101）', () => {
  it('⭐ 12.4 时代写下的行（没有 body 列、FTS 建在整行 JSON 上）升级后照样搜得到，索引也搬到正文列上', async () => {
    /*
     * 造一份**当时那份**库：结构就是 12.4 那几个版本写出来的形状 ——
     * `events` 没有 `body`，`events_fts` 的索引列是 `payload`（整行 JSON），
     * 触发器写的也是 `new.payload`。这不是"模拟"，它就是老版本落下的盘。
     *
     * ⚠️ 时间戳要用**当前时刻**：老库一打开就会跑收口（`maxAgeDays: 30`），
     * 拿 `at: 1` 造数据的话那条行会在被测代码碰它之前就被年龄那一道删掉 ——
     * 那样这条用例就测不到"回填"了（第一版真踩了：search 返回空，看着像缺陷没修好）。
     */
    const now = Date.now();
    const file = path.join(dir, 'sessions.db');
    const raw = openSqlite(file);
    raw.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE INDEX idx_events_session ON events(session_id, seq);
      CREATE VIRTUAL TABLE events_fts USING fts5(payload, content='events', content_rowid='rowid');
      CREATE TRIGGER events_fts_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, payload) VALUES (new.rowid, new.payload);
      END;
    `);
    const oldPayload = JSON.stringify({
      seq: 1,
      at: now,
      requestId: 'r1',
      type: 'request',
      provider: 'deepseek',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '三个月前聊过预算的事' }],
    });
    raw.prepare('INSERT INTO events(session_id, seq, at, type, payload) VALUES(?,?,?,?,?)').run(
      chatSessionId('old'),
      1,
      now,
      'request',
      oldPayload,
    );
    raw.exec(
      `INSERT INTO sessions(id, kind, title, updated_at, bytes) VALUES('chat-old','chat','三个月前',${now},100)`,
    );
    raw.close();

    const store = openStore();
    const hits = await store.search('预算');
    expect(hits.map((h) => h.sessionId), '老行没回填正文 → 它永远搜不到').toEqual([chatSessionId('old')]);
    expect(hits[0]?.excerpt).toContain('预算');

    const check = openSqlite(file);
    // ① 索引被搬到**正文列**上（原来索引的是整行 JSON：假命中就是那么来的）
    const ftsSql = String((check.prepare("SELECT sql FROM sqlite_master WHERE name='events_fts'").get() as { sql?: string })?.sql ?? '');
    expect(ftsSql, '索引还在整行 JSON 上（没做列迁移）').toMatch(/fts5\s*\(\s*body\b/i);
    const triggerSql = String(
      (check.prepare("SELECT sql FROM sqlite_master WHERE name='events_fts_ai'").get() as { sql?: string })?.sql ?? '',
    );
    expect(triggerSql, '触发器还在同步 payload 那一列').toContain('new.body');
    // ② 索引**真的重建过**：external-content 表的 integrity-check 只在索引与正文一致时通过
    expect(
      () => check.exec("INSERT INTO events_fts(events_fts) VALUES('integrity-check')"),
      '老行不在 FTS 索引里（没跑过 rebuild）',
    ).not.toThrow();
    // ③ 版本号被写上：说明走的是"版本化迁移"那条路（P101 提的"表变更没有版本管理"）
    const version = Number((check.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0);
    expect(version).toBeGreaterThanOrEqual(2);
    check.close();

    // 老行搬过来之后是**正常数据**：读得回来、能列出来
    expect((await store.load(chatSessionId('old'))).records).toHaveLength(1);
    expect((await store.list()).map((x) => x.conversationId)).toEqual(['old']);
  });
});

describe('语句生命期：复用 + 释放（审计 P144）', () => {
  it('⭐ 收口循环复用同一条语句（不是每淘汰一个就 prepare 一条），关闭时逐个释放', async () => {
    const prepared: string[] = [];
    let finalized = 0;
    const countingDriver = (file: string): SqliteDatabase => {
      const db = openSqlite(file);
      let closed = false;
      return {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => {
          prepared.push(sql);
          const statement = db.prepare(sql);
          return {
            run: (...params: unknown[]) => statement.run(...params),
            get: (...params: unknown[]) => statement.get(...params),
            all: (...params: unknown[]) => statement.all(...params),
            // 模拟 `bun:sqlite` 的 finalize（node:sqlite 没有这个方法，见 sqliteDriver 的说明）
            finalize: () => {
              finalized += 1;
            },
          };
        },
        close: () => {
          if (!closed) {
            closed = true;
            db.close();
          }
        },
      };
    };

    const store = createSqliteSessionStore(
      dir,
      'sessions.db',
      /*
       * ⚠️ 用**容量**那一道（不是条数那道）：这条用例要的是"淘汰循环真的转了不止一圈"，
       * 而条数那道走的是 `victims()` —— 那个循环里本来就没有 prepare。
       * `maxBytes: 1` 逼着容量那道把三个会话逐个淘汰掉。
       */
      { maxBytes: 1 },
      { driver: countingDriver },
    );
    opened.push(store);
    for (const id of ['c1', 'c2', 'c3']) {
      await store.append(chatSessionId(id), [request(`对话 ${id}`)]);
      await new Promise((r) => setTimeout(r, 3));
    }

    const openedStatements = prepared.length;
    expect(openedStatements, '打开时一条语句都没准备？').toBeGreaterThan(5);
    prepared.length = 0; // 只看收口这一段

    const got = await store.prune();
    expect(got.deleted.length, '这条用例要靠"淘汰了不止一个"才有意义').toBeGreaterThan(1);
    expect(
      prepared.filter((sql) => /FROM sessions/i.test(sql)).length,
      '每淘汰一个就新 prepare 一条：语句数随淘汰量涨',
    ).toBe(0);

    store.close();
    expect(finalized, '关闭时没有释放长命语句').toBe(openedStatements);
  });
});

describe('迁移/写入路径：原始时刻不能被改写成"迁移那一刻"（审计 P14 / P31）', () => {
  /** 三天（用 `localDay` 自己算期望值，跨时区也稳）。 */
  const DAY = 86_400_000;
  const BASE = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01 12:00 UTC：离本地日界足够远

  /** 造一轮（request + done，`done` 带用量 —— 账本要它才入账）。 */
  function roundOf(requestId: string, text: string, at: number): Array<{ record: LogInput; at: number }> {
    return [
      { at, record: { type: 'request', requestId, provider: 'strata', model: 'm', messages: [{ role: 'user', content: text }], tools: [] } as LogInput },
      {
        at,
        record: { type: 'done', requestId, usage: { inputTokens: 10, outputTokens: 5 } } as LogInput,
      },
    ];
  }

  it('⭐ 迁进来的一整段历史仍分属各自那几天（成本账本按天看得到真日子）', async () => {
    /*
     * 这是"迁移丢掉原始时间戳"那条缺陷的**可见后果**：
     * 一段三个月的会话迁进新库之后，如果每一行都被盖成 `Date.now()`，
     * 账本按天那一栏就只剩今天一格（`ledger.ts` 的 `localDay(record.at)`）——
     * "哪天花得多"这个问题从此问不出答案。
     */
    const legacy = mkdtempSync(path.join(tmpdir(), 'dh-legacy-at-'));
    const sid = chatSessionId('old-at');
    const rounds = [roundOf('r1', '第一天的活', BASE), roundOf('r2', '第二天的活', BASE + DAY), roundOf('r3', '第三天的活', BASE + 2 * DAY)];

    const lines: string[] = [];
    let seq = 0;
    for (const r of rounds) {
      for (const item of r) {
        seq += 1;
        /* ⚠️ 这里**必须**用 logLine 写进真实的 seq/at —— 它就是旧 .jsonl 的落盘形态 */
        lines.push(logLine(item.record, seq, item.at));
      }
    }
    writeFileSync(path.join(legacy, `${sid}.jsonl`), lines.join(''), 'utf8');

    const store = openStore();
    const got = await migrateJsonlSessions(legacy, store);
    expect(got).toMatchObject({ files: 1, records: 6, skipped: 0 });

    const { records } = await store.load(sid);
    expect(
      records.map((r) => r.at),
      '迁移把每行的时刻盖成了"迁移那一刻" —— 历史被改写成了同一个瞬间',
    ).toEqual([BASE, BASE, BASE + DAY, BASE + DAY, BASE + 2 * DAY, BASE + 2 * DAY]);

    /* 账本按天：应当是**原来的三天**，不是今天一格 */
    const byDay = rollup(ledgerOf(records, sid), 'day').map((row) => row.key).sort();
    expect(byDay, '账本按天只剩一格（或不是原来那几天）—— 迁移把日的口径抹平了').toEqual(
      [localDay(BASE), localDay(BASE + DAY), localDay(BASE + 2 * DAY)].sort(),
    );
    expect(byDay).not.toContain(localDay(Date.now()));

    rmSync(legacy, { recursive: true, force: true });
  });

  it('⭐ 记录自带 `at` 时就用它；新记录（没有 `at`）才盖"现在"', async () => {
    const store = openStore();
    const sid = chatSessionId('supplied');
    const old = BASE - 40 * DAY;

    const written = await store.append(sid, [
      { ...(request('很久以前说过的一句') as Record<string, unknown>), at: old } as LogInputAt,
    ]);
    expect(written[0]?.at, 'append 把调用方给的时刻吞了（迁移与恢复都靠它）').toBe(old);

    /* 对照：不带 `at` 的记录照旧盖"现在"（那就是它发生的时刻） */
    const before = Date.now();
    const fresh = await store.append(sid, [ev({ type: 'text', text: '刚刚说的' })]);
    expect(fresh[0]?.at ?? 0).toBeGreaterThanOrEqual(before);

    /* 库里的列与 payload 里的时刻是**同一个**（两处口径不许分叉） */
    const { records } = await store.load(sid);
    expect(records.map((r) => r.at)).toEqual([old, fresh[0]?.at]);
  });

  it('会话行的 `updated_at` 仍是写入时刻（收口的年龄那道按它算，迁移进来的老历史不会一下就被删）', async () => {
    const store = openStore();
    const sid = chatSessionId('updated');
    const old = BASE - 400 * DAY; // 远超 30 天
    const before = Date.now();
    await store.append(sid, [{ ...(request('很多年前的记录') as Record<string, unknown>), at: old } as LogInputAt]);
    const row = (await store.list()).find((x) => x.sessionId === sid);
    expect(row?.updatedAt ?? 0, 'updated_at 跟着记录走了 —— 刚迁进来的老会话会在下一次打开时被年龄那道删掉').toBeGreaterThanOrEqual(before);
  });

  it('新库开出来就带着 schema 版本（P101 的"表变更要有版本"那一半，别退回去）', async () => {
    /* ⚠️ 这条要自己建、自己关（`openStore` 那句会在 afterEach 再关一次 → "database is not open"） */
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId('v'), [request('随便一句')]);
    store.close();
    const db = openSqlite(path.join(dir, 'sessions.db'));
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number })?.user_version ?? 0);
    db.close();
    expect(version, '版本号没写上：下次表变更就没有"搬过没搬过"这个判据了').toBeGreaterThanOrEqual(2);
  });
});

describe('容量那道数的是**整行**（审计 P32）', () => {
  it('⭐ `sessions.bytes` 把 `body` 那一列也算进去（中文正文不会被漏掉一半）', async () => {
    /*
     * `body` 是 P101 加的第二份正文（检索用）。容量那道收口（`maxBytes`）原来只数
     * `payload`，于是同一段文字在库里存了两遍、账却只记一遍 ——
     * "64MB 上限"实际允许的磁盘占用接近两倍。
     *
     * 判据直接问库：这一行两列各占多少字节（`LENGTH(CAST(x AS BLOB))` 才是字节）。
     */
    const store = openStore();
    const sid = chatSessionId('row-bytes');
    await store.append(sid, [request('这是一段中文正文，用来量它到底占了多少字节')]);

    const row = (await store.list()).find((x) => x.sessionId === sid);
    expect(row?.bytes ?? 0).toBeGreaterThan(0);

    const db = openSqlite(path.join(dir, 'sessions.db'));
    const sum = db
      .prepare(
        'SELECT SUM(LENGTH(CAST(payload AS BLOB)) + LENGTH(CAST(body AS BLOB))) AS n FROM events WHERE session_id = ?',
      )
      .get(sid) as { n?: number } | undefined;
    db.close();

    expect(
      row?.bytes ?? 0,
      '导出的字节数比库里这一行真正占的还少 —— `body` 那一列没算（中文正文会漏掉将近一半）',
    ).toBeGreaterThanOrEqual(Number(sum?.n ?? 0));
  });

  it('容量压到"刚好只装得下正文"时：淘汰按**真实占用**算（不是按半份）', async () => {
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId('c1'), [request('第一段中文正文，用于量容量')]);
    await new Promise((r) => setTimeout(r, 3));
    await store.append(chatSessionId('c2'), [request('第二段中文正文，用于量容量')]);
    const rows = await store.list();
    const newest = rows.find((r) => r.conversationId === 'c2')?.bytes ?? 0;
    store.close();

    /* 只留得下新的那一个（余量 10 字节） */
    const tight = createSqliteSessionStore(dir, 'sessions.db', { maxBytes: newest + 10 });
    await tight.prune();
    expect((await tight.list()).map((x) => x.conversationId)).toEqual(['c2']);
    /* 剩下的那个也真的在预算之内（按同一口径算的，不是"账上一个数、占的是另一个"） */
    const kept = (await tight.list())[0]?.bytes ?? 0;
    expect(kept).toBeLessThanOrEqual(newest + 10);
    tight.close();
  });
});

describe('打开库**不删数据**：收口是显式动作（审计 P125）', () => {
  it('⭐ 一个只想读一眼的命令（`ding resume` / `ding backup` 那种）不会顺手删掉旧会话', async () => {
    /*
     * 原来 `createSqliteSessionStore` 在**打开时**无条件跑一次收口（"与 JSONL 那版
     * 启动时清理同一个时机"）。而"打开库"到处都是：读一段历史、服务态每个请求开一次 ——
     * 它们都会把用户的旧会话按保留策略删掉。收口是**不可逆**的动作，"打开"不是它的理由。
     *
     * 判据：拿一份**超龄**的数据 + 一个把年龄设成 0 的库打开（那等于"只留此刻之后写的"），
     * 打开之后**数据必须还在**；调一次 `prune()` 才该消失。
     */
    const seeded = createSqliteSessionStore(dir);
    await seeded.append(chatSessionId('old'), [request('很久以前的一段')]);
    seeded.close();

    const opened = createSqliteSessionStore(dir, 'sessions.db', { maxAgeDays: 0 });
    expect(
      (await opened.list()).map((x) => x.conversationId),
      '打开就把数据删了：一个只想看一眼的命令不该改用户的数据（P125）',
    ).toEqual(['old']);
    expect((await opened.load(chatSessionId('old'))).records.length).toBeGreaterThan(0);

    /* 显式收口仍然照常工作（别把"不隐式删"做成了"删不掉"） */
    const got = await opened.prune();
    expect(got.deleted).toEqual([chatSessionId('old')]);
    expect(await opened.list()).toEqual([]);
    opened.close();
  });

  it('想保留旧行为就显式传 `pruneOnOpen`（调用点在代码里看得见）', async () => {
    const seeded = createSqliteSessionStore(dir);
    await seeded.append(chatSessionId('old'), [request('很久以前的一段')]);
    seeded.close();

    const eager = createSqliteSessionStore(dir, 'sessions.db', { maxAgeDays: 0 }, { pruneOnOpen: true });
    expect(await eager.list()).toEqual([]);
    eager.close();
  });
});

describe('连接的默认设置：busy_timeout + WAL（审计 P39）', () => {
  it('⭐ 每条连接都带 busy_timeout（撞上并发写时**等**，不是当场 SQLITE_BUSY）', () => {
    /*
     * `busy_timeout` 是**每条连接**的设置，所以判据就是"随便开一条连接看它有没有" ——
     * 只要有一条路径忘了设，那条路径撞上并发写就是立刻失败，上层当成"写盘失败"。
     * 开连接这件事只有一个入口（`openSqlite`），判据钉在这个入口上。
     */
    const db = openSqlite(path.join(dir, 'sessions.db'));
    const got = db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined;
    db.close();
    expect(
      Number(got?.timeout ?? 0),
      '没设 busy_timeout：两个进程同时写同一个库时，后来那个当场 SQLITE_BUSY —— 上层回落到"文件"就出现同一份数据两个版本',
    ).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('⭐ 库切到 WAL（读不挡写、写不挡读）—— 桌面与 CLI 同开一个 data/ 才不乱', async () => {
    const store = createSqliteSessionStore(dir);
    await store.append(chatSessionId('wal'), [request('写一句')]);
    /* 另开一条连接看**库文件上**的模式（WAL 是落在文件上的设置，不是每条连接的事） */
    const db = openSqlite(path.join(dir, 'sessions.db'));
    const got = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    db.close();
    store.close();
    expect(String(got?.journal_mode ?? '').toLowerCase(), '还停在原来的 journal 模式：一边写一边读会互相挡').toBe('wal');
  });
});

/**
 * C1（V5-1 3.5）：会话归属。
 *
 * 三件事必须同时成立（V5 §3.2b 的 `sessions: + owner` 与 §3.1 的兼容矩阵）：
 *   ① 老路径零迁移：不给 owner 的调用照旧，新会话落默认 `local`；
 *   ② 新会话**必带归属**：第一次写入那一刻定下来，之后不再改（首次写入者定归属）；
 *   ③ 跨 owner **拒绝**：写要拒（抛错、整批回滚）、读不返回内容（`denied`）。
 */
describe("C1：会话归属（owner）", () => {
  it("⭐ 不给 owner = 老行为：新会话落 'local'，list 里看得见", async () => {
    const store = openStore();
    const sid = chatSessionId("owner-default");
    await store.append(sid, [request("写一句")]);
    const row = (await store.list()).find((x) => x.sessionId === sid);
    expect(row?.owner, "默认归属不是 local").toBe("local");
  });

  it("⭐ 显式 owner：第一次写入定归属，之后的写入不刷它", async () => {
    const store = openStore();
    const sid = chatSessionId("owner-alice");
    await store.append(sid, [request("alice 说的")], { owner: "alice" });
    expect((await store.list()).find((x) => x.sessionId === sid)?.owner).toBe("alice");
    /* 同一个 owner 继续写：正常 */
    await store.append(sid, [ev({ type: "text", text: "继续" })], { owner: "alice" });
    expect((await store.load(sid, { owner: "alice" })).records).toHaveLength(2);
  });

  it("⭐ 跨 owner 写入：拒绝（抛错），而且整批一个字节都没落", async () => {
    const store = openStore();
    const sid = chatSessionId("owner-conflict");
    await store.append(sid, [request("alice 的会话")], { owner: "alice" });
    await expect(store.append(sid, [ev({ type: "text", text: "bob 想插一句" })], { owner: "bob" })).rejects.toThrow(
      /归属冲突/,
    );
    const { records } = await store.load(sid, { owner: "alice" });
    expect(records, "被拒绝的那批写进去了").toHaveLength(1);
  });

  it("⭐ 跨 owner 读取：不返回内容（denied），也不在错误里泄漏「它存在」", async () => {
    const store = openStore();
    const sid = chatSessionId("owner-read");
    await store.append(sid, [request("alice 的秘密")], { owner: "alice" });

    const alien = await store.load(sid, { owner: "bob" });
    expect(alien.records).toEqual([]);
    expect(alien.denied).toBe("owner");

    /* 本主读得到；不给 owner 的调用（老路径）照旧读得到 —— 兼容矩阵 */
    expect((await store.load(sid, { owner: "alice" })).records).toHaveLength(1);
    expect((await store.load(sid)).records).toHaveLength(1);
    /* 不存在的会话：空，但**不是** denied（"没有"与"不是你的"要分得开） */
    expect(await store.load("没这段", { owner: "bob" })).toEqual({ records: [], skipped: 0 });
  });
});

/**
 * fork 的存储侧（V5-2 2.5）：`forked_from` 只在新建那一刻写、之后不再改。
 */
describe("C6/2.5：分叉来源（forked_from）", () => {
  it("⭐ 副本会话带着来源；普通会话没有这一格（undefined，不是空串）", async () => {
    const store = openStore();
    const sid = chatSessionId("src");
    await store.append(sid, [request("原话")]);
    const forkId = chatSessionId("copy");
    await store.append(forkId, [request("原话")] as never, { forkedFrom: sid });

    const rows = new Map((await store.list()).map((x) => [x.sessionId, x]));
    expect(rows.get(forkId)?.forkedFrom).toBe(sid);
    expect(rows.get(sid)?.forkedFrom).toBeUndefined();

    /* 之后再写不改来源（归属/来源都是创建时的事实） */
    await store.append(forkId, [ev({ type: "text", text: "副本里接着说" })], { forkedFrom: "别的会话" });
    expect(new Map((await store.list()).map((x) => [x.sessionId, x])).get(forkId)?.forkedFrom).toBe(sid);
  });

  it("旧库（没有 forked_from 列）：补列之后读不出来源（不是「分叉自空会话」）", async () => {
    const store = openStore();
    await store.append(chatSessionId("old"), [request("老会话")]);
    const row = (await store.list()).find((x) => x.sessionId === chatSessionId("old"));
    expect(row?.forkedFrom).toBeUndefined();
  });
});
