import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { openSqlite } from "../../engine/adapters/sqliteDriver";
import { closeKv } from "../../engine/adapters/kvStore";
import type { LogInput } from "../../engine/core/events";
import { parseArgv } from "./args";
import { readConfig } from "./config";
import {
  cmdBackup,
  cmdRestore,
  desktopDataDir,
  emptyBackupWarning,
  resolveBackupDataDir,
  resolveJsonOutputPath,
  restoreIntent,
  storeBackendWarning,
  writePreRestoreSnapshot,
} from "./cmdBackup";

/**
 * `ding backup` / `ding restore` 的数据安全判据（2026-10-16，审计第 6 单）。
 *
 * 覆盖的条：
 *   · **P124** `backup --out` 路径不设防（能用文本盖掉真库/配置）；
 *   · **P214** `--out` 撞到已有文件时无条件覆写；
 *   · **P125** 备份**之前**先跑打开时的收口，先删掉它要备份的东西；
 *   · **P129** 备份/恢复只动一个数据根 + 空备份不再静默；
 *   · **P130** 恢复没有确认、没有先备份当前；
 *   · **P134** 恢复只写 KV，file 后端读不到；
 *   · **P147** 恢复配置不验形状（`cfg as never` / 死语句 `void paths`）。
 *
 * 判据分两种：纯函数（落点判定 / 确认门 / 警告文案）与**真跑**（`cmdBackup` /
 * `cmdRestore` 落真库、读真文件）—— 后者才是"修了没有"的证据。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) closeKv(d);
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(prefix = "dh-cmdbackup-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const req = (text: string): LogInput => ({
  requestId: "r1",
  type: "request",
  provider: "strata",
  model: "m",
  messages: [{ role: "user", content: text }],
  toolPolicy: "按需确认",
  tools: [],
});

/** 把一段会话的 `updated_at` 改成"很久以前"（用来触发默认保留策略的年龄那道）。 */
function ageSession(dbFile: string, sessionId: string, days: number): void {
  const db = openSqlite(dbFile);
  try {
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now() - days * 86_400_000, sessionId);
  } finally {
    db.close();
  }
}

function sessionCount(dbFile: string): number {
  const db = openSqlite(dbFile);
  try {
    return Number(((db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }) ?? { n: 0 }).n);
  } finally {
    db.close();
  }
}

/** 静音 stdout/stderr 并留档（判据要看它们说了什么）。 */
function silence(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  });
  return { out, err };
}

describe("P124 / P214 —— 输出路径收窄（备份与 recipe export 共用）", () => {
  it("扩展名不是 .json：拒绝（落到 sessions.db / config.json 上是拿文本盖库）", () => {
    const dir = tempDir();
    /* ⚠️ 目标在数据目录**外面**：只有这样才是在考"扩展名"这一条，而不是被"落在数据目录里"挡住 */
    const got = resolveJsonOutputPath(path.join(tempDir(), "sessions.db"), dir, { defaultName: "b.json", force: false });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain(".json");
  });

  it("⭐ 落在数据目录里：拒绝（那里装着 sessions.db / stores.db / config.json）", () => {
    const dir = tempDir();
    const got = resolveJsonOutputPath(path.join(dir, "backup.json"), dir, { defaultName: "b.json", force: false });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain("数据目录");
  });

  it("⭐ 已存在且没给 --force：拒绝；给了 --force 才放行（P214）", () => {
    const dir = tempDir();
    const out = path.join(tempDir(), "old.json");
    fs.writeFileSync(out, "{}", "utf8");
    const denied = resolveJsonOutputPath(out, dir, { defaultName: "b.json", force: false });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.message).toContain("已存在");
    expect(resolveJsonOutputPath(out, dir, { defaultName: "b.json", force: true })).toEqual({ ok: true, file: path.resolve(out) });
  });

  it("没给 --out：默认名撞名时自动加序号，不覆盖也不报错", () => {
    const dir = tempDir();
    const cwd = tempDir();
    const now = path.resolve(cwd, "ding-backup-x.json");
    fs.writeFileSync(now, "{}", "utf8");
    const got = resolveJsonOutputPath(undefined, dir, { defaultName: "ding-backup-x.json", force: false });
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(fs.existsSync(got.file), "默认名撞了就直接用同一个名字（会覆盖）").toBe(false);
      expect(got.file.endsWith(".json")).toBe(true);
    }
  });
});

