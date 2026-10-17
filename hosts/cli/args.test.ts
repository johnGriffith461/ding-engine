import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { flag, flagAll, KNOWN_FLAGS, parseArgv, parseIntFlagValue } from "./args";

/**
 * 命令行解析（Phase 9）。
 *
 * ## 这组断言挡的是什么
 *
 * 参数解析写错了**不会崩**：它只会表现为"某个参数没生效" ——
 * 比如 `--dir` 被当成位置参数吃掉、`--mode` 的值被当成子命令。
 * 而那种错在真实使用里极难归因（"我明明给了 --provider"）。
 */

describe("parseArgv", () => {
  it("位置参数与旗标分开", () => {
    const got = parseArgv(["run", "把文件整理一下", "--provider", "deepseek"]);
    expect(got.command).toBe("run");
    expect(got.args).toEqual(["把文件整理一下"]);
    expect(flag(got, "provider")).toBe("deepseek");
  });

  it("⭐ 三种写法都认：`--k v` / `--k=v` / `-k v`", () => {
    expect(flag(parseArgv(["--provider", "deepseek"]), "provider")).toBe("deepseek");
    expect(flag(parseArgv(["--provider=deepseek"]), "provider")).toBe("deepseek");
    expect(flag(parseArgv(["-provider", "deepseek"]), "provider")).toBe("deepseek");
  });

  it("不带值的旗标当 `true`（`--json`）", () => {
    expect(flag(parseArgv(["--json"]), "json")).toBe("true");
    expect(flagAll(parseArgv(["--json", "sessions"]), "json")).toEqual(["true"]);
  });

  it("可重复的旗标收成数组（`--dir a --dir b`）", () => {
    expect(flagAll(parseArgv(["--dir", "a", "--dir", "b"]), "dir")).toEqual(["a", "b"]);
  });

  it("旗标后面跟着另一个旗标时，前一个当 `true`（不被后一个的值吞掉）", () => {
    const got = parseArgv(["--yes", "--grant", "tools:register"]);
    expect(flag(got, "yes")).toBe("true");
    expect(flag(got, "grant")).toBe("tools:register");
  });

  it("⭐ 只给旗标时 command 是**空串**（要进交互模式，不是要帮助）", () => {
    // 第一版这里是 "help"，于是 `ding --provider strata` 永远进不了 REPL ——
    // 而它表现成"打印了一屏帮助"，看着不像 bug。
    const got = parseArgv(["--provider", "strata"]);
    expect(got.command).toBe("");
    expect(got.args).toEqual([]);
  });

  it("空 argv：什么都不给（由调用方决定是进 REPL 还是给帮助）", () => {
    expect(parseArgv([])).toEqual({ command: "", args: [], flags: new Map() });
  });

  it("`--` 之后的参数一律当位置参数（`--k=v` 之外的负数值走这条路）", () => {
    const got = parseArgv(["run", "--", "-5", "--not-a-flag"]);
    expect(got.args).toEqual(["-5", "--not-a-flag"]);
    expect(got.unknown).toBeUndefined();
  });

  it("⭐ 裸的 `-5` 不再无声：算「不认识的旗标」（入口会报错，提示用 `--` 隔开）", () => {
    // 旧行为：`-5` 被收成旗标 "5" = "true"。那是"拼错了完全无声"的一种（审计 P220）。
    const got = parseArgv(["run", "-5"]);
    expect(got.unknown).toEqual(["5"]);
  });

  it("⭐ 值旗标缺值 → problems（不再是静默的 `\"true\"` → NaN）", () => {
    /*
     * 审计 P49/P111 的根：`ding run --steps`（漏值）与 `ding serve --port -1`
     * 原来都变成 `Number("true") = NaN`，而 NaN 会让"最多跑几步"这道闸恒不成立。
     */
    expect(parseArgv(["run", "--steps"]).problems).toEqual(["--steps 要一个值（后面没跟值）"]);
    expect(flag(parseArgv(["run", "--steps"]), "steps")).toBe("");
    expect(parseArgv(["serve", "--port", "--json"]).problems).toEqual(["--port 要一个值（后面没跟值）"]);
  });

  it("⭐ `--k=`（空值）→ problems（不再静默变空串/0）", () => {
    // 审计 P219：`ding run --steps=` 会让 maxSteps=0（一步都不跑）；`--export=` 会去 load("")
    expect(parseArgv(["run", "--steps="]).problems).toEqual(["--steps 要一个值（现在是空的）"]);
    // 开关类旗标给 `=true` 是合法写法（不进 problems）
    expect(parseArgv(["--json=true"]).problems).toBeUndefined();
  });

  it("⭐ 不认识的旗标收进 unknown（拼错要能被告知）", () => {
    const got = parseArgv(["run", "--por", "8080", "--json"]);
    expect(got.unknown).toEqual(["por"]);
    expect(flag(got, "json")).toBe("true");
    /* 值旗标 + 开关都给对了时不产生 unknown */
    expect(parseArgv(["serve", "--port", "8787", "--json"]).unknown).toBeUndefined();
  });

  it("正常参数不产生 problems / unknown（形状最小：只在出错时出现）", () => {
    const got = parseArgv(["run", "干活", "--steps", "3", "--json"]);
    expect(got.problems).toBeUndefined();
    expect(got.unknown).toBeUndefined();
    expect(flag(got, "steps")).toBe("3");
  });
});

