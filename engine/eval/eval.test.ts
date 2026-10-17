import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { buildEngine } from "../../hosts/cli/assembly";
import { EVAL_CASES } from "./cases";
import { runSuite, type EvalReport } from "./run";
import { EVAL_CATEGORIES } from "./types";

/**
 * 评测集：**离线跑、不烧一分钱、有基线棘轮**（Phase 10.1 / 10.2 / 10.3）。
 *
 * ## 为什么它是单测而不是一条 CLI 脚本
 *
 * 方案 10.2 要求"一条命令出报告"（`ding eval`），10.3 要求"通过率跌超 5% 即红"。
 * 这两件事的**判定**必须在 CI 里自动发生 —— 所以：
 *
 *   · 判定在这里（vitest，每次 push 都跑）；
 *   · 给人看的报告在 `ding eval`（同一份 `runSuite`，只是渲染不同）。
 *
 * 一个跑、一个看，共用同一个执行器 —— 不会出现"CI 里的判据与命令行看到的不一致"。
 *
 * ## 装配为什么从 `hosts/cli/assembly.ts` 来
 *
 * 评测必须走**产品那条装配路**（同一批工具、同一个闸门、同一个存储）。
 * 评测器自己拼一套端口的话，测出来的是那套端口的质量，不是产品的。
 */

const BASELINE = path.resolve(__dirname, "baseline.json");

let report: EvalReport;

beforeAll(async () => {
  report = await runSuite(EVAL_CASES, {
    /*
     * 每个用例：一个临时工作目录（工具能碰的范围）+ 一个临时数据目录（会话库）。
     * 两者都不能落在真实 userData 上 —— 评测跑在 CI 上，不该碰任何真实数据。
     */
    makeEngine: async (workDir) => {
      const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-eval-store-"));
      const built = await buildEngine([workDir], storeDir);
      return {
        engine: built.engine,
        close: () => {
          built.close();
          fs.rmSync(storeDir, { recursive: true, force: true });
        },
      };
    },
    sessionPrefix: "eval",
  });
  // 让失败信息一次看全（默认只在断言里打一行）
  if (report.failed || report.environment) {
    for (const r of report.results.filter((x) => !x.ok)) {
      console.log(`✗ ${r.id}（${r.category}）${r.title}${r.environment ? "［装置不可达］" : ""}`);
      for (const f of r.failures) console.log(`    ${f.what}：${f.detail}`);
      console.log(`    实际事件：${r.eventTypes.join(" → ") || "(空)"}`);
      /* 事件里 error 说了什么，一条都别省 —— 不然"为什么红"只能靠猜 */
      for (const e of r.errors ?? []) console.log(`    error 事件：${e}`);
    }
  }
}, 300_000);

describe("评测集（Phase 10：离线回放 + 基线棘轮）", () => {
  it("① 六类都有覆盖，且每条至少断两样（事件序列 / 关键文案 / 产物）", () => {
    for (const category of EVAL_CATEGORIES) {
      const n = EVAL_CASES.filter((c) => c.category === category).length;
      expect(n, `「${category}」这一类还没有用例`).toBeGreaterThan(0);
    }
    /*
     * 三样判据**不必每条都齐**（硬凑会写出没有意义的断言 —— 比如"不给工具"那条，
     * 它要验的就是"没有 tool-call"，再加一条文案断言是充数）。
     * 要有的是两件事：
     *   ① **每一条都有可证伪的判据**（turn 类至少一条断言，core 类必须有 coreCheck）；
     *   ② **整批三样都用上了** —— 否则"产物存在性"这类判据会在没人注意的时候整体失效。
     */
    const withNothing = EVAL_CASES.filter((c) => {
      if (c.kind === "core") return !c.coreCheck;
      const e = c.expect ?? {};
      return !(e.events?.length || e.copy?.length || e.files?.length || e.filesAbsent?.length || e.gate || e.toolErrors?.length);
    }).map((c) => c.id);
    expect(withNothing, "这些用例一条判据都没有 —— 它们永远不会红").toEqual([]);

    const used = {
      事件序列: EVAL_CASES.filter((c) => c.expect?.events?.length).length,
      关键文案: EVAL_CASES.filter((c) => c.expect?.copy?.length).length,
      产物: EVAL_CASES.filter((c) => c.expect?.files?.length || c.expect?.filesAbsent?.length).length,
    };
    for (const [kind, n] of Object.entries(used)) {
      expect(n, `整批里「${kind}」这类判据一条都没用到（那一类判据会在无人注意时失效）`).toBeGreaterThan(0);
    }
  });

  it("② 每条用例的期望里都有「过程」判据（事件序列），不只是最终文本", () => {
    const noEvents = EVAL_CASES.filter((c) => c.kind !== "core" && !c.expect?.events?.length).map((c) => c.id);
    expect(noEvents, "只断最终文本的话，「模型直接编了个答案」与「它真的看了文件」长得一模一样").toEqual([]);
  });

  it("③ 全部用例通过（离线回放，一条真 provider 都不调）", () => {
    const detail = report.results
      .filter((r) => !r.ok)
      .map((r) => `${r.id}: ${r.failures.map((f) => `${f.what}(${f.detail})`).join("; ")}${
        r.errors?.length ? ` ［error 事件：${r.errors.join(" ／ ")}］` : ""
      }`)
      .join(" | ");
    expect(report.failed, detail).toBe(0);
    /*
     * ⭐ **装置不可达也要红**（2026-10-16）。
     *
     * `failed` 里已经不包含"本机回环连不上自己的假 provider"那一类（它由
     * `runSuite` 重跑一次、仍不可达则标成 `environment`）—— 那条判据故意收得很窄，
     * 因为那种失败**按构造**不可能来自产品：产品在这一步做的事就是"往宿主给的 baseURL 发个请求"。
     * 但"不算产品失败"不等于"可以放过"：这台机器如果**系统性**连不上回环，
     * 那这套评测在这里本来就不该给出"全绿"的结论 —— 所以这里要求 `environment` 必须是 0。
     */
    expect(
      report.environment,
      report.results
        .filter((r) => r.environment && !r.ok)
        .map((r) => `${r.id}: ${r.environment}`)
        .join(" | "),
    ).toBe(0);
  });

  it("④ 基线棘轮：用例只增不减，且基线本身必须记的是「全绿」", () => {
    if (!fs.existsSync(BASELINE)) {
      // 还没有基线时不该红：第一条基线是 `ding eval --update-baseline` 落下来的
      console.log(`（还没有基线文件 ${path.relative(process.cwd(), BASELINE)}：本次通过率 ${report.rate}%）`);
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8")) as { rate: number; total: number };
    /*
     * ⚠️ 2026-10-16（审计 G76）：这里原来写的是 `report.rate >= baseline.rate - 5`
     * —— "跌超 5% 即红"。可 ③ 已经要求 **0 失败**：走到 ④ 时通过率必然是 100%，
     * 那条容忍度**永远不可能成为先红的那个门**（恒真的判据 = 没有判据）。
     *
     * 改成棘轮真正能管的两件事：
     *   · **用例只增不减** —— 删掉用例来"提高通过率"是漂移；
     *   · **基线本身必须是 100%** —— 拿一次半绿的运行去 `--update-baseline`
     *     等于把及格线调低，那正是"全绿"这个词被稀释的方式。
     */
    expect(report.total, `基线有 ${baseline.total} 条，现在只剩 ${report.total} 条`).toBeGreaterThanOrEqual(baseline.total);
    expect(baseline.rate, `基线记的是 ${baseline.rate}% 而不是 100% —— 及格线被调低过`).toBe(100);
  });
});
