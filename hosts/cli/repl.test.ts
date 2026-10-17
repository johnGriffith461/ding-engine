import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { REPL_COMMANDS, parseReplLine, replHelp, replPrecondition } from "./repl";

/**
 * 交互模式的行解析（Phase 9）。
 *
 * ## 这组断言挡的是什么
 *
 * REPL 里"这一行是命令还是一句话"判错的后果很具体：
 * 把 `/model` 当成任务发给模型（用户莫名其妙被收了一次费），
 * 或者把"帮我看看 /etc/hosts"里那个斜杠当成命令（任务被吃掉）。
 * 两种都不会报错。
 */

describe("parseReplLine", () => {
  it("空行忽略（连空格都不算一句话）", () => {
    expect(parseReplLine("")).toEqual({ command: "", args: [] });
    expect(parseReplLine("   ")).toEqual({ command: "", args: [] });
  });

  it("不以斜杠开头的都是**一句话**（交给模型跑一轮）", () => {
    expect(parseReplLine("把 demo 里的 md 整理成纪要")).toEqual({ command: "ask", args: ["把 demo 里的 md 整理成纪要"] });
  });

  it("斜杠开头的是命令，参数按空白切开", () => {
    expect(parseReplLine("/model deepseek-chat")).toEqual({ command: "model", args: ["deepseek-chat"] });
    expect(parseReplLine("/mode 每步确认")).toEqual({ command: "mode", args: ["每步确认"] });
  });

  it("命令大小写不敏感（`/EXIT` 也能退）", () => {
    expect(parseReplLine("/EXIT").command).toBe("exit");
  });

  it("⭐ 句子**中间**出现斜杠不当命令（`/etc/hosts` 那种）", () => {
    // 只有**行首**才是命令 —— 否则"看看 /etc/hosts"会被当成命令吃掉
    expect(parseReplLine("帮我看看 /etc/hosts 里写了什么").command).toBe("ask");
  });

  it("`/` 单独一行：命令名为空（当「不认识」处理，不会当成一句话发出去）", () => {
    expect(parseReplLine("/")).toEqual({ command: "", args: [] });
  });
});

describe("帮助与前置条件", () => {
  it("帮助里列出表里的每个命令，并且带上当前档位与会话 id", () => {
    /* ── 变异实证：把某个命令从 REPL_COMMANDS 里删掉 → 本用例红（P235 的形状）── */
    const help = replHelp("cli-abc", "每步确认");
    for (const { name, usage } of REPL_COMMANDS) {
      expect(help, `帮助里漏了 /${name}`).toContain(`/${name}`);
      expect(help).toContain(usage);
    }
    expect(help).toContain("每步确认");
    expect(help).toContain("cli-abc");
  });

  it("⭐ `/provider` 必须在帮助里 —— 它是唯一能在会话中换 provider 的入口（P235）", () => {
    // 这条单独写出来：P235 报的就是"它在派发里活着、帮助里却没有，于是不可发现"。
    expect(replHelp("cli-abc", "每步确认")).toContain("/provider");
  });

  it("⭐ 派发里出现的每个命令都必须登记进 REPL_COMMANDS（从源码反查，不许手抄）", () => {
    /*
     * ── 变异实证：在 repl.ts 的派发里加一个 `if (parsed.command === "xxx")` 而不登记 → 本用例红 ──
     *
     * 起因（P235）：命令清单原来有三处手抄本 —— 文件头那张表、`replHelp` 里的字面量、
     * 以及派发处的 if 串。`/provider` 只加进了派发，另外两处都没跟上，
     * 于是"活命令不可发现"，而它们**不会因为任何检查而变红**。
     * 现在这条把"派发 = 命令表"变成断言：新加命令时忘登记，这里就红。
     */
    const source = readFileSync(path.resolve(__dirname, "repl.ts"), "utf8");
    const dispatched = new Set<string>();
    for (const m of source.matchAll(/parsed\.command\s*===\s*"([a-z]+)"/g)) dispatched.add(m[1]!);
    const known = new Set(REPL_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const missing = [...dispatched].filter((c) => !known.has(c));
    expect(missing, "这些命令在派发里活着、却没登记进 REPL_COMMANDS（帮助里也就看不到）").toEqual([]);
    // 反向：表里的"名字"必须真的被派发认下（别名不要求单独有分支）
    const names = REPL_COMMANDS.map((c) => c.name);
    const phantom = names.filter((n) => !dispatched.has(n));
    expect(phantom, "REPL_COMMANDS 里登记了派发根本不认的命令 —— 帮助会列出一条点不动的命令").toEqual([]);
  });

  it("没有可用通道时给一句人话（而不是进了 REPL 才发现发不出请求）", () => {
    const prev = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (/API_KEY$/.test(k)) delete process.env[k];
      process.env.DSH_CREDENTIALS_FILE = "C:/definitely/not/here.yaml";
      const got = replPrecondition();
      // 本机若真配了密钥，这条就跳过（不把"环境里有没有密钥"当成断言）
      if (!got.ok) expect(got.reason).toContain("没有可用的 provider");
    } finally {
      process.env = prev;
    }
  });
});
