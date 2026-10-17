import { resolveSecret } from "../../engine/runtime/credentials";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { SYSTEM_ACTOR, splitTurns } from "../../engine/core/events";
import { recoveryViewOf } from "../../engine/core/recovery";
import { firstAvailableProvider } from "../../engine/runtime/providers";
import { normalizeConfirmMode } from "../../shared/ipc";
import { flag, type Parsed } from "./args";
import { buildEngine } from "./assembly";
import { effectiveConfig } from "./config";

/**
 * `ding resume [<会话 id>] [--continue]` —— 崩溃恢复的 CLI 入口（Phase 12.2）。
 *
 * ## 它回答的问题
 *
 * "上次那一轮被打断了，我该怎么办？" 两端（桌面与 CLI）都要能回答，这里是命令行那份：
 *
 * ```
 * ding resume                        # 列出所有需要处理的会话（被打断的回合 + 待决审批）
 * ding resume <会话 id>               # 看这一段当时做到哪了
 * ding resume <会话 id> --continue    # 把它接着跑完
 * ```
 *
 * ## ⚠️ "继续"的如实含义：重新跑那一轮，不是"从半句接着写"
 *
 * 上游 API 没有"续写半轮"这回事。能做的是把那一轮**重新跑一遍** ——
 * 历史与已有的工具结果都在日志里，所以新一轮会看到"上次做到哪"。
 * 代价是**这一轮会重新花一次钱**，所以命令里明确打出来，而不是假装免费续上。
 */

/** 读一段会话并算出恢复视图。 */
async function viewOf(store: ReturnType<typeof createSqliteSessionStore>, sessionId: string) {
  const { records } = await store.load(sessionId);
  return { records, view: recoveryViewOf(records) };
}

/** 时间戳写成给人看的样子（读不动就说读不动，不编）。 */
function when(at: number): string {
  if (!at) return "（没有时间）";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "（时间不可读）" : d.toLocaleString();
}

