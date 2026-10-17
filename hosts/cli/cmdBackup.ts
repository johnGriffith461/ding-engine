import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { createSqliteSessionStore, type RetentionPolicy } from "../../engine/adapters/sqliteStore";
import { backendKind, kvList, kvReadByKey, kvWriteKey, looksLikeForeignPathKey } from "../../engine/adapters/kvStore";
import {
  UNMAPPABLE_STORE_KEY,
  applyBackup,
  buildBackup,
  describeBackup,
  validateBackup,
  type BackupPayload,
} from "../../engine/core/backup";
import { flag, type Parsed } from "./args";
import { configPaths, normalizeConfig, readConfig, writeConfig } from "./config";

/**
 * `ding backup` / `ding restore` —— 数据主权（Phase 12.3）。
 *
 * ## 为什么这两条命令重要
 *
 * 方案里这一节的标题是"**日常可靠与数据主权**"。备份不只是容灾：
 * 它意味着"**这些数据是我的**，我可以拿走、可以自己看、可以搬到另一台机器"。
 * 所以备份是**一个能打开的 JSON 文件**（见 `engine/core/backup.ts` 的说明），
 * 而不是一个只有本程序能读的容器。
 *
 * ## 绑三个来源，与 `ding backup --list` 的信息一致
 *
 * | 来源 | 在哪 |
 * |---|---|
 * | 会话日志（含工具留痕、审批、账本） | `sessions.db` 的 events 表 |
 * | 配置型 store（任务 / 记忆 / 定时 / 工作区…） | `stores.db` 的 kv 表 |
 * | CLI 配置（provider / model / 档位 / 目录） | `config.json` |
 *
 * ⚠️ **不含密钥**：凭据在 `~/.dsh/.credentials.yaml`，那是另一个程序的资产，
 * 也**不该**被一个随手分享的备份文件带走。这一条写在这里，免得有人"顺手加上"。
 *
 * ## 两个数据根与 `--data-dir`（审计 P129 / NEW-N2-7）
 *
 * 桌面的数据落在 `app.getPath("userData")`（受 `DSH_CANVAS_DATA_DIR` 管），
 * CLI 落在 `~/.ding`（受 `DH_DATA_DIR` 管）——**两个根互不相干**。
 * 默认这条命令只动宿主给的那个根；想备份/恢复桌面那份，用 `--data-dir` 显式指过去
 * （`resolveBackupDataDir`）。**一次只动一个根**是刻意的：把多个根合并进一份备份
 * 要改备份格式（`engine/core/backup.ts` 的 `fromDataDir` 是单值），那不在本工单的
 * 文件范围里。
 */

/**
 * 备份/恢复打开会话库时用的保留策略：**一道收口都不跑**（审计 P125 / NEW-N2-3）。
 *
 * `createSqliteSessionStore()` 打开时就会跑一次收口（`pruneStore()`），默认
 * `SQLITE_RETENTION` 是 `maxAgeDays:30 / maxSessions:400 / maxBytes:64MB`。
 * 于是**读一下**就等于**删一批**：`ding backup` 在写备份文件**之前**先把超过 30 天的
 * 会话删掉 —— 而它们正是备份该带走的东西（第一次备份就把它们删了，备份文件里
 * 永远不会有它们）；`ding restore` 也会在恢复之前先删本地旧会话。
 *
 * ⚠️ 根因在 `engine/adapters/sqliteStore.ts`（保留策略应改成**显式** `prune()` 才跑，
 * 见汇报里"需要别人改哪一行"）。这里先从**宿主侧**把口子堵上：三道阈值全推到
 * 不可能触发的位置（年龄上限取 `MAX_SAFE_INTEGER`、条数与字节取 `Infinity`）。
 */
const NO_PRUNE: RetentionPolicy = {
  maxAgeDays: Number.MAX_SAFE_INTEGER,
  maxSessions: Number.POSITIVE_INFINITY,
  maxBytes: Number.POSITIVE_INFINITY,
};

/** 把 `--out` / 默认名收窄成一个**安全**的输出落点判定（审计 P124 / P214）。 */
export type OutputPathDecision = { ok: true; file: string } | { ok: false; message: string };