describe("P125 —— 备份不该先删掉它要备份的东西", () => {
  it("⭐ 40 天前的会话：备份前**不许**被收口删掉，且要进备份文件", async () => {
    const root = tempDir();
    const outDir = tempDir();
    const dbFile = path.join(root, "sessions.db");
    const store = createSqliteSessionStore(root);
    await store.append("cli-old", [req("一个月前说过的话")]);
    store.close();
    ageSession(dbFile, "cli-old", 40);

    silence();
    const out = path.join(outDir, "b.json");
    const code = await cmdBackup(parseArgv(["backup", "--out", out]), root);
    expect(code).toBe(0);

    /*
     * 双判据：
     *   ① 盘上那段会话**还在**（`readAllSessions` 打开库时不许跑收口）；
     *   ② 备份文件里**有**它（1 段 / 1 条记录）。
     * 退回修复（给 `createSqliteSessionStore` 去掉禁用收口那份策略）→ 两条都红。
     */
    expect(sessionCount(dbFile), "备份动作本身把 40 天前的会话删了").toBe(1);
    const payload = JSON.parse(fs.readFileSync(out, "utf8")) as { summary: { sessions: number; records: number } };
    expect(payload.summary.sessions).toBe(1);
    expect(payload.summary.records).toBe(1);
  });
});

describe("P129 —— 一次只动一个数据根，空备份不再静默", () => {
  it("--data-dir 覆盖宿主给的根（绝对化）", () => {
    const fallback = tempDir();
    const other = tempDir();
    expect(resolveBackupDataDir(parseArgv(["backup"]), fallback)).toBe(fallback);
    expect(resolveBackupDataDir(parseArgv(["backup", "--data-dir", other]), fallback)).toBe(path.resolve(other));
  });

  it("⭐ 0 段会话 + 0 项 store：警告里点出桌面那个根与 --data-dir", () => {
    const root = path.resolve("C:/cli-root");
    const desktop = path.resolve("C:/desktop-root");
    const note = emptyBackupWarning({ sessions: 0, stores: 0 }, root, desktop);
    expect(note, "空备份一声不吭").toBeTruthy();
    expect(note!).toContain("--data-dir");
    expect(note!).toContain(desktop);
    // 有东西可备份时不该打扰
    expect(emptyBackupWarning({ sessions: 1, stores: 0 }, root, desktop)).toBeNull();
    // 根与桌面是同一个：不再"桌面那份在别处"那半句
    expect(emptyBackupWarning({ sessions: 0, stores: 0 }, root, root)).not.toContain("桌面应用的数据在");
  });

  it("desktopDataDir 认 DSH_CANVAS_DATA_DIR（与桌面同一口径）", () => {
    const prev = process.env.DSH_CANVAS_DATA_DIR;
    const d = tempDir();
    process.env.DSH_CANVAS_DATA_DIR = d;
    try {
      expect(desktopDataDir()).toBe(path.resolve(d));
    } finally {
      if (prev === undefined) delete process.env.DSH_CANVAS_DATA_DIR;
      else process.env.DSH_CANVAS_DATA_DIR = prev;
    }
  });
});

