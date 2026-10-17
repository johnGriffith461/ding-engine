/**
 * **成员-角色模型**（C2，V5-1 任务 3.6a）。
 *
 * ## 它是什么
 *
 * 一份**数据**（不是一串 if）：who 是成员（`id` / `kind` / `displayName`）、
 * 谁有哪些角色（`roles`）、每种角色能做什么（`CAPABILITIES`）。
 * 权限判定在 `./policy.ts` 的 `decideForMember`（工具轴 × 人轴的叠加矩阵，见 ADR-007）。
 *
 * ## 两轴的分工（ADR-007 的落点）
 *
 * · **工具轴**（`ConfirmMode`：全部允许 / 按需确认 / 每步确认）= 用户对**这个模型**的放手程度
 *   （"我信它多少"）；
 * · **人轴**（`MemberRole`）= 这个**人**在这台机器/这个空间里的身份（"他是谁"）。
 *
 * 叠加规则一句话：**角色是上限，档位是旋钮** —— 档位只能在角色允许的范围内收紧或放松，
 * 越不过角色那道墙（viewer 的写操作无论在哪个档位都拒）。
 *
 * ## 本文件是纯逻辑
 *
 * 不 import fs/electron/node:*（内核边界守卫盯着 `engine/core/**` 不许出现 node:*）。
 * **持久化不在这一轮**：成员目录写进库/文件、身份从 token 解析（V5-2 的成员 token）
 * 都还没有客户；现在造一张没人读写的表就是脚手架（ADR-007 的 open follow-ups 记着）。
 */

/** 成员的种类：人，或 agent（DeepSeek-Bot 的 main bot / specialist 是同一件事的另一种说法）。 */
export const MEMBER_KINDS = ["user", "agent"] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

/**
 * 角色最小集（V5 §3.6 的"owner/admin/specialist/viewer"）。
 *
 * ⚠️ **specialist 与 admin 在工具上是同权的**（都能写）。区别在"人"那一侧的能力
 * （见 `CAPABILITIES`）：specialist **不管成员**。本轮**不编**更细的工具分层 ——
 * 没有"工具 → 专业方向"的映射，把 specialist 编得窄一点只是凭空发明规则
 * （ADR-007 的"明确不做"里有这一条）。
 */
export const MEMBER_ROLES = ["owner", "admin", "specialist", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** 角色给人的名字（界面/人话里用这一份，别各写各的）。 */
export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: "所有者",
  admin: "管理员",
  specialist: "专家",
  viewer: "只读成员",
};

/** 一个成员。 */
export type Member = {
  /** 身份 id（同类里唯一；本机用户是 `local`）。 */
  id: string;
  kind: MemberKind;
  /** 给人看的名字（界面顶部那块用它）。 */
  displayName: string;
  /** 角色（可以有多个；空数组 = 最弱，同 viewer —— 见 `rolesOf` 的兜底）。 */
  roles: MemberRole[];
  /** 什么时候进来的（epoch ms）。 */
  createdAt: number;
};

/**
 * 本机那个用户（单用户阶段的默认成员）。
 *
 * ⚠️ `createdAt: 0` 是刻意的：它不是"某天创建的"，而是**这个维度的起点**。
 * 编一个时间戳等于伪造一条我们并不知道的事实。
 */
export const LOCAL_MEMBER: Member = {
  id: "local",
  kind: "user",
  displayName: "本机用户",
  roles: ["owner"],
  createdAt: 0,
};

/** 一种"这个角色能不能做这件事"的能力（人轴那一侧，不含工具）。 */
export type Capability = "manageMembers";

/**
 * 角色 → 能力表（**唯一一份**）。
 *
 * ⚠️ 本轮只列 `manageMembers`（邀请/移除/改角色）。审批裁决权（"谁能批"）
 * 是 V5-1 3.7 的活（ADR-008 会把它作为审批人集合的一部分定下来）——
 * 这里先不写，免得两处各说一套。`viewer` 连成员列表里的操作都做不了。
 */
