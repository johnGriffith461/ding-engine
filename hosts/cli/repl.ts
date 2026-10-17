import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import type { Engine, EngineRunRequest } from "../../engine/index";
import { agentNames } from "../../engine/runtime/agents";
import { allProviders, firstAvailableProvider, getProvider } from "../../engine/runtime/providers";
import { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import type { CliConfig } from "./config";

/**
 * `ding` 的**交互模式**（Phase 9：CLI 从"验收驱动器"升级为正式产品表面）。
 *
 * ## 为什么是它
 *
 * 命令行 agent 的真实用法有两种，缺一不可：
 * - **一次性**（`ding run "任务"`）：脚本、CI、管道。已经做好了；
 * - **连续对话**：人在终端里一件件交代事情，**上下文要接着**。
 *   前者替代不了后者 —— 每问一句都从零开始，agent 就记不住上一句说的。
 *
 * ## 一条会话 = 一段上下文
 *
 * 进 REPL 时开**一个**会话（`cli-<时间戳>`），后面每一轮都往它里面写。
 * 所以"刚才那个文件你放哪了"这种话在这里是有意义的 ——
 * 而它在 `ding run` 里没有意义（每次都是新会话，这是**有意**的：
 * 一次性命令不该默默继承上一次的上下文）。
 *
 * ## 它能做什么（如实：都是既有能力，这里只做一个壳）
 *
 * | 输入 | 干什么 |
 * |---|---|
 * | 任意一句话 | 当成任务跑一轮（走与 `ding run` 完全相同的引擎路径） |
 * | `/model <名>` | 换模型（只影响后面几轮） |
 * | `/provider [家名]` | 换 provider（不给参数就列可选的） |
 * | `/mode <档位>` | 换闸门档位 |
 * | `/agents` | 列可用的专家（`spawn_agents` 派活用的那几个） |
 * | `/sessions` | 这次交互的会话 id（配合 `ding record` / `ding sessions` 用） |
 * | `/help` | 这一屏 |
 * | `/exit` 或 Ctrl-D | 退出 |
 *
 * ⚠️ 这张表是**手写的说明**（注释渲染不了东西，别把它当成自动同步的）。
 * 真正被结构保证的是**运行时的帮助那一屏**：它由下面的 `REPL_COMMANDS` 渲染，
 * 而 `repl.test.ts` 有一条守卫盯着"派发里出现的每个命令都在表里" ——
 * 那一条正是冲 P235 来的（`/provider` 曾加进派发、而这张表和 `/help` 都没跟上，
 * 于是它成了"活命令却不可发现"）。改派发时**两处都要动**：`REPL_COMMANDS` 与这段注释。
 *
 * ⚠️ 不做的事：不做自动补全、不做多行、不做 ANSI 全屏。
 * 那些是"好看"，而这一步要的是"能用且**行为与一次性命令一模一样**"。
 */

/** REPL 需要从宿主拿的东西（都是 `ding.ts` 已经有的）。 */
export type ReplContext = {
  engine: Engine;
  /** 这次交互的会话 id。 */
  sessionId: string;
  /** 初始 provider / model / 档位（来自配置与命令行）。 */
  provider: string;
  model?: string;
  mode: ConfirmMode;
  /** 打印一轮的结果（复用一次性命令那套渲染）。 */
  renderLatest: () => Promise<void>;
  /** 数据目录（`/sessions` 显示用）。 */
  dataDir: string;
};

/** 把一行输入拆成命令与参数（`/model deepseek-chat` → `["model", "deepseek-chat"]`）。 */
export function parseReplLine(line: string): { command: string; args: string[] } | { command: ""; args: [] } {
  const text = line.trim();
  if (!text) return { command: "", args: [] };
  if (!text.startsWith("/")) return { command: "ask", args: [text] };
  const [head, ...rest] = text.slice(1).split(/\s+/);
  return { command: (head ?? "").toLowerCase(), args: rest };
}

/**
 * REPL 的命令表 —— **唯一一份**，`replHelp` 就是照它渲染的。
 *
 * ⚠️ 2026-10-16（审计 P235）：这份清单原来有**三处手抄本**（文件头那张表、`replHelp` 里的字面量、
 * 以及派发处的 `if` 串）。`/provider` 加进派发之后另外两处都没跟上 ——
 * 于是它是**活命令却不可发现**（那是唯一能在会话中换 provider 的入口，`/help` 里找不到），
 * 而 `replHelp` 头上那句"只列真的有的"就成了不实自述。
 *
 * 现在帮助从这张表渲染，`repl.test.ts` 另有一条**从源码反查**的守卫：
 * 派发里出现的每个命令都必须登记在这张表里，否则红。
 */
export const REPL_COMMANDS: ReadonlyArray<{
  /** 派发处 `parsed.command === "<这个>"` 的值 */
  name: string;
  /** 别名（同样被认下，但不单独占一行） */
  aliases?: readonly string[];
  /** 帮助里那一列（含参数占位） */
  usage: string;
  /** 一句话说明；`{MODES}` / `{MODE}` 在渲染时替换成档位表与当前档位 */
  what: string;
}> = [
  { name: "model", usage: "/model <名>", what: "换模型（只影响后面几轮）" },
  {
    name: "provider",
    usage: "/provider [家名]",
    what: "换 provider（不给参数就列可选的；换家之后模型回到该家默认）",
  },
  { name: "mode", usage: "/mode <档位>", what: "换闸门档位（{MODES}，当前「{MODE}」）" },
  { name: "agents", usage: "/agents", what: "列可用的专家" },
  { name: "sessions", usage: "/sessions", what: "这次交互的会话 id（配合 ding sessions / ding record）" },
  { name: "help", usage: "/help", what: "这一屏" },
  { name: "exit", aliases: ["quit"], usage: "/exit", what: "退出（Ctrl-D 也行）" },
];

/** 帮助那一屏。**只列真的有的** —— 这句话现在由结构保证，不再靠人抄。 */
export function replHelp(sessionId: string, mode: ConfirmMode): string {
  const rows = REPL_COMMANDS.map(
    ({ usage, what }) =>
      `  ${usage.padEnd(16)}${what.replace("{MODES}", CONFIRM_MODES.join(" / ")).replace("{MODE}", mode)}`,
  );
  return [
    "直接输入一句话 = 跑一轮（上下文接着上面）",
    "",
    ...rows,
    "",
    `这次交互的会话：${sessionId}（存在数据库里，退出后还能用 ding sessions 查到）`,
  ].join("\n");
}

/**
 * 跑交互模式。
 *
 * @param ctx 见 `ReplContext`
 * @param initial 初始配置（从命令行与配置文件合出来的）
 * @returns 退出码
 */
export async function runRepl(ctx: ReplContext, initial: CliConfig): Promise<number> {
  /** 这一轮会话的可变状态（`/model`、`/mode`、`/provider` 只影响后面几轮）。 */
  const state = { provider: ctx.provider, model: ctx.model ?? initial.model, mode: ctx.mode };

  stdout.write(
    [
      `Ding Harness 交互模式（会话 ${ctx.sessionId}）`,
      `provider：${state.provider}　模型：${state.model ?? "（默认）"}　档位：${state.mode}　数据：${ctx.dataDir}`,
      "输入 /help 看能用的命令，/exit 退出。",
      "",
    ].join("\n"),
  );

  const rl = createInterface({ input: stdin, output: stdout, prompt: "ding> " });

  /**
   * 处理一行。
   *
   * ⚠️ 抽成函数是为了**让回路只剩两件事**：读一行、问"要不要退"。
   * 原来每个分支各写一个 `continue` —— 那样加一个命令就要记得补一次提示符，
   * 漏一处表现为"提示符不见了"（不算崩，但很难看）。
   *
   * @param line 一行输入（含空行）
   * @returns 是不是要退出
   */
  async function handleLine(line: string): Promise<boolean> {
    const parsed = parseReplLine(line);
    if (parsed.command === "") return false;
    if (parsed.command === "exit" || parsed.command === "quit") return true;

    if (parsed.command === "help") {
      stdout.write(`${replHelp(ctx.sessionId, state.mode)}\n\n`);
      return false;
    }
    if (parsed.command === "agents") {
      stdout.write(`${agentNames().join(" / ")}\n（用 spawn_agents 把它们派出去；ding agents 有详细说明）\n\n`);
      return false;
    }
    if (parsed.command === "sessions") {
      stdout.write(`${ctx.sessionId}\n（ding sessions 列出全部；ding record ${ctx.sessionId} 录一份快照）\n\n`);
      return false;
    }
    if (parsed.command === "model") {
      const next = parsed.args[0];
      if (!next) {
        const def = getProvider(state.provider);
        stdout.write(`当前：${state.model ?? "（默认）"}；可选：${(def?.models ?? []).join(" / ") || "（这家没有清单）"}\n\n`);
        return false;
      }
      /*
       * ⚠️ 不校验"这个名字在不在清单里"：清单是**配置**（可能被环境变量覆盖、
       * 也可能是刚上线的新模型），而"模型不存在"下一轮请求会如实报出来。
       * 在这里提前拦住，反而会让"清单没更新"变成"用不了新模型"。
       */
      state.model = next;
      stdout.write(`模型换成 ${next}（下一轮生效）\n\n`);
      return false;
    }
    if (parsed.command === "mode") {
      const next = parsed.args.join(" ").trim();
      if (!next) {
        stdout.write(`当前档位：${state.mode}（可选：${CONFIRM_MODES.join(" / ")}）\n\n`);
        return false;
      }
      const normalized = normalizeConfirmMode(next);
      if (normalized !== next) {
        // 认不出来就说清楚，而不是悄悄回落（那会让人以为设置生效了）
        stdout.write(`「${next}」不是有效档位。可用：${CONFIRM_MODES.join(" / ")}\n\n`);
        return false;
      }
      state.mode = normalized;
      stdout.write(`档位换成「${state.mode}」（下一轮生效）\n\n`);
      return false;
    }
    if (parsed.command === "provider") {
      const next = parsed.args[0];
      if (!next) {
        stdout.write(`当前：${state.provider}；可选：${allProviders().map((p) => p.id).join(" / ")}\n\n`);
        return false;
      }
      if (!getProvider(next)) {
        stdout.write(`没有叫「${next}」的 provider。可用：${allProviders().map((p) => p.id).join(" / ")}\n\n`);
        return false;
      }
      state.provider = next;
      state.model = undefined; // 换家之后模型名通常不通用，交回默认
      stdout.write(`provider 换成 ${next}（模型回到该家的默认）\n\n`);
      return false;
    }
    if (parsed.command !== "ask") {
      stdout.write(`不认识 /${parsed.command}。输入 /help 看能用的。\n\n`);
      return false;
    }

    // 一轮：走与 `ding run` **完全相同**的引擎路径（不多一条、不少一条）
    const request: EngineRunRequest = {
      sessionId: ctx.sessionId,
      provider: state.provider,
      ...(state.model ? { model: state.model } : {}),
      messages: [{ role: "user", content: parsed.args.join(" ") }],
      mode: state.mode,
      useTools: true,
      maxSteps: 8,
    };
    try {
      const outcome = await ctx.engine.run(request);
      await ctx.renderLatest();
      if (!outcome.ok && !outcome.aborted) stdout.write(`没跑完：${outcome.error ?? "未知原因"}\n`);
    } catch (error) {
      /*
       * ⚠️ 一轮失败**不能把 REPL 带走**：终端里输错一句、provider 断一下，
       * 都只是"这一轮没成"，用户还要接着聊。所以这里兜住并打印，继续下一轮。
       */
      stdout.write(`这一轮出错了：${error instanceof Error ? error.message : String(error)}\n`);
    }
    stdout.write("\n");
    return false;
  }

  try {
    /*
     * ⚠️ 用**异步迭代**而不是 `rl.question()`：`question()` 在**管道输入**下
     * 会一次把标准输入读空（后续 question 拿不到行），于是
     * `printf '甲\n乙\n' | ding` 只跑第一句 —— 而"能不能被管道驱动"
     * 恰恰是这个 REPL 唯一能在 CI 里验的东西（真终端没人按键）。
     */
    /*
     * ⚠️ 提示符要**防御性地**打：管道输入（`printf … | ding`）下，
     * 第一行处理完时标准输入可能已经关了，此时 `prompt()` 会抛
     * `ERR_USE_AFTER_CLOSE`。那不是故障（就是"输入给完了"），
     * 所以这里当成"结束"，而不是让整个 REPL 崩掉把用户的话吞掉。
     */
    let closed = false;
    rl.on("close", () => {
      closed = true;
    });
    const prompt = (): void => {
      if (closed) return;
      try {
        rl.prompt();
      } catch {
        closed = true;
      }
    };

    /*
     * ⚠️ 循环里**不因 closed 而 break**：输入流关上（EOF）不代表缓冲里没有剩下的行 ——
     * `printf '甲
乙
丙
' | ding` 时三行都该被处理完，只是不再打提示符了。
     * 第一版在这里 break 过，表现是"只跑了前两行"，而看起来像命令没生效。
     */
    prompt();
    for await (const line of rl) {
      if (await handleLine(line)) break;
      prompt();
    }
  } finally {
    rl.close();
  }
  stdout.write(`再见。（会话 ${ctx.sessionId} 留着，ding sessions 还能查到）\n`);
  return 0;
}

/** `ding` 没给任何参数时：能进 REPL 就进，进不了（没有通道）就说清楚。 */
export function replPrecondition(): { ok: true } | { ok: false; reason: string } {
  const provider = firstAvailableProvider();
  if (!provider) {
    return {
      ok: false,
      reason: `没有可用的 provider（已登记：${allProviders().map((p) => p.id).join(" / ")}）。先配一个密钥，或用 ding models 看看。`,
    };
  }
  return { ok: true };
}
