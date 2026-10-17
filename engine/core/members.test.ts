import { describe, expect, it } from "vitest";

import {
  can,
  createMemberDirectory,
  isMemberRole,
  LOCAL_MEMBER,
  MEMBER_ROLES,
  normalizeRoles,
  rolesOf,
  ROLE_LABEL,
  type Member,
} from "./members";

/**
 * 成员-角色模型（C2，V5-1 3.6a）。
 *
 * 这些断言要挡住的是"模型看起来在、其实是散文"：角色集合是**枚举**、
 * 能力表是**数据**、目录能被问"这个人现在是什么角色"。
 * 两轴叠加的判定在 `policy.test.ts`（那张矩阵逐格有断言）。
 */

describe("成员模型（C2 · 3.6a）", () => {
  it("角色最小集就是那四个，每个都有给人看的名字（界面不另写一套）", () => {
    expect(MEMBER_ROLES).toEqual(["owner", "admin", "specialist", "viewer"]);
    for (const role of MEMBER_ROLES) {
      expect(ROLE_LABEL[role]?.trim().length, `角色 ${role} 没有说话的名字`).toBeGreaterThan(0);
    }
  });

  it("角色值收窄：认识的留下、去重、按枚举顺序（判定与展示都稳定）", () => {
    expect(normalizeRoles(["viewer", "owner", "viewer"])).toEqual(["owner", "viewer"]);
    expect(normalizeRoles(["不是角色", 7, null])).toEqual([]);
    expect(normalizeRoles("owner")).toEqual([]); // 不是数组：一律空（别把单个字符串当数组）
    expect(isMemberRole("admin")).toBe(true);
    expect(isMemberRole("Admin")).toBe(false);
  });

  it("⭐ 空角色 = 最弱（viewer）：身份在、但还没被授予任何东西时不给写权", () => {
    expect(rolesOf({ roles: [] })).toEqual(["viewer"]);
    expect(rolesOf(undefined)).toEqual(["viewer"]);
    expect(rolesOf({ roles: ["specialist"] })).toEqual(["specialist"]);
  });

  it("能力表：只有 owner/admin 管成员；viewer/specialist 都不行（角色是并集）", () => {
    expect(can(["owner"], "manageMembers")).toBe(true);
    expect(can(["admin"], "manageMembers")).toBe(true);
    expect(can(["specialist"], "manageMembers")).toBe(false);
    expect(can(["viewer"], "manageMembers")).toBe(false);
    /* 多角色取并集：带 admin 的人在别的角色之外照样能管成员 */
    expect(can(["viewer", "admin"], "manageMembers")).toBe(true);
  });

  it("本机用户 = owner（单用户阶段的默认成员；createdAt 是 0 —— 不编一个创建时间）", () => {
    expect(LOCAL_MEMBER.roles).toEqual(["owner"]);
    expect(LOCAL_MEMBER.createdAt).toBe(0);
  });
});

describe("成员目录（纯内存那一小本账）", () => {
  const alice: Omit<Member, "createdAt"> = { id: "u-alice", kind: "user", displayName: "Alice", roles: ["admin"] };

  it("默认目录里有本机用户；加一个成员之后按 id 查得到", () => {
    const dir = createMemberDirectory();
    expect(dir.list().map((m) => m.id)).toEqual(["local"]);
    dir.upsert(alice);
    expect(dir.get("u-alice")).toMatchObject({ displayName: "Alice", roles: ["admin"], kind: "user" });
  });

  it("upsert 是就地更新：改显示名与角色不动 createdAt（加入时间不会被刷）", () => {
    const dir = createMemberDirectory([]);
    const first = dir.upsert({ ...alice, createdAt: 1000 });
    const again = dir.upsert({ ...alice, displayName: "Alice 改过名", roles: ["viewer"] });
    expect(again.createdAt, "改角色把加入时间刷了").toBe(1000);
    expect(dir.list()).toHaveLength(1);
    expect(dir.get("u-alice")?.displayName).toBe("Alice 改过名");
    expect(dir.get("u-alice")?.roles).toEqual(["viewer"]);
    expect(first.createdAt).toBe(1000);
  });

  it("upsert 收窄不可信输入：坏 kind 按 user、空显示名用 id 兜底、角色收窄", () => {
    const dir = createMemberDirectory([]);
    const got = dir.upsert({ id: "bot-1", kind: "机器人" as never, displayName: "   ", roles: ["不是角色"] as never });
    expect(got.kind).toBe("user");
    expect(got.displayName).toBe("bot-1");
    expect(got.roles).toEqual([]);
  });

  it("空 id 直接拒绝（成员没有 id 就没法被引用）", () => {
    const dir = createMemberDirectory([]);
    expect(() => dir.upsert({ id: "  ", kind: "user", displayName: "x", roles: [] })).toThrow(/id/);
  });

  it("setRoles / remove：成员不在时如实返回 false（不凭空造一个）", () => {
    const dir = createMemberDirectory([]);
    expect(dir.setRoles("没这个人", ["owner"])).toBe(false);
    expect(dir.remove("没这个人")).toBe(false);
    dir.upsert(alice);
    expect(dir.setRoles("u-alice", ["owner", "viewer"])).toBe(true);
    expect(dir.get("u-alice")?.roles).toEqual(["owner", "viewer"]);
    expect(dir.remove("u-alice")).toBe(true);
    expect(dir.get("u-alice")).toBeUndefined();
  });
});
