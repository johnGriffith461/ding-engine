import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseLogLine, resumeSession, type LogRecord } from "../core/events";

/**
 * 会话样本（Phase 10.4 的第三件事：**混入 ≥10 条样本防失真**）。
 *
 * ## 它挡的是什么
 *
 * 评测集与单测里的 fixture 都是**手写的**，于是它们天然"太干净"：字段齐全、
 * 顺序规整、没有坏行。而生产里的日志会长成别的样子 ——
 * 进程被杀会留下**截断的 JSON**、老版本会写**缺字段**的记录、
 * 模型会吐出**超长工具输出**。只在干净数据上跑，等于没验过容错那部分。
 *
 * 所以这里做两件事：
 *   1. **脱敏是断言**：任何样本里出现绝对路径 / 密钥形状 / 用户目录痕迹都直接红；
 *   2. **回放真样本**：每条样本都过一遍真投影（`parseLogLine` + `resumeSession`），
 *      坏行要被**如实算成坏行**，而不是被丢掉或让整段崩掉。
 *
 * ## 样本怎么来的（别把它读成"抓的真实聊天记录"）
 *
 * 由 `pnpm eval:samples` 用**真代码路径**生成（真引擎、真事件、真落盘格式
 * `logLine`），模型文本是脚本化的；另外刻意混入了截断 JSON 与空行。
 * 为什么不抓真实聊天记录：这台机器的会话库是空的，而且把私人对话提交进公开仓
 * 需要主人点头 —— 两条都写在 `scripts/eval-samples.ts` 的头注里。
 *
 * ## 周期
 *
 * 方案要求"每季度补充"。加样本就是在生成脚本的 `RECIPES` 里加一条再跑一次 ——
 * 这样"补充"是机械动作，不需要理解整个装置。
 */

const DIR = path.resolve(__dirname, "samples");

function sampleFiles(): string[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

function linesOf(file: string): string[] {
  return fs.readFileSync(path.join(DIR, file), "utf8").split("\n");
}

describe("会话样本（Phase 10.4：≥10 条，脱敏是断言）", () => {
  const files = sampleFiles();

  it("① 样本不少于 10 条", () => {
    expect(files.length, `样本只有 ${files.length} 条（方案要求 ≥10）`).toBeGreaterThanOrEqual(10);
  });

  it("② 脱敏：不许出现绝对路径、密钥形状、用户目录痕迹", () => {
    /*
     * 这一条是"脱敏"的可证伪形式。三个模式各自对应一种真实泄漏：
     *   · `C:\` / `/Users/` / `/home/` —— 把开发机的目录结构提交了出去；
     *   · `sk-` / `Bearer ` / `api_key"` —— 把凭据提交了出去（最坏的一种）；
     *   · 应用名目录 —— 把"这台机器上装了哪个应用"泄漏出去。
     */
    const patterns: Array<[RegExp, string]> = [
      [/[A-Za-z]:\\/, "Windows 绝对路径"],
      [/\/(Users|home)\//, "POSIX 家目录路径"],
      [/sk-[A-Za-z0-9]{8,}/, "密钥形状（sk-）"],
      [/Bearer\s+[A-Za-z0-9._-]{8,}/, "Authorization 头里的 token"],
      [/api[_-]?key"?\s*[:=]\s*"[^"]{8,}"/i, "明文 api key 字段"],
      [/AppData|\.zcode|DingHarness\/\.\./, "用户目录痕迹"],
    ];
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(DIR, file), "utf8");
      for (const [re, what] of patterns) {
        const m = re.exec(text);
        if (m) hits.push(`${file}: ${what} —— ${m[0].slice(0, 40)}`);
      }
    }
    expect(hits, "样本里出现了不该提交的内容").toEqual([]);
  });

  it("③ 每条样本都能回放：坏行被如实算成坏行，好行照常成回合", () => {
    const problems: string[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(DIR, file), "utf8");
      const parsed = raw
        .split("\n")
        .map((line) => parseLogLine(line))
        .filter((r): r is LogRecord => r !== null);

      if (parsed.length === 0) {
        problems.push(`${file}: 一行都没解析出来`);
        continue;
      }
      // 每份样本都该有首行请求（那是"这一轮模型看见了什么"）
      if (!parsed.some((r) => r.type === "request")) problems.push(`${file}: 没有 request 记录`);

      // 真投影：不许抛异常
      let resumed;
      try {
        resumed = resumeSession(parsed);
      } catch (error) {
        problems.push(`${file}: 投影抛异常 —— ${String((error as Error)?.message ?? error).slice(0, 80)}`);
        continue;
      }
      if (resumed.turns.length === 0) problems.push(`${file}: 回放出来 0 个回合`);
    }
    expect(problems, "样本回放出的问题").toEqual([]);
  });

  it("④ 样本里有真实日志一定有的脏东西（否则它还是「太干净」）", () => {
    /*
     * ⚠️ 每份样本以 `
` 结尾，`split("
")` 的最后一个元素**必然是空串**——
     * 不看掉它的话，下面"样本里没有空行"那条断言恒真（审计 G85）。
     */
    const all = files.flatMap((f) => {
      const lines = linesOf(f);
      if (lines.at(-1) === "") lines.pop();
      return lines;
    });
    // 截断的 JSON：解析不出来，但**不能**让读日志的人崩
    const truncated = all.filter((l) => l.trim().startsWith("{") && parseLogLine(l) === null);
    expect(truncated.length, "样本里一条坏行都没有 —— 那就挡不住「真实日志有坏行」这类问题").toBeGreaterThan(0);
    // 空行
    expect(all.some((l) => l.trim() === ""), "样本里没有空行").toBe(true);
    // 工具失败 + 闸门待决：两种最容易在界面出错的形状
    expect(all.some((l) => l.includes('"error"')), "样本里没有工具失败的记录").toBe(true);
    expect(all.some((l) => l.includes('"pending":true')), "样本里没有闸门待决的记录").toBe(true);
    // 被中断 / 报错的回合
    expect(all.some((l) => l.includes("已中止") || l.includes('"type":"error"')), "样本里没有被中断或报错的回合").toBe(true);
  });

  it("⑤ 样本覆盖到产品真的会吐的那些事件类型（这一层靠结构而不是靠人记）", () => {
    const types = new Set<string>();
    for (const file of files) {
      for (const line of linesOf(file)) {
        const rec = parseLogLine(line);
        if (rec) types.add(rec.type);
      }
    }
    /*
     * 这几个类型是产品会写进日志的全部（见 `engine/core/events.ts` 的 LogRecord）。
     * 断言覆盖而不是"数量"：漏掉某一类意味着那类的容错从来没被样本碰过。
     */
    for (const want of ["request", "text", "tool-call", "tool-result", "done"]) {
      expect(types.has(want), `样本里没有 ${want} 类型的记录`).toBe(true);
    }
    /*
     * 委派（团队/子智能体那条路）也要有 —— 它是 Phase 7 加的，最容易在样本里被漏掉。
     * ⚠️ 原来写的是 `some((t) => t === "delegation" || t === "request")` ——
     * `request` 每一份样本都有，于是这条**恒真**，"委派事件没出现"永远逮不到（审计 G85）。
     */
    expect(types.has("delegation"), "委派事件在样本里没出现").toBe(true);
  });
});
