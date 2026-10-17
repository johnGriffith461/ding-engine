import { describe, expect, it } from "vitest";

import {
  CANVAS_EVENT_TYPES,
  CANVAS_SURFACE,
  CANVAS_TOOL_OPS,
  canvasDocToEvents,
  canvasEventsToDoc,
  canvasOwner,
  canvasSurfaceVerdict,
  DEFAULT_CANVAS_OWNER,
  foldCanvas,
  type CanvasEvent,
} from "./canvasContract";
import { decide } from "./policy";
import { createToolRegistry } from "../runtime/registry";
import { CANVAS_VERSION, type CanvasDocument } from "../../shared/canvas";

/**
 * 画布语义契约（C6，V5-1 3.9）。
 *
 * 三条要挡的事：
 *   ① 画布操作**能变成可回放的事件**（fold 是纯函数、`seq` 乱序也不怕）；
 *   ② **存量桥接等价**（3.9d 的验收：老文档 → 事件 → 折叠回来，内容 diff=0）；
 *   ③ 画布工具族的**判定不靠运气**（surface 表 + 注册表对账：新工具没登记就红）。
 */

/** 一份像真家伙的存量画布文档（六种节点里挑三种 + 边 + 标记 + 非平凡视口）。 */
const legacyDoc: Pick<CanvasDocument, "nodes" | "edges" | "markers" | "viewport"> = {
  viewport: { x: -120.5, y: 64, zoom: 0.85 },
  nodes: [
    { id: "n1", type: "markdown", position: { x: 10, y: 20 }, data: { text: "# 标题", title: "笔记" } },
    { id: "n2", type: "image", position: { x: 300, y: 40 }, data: { src: "dshasset://gen-1.png", alt: "图", title: "图" } },
    { id: "n3", type: "mindmap", position: { x: 10, y: 260 }, data: { text: "- 根", title: "脑图" }, locked: true },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n1", target: "n3", label: "参考" },
  ],
  markers: [
    { id: "m1", from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, color: "#d9603a" },
  ],
};

describe("C6：事件类型与折叠", () => {
  it("类型就是方案列出的那八个名字（方案写「七类」但列了八个 —— 以名字为准，ADR-009）", () => {
    expect([...CANVAS_EVENT_TYPES]).toEqual([
      "canvas.open",
      "node.create",
      "node.update",
      "node.delete",
      "edge.create",
      "edge.delete",
      "marker.add",
      "fork",
    ]);
  });

  it("折叠是纯函数：seq 乱序喂进去结果一致（存储追加语义的等价）", () => {
    const events = canvasDocToEvents(legacyDoc, { canvasId: "c1" });
    const straight = foldCanvas(events);
    const shuffled = foldCanvas([...events].reverse());
    expect(shuffled).toEqual(straight);
    expect(straight.nodes).toHaveLength(3);
    expect(straight.edges).toHaveLength(2);
    expect(straight.markers).toHaveLength(1);
    expect(straight.viewport).toEqual(legacyDoc.viewport);
  });

  it("node.update 按 id 就地合并；node.delete / edge.delete 把它去掉；找不到 id 不凭空造", () => {
    const at = 5;
    const events: CanvasEvent[] = [
      { type: "canvas.open", canvasId: "c", seq: 1, at, owner: "u-alice" },
      { type: "node.create", canvasId: "c", seq: 2, at, node: { id: "n1", data: { text: "旧" } } },
      { type: "node.update", canvasId: "c", seq: 3, at, id: "n1", patch: { position: { x: 9, y: 9 } } },
      { type: "node.update", canvasId: "c", seq: 4, at, id: "没这个", patch: { locked: true } },
      { type: "edge.create", canvasId: "c", seq: 5, at, edge: { id: "e1", source: "n1", target: "n2" } },
      { type: "edge.delete", canvasId: "c", seq: 6, at, id: "e1" },
      { type: "node.delete", canvasId: "c", seq: 7, at, id: "n1" },
    ];
    const state = foldCanvas(events);
    expect(state.nodes).toEqual([]); /* n1 合并后又被删掉 */
    expect(state.edges).toEqual([]);
    expect(state.owner).toBe("u-alice");
    expect(state.revision, "revision 就是最后一个 seq（3.9d 的平移）").toBe(7);
  });

  it("确认位点：省略 = 全部已确认；给了就按给的（且不超过 revision）", () => {
    const events = canvasDocToEvents(legacyDoc, { canvasId: "c" });
    expect(foldCanvas(events).confirmedRevision).toBe(events.length);
    expect(foldCanvas(events, { confirmedRevision: 2 }).confirmedRevision).toBe(2);
    expect(foldCanvas(events, { confirmedRevision: 999 }).confirmedRevision).toBe(events.length);
  });
});

