import path from "node:path";
import { kvReadStrict, kvWrite } from "./kvStore";
import type { CursorState } from "../sync/cursor";

/**
 * **同步游标的账本**（V5-2 任务 2.6）：把每段会话的游标（`chunk` 里那几个数字）
 * 落到本地库，进程重启后接着用。
 *
 * ## 为什么走 `kvStore` 而不是自己写文件
 *
 * 那 14 个 store 的落盘纪律（原子写 / 信封 / 只读旧写新 / 跨机器可读）已经收进
 * `./kvStore.ts` 一份了 —— 游标是**同一种东西**（一小块可丢可重建的本地状态），
 * 没有理由再长第二份实现。键用的是"原来那个文件路径"（`<数据目录>/sync-cursors.json`），
 * 与其余 store 同形：`DSH_STORE_BACKEND=file` 的回落路径也自动跟着走。
 *
 * ## 三种读状态都如实回报（P132 的口径）
 *
 * 「没有」（第一次用）与「坏了」（文件被手改）**不是一回事**：前者是正常起步，
 * 后者要让人知道（坏了就当没有 = 静默丢一次续传进度，那正是这一层要防的）。
 */

/** 账本里的形状（一个会话一条）。 */
type Journal = { cursors: Record<string, CursorState> };

/** 读一条的结果：三种状态，别混成一个 null。 */
export type CursorRead =
  | { status: "missing" }
  | { status: "ok"; cursor: CursorState }
  | { status: "corrupt"; note: string };

export type CursorJournal = {
  /**
   * 读一段会话的游标。
   *
   * @param streamId 流 id（本机版 = 会话 id）
   */
  load(streamId: string): CursorRead;
  /** 写一条（覆盖式；只动这一条，别的不受影响）。 */
  save(cursor: CursorState): void;
  /** 全部游标（诊断/界面用）。 */
  all(): CursorState[];
};

/**
 * 建一个游标账本。
 *
 * @param dataDir 数据目录（与其余 store 同一个根）
 * @returns 账本
 */
export function createCursorJournal(dataDir: string): CursorJournal {
  const file = path.join(dataDir, "sync-cursors.json");

  /** 读整本账（坏/没有都给空 + 说明）。 */
  function readJournal(): { cursors: Record<string, CursorState>; corrupt?: string } {
    const got = kvReadStrict(dataDir, file);
    if (got.status === "missing") return { cursors: {} };
    if (got.status === "corrupt") return { cursors: {}, corrupt: `同步游标文件读不出来（${file}）：当空账用，下一次推进会覆盖它` };
    /*
     * ⚠️ **形状不对也算坏**（不只是"JSON 解析不了"）：手改过 / 别的程序写过同一个键 ——
     * 那种东西当"没有"会让续传进度静默丢掉，而这正是这一层要防的事。
     */
    const raw = got.value as Journal | null;
    const cursors = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw.cursors as unknown) : undefined;
    if (!cursors || typeof cursors !== "object" || Array.isArray(cursors)) {
      return { cursors: {}, corrupt: `同步游标文件形状不对（${file}）：当空账用，下一次推进会覆盖它` };
    }
    return { cursors: cursors as Record<string, CursorState> };
  }

  return {
    load: (streamId) => {
      const { cursors, corrupt } = readJournal();
      if (corrupt) return { status: "corrupt", note: corrupt };
      const cursor = cursors[streamId];
      if (!cursor) return { status: "missing" };
      return { status: "ok", cursor };
    },

    save: (cursor) => {
      /* 读-改-写：只覆盖这一条（别的会话的游标不受影响） */
      const { cursors } = readJournal();
      cursors[cursor.streamId] = cursor;
      kvWrite(dataDir, file, { cursors } satisfies Journal);
    },

    all: () => Object.values(readJournal().cursors),
  };
}
