import path from "node:path";

import {
  canvasDiffToEvents,
  canvasEventsToDoc,
  foldCanvas,
  type CanvasEvent,
  type CanvasEventType,
} from "../core/canvasContract";
import type { CanvasDocument } from "../../shared/canvas";
import { openSqlite, type SqliteDatabase } from "./sqliteDriver";
import { runMigrations } from "./sqliteSchema";

/**
 * **画布事件的存储**（V5-4 补：C6 3.9a 的验收"画布操作产生可回放事件"）。
 *
 * ## 为什么它必须存在
 *
 * 在这之前，画布是 `CanvasDocument`（一个 JSON 快照）："谁在什么时候加了哪个节点"
 * 在会话日志里查不到 —— 而协作（共享/接管）与审计（C5）都要这两件事。
 * 契约（八类事件 + `foldCanvas` + 双向桥）在 V5-1 就冻好了，缺的是**有一张真表在存它**。
 *
 * ## 谁写它
 *
 * 宿主在"保存画布"那一步写：拿上一次的文档与新文档算差（`canvasDiffToEvents`），
 * 把差追加成事件。第一次见到某张画布时是**全量转换**（3.9d：只读旧写新），
 * 之后每次只追加变化的那几条。
 *
 * ## 与 `document.json` 的关系
 *
 * `document.json` **降级为派生缓存**（打开页面时读它快；真相是这张表）。
 * 两者不一致时以事件表为准 —— 而且这种不一致要被**报出来**（`drift`），
 * 不静默覆盖：静默覆盖的后果是哪天有人手改了 JSON，日志里的历史就凭空少了一截。
 */

/** 一条落盘的画布事件。 */
export type StoredCanvasEvent = CanvasEvent & { seq: number };

/** 一次写入的结果。 */
export type CanvasAppendResult = {
  /** 真的落下去的事件（**只有变化才落** —— "保存了但什么都没改"不该留痕）。 */
  appended: StoredCanvasEvent[];
  /** 写完之后这张画布的修订号。 */
  revision: number;
};

export type CanvasStore = {
  /** 这张画布的 owner（没有这张画布 → `undefined`）。 */
  ownerOf: (canvasId: string) => string | undefined;
  /** 读全部事件（按 seq）。 */
  events: (canvasId: string) => StoredCanvasEvent[];
  /** 折叠成的状态（= 事件流算出来的文档内容）。 */
  stateOf: (canvasId: string) => ReturnType<typeof foldCanvas>;
  /** 文档形态（`document.json` 该长什么样 —— 由事件算出来）。 */
  docOf: (canvasId: string, opts?: { version?: number }) => CanvasDocument;
  /**
   * **保存一次文档**（宿主在"保存画布"那一步调它）。
   *
   * @param input.canvasId 哪张画布
   * @param input.doc 新文档
   * @param input.owner 第一次见到这张画布时的归属（之后不再改 —— 与 C1 同一个口径）
   * @param input.at / input.actor 时刻与谁干的（C5）
   * @returns 真落了哪些事件 + 写完的修订号
   */
  save: (input: {
    canvasId: string;
    doc: Pick<CanvasDocument, "nodes" | "edges" | "markers" | "viewport">;
    owner?: string;
    at?: number;
    actor?: CanvasEvent["actor"];
  }) => CanvasAppendResult;
  /** 文档与事件流算出来的那份**对不对得上**（对不上给一句人话，不静默覆盖）。 */
  drift: (canvasId: string, doc: Pick<CanvasDocument, "nodes" | "edges" | "markers" | "viewport">) => string | null;
  close: () => void;
};