export const CAPABILITIES: Record<MemberRole, readonly Capability[]> = {
  owner: ["manageMembers"],
  admin: ["manageMembers"],
  specialist: [],
  viewer: [],
};

/** 这个角色能不能做那件事（**任一**角色有就算有 —— 角色是并集）。 */
export function can(roles: readonly MemberRole[], capability: Capability): boolean {
  return roles.some((role) => CAPABILITIES[role].includes(capability));
}

/** 收窄一个角色值（磁盘/请求里来的都不可信）。 */
export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/** 收窄一组成员角色：认识的留下、去重、按 `MEMBER_ROLES` 的顺序（判定与展示都稳定）。 */
export function normalizeRoles(raw: unknown): MemberRole[] {
  if (!Array.isArray(raw)) return [];
  const got = new Set(raw.filter(isMemberRole));
  return MEMBER_ROLES.filter((role) => got.has(role));
}

/**
 * 取一个成员的**生效角色**。
 *
 * 空角色 = 最弱（`viewer`）—— 这是**最小权限**的方向：身份在、但还没被授予任何东西时，
 * 默认不该拿到写权。⚠️ 与"**未知**成员（查不到这个人）"是两回事：
 * 那种情况由调用方决定（本机单用户阶段 = owner，见 `decideForMember` 的说明）。
 */
export function rolesOf(member: { roles?: readonly MemberRole[] | null } | undefined): MemberRole[] {
  const roles = normalizeRoles(member?.roles);
  return roles.length ? roles : ["viewer"];
}

/**
 * 成员目录（**纯内存**的一小本账：加/查/改角色）。
 *
 * 为什么现在就有它：没有它，"成员模型"只是一堆类型 —— 而类型不能回答
 * "这个人现在是什么角色"。目录让判定层有**数据**可问（测试与将来的宿主都用它），
 * 又不假装持久化已经存在（见文件头）。
 */
export type MemberDirectory = {
  /** 全部成员（按加入顺序）。 */
  list(): Member[];
  /** 按 id 查（没有就是 undefined —— **不编一个默认成员出来**）。 */
  get(id: string): Member | undefined;
  /** 加入一个成员（已有同 id 就更新显示名与角色；`id` 空串拒绝）。 */
  upsert(member: Omit<Member, "createdAt"> & { createdAt?: number }): Member;
  /** 改角色（成员不在就什么都不做，返回 false）。 */
  setRoles(id: string, roles: readonly MemberRole[]): boolean;
  /** 移除（不在返回 false）。 */
  remove(id: string): boolean;
};

/**
 * 建一本成员目录。
 *
 * @param initial 初始成员（默认给本机用户 —— 单用户阶段目录里本来就该有他）
 * @returns 目录
 */
export function createMemberDirectory(initial: readonly Member[] = [LOCAL_MEMBER]): MemberDirectory {
  const byId = new Map<string, Member>();
  for (const member of initial) byId.set(member.id, { ...member, roles: normalizeRoles(member.roles) });

  return {
    list: () => [...byId.values()],
    get: (id) => byId.get(id),
    upsert: (member) => {
      const id = String(member.id ?? "").trim();
      if (!id) throw new Error("成员 id 不能为空");
      const previous = byId.get(id);
      const next: Member = {
        id,
        kind: MEMBER_KINDS.includes(member.kind) ? member.kind : "user",
        displayName: String(member.displayName ?? "").trim() || id,
        roles: normalizeRoles(member.roles),
        createdAt: member.createdAt ?? previous?.createdAt ?? Date.now(),
      };
      byId.set(id, next);
      return next;
    },
    setRoles: (id, roles) => {
      const member = byId.get(id);
      if (!member) return false;
      byId.set(id, { ...member, roles: normalizeRoles(roles) });
      return true;
    },
    remove: (id) => byId.delete(id),
  };
}
