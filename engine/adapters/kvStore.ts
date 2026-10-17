import fs from "node:fs";
import path from "node:path";

import { openSqlite, type SqliteDatabase } from "./sqliteDriver";

/**
 * 配置型数据的 **SQLite KV**（Phase 12.1）。
 *
 * ## 为什么收在这一层
 *
 * 全仓 14 个"配置型 store"（任务 / 记忆 / MCP / 定时 / 日程 / 工作区 / 设置 / 库 …）
 * **都走同一个 `createJsonStore`**（C1 那次收口）。所以"存储 SQLite 化"不需要改 14 处 ——
 * 在这一层换后端，14 个 store 一起换。这也是方案说的"配置型 store → SQLite KV + 信封版本"。
 *
 * ## 键的口径：**相对数据目录**（P100/P128）
 *
 * 键原来是"数据文件的绝对路径"。那让**跨机器恢复静默落空**：备份里带的是导出机的
 * `c:\users\alice\...\tasks.json`，换台机器/换个数据目录之后没人再去查那串键，
 * 而 CLI 照样报"恢复了 N 项"。现在键是**相对数据目录的路径**（`tasks.json`），
 * 与机器、盘符、用户名、数据目录位置都无关。
 *
 * 兼容：改动之前写进库里的键是绝对路径（`kvKeyFor`）。读时若稳定键没有，
 * 会再按旧键查一次，查到就**就地搬成稳定键并删掉旧键**（只影响老数据，一次而已）。
 *
 * ## 三条设计取舍（写在前面，免得下一个人以为写漏了）
 *
 * 1. **一个数据目录一个库**（`stores.db`）：句柄按目录缓存，进程退出时统一关。
 * 2. **信封原样保留**：值里存的还是 `{__schema, data}` 那套（`shared/persist` 的 wrap/unwrap），
 *    所以版本迁移链一行都不用改 —— KV 只是换了个存放介质。
 * 3. **"没有这条"与"这条坏了"分开**（P132）：`kvReadStrict` 会区分，坏值不许被
 *    陈旧文件回写覆盖 —— 那是"用迁移日的数据替换当前数据"。
 *
 * ## 回退开关
 *
 * `DSH_STORE_BACKEND=file` 就让所有 store 走回 JSON 文件（见 `jsonStore.ts` 的选择逻辑）。
 * ⚠️ 这个开关只切"介质"，不该变成"时间机器"：`jsonStore` 在文件模式下会拿 KV 的
 * `updated_at` 与文件 mtime 比，谁新读谁，并把"文件落后"如实报出来（P133）。
 */

/** 库文件名（与 `sessions.db` 并列放在数据目录下）。 */
export const KV_FILE = "stores.db";

type Handle = { db: SqliteDatabase };

/** 按数据目录缓存句柄（同一个目录复用同一个连接）。 */
const handles = new Map<string, Handle>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * 目录的归一化（句柄缓存键 + 关句柄都走它）。
 *
 * ⚠️ 必须与键的归一化同一套口径：Windows 上 `C:\Users\x` 与 `c:\users\x` 是同一个目录，
 * 不归一就会在 `handles` 里存成两项 —— 同一物理库两个连接，`closeKv` 还只关得掉一个（P142）。
 */