/** 打开画布事件库（与会话库**同一个文件** + 同一条迁移链 —— 表是 v6 建的）。 */
export function createCanvasStore(dataDir: string, file = "sessions.db"): CanvasStore {
  const db: SqliteDatabase = openSqlite(path.join(dataDir, file));
  runMigrations(db);

  const prep = (sql: string) => {
    const statement = db.prepare(sql);
    return statement;
  };
  const insertEvent = prep(
    "INSERT OR REPLACE INTO canvas_events(canvas_id, seq, at, type, actor_id, actor_kind, payload) VALUES(?, ?, ?, ?, ?, ?, ?)",
  );
  const selectEvents = prep("SELECT seq, at, type, actor_id, actor_kind, payload FROM canvas_events WHERE canvas_id = ? ORDER BY seq ASC");
  const upsertCanvas = prep(
    `INSERT INTO canvases(id, owner, current_revision, confirmed_revision, updated_at) VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET current_revision = ?, confirmed_revision = ?, updated_at = ?`,
  );
  const canvasRow = prep("SELECT owner, current_revision, confirmed_revision FROM canvases WHERE id = ?");

  const eventsOf = (canvasId: string): StoredCanvasEvent[] => {
    const rows = selectEvents.all(canvasId) as {
      seq: number;
      at: number;
      type: string;
      actor_id?: string;
      actor_kind?: string;
      payload: string;
    }[];
    const out: StoredCanvasEvent[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as CanvasEvent;
        out.push({ ...parsed, seq: Number(row.seq) });
      } catch {
        /* 坏行跳过（与日志读回同一个口径：一条坏行不该让整张画布打不开） */
      }
    }
    return out;
  };

  return {
    ownerOf: (canvasId) => (canvasRow.get(canvasId) as { owner?: string } | undefined)?.owner,

    events: (canvasId) => eventsOf(canvasId),

    stateOf: (canvasId) => foldCanvas(eventsOf(canvasId)),

    docOf: (canvasId, opts = {}) => canvasEventsToDoc(eventsOf(canvasId), { version: opts.version ?? 2 }),

    save: ({ canvasId, doc, owner, at, actor }) => {
      const existing = eventsOf(canvasId);
      const previousDoc = existing.length
        ? canvasEventsToDoc(existing, { version: 2 })
        : null;
      const fresh = canvasDiffToEvents(previousDoc, doc, {
        canvasId,
        startSeq: existing.length ? Math.max(...existing.map((e) => e.seq)) : 0,
        at: at ?? Date.now(),
        ...(actor ? { actor } : {}),
        ...(owner ? { owner } : {}),
      });

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const event of fresh) {
          const { seq, ...rest } = event as StoredCanvasEvent;
          insertEvent.run(
            canvasId,
            seq,
            Number((rest as { at?: number }).at ?? 0),
            String((rest as { type?: string }).type ?? ""),
            rest.actor?.id ?? "legacy",
            rest.actor?.kind ?? "legacy",
            JSON.stringify({ ...rest, seq }),
          );
        }
        const revision = fresh.length ? Math.max(...fresh.map((e) => e.seq)) : Math.max(0, ...existing.map((e) => e.seq));
        const ownerNow = owner?.trim() || existing.find((e) => e.type === "canvas.open")?.owner?.trim() || "local";
        const now = at ?? Date.now();
        /* 确认位点：事件一落盘就是"已确认"（宿主保存了这个文档），口径与 3.9d 一致 */
        upsertCanvas.run(canvasId, ownerNow, revision, revision, now, revision, revision, now);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.exec("COMMIT");
      return { appended: fresh as StoredCanvasEvent[], revision: Number((canvasRow.get(canvasId) as { current_revision?: number })?.current_revision ?? 0) };
    },

    drift: (canvasId, doc) => {
      const fromEvents = canvasEventsToDoc(eventsOf(canvasId), { version: 2 });
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
      if (same(fromEvents.nodes, doc.nodes) && same(fromEvents.edges, doc.edges) && same(fromEvents.markers, doc.markers)) return null;
      return (
        `这张画布的 document.json 与事件流算出来的那份不一致（节点 ${(doc.nodes ?? []).length} vs ${fromEvents.nodes.length}，` +
        `边 ${(doc.edges ?? []).length} vs ${fromEvents.edges.length}）—— 真相是事件流，` +
        `下次保存会以事件流为基准算差；要重建缓存可以按事件流重放。`
      );
    },

    close: () => db.close(),
  };
}

/** 画布事件里出现过哪些类型（`doctor`/诊断用得上：一眼看出有没有认不出的类型）。 */
export function canvasEventTypesSeen(events: readonly CanvasEvent[]): CanvasEventType[] {
  return [...new Set(events.map((e) => e.type))].sort() as CanvasEventType[];
}
