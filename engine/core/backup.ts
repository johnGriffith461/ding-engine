import type { LogRecord } from "./events";
import type { LogInputAt } from "../ports/store";
import type { SessionSummary } from "../../shared/ipc";

/**
 * 备份与恢复（Phase 12.3）。
 *
 * 方案原文：「`ding backup` / `ding restore` 全量（会话 + 配置 + 注册表引用）单文件 roundtrip」，
 * 验收是「恢复后评测集重放行为一致 —— **数据是用户的**」。
 *
 * ## 为什么是"一个 JSON 文件"而不是 zip
 *
 * 用户要能**自己看懂备份里有什么**：出问题时他能打开看一眼、能手动救出一段对话。
 * 二进制容器（zip/tar）会把这件事变成"得写个脚本才能读"。代价是文件大一些（JSON 不压缩），
 * 但备份本来就该是可以慢慢传的东西。
 *
 * ## 逻辑在这里，IO 在宿主
 *
 * 这个文件**不碰磁盘**：`buildBackup` 收一份已经读出来的数据、产出一个纯对象；
 * `applyBackup` 收一个纯对象、通过注入的写入口落回去。这样"备份了什么、恢复了什么"
 * 能被单测一遍遍验（`engine/core/backup.test.ts`），而不是靠人工做一次。
 *
 * ## 一条硬规矩：**恢复不删东西**
 *
 * `applyBackup` 只**追加**：
 *   · 会话：**按内容**跳过本地已有（同一段内容不重复入库），新的追加在后面；
 *   · 配置型 store：`readStore` 报"这台机器上已经有"的键一律**跳过**（不动用户现在的设置）。
 *
 * 理由：备份文件可能是三天前的，而用户这三天又聊了一堆 —— 直接覆盖等于用旧数据
 * 抹掉新的。想"完全回到备份那一刻"是另一件事（用户手动把 sessions.db 挪走再恢复），
 * 不该是默认行为。
 *
 * ⚠️ 这条规矩以前**只是写在注释里**：`RestorePorts` 没有"读一条 store"的口子，
 * 所以配置型 store 实际是**无条件覆盖**（P99/P123/P196，与 CLI 打印的"只补不覆盖"相反）。
 * 现在 `readStore` 是真口子，跳过与计数都落在报告里。
 */

/** 备份格式版本（将来改格式时靠它判断）。 */
export const BACKUP_VERSION = 1;

/**
 * 恢复侧"这条键在本机用不了"的标记（跨机器带来的旧式绝对路径键）。
 *
 * `readStore` 返回它 → `applyBackup` 记进 `storesUnavailable` 并跳过，
 * 而不是把值写到一串**没人会查**的键上、然后在报告里说"恢复了 N 项"（P100/P128）。
 */
export const UNMAPPABLE_STORE_KEY = Symbol("unmappable-store-key");

/** 备份文件里的一份会话。 */
export type BackupSession = {
  sessionId: string;
  /** 落盘形态的记录（带 seq/at）。 */
  records: LogRecord[];
};

/** 备份文件的内容。 */
export type BackupPayload = {
  kind: "ding-harness-backup";
  version: number;
  exportedAt: string;
  /**
   * 这台机器上的数据目录（**只是记个出处**，恢复时不用它 —— 备份该能跨机器用）。
   *
   * ⚠️ 默认只存**目录名**（`path.basename`）：完整路径里带用户名/机器名，
   * 而这个文件是要拿去分享/传别的机器的（P145）。要完整路径就显式 `--keep-provenance`。
   */
  fromDataDir: string;
  /** 完整的数据目录（只在 `--keep-provenance` 时出现）。 */
  fromDataDirFull?: string;
  /** 会话（含日志正文）。 */
  sessions: BackupSession[];
  /**
   * 配置型 store 的内容（KV 里那些键值）。
   *
   * ⚠️ 值是**信封**（`{__schema, data}`），不是裸数据 —— 恢复时直接放回 KV，
   * 读出来仍然过同一套版本迁移。这里不做"拍平"，因为拍平就等于多一份要维护的翻译。
   */
  stores: Array<{ key: string; value: unknown }>;
  /** CLI 配置（provider / model / mode / dirs）。 */
  config?: unknown;
  /** 汇总（给人看的一行）。 */
  summary: {
    sessions: number;
    records: number;
    stores: number;
  };
};

