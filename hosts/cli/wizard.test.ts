import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureConfigured, runWizard, suggestModel, writeSecret, type WizardIo } from "./wizard";
import { readConfig } from "./config";
import { MODEL_CATALOG } from "../../engine/runtime/models";
import { hasSecret } from "../../engine/runtime/credentials";

/**
 * 首次运行向导的验收（Phase 11.3），也是 **Phase 10.4 的「首跑路径可自动重放」**。
 *
 * ## 为什么这里能验、而"新用户 ≤5 分钟"这种话通常不能验
 *
 * 向导的**逻辑**是纯函数式的：给定一串答案，它算出该写什么配置。
 * 所以下面整个"新用户第一次装上"的过程是被**重放**的 —— 不是靠某次手工演示说"我试过挺快的"。
 *
 * 「≤5 分钟」这条没法真的计时（我这台机器不是用户那台），所以用一个**能证伪的代理**：
 * 向导问的问题**不超过 4 个**，且每个都有默认值（回车即可）。
 * 问 20 个问题还要人查文档的向导，5 分钟肯定上不了手 —— 这条代理挡住了那种回归。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-wizard-"));
  tmpDirs.push(dir);
  return dir;
}

let credFile = "";
beforeEach(() => {
  credFile = path.join(freshDir(), "credentials.yaml");
  process.env.DSH_CREDENTIALS_FILE = credFile;
  // 清掉环境里的 key：否则"全新机器"这个前提不成立
  for (const n of ["DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "A_API_KEY"]) {
    delete process.env[n];
  }
});
afterEach(() => {
  delete process.env.DSH_CREDENTIALS_FILE;
});

/** 一列预设答案 + 记账的问句。 */
function scriptedIo(answers: string[]): WizardIo & { questions: string[]; lines: string[] } {
  const questions: string[] = [];
  const lines: string[] = [];
  let i = 0;
  return {
    questions,
    lines,
    ask: async (q, opts) => {
      questions.push(q);
      const raw = answers[i++];
      return raw === undefined || raw === "" ? (opts?.default ?? "") : raw;
    },
    say: (line) => lines.push(line),
  };
}

