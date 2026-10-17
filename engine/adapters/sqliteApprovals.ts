import path from "node:path";

import { approversOf } from "../core/gates";
import { openSqlite, type SqliteDatabase } from "./sqliteDriver";
import { runMigrations, SCHEMA_VERSION } from "./sqliteSchema";

/**
 * **审批索引的读侧**（v6；C3 3.7b）。
 *
 * ## 它是投影，不是真相
 *
 * 待决与决策的真相在**会话日志**里（`tool-result(pending)` / `approval` / `approval-grant`
 * 三条记录）。这张表由 `sqliteStore` 的 `append` 同步维护，存在的唯一理由是**快**：
 * 服务端回答"有哪些待决、归谁批、批了没有"要一次索引查询 ——
 * 而不是把每个会话的记录解一遍 JSON（成员一多就得扫全场）。
 *
 * ⚠️ 由此有一条纪律：**这里只读，不写**。写入只有 `sqliteStore.append` 一处 ——
 * 两个写入方迟早会让索引与日志对不上（`sqliteApprovals.test.ts` 的"索引 = 从日志现算"
 * 就是盯这件事的）。
 *
 * ## 为什么要单独一个工厂（而不是挂在 SessionStore 上）
 *
 * `SessionStore` 是**冻结的公开端口**（契约门盯着），加方法是一次契约变更；
 * 而"审批索引"是宿主侧的一个查询面，不该塞进会话库那个口子里。
 * 两个工厂打开的是同一个库文件（WAL 下多连接是正常的读写方式）。
 */

/** 一条审批索引行。 */
export type ApprovalRow = {
  sessionId: string;
  toolCallId: string;
  /** 工具名（界面要显示"要批准什么"）。 */
  name: string;
  /** 当时的审批人集合（可能被后续的授权记录更新过）。 */
  approvers: string[];
  state: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: number;
  createdAt: number;
};

export type ApprovalsIndex = {
  /** 按会话 + 工具调用 id 取一条。 */
  get: (sessionId: string, toolCallId: string) => ApprovalRow | undefined;
  /**
   * 查一批会话里的审批（服务的"有哪些待决"那条路）。
   *
   * @param opts.sessionIds 只查这些会话（**调用方负责把可见集算好** ——
   *   这里不做权限判定，那是 `spaceApi`/`canReadSession` 的事）
   * @param opts.state 只要这个状态（不给 = 全部）
   * @param opts.limit 上限（默认 200；这条路的调用方是界面/服务端）
   */
  list: (opts: { sessionIds: readonly string[]; state?: ApprovalRow["state"]; limit?: number }) => ApprovalRow[];
  /**
   * **会话收口时一起清**（ADR-0016 第 7 条）：删掉这些会话名下**已决**的审批行。
   *
   * ⚠️ **待决的不删** —— 待决是"还没处置的事"，跟着会话收口一起消失等于把用户的待办
   * 悄悄清了（他会以为"没人等他批"）。讨论与依据在 ADR-0016。
   *
   * @param sessionIds 刚被收口掉的会话
   * @returns 删了几行
   */
  pruneWith: (sessionIds: readonly string[]) => number;
  close: () => void;
};

/** 从载荷里读审批人（坏形状落默认，与读路径同一个口径 —— 不在这一层另立一套）。 */
const readApprovers = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]")) as unknown;
    if (!Array.isArray(parsed)) return approversOf(undefined);
    const list = parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
    return list.length ? [...new Set(list)] : approversOf(undefined);
  } catch {
    return approversOf(undefined);
  }
};

/** 打开审批索引（与 `createSqliteSessionStore` 同一个库文件 + 同一条迁移链）。 */
export function createApprovalsIndex(dataDir: string, file = "sessions.db"): ApprovalsIndex {
  const db: SqliteDatabase = openSqlite(path.join(dataDir, file));
  /* 打开即跑链：索引表是 v6 建的，旧库打开时补齐（不然查询会报"没有这张表"） */
  runMigrations(db);
  const cols = "session_id, tool_call_id, name, approvers, state, decided_by, decided_at, created_at";
  const toRow = (raw: Record<string, unknown>): ApprovalRow => ({
    sessionId: String(raw.session_id ?? ""),
    toolCallId: String(raw.tool_call_id ?? ""),
    name: String(raw.name ?? ""),
    approvers: readApprovers(raw.approvers),
    state: (raw.state === "approved" || raw.state === "rejected" ? raw.state : "pending") as ApprovalRow["state"],
    ...(typeof raw.decided_by === "string" && raw.decided_by ? { decidedBy: raw.decided_by } : {}),
    ...(typeof raw.decided_at === "number" ? { decidedAt: raw.decided_at } : {}),
    createdAt: Number(raw.created_at ?? 0),
  });

  /* 一次性查询（用完释放 —— 与 schema 那边同一个口径） */
  const all = (sql: string, ...params: unknown[]): Record<string, unknown>[] => {
    const statement = db.prepare(sql);
    try {
      return statement.all(...params) as Record<string, unknown>[];
    } finally {
      statement.finalize?.();
    }
  };

  const run = (sql: string, ...params: unknown[]): void => {
    const statement = db.prepare(sql);
    try {
      statement.run(...params);
    } finally {
      statement.finalize?.();
    }
  };

  return {
    get: (sessionId, toolCallId) => {
      const rows = all(`SELECT ${cols} FROM approvals WHERE session_id = ? AND tool_call_id = ?`, sessionId, toolCallId);
      return rows[0] ? toRow(rows[0]) : undefined;
    },

    list: ({ sessionIds, state, limit = 200 }) => {
      if (!sessionIds.length) return [];
      const marks = sessionIds.map(() => "?").join(",");
      const args: unknown[] = [...sessionIds];
      const stateSql = state ? " AND state = ?" : "";
      if (state) args.push(state);
      args.push(Math.max(1, limit));
      return all(
        `SELECT ${cols} FROM approvals WHERE session_id IN (${marks})${stateSql} ORDER BY created_at DESC LIMIT ?`,
        ...args,
      ).map(toRow);
    },

    pruneWith: (sessionIds) => {
      if (!sessionIds.length) return 0;
      const marks = sessionIds.map(() => "?").join(",");
      const before = Number((all(`SELECT COUNT(*) AS n FROM approvals WHERE session_id IN (${marks}) AND state <> 'pending'`, ...sessionIds)[0]?.n ?? 0));
      run(`DELETE FROM approvals WHERE session_id IN (${marks}) AND state <> 'pending'`, ...sessionIds);
      return before;
    },

    close: () => db.close(),
  };
}

/** SDK/宿主侧的一个便利：本程序认识的表结构版本（印在 `doctor` 里）。 */
export const APPROVALS_SCHEMA_VERSION = SCHEMA_VERSION;
