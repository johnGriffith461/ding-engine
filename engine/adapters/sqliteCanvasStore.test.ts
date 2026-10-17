import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCanvasStore } from "./sqliteCanvasStore";

/**
 * **画布事件接线**（v6；C6 3.9a 的验收："画布操作产生可回放事件"）。
 *
 * 判据按"产品里真会发生的那几步"排：
 *   ① 第一次保存 → **全量转换**（存量只读旧写新，3.9d）；
 *   ② 之后每次保存 → **只追加变化的那几条**（"保存了但没改"不留痕）；
 *   ③ 折叠出来的文档 == 保存进去的那份（节点/边/标记逐字相同 —— 这是"可回放"的定义）；
 *   ④ 三类元素各自的表达能力：节点增改删；边改内容 = 删 + 建（没有 `edge.update`）；
 *   **标记改不了也删不掉**（契约里只有 `marker.add`，如实记边界）；
 *   ⑤ `document.json` 与事件流不一致要**报出来**（`drift`），不静默覆盖。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为（Windows） */
    }
  }
});
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-canvas-store-"));
  dirs.push(dir);
  return dir;
};

const node = (id: string, text: string) => ({ id, type: "markdown", position: { x: 0, y: 0 }, data: { text, title: "文本" } });
const edge = (id: string, from: string, to: string) => ({ id, source: from, target: to });
const doc = (over: Record<string, unknown> = {}) => ({
  version: 2,
  revision: 0,
  confirmedRevision: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  edges: [],
  markers: [],
  ...over,
});