describe("C6 · 3.9d 验收：存量桥接（只读旧写新，重放 diff=0）", () => {
  it("⭐ 老文档 → 事件 → 折叠回来：内容逐字相同（节点/边/标记/视口）", () => {
    const events = canvasDocToEvents(legacyDoc, { canvasId: "c1", owner: "u-alice" });
    /* seq 从 1 连续、数量 = 1（open）+ 3 节点 + 2 边 + 1 标记 */
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const back = canvasEventsToDoc(events, { version: CANVAS_VERSION });
    expect(back.nodes, "节点在往返里变了").toEqual(legacyDoc.nodes);
    expect(back.edges).toEqual(legacyDoc.edges);
    expect(back.markers).toEqual(legacyDoc.markers);
    expect(back.viewport).toEqual(legacyDoc.viewport);
    expect(back.version).toBe(CANVAS_VERSION);
    /* revision 平移为事件序号（原文档的 revision 是它自己的计数，不进这份转换） */
    expect(back.revision).toBe(events.length);
    expect(back.confirmedRevision).toBe(events.length);
  });

  it("空画布也是合法的（只剩一条 canvas.open）—— 不能因为没内容是坏事", () => {
    const events = canvasDocToEvents({ viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [], markers: [] }, { canvasId: "c0" });
    expect(events).toHaveLength(1);
    const back = canvasEventsToDoc(events, { version: CANVAS_VERSION });
    expect(back.nodes).toEqual([]);
    expect(back.markers).toEqual([]);
  });

  it("存量转换不编时间与 actor（老数据里没有这个事实）", () => {
    const events = canvasDocToEvents(legacyDoc, { canvasId: "c1" });
    for (const e of events) {
      expect(e.at).toBe(0);
      expect(e.actor).toBeUndefined();
    }
  });

  it("归属：在画布上（canvas.open 那条），节点不背 owner；缺省是 local", () => {
    const owned = canvasDocToEvents(legacyDoc, { canvasId: "c1", owner: "u-alice" });
    expect(canvasOwner(owned)).toBe("u-alice");
    const plain = canvasDocToEvents(legacyDoc, { canvasId: "c1" });
    expect(canvasOwner(plain)).toBe(DEFAULT_CANVAS_OWNER);
    for (const node of foldCanvas(owned).nodes) {
      expect((node as Record<string, unknown>).owner, "节点身上不该有 owner（归属在画布上）").toBeUndefined();
    }
  });

  it("fork 事件记得它从哪来（分叉的复制本身由那一侧写，见 ADR-009）", () => {
    const events: CanvasEvent[] = [
      { type: "canvas.open", canvasId: "c2", seq: 1, at: 10, owner: "u-bob" },
      { type: "fork", canvasId: "c2", seq: 2, at: 10, source: { canvasId: "c1", revision: 37 } },
    ];
    const state = foldCanvas(events);
    expect(state.canvasId).toBe("c2");
    expect(state.owner).toBe("u-bob");
    expect(state.revision).toBe(2);
  });
});

describe("C6 · 3.9c 验收：画布工具族的 declared surface 与判定", () => {
  it("surface 表：读类 run、写类 ask（create/link/generate 都会改东西/花钱）", () => {
    expect(CANVAS_SURFACE).toEqual({ read: "run", query: "run", create: "ask", link: "ask", generate: "ask" });
  });

  it("⭐ 注册表对账：`canvas_` 前缀的工具都必须在 surface 表里登记", () => {
    const canvasTools = createToolRegistry()
      .list()
      .map((e) => e.name)
      .filter((n) => n.startsWith("canvas_"));
    expect(canvasTools.length, "一个画布工具都没有 —— 这条守卫成了空扫描").toBeGreaterThan(0);
    for (const name of canvasTools) {
      expect(CANVAS_TOOL_OPS[name], `${name} 没在 CANVAS_TOOL_OPS 里登记（会掉进策略表默认只读）`).toBeTruthy();
    }
  });

  it("⭐ 登记过的画布工具，在按需确认档下的判定与 surface 表一致（表与策略不许各说一套）", () => {
    for (const [name, op] of Object.entries(CANVAS_TOOL_OPS)) {
      const verdict = decide("按需确认", name);
      expect(canvasSurfaceVerdict(name), name).toBe(CANVAS_SURFACE[op]);
      expect(verdict === "hide" ? "ask" : verdict, `${name} 的实际判定与 surface 表不一致`).toBe(CANVAS_SURFACE[op]);
    }
  });

  it("没登记的（不是画布工具）→ null，别硬套一张表", () => {
    expect(canvasSurfaceVerdict("read_file")).toBeNull();
  });
});