/**
 * 取路径的最后一段（**纯字符串**：`engine/core/**` 不许 import 任何 `node:*`，见 `kernelBoundary.test.ts`）。
 *
 * 只为把完整数据目录脱敏成目录名，不做任何文件系统判断。
 */
function baseName(p: string): string {
  const cleaned = String(p ?? "").replace(/[\\/]+$/, "");
  const at = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return at >= 0 ? cleaned.slice(at + 1) : cleaned;
}

/** 建一份备份（纯函数：只整理，不落盘）。 */
export function buildBackup(input: {
  fromDataDir: string;
  sessions: BackupSession[];
  stores: Array<{ key: string; value: unknown }>;
  config?: unknown;
  now?: Date;
  /** 把**完整**数据目录写进备份（默认只写目录名，见 `fromDataDir`）。 */
  keepProvenance?: boolean;
}): BackupPayload {
  const records = input.sessions.reduce((n, s) => n + s.records.length, 0);
  const safeDir = baseName(input.fromDataDir) || input.fromDataDir;
  return {
    kind: "ding-harness-backup",
    version: BACKUP_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    fromDataDir: safeDir,
    ...(input.keepProvenance ? { fromDataDirFull: input.fromDataDir } : {}),
    sessions: input.sessions,
    stores: input.stores,
    ...(input.config === undefined ? {} : { config: input.config }),
    summary: { sessions: input.sessions.length, records, stores: input.stores.length },
  };
}

/** 备份里一条记录的最小形状校验（**不收窄形状**，只挡住"根本不是记录"那种）。 */
function looksLikeRecord(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const type = (raw as { type?: unknown }).type;
  return type === undefined || typeof type === "string";
}

/** 校验一份备份（**磁盘上的东西不可信**：手改过/拷坏了都要说清而不是崩）。 */
export function validateBackup(raw: unknown): { ok: true; payload: BackupPayload } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "不是一个对象（文件可能拷坏了）" };
  const o = raw as Partial<BackupPayload>;
  if (o.kind !== "ding-harness-backup") return { ok: false, reason: "kind 不是 ding-harness-backup —— 这不是本程序的备份" };
  if (typeof o.version !== "number" || !Number.isInteger(o.version) || o.version < 1 || o.version > BACKUP_VERSION) {
    /*
     * ⚠️ P145：原来只挡 `version > BACKUP_VERSION` —— 于是 `0`、负数、`NaN`
     * （`typeof NaN === "number"`，且 `NaN > 1` 为 false）全都"通过"，被当成第 1 版恢复。
     * 版本号是格式契约的地基，读不懂就一律拒绝。
     */
    if (typeof o.version === "number" && o.version > BACKUP_VERSION) {
      // 更高版本的备份**不要猜着恢复**：可能有不认识的字段，恢复出来是半截数据
      return { ok: false, reason: `备份是第 ${o.version} 版，本程序只认到第 ${BACKUP_VERSION} 版（升级之后再恢复）` };
    }
    return { ok: false, reason: `version 必须是 1..${BACKUP_VERSION} 之间的整数，读到的却是 ${String(o.version)}` };
  }
  if (!Array.isArray(o.sessions)) return { ok: false, reason: "sessions 不是数组" };
  if (!Array.isArray(o.stores)) return { ok: false, reason: "stores 不是数组" };
  for (const s of o.sessions) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return { ok: false, reason: "sessions 里有一条不是对象" };
    const sess = s as { sessionId?: unknown; records?: unknown };
    if (typeof sess.sessionId !== "string" || !sess.sessionId.trim()) {
      return { ok: false, reason: "sessions 里有一条缺 sessionId" };
    }
    if (sess.sessionId.includes("..")) {
      // 会话 id 会被当键写进库：`.`/`..` 这类不合法（与 JSONL 侧同一条规矩）
      return { ok: false, reason: `会话 id 里有 ..（拒绝）：${sess.sessionId}` };
    }
    if (!Array.isArray(sess.records)) {
      return { ok: false, reason: `会话 ${sess.sessionId} 的 records 不是数组` };
    }
    for (const r of sess.records) {
      if (!looksLikeRecord(r)) return { ok: false, reason: `会话 ${sess.sessionId} 里有一条记录不是对象` };
    }
  }
  for (const e of o.stores) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return { ok: false, reason: "stores 里有一条不是对象" };
    if (typeof (e as { key?: unknown }).key !== "string" || !(e as { key: string }).key.trim()) {
      return { ok: false, reason: "stores 里有一条缺 key" };
    }
  }
  return { ok: true, payload: o as BackupPayload };
}

