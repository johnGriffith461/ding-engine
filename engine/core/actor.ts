/**
 * **actor 模型**（C5：是谁写下了这条记录）。
 *
 * ## 为什么单独一个文件
 *
 * 它会被三处同时用到，而三处关心的东西不同：
 *   · 记录形状与读兼容（`./events.ts`）；
 *   · 内核的标注出口（`engine/index.ts`：`request` = 发起人、事件 = 主循环）；
 *   · 存储的查询列与回填（`engine/adapters/sqliteStore.ts` / `sqliteSchema.ts` 的 v3）。
 * 放在 events.ts 里也行 —— 但那个文件顶着"巨石守卫"（900 行）的天花板，
 * 而 actor 的取舍理由（下头这几段）本身就值几十行注释。拆出来两边都舒服。
 *
 * ⚠️ **本文件是纯逻辑**（不 import fs/electron/node:*）：桌面与 CLI 都 import 它。
 *
 * ## 四个 kind 而不是三个（与 V5 §3.2b 草案的偏差，已记进 ADR-006）
 *
 * 草案写的是 `user|agent|system`。实现多一个 `legacy`，理由是**诚实**：
 * actor 维度上线之前的记录，我们**不知道**是谁写的 —— 把它归进 `system`
 * （"机器写的"）是编一个我们并不知道的事实，而 C5 的审计恰恰靠这个字段回答"谁做的"。
 * 草案是草案，实现不为对上草案而编数据。
 */

/** actor 的种类。 */
export type ActorKind = "user" | "agent" | "system" | "legacy";

/** 一个 actor：**身份 id + 种类**（id 在同类里唯一）。 */
export type Actor = {
  /** 谁（同类里唯一的 id；本机单用户阶段是 `local` / `main` / `system`）。 */
  id: string;
  kind: ActorKind;
};

/**
 * 维度上线之前的记录用的（**读旧日志时填**，不写进磁盘 —— 老记录里本来没有这个字段）。
 *
 * ⚠️ "旧日志读回 actor='legacy'" 是 V5 §3.1 兼容矩阵的明文口径：
 * 读路径兼容（填默认值），而不是"迁移时给老行编一个 actor"。
 */
export const LEGACY_ACTOR: Actor = { id: "legacy", kind: "legacy" };

/** 本机用户（单用户阶段；V5-2/3 的成员身份接上来之后会换成真实成员 id）。 */
export const LOCAL_USER: Actor = { id: "local", kind: "user" };

/** 主循环这个 agent（本机版只有一个主 loop；子智能体的名字只在它自己的事件 payload 里）。 */
export const MAIN_AGENT: Actor = { id: "main", kind: "agent" };

/** 宿主自己写的记录（例如"这一轮起不来"那条错误）—— 不是人、也不是模型写的。 */
export const SYSTEM_ACTOR: Actor = { id: "system", kind: "system" };

/**
 * 取一条记录的 actor（**读路径的唯一口径**）。
 *
 * 老记录（没有这个字段）→ `LEGACY_ACTOR`；新记录 → 它自己带的那个。
 * 所有读日志的地方都走它，别各自写 `?? {id:"legacy"}`。
 */
export function actorOf(record: { actor?: Actor } | null | undefined): Actor {
  return record?.actor ?? LEGACY_ACTOR;
}

/**
 * 把落盘回来的值收窄成一个 actor（`parseLogLine` 用它）。
 *
 * 三条口径（ADR-006 第 7 条）：
 *   · 没有这个字段（老记录）→ `LEGACY_ACTOR`（**只在读回来的对象上填，不改磁盘**）；
 *   · 形状不对（手改过 / 被截断）→ 也按 legacy 兜底：**别让它把整行判成坏行** ——
 *     actor 是元数据，缺了它这条记录讲的事仍然成立；
 *   · 正常 → 原样（id 收窄成非空字符串，kind 必须在四种里）。
 */
export function normalizeActor(raw: unknown): Actor {
  if (!raw || typeof raw !== "object") return LEGACY_ACTOR;
  const o = raw as { id?: unknown; kind?: unknown };
  const id = typeof o.id === "string" && o.id.trim() ? o.id : "";
  const kind = o.kind;
  if (!id || (kind !== "user" && kind !== "agent" && kind !== "system" && kind !== "legacy")) {
    return LEGACY_ACTOR;
  }
  return { id, kind };
}
