import path from "node:path";
import { kvReadStrict, kvWrite } from "./kvStore";
import { normalizeRoster, type SpaceRoster } from "../core/space";
import { newRoomSecret, type RoomSecret } from "../sync/e2ee";

/**
 * **团队空间的落盘**（V5-3 任务 3.1）：名册 + 配对码 + **成员口令** + 共享清单。
 *
 * ## 为什么口令与服务端账放同一份文件
 *
 * `space.json` 是**服务端自己的账**（谁在空间里、各自的口令、哪些会话共享出去了）——
 * 它不是"给成员看的名册"（那个视图由 `memberView` 产出，**不含口令**）。
 * 口令放这里而不是环境变量，是因为**邀请即入**那条路要服务端**签发**口令
 * （被邀请者不可能预先在服务端配好一把口令）。
 *
 * ⚠️ 口令是明文存的（本机版；与 CLI 向导对 `.credentials.yaml` 的做法一致）——
 * 真要多机部署得换成哈希/密钥库，这条边界如实写在 SAFETY.md 那套口径里。
 *
 * ## 落盘纪律沿用 kvStore
 *
 * 原子写 / 信封 / `DSH_STORE_BACKEND=file` 回落都跟着走，不另长第二份实现。
 */

/** `space.json` 的形状（服务端的账）。 */
export type SpaceFile = {
  roster: SpaceRoster;
  /** 成员 id → 口令（**服务端签发**；不进成员视图）。 */
  tokens: Record<string, string>;
  /** 共享出去、成员可读的会话（V5-3 3.2）。 */
  shared: string[];
  /** 共享出去的模板 id（V5-3 3.7；模板本体在 `recipes.json`，这里只记"哪些共享了"）。 */
  sharedRecipes: string[];
  /**
   * 这段会话当前的**接管人**（V5-3 3.2；fencing 语义：接管之后老持有人在写侧失效）。
   * 键是会话 id，值是成员 id。
   */
  holders: Record<string, string>;
  /** 同步房间的秘密（V5-2 2.4 的房间号 + 密钥；服务端**只该存房间号那一半**）。 */
  rooms: Record<string, { roomId: string }>;
};

/** 读一份空间账的结果（三态，别混成一个 null —— P132 的口径）。 */
export type SpaceRead =
  | { status: "missing" }
  | { status: "ok"; space: SpaceFile }
  | { status: "corrupt"; note: string };

export type SpaceStore = {
  /** 读整份（三态）。 */
  read(): SpaceRead;
  /** 写整份（覆盖式；调用方从 `read()` 拿旧的再改）。 */
  write(space: SpaceFile): void;
  /** 文件路径（诊断/测试用）。 */
  file(): string;
};

/** 空账（还没有建过空间）。 */
export function emptySpaceFile(owner = "local"): SpaceFile {
  return {
    roster: normalizeRoster({}, owner),
    tokens: {},
    shared: [],
    sharedRecipes: [],
    holders: {},
    rooms: {},
  };
}

/**
 * 收窄一份从磁盘读回来的空间账（磁盘不可信）。
 *
 * @param raw 读到的值
 * @param fallbackOwner 名册缺主人时用谁兜底
 * @returns 干净的账
 */
export function normalizeSpaceFile(raw: unknown, fallbackOwner = "local"): SpaceFile {
  const o = (raw ?? {}) as Partial<SpaceFile>;
  const tokens: Record<string, string> = {};
  for (const [id, token] of Object.entries(o.tokens ?? {})) {
    if (typeof token === "string" && token.trim() && id.trim()) tokens[id.trim()] = token;
  }
  const shared = Array.isArray(o.shared) ? [...new Set(o.shared.filter((x): x is string => typeof x === "string" && x.trim() !== ""))] : [];
  const sharedRecipes = Array.isArray(o.sharedRecipes)
    ? [...new Set(o.sharedRecipes.filter((x): x is string => typeof x === "string" && x.trim() !== ""))]
    : [];
  const holders: Record<string, string> = {};
  for (const [sessionId, holder] of Object.entries(o.holders ?? {})) {
    if (typeof holder === "string" && holder.trim() && sessionId.trim()) holders[sessionId.trim()] = holder.trim();
  }
  const rooms: Record<string, { roomId: string }> = {};
  for (const [streamId, room] of Object.entries(o.rooms ?? {})) {
    const roomId = (room as { roomId?: unknown } | null)?.roomId;
    if (typeof roomId === "string" && roomId.trim()) rooms[streamId.trim()] = { roomId: roomId.trim() };
  }
  return { roster: normalizeRoster(o.roster, fallbackOwner), tokens, shared, sharedRecipes, holders, rooms };
}

/**
 * 建一个空间账本。
 *
 * @param dataDir 数据目录
 * @returns 账本
 */
export function createSpaceStore(dataDir: string): SpaceStore {
  const file = path.join(dataDir, "space.json");
  return {
    file: () => file,
    read: () => {
      const got = kvReadStrict(dataDir, file);
      if (got.status === "missing") return { status: "missing" };
      if (got.status === "corrupt") return { status: "corrupt", note: `空间账读不出来（${file}）：当空账用会丢成员与配对码` };
      return { status: "ok", space: normalizeSpaceFile(got.value) };
    },
    write: (space) => kvWrite(dataDir, file, space),
  };
}

/**
 * 给一个成员签一把口令（邀请即入那条路）。
 *
 * ⚠️ 口令**不重复**：与账上已有的任何一把都不同（撞了就是身份串号）。
 * 用 `newRoomSecret` 的随机源（同一条密码学纪律：标准件，不自造）。
 *
 * @param tokens 现有口令表（用来查重）
 * @param random 随机源（测试注入）
 * @returns 新口令
 */
export function issueToken(tokens: Record<string, string>, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const secret = newRoomSecret("member" + random());
    const token = `sk-${secret.key.slice(0, 22)}`;
    if (!Object.values(tokens).includes(token)) return token;
  }
  throw new Error("口令生成连撞 20 次（随机源坏了？）");
}

/** 造一个房间秘密（房间号公开 + 密钥 fragment；这里只要房间号那一半落账）。 */
export function roomOf(streamId: string): RoomSecret {
  const secret = newRoomSecret(streamId);
  return secret;
}