/**
 * 算出一个"不会盖掉别的东西"的输出路径。
 *
 * ## 为什么必须有它（这不只是"防手滑"）
 *
 * 原来的形状是 `out = flag(p,"out") ?? 默认名` 之后**原样** `writeFileSync`。
 * 于是 `ding backup --out data/sessions.db`（或 `--out ~/.ding/config.json`）
 * 会用一段**文本**盖掉真正的 SQLite 库/配置文件 → 全部历史报废，
 * 而程序只在下一行打印「备份完成」（审计 P124 / NEW-N2-2）。
 * 显式 `--out` 还绕过了"默认名带时间戳"那条自我保护，无条件覆盖上一份备份
 * （审计 P214 / NEW-N7-23）。
 *
 * ## 四条判据（备份与 `recipe export` 共用这一份）
 *
 * 1. 扩展名必须是 `.json`：备份/导出都是给人看的 JSON，落在别的扩展名上多半是
 *    指错了文件（指到了库或配置）；
 * 2. **不许落在数据目录里**：那里装着 `sessions.db` / `stores.db` / `config.json`，
 *    写进去就等于用备份覆盖数据；
 * 3. 已存在且没给 `--force` → 拒绝（备份不该悄悄覆盖上一个）；
 * 4. 默认名（没给 `--out`）撞名时自动加序号 —— 不覆盖、也不报错挡路。
 *
 * @param raw `--out` 原文（`undefined` = 没给）
 * @param dataDir 这次动的那一个数据根（用来判"是不是落在里面"）
 * @param opts 默认名、是否强制覆盖、当前时间（测试注入）
 */
export function resolveJsonOutputPath(
  raw: string | undefined,
  dataDir: string,
  opts: { defaultName: string; force: boolean },
): OutputPathDecision {
  if (raw === undefined || !raw.trim()) {
    const base = path.resolve(opts.defaultName.replace(/\.json$/i, ""));
    let file = `${base}.json`;
    for (let i = 2; fs.existsSync(file) && i < 1000; i += 1) file = `${base}-${i}.json`;
    return { ok: true, file };
  }

  const file = path.resolve(raw);
  if (path.extname(file).toLowerCase() !== ".json") {
    return {
      ok: false,
      message:
        `--out 只写 .json（给的是「${raw}」）—— ` +
        `落到别的扩展名上多半是把数据文件或配置盖掉了。给个 .json 的名字再试。`,
    };
  }
  const base = path.resolve(dataDir);
  const rel = path.relative(base, file);
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (file === base || (rel !== "" && !outside)) {
    return {
      ok: false,
      message:
        `--out 不能落在数据目录里（${base}）—— 那里装着 sessions.db / stores.db / config.json。\n` +
        `  换个目录，例如：--out ~/ding-backup.json`,
    };
  }
  if (fs.existsSync(file) && !opts.force) {
    return {
      ok: false,
      message:
        `文件已存在：${file}\n` +
        `  备份不该悄悄覆盖上一个 —— 换个名字，或加 --force 明确要覆盖。`,
    };
  }
  return { ok: true, file };
}

/**
 * 这次备份/恢复动的是**哪一个数据根**（审计 P129 / NEW-N2-7）。
 *
 * 默认用宿主给的那个（`DH_DATA_DIR` > `DSH_CANVAS_DATA_DIR` > `~/.ding`，见 `ding.ts`）；
 * 给了 `--data-dir` 就听它的 —— 桌面数据在 `app.getPath("userData")`，
 * 要把它一起备份/恢复就得显式指过去。
 */
export function resolveBackupDataDir(p: Parsed, fallback: string): string {
  const raw = flag(p, "data-dir");
  return raw && raw.trim() ? path.resolve(raw) : fallback;
}

/**
 * 桌面应用的数据根（本机存在才返回）。
 *
 * 用来在 `backup` / `restore` 时**指出**"你桌面的那份在不在这个根里"——
 * `impact` 正是"用户以为备份覆盖了桌面数据，其实一行都没有"（审计 P129）。
 *
 * ⚠️ 原来这份判断在 `ding.ts` 里（`warnDesktopRoot` 用），搬到这里是为了让
 * `cmdBackup` 也能用它（空备份的忠告）——**同一份口径只留一份**。
 */
