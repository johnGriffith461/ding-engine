import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configIssues, doctorReport, runDoctor, type Check } from "./doctor";

/**
 * 自检核心的**宿主中立那半边**（2026-10-17：桌面「反馈」导出诊断包复用同一套检查，
 * 见 `electron/ipc/diagnostics.ts` 与其回归 `src/diagnosticsExport.test.ts`）。
 *
 * CLI 那半（配置从 `config.json` 收窄、`CONFIG_KEYS` 白名单）的守门在
 * `hosts/cli/doctor.test.ts`；这里钉的是**接缝本身**：
 *
 *   · `config` 视图由宿主注入 —— 换个宿主就换一套键，engine 里没有写死的 CLI 键表；
 *   · `skip` 按名字剔检查（**剔掉，不是改成绿**）；
 *   · `doctorReport` 的 JSON 形状是"一份实现"（`--json` 与诊断包共用）。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-doctor-core-"));
  tmpDirs.push(dir);
  return dir;
}

/** 干净环境：不读真实凭据（同 `hosts/cli/doctor.test.ts` 的口径）。 */
function cleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const names = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "A_API_KEY", "STRATA_API_KEY"];
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  const prevPath = process.env.DSH_CREDENTIALS_FILE;
  process.env.DSH_CREDENTIALS_FILE = path.join(freshDir(), "none.yaml");
  try {
    return fn();
  } finally {
    for (const n of names) if (saved[n] !== undefined) process.env[n] = saved[n]!;
    if (prevPath === undefined) delete process.env.DSH_CREDENTIALS_FILE;
    else process.env.DSH_CREDENTIALS_FILE = prevPath;
  }
}

describe("自检核心（宿主中立半边）", () => {
  it("⭐ `config.allowedKeys` 由宿主注入：换一个宿主的键表，判定跟着换（engine 里没有写死的 CLI 键表）", () => {
    /* 桌面的 settings.json：两个键 */
    const desktopKeys = ["pinnedModel", "navCollapsed"] as const;
    expect(configIssues({ pinnedModel: "deepseek/deepseek-chat" }, desktopKeys).unknownKeys).toEqual([]);
    expect(configIssues({ pinnedModle: "x" }, desktopKeys).unknownKeys).toEqual(["pinnedModle"]);
    /* CLI 的键在这个白名单下就属于"不认识" —— 这正是"按宿主的表判"的意思 */
    expect(configIssues({ mode: "全部允许" }, desktopKeys).unknownKeys).toEqual(["mode"]);
  });

  it("⭐ `skip` 按名字剔检查：剔掉是不显示，不是判成绿", () => {
    const all = cleanEnv(() =>
      runDoctor({
        dataDir: freshDir(),
        configPath: "x",
        rawConfig: {},
        runtime: "test",
        bunBinary: false,
        config: { normalized: { dirs: [] }, allowedKeys: [] },
      }),
    );
    expect(all.some((c) => c.name === "工作目录")).toBe(true);

    const skipped = cleanEnv(() =>
      runDoctor({
        dataDir: freshDir(),
        configPath: "x",
        rawConfig: {},
        runtime: "test",
        bunBinary: false,
        config: { normalized: { dirs: [] }, allowedKeys: [] },
        skip: ["工作目录"],
      }),
    );
    expect(skipped.some((c) => c.name === "工作目录"), "skip 没生效（那一格还在）").toBe(false);
    expect(skipped.length).toBe(all.length - 1);
  });

  it("`config` 不传 = 宿主没有配置层：默认 provider 那格按「没配」报，不编值", () => {
    const checks = cleanEnv(() =>
      runDoctor({ dataDir: freshDir(), configPath: "x", rawConfig: {}, runtime: "test", bunBinary: false }),
    );
    const prov = checks.find((c) => c.name === "默认 provider");
    expect(prov, "没有「默认 provider」这一格").toBeTruthy();
    expect(prov!.detail).toContain("没配");
  });

  it("`doctorReport` 的形状：ok / failed / checks（`--json` 与诊断包共用这一份）", () => {
    const checks: Check[] = [
      { name: "甲", ok: true, detail: "好", next: "无需处理" },
      { name: "乙", ok: false, detail: "坏", next: "去修" },
    ];
    expect(doctorReport(checks)).toEqual({ ok: false, failed: 1, checks });
    expect(doctorReport([checks[0]!])).toEqual({ ok: true, failed: 0, checks: [checks[0]] });
  });
});