/** 恢复时用到的写入口（宿主给：会话 store + KV）。 */
export type RestorePorts = {
  /** 读某个会话**已有**的记录（用来判重，见下面"只追加"）。 */
  loadSession: (sessionId: string) => Promise<{ records: LogRecord[] }>;
  /** 追加一批记录（返回落盘形态）。 */
  appendSession: (sessionId: string, records: readonly LogInputAt[]) => Promise<LogRecord[]>;
  /**
   * 读一条配置型 store 现在有没有。`null`/`undefined` = 没有；`UNMAPPABLE_STORE_KEY` = 这台机器上这条键用不了。
   *
   * ⚠️ 这个口子**必须**给：没有它，"已有的键跳过"在结构上就兑现不了（P99/P123/P196）。
   */
  readStore?: (key: string) => unknown | null;
  /** 写一条配置型 store 的值。 */
  writeStore: (key: string, value: unknown) => void;
  /** 写回 CLI 配置（可选：宿主不给就跳过）。 */
  writeConfig?: (config: unknown) => void;
};

/** 一次恢复的结果（报给用户看的数字）。 */
export type RestoreReport = {
  sessions: number;
  recordsAdded: number;
  recordsSkipped: number;
  /** 真正写进去的配置型 store 项数（"补"的那部分）。 */
  stores: number;
  /** 本机已有、按"只补不覆盖"跳过的项数。 */
  storesSkipped: number;
  /** 跨机器带来的键（旧式绝对路径）在本机用不了、没能恢复的项数。 */
  storesUnavailable: number;
  configRestored: boolean;
};

/**
 * 一条记录的**内容指纹**（去掉 `seq`/`at` —— 它们是存储自己编的，跨机器必然不同）。
 *
 * 键排序后序列化，所以同一段内容换个键序也是同一个指纹。
 */