export function desktopDataDir(): string | null {
  const override = process.env.DSH_CANVAS_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  const appData = process.env.APPDATA;
  if (!appData) return null;
  const guess = path.join(appData, "Ding Harness");
  return fs.existsSync(guess) ? guess : null;
}

/**
 * "这份备份读出来是空的"的忠告（审计 P129 / NEW-N2-7 ②）。
 *
 * `ding backup` 默认只备份 CLI 的根，而桌面那份在 `userData` —— 用户跑完看到
 * 「备份完成」就以为数据都在里面。**0 段会话 + 0 项 store** 时把话说明白：
 * 这个根里没有东西，桌面那份在哪，怎么一起备份。
 *
 * @returns 有东西可备份时返回 `null`（不必打扰）
 */
export function emptyBackupWarning(
  summary: { sessions: number; stores: number },
  dataDir: string,
  desktopDir: string | null,
): string | null {
  if (summary.sessions > 0 || summary.stores > 0) return null;
  const lines = [`⚠️ 这次从 ${dataDir} 里读到 **0 段会话 / 0 项配置型 store** —— 这份备份是空的。`];
  const desktop = desktopDir && path.resolve(desktopDir) !== path.resolve(dataDir) ? desktopDir : null;
  if (desktop) lines.push(`   桌面应用的数据在：${desktop}`);
  lines.push(`   要备份桌面那份：ding backup --data-dir "${desktop ?? "<桌面数据目录>"}" --out <文件.json>`);
  lines.push(`   （也可以让两边用同一个根：DH_DATA_DIR / DSH_CANVAS_DATA_DIR 指到同一个目录。）`);
  return lines.join("\n");
}

/**
 * 恢复侧的后端警告（审计 P134 / NEW-N2-12）。
 *
 * `writeStore` 把值写进 **KV**（`stores.db`）。而 `DSH_STORE_BACKEND=file` 时，
 * 应用读的是 **JSON 文件**、从不读 KV —— 于是恢复"成功"了，用户却一条都看不到
 * （终端还报「配置型 store：N 项」）。这里把这件事**当场说清**。
 *
 * ⚠️ 彻底修法是让 `writeStore` 按 `backendKind()` 也写文件；但那份文件格式
 * （`{__schema, data}` 信封 + `SCHEMA_VERSION`）在 `electron/ipc/jsonStore.ts` 里，
 * CLI 这边复制一份必然漂 —— 那需要把信封口径抽成共享模块，见汇报里"需要别人改哪一行"。
 *
 * @returns 后端是 sqlite（默认）时返回 `null`
 */
export function storeBackendWarning(kind: "sqlite" | "file", dataDir: string): string | null {
  if (kind !== "file") return null;
  return (
    `⚠️ 当前存储后端是 file（DSH_STORE_BACKEND=file）：恢复写进的是 KV（${path.join(dataDir, "stores.db")}），\n` +
    `   而 file 后端读的是 JSON 文件 —— 这次恢复对它**不可见**。\n` +
    `   要么去掉 DSH_STORE_BACKEND 再恢复一次，要么恢复之后用同一后端（文件）跑应用。`
  );
}

/** 恢复这类**会写用户数据**的动作该不该往下走（审计 P130 / NEW-N2-8）。 */
export type RestoreIntent =
  /** `--list`：只看不写。 */
  | "dry-run"
  /** 给了 `--yes`：明确要恢复。 */
  | "confirmed"
  /** 交互式终端、没给 `--yes`：问一句。 */
  | "ask"
  /** 非交互且没给 `--yes`：拒（不替用户在脚本里点"同意"）。 */
  | "refused";

/**
 * 恢复前的确认判定（审计 P130 / NEW-N2-8）。
 *
 * 原来 `ding restore <文件>` 不带 `--list` 就**立刻**写 `sessions.db` + `stores.db`：
 * 没有确认、没有先备份当前、没有事务 —— 一条命令用旧数据换掉现在，且**不可逆**。
 * 这里立三道门：`--list` 只读、`--yes` 明确、交互终端问一句；脚本里（非 TTY）
 * 不给 `--yes` 就**拒**（而不是替它点同意）。
 */
export function restoreIntent(opts: { listOnly: boolean; yes: boolean; interactive: boolean }): RestoreIntent {
  if (opts.listOnly) return "dry-run";
  if (opts.yes) return "confirmed";
  return opts.interactive ? "ask" : "refused";
}

