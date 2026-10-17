import { createRequire } from "node:module";

/**
 * SQLite 驱动的**运行时选择**（Phase 11.1 的配套）。
 *
 * ## 为什么要有这一层
 *
 * 方案 11.1 有一条**前置冒烟门**：CLI 要编成单文件可执行，而 `node:sqlite` 是
 * **Node 独有**的内置模块 —— 换到 Bun runtime 就不存在了。实测确认：
 *
 * ```
 * $ bun -e 'require("node:sqlite")'
 * No such built-in module: node:sqlite
 * ```
 *
 * 而方案的处置也写好了：**经冻结端口换 `bun:sqlite` 实现**
 * （"端口冻结原则正为此设计" —— `SessionStore` 端口从 Phase 1 就没动过，
 * 换的是它底下的驱动，不是它的形状）。
 *
 * ## 这一层只做一件事：把两家的 API 抹平成同一个形状
 *
 * 两家的**同步** API 几乎一样（`exec` / `prepare().run|get|all` / `close`），
 * 差别只有类名与几个返回值细节。所以这里不引入抽象层，只做一个最小的适配：
 * 存储层拿到的永远是 `SqliteDatabase`。
 *
 * ## 选驱动的判据：**运行时**，不是编译期
 *
 * - Bun runtime（单二进制那条）：`require("bun:sqlite")`
 * - Node / Electron：`require("node:sqlite")`
 *
 * 判据是 `process.versions.bun`。**不按"编译目标"判** —— 同一份源码既跑在
 * Node（桌面与 `pnpm ding`）又跑在 Bun（单二进制），编译期区分会逼出两套产物。
 *
 * ⚠️ 用 `require` 而不是 `import`：`bun:sqlite` 在 Node 里不存在，
 * 静态 import 会让 Node 侧**加载即失败**。下面这一段在 ESM 与 CJS 下都能跑：
 * CJS 有全局 `require`，ESM（vitest / tsx）走 `createRequire`。
 */

const req: NodeRequire =
  typeof require === "function" ? require : createRequire(`${process.cwd()}/sqliteDriver.js`);

/** 一条预处理语句（两家共有的那部分）。 */
export type SqliteStatement = {
  run: (...params: unknown[]) => { changes?: number | bigint; lastInsertRowid?: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  /**
   * 释放这条语句（可选：**两家不一样**）。
   *
   * `bun:sqlite` 的 `Statement` 有 `finalize()`，`node:sqlite` 的 `StatementSync`
   * **没有**（靠 GC 回收）。所以类型里是可选的，调用方用 `stmt.finalize?.()`。
   * 审计 P144 的要求就是"别只 prepare 不释放"：长命语句（会话库那十几条）在
   * `close()` 时逐个释放。
   */
  finalize?: () => void;
};

/** 一个同步数据库句柄（两家共有的那部分）。 */
export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};

/** 当前跑在哪个 runtime 上（写进 `ding doctor` 与错误信息里，排查时有用）。 */
export function sqliteRuntimeName(): "bun" | "node" {
  return typeof (process.versions as { bun?: string }).bun === "string" ? "bun" : "node";
}

/**
 * 一次写事务最多等多久（毫秒）—— `busy_timeout`（审计 P39）。
 *
 * 5 秒是个取舍：够覆盖一次真实的写入事务（本项目的写入是**整批一个事务**、
 * 毫秒级），又不至于让界面在"另一个进程正写着"时卡上半分钟。
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * 每一条连接打开后立刻要设的两条 PRAGMA（**审计 P39 的数据库那一半**）。
 *
 * ## 缺陷形状
 *
 * 整改前这里是**裸连接**：没有 `busy_timeout`、没有 WAL。而同一个库文件真的会被
 * 多个进程/连接碰到 —— 桌面（`sessions.db`）与 CLI 在开发态指向同一个 `data/`
 * 目录、`ding` 与 `ding serve` 也会同时开库；单实例锁（`electron/ipc/singleInstance.ts`）
 * 只覆盖了"桌面开两份"那一种，数据库这一侧不能假设"只有一个写者"。
 * 裸连接撞在一起的后果很具体：写侧立刻 `SQLITE_BUSY`，上层当作"写盘失败"，
 * 于是同一份数据出现两个版本（split-brain）。
 *
 * ## 两条各自解决什么
 *
 * · `busy_timeout`：库被别的连接占着时**等**一会儿，而不是立刻失败。
 *   它是**每条连接**的设置 —— 所以必须设在唯一的开库入口这里；
 *   设在某个调用点的话，别的调用点就是裸的。
 * · `journal_mode = WAL`：读不挡写、写不挡读（我们最需要的正是这一点：一边流式写日志、
 *   一边读历史）。它是**落在库文件上**的设置（会多出 `-wal` / `-shm` 两个文件），
 *   设一次之后别的连接打开也是 WAL。
 *
 * ## 设不上怎么办（如实降级，不让库打不开）
 *
 * 两条都包在 try 里：库在只读介质 / 网络盘上，或那个 SQLite 构建不支持时，
 * **设不上不等于库坏了** —— 说一句，照旧按原来的 journal 模式用。
 * `:memory:` 上 WAL 本来就不适用，同理。
 *
 * @param db 刚打开的句柄
 */
function applyConnectionDefaults(db: SqliteDatabase): void {
  try {
    db.prepare(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`).get();
  } catch (error) {
    console.error("[sqlite] busy_timeout 没设上（并发写更容易撞 SQLITE_BUSY）：", error);
  }
  try {
    db.prepare("PRAGMA journal_mode = WAL").get();
  } catch (error) {
    console.error("[sqlite] 没切到 WAL（读会被写挡住，功能不受影响）：", error);
  }
}

/**
 * 打开一个 SQLite 库（同步）。
 *
 * ⚠️ **所有连接都从这里出去**，所以 `busy_timeout` / WAL 也在这里设一次
 * （见 `applyConnectionDefaults` —— 每条连接各设一次，漏一个调用点就是一条裸连接）。
 *
 * @param file 文件路径（`:memory:` 也可以）
 * @returns 统一的数据库句柄
 * @throws 两家都没有时抛一句能看懂的话（而不是 `Cannot find module`）
 */
export function openSqlite(file: string): SqliteDatabase {
  const runtime = sqliteRuntimeName();
  const db =
    runtime === "bun"
      ? new (req("bun:sqlite") as { Database: new (f: string) => SqliteDatabase }).Database(file)
      : new (req("node:sqlite") as { DatabaseSync: new (f: string) => SqliteDatabase }).DatabaseSync(file);
  applyConnectionDefaults(db);
  return db;
}
