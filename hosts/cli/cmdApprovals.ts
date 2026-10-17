import type { Parsed } from "./args";

/**
 * **`ding approvals`：审批与"批后通知"的消费端**（方案 3.7b 的最后一段）。
 *
 * 服务端那条 `GET /v1/approvals/stream`（只读 SSE）在上一轮建好了，但**没人用它** ——
 * 一个没人消费的通知端点等于没通知。这个命令就是那个消费端：
 *
 * ```
 * ding approvals --to <服务地址> --token <口令>            # 列一遍待决与已决
 * ding approvals --to <服务地址> --token <口令> --watch    # 盯着：**新处置的**主动打出来
 * ```
 *
 * ⚠️ `--watch` 的读法照抄 `hosts/server/approvalApi.test.ts` 里踩过两遍的写法：
 * **循环 read 到流结束**，不要用 `reader.read()` 与超时赛跑（会留下悬着的读把帧吞了），
 * 也不要用 `Response.text()` 配 abort（abort 抛错时已收到的也丢）。
 */

export async function cmdApprovals(parsed: Parsed): Promise<number> {
  const to = parsed.flags.get("to")?.[0] ?? "";
  const token = parsed.flags.get("token")?.[0] ?? process.env.DH_SYNC_TOKEN?.trim() ?? "";
  if (!to || !token) {
    process.stderr.write(
      "用法：ding approvals --to <服务地址> --token <口令> [--watch] [--state pending|approved|rejected]\n" +
        "（口令也可走环境变量 DH_SYNC_TOKEN）\n",
    );
    return 1;
  }
  const base = to.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const watch = parsed.flags.has("watch");
  const state = parsed.flags.get("state")?.[0];

  try {
    if (!watch) {
      const res = await fetch(`${base}/v1/approvals${state ? `?state=${encodeURIComponent(state)}` : ""}`, { headers: auth });
      const body = (await res.json()) as { approvals?: Array<Record<string, unknown>>; error?: string };
      if (!res.ok) {
        process.stderr.write(`读审批被拒（${res.status}）：${body.error ?? ""}\n`);
        return 1;
      }
      const rows = body.approvals ?? [];
      if (parsed.flags.has("json")) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      else if (!rows.length) process.stdout.write("没有待决/已决的审批（或者这段会话没共享给你）\n");
      else
        for (const row of rows) {
          process.stdout.write(
            `${String(row.state).padEnd(8)} ${String(row.name)}　会话 ${String(row.sessionId)}　` +
              `审批人 ${((row.approvers as string[] | undefined) ?? []).join("/") || "?"}` +
              `${row.decidedBy ? `　由 ${String(row.decidedBy)} 处置` : ""}\n`,
          );
        }
      return 0;
    }

    /* --watch：盯着那条流（Ctrl+C 停） */
    process.stdout.write(`盯着 ${base}/v1/approvals/stream（新处置的会打出来；Ctrl+C 停）\n`);
    const res = await fetch(`${base}/v1/approvals/stream`, { headers: auth });
    if (!res.ok || !res.body) {
      process.stderr.write(`连不上通知流（${res.status}）—— 这条流要服务端接了审批索引\n`);
      return 1;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      /* 按空行切帧（SSE 的规矩）；只处理完整的那些，最后一段留着等下一块 */
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const name = /^event: (.+)$/m.exec(block)?.[1] ?? "";
        const data = /^data: (.+)$/m.exec(block)?.[1] ?? "";
        /* ready / ping 是握手与心跳：不打（用户要的是"有人动了那条"） */
        if (name !== "decision") continue;
        try {
          const got = JSON.parse(data) as { name?: string; state?: string; decidedBy?: string; sessionId?: string };
          process.stdout.write(
            `${got.decidedBy ?? "?"} ${got.state === "approved" ? "批了" : "拒了"}「${got.name ?? "?"}」（会话 ${got.sessionId ?? "?"}）\n`,
          );
        } catch {
          process.stdout.write(`${data}\n`);
        }
      }
    }
    return 0;
  } catch (error) {
    process.stderr.write(`审批命令失败：${String((error as Error)?.message ?? error)}\n`);
    return 1;
  }
}