describe("画布事件存储（v6）", () => {
  it("① 第一次保存全量转换；② 之后只追加差；③ 折叠回来与保存的那份一致", () => {
    const dir = tmpDir();
    const store = createCanvasStore(dir);
    try {
      const first = store.save({
        canvasId: "canvas-1",
        doc: doc({ nodes: [node("n1", "甲")], edges: [edge("e1", "n1", "n1")] }),
        owner: "local",
      });
      /* 第一次：open + 1 节点 + 1 边 = 3 条 */
      expect(first.appended.map((e) => e.type)).toEqual(["canvas.open", "node.create", "edge.create"]);
      expect(store.ownerOf("canvas-1")).toBe("local");
      const asDoc = store.docOf("canvas-1");
      expect(asDoc.nodes).toEqual([node("n1", "甲")]);
      expect(asDoc.edges).toEqual([edge("e1", "n1", "n1")]);

      /* 什么都没改：一条也不产（"保存了但没改"不该在日志里留痕） */
      const noop = store.save({ canvasId: "canvas-1", doc: doc({ nodes: [node("n1", "甲")], edges: [edge("e1", "n1", "n1")] }) });
      expect(noop.appended).toEqual([]);

      /* 加一个节点 → 一条 */
      const added = store.save({
        canvasId: "canvas-1",
        doc: doc({ nodes: [node("n1", "甲"), node("n2", "乙")], edges: [edge("e1", "n1", "n1")] }),
      });
      expect(added.appended.map((e) => e.type)).toEqual(["node.create"]);
      expect(added.appended[0]?.node).toEqual(node("n2", "乙"));

      /* 改一个节点 → 一条 node.update（带 patch） */
      const changed = store.save({
        canvasId: "canvas-1",
        doc: doc({ nodes: [node("n1", "甲（改过）"), node("n2", "乙")], edges: [edge("e1", "n1", "n1")] }),
      });
      expect(changed.appended.map((e) => e.type)).toEqual(["node.update"]);
      expect(changed.appended[0]?.patch).toEqual(node("n1", "甲（改过）"));

      /* 删一个节点 → 一条 node.delete */
      const removed = store.save({ canvasId: "canvas-1", doc: doc({ nodes: [node("n2", "乙")], edges: [edge("e1", "n1", "n1")] }) });
      expect(removed.appended.map((e) => e.type)).toEqual(["node.delete"]);
      expect(removed.appended[0]?.id).toBe("n1");

      /* 折叠回来 = 最后保存的那份（节点/边逐字） */
      const finalDoc = store.docOf("canvas-1");
      expect(finalDoc.nodes).toEqual([node("n2", "乙")]);
      expect(finalDoc.edges).toEqual([edge("e1", "n1", "n1")]);
      /* 修订号 = 事件序号（3.9d 的"平移"） */
      expect(finalDoc.revision).toBe(store.events("canvas-1").at(-1)?.seq);
    } finally {
      store.close();
    }
  });

  it("④ 三类元素的表达能力：边改内容 = 删 + 建；标记改不动（契约边界）", () => {
    const dir = tmpDir();
    const store = createCanvasStore(dir);
    try {
      store.save({ canvasId: "c2", doc: doc({ edges: [edge("e1", "a", "b")], markers: [{ id: "m1", text: "标注" }] }) });

      /* 边换目标 → 两条（没有 edge.update） */
      const edgeChanged = store.save({ canvasId: "c2", doc: doc({ edges: [edge("e1", "a", "c")], markers: [{ id: "m1", text: "标注" }] }) });
      expect(edgeChanged.appended.map((e) => e.type)).toEqual(["edge.delete", "edge.create"]);
      expect(store.docOf("c2").edges).toEqual([edge("e1", "a", "c")]);

      /* 改标记的文字：**表达不了**（`CANVAS_EVENT_TYPES` 里只有 marker.add）→ 不产事件，如实记边界 */
      const markerChanged = store.save({ canvasId: "c2", doc: doc({ edges: [edge("e1", "a", "c")], markers: [{ id: "m1", text: "改过的标注" }] }) });
      expect(markerChanged.appended).toEqual([]);
      /* 折叠出来的仍是旧文字 —— 这就是那条边界的可见后果（不是 bug，是契约只管到这儿） */
      expect((store.docOf("c2").markers ?? [])[0]).toEqual({ id: "m1", text: "标注" });

      /* 加一个**新的**标记：能表达 */
      const markerAdded = store.save({
        canvasId: "c2",
        doc: doc({ edges: [edge("e1", "a", "c")], markers: [{ id: "m1", text: "标注" }, { id: "m2", text: "新的" }] }),
      });
      expect(markerAdded.appended.map((e) => e.type)).toEqual(["marker.add"]);
    } finally {
      store.close();
    }
  });

  it("视口变了 = 一条 canvas.open（契约里视口并进 open 的载荷）", () => {
    const dir = tmpDir();
    const store = createCanvasStore(dir);
    try {
      store.save({ canvasId: "c3", doc: doc({ nodes: [node("n1", "甲")] }) });
      const moved = store.save({ canvasId: "c3", doc: doc({ viewport: { x: 120, y: -40, zoom: 1.5 }, nodes: [node("n1", "甲")] }) });
      expect(moved.appended.map((e) => e.type)).toEqual(["canvas.open"]);
      expect(store.docOf("c3").viewport).toEqual({ x: 120, y: -40, zoom: 1.5 });
      /* 归属不会被后续保存改掉（与 C1 同一个口径） */
      expect(store.ownerOf("c3")).toBe("local");
    } finally {
      store.close();
    }
  });

  it("⑤ document.json 与事件流不一致：报出来，不静默覆盖", () => {
    const dir = tmpDir();
    const store = createCanvasStore(dir);
    try {
      store.save({ canvasId: "c4", doc: doc({ nodes: [node("n1", "甲")] }) });
      expect(store.drift("c4", doc({ nodes: [node("n1", "甲")] }))).toBeNull();
      const reported = store.drift("c4", doc({ nodes: [node("n1", "甲"), node("x", "手改的")] }));
      expect(reported).toContain("真相是事件流");
      /* 报出来之后**保存仍然以事件流为基准算差**（手加的那个会被当成新增，而不是被删） */
      const saved = store.save({ canvasId: "c4", doc: doc({ nodes: [node("n1", "甲"), node("x", "手改的")] }) });
      expect(saved.appended.map((e) => e.type)).toEqual(["node.create"]);
    } finally {
      store.close();
    }
  });

  it("actor 进事件（C5）：谁改的画布要查得到", () => {
    const dir = tmpDir();
    const store = createCanvasStore(dir);
    try {
      store.save({ canvasId: "c5", doc: doc({ nodes: [node("n1", "甲")] }), actor: { id: "alice", kind: "user" }, at: 1_700_000_000_000 });
      const first = store.events("c5")[0]!;
      expect(first.actor).toEqual({ id: "alice", kind: "user" });
      expect(first.at).toBe(1_700_000_000_000);
    } finally {
      store.close();
    }
  });
});
