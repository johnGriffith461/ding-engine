import { openSqlite, type SqliteDatabase, type SqliteStatement } from "./sqliteDriver";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  actorOf,
  conversationTitle,
  isChatSessionId,
  parseLogLine,
  SESSION_PREFIX,
  type Actor,
  type LogRecord,
} from "../core/events";
import type { AppendOptions, LoadOptions, LogInputAt, SearchHit, SessionKind, SessionStore } from "../ports/store";
import { isPendingOutput } from "../core/events";
import { excerptOf, prepareSearchIndex, searchBodyOf } from "./sqliteSearch";
import { pendingMigrations, runMigrations } from "./sqliteSchema";
import type { SessionSummary } from "../../shared/ipc";

/**
 * 会话事件的 **SQLite 实现**（Phase 1 D1 的 PoC 结论落地）。
 *
 * ## 为什么是 `node:sqlite` 而不是 better-sqlite3
 *
 * PoC 实测（2026-10-14，本机）：
 *
 * | 候选 | 结果 |
 * |---|---|
 * | `better-sqlite3` | 原生模块 → 需要 MSVC/node-gyp 构建，且 Electron 与 Node 的 ABI 不同，**同一个模块要给两个宿主各编一份**（149 vs 137） |
 * | `node:sqlite` | Node 24 内置；**Electron 44.7 也内置**（实测 `ELECTRON_RUN_AS_NODE=1 electron -p require('node:sqlite')` → OK，其 Node 为 24.21） |
 *
 * 结论：**同一份实现同时服务 CLI 与桌面，零原生构建、零 ABI 重编译**。
 * 这不是"图省事"—— 原生模块那条路会让"新机器上 `pnpm install` 就能跑"变成
 * "先装 Visual Studio 构建工具"，而那正是本项目要避免的那类环境门槛。
 *
 * ⚠️ `node:sqlite` 在 Node 里仍是 experimental（API 稳定但会变）。风险已对冲：
 * 端口（`engine/ports/store.ts`）按意图定死，换回 better-sqlite3 或别的
 * 只需新增一个实现文件，**宿主与内核一行不用改**。
 *
 * ## 表结构
 *
 * ```sql
 * sessions(id, kind, title, updated_at, bytes)   -- 列举用；title 在写入时算好
 * events(session_id, seq, at, type, payload, body) -- payload 是**整行 JSON**（与 .jsonl 同形）
 * ```
 *
 * ⚠️ `payload` 存整行 JSON（含 `seq`/`at`）而不是"只存正文"：读回时直接喂给
 * `parseLogLine` —— **校验只有一份**。若拆开存字段，读回路径就会长出第二套校验，
 * 而两套校验迟早对不齐（`parseLogLine` 的规矩：决定一条记录算不算数）。
 *
 * ⚠️ `body` 是**给检索用的那一列**（审计 P136）：它是记录里"该被搜到的那些正文"
 * 的拼接（见 `searchBodyOf`），**不含字段名 / provider / 档位 / 元数据** ——
 * 原来检索是拿整行 JSON 去 LIKE/MATCH，于是搜 `provider`、`按需确认` 这类
 * 出现在字段名与策略值里的词会**假命中**，摘要也会摘出一段 JSON 噪声。
 * 正文那一列是**写的时候算好**的（读的时候不再解析，也就不会有两套口径）。
 */

/**
 * ⚠️ 2026-10-17（V5-1 3.3）：表结构（基线 DDL）与**版本化迁移链**搬去了
 * `./sqliteSchema.ts`（`MIGRATIONS` + `schema_version` 账本 + 不可降级闸门）。
 * 这个文件不再持有 `SCHEMA` / `SCHEMA_VERSION` —— 迁移只有一份实现，
 * 内存里的表结构描述与链上的步骤必须是同一个（ADR-005）。
 */

/**
 * 库文件里**有没有东西**（决定迁移前要不要留备份）。
 *
 * ⚠️ 不能只看 `existsSync`：`openSqlite` 会把不存在的文件建出来 ——
 * 全新库在跑到这里时**文件已经在、但 0 字节**（第一次实现就是这么把
 * "空文件"也备份了一份）。SQLite 的空库也有 4KB 头，所以用"字节数 > 0"当判据。
 */
