import { can, normalizeRoles, type Capability, type MemberKind, type MemberRole } from "./members";

/**
 * **团队空间**（V5-3 任务 3.1）：成员名册 + 配对码准入（**只读起步**）。
 *
 * ## 一条空间的语义
 *
 * · 空间有**一个 owner**（建空间的那个人；本机版 = 主口令持有者）；
 * · 成员进空间靠**配对码**（邀请即入的轻量形态）：码由 owner/admin 生成，
 *   **限时、一次性**（用过即废 —— 一次邀请一个人）；
 * · 新成员**只读起步**（角色默认 `viewer`）—— 要写、要批，由 owner 事后给角色
 *   （"先让他看得见，再谈给多少权"是最省事的默认，也是最小权限方向的默认）；
 * · 名册与码是**纯数据**（这个文件不碰磁盘；持久化在 `engine/adapters/spaceStore.ts`）。
 *
 * ## 为什么"只读起步"要写成明文
 *
 * U8-1 的三条承诺里第一条就是它（"被邀请者只读起步"）。做成"默认给写权、
 * 事后收回"的话，一次误邀请的代价是真实的写盘/花钱 —— 而"先只读、再放权"
 * 的最坏代价只是他多看了点东西。
 *
 * ## 纯逻辑
 *
 * 不 import fs/electron/node:*（内核边界守卫盯着 `engine/core/**`）。
 */

/** 名册里的一个成员。 */
export type SpaceMember = {
  id: string;
  kind: MemberKind;
  displayName: string;
  roles: MemberRole[];
  /** 什么时候进来的（epoch ms）。 */
  joinedAt: number;
  /** 谁把他请进来的（配对码的创建者；owner 自己进来的那条给空串）。 */
  invitedBy: string;
};

/** 一张配对码。 */
export type PairingCode = {
  /** 码本体（短、易读：见 `newPairingCode`）。 */
  code: string;
  /** 进来之后给什么角色（**默认只读** —— 见文件头）。 */
  roles: MemberRole[];
  /** 谁生成的。 */
  createdBy: string;
  /** 什么时候过期（epoch ms）。 */
  expiresAt: number;
  /** 谁用掉了（用过即废；没用过是 undefined）。 */
  usedBy?: string;
};

/** 空间名册（**纯数据**：宿主负责存取）。 */
export type SpaceRoster = {
  /** 空间主人（成员 id）。 */
  owner: string;
  members: SpaceMember[];
  codes: PairingCode[];
};

/** 配对码的有效期（默认 10 分钟：邀请是"当面/近时"的事，长命码是漏洞）。 */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * 码的字符集：**去掉了容易读错的那几个**（0/O、1/I/l）。
 *
 * 它是给人念/抄的（"你把码报给我"），所以可读性优先于熵 ——
 * 32 个字符 × 8 位 ≈ 40 bit，加上 10 分钟限时与一次性，暴力穷举没有意义。
 */
export const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** 新空间（owner 自己就是第一名成员，角色 owner）。 */
export function createRoster(owner: string, displayName = "本机用户", now = 0): SpaceRoster {
  const id = String(owner ?? "").trim();
  if (!id) throw new Error("空间主人不能是空 id");
  return {
    owner: id,
    members: [{ id, kind: "user", displayName: displayName || id, roles: ["owner"], joinedAt: now, invitedBy: "" }],
    codes: [],
  };
}

