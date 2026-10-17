import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { createCursorJournal } from "../../engine/adapters/syncCursorJournal";
import { appliedNote, frameOf, planMerge } from "../../engine/sync/merge";
import type { StreamRecord } from "../../engine/sync/relay";
import type { LogInput } from "../../engine/core/events";
import type { Parsed } from "./args";

/**
 * **`ding sync`：两端同步的产品客户端**（V5-2 的那半，2026-10-17 补；ADR-0017）。
 *
 * ## 它补的是什么
 *
 * 在这之前 V5-2 只有"引擎原语 + 中继 + 服务端端点"：协议、游标、出站队列、
 * fencing 全都在、测试也全绿，但**没有一个宿主在推拉** —— 也就是说"两台设备同步
 * 同一段会话"作为产品功能并不存在。这一条把它接上：
 *
 * ```
 * ding sync <会话 id> --to http://<跑着 ding serve 的机器>:8787 --token <成员口令>
 * ```
 *
 * ## 一轮同步干三件事（顺序是刻意的）
 *
 * 1. **建流 + claim**（拿当前 epoch —— 中继是"单一持有者 + fencing"语义，
 *    另一端接管过的话我这边会拿到 `fenced`，claim 一次就拿到新的）；
 * 2. **推**：本地**还没推过**的记录（出站队列口径：游标里 `pushedSeq` 之后的）→
 *    包成**记录帧**（`frameOf`，内容寻址 id）推上去。中继回 `gap`（换了流/换了实例）
 *    就 `restart` 从这条流的头重推（进度作废，id 不变所以不会重复）；
 * 3. **拉 + 合并**：从中继拉一页 → `planMerge` 定"该 append 哪几条"（自己的、
 *    以及经别人转手回来的自己的，按**内容 id** 跳过）→ append 进本地库
 *    （`at` 用记录自己的 —— 另一端的历史不该被挤进"现在"）。
 *
 * ## 如实说边界
 *
 * · **不做删除/改写**（两端同步的是"发生过的事"，日志是只追加的）；
 * · **不抢归属**：本地没有这段会话时按 `--owner` 建（不给就拒绝，**不猜**）；
 * · 一次一轮（没有常驻循环）：要"一直同步"就配 cron / 定时任务调它。
 */

export type SyncOptions = {
  dataDir: string;
  sessionId: string;
  /** 中继所在的服务地址（`ding serve` 那台机器）。 */
  to: string;
  /** 成员口令 / 主口令。 */
  token: string;
  /** 生产者在这次同步里的 id（默认取主机名 + 时间戳的短哈希，稳定即可）。 */
  producerId?: string;
  /** 本地没有这段会话时用它建（不给就拒绝）。 */
  owner?: string;
  /** 拉一页的上限（默认 200）。 */
  pageSize?: number;
  fetchImpl?: typeof fetch;
};

export type SyncReport = {
  streamId: string;
  epoch: number;
  pushed: number;
  pulled: number;
  applied: number;
  skippedMine: number;
  skippedBadShape: number;
  localBefore: number;
  localAfter: number;
  note: string;
};

