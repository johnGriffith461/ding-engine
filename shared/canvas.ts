/**
 * 画布文档与快照的共享类型（主进程写盘、渲染进程读写都引这里）。
 *
 * 一份画布 = 版本号 + 单调修订号 + 视口 + 节点 + 边。
 * 节点/边的具体结构由渲染进程的 `src/canvas/types.ts` 定义，这里只保证
 * "能被 JSON 序列化"这一条（画布图必须可序列化，否则宁可显式报错）。
 */

export type CanvasViewport = { x: number; y: number; zoom: number };

export type CanvasDocument = {
  /** 文档格式版本；结构变了才 +1。 */
  version: number;
  /** 单调递增修订号（对标原版 `documentRevision`）。 */
  revision: number;
  /** 已被确认落盘的修订号（对标原版 ack）。 */
  confirmedRevision: number;
  /** 最后写入时间（ISO）。 */
  updatedAt?: string;
  viewport: CanvasViewport;
  nodes: unknown[];
  edges: unknown[];
  /** 标记层（阶段 5）。文档 version 2 起有这一项。 */
  markers?: unknown[];
};

/** 快照状态摘要。 */
export type CanvasSnapshotFile = {
  revision: number;
  confirmed: boolean;
  updatedAt: string | null;
  dir: string;
};

/** 载入结果。 */
export type CanvasLoadResult = {
  doc: CanvasDocument;
  recovered: boolean;
  recoveryNote?: string;
};

/** 保存结果。 */
export type CanvasSaveResult = { ok: true; savedAt: string } | { ok: false; error: string };

/**
 * 当前文档格式版本。
 *
 * ⚠️ **以前这个 2 是装饰品**：`emptyDocument()` 一直写 `version: 2`，
 * 但**没有任何代码读过它** —— 也就是说"结构变了才 +1"这条规矩从来没有落点
 * （C1 点名的那条："仅画布有 version: 2 却无迁移分支"）。
 * 现在 `migrateCanvasDoc` 读它，`saveDocument` 也用它挡"别把新数据降级写回"。
 */
export const CANVAS_VERSION = 2;

/** 迁移结果。 */
export type CanvasMigrateResult = {
  doc: CanvasDocument;
  /** 磁盘上是第几版（缺 `version` 的旧文件算 1）。 */
  from: number;
  /** 跑过迁移 → 建议回写一次，让磁盘也升上来。 */
  migrated: boolean;
  /**
   * 磁盘上的版本比本代码新。
   *
   * ⚠️ 这时**不许回写**（`saveDocument` 会拒）—— 降级运行硬写回去 = 把用户画布降级销毁。
   * 但**内容照给**：画布是用户看得见的东西，宁可尽力读出来，
   * 也不要因为"版本不认识"就让用户以为画布没了。
   */
  foreign: boolean;
  note?: string;
};

/**
 * 画布文档的前向迁移（C1）。
 *
 * 已知的结构变化：
 * - **version 1 → 2**：新增**标记层** `markers`（阶段 5 的批注）。
 *   旧文件没有这个字段，补一个空数组即可 —— 不补的话渲染侧要各自判空
 *   （那是"每个消费方都得记得"的老毛病）。
 *
 * 缺 `version` 的当 1 处理（`version` 是后来才加的，早期的文件里没有）。
 * **不做节点/边的清洗** —— 那是 `src/canvas/normalizeDoc.ts` 的活（"宁可挪位置，不可丢内容"），
 * 这里只管**文档外壳**的形状，两件事分开，免得两个地方都在猜同一件事。
 *
 * @param raw 磁盘上读出来的东西
 * @param empty 兜底的空文档（调用方给，避免这里 import 主进程的 `emptyDocument`）
 * @returns 迁移结果
 */
export function migrateCanvasDoc(raw: unknown, empty: () => CanvasDocument): CanvasMigrateResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { doc: empty(), from: CANVAS_VERSION, migrated: false, foreign: false };
  }
  const doc = raw as CanvasDocument;
  const from = typeof doc.version === "number" && Number.isFinite(doc.version) ? doc.version : 1;

  if (from > CANVAS_VERSION) {
    return {
      doc,
      from,
      migrated: false,
      foreign: true,
      note: `磁盘上的画布是第 ${from} 版，本程序只认识到第 ${CANVAS_VERSION} 版 —— 只读不写`,
    };
  }
  if (from === CANVAS_VERSION) return { doc, from, migrated: false, foreign: false };

  // 1 → 2：补标记层
  const next: CanvasDocument = { ...doc, version: CANVAS_VERSION, markers: Array.isArray(doc.markers) ? doc.markers : [] };
  return { doc: next, from, migrated: true, foreign: false, note: `画布已从第 ${from} 版升到第 ${CANVAS_VERSION} 版` };
}