/** 名册收窄（磁盘上的东西不可信）。 */
export function normalizeRoster(raw: unknown, fallbackOwner = "local"): SpaceRoster {
  const o = (raw ?? {}) as { owner?: unknown; members?: unknown; codes?: unknown };
  const owner = typeof o.owner === "string" && o.owner.trim() ? o.owner.trim() : fallbackOwner;
  const members: SpaceMember[] = [];
  for (const item of Array.isArray(o.members) ? o.members : []) {
    const m = item as Partial<SpaceMember> | null;
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id || members.some((x) => x.id === id)) continue;
    members.push({
      id,
      kind: m?.kind === "agent" ? "agent" : "user",
      displayName: typeof m?.displayName === "string" && m.displayName.trim() ? m.displayName.trim() : id,
      roles: normalizeRoles(m?.roles),
      joinedAt: typeof m?.joinedAt === "number" && Number.isFinite(m.joinedAt) ? m.joinedAt : 0,
      invitedBy: typeof m?.invitedBy === "string" ? m.invitedBy : "",
    });
  }
  /* 主人必须在名册里且是 owner（坏数据不许把空间弄成无主状态） */
  const boss = members.find((m) => m.id === owner);
  if (!boss) members.unshift({ id: owner, kind: "user", displayName: owner, roles: ["owner"], joinedAt: 0, invitedBy: "" });
  else if (!boss.roles.includes("owner")) boss.roles = ["owner", ...boss.roles];

  const codes: PairingCode[] = [];
  for (const item of Array.isArray(o.codes) ? o.codes : []) {
    const c = item as Partial<PairingCode> | null;
    const code = typeof c?.code === "string" ? c.code.trim() : "";
    if (!code || codes.some((x) => x.code === code)) continue;
    codes.push({
      code,
      roles: normalizeRoles(c?.roles),
      createdBy: typeof c?.createdBy === "string" ? c.createdBy : owner,
      expiresAt: typeof c?.expiresAt === "number" ? c.expiresAt : 0,
      ...(typeof c?.usedBy === "string" && c.usedBy ? { usedBy: c.usedBy } : {}),
    });
  }
  return { owner, members, codes };
}

/** 名册里某人的角色（不在 = null —— **不编**一个默认角色出来）。 */
export function rolesIn(roster: SpaceRoster, memberId: string): MemberRole[] | null {
  return roster.members.find((m) => m.id === memberId)?.roles ?? null;
}

/** 某人在空间里能不能做那件事（人那一侧的能力，见 `members.ts` 的 `CAPABILITIES`）。 */
export function canInSpace(roster: SpaceRoster, memberId: string, capability: Capability): boolean {
  return can(rolesIn(roster, memberId) ?? [], capability);
}

/** 谁在空间里（成员视图：**不带口令** —— 那是服务端的账，不进这一份）。 */
export function memberView(roster: SpaceRoster): SpaceMember[] {
  return [...roster.members];
}

/**
 * 造一张配对码。
 *
 * @param roster 名册
 * @param input.createdBy 谁生成的（**必须**是能管成员的人 —— 校验在这里，不靠调用方记得）
 * @param input.roles 进来给什么角色（缺省 `["viewer"]`：**只读起步**）
 * @param input.now 现在（注入，测试用）
 * @returns 新的码；不合法给 `{ok:false}`
 */