/** 一轮同步（**可测的纯逻辑 + 真 HTTP**：`fetch` 可注入）。 */
export async function syncSession(opts: SyncOptions): Promise<SyncReport> {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.to.replace(/\/+$/, "");
  const sessionId = opts.sessionId;
  const producerId = opts.producerId ?? `cli-${Math.abs(hashOf(`${base}|${sessionId}`))}`;
  const journal = createCursorJournal(opts.dataDir);
  const store = createSqliteSessionStore(opts.dataDir);
  const auth = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    try {
      return { status: res.status, json: (JSON.parse(text) as Record<string, unknown>) ?? {} };
    } catch {
      return { status: res.status, json: { raw: text } };
    }
  };

  try {
    const records = (await store.load(sessionId)).records;
    const localBefore = records.length;
    /*
     * 本地没有这段会话：**不猜归属** —— 要么先同步另一端过来（那时它就在本地了），
     * 要么显式 `--owner`（"这段会话归谁"是 C1 的事实，不该由同步顺手编一个）。
     */
    if (!localBefore && !opts.owner) {
      throw new Error(`本地没有这一段会话：${sessionId}（要新建请给 --owner <成员 id>：归属是事实，不猜）`);
    }
    if (!localBefore && opts.owner) {
      /* 建一段空的（归属定下来），下面拉回来的记录就落进它 */
      await store.append(sessionId, [{ requestId: "sync-init", type: "request", provider: "", model: "", messages: [] } as LogInput], {
        owner: opts.owner,
      });
    }

    /* ① 建流（幂等）+ claim */
    const created = await call("PUT", `/v1/streams/${encodeURIComponent(sessionId)}`);
    if (created.status >= 400 && !String(created.json.error ?? "").includes("已经")) {
      /* 建流失败不致命（可能已经在了）—— 但 401/403 要当场说清 */
      if (created.status === 401 || created.status === 403) throw new Error(`建流被拒（${created.status}）：${String(created.json.error ?? "")}`);
    }
    const claimed = await call("POST", `/v1/streams/${encodeURIComponent(sessionId)}/claim`, { holder: producerId });
    if (!claimed.json.ok) throw new Error(`claim 失败：${String(claimed.json.message ?? JSON.stringify(claimed.json))}`);
    let epoch = Number(claimed.json.epoch ?? 0);

    /* ② 推：游标之后的那些（内容寻址 id → 多跳也不会重复） */
    const restored = journal.load(sessionId);
    let pushedSeq = restored.status === "ok" ? restored.cursor.pushedSeq : 0;
    let pulledOffset = restored.status === "ok" ? restored.cursor.pulledOffset : 0;
    let pushed = 0;

    const pending = records.filter((r) => r.seq > pushedSeq);
    const pushOnce = async (items: typeof pending, from: number): Promise<{ ok: boolean; code?: string }> => {
      if (!items.length) return { ok: true };
      const events = items.map((record, index) => ({ ...frameOf(sessionId, record), seq: from + index + 1 }));
      const got = await call("POST", `/v1/streams/${encodeURIComponent(sessionId)}/push`, { producerId, epoch, events });
      if (got.json.ok) {
        pushed += events.length;
        pushedSeq = from + events.length;
        return { ok: true };
      }
      return { ok: false, code: String(got.json.code ?? "") };
    };

    let attempt = await pushOnce(pending, pushedSeq);
    if (!attempt.ok && attempt.code === "gap") {
      /*
       * **换了一条流**（中继重启/换实例）：我这边的进度作废 —— 从这条流的**头**重推
       * （事件 id 由内容算，另一端按 id 去重，所以不会重复）。规则在 ADR-0016 §1。
       */
      pushedSeq = 0;
      attempt = await pushOnce(pending, 0);
    }
    if (!attempt.ok) throw new Error(`push 被拒：${attempt.code}（换流之后仍推不上去，请检查 token / epoch）`);

    /* ③ 拉 + 合并（内容 id 认"是不是我的"） */
    const pageSize = opts.pageSize ?? 200;
    const pulledPage = await call("GET", `/v1/streams/${encodeURIComponent(sessionId)}/pull?from=${pulledOffset}&limit=${pageSize}`);
    const events = (pulledPage.json.events ?? []) as StreamRecord[];
    const nextOffset = Number(pulledPage.json.nextOffset ?? pulledOffset);
    const plan = planMerge({ sessionId, local: records, pulled: events });
    if (plan.apply.length) {
      await store.append(
        sessionId,
        plan.apply.map((a) => ({ ...(a.record as Record<string, unknown>), at: a.at })) as unknown as LogInput[],
      );
    }
    pulledOffset = nextOffset;
    journal.save({ streamId: sessionId, producerId, epoch, pushedSeq, pulledOffset });

    const localAfter = (await store.load(sessionId)).records.length;
    return {
      streamId: sessionId,
      epoch,
      pushed,
      pulled: events.length,
      applied: plan.apply.length,
      skippedMine: plan.skippedMine,
      skippedBadShape: plan.skippedBadShape,
      localBefore,
      localAfter,
      note: appliedNote(plan),
    };
  } finally {
    store.close();
  }
}

/** 短哈希（生产者的默认 id 用；只是要个稳定的名字，不是密码学）。 */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0;
}

/** `ding sync <会话 id> --to <地址> --token <口令> [--owner <id>] [--producer <id>]`。 */
export async function cmdSync(parsed: Parsed, dataDir: string): Promise<number> {
  const sessionId = parsed.args[0] ?? "";
  const to = parsed.flags.get("to")?.[0] ?? "";
  const tokenEnv = process.env.DH_SYNC_TOKEN?.trim() ?? "";
  const token = parsed.flags.get("token")?.[0] ?? tokenEnv;
  if (!sessionId || !to || !token) {
    process.stderr.write(
      "用法：ding sync <会话 id> --to <服务地址> --token <口令> [--owner <成员 id>] [--producer <id>]\n" +
        "（口令也可以走环境变量 DH_SYNC_TOKEN —— 别把它写进命令行历史）\n",
    );
    return 1;
  }
  const json = parsed.flags.has("json");
  try {
    const report = await syncSession({
      dataDir,
      sessionId,
      to,
      token,
      ...(parsed.flags.get("owner")?.[0] ? { owner: parsed.flags.get("owner")![0]! } : {}),
      ...(parsed.flags.get("producer")?.[0] ? { producerId: parsed.flags.get("producer")![0]! } : {}),
    });
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else
      process.stdout.write(
        [
          `已同步 ${sessionId}（epoch ${report.epoch}）`,
          `  推上去 ${report.pushed} 条　拉回来 ${report.pulled} 条`,
          `  合并进本地 ${report.applied} 条（跳过自己的 ${report.skippedMine} 条，形状不认的 ${report.skippedBadShape} 条）`,
          `  本地记录：${report.localBefore} → ${report.localAfter}`,
          `  ${report.note}`,
        ].join("\n") + "\n",
      );
    return 0;
  } catch (error) {
    process.stderr.write(`同步失败：${String((error as Error)?.message ?? error)}\n`);
    return 1;
  }
}