describe("parseIntFlagValue（审计 P49 / P111 同一形状的第二个入口）", () => {
  const opts = { min: 0, max: 65535, fallback: 8787 };

  it("没给就用默认；正常整数照收", () => {
    expect(parseIntFlagValue(undefined, "port", opts)).toEqual({ ok: true, value: 8787 });
    expect(parseIntFlagValue("8787", "port", opts)).toEqual({ ok: true, value: 8787 });
    expect(parseIntFlagValue("0", "port", opts)).toEqual({ ok: true, value: 0 });
  });

  it("⭐ 坏值报错（不静默变 NaN / 0）", () => {
    expect(parseIntFlagValue("true", "port", opts).ok).toBe(false);
    expect(parseIntFlagValue("", "port", opts).ok).toBe(false);
    expect(parseIntFlagValue("87.87", "port", opts).ok).toBe(false);
    expect(parseIntFlagValue("-1", "port", opts).ok).toBe(false);
    expect(parseIntFlagValue("70000", "port", opts).ok).toBe(false);
  });

  it("报错文案带旗标名与区间（能直接给用户看）", () => {
    const got = parseIntFlagValue("abc", "steps", { min: 1, max: 1000, fallback: 8 });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.message).toBe("--steps 要 1–1000 的整数，给了「abc」");
  });
});

/**
 * ⭐ 守卫：**源码里读过的旗标必须都在 `KNOWN_FLAGS` 里**。
 *
 * 否则新加的旗标会在入口被当成"拼错"拒掉（比"完全无声"好，但也是坏体验）——
 * 这条守卫让"漏登记"在测试里立刻可见，而不是等到用户报"我的参数没生效"。
 */
describe("旗标登记守卫（审计 P220 的配套）", () => {
  it("hosts/ 与 scripts/ 里所有 flag()/flagAll()/flags.has() 的名字都已登记", () => {
    const roots = ["hosts", "scripts"].map((rel) => path.resolve(process.cwd(), rel));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
      }
    };
    for (const root of roots) walk(root);

    const misses: string[] = [];
    for (const file of files) {
      /* 先剥注释再扫：注释里举例写 `flag(p, "x")` 不该被当成真读了旗标 x */
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of text.matchAll(/flag(?:All)?\(\s*\w+\s*,\s*"([a-z0-9-]+)"/g)) {
        if (!KNOWN_FLAGS.has(match[1]!)) misses.push(`${match[1]}（${path.relative(process.cwd(), file)}）`);
      }
      for (const match of text.matchAll(/flags\.has\("([a-z0-9-]+)"\)/g)) {
        if (!KNOWN_FLAGS.has(match[1]!)) misses.push(`${match[1]}（${path.relative(process.cwd(), file)}）`);
      }
    }
    expect(misses, "这些旗标没登记进 KNOWN_FLAGS，会被入口当拼错拒掉").toEqual([]);
  });
});
