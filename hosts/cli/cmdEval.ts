/**
 * `ding eval` —— 离线评测集（Phase 10.2）。
 *
 * 从 `ding.ts` 拆出来的（结构守卫 C6-5：那个文件超了 900 行上限）。
 * 拆法按**命令**分：一个命令的实现（连同它自己的渲染与依赖）聚在一处。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EVAL_CASES } from "../../engine/eval/cases";
import { runSuite } from "../../engine/eval/run";
import { EVAL_CATEGORIES } from "../../engine/eval/types";
import { buildEngine as buildEngineIn } from "./assembly";
import type { Parsed } from "./args";
/* ────────────────────── eval（Phase 10） ────────────────────── */

/**
 * 仓根。
 *
 * ⚠️ 两条路都要留：**打包后的 CLI 是 CJS**（有 `__dirname`），
 * 而 `pnpm ding` 走 tsx（ESM，没有 `__dirname` —— 用它会 ReferenceError）。
 * `typeof __dirname` 在 ESM 下不会抛（对未声明标识符取 typeof 是安全的）。
 */
function repoRoot(): string {
  /*
   * 往上找 `engine/eval/cases.ts` —— 而不是"从 cwd 上两级"或"从 __dirname 上两级"：
   * 那两条各只对一种跑法（tsx 从仓根跑 / 打包后的 dist-cli/hosts/cli），换一种就指错地方
   * （实测撞过：写基线写到了 `C:\engine\evalaseline.json`）。
   * 找标记文件对两种跑法都对。
   */
  const starts = [process.cwd(), ...(typeof __dirname === "string" ? [__dirname] : [])];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i += 1) {
      if (fs.existsSync(path.join(dir, "engine", "eval", "cases.ts"))) return dir;
      dir = path.dirname(dir);
    }
  }
  return process.cwd();
}

/**
 * 基线落哪（**进版本库**）。
 *
 * ⚠️ 不放 `docs/`：那个目录被 `.gitignore` 排除了（内部施工笔记不入公开仓，2026-10-15 的决定）。
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * 基线必须跟着版本走 —— 它是"通过率不许往下掉"的那个参照。
 */
function evalBaselinePath(): string {
  return path.join(repoRoot(), "engine", "eval", "baseline.json");
}

/**
 * `--update-baseline` 能不能写（审计 P160 / NEW-N3-21）。
 *
 * 基线是"通过率与**用例总数**都不许往下掉"的那个参照（`engine/eval/eval.test.ts` 会拿
 * `report.total >= baseline.total` 当门）。原来 `ding eval <类别> --update-baseline`
 * 会把**子集**的报告原样覆盖进同一份 `engine/eval/baseline.json`：
 * `ding eval 纯对话 --update-baseline` 之后基线变成 `total: 9 / byCategory 只剩一类`，
 * 于是删掉另外 54 条用例也不会有任何门变红 —— "总数只该涨"的棘轮被削掉。
 *
 * 所以只有**全量**（没给类别）时才允许写基线。
 *
 * @param only 命令行的类别过滤（`undefined` = 全量）
 */
export function baselineUpdateAllowed(only: string | undefined): { ok: true } | { ok: false; message: string } {
  if (!only) return { ok: true };
  return {
    ok: false,
    message:
      `--update-baseline 只能在全量跑时用（现在只跑了「${only}」这一类）。\n` +
      `  子集报告会覆盖整份基线，把"用例总数只该涨"那道棘轮一起削掉。\n` +
      `  想更新基线：去掉类别，跑 \`ding eval --update-baseline\`。`,
  };
}

/**
 * `ding eval [suite] [--json] [--update-baseline]`（Phase 10.2）。
 *
 * ## 它为什么必须离线
 *
 * 评测要**能进 CI、能天天跑**，所以一条真 provider 都不调：用例自带脚本化的模型回复
 * （`engine/eval/fakeProvider.ts` 起一个本地的 OpenAI 兼容 SSE 服务），
 * 于是被测的是**真代码路径**（真 SDK、真流解析、真工具往返、真闸门），
 * 只是"模型"那一段是确定性的。
 *
 * ## 它与 `engine/eval/eval.test.ts` 的关系
 *
 * **同一个 `runSuite`**：那条在 CI 里当门（通过率跌超 5% 即红），这条给人看报告。
 * 一个跑、一个看 —— 不会出现"CI 判的与命令行看到的不一样"。
 *
 * @param p 解析后的参数
 * @returns 退出码（有失败 = 1）
 */
