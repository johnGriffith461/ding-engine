import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configPaths, configFromEnv, describeConfig, effectiveConfig, normalizeConfig, readConfig, writeConfig } from "./config";

/**
 * CLI 配置（Phase 9）。
 *
 * ## 这组断言挡的是什么
 *
 * 配置是"长期偏好"，它错了的表现是"我改了但没生效" ——
 * 而那既可能是优先级搞反了（命令行被配置覆盖），也可能是磁盘上的值不合法
 * （手改坏的 JSON、写错的档位名）。两种都不报错，只在行为上悄悄不同。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "dh-cli-cfg-"));
});

afterEach(() => {
  delete process.env.DH_PROVIDER;
  delete process.env.DH_MODE;
  delete process.env.DH_DIRS;
  rmSync(dir, { recursive: true, force: true });
});

describe("收窄（磁盘不可信）", () => {
  it("非对象 / 空值一律给空配置", () => {
    for (const bad of [null, 42, "x", []]) expect(normalizeConfig(bad)).toEqual({});
  });

  it("⭐ 认不出的档位**不写进去**（回落默认，而不是留一个假档位）", () => {
    // Phase 11.5：认不出的档位回落到**安全默认**（按需确认），不是"全放开"
    expect(normalizeConfig({ mode: "随便" })).toEqual({ mode: "按需确认" });
    expect(normalizeConfig({ mode: "每步确认" })).toEqual({ mode: "每步确认" });
  });

  it("空串与空数组一律丢掉（等于没设）", () => {
    expect(normalizeConfig({ provider: "  ", model: "", dirs: [] })).toEqual({});
  });
});

describe("读写", () => {
  it("写进去再读回来一致", () => {
    writeConfig(dir, { provider: "deepseek", model: "deepseek-chat", mode: "按需确认", dirs: ["a", "b"] });
    expect(readConfig(dir).config).toEqual({ provider: "deepseek", model: "deepseek-chat", mode: "按需确认", dirs: ["a", "b"] });
  });

  it("⭐ 两种文件名都读（`config.json` 优先，无扩展名的 `config` 也认）", () => {
    // 方案里写的是 `~/.ding/config`；我们写 `config.json`，但**读**两种都认
    writeFileSync(configPaths(dir).legacy, JSON.stringify({ provider: "legacy-provider" }), "utf8");
    expect(readConfig(dir).config.provider).toBe("legacy-provider");
    writeFileSync(configPaths(dir).primary, JSON.stringify({ provider: "primary-provider" }), "utf8");
    expect(readConfig(dir).config.provider).toBe("primary-provider");
  });

  it("坏 JSON 不抛：给空配置 + 一句人话（配置文件坏了不该让命令跑不起来）", () => {
    writeFileSync(configPaths(dir).primary, "{ 这不是 JSON", "utf8");
    const got = readConfig(dir);
    expect(got.config).toEqual({});
    expect(got.note).toContain("读不动");
  });

  it("没有配置文件：空配置，不是错误", () => {
    expect(readConfig(dir)).toEqual({ config: {} });
  });
});

describe("优先级", () => {
  it("⭐ 环境变量**压过**配置文件（CI 用环境变量、日常用配置）", () => {
    writeConfig(dir, { provider: "file-provider", mode: "全部允许" });
    process.env.DH_PROVIDER = "env-provider";
    process.env.DH_MODE = "每步确认";
    const got = effectiveConfig(dir).config;
    expect(got.provider).toBe("env-provider");
    expect(got.mode).toBe("每步确认");
  });

  it("环境变量里的 dirs 支持逗号与分号（两种都写得出）", () => {
    process.env.DH_DIRS = "a,b;c";
    expect(configFromEnv().dirs).toEqual(["a", "b", "c"]);
  });

  it("环境变量没设时**不覆盖**文件里的值（三层各自回落）", () => {
    writeConfig(dir, { provider: "file-provider" });
    expect(effectiveConfig(dir).config.provider).toBe("file-provider");
  });
});

describe("给人看的那句话", () => {
  it("没设的项如实说「没设」与它的回落规则，不假装有默认值", () => {
    const line = describeConfig({});
    expect(line).toContain("没设");
    expect(line).toContain("全部允许");
  });
});
