import { actorOf, type Actor } from "./actor";
import type { LogRecord } from "./events";

/**
 * **审计**（V5-3 任务 3.3）：从会话日志里回答"**谁在什么时候做了什么**"。
 *
 * ## 为什么它这么薄
 *
 * 因为留痕**早就有了**：C5 起每条记录自带 actor（谁写的），C1 起每段会话有归属。
 * 审计这一层不新造记录、不加字段 —— 它只是**把这些记录按人捞出来**。
 * 这正是方案里那句"成员操作全留痕（actor 维度的天然副产品）"的落点：
 * 如果审计要另记一份，那两份迟早对不上（对不上的那天，信哪一份都是错的）。
 *
 * ## 什么算"成员操作"
 *
 * | 记录 | 动作 | 为什么算 |
 * |---|---|---|
 * | `request` | 发起一轮 | 人说话（把模型叫起来的那一下） |
 * | `approval` | 批准 / 拒绝 | 人的裁决（C3） |
 * | 其余（text / tool-* / done…） | —— | 那是 **agent 的动作**，交给"团队进展"那条线，不混进成员审计 |
 *
 * 想连 agent 的动作一起看时给 `includeAgent`（诊断用）—— 默认不混，
 * 免得"某人做了什么"里塞满模型的自言自语。
 *
 * ## 纯逻辑
 *
 * 不 import fs/electron/node:*（内核边界守卫盯着 `engine/core/**`）。
 */

/** 审计里的一条。 */
export type AuditEntry = {
  /** 什么时刻（用记录自己的 `at` —— 它是"发生"的时刻，见 P14/P31 的教训）。 */
  at: number;
  /** 谁（C5 的 actor；老记录读回 legacy）。 */
  actor: Actor;
  sessionId: string;
  /** 动作（给人看的一句话，短）。 */
  action: string;
  /** 细节（用户说了什么 / 批的是哪个工具……）。 */
  detail?: string;
};

/** `auditOf` 的选项。 */
export type AuditOptions = {
  /** 连 agent 的动作也收进来（默认 false：审计是"人的账"）。 */
  includeAgent?: boolean;
};

/** 一条记录的动作名（人看的那些）。 */
function actionOf(record: LogRecord): { action: string; detail?: string } | null {
  if (record.type === "request") {
    const last = [...(record.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = (last?.content ?? "").trim().split("\n")[0]?.trim() ?? "";
    return { action: "发起一轮", ...(text ? { detail: text.slice(0, 60) } : {}) };
  }
  if (record.type === "approval") {
    const name = (record as { name?: string }).name ?? "";
    const line = (record as { line?: string }).line ?? "";
    return { action: (record as { approved?: boolean }).approved ? `批准 ${name}` : `拒绝 ${name}`, ...(line ? { detail: line.slice(0, 60) } : {}) };
  }
  return null;
}

/**
 * 把一段会话的记录过成审计条目（**按发生顺序**）。
 *
 * @param sessionId 会话 id（进每一条，方便跨会话汇总）
 * @param records 记录（`load()` 的产物）
 * @param opts 见 `AuditOptions`
 * @returns 审计条目
 */
export function auditOf(sessionId: string, records: readonly LogRecord[], opts: AuditOptions = {}): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const record of records) {
    const actor = actorOf(record as { actor?: Actor });
    const named = actionOf(record);
    const isHuman = actor.kind === "user" || actor.kind === "system" || actor.kind === "legacy";
    if (!named && !(opts.includeAgent && actor.kind === "agent")) continue;
    if (!isHuman && !opts.includeAgent) continue;
    out.push({
      at: record.at,
      actor,
      sessionId,
      action: named?.action ?? `${record.type}（agent）`,
      ...(named?.detail ? { detail: named.detail } : {}),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 审计查询的条件。 */
export type AuditQuery = {
  /** 只看这个人（成员 id）。 */
  member?: string;
  /** 从这个时刻起（epoch ms）。 */
  since?: number;
  /** 最多几条（默认 100 —— 审计是"翻账"，不是"导全量"，要全量就用 `since` 分段翻）。 */
  limit?: number;
};

/**
 * 查审计（纯函数：条件 → 结果）。
 *
 * @param entries 待查的条目（可能是多段会话拼起来的）
 * @param query 条件
 * @returns 命中的条目（**新的在前**：看的人在追最近发生的事）
 */
export function auditQuery(entries: readonly AuditEntry[], query: AuditQuery = {}): AuditEntry[] {
  const limit = Math.max(1, Math.floor(query.limit ?? 100));
  return entries
    .filter((e) => (query.member ? e.actor.id === query.member : true))
    .filter((e) => (query.since === undefined ? true : e.at >= query.since))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/**
 * 按人汇总（"谁在这台机器上做过多少事"）。
 *
 * @param entries 条目
 * @returns 每人一条（按条数降序）
 */
export function auditSummary(entries: readonly AuditEntry[]): Array<{ actor: Actor; count: number; lastAt: number }> {
  const byId = new Map<string, { actor: Actor; count: number; lastAt: number }>();
  for (const entry of entries) {
    const hit = byId.get(entry.actor.id);
    if (hit) {
      hit.count += 1;
      hit.lastAt = Math.max(hit.lastAt, entry.at);
    } else {
      byId.set(entry.actor.id, { actor: entry.actor, count: 1, lastAt: entry.at });
    }
  }
  return [...byId.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}
