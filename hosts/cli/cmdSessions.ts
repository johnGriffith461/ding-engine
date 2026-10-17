/**
 * `ding sessions` / `ding sessions --cost` —— 会话列表、导出与成本账本。
 *
 * 从 `ding.ts` 拆出来的（结构守卫 C6-5）。
 */
import { formatTotal, ledgerOf, localDay, rollup, type LedgerEntry } from "../../engine/core/ledger";
import { logLine } from "../../engine/core/events";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { modelInfoOf } from "../../engine/runtime/models";
import { softLimitNotice } from "../../engine/core/notices";
import { readConfig } from "./config";
import { flag, type Parsed } from "./args";
export async function cmdCost(p: Parsed, dataDir: string): Promise<number> {
  const store = createSqliteSessionStore(dataDir);
  try {
    const kind = flag(p, "kind");
    const sessions = await store.list(kind === "chat" || kind === "task" || kind === "cli" ? { kind } : undefined);
    const entries: LedgerEntry[] = [];
    for (const summary of sessions) {
      const { records } = await store.load(summary.sessionId);
      // 只给会话维度留标题（其它维度用的是日期/模型名，不需要）
      const book = ledgerOf(records, summary.sessionId);
      for (const e of book) entries.push({ ...e });
      titles.set(summary.sessionId, summary.title || summary.sessionId);
    }

    const by = flag(p, "by");
    const dim = by === "day" || by === "model" ? by : "session";
    // 目录表从 runtime 递进来（core 的账本自己不去查表 —— 分层方向）
    const rows = rollup(entries, dim, (key) => titles.get(key) || key, modelInfoOf);
    if (p.flags.has("json")) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (!rows.length) {
      console.log("账本还是空的（没有任何一轮带 provider 上报的用量）。");
      return 0;
    }
    for (const row of rows) console.log(formatTotal(row));
    console.log("[2m口径：数字全部来自 provider 上报的 usage；`-` 表示 provider 没给（不是 0）。[0m");

    /*
     * 软限额（Phase 13.2）：**只在用户自己设过的时候**才算、才说。
     * 没设就不提 —— 替用户定一个他没同意的额度比不提示更烦人。
     */
    const limit = readConfig(dataDir).config.softLimitUsd;
    if (limit && limit > 0) {
      /*
       * ⭐ 今天花了多少：**直接从账目里按"本地日"取**（2026-10-16，审计 P151 / P203）。
       *
       * 原来是在 rollup 的结果行里找 `key === new Date().toISOString().slice(0, 10)`：
       *   · 默认维度是 `session`，行的 key 是 sessionId —— 永远找不到，
       *     于是 `spent = 0`、整块 `if (spent > 0)` 进不去，**这条提示在默认调用下从不出现**；
       *   · 就算显式用 `--by day`，`toISOString` 给的是 **UTC 日**，
       *     而账本自己（`localDay`）用的是本地日 —— 跨零点那几小时会算到前一天上。
       */
      const today = localDay(Date.now());
      /* 复用同一份"按天汇总 + 目录单价估算"的口径（`rollup` 的 day 维就是 localDay） */
      const spent = rollup(entries, "day", (key) => key, modelInfoOf).find((r) => r.key === today)?.estimatedCost ?? 0;
      if (spent > 0) {
        console.log("");
        console.log(softLimitNotice(spent, limit, spent / limit));
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

/** 会话 id → 标题（成本账本按会话汇总时给人看的那一列）。 */
const titles = new Map<string, string>();

export async function cmdSessions(p: Parsed, dataDir: string): Promise<number> {
  /*
   * `--search <词>`（Phase 12.4）：本地全文检索。
   * 走 store 的 search 口子（FTS + LIKE 并集），所以桌面侧将来接同一个口子就行。
   */
  const query = flag(p, "search");
  if (query) {
    const store = createSqliteSessionStore(dataDir);
    try {
      const hits = await store.search(query, { limit: 30 });
      if (p.flags.has("json")) {
        process.stdout.write(JSON.stringify({ query, hits }, null, 2) + "\n");
        return 0;
      }
      if (!hits.length) {
        process.stdout.write(`没搜到「${query}」。换个词试试（检索的是会话正文，不是标题）。\n`);
        return 0;
      }
      process.stdout.write(`搜到 ${hits.length} 段会话（按命中多少排序）：\n\n`);
      for (const hit of hits) {
        const when = new Date(hit.updatedAt).toLocaleString();
        process.stdout.write(`  ${hit.sessionId}  ${when}  命中 ${hit.hits} 处\n`);
        if (hit.title) process.stdout.write(`    ${hit.title}\n`);
        process.stdout.write(`    ${hit.excerpt}\n\n`);
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (p.flags.has("cost")) return cmdCost(p, dataDir);
  const store = createSqliteSessionStore(dataDir);
  try {
    const kind = flag(p, "kind");
    const list = await store.list(kind === "chat" || kind === "task" || kind === "cli" ? { kind } : undefined);

    const exportId = flag(p, "export");
    if (exportId) {
      const { records, skipped } = await store.load(exportId);
      /*
       * 用 `logLine` 而不是自己 `JSON.stringify(record)`：那一行是 `.jsonl` 的**格式定义**
       * （`parseLog` 是它的读侧），自己拼一遍就等于把这个格式写了两份 ——
       * 而迁移路径吃的正是这个格式，两份一旦不一致，"导出的文件导不回去"。
       */
      for (const record of records) process.stdout.write(logLine(record, record.seq, record.at));
      process.stderr.write(`\x1b[2m导出了 ${records.length} 条${skipped ? `（跳过 ${skipped} 条坏行）` : ""}\x1b[0m\n`);
      return 0;
    }
    if (p.flags.has("json")) {
      process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      return 0;
    }
    if (!list.length) {
      process.stdout.write("还没有任何会话。\n");
      return 0;
    }
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString("zh-CN");
      const kb = `${Math.round(s.bytes / 1024)}KB`;
      process.stdout.write(`${s.sessionId.padEnd(28)} ${when.padEnd(22)} ${kb.padStart(6)}  ${s.title || "（没有标题）"}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