export function newPairingCode(
  roster: SpaceRoster,
  input: { createdBy: string; roles?: readonly MemberRole[]; now?: number; random?: () => number },
): { ok: true; code: PairingCode } | { ok: false; code2: "not-allowed"; message: string } {
  if (!canInSpace(roster, input.createdBy, "manageMembers")) {
    return { ok: false, code2: "not-allowed", message: `${input.createdBy} 不能发配对码（只有所有者/管理员能邀请成员）` };
  }
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  const alphabet = PAIRING_ALPHABET;
  const code = Array.from({ length: 8 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  const roles = normalizeRoles(input.roles ?? ["viewer"]);
  return {
    ok: true,
    code: {
      code,
      roles: roles.length ? roles : ["viewer"],
      createdBy: input.createdBy,
      expiresAt: now + PAIRING_TTL_MS,
    },
  };
}

/** 兑码的结果。 */
export type RedeemResult =
  | { ok: true; roster: SpaceRoster; member: SpaceMember }
  | { ok: false; reason: "unknown" | "expired" | "used" | "already-member"; message: string };

/**
 * **兑一张配对码**（被邀请者那一侧的动作）。
 *
 * 规矩（三条都要对）：
 *   ① 码在名册里、且**没用过**、且**没过期**；
 *   ② 这个人**还不在**名册里（在的话说清"你已经在空间里了"，不重复发名额）；
 *   ③ 进来之后拿的是**码上写的角色**（默认 viewer，只读起步）。
 *
 * ⚠️ 兑码是**一次性**的：成功后那张码标记 `usedBy`（再用一次会拿到 `used`），
 * 而不是"留着还能用" —— 邀请是"一次请一个人"。
 *
 * @param roster 名册
 * @param input.code 码
 * @param input.memberId 谁在兑（成员 id）
 * @param input.displayName 显示名（可选）
 * @param input.now 现在（注入，测试用）
 * @returns 新名册 + 新成员；失败给原因与人话
 */
export function redeemPairingCode(
  roster: SpaceRoster,
  input: { code: string; memberId: string; displayName?: string; now?: number },
): RedeemResult {
  const now = input.now ?? Date.now();
  const wanted = String(input.code ?? "").trim().toUpperCase();
  const memberId = String(input.memberId ?? "").trim();
  if (!memberId) return { ok: false, reason: "unknown", message: "要一个成员 id（你叫什么）" };

  const existing = roster.members.find((m) => m.id === memberId);
  if (existing) {
    return { ok: false, reason: "already-member", message: `${memberId} 已经在空间里了（角色：${existing.roles.join("/") || "无"}）` };
  }

  const index = roster.codes.findIndex((c) => c.code === wanted);
  if (index < 0) return { ok: false, reason: "unknown", message: "这个配对码不认识（让邀请你的人再发一次）" };
  const code = roster.codes[index]!;
  if (code.usedBy) return { ok: false, reason: "used", message: "这张配对码已经用过了（一码一人）" };
  if (code.expiresAt <= now) return { ok: false, reason: "expired", message: "这张配对码过期了（有效期 10 分钟，请对方重新发一张）" };

  const member: SpaceMember = {
    id: memberId,
    kind: "user",
    displayName: String(input.displayName ?? "").trim() || memberId,
    roles: code.roles.length ? [...code.roles] : ["viewer"],
    joinedAt: now,
    invitedBy: code.createdBy,
  };
  const codes = roster.codes.map((c, i) => (i === index ? { ...c, usedBy: memberId } : c));
  return { ok: true, roster: { ...roster, members: [...roster.members, member], codes }, member };
}

/**
 * 改一个成员的角色（**只有能管成员的人能改**；不能改自己 —— 防"自己给自己升权"）。
 *
 * @param roster 名册
 * @param input.by 谁在改
 * @param input.memberId 改谁
 * @param input.roles 新角色
 * @returns 新名册；失败给人话
 */
export function setMemberRoles(
  roster: SpaceRoster,
  input: { by: string; memberId: string; roles: readonly MemberRole[] },
): { ok: true; roster: SpaceRoster } | { ok: false; reason: "not-allowed" | "no-member" | "self"; message: string } {
  if (!canInSpace(roster, input.by, "manageMembers")) {
    return { ok: false, reason: "not-allowed", message: `${input.by} 不能改成员角色（只有所有者/管理员能管成员）` };
  }
  if (input.by === input.memberId) {
    return { ok: false, reason: "self", message: "不能改自己的角色（要改就请另一位管理员来）" };
  }
  const target = roster.members.find((m) => m.id === input.memberId);
  if (!target) return { ok: false, reason: "no-member", message: `名册里没有 ${input.memberId}` };
  if (target.id === roster.owner) return { ok: false, reason: "not-allowed", message: `${target.id} 是空间主人，角色不能被改` };
  const roles = normalizeRoles(input.roles ?? []);
  return {
    ok: true,
    roster: {
      ...roster,
      members: roster.members.map((m) => (m.id === input.memberId ? { ...m, roles: roles.length ? roles : ["viewer"] } : m)),
    },
  };
}

/**
 * 把一个人移出名册（**不让他移主人**）。
 *
 * @param roster 名册
 * @param input.by 谁在移除
 * @param input.memberId 移除谁
 * @returns 新名册；失败给人话
 */
export function removeFromSpace(
  roster: SpaceRoster,
  input: { by: string; memberId: string },
): { ok: true; roster: SpaceRoster } | { ok: false; reason: "not-allowed" | "no-member"; message: string } {
  if (!canInSpace(roster, input.by, "manageMembers")) {
    return { ok: false, reason: "not-allowed", message: `${input.by} 不能移除成员（只有所有者/管理员能管成员）` };
  }
  if (input.memberId === roster.owner) {
    return { ok: false, reason: "not-allowed", message: `${roster.owner} 是空间主人，不能被移除` };
  }
  if (!roster.members.some((m) => m.id === input.memberId)) {
    return { ok: false, reason: "no-member", message: `名册里没有 ${input.memberId}` };
  }
  return { ok: true, roster: { ...roster, members: roster.members.filter((m) => m.id !== input.memberId) } };
}