/**
 * 恢复**之前**把当前状态另存一份（审计 P130 / NEW-N2-8）。
 *
 * 恢复是不可逆的：写下去之后"恢复前长什么样"就只能在脑子里回忆。所以先做一次
 * 快照，写到 `<数据根>/pre-restore-<时间戳>.json`（与备份同一种、能打开的格式）。
 *
 * ⚠️ 快照失败就**不往下走**（fail-closed）：连当前状态都存不下来时做不可逆的写，
 * 出了事没有任何退路。
 *
 * @returns 快照文件位置，或失败原因
 */
export async function writePreRestoreSnapshot(
  dataDir: string,
  now: Date = new Date(),
): Promise<{ ok: true; file: string; payload: BackupPayload } | { ok: false; error: string }> {
  try {
    const sessions = await readAllSessions(dataDir);
    const stores = kvList(dataDir).map((e) => ({ key: e.key, value: e.value }));
    const config = readConfig(dataDir).config;
    const payload = buildBackup({ fromDataDir: dataDir, sessions, stores, config });
    const file = path.join(dataDir, `pre-restore-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return { ok: true, file, payload };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? "写不进去" };
  }
}

/** 把所有会话读出来（含记录）。**不带收口**：读一下不该删东西（P125）。 */
async function readAllSessions(storeDir: string) {
  const store = createSqliteSessionStore(storeDir, "sessions.db", NO_PRUNE);
  try {
    // 用 `list()` 拿会话清单（它按时间倒序），逐个 `load`
    const summaries = await store.list();
    const sessions: Array<{ sessionId: string; records: Awaited<ReturnType<typeof store.load>>["records"] }> = [];
    for (const s of summaries) {
      const got = await store.load(s.sessionId);
      sessions.push({ sessionId: s.sessionId, records: got.records });
    }
    return sessions;
  } finally {
    store.close();
  }
}

/**
 * 把备份里的 store 键映射到**本机**的键。
 *
 * - 新格式：键是**相对数据目录**的路径（`tasks.json`，见 `engine/adapters/kvStore.ts`）→ 直接用。
 * - 旧格式：键是本机绝对路径。只有它确实落在**本机**数据目录下才认得出（同机恢复）；
 *   别的机器的绝对路径没有人会去查，返回 `UNMAPPABLE_STORE_KEY` 让报告如实说"这几项没能恢复"，
 *   而不是把它们写进一串死键、然后在终端上说"恢复了 N 项"（P100/P128）。
 */
function mapStoreKey(dataDir: string, key: string): string | typeof UNMAPPABLE_STORE_KEY {
  if (!looksLikeForeignPathKey(key)) return key; // 新格式：相对数据目录的键，直接用
  /*
   * 路径形状：只有它确实是绝对路径、且落在**本机**数据目录下才认得出（同机恢复）。
   * `C:foo` 这种盘相对畸形一律不猜 —— 猜错的代价是把数据写进一串没人会查的键。
   */
  if (!path.isAbsolute(key)) return UNMAPPABLE_STORE_KEY;
  const base = path.resolve(dataDir);
  const rel = path.relative(base, path.resolve(key));
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  return inside ? rel : UNMAPPABLE_STORE_KEY;
}

/**
 * `ding backup [--out <文件.json>] [--data-dir <根>] [--keep-provenance] [--force]`。
 *
 * 默认写到**当前目录**下一个带时间戳的文件名 —— 备份不该悄悄覆盖上一个。
 */
export async function cmdBackup(p: Parsed, dataDir: string): Promise<number> {
  const root = resolveBackupDataDir(p, dataDir);

  const sessions = await readAllSessions(root);
  const stores = kvList(root).map((e) => ({ key: e.key, value: e.value }));
  const config = readConfig(root).config;

  const payload = buildBackup({
    fromDataDir: root,
    sessions,
    stores,
    config,
    // 默认只记目录名：完整路径带用户名/机器名，而这个文件是要拿去分享的（P145）
    keepProvenance: p.flags.has("keep-provenance"),
  });

  const target = resolveJsonOutputPath(flag(p, "out"), root, {
    defaultName: `ding-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    force: p.flags.has("force"),
  });
  if (!target.ok) {
    process.stderr.write(`${target.message}\n`);
    return 2;
  }
  const out = target.file;
  try {
    fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch (error) {
    process.stderr.write(`写不进去：${out}（${(error as Error)?.message ?? "未知错误"}）\n`);
    return 2;
  }

  /* 读侧只看 KV —— file 后端下这份备份的"配置型 store"是空的（P134 的同源问题） */
  const backendWarn = storeBackendWarning(backendKind(), root);
  /* 空备份的忠告：桌面那份不在这个根里（P129） */
  const emptyWarn = emptyBackupWarning(payload.summary, root, desktopDataDir());

  if (p.flags.has("json")) {
    process.stdout.write(JSON.stringify({ ok: true, file: out, root, summary: payload.summary }, null, 2) + "\n");
    if (emptyWarn) process.stderr.write(emptyWarn + "\n");
    if (backendWarn) process.stderr.write(backendWarn + "\n");
    return 0;
  }
  process.stdout.write(
    [
      "备份完成。",
      `  文件：${out}`,
      `  数据根：${root}`,
      `  内容：会话 ${payload.summary.sessions} 段 / 记录 ${payload.summary.records} 条 / 配置型 store ${payload.summary.stores} 项`,
      "",
      "  它是一个**能打开的 JSON 文件** —— 你可以自己看里面有什么，也可以拷到别的机器上恢复。",
      "  不含密钥（凭据在 ~/.dsh/.credentials.yaml，不跟着备份走）。",
      "",
    ].join("\n"),
  );
  if (emptyWarn) process.stderr.write(emptyWarn + "\n");
  if (backendWarn) process.stderr.write(backendWarn + "\n");
  return 0;
}

/** 交互问一句"要不要恢复"（`restoreIntent` 判成 `ask` 时用）。 */
async function confirmRestore(target: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`把备份恢复到 ${target} 吗？（输入 yes 继续） `, resolve));
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