export function normalizeKvDir(dir: string): string {
  const abs = path.resolve(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * **旧口径**的键：数据文件的绝对路径（Windows 大小写归一）。
 *
 * ⚠️ 只为**兼容读**改动之前写进库里的老键，不用于新写入 —— 新写入走 `kvStoreKey`（P100/P128）。
 */
export function kvKeyFor(file: string): string {
  const abs = path.resolve(file);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/**
 * **稳定键**：相对数据目录的路径。
 *
 * 文件不在数据目录下（例如宿主用了别的目录）时退回绝对路径 —— 那种 store 本来
 * 就与数据目录无关，"相对"没有意义。
 *
 * @param dir 数据目录
 * @param file 数据文件的绝对路径
 * @returns 与机器/目录位置无关的键
 */
export function kvStoreKey(dir: string, file: string): string {
  const abs = path.resolve(file);
  const base = path.resolve(dir);
  const rel = path.relative(base, abs);
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  const raw = inside ? rel : abs;
  return process.platform === "win32" ? raw.toLowerCase() : raw;
}

/** 库里的键是不是"路径形状"（旧口径的键、或别的机器带来的键）。 */
function isPathLikeKey(key: string): boolean {
  // `C:\...`（绝对）、`C:foo`（盘相对，旧备份里可能出现的畸形态）、`\\server\share` —— 都算路径
  return path.isAbsolute(key) || /^[a-zA-Z]:/.test(key) || key.startsWith("\\\\");
}

/** 这条键像不像"另一个盘 / 另一台机器的路径"（恢复侧据此明确报出来，而不是写进一串死键）。 */
export function looksLikeForeignPathKey(key: string): boolean {
  return isPathLikeKey(key);
}

/**
 * 把一个库里的键收成稳定键（备份/列表用）。
 *
 * 路径形状且在本目录下 → 相对路径；否则原样（不在本目录下的旧键，交由恢复侧明确报出来）。
 */
export function normalizeStoredKey(dir: string, key: string): string {
  if (!isPathLikeKey(key)) return key;
  if (!path.isAbsolute(key)) return key; // 盘相对这种畸形态不猜，原样留着（恢复侧会报"用不了"）
  return kvStoreKey(dir, key);
}

function handleFor(dir: string): Handle {
  const key = normalizeKvDir(dir);
  const hit = handles.get(key);
  if (hit) return hit;
  /*
   * ⚠️ 先建目录再开库：`openSqlite` 不会替我们建目录，与 `sqliteStore.ts` 的
   * `mkdirSync`（会话库那边有）不对称 —— 少这一步，数据目录还没建时一次读就让
   * 14 个 store 全体抛异常（P131）。
   */
  fs.mkdirSync(key, { recursive: true });
  const db = openSqlite(path.join(key, KV_FILE));
  db.exec(SCHEMA);
  const made: Handle = { db };
  handles.set(key, made);
  return made;
}

/**
 * 后端选择：SQLite 还是文件。
 *
 * 判据是环境变量（`file` 走回退），默认 SQLite —— 方案的 12.1 就是"存储全面 SQLite 化"。
 */
export function backendKind(): "sqlite" | "file" {
  return process.env.DSH_STORE_BACKEND?.trim().toLowerCase() === "file" ? "file" : "sqlite";
}

/** 库里的一行。 */
type Row = { value: string; updated_at: number };

function rowFor(dir: string, key: string): Row | undefined {
  return handleFor(dir).db.prepare("SELECT value, updated_at FROM kv WHERE key = ?").get(key) as Row | undefined;
}

/** 一次带状态的读（P132：区分「没有」与「坏了」）。 */
export type KvReadResult =
  | { status: "missing" }
  | { status: "ok"; value: unknown; updatedAt: number }
  | { status: "corrupt"; raw: string; updatedAt: number };

function parseRow(row: Row): KvReadResult {
  try {
    return { status: "ok", value: JSON.parse(row.value) as unknown, updatedAt: row.updated_at };
  } catch {
    return { status: "corrupt", raw: row.value, updatedAt: row.updated_at };
  }
}

/** 把一条老键的值搬成稳定键（best-effort：搬不动就照旧读得到，不影响这次读取）。 */
function migrateLegacyKey(dir: string, stableKey: string, legacyKey: string, row: Row): void {
  try {
    const handle = handleFor(dir);
    handle.db
      .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(stableKey, row.value, row.updated_at);
    handle.db.prepare("DELETE FROM kv WHERE key = ?").run(legacyKey);
  } catch {
    /* 搬不动不影响这次读取 —— 下次再搬 */
  }
}

/**
 * 读一条（带状态）。**推荐用它**：`kvRead` 会把"坏了"和"没有"混成一个 `null`。
 *
 * @param dir 数据目录
 * @param file 数据文件的绝对路径
 * @returns 三种状态之一；老键命中时顺手搬成稳定键
 */
export function kvReadStrict(dir: string, file: string): KvReadResult {
  const stableKey = kvStoreKey(dir, file);
  const hit = rowFor(dir, stableKey);
  if (hit) return parseRow(hit);
  const legacyKey = kvKeyFor(file);
  if (legacyKey === stableKey) return { status: "missing" };
  const old = rowFor(dir, legacyKey);
  if (!old) return { status: "missing" };
  const parsed = parseRow(old);
  if (parsed.status === "ok") migrateLegacyKey(dir, stableKey, legacyKey, old);
  return parsed;
}

/** 读一条。没有 / 读不动 → `null`（调用方去读旧文件或给兜底值）。 */
export function kvRead(dir: string, file: string): unknown | null {
  const got = kvReadStrict(dir, file);
  return got.status === "ok" ? got.value : null;
}

/** 读一条的元信息（值 + 最后写入时刻）；没有 → `null`。**不**把坏值当没有。 */
export function kvEntry(dir: string, file: string): { value: unknown; updatedAt: number } | null {
  const got = kvReadStrict(dir, file);
  return got.status === "ok" ? { value: got.value, updatedAt: got.updatedAt } : null;
}

/**
 * 读一条的元信息，但**不建库**：库文件本来就不在 → 直接 `null`。
 *
 * 给回退开关（`DSH_STORE_BACKEND=file`）用 —— 那条路只读 JSON 文件，不该顺手
 * 建出一个 `stores.db` 还把句柄一直开着（测试里表现为临时目录删不掉，用户那里
 * 表现为"我把后端切回文件了怎么还多出个库文件"）。
 */
export function kvEntryExisting(dir: string, file: string): { value: unknown; updatedAt: number } | null {
  try {
    if (!fs.existsSync(path.join(path.resolve(dir), KV_FILE))) return null;
  } catch {
    return null;
  }
  return kvEntry(dir, file);
}

/** 按**原始键**读（恢复备份时用：键来自备份文件，不是本机算出来的文件路径）。 */
export function kvReadByKey(dir: string, key: string): unknown | null {
  const row = rowFor(dir, normalizeStoredKey(dir, key));
  if (!row) return null;
  return parseRow(row).status === "ok" ? (JSON.parse(row.value) as unknown) : null;
}

/** 按**原始键**写（恢复备份时用）。 */
export function kvWriteKey(dir: string, key: string, value: unknown): void {
  handleFor(dir)
    .db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(normalizeStoredKey(dir, key), JSON.stringify(value), Date.now());
}

/** 写一条（同键覆盖）。 */
export function kvWrite(dir: string, file: string, value: unknown): void {
  kvWriteKey(dir, kvStoreKey(dir, file), value);
}

/** 某个数据目录下已经进了 KV 的全部键（备份/导出用）。键已收成稳定口径；同键取最新一条。 */
export function kvList(dir: string): Array<{ key: string; value: unknown; updatedAt: number }> {
  const rows = handleFor(dir).db.prepare("SELECT key, value, updated_at FROM kv ORDER BY key").all() as Array<{
    key: string;
    value: string;
    updated_at: number;
  }>;
  const byKey = new Map<string, { value: unknown; updatedAt: number }>();
  for (const r of rows) {
    let value: unknown;
    try {
      value = JSON.parse(r.value) as unknown;
    } catch {
      /* 坏值跳过（导出不该因为一条坏值整体失败） */
      continue;
    }
    const stable = normalizeStoredKey(dir, r.key);
    const prev = byKey.get(stable);
    if (prev && prev.updatedAt >= r.updated_at) continue;
    byKey.set(stable, { value, updatedAt: r.updated_at });
  }
  return [...byKey.entries()].map(([key, v]) => ({ key, value: v.value, updatedAt: v.updatedAt }));
}

/** 关掉某个目录的句柄（进程退出 / 测试收尾）。 */
export function closeKv(dir?: string): void {
  if (dir) {
    const key = normalizeKvDir(dir);
    const hit = handles.get(key);
    if (hit) {
      try {
        hit.db.close();
      } catch {
        /* 已经关了 */
      }
      handles.delete(key);
    }
    return;
  }
  for (const key of [...handles.keys()]) closeKv(key);
}