export async function cmdResume(p: Parsed, dataDir: string): Promise<number> {
  const store = createSqliteSessionStore(dataDir);
  try {
    const wanted = p.args[0];

    /* ① 不给会话 id：列出所有需要处理的（"一键恢复"的第一跳） */
    if (!wanted) {
      const summaries = await store.list();
      const hits: Array<{ id: string; title: string; interrupted: number; pending: number; updatedAt: number }> = [];
      for (const s of summaries) {
        const { view } = await viewOf(store, s.sessionId);
        if (!view.needsAttention) continue;
        hits.push({
          id: s.sessionId,
          title: s.title,
          interrupted: view.interrupted.length,
          pending: view.pending.length,
          updatedAt: s.updatedAt,
        });
      }
      if (p.flags.has("json")) {
        process.stdout.write(JSON.stringify({ needAttention: hits }, null, 2) + "\n");
        return 0;
      }
      if (!hits.length) {
        process.stdout.write("没有需要恢复的会话：所有回合都收尾了，也没有待决审批。\n");
        return 0;
      }
      process.stdout.write(`有 ${hits.length} 段会话需要处理：\n\n`);
      for (const h of hits) {
        process.stdout.write(`  ${h.id}\n`);
        process.stdout.write(`    ${when(h.updatedAt)}  ${h.title || "（没有标题）"}\n`);
        process.stdout.write(`    被打断的回合 ${h.interrupted} 个${h.pending ? ` / 待决审批 ${h.pending} 项` : ""}\n\n`);
      }
      process.stdout.write("看某一段：ding resume <会话 id>\n");
      return 0;
    }

    /* ② 给了会话 id：先看它当时做到哪了 */
    const { records, view } = await viewOf(store, wanted);
    if (!records.length) {
      process.stderr.write(`没有这段会话：${wanted}（ding sessions 能看到全部）\n`);
      return 2;
    }

    /*
     * ⭐ `--json` 与 `--continue` 同时给：**stdout 只出 JSON**（2026-10-16，审计 P218）。
     *
     * 原来先打 JSON、再落到下面那段人类可读输出（"继续：把…重跑一轮"、"跑完了。"）——
     * 而 `--json` 的承诺是"只把发生过什么结构化、不夹人话"（ding.ts 的口径），
     * 脚本里 `JSON.parse(stdout)` 会当场炸。所以：带 `--continue` 时**不出**这份状态 JSON，
     * 进度那些人话一律走 stderr，最后 stdout 上一个完整的 JSON。
     */
    const asJson = p.flags.has("json");
    if (asJson && !p.flags.has("continue")) {
      process.stdout.write(JSON.stringify({ sessionId: wanted, ...view }, null, 2) + "\n");
      return 0;
    }

    if (!asJson && !p.flags.has("continue")) {
      if (!view.needsAttention) {
        process.stdout.write("这段会话没有需要恢复的东西（所有回合都收尾了）。\n");
        return 0;
      }
      if (view.interrupted.length) {
        process.stdout.write(`被打断的回合 ${view.interrupted.length} 个：\n\n`);
        for (const t of view.interrupted) {
          process.stdout.write(`  你说：${t.userMessage || "（取不到原话）"}\n`);
          process.stdout.write(`  开始于：${when(t.startedAt)}，已经调过 ${t.stepsDone} 次工具\n`);
          if (t.lastText) process.stdout.write(`  最后说到：${t.lastText.slice(0, 80)}\n`);
          process.stdout.write("\n");
        }
      }
      if (view.pending.length) {
        process.stdout.write(`待决审批 ${view.pending.length} 项：\n`);
        for (const g of view.pending) process.stdout.write(`  ${g.name}\n`);
        process.stdout.write("（审批要在桌面端点，或者用 ding run 重新跑一轮）\n\n");
      }
      process.stdout.write(`接着跑完：ding resume ${wanted} --continue\n`);
      return 0;
    }

    /* ③ --continue：重发那一轮 */
    const target = view.interrupted.at(-1);
    if (!target) {
      process.stdout.write("没有被打断的回合 —— 不需要继续。\n");
      return 0;
    }
    if (!target.userMessage) {
      process.stderr.write("这一轮取不到用户原话（日志里没有 user 消息）—— 没法自动继续，请手动重发。\n");
      return 2;
    }

    const { config } = effectiveConfig(dataDir);
    /*
     * ⭐ provider 的回落要与别的 CLI 入口**同一口径**（2026-10-16，审计 P208）。
     *
     * 机器上只有环境变量 key、config.json 没写 provider 时（doctor 与向导都允许这种状态，
     * doctor 明说"没配就按第一个有密钥的选"）：`ding run` 与 REPL 有
     * `firstAvailableProvider()` 兜底，而这里原来只有 `config.provider ?? ""` ——
     * 于是同一台机器上 `ding run` 能跑、`ding resume --continue` 报"未知 provider：（空）"。
     */
    const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider(resolveSecret)?.id ?? "";
    /*
     * ⭐ 把**已完成的历史**带上（2026-10-16，审计 P127）。
     *
     * 原来 `messages` 只有 `[{role:"user", content:target.userMessage}]`，
     * 而 `engine.run` 也不读会话库 —— 所谓"继续"是**没有任何历史的重跑**：
     * 上一轮做到哪、已经改过哪些文件，新一轮完全看不见（而命令的文案与
     * 文件头的说明都承诺"历史与已有的工具结果都在日志里，所以新一轮会看见"）。
     *
     * 现在：从记录里还原出**目标那轮之前**的完整回合（user 原话 + 助手正文）交给引擎。
     * ⚠️ 被重跑那一轮的半截输出**不带上** —— 它不是"已经发生的对话"，
     * 塞进 assistant 消息等于替模型伪造一次它没说完的话。这一点下面如实打出来。
     */
    const priorTurns = splitTurns(records).filter((chunk) => chunk.request?.requestId !== target.requestId);
    const history: { role: "user" | "assistant"; content: string }[] = [];
    for (const chunk of priorTurns) {
      const ask = [...(chunk.request?.messages ?? [])].reverse().find((m) => m.role === "user");
      if (ask?.content?.trim()) history.push({ role: "user", content: ask.content });
      const said = chunk.view.text.trim();
      if (said) history.push({ role: "assistant", content: said });
    }

    const { engine, close } = await buildEngine(config.dirs ?? [], dataDir);
    const say = (line: string) => (asJson ? process.stderr.write(line) : process.stdout.write(line));
    try {
      say(`继续：把「${target.userMessage.slice(0, 60)}」重跑一轮\n`);
      say("（⚠️ 这是**重发**，不是「续写半句」—— 这一轮会重新计费）\n");
      say(
        history.length
          ? `（带上 ${history.length} 条已完成的历史；被打断那一轮的半截输出不带上 —— 它不是完整的对话）\n\n`
          : "（这一段之前没有完成的回合，所以这轮没有历史可带）\n\n",
      );
      const out = await engine.run({
        sessionId: wanted,
        provider,
        ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
        messages: [{ role: "user", content: target.userMessage }],
        ...(history.length ? { history } : {}),
        mode: normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认"),
        useTools: true,
        maxSteps: 8,
      });
      /*
       * ⭐ 把**旧那一轮**销账（2026-10-16，审计 P141）。
       *
       * "被打断"的判据是"这条请求没有终止记录"（`recovery.ts` 的 `interruptedTurns`）。
       * 原来 `--continue` 只是用**新的** requestId 重跑一轮，旧那条请求依旧没有终态 ——
       * 于是 `ding resume` 每次都还报同一段会话"被打断"，用户以为继续失败，
       * 再点一次又花一次钱（这个循环没有出口）。
       * 现在补一条**指向旧 requestId** 的终止记录：它settle了，后面的 `ding resume` 就不再报。
       */
      await store.append(wanted, [
        {
          requestId: target.requestId,
          type: "error",
          message: "这一轮已由 `ding resume --continue` 重跑，不再算作被打断",
          /* 宿主补的终止记录：actor = system（C5 —— 不是人也不是模型写的） */
          actor: SYSTEM_ACTOR,
        },
      ]);
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              sessionId: wanted,
              continued: true,
              ok: out.ok,
              ...(out.error ? { error: out.error } : {}),
              historyTurns: history.length,
            },
            null,
            2,
          ) + "\n",
        );
      } else if (out.ok) {
        process.stdout.write("跑完了。`ding resume` 能再看一眼状态。\n");
      }
      if (!out.ok) {
        process.stderr.write(`这一轮没成功：${out.error ?? "（没有错误信息）"}\n`);
        return 1;
      }
      return 0;
    } finally {
      close();
    }
  } finally {
    store.close();
  }
}