export async function cmdEval(p: Parsed): Promise<number> {
  const only = p.args[0];
  if (only && !EVAL_CATEGORIES.includes(only as (typeof EVAL_CATEGORIES)[number])) {
    process.stderr.write(`没有这一类评测集：${only}\n可选：${EVAL_CATEGORIES.join(" / ")}\n`);
    return 2;
  }
  /* 先验后用（P160）：子集不许写基线 —— 别等跑完十分钟才说 */
  if (p.flags.has("update-baseline")) {
    const allowed = baselineUpdateAllowed(only);
    if (!allowed.ok) {
      process.stderr.write(`${allowed.message}\n`);
      return 2;
    }
  }
  const cases = only ? EVAL_CASES.filter((c) => c.category === only) : EVAL_CASES;
  if (!cases.length) {
    process.stderr.write("这一类还没有用例。\n");
    return 2;
  }

  const report = await runSuite(
    cases,
    {
      /*
       * ⚠️ 每个用例一个临时工作目录 + 一个临时数据目录：**绝不碰真实 userData**。
       * CLI 的 `ding run` 用的是真实数据目录，而评测是"可重复的检查"，
       * 写进真实目录会让下一轮的先决条件变掉（前几条用例跑的产物变成后几条的既有状态）。
       */
      makeEngine: async (workDir) => {
        const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dh-eval-store-"));
        const built = await buildEngineIn([workDir], storeDir);
        return {
          engine: built.engine,
          close: () => {
            built.close();
            fs.rmSync(storeDir, { recursive: true, force: true });
          },
        };
      },
      sessionPrefix: "eval",
    },
    (r, i, total) => {
      if (p.flags.has("json")) return;
      /* 装置不可达的用 ⚠️ 而不是 ✗ —— 它不是产品失败，但**绝不能不吭声** */
      const mark = r.ok ? "✓" : r.environment ? "⚠️" : "✗";
      process.stdout.write(`${mark} [${i}/${total}] ${r.id}  ${r.title}\n`);
      for (const f of r.failures) process.stdout.write(`     ${f.what}：${f.detail}\n`);
      if (r.environment) process.stdout.write(`     装置：${r.environment}\n`);
      /* error 事件说了什么 —— 没有这一行，"为什么红"只能靠猜 */
      for (const e of r.errors ?? []) process.stdout.write(`     error 事件：${e}\n`);
    },
  );

  if (p.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      `\n共 ${report.total} 条，通过 ${report.passed}，失败 ${report.failed}` +
        (report.environment ? `，装置不可达 ${report.environment}（不算产品失败，但仍会让退出码为 1）` : "") +
        `，通过率 ${report.rate}%\n`,
    );
    for (const [category, slot] of Object.entries(report.byCategory)) {
      process.stdout.write(`  ${category}：${slot.passed}/${slot.total}\n`);
    }
  }

  /* 基线：`--update-baseline` 落盘；否则只比对并提示（判定在单测里，这里给人看） */
  const baselineFile = evalBaselinePath();
  if (p.flags.has("update-baseline")) {
    const payload = { rate: report.rate, total: report.total, byCategory: report.byCategory, generatedAt: new Date().toISOString() };
    fs.writeFileSync(baselineFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    process.stdout.write(`基线已更新：${baselineFile}\n`);
  } else if (fs.existsSync(baselineFile)) {
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8")) as { rate: number };
    const drop = baseline.rate - report.rate;
    if (drop > 5) process.stderr.write(`⚠️ 通过率比基线跌了 ${drop.toFixed(1)} 个百分点（${baseline.rate}% → ${report.rate}%）\n`);
  } else {
    process.stdout.write(`（还没有基线：跑 \`ding eval --update-baseline\` 落一份）\n`);
  }

  /*
   * 退出码：产品失败 → 1；**装置不可达也 → 1**。
   * 后者不是"甩锅给机器就算了" —— 这一批的结论在这台机器上不成立，重跑一次再来。
   */
  return report.failed || report.environment ? 1 : 0;
}