function recordSignature(record: unknown): string {
  const { seq: _seq, at: _at, ...rest } = (record ?? {}) as Record<string, unknown>;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * 恢复一份备份。
 *
 * **只补不覆盖**：
 *   · 会话：按**内容指纹**判重（同一段内容不重复入库）；备份里本地没有的一律追加。
 *     ⚠️ 原来按 `seq` 判重：`seq` 是每台机器自己的编号，跨机器同 id 会话会在
 *     `seq` 上与本地撞车，于是备份的**前几轮被静默当"已存在"丢掉**（P210）。
 *   · 配置型 store：`readStore` 说"本机已有"就跳过（不动用户现在的设置），只补缺失的键。
 *
 * ## ⚠️ 原子性的**边界**（2026-10-16，审计 P130 如实记）
 *
 * 它是**逐会话原子**的，不是整体原子的：
 *
 * · 每个会话**只调一次** `appendSession`，而端口对那一次调用的承诺是
 *   "这一批要么都进、要么都不进"（`engine/ports/store.ts` 的 `append` 注释，
 *   SQLite 版就是整批一个事务）—— 所以不会出现"某个会话只恢复了一半"；
 * · 但**多个会话之间**没有共同的事务：第 3 个会话写失败时，前 2 个已经在库里了。
 *   这是**追加语义**下最合理的粒度：回滚要做的是"把已经追加的再删掉"，
 *   而它与"只补不覆盖"直接冲突 —— 删错了就是**拿回滚把一个好备份变成数据损失**。
 *
 * 所以恢复中途失败时：错误**照实抛出去**（调用方能告诉用户"恢复到哪一步停的"），
 * 而那之前已经落库的会话是**有效的部分恢复**，不是坏数据（它们的判重关系没被破坏，
 * 下一次恢复会把剩下的补齐）。想要"要么全有要么一点没有"，要的是恢复**之前**的快照，
 * 那是宿主的活（CLI 侧已经落一份 `pre-restore-<ts>.json`）。
 *
 * @param payload 已通过 `validateBackup` 的备份
 * @param ports 写入口
 * @returns 恢复报告
 */
export async function applyBackup(payload: BackupPayload, ports: RestorePorts): Promise<RestoreReport> {
  let recordsAdded = 0;
  let recordsSkipped = 0;

  for (const session of payload.sessions) {
    if (!session?.sessionId || !Array.isArray(session.records)) continue;
    const existing = await ports.loadSession(session.sessionId);
    /* 内容指纹 → 本地已有条数（多重集：本地有两条一样的内容就只跳过两条） */
    const have = new Map<string, number>();
    for (const r of existing.records) {
      const sig = recordSignature(r);
      have.set(sig, (have.get(sig) ?? 0) + 1);
    }
    const missing: LogRecord[] = [];
    for (const r of session.records) {
      const sig = recordSignature(r);
      const n = have.get(sig) ?? 0;
      if (n > 0) {
        have.set(sig, n - 1);
        recordsSkipped += 1;
        continue;
      }
      missing.push(r);
    }
    if (!missing.length) continue;
    /*
     * 走 `LogInputAt`：**去掉 `seq` 让存储自己重新编号**（存储的编号才是权威 ——
     * 备份里的编号是那台机器的），但 **`at` 要原样带上**（审计 P14 / P31）。
     *
     * 恢复是**搬运**，不是"这些东西现在才发生"：三段不同月份的历史恢复进来之后
     * 还该分属那三个月份（成本账本按天的口径读的就是记录里的 `at`）。
     * 指纹判重那一层（`recordSignature`）另外把 `seq`/`at` 都剔掉 —— 那是"内容是否同一"
     * 的判据，与本条无关，两处口径各管各的。
     */
    const toWrite: LogInputAt[] = missing.map((r) => {
      const { seq: _seq, ...rest } = r as LogRecord & { seq: number };
      return rest as LogInputAt;
    });
    const written = await ports.appendSession(session.sessionId, toWrite);
    recordsAdded += written.length;
  }

  let stores = 0;
  let storesSkipped = 0;
  let storesUnavailable = 0;
  for (const entry of payload.stores) {
    if (!entry?.key) continue;
    if (ports.readStore) {
      let existing: unknown;
      try {
        existing = ports.readStore(entry.key);
      } catch {
        existing = null; // 读不了就当没有（写入口自己还有一层判断）
      }
      if (existing === UNMAPPABLE_STORE_KEY) {
        storesUnavailable += 1;
        continue;
      }
      if (existing !== null && existing !== undefined) {
        storesSkipped += 1;
        continue;
      }
    }
    ports.writeStore(entry.key, entry.value);
    stores += 1;
  }

  let configRestored = false;
  if (payload.config !== undefined && ports.writeConfig) {
    ports.writeConfig(payload.config);
    configRestored = true;
  }

  return {
    sessions: payload.sessions.length,
    recordsAdded,
    recordsSkipped,
    stores,
    storesSkipped,
    storesUnavailable,
    configRestored,
  };
}

/** 备份里到底有没有配置内容（空对象不算）。 */
function hasConfig(config: unknown): boolean {
  return Boolean(config && typeof config === "object" && Object.keys(config as object).length > 0);
}

/** 备份里有哪些会话（`ding restore --list` 用它先给人看一眼）。 */
export function describeBackup(payload: BackupPayload): string {
  const when = new Date(payload.exportedAt);
  const lines = [
    `备份来自：${payload.fromDataDir}`,
    `导出时间：${Number.isNaN(when.getTime()) ? payload.exportedAt : when.toLocaleString()}`,
    `格式版本：${payload.version}`,
    /*
     * `config` 是个**空对象**时不该说"含 CLI 配置"（那只是没配过）——
     * 报的话得与事实对得上，不然用户会去找一份并不存在的配置。
     */
    `内容：会话 ${payload.summary.sessions} 段 / 记录 ${payload.summary.records} 条 / 配置型 store ${payload.summary.stores} 项${hasConfig(payload.config) ? "（含 CLI 配置）" : ""}`,
  ];
  const top = [...payload.sessions]
    .sort((a, b) => b.records.length - a.records.length)
    .slice(0, 5);
  if (top.length) {
    lines.push("", "最大的几段会话：");
    for (const s of top) lines.push(`  ${s.sessionId}  ${s.records.length} 条`);
  }
  return lines.join("\n");
}

/** 会话摘要（`ding backup` 的清单里用；与 `SessionStore.list` 同形）。 */
export type BackupSessionSummary = SessionSummary;