function dbHasContent(file: string): boolean {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

/** 会话种类 → 前缀。写成表而不是 `if`：加第三种会话时只改这里。 */
const KIND_PREFIX: Record<SessionKind, string> = {
  chat: SESSION_PREFIX.chat,
  task: SESSION_PREFIX.task,
  cli: SESSION_PREFIX.cli,
};

/**
 * 保留策略（默认值）。
 *
 * ## 与 JSONL 那套的**一处语义变化**（如实记）
 *
 * JSONL 版在"单个会话超过 4MB"时做的是**轮转**：把整个文件改名成 `<id>.ts.jsonl.old`
 * 留在原地。后果是**那个会话被截断** —— 新文件里只剩后半段，前半段虽然还在磁盘上，
 * 但应用读不到（`.old` 不以 `.jsonl` 结尾）。也就是说：轮转过的会话**恢复不完整**。
 *
 * SQLite 版不再那么做，改成**按容量淘汰整个会话**（从最旧的开始），理由两条：
 *   ① SQLite 的读是带索引的查询（`WHERE session_id = ? ORDER BY seq`），
 *      不像 JSONL 那样必须整文件读进来 —— 单会话大不再是"每次读写都拖几 MB"；
 *   ② "半个会话"是**救不回来**的状态（`splitTurns` 拿不到首轮的 `request`，
 *      于是恢复出来的第一截没有输入记录）。整会话淘汰至少是干净的。
 *
 * ⚠️ 代价要说清：**被淘汰的是整个会话**（用户看不到那段历史了），而不是"看得到一部分"。
 * 容量上限因此给得比 4MB 宽得多（默认 64MB），它防的是"几年不清理"，不是日常回收。
 */
export const SQLITE_RETENTION = {
  /** 多久没动过就删。 */
  maxAgeDays: 30,
  /** 最多留几个会话（超了从最旧的删）。 */
  maxSessions: 400,
  /** 会话正文总字节上限（超了从最旧的整会话淘汰）。 */
  maxBytes: 64 * 1024 * 1024,
} as const;

/** 保留策略（可覆盖）。 */
export type RetentionPolicy = {
  maxAgeDays?: number;
  maxSessions?: number;
  maxBytes?: number;
};

/**
 * 一行在库里占的字节：`payload`（整行 JSON）+ `body`（检索那一列）+ 1。
 *
 * ## 为什么 `body` 必须算进去（审计 P32）
 *
 * `body` 是 P101 加的第二份正文（`searchBodyOf` 算好、专给检索用），
 * 而容量那道收口（`maxBytes`）原来只数 `payload` —— 中文正文的库里同一段文字
 * 被存了两遍，于是"64MB 上限"实际允许的磁盘占用接近**两倍**。
 * 这不是"精确到页"（SQLite 的页分配另有开销），是**别漏一列**。
 *
 * @param payload 整行 JSON（与 .jsonl 的一行同形）
 * @param body 检索用的正文那一列
 * @returns 字节数（UTF-8）
 */
function rowBytes(payload: string, body: string): number {
  return Buffer.byteLength(payload, "utf8") + Buffer.byteLength(body, "utf8") + 1;
}

/**
 * 读一条待落盘记录**自带**的时刻（没有 / 不是有限数 → `undefined`）。
 *
 * 迁移与恢复那条路要把记录原来的时刻带进来（审计 P14 / P31）；新发生的事件没有它。
 */
function originalAtOf(record: LogInputAt): number | undefined {
  const at = (record as { at?: unknown }).at;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

/** 打开时的额外选项。 */
export type OpenOptions = {
  /**
   * **收口保护线**（2026-10-16，审计 P173）：`updated_at` 早于这一刻的会话
   * **不参与任何一道收口**（年龄 / 条数 / 容量都不动它们）。
   *
   * ## 为什么要有它
   *
   * 服务态（`ding serve` / `ding acp`）**每来一个请求就打开一次库**，而打开即收口。
   * 于是一个能连上服务的外部调用方只要不停换 `sessionId` 请求，就能造出几百个新会话，
   * 把**用户自己的历史**按"最旧的先删"整段淘汰掉 —— 不可逆的数据损失，
   * 而触发它只需要"能连上"。
   *
   * 给了这条保护线之后：收口只淘汰**保护线之后**（即这次服务期间）产生的会话，
   * 用户原有的历史一条不动。保留策略的最终判断交还给**拥有数据的宿主**
   * （桌面 / CLI 打开库时不带这条线，照旧收口）。
   *
   * ⚠️ 故意不做成"只保护非本次请求创建的"字面实现：那种粒度需要在每行上记来源，
   * 而这里的威胁是"外部流量 vs 用户存量"，用服务启动时刻当分界线已经完整覆盖它。
   */
  protectBefore?: number;

  /**
   * **驱动替换**（只有测试会传）。
   *
   * 审计 P140/P144 的那两条判据都需要"这台机器上编的 SQLite 没有 FTS5"、
   * "语句最后有没有被释放"这类**在真机上造不出来的环境**。所以留这个口子：
   * 测试包一层真驱动，就能构造出这些环境（生产永远不传，走 `openSqlite`）。
   */
  driver?: (file: string) => SqliteDatabase;

  /**
   * **打开即收口**（旧行为，默认关；审计 P125）。
   *
   * 默认 `false`：收口是不可逆的，而"打开"到处都是（读一段历史、每个请求开一次库），
   * 打开就删数据的代价太大 —— 想删就显式调 `prune()`（见 `createSqliteSessionStore`
   * 里那段说明）。只有"确实希望每次打开都收一遍"的宿主才传 `true`，
   * 而且它在代码里看得见。
   */
  pruneOnOpen?: boolean;
};

/**
 * 打开（必要时建）一个 SQLite 会话库。
 *
 * @param dir 数据目录（不存在就建）
 * @param file 库文件名（默认 `sessions.db`；测试要并行时各给各的）
 * @param retention 保留策略（默认 `SQLITE_RETENTION`）；**收口不在打开时发生**，
 *   由宿主显式调 `prune()`（想恢复旧行为传 `open.pruneOnOpen`，见它那里的说明）
 * @param open 打开选项（`protectBefore` 见其说明）
 * @returns 满足 `SessionStore` 的实现
 */
export function createSqliteSessionStore(
  dir: string,
  file = "sessions.db",
  retention: RetentionPolicy = {},
  open: OpenOptions = {},
): SessionStore {
  mkdirSync(dir, { recursive: true });
  /*
   * ⚠️ 驱动是**运行时选的**（Phase 11.1）：Node/Electron 用 `node:sqlite`，
   * Bun（单二进制那条路）用 `bun:sqlite` —— 见 `./sqliteDriver.ts` 的说明与实测证据。
   * `open.driver` 是测试留的口子（见 `OpenOptions.driver`），生产不传。
   */
  const dbFile = path.join(dir, file);
  /*
   * ⚠️ **打开之前**先看盘上有没有东西（`dbHasContent`）：`openSqlite` 本身会把文件
   * 建出来、还会切 WAL（切日志模式要写库头）—— 打开之后再量，一个全新库也是 4KB。
   */
  const hadContent = dbHasContent(dbFile);
  const db = open.driver ? open.driver(dbFile) : openSqlite(dbFile);

  /*
   * ⭐ **迁移前先给库文件留一份**（V5 §3.1 的"迁移前自动快照"，G01 流血项的教训）。
   *
   * 只在**盘上本来就有东西且有 pending** 时做（全新库 / 已迁移库都不复制）。
   * 一份就够（覆盖式 `.pre-migrate.bak`）：链只在升级那一刻跑，
   * 要回退就是"用旧程序 + 这份文件"。⚠️ 复制**不删源**，失败了也不拦着迁移 ——
   * 备份是保险，不是闸门（闸门是"迁移失败就 ROLLBACK 停在旧版"，见 `runMigrations`）。
   */
  let backup: string | null = null;
  if (hadContent && pendingMigrations(db).length) {
    try {
      backup = `${dbFile}.pre-migrate.bak`;
      copyFileSync(dbFile, backup);
    } catch (error) {
      backup = null;
      console.error("[sqlite] 迁移前备份没做成（继续迁移，库没法回退这一步）：", error);
    }
  }

  /* 版本化迁移链（`./sqliteSchema.ts`）：有序、记账、不可降级 */
  const migration = runMigrations(db);
  /* 只报"**升级**"：全新库（from 0）建出来不算迁移，别在日志里制造噪音 */
  if (migration.applied.length && migration.from > 0) {
    console.log(
      `[sqlite] 会话库已迁移：v${migration.from} → v${migration.to}` +
        `（应用 ${migration.applied.join(", ")}${migration.adopted.length ? `；认领 ${migration.adopted.join(", ")}` : ""}）` +
        (backup ? `；迁移前备份在 ${backup}` : ""),
    );
  }

  /*
   * 检索那一套（FTS5 能力探测 / 索引形态不对时重建）由它负责，并**如实回报**能不能走 FTS：
   * 不能就只走 LIKE（审计 P140 要的"降级而不是打不开"）。
   */
  const ftsReady = prepareSearchIndex(db);

  /*
   * 所有语句都从这里出去并记下来：`close()` 时逐个 `finalize()`（审计 P144 ——
   * 长命语句不该只 prepare 不释放；`node:sqlite` 没有 finalize 时是可选项，
   * 见 `sqliteDriver.ts` 的 `SqliteStatement.finalize`）。
   */
  const statements: SqliteStatement[] = [];
  const prep = (sql: string): SqliteStatement => {
    const statement = db.prepare(sql);
    statements.push(statement);
    return statement;
  };

  const insertEvent = prep(
    "INSERT OR REPLACE INTO events(session_id, seq, at, type, payload, body, actor_id, actor_kind) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const maxSeq = prep("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE session_id = ?");
  const upsertSession = prep(
    `INSERT INTO sessions(id, kind, title, updated_at, bytes, owner, forked_from) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = ?, bytes = bytes + ?,
       title = CASE WHEN sessions.title = '' THEN excluded.title ELSE sessions.title END`,
  );
  /*
   * **审批索引的三条投影语句**（v6；C3 3.7b）。
   *
   * 真相仍是日志里那三条记录（`tool-result(pending)` / `approval` / `approval-grant`），
   * 这三条语句只是把"谁在等批、归谁批、批了没有"做成一次索引查询能答的问题
   * （见 `sqliteSchema.ts` v6 的说明）。写入方**只有**下面那处 append。
   */
  const upsertApproval = prep(
    `INSERT INTO approvals(session_id, tool_call_id, name, approvers, state, created_at) VALUES(?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(session_id, tool_call_id) DO UPDATE SET name = excluded.name, approvers = excluded.approvers`,
  );
  const decideApproval = prep(
    "UPDATE approvals SET state = ?, decided_by = ?, decided_at = ? WHERE session_id = ? AND tool_call_id = ?",
  );
  const grantApproval = prep("UPDATE approvals SET approvers = ? WHERE session_id = ? AND tool_call_id = ?");
  const selectEvents = prep("SELECT payload FROM events WHERE session_id = ? ORDER BY seq ASC");
  /** 这段会话归谁（C1）：不存在给 null。 */
  const ownerOf = prep("SELECT owner FROM sessions WHERE id = ?");
  /*
   * 检索的两条路（见 search() 的说明）：
   *   · FTS：走倒排索引（英文/词形），`bm25` 让更相关的排前面；
   *   · LIKE：中文与任意子串的兜底。
   * 并集之后按"命中最多的会话"优先、同数量按时间倒序 —— 与 list 的口径一致（最近的在前面）。
   *
   * ⚠️ FTS 那条**按能力准备**（审计 P140）：这台机器的 SQLite 没编 FTS5 时这里是 null，
   * 检索整体退化到 LIKE；`MATCH` 在不支持的表上会在 prepare 阶段就抛，所以那一步也要兜住。
   */
  let searchFts: SqliteStatement | null = null;
  if (ftsReady) {
    try {
      searchFts = prep(
        "SELECT e.session_id AS session_id, e.body AS body, bm25(events_fts) AS rank " +
          "FROM events_fts JOIN events e ON e.rowid = events_fts.rowid " +
          "WHERE events_fts MATCH ? LIMIT ?",
      );
    } catch {
      searchFts = null;
    }
  }
  /*
   * LIKE 那条路（审计 P135）：命中数必须是**这个会话真有多少条事件命中**，
   * 不能写死成 `1 AS n` —— 写死之后"命中最多的会话排前面"就名存实亡
   * （任何只被 LIKE 命中的会话都是 1，排序退化成按 updated_at）。
   * 所以这里 `GROUP BY session_id` + `COUNT(*)`，并顺手取最新那条命中的正文当摘要。
   */
  const searchLike = prep(
    `SELECT e.session_id AS session_id,
            COUNT(*) AS n,
            MAX(e.at) AS last_at,
            (SELECT e2.body FROM events e2
              WHERE e2.session_id = e.session_id AND e2.body LIKE ? ESCAPE '\\'
              ORDER BY e2.at DESC LIMIT 1) AS body
     FROM events e
     WHERE e.body LIKE ? ESCAPE '\\'
     GROUP BY e.session_id
     ORDER BY last_at DESC
     LIMIT ?`,
  );
  const sessionById = prep("SELECT id, title, updated_at, bytes, owner FROM sessions WHERE id = ?");
  const selectSessions = prep(
    "SELECT id, title, updated_at, bytes, owner, forked_from FROM sessions ORDER BY updated_at DESC",
  );
  const countSessions = prep("SELECT COUNT(*) AS n FROM sessions");
  const totalBytes = prep("SELECT COALESCE(SUM(bytes), 0) AS n FROM sessions");
  const oldestSessions = prep("SELECT id FROM sessions ORDER BY updated_at ASC LIMIT ?");
  const deleteSessionRow = prep("DELETE FROM sessions WHERE id = ?");
  const deleteSessionEvents = prep("DELETE FROM events WHERE session_id = ?");
  const staleSessions = prep("SELECT id FROM sessions WHERE updated_at < ? ORDER BY updated_at ASC");
  /*
   * 收口保护线那一侧的查询（见 `OpenOptions.protectBefore`）：
   * "受保护" = `updated_at < protectBefore`，三道收口都只看**未受保护**的那批。
   */
  const countUnprotected = prep("SELECT COUNT(*) AS n FROM sessions WHERE updated_at >= ?");
  const unprotectedBytes = prep("SELECT COALESCE(SUM(bytes), 0) AS n FROM sessions WHERE updated_at >= ?");
  const oldestUnprotected = prep(
    "SELECT id FROM sessions WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT ?",
  );
  const oldestUnprotectedRow = prep(
    "SELECT id, bytes FROM sessions WHERE updated_at >= ? ORDER BY updated_at ASC LIMIT 1",
  );
  const oldestRow = prep("SELECT id, bytes FROM sessions ORDER BY updated_at ASC LIMIT 1");
  const staleUnprotected = prep(
    "SELECT id FROM sessions WHERE updated_at < ? AND updated_at >= ? ORDER BY updated_at ASC",
  );

  /** 删掉一个会话（它的会话行与全部事件）。**整会话**，不截断。 */
  const dropSession = (id: string): void => {
    deleteSessionEvents.run(id);
    deleteSessionRow.run(id);
  };

  /**
   * 收口一次（年龄 → 条数 → 容量，三道都在这里）。
   *
   * ⚠️ 顺序有意义：先按年龄删（那是真的没人看了），再按条数，最后按容量 ——
   * 反过来的话，容量那道会把"很老但条数不多"的会话先淘汰掉，
   * 而它本来该由年龄那道更早、更便宜地处理掉。
   *
   * ⚠️ 给了保护线时（`OpenOptions.protectBefore`）：三道都只在**未受保护**的会话里淘汰，
   * 受保护的连年龄那道也不碰 —— 服务态不该替用户决定"你的旧历史该删了"。
   *
   * @returns 删掉的会话 id 与剩下的条数
   */
  const pruneStore = (): { deleted: string[]; kept: number } => {
    const policy = { ...SQLITE_RETENTION, ...retention };
    const deleted: string[] = [];
    const protectBefore = open.protectBefore;

    /** 未受保护里最旧的 n 个 id（没给保护线时就是全局最旧）。 */
    const victims = (limit: number): string[] =>
      protectBefore === undefined
        ? (oldestSessions.all(limit) as { id: string }[]).map((r) => r.id)
        : (oldestUnprotected.all(protectBefore, limit) as { id: string }[]).map((r) => r.id);

    const cutoff = Date.now() - policy.maxAgeDays * 86_400_000;
    const stale = (
      protectBefore === undefined ? staleSessions.all(cutoff) : staleUnprotected.all(cutoff, protectBefore)
    ) as { id: string }[];
    for (const row of stale) {
      dropSession(row.id);
      deleted.push(row.id);
    }

    const total = Number((countSessions.get() as { n: number }).n);
    const freeCount =
      protectBefore === undefined ? total : Number((countUnprotected.get(protectBefore) as { n: number }).n);
    /*
     * 受保护的那批**自己**就可能超过上限。那不是外部流量造成的，
     * 不该由这里去删；配额只落在未受保护的那批头上（下限 0）。
     */
    const quota = Math.max(0, policy.maxSessions - (total - freeCount));
    const overCount = freeCount - quota;
    if (overCount > 0) {
      for (const id of victims(overCount)) {
        dropSession(id);
        deleted.push(id);
      }
    }

    let freeBytes = Number(
      ((protectBefore === undefined ? totalBytes.get() : unprotectedBytes.get(protectBefore)) as { n: number }).n,
    );
    /*
     * 容量的"受保护占用"要用**当前**的全库总字节减去未受保护的字节 ——
     * 条数那道刚删过，两个数都得重新读一次，不能沿用上面的快照。
     */
    const totalNow = Number((totalBytes.get() as { n: number }).n);
    const protectedNow = protectBefore === undefined ? 0 : totalNow - freeBytes;
    const budget = Math.max(0, policy.maxBytes - protectedNow);
      while (freeBytes > budget) {
        /*
         * ⚠️ 这两条语句**提到循环外**（审计 P144）：原来是在循环里 prepare 的 ——
         * 淘汰量大时（上限被调小、或长期没跑收口）一次打开造出几百条 `StatementSync`，
         * 靠 GC 回收。现在用打开时准备好的那两条，`close()` 时统一释放。
         */
        const row = (
          protectBefore === undefined ? oldestRow.get() : oldestUnprotectedRow.get(protectBefore)
        ) as { id: string; bytes: number } | undefined;
        if (!row) break;
        dropSession(row.id);
        deleted.push(row.id);
        freeBytes -= Number(row.bytes ?? 0);
      }

    const kept = Number((countSessions.get() as { n: number }).n);
    return { deleted, kept };
  };

  /*
   * ⚠️ **打开时不再无条件收口**（2026-10-16，审计 P125）。
   *
   * 原来这里是一句 `pruneStore()`（"与 JSONL 那版启动时清理同一个时机"），
   * 而打开库这件事**到处都是**：CLI 的 `ding resume` / `ding backup` 只是要读一段历史、
   * 服务态每个请求打开一次库 —— 它们都会**顺手删掉用户的旧会话**。
   * 收口是**不可逆**的动作，"打开"不是它的理由：一个只想看一眼的命令不该改数据。
   *
   * 现在的口径：**收口是显式动作**（`store.prune()`，端口上就写着它），
   * 由**拥有数据的宿主**在合适的时机调（桌面在 `ready()` 里调一次；
   * CLI 要不要调、什么时候调，是 CLI 的产品决定）。
   * 想保留"打开即收口"的旧行为，就在 `open` 里显式传 `{ pruneOnOpen: true }`
   * —— 那样至少调用点在代码里看得见，而不是隐式发生。
   */
  if (open.pruneOnOpen) pruneStore();

  /** 会话种类（按前缀判；`SESSION_PREFIX` 是唯一那份口径）。 */
  function kindOf(sessionId: string): SessionKind {
    if (isChatSessionId(sessionId)) return "chat";
    return sessionId.startsWith(SESSION_PREFIX.cli) ? "cli" : "task";
  }

  return {
    async append(sessionId: string, records: readonly LogInputAt[], opts?: AppendOptions): Promise<LogRecord[]> {
      if (!records.length) return [];
      const kind = kindOf(sessionId);
      const stored: LogRecord[] = [];

      /*
       * ⚠️ 整批一个事务：半批写入会让"请求记录在、它的工具事件不在"这种形状成为可能，
       * 而日志的价值恰恰在顺序与完整。
       *
       * ⚠️ `BEGIN IMMEDIATE`（不是裸 `BEGIN`）的理由（审计 P39 那条的 db 侧）：
       * 裸 `BEGIN` 是**延迟**取锁的 —— 先读后写的那种事务会在写那一刻才升级锁，
       * 两个这样的连接撞在一起就是"谁也升不上去"（SQLITE_BUSY，而且没有重试的机会）。
       * IMMEDIATE 一上来就取写锁，配合 `sqliteDriver.ts` 里那条 `busy_timeout`，
       * 撞上时是**排队等**，不是当场失败。
       */
      db.exec("BEGIN IMMEDIATE");
      try {
        /*
         * ⭐ C1（V5-1 3.5）：归属只对**新建**会话生效，且**冲突要拒绝**。
         *
         * · 调用方没给 owner（老路径）：什么都不查，行为与从前一致（本机单用户）。
         * · 给了 owner：先看这段会话在不在。
         *   - 不在 → 这次写入就是它的创建，owner 定下来（之后不再改：归属是创建时的事实）；
         *   - 在且 owner 相同 → 正常追加；
         *   - 在但 owner 不同 → **抛错拒绝**（不让 B 往 A 的会话里写）。
         *     拒绝而不是静默改写：后者会让归属这条线永远说不清。
         */
        if (opts?.owner) {
          const existing = (ownerOf.get(sessionId) as { owner?: string } | undefined)?.owner;
          if (existing !== undefined && existing !== opts.owner) {
            throw new Error(`会话归属冲突：${sessionId} 归 ${existing}，不是 ${opts.owner}（拒绝写入）`);
          }
        }

        const row = maxSeq.get(sessionId) as { m?: number } | undefined;
        let seq = Number(row?.m ?? 0);
        let bytes = 0;
        let title = "";

        for (const record of records) {
          seq += 1;
          /*
           * ⚠️ 记录**自带时刻**时用它（迁移 / 恢复那条路，审计 P14 / P31）。
           *
           * 原来这里一律 `at = Date.now()`：从旧 `.jsonl` 迁进来的一整段历史于是
           * 全挤进"迁移那一刻"—— 成本账本按天的口径（`ledger.ts` 的 `localDay`）
           * 当场散掉，会话里"什么时候说的这句话"也被改写了。
           * 新发生的事件没有 `at`，照旧盖现在（那就是它发生的时刻）。
           */
          const at = originalAtOf(record) ?? Date.now();
          /*
           * 落盘形态与 .jsonl 的一行**同形**（读回时喂同一个 parseLogLine）：
           * `seq`/`at` 写在最前、由存储给出。记录自带的那一份先剥掉 ——
           * 它已经取进 `at` 了，留着只会在键序上与别处对不上（也不许它冒充权威）。
           */
          const { seq: _frozenSeq, at: _frozenAt, ...rest } = record as Record<string, unknown>;
          const payload = JSON.stringify({ seq, at, ...rest });
          // 检索用的正文**写的时候算好**（只算一次，读的时候不再解析 —— 审计 P136）
          const body = searchBodyOf(record as Record<string, unknown>);
          /*
           * actor 两列与 payload **同一口径**（C5，ADR-006）：缺字段 = legacy。
           * ⚠️ 拿 `record` 判而不是 `stored` 那条解析结果判：两者此刻相等，
           * 但 `actorOf` 是读路径的唯一口径，这里直接复用它（少一处各写各的）。
           */
          const actor = actorOf(record as { actor?: Actor });
          insertEvent.run(sessionId, seq, at, record.type, payload, body, actor.id, actor.kind);
          bytes += rowBytes(payload, body);
          if (!title && record.type === "request") title = conversationTitle([{ seq, at, ...rest } as LogRecord]);
          stored.push(JSON.parse(payload) as LogRecord);

          /*
           * ⭐ **审批索引的投影**（v6）：真相是上面那条记录本身，这里只是把它记进索引表。
           *
           * 投影规则与读路径（`pendingFor` / `approversFor` / `decidedByOf`）**同一套**：
           * 一致性由 `sqliteApprovals.test.ts` 的"索引 = 从日志现算"盯着 ——
           * 两处各写一套的话，会让"列表里显示待批、点下去说已经批过了"这类事发生。
           *
           * ⚠️ 三支都只在**认得出来的形状**上动作；认不出来就什么都不做
           * （不是"记一条空的"—— 那会让索引里多出一条谁也解释不了的待决）。
           */
          const typed = record as { toolCallId?: unknown; output?: unknown; approved?: unknown; decidedBy?: unknown };
          const approvalId = typeof typed.toolCallId === "string" ? typed.toolCallId : "";
          if (approvalId && record.type === "tool-result") {
            /*
             * ⚠️ "是不是待决"必须问**投影层**（`isPendingOutput`）—— 自己从 output 里
             * 判一次就是第二份解析（`src/projectionGuard.test.ts` 盯着这件事，
             * 它当场逮到了这一处）。
             */
            if (isPendingOutput(typed.output)) {
              const approvers = (typed.output as { approvers?: unknown }).approvers;
              upsertApproval.run(
                sessionId,
                approvalId,
                String((record as { toolName?: unknown }).toolName ?? ""),
                JSON.stringify(Array.isArray(approvers) ? approvers : []),
                at,
              );
            }
          } else if (approvalId && record.type === "approval") {
            decideApproval.run(
              typed.approved === true ? "approved" : "rejected",
              typeof typed.decidedBy === "string" ? typed.decidedBy : null,
              at,
              sessionId,
              approvalId,
            );
          } else if (approvalId && record.type === "approval-grant") {
            grantApproval.run(JSON.stringify((record as { approvers?: unknown }).approvers ?? []), sessionId, approvalId);
          }
        }

        /*
         * 会话行上的 `updated_at` 仍是**写入这一刻**（不是记录里的时刻），刻意的：
         *
         * · 它是"这一行最近一次进库"的时刻，收口里的**年龄那道**按它算
         *   —— 迁进来/恢复回来的老历史因此还能再留满一个 `maxAgeDays`，
         *   而不是刚搬进来就在下一次打开时被删掉（那才是数据损失）；
         * · 账本按天看的是**记录自己的 `at`**（上面那个 `at`），与这一格无关 ——
         *   两个口径各管各的，谁也不许拿它冒充另一个。
         */
        const at = Date.now();
        /* owner 只在**新建**那一刻写进去（ON CONFLICT 那支不碰它 —— 首次写入者定归属） */
        upsertSession.run(sessionId, kind, title, at, bytes, opts?.owner ?? "local", opts?.forkedFrom ?? null, at, bytes);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec("COMMIT");
      return stored;
    },

    async load(sessionId: string, loadOpts?: LoadOptions): Promise<{ records: LogRecord[]; skipped: number; denied?: "owner" }> {
      /*
       * C1（V5-1 3.5）：给了 owner 就校验归属 —— 陌生 owner **不返回内容**。
       * 回空 + `denied` 而不是抛错：调用方按"没有内容"处理即可，
       * 也不必从错误里反推"它存在但不是你的"（那本身也是信息泄漏）。
       */
      if (loadOpts?.owner) {
        const owner = (ownerOf.get(sessionId) as { owner?: string } | undefined)?.owner;
        if (owner !== undefined && owner !== loadOpts.owner) return { records: [], skipped: 0, denied: "owner" };
      }
      const rows = selectEvents.all(sessionId) as { payload: string }[];
      const records: LogRecord[] = [];
      let skipped = 0;
      for (const row of rows) {
        // 坏数据只跳过它自己（与 `.jsonl` 那边同一个 parseLogLine）
        const parsed = parseLogLine(row.payload);
        if (parsed) records.push(parsed);
        else skipped += 1;
      }
      records.sort((a, b) => a.seq - b.seq);
      return { records, skipped };
    },

    prune: async () => pruneStore(),

    /**
     * 按内容检索（Phase 12.4）。
     *
     * ## 为什么要 FTS + LIKE **两条路并集**
     *
     * FTS5 的内置分词器（`unicode61`）对中文**不分词** —— 它把一整串中文当成一个词，
     * 于是 `MATCH '会议'` 在 `"明天十点开会"` 上**不命中**（那串是一个词）。
     * 实测过这件事，所以这里把两条路并起来：
     *
     *   · FTS 那条负责"英文/词形/相关度"（它快、有索引）；
     *   · `LIKE '%词%'` 那条负责中文与任何子串（它慢，但**搜得到**）。
     *
     * 宁可多扫一次也不要"搜不到"：对用户来说，"我以前明明聊过"是最能感知的坏。
     *
     * ## 匹配的是**正文那一列**（审计 P136）
     *
     * 两条路都在 `events.body` 上匹配（见 `searchBodyOf`）—— 不碰字段名/provider/档位/元数据。
     *
     * ## 命中数是**真的数出来的**（审计 P135）
     *
     * LIKE 那条 `GROUP BY session_id` + `COUNT(*)`：写死 `1 AS n` 的话，
     * "命中最多的会话排前面"对中文（只有 LIKE 命中）完全失效。
     *
     * ## 摘要是**原文里的一小段**，不是生成的
     *
     * 用户点开检索结果前要能看到"为什么这条被搜出来"，所以摘一段命中的上下文
     * （前后各留一点）。这里**不生成**任何文字 —— 生成的东西没法保证与原文一致。
     */
    async search(query: string, opts?: { limit?: number }): Promise<SearchHit[]> {
      const q = query.trim();
      if (!q) return []; // 空串 = 空结果（不是"全部" —— 那会让界面在回车时刷出一切）
      const limit = Math.max(1, Math.min(opts?.limit ?? 20, 200));
      /*
       * `LIKE` 要转义（用户在搜索框里打 `%` 或 `_` 是很自然的，不该变成通配符）。
       * FTS 的查询串要**引号包起来**：不然 `AND` / `OR` / `*` 这些会被当语法。
       */
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const ftsQuery = `"${q.replace(/"/g, '""')}"`;

      /*
       * 两条路并集（口径见上面那段说明）：
       *   · FTS 那条：文本/词形，走倒排索引，快（**没有 FTS5 时它是 null：只走 LIKE**）；
       *   · LIKE 那条：中文与任意子串的兜底，慢但搜得到。
       * 合并规则：同一个会话取两者里**命中最多的那个数**；排序按"命中多的优先、
       * 同数量按时间倒序"（与 `list` 的口径一致：最近的在前面）。
       */
      const byId = new Map<string, { n: number; body: string }>();

      if (searchFts) {
        try {
          const ftsRows = searchFts.all(ftsQuery, limit) as { session_id: string; body: string }[];
          for (const r of ftsRows) {
            const prev = byId.get(r.session_id);
            byId.set(r.session_id, { n: (prev?.n ?? 0) + 1, body: prev?.body ?? r.body });
          }
        } catch {
          /* FTS 查询串不合法（极端输入）/ 索引坏了 → 只靠 LIKE；不因为语法问题让整个检索失败 */
        }
      }

      const likeRows = searchLike.all(like, like, limit) as {
        session_id: string;
        n: number;
        body: string;
      }[];
      for (const r of likeRows) {
        const prev = byId.get(r.session_id);
        byId.set(r.session_id, {
          // `r.n` 是这个会话真命中多少条（COUNT），FTS 那条只数了"取回来的行" —— 取大的
          n: Math.max(prev?.n ?? 0, Number(r.n)),
          body: prev?.body ?? r.body,
        });
      }

      const rows = [...byId.entries()]
        .map(([session_id, v]) => ({ session_id, ...v }))
        .sort((a, b) => {
          if (b.n !== a.n) return b.n - a.n;
          const ta = (sessionById.get(a.session_id) as { updated_at?: number } | undefined)?.updated_at ?? 0;
          const tb = (sessionById.get(b.session_id) as { updated_at?: number } | undefined)?.updated_at ?? 0;
          return tb - ta;
        })
        .slice(0, limit);

      const out: SearchHit[] = [];
      for (const row of rows) {
        const summary = sessionById.get(row.session_id) as
          | { id: string; title: string; updated_at: number; bytes: number }
          | undefined;
        if (!summary) continue;
        const kind = kindOf(row.session_id);
        const prefix = KIND_PREFIX[kind];
        out.push({
          sessionId: row.session_id,
          conversationId: kind === "chat" ? row.session_id.slice(prefix.length) : row.session_id,
          title: summary.title,
          updatedAt: summary.updated_at,
          bytes: summary.bytes,
          excerpt: excerptOf(row.body ?? "", q),
          hits: row.n,
        });
      }
      return out;
    },

    close(): void {
      // 长命语句逐个释放（Bun 有 `finalize`；node:sqlite 没有 → 可选调用）
      for (const statement of [...statements].reverse()) {
        try {
          statement.finalize?.();
        } catch {
          /* 释放失败不该盖住真正的错误（关库才是要紧的那一步） */
        }
      }
      statements.length = 0;
      db.close();
    },

    async list(opts?: { kind?: SessionKind }): Promise<SessionSummary[]> {
      const rows = selectSessions.all() as {
        id: string;
        title: string;
        updated_at: number;
        bytes: number;
        owner?: string;
        forked_from?: string | null;
      }[];
      const out: SessionSummary[] = [];
      for (const row of rows) {
        const kind = kindOf(row.id);
        if (opts?.kind && opts.kind !== kind) continue;
        const prefix = KIND_PREFIX[kind];
        out.push({
          sessionId: row.id,
          conversationId: kind === "chat" ? row.id.slice(prefix.length) : row.id,
          title: row.title,
          updatedAt: Number(row.updated_at),
          bytes: Number(row.bytes),
          /* C1：归属跟着摘要一起给（老库补列后一律 'local'） */
          owner: row.owner ?? "local",
          /* V5-2 2.5：分叉来源（没有就是没有 —— 不给空串） */
          ...(row.forked_from ? { forkedFrom: row.forked_from } : {}),
        });
      }
      return out;
    },
  };
}

/**
 * 把一份 `.jsonl` 会话日志迁进 SQLite（**只读旧、写新，不删旧**）。
 *
 * ## 为什么是"复制"而不是"移动"
 *
 * 迁移最坏的情况是"迁到一半崩了"。只读旧文件的话，那种情况下的损失上限是
 * "重跑一次"，而不是"历史没了"。旧文件留在原处，用户自己也翻得到。
 *
 * @param dir 旧日志所在目录（`.jsonl` 一族）
 * @param store 目标 store
 * @returns 迁了几个文件、几条记录、几个坏行
 */
export async function migrateJsonlSessions(
  dir: string,
  store: SessionStore,
): Promise<{ files: number; records: number; skipped: number }> {
  if (!existsSync(dir)) return { files: 0, records: 0, skipped: 0 };
  let files = 0;
  let records = 0;
  let skipped = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    const text = readFileSync(path.join(dir, name), "utf8");
    const parsed: LogRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = parseLogLine(line);
      if (record) parsed.push(record);
      else skipped += 1;
    }
    if (!parsed.length) continue;
    /*
     * 已经是"落盘形态"（带 seq/at）的那批：整批原样写进去。
     *
     * ⚠️ **只丢掉 `seq`，`at` 原样带上**（审计 P14 / P31）：
     *
     * · `seq` 由存储自己重新编号是对的 —— 旧编号只用于排序，保序就够了；
     * · `at` **不能丢**：它是"这句话是什么时候说的"。原来这里写的是
     *   `.map(({ seq, at, ...rest }) => rest)`，于是接手的 `append` 把每一行都盖成
     *   "迁移那一刻"—— 一段三年的历史全挤进今天，成本账本按天的口径当场散掉
     *   （`ledger.ts` 按 `record.at` 分天）。迁移是**搬运**，不是重新发生。
     */
    const ordered = [...parsed].sort((a, b) => a.seq - b.seq).map(({ seq: _seq, ...rest }) => rest);
    await store.append(sessionId, ordered as LogInputAt[]);
    files += 1;
    records += ordered.length;
  }
  return { files, records, skipped };
}