describe("首次运行向导（Phase 11.3 / 10.4 的首跑路径）", () => {
  it("① 全新机器：一路回车就能配好（每问都有默认值，问题不超过 4 个）", async () => {
    const dataDir = freshDir();
    const io = scriptedIo(["", "sk-test-wizard-key", "", ""]); // 全用默认
    const result = await runWizard(io, { dataDir });

    expect(result.skipped, `向导不该中断：${result.skipped ?? ""}`).toBeUndefined();
    expect(result.wrote).toBe(true);
    expect(io.questions.length, `问了 ${io.questions.length} 个问题（超过 4 个就谈不上"五分钟上手"）`).toBeLessThanOrEqual(4);

    const cfg = readConfig(dataDir).config;
    expect(cfg.provider, "没写下 provider").toBeTruthy();
    expect(cfg.model, "没写下模型").toBeTruthy();
    expect(cfg.mode, "没写下档位").toBe("按需确认");
    /*
     * key 写进了凭据文件 —— ⚠️ 判据是**用读取端读回来**，不是"文件里有那几个字"。
     * 第一版按后者断言，于是"写成扁平格式、读取端根本读不到"这个真 bug 溜过去了
     * （凭据文件的格式是 `refs:` 段内缩进一层）。
     */
    expect(hasSecret("DEEPSEEK_API_KEY"), "向导写下的 key 读不回来 —— 那等于没配").toBe(true);
  });

  it("② 默认档位是「按需确认」（安全的那一侧），且告诉用户怎么改", async () => {
    const dataDir = freshDir();
    const io = scriptedIo(["deepseek", "sk-x", "deepseek-chat", ""]);
    const result = await runWizard(io, { dataDir });
    expect(result.config.mode).toBe("按需确认");
    const said = io.lines.join("\n");
    expect(said, "没告诉用户怎么放宽").toContain("ding config set mode");
    expect(said, "没说清默认档是什么").toContain("读操作直接放行");
  });

  it("③ 指定工作目录：会被解析成绝对路径写进配置", async () => {
    const dataDir = freshDir();
    const work = freshDir();
    const io = scriptedIo(["deepseek", "sk-x", "deepseek-chat", work]);
    await runWizard(io, { dataDir });
    const cfg = readConfig(dataDir).config;
    expect(cfg.dirs).toEqual([path.resolve(work)]);
  });

  it("④ 已经有 key 时**不再问 key**（少一个问题，且不会把旧 key 覆盖掉）", async () => {
    const dataDir = freshDir();
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, "refs:\n  DEEPSEEK_API_KEY: sk-already-there\n", "utf8");
    const io = scriptedIo(["deepseek", "deepseek-chat", ""]); // 少一个答案
    const result = await runWizard(io, { dataDir });
    expect(result.providerWithKey).toBe("deepseek");
    expect(io.questions.length, `问了：${JSON.stringify(io.questions)}`).toBeLessThanOrEqual(3);
    // 旧 key 原样还在
    expect(fs.readFileSync(credFile, "utf8")).toContain("sk-already-there");
  });

  it("⑤ 模型推荐按目录表的核实日期（方案的原文要求）", () => {
    const model = suggestModel("deepseek");
    expect(model, "没推荐出模型").toBeTruthy();
    // 推荐的那个如果登记过，就该是该 provider 里核实日期最新的那些之一
    const specs = MODEL_CATALOG.filter((m) => m.id === model);
    if (specs.length) {
      const freshest = MODEL_CATALOG.filter((m) => m.verifiedAt).map((m) => m.verifiedAt ?? "").sort().at(-1) ?? "";
      expect(specs[0]!.verifiedAt, "推荐的不是最新的那批").toBe(freshest);
    }
    // 不认识的 provider 也不能崩（返回一个目录表里的模型而不是空串）
    expect(suggestModel("不存在的 provider").length).toBeGreaterThan(0);
  });

  it("⑥ 写凭据只碰自己那一行（别的键原样保留）", () => {
    const dir = freshDir();
    const file = path.join(dir, "cred.yaml");
    process.env.DSH_CREDENTIALS_FILE = file;
    fs.writeFileSync(file, "# 我的凭据\nANTHROPIC_API_KEY: sk-keep-me\nOPENAI_API_KEY: sk-also-keep\n", "utf8");
    const wrote = writeSecret("DEEPSEEK_API_KEY", "sk-new");
    expect(wrote.ok).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("sk-keep-me");
    expect(text).toContain("sk-also-keep");
    expect(text).toContain("sk-new");
    expect(text, "注释行被吃掉了").toContain("# 我的凭据");
  });

  it("⑦ 非交互环境（没有 IO）：**不提问、不挂住**，给一句能照做的话", async () => {
    const got = await ensureConfigured(null, { dataDir: freshDir() });
    expect(got.ok).toBe(false);
    expect(got.reason ?? "").toMatch(/ding init|环境变量/);
  });

  it("⑧ 已经配好了就不打扰（不问任何问题）", async () => {
    const dataDir = freshDir();
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, "refs:\n  DEEPSEEK_API_KEY: sk-ok\n", "utf8");
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ provider: "deepseek", model: "deepseek-chat" }), "utf8");
    const io = scriptedIo([]);
    const got = await ensureConfigured(io, { dataDir });
    expect(got.ok).toBe(true);
    expect(io.questions.length, "已经配好了还问问题").toBe(0);
  });
});

/**
 * ⭐ 守卫：向导的依赖里**不许**再出现那个从没被读过的入参（审计 P221 / NEW-N7-30）。
 *
 * `runWizard` 的 deps 上原来声明了 `hasUsableProvider`，而函数体**从没读过**它 ——
 * `ding init` 传 `false`、`ensureConfigured` 传真值，两条路跑出来一模一样。
 * 一个"看起来会影响分支"的入参其实什么都不做，比少一个入参危险得多：将来谁照着它
 * 分支（比如已有 key 就跳过第①步），`ding init` 那条路会先错。
 *
 * 处理方式是**删掉**而不是"真用"：向导里决定默认值的是 `suggestProvider()` 与现场
 * `hasSecret()` —— 它们算的就是这台机器上有没有可用的 provider，再从外面传一个同样的布尔
 * 进来就是第二份口径。守卫把这件事钉死：谁把它加回来，这里立刻红。
 */
describe("守卫：向导不读的入参不许复活（P221 的落点）", () => {
  it("wizard.ts / cmdSetup.ts 里都没有 hasUsableProvider 了", () => {
    /* 先剥注释：说明里提到这个名字（解释为什么删掉）不算"代码里又有了它" */
    const strip = (text: string): string =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const wizard = strip(fs.readFileSync(path.resolve(process.cwd(), "hosts/cli/wizard.ts"), "utf8"));
    const setup = strip(fs.readFileSync(path.resolve(process.cwd(), "hosts/cli/cmdSetup.ts"), "utf8"));
    expect(wizard, "wizard.ts 里又有 hasUsableProvider 了").not.toContain("hasUsableProvider");
    expect(setup, "cmdSetup.ts 里又在传 hasUsableProvider 了").not.toContain("hasUsableProvider");
  });
});