describe("P130 —— 恢复：确认门 + 恢复前快照", () => {
  it("--list 只读；--yes 才算确认；非交互且没给 --yes 一律拒", () => {
    expect(restoreIntent({ listOnly: true, yes: false, interactive: false })).toBe("dry-run");
    expect(restoreIntent({ listOnly: false, yes: true, interactive: false })).toBe("confirmed");
    expect(restoreIntent({ listOnly: false, yes: false, interactive: true })).toBe("ask");
    expect(restoreIntent({ listOnly: false, yes: false, interactive: false })).toBe("refused");
  });

  it("⭐ 非交互且没给 --yes：拒（退出码 2），一个字节都不写", async () => {
    const root = tempDir();
    const src = path.join(tempDir(), "b.json");
    fs.writeFileSync(
      src,
      JSON.stringify({ kind: "ding-harness-backup", version: 1, exportedAt: new Date().toISOString(), fromDataDir: "x", sessions: [], stores: [], summary: { sessions: 0, records: 0, stores: 0 } }),
      "utf8",
    );
    const before = fs.readdirSync(root);
    const { err } = silence();
    const code = await cmdRestore(parseArgv(["restore", src]), root);
    expect(code).toBe(2);
    expect(err.join("")).toContain("--yes");
    expect(fs.readdirSync(root), "拒了却还是写了东西").toEqual(before);
  });

  it("⭐ 恢复之前先落一份当前状态快照（写得出文件、内容是真的）", async () => {
    const root = tempDir();
    const store = createSqliteSessionStore(root);
    await store.append("cli-before", [req("恢复前就有的话")]);
    store.close();

    const got = await writePreRestoreSnapshot(root, new Date("2026-01-02T03:04:05Z"));
    expect(got.ok, got.ok ? "" : got.error).toBe(true);
    if (!got.ok) return;
    expect(path.basename(got.file)).toContain("pre-restore-");
    const payload = JSON.parse(fs.readFileSync(got.file, "utf8")) as { sessions: Array<{ sessionId: string }> };
    expect(payload.sessions.map((s) => s.sessionId)).toContain("cli-before");
  });
});

describe("P134 —— 后端开关不一致要说清（恢复写 KV，file 后端读文件）", () => {
  it("sqlite（默认）不打扰；file 后端明确报出来", () => {
    expect(storeBackendWarning("sqlite", "C:/d")).toBeNull();
    const note = storeBackendWarning("file", "C:/d");
    expect(note).toBeTruthy();
    expect(note!).toContain("DSH_STORE_BACKEND");
    expect(note!).toContain("KV");
  });
});

describe("P147 —— 恢复配置：只在本机没有配置时写，且按形状收窄", () => {
  function payloadWithConfig(config: unknown) {
    return {
      kind: "ding-harness-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      fromDataDir: "src",
      sessions: [],
      stores: [],
      config,
      summary: { sessions: 0, records: 0, stores: 0 },
    };
  }

  it("⭐ 备份文件里的坏形状/陌生键不落进 config.json，写回的键报出来", async () => {
    const root = tempDir();
    const src = path.join(tempDir(), "b.json");
    fs.writeFileSync(src, JSON.stringify(payloadWithConfig({ provider: 123, evil: "x", mode: "按需确认" })), "utf8");

    const { out } = silence();
    const code = await cmdRestore(parseArgv(["restore", src, "--yes", "--json"]), root);
    expect(code).toBe(0);

    const text = fs.readFileSync(path.join(root, "config.json"), "utf8");
    expect(text, "陌生的键被原样写进了配置（配置注入点）").not.toContain("evil");
    expect(text, "类型不对的 provider 被写进去了").not.toContain("123");
    const cfg = readConfig(root).config;
    expect(cfg.provider).toBeUndefined();
    expect(cfg.mode).toBe("按需确认");

    const report = JSON.parse(out.join("")) as { configRestored: boolean; configKeys: string[] };
    expect(report.configKeys).toContain("mode");
    expect(report.configRestored).toBe(true);
  });

  it("本机已有配置：不覆盖（只补不覆盖这条硬规矩）", async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ provider: "anthropic" }), "utf8");
    const src = path.join(tempDir(), "b.json");
    fs.writeFileSync(src, JSON.stringify(payloadWithConfig({ provider: "deepseek", mode: "每步确认" })), "utf8");

    const { out } = silence();
    const code = await cmdRestore(parseArgv(["restore", src, "--yes", "--json"]), root);
    expect(code).toBe(0);
    expect(readConfig(root).config.provider, "本地已有配置被备份覆盖了").toBe("anthropic");
    const report = JSON.parse(out.join("")) as { configRestored: boolean };
    expect(report.configRestored).toBe(false);
  });
});
