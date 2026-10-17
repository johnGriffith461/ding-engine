import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveServePort, serveProvider } from "./cmdServe";

/**
 * `ding serve --port` 的取值判定（2026-10-16，审计 P111）。
 *
 * 原来的形状是 `Number(flag(p, "port") ?? 8787)`：
 * `--port`（漏值，`parseArgv` 回填 `"true"`）或 `--port -1`（`-1` 被当新旗标）
 * 都会静默变成 `NaN` 喂给 `listen`。同类形状在生产里是"参数好像没生效"那种错，
 * 在这里还给不出那句人话。这条判定就是那句人话。
 */

describe("resolveServePort", () => {
  it("不给 --port：默认 8787", () => {
    expect(resolveServePort(undefined)).toEqual({ ok: true, port: 8787 });
  });

  it("正常值直接过（含 0 = 系统分配随机端口）", () => {
    expect(resolveServePort("8787")).toEqual({ ok: true, port: 8787 });
    expect(resolveServePort("0")).toEqual({ ok: true, port: 0 });
    expect(resolveServePort("65535")).toEqual({ ok: true, port: 65535 });
  });

  it("⭐ 漏值（`parseArgv` 回填的 `\"true\"`）报错，不再变 NaN", () => {
    const got = resolveServePort("true");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toContain("整数");
  });

  it("⭐ 负数 / 超出范围 / 不是数字：都报错", () => {
    expect(resolveServePort("-1").ok).toBe(false);
    expect(resolveServePort("70000").ok).toBe(false);
    expect(resolveServePort("八七八七").ok).toBe(false);
    expect(resolveServePort("87.87").ok).toBe(false);
  });
});

/**
 * provider 回落（2026-10-16，审计 P208 / NEW-N7-14）。
 *
 * 原来 `ding serve` / `ding acp` 只认 `config.provider`，没配就"先配一个 provider"退出 3。
 * 而同一台机器上（只有环境变量 key、config.json 没写 provider —— doctor 与向导都允许
 * 这种状态）`ding run` / REPL / `resume` / `recipe` 有 `firstAvailableProvider()` 兜底。
 * 同一件事在四个入口给出三种结果，是宿主一致性最容易被漏的一类。
 *
 * 判据是"与别的入口**同一口径**"：没配 → 挑第一个有密钥的；配了 → 听配置的。
 */
describe("serveProvider —— 与 ding run / resume / recipe 同一口径（P208）", () => {
  const saved: Record<string, string | undefined> = {};
  const names = ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "A_API_KEY"];

  function withCleanEnv(fn: () => void): void {
    for (const n of names) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
    const prevFile = process.env.DSH_CREDENTIALS_FILE;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dh-serve-"));
    process.env.DSH_CREDENTIALS_FILE = path.join(tmp, "none.yaml");
    try {
      fn();
    } finally {
      for (const n of names) if (saved[n] !== undefined) process.env[n] = saved[n]!;
      if (prevFile === undefined) delete process.env.DSH_CREDENTIALS_FILE;
      else process.env.DSH_CREDENTIALS_FILE = prevFile;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("config.json 写了 provider：听它的", () => {
    withCleanEnv(() => {
      expect(serveProvider("anthropic")).toBe("anthropic");
    });
  });

  it("⭐ 没配 provider、只有环境变量 key：回落到第一个有密钥的那家（不再直接退出 3）", () => {
    withCleanEnv(() => {
      process.env.DEEPSEEK_API_KEY = "sk-test";
      expect(serveProvider(undefined)).toBe("deepseek");
    });
  });

  it("一条 key 都没有：给空串（调用方据此报错退出）", () => {
    withCleanEnv(() => {
      expect(serveProvider(undefined)).toBe("");
    });
  });
});