/**
 * `ding restore <文件> [--list] [--yes] [--data-dir <根>]`。
 *
 * `--list` 只**看**不恢复（先让人确认这是不是他要的那份）。
 *
 * ⚠️ 恢复是**只补不覆盖**（P99/P123/P196）：本机已有的键不动；备份里那些键若是
 * **另一台机器**的绝对路径（旧格式备份），本机认不出来 —— 那种会**明确报**出来
 * （`storesUnavailable`），而不是写进一串没人会查的键再报"恢复了 N 项"（P100/P128）。
 *
 * ⚠️ 非 `--list` 时**默认先做快照**、并要 `--yes` / 交互确认（P130）——
 * 恢复不可逆，一条命令换掉现在太危险。
 */
export async function cmdRestore(p: Parsed, dataDir: string): Promise<number> {
  const root = resolveBackupDataDir(p, dataDir);
  const file = p.args[0] ?? flag(p, "out");
  if (!file) {
    process.stderr.write("用法：ding restore <备份文件> [--list]（--list 只看不恢复）\n");
    return 2;
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    process.stderr.write(`找不到备份文件：${abs}\n`);
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
  } catch (error) {
    process.stderr.write(`这个文件不是合法 JSON（${(error as Error).message.slice(0, 80)}）—— 可能拷坏了\n`);
    return 2;
  }

  const checked = validateBackup(raw);
  if (!checked.ok) {
    process.stderr.write(`这份备份不能用：${checked.reason}\n`);
    return 2;
  }
  const payload = checked.payload;

  if (p.flags.has("list")) {
    process.stdout.write(describeBackup(payload) + "\n");
    return 0;
  }

  /* ① 确认门（P130）：这里开始就要写用户数据了 */
  const intent = restoreIntent({ listOnly: false, yes: p.flags.has("yes"), interactive: process.stdin.isTTY === true });
  if (intent === "refused") {
    process.stderr.write(
      "恢复会写入现有数据（且不可逆）。确认要恢复就加 `--yes`；只想看看里面有什么，用 `--list`。\n",
    );
    return 2;
  }
  if (intent === "ask" && !(await confirmRestore(root))) {
    process.stdout.write("已取消（没有改动任何数据）。\n");
    return 1;
  }

  /* ② 恢复前的当前状态快照（P130）：失败就不往下走（fail-closed） */
  const snapshot = await writePreRestoreSnapshot(root);
  if (!snapshot.ok) {
    process.stderr.write(`恢复前做不了当前状态快照（${snapshot.error}）—— 不做不可逆的写，已停在原地。\n`);
    return 2;
  }

  /*
   * ⚠️ 恢复**不删不覆盖**（见 `engine/core/backup.ts` 的硬规矩）：
   * 备份可能是三天前的，而这三天用户又聊了一堆 —— 直接覆盖等于用旧数据抹掉新的。
   *
   * `readStore` 是那条规矩的落点：本机已经有这个键 → 跳过（P99/P123/P196）。
   * `writeStore` 按**本机**键写：备份里的键可能是导出机的绝对路径（P100/P128）。
   */
  const store = createSqliteSessionStore(root, "sessions.db", NO_PRUNE);
  let restoredConfigKeys: string[] = [];
  try {
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      readStore: (key) => {
        const mapped = mapStoreKey(root, key);
        return mapped === UNMAPPABLE_STORE_KEY ? UNMAPPABLE_STORE_KEY : kvReadByKey(root, mapped);
      },
      writeStore: (key, value) => {
        const mapped = mapStoreKey(root, key);
        if (mapped === UNMAPPABLE_STORE_KEY) return; // applyBackup 已把它记进 unavailable 并跳过
        kvWriteKey(root, mapped, value);
      },
      /*
       * ⚠️ 只在本机**还没有配置**时写回（只补不覆盖）。写之前先 `normalizeConfig`
       * 收窄形状（P147 / NEW-N2-26）：`payload.config` 来自**外部 JSON**，
       * `validateBackup` 没查过它 —— 不能因为它在备份文件里就原样原子写进 config.json
       * （原来那句 `writeConfig(dataDir, cfg as never)` 连编译器的声音都关掉了）。
       * 写进去的键也报出来（"恢复了哪几项"）。
       */
      writeConfig: (cfg) => {
        const paths = configPaths(root);
        if (fs.existsSync(paths.primary)) return;
        const normalized = normalizeConfig(cfg);
        const keys = Object.keys(normalized);
        if (!keys.length) return; // 空形状 / 全是不认识的键：不写
        writeConfig(root, normalized);
        restoredConfigKeys = keys;
      },
    });

    /*
     * `applyBackup` 只看"端口给没给"就置 `configRestored`；而上面那条路可能因为
     * "本机已有配置" 或 "形状收窄后为空" 而**没写**。报告以**实际写了什么**为准。
     */
    const configRestored = restoredConfigKeys.length > 0;
    const backendWarn = storeBackendWarning(backendKind(), root);

    if (p.flags.has("json")) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, ...report, configRestored, configKeys: restoredConfigKeys, root, snapshot: snapshot.file },
          null,
          2,
        ) + "\n",
      );
      if (backendWarn) process.stderr.write(backendWarn + "\n");
      return 0;
    }
    const unavailableNote =
      report.storesUnavailable > 0
        ? `  ${report.storesUnavailable} 项没能恢复：它们的键是**另一台机器**的绝对路径（旧格式备份）；本机读不到那串键`
        : null;
    process.stdout.write(
      [
        "恢复完成（**只补不覆盖**：已有的记录与设置都没动）。",
        `  数据根：${root}`,
        `  会话：${report.sessions} 段`,
        `  新增记录：${report.recordsAdded} 条`,
        `  跳过（本地已有同样的内容）：${report.recordsSkipped} 条`,
        `  配置型 store：补入 ${report.stores} 项 / 跳过（本机已有）${report.storesSkipped} 项`,
        configRestored
          ? `  CLI 配置：已写回 ${restoredConfigKeys.join(" / ")}`
          : "  CLI 配置：本机已有配置，未覆盖",
        ...(unavailableNote ? [unavailableNote] : []),
        "",
        `  恢复前的当前状态已另存：${snapshot.file}（反悔就把它恢复回来）`,
        "  想完全回到备份那一刻：把数据目录里的 sessions.db / stores.db 挪走再恢复一次。",
        "",
      ].join("\n"),
    );
    if (backendWarn) process.stderr.write(backendWarn + "\n");
    return 0;
  } finally {
    store.close();
  }
}
