import { splitTurns, type LogRecord } from "../../engine/core/events";

/**
 * 把一段记录渲染成人看的终端输出（Phase 18 从 `ding.ts` 那一份口径拆出来）。
 *
 * ⚠️ **这是唯一一份渲染**（审计 P217 / NEW-N7-26）：`ding run` / REPL / `ding recipe run`
 * 都走它。原来 `ding.ts` 里另有一份 `render()`，`ding recipe run` 用的是这一份 ——
 * 两份在细节上都不同，最要命的一处是：
 *
 * | | 老 `ding.ts` 的 render | 老 renderRecords |
 * |---|---|---|
 * | `view.error`（这一轮报的错） | **打** | **完全不打** |
 * | `trace.pending` | `✗` | `⏸` |
 * | 用户消息前缀 | `›` | `❯` |
 *
 * 第二条尤其糟：`ding recipe run` 里一轮带 error 的结果只留下正文，
 * 错误被吞 —— 用户看到"跑完了"，而那一轮其实报错了。同一个文件头还写着
 * "再写一份怎么显示必然漂"，所以这里把两份合成一份（补上 error 分支）。
 *
 * ⚠️ 用量那一行只打**输入/输出**（provider 没给就不打），
 * 不做"合计/单价"那些换算 —— 那是成本账本（`ding sessions --cost`）的活，
 * 两份换算放一起迟早对不上。
 *
 * @param records 整段会话的记录
 * @returns 一段可以直接写 stdout 的文本
 */
export function renderRecords(records: readonly LogRecord[]): string {
  const out: string[] = [];
  /** 工具留痕缩进（比正文退一格：读起来是"这句话底下发生的事"）。 */
  const indent = "  ";
  for (const chunk of splitTurns(records)) {
    /* 一轮里最后那条用户消息 = 这一轮的问题（与 `ding.ts` 原来的取法一致） */
    const ask = [...(chunk.request?.messages ?? [])].reverse().find((m) => m.role === "user");
    if (ask) out.push(`\n\x1b[2m› ${ask.content.trim()}\x1b[0m\n`);
    const view = chunk.view;
    if (view.text.trim()) out.push(`${view.text.trim()}`);
    for (const trace of view.traces) {
      const mark = trace.pending ? "⏸" : trace.ok ? "✓" : "✗";
      out.push(`${indent}${mark} ${trace.line}`);
    }
    if (view.usage) {
      const u = view.usage;
      const has = typeof u.inputTokens === "number" || typeof u.outputTokens === "number";
      out.push(`${indent}\x1b[2m（用量${has ? ` ↑${u.inputTokens ?? "-"} ↓${u.outputTokens ?? "-"}` : ""}）\x1b[0m`);
    }
    /* ⭐ 这一行就是 P217 修掉的那个"被吞掉的错误" */
    if (view.error) out.push(`${indent}\x1b[31m${view.error}\x1b[0m`);
  }
  return out.join("\n") + "\n";
}
