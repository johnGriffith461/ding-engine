import { describe, expect, it } from "vitest";

import {
  canInSpace,
  createRoster,
  memberView,
  newPairingCode,
  PAIRING_ALPHABET,
  PAIRING_TTL_MS,
  redeemPairingCode,
  removeFromSpace,
  rolesIn,
  setMemberRoles,
  type SpaceRoster,
} from "./space";
import { MEMBER_ROLES } from "./members";

/**
 * 团队空间（V5-3 任务 3.1）：名册 + 配对码（邀请即入的轻量形态）。
 *
 * 判据对着 U8-1 写：**被邀请者只读起步**、一码一人、限时、只有能管成员的人能发码，
 * 以及三条不许发生的事（自己给自己升权、改主人、把主人移出去）。
 */

const T = 1_700_000_000_000;
const roster = () => createRoster("local", "本机用户", T);

/** 固定随机源（码可预测 —— 测试才这么干）。 */
const seq = (values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe("3.1 · 名册", () => {
  it("新空间：主人是第一名成员、角色 owner（成员视图里**不含口令**）", () => {
    const got = roster();
    expect(got.owner).toBe("local");
    expect(got.members).toEqual([expect.objectContaining({ id: "local", roles: ["owner"] })]);
    /* 成员视图是名册成员本身（口令根本不在名册里 —— 那是 `spaceStore` 的账） */
    expect(memberView(got)).toHaveLength(1);
  });

  it("角色查询：不在名册里给 null（**不编**默认角色）；能力查得到", () => {
    const got = roster();
    expect(rolesIn(got, "alice")).toBeNull();
    expect(canInSpace(got, "local", "manageMembers")).toBe(true);
    expect(canInSpace(got, "alice", "manageMembers")).toBe(false);
  });

  it("空主人 id 直接拒（空间不能无主）", () => {
    expect(() => createRoster("   ")).toThrow(/不能是空/);
  });
});

describe("3.1 · 配对码（邀请即入）", () => {
  it("⭐ 码的形态：8 位、字符集去掉了容易读错的 0/O/1/I/l、10 分钟到期", () => {
    const made = newPairingCode(roster(), { createdBy: "local", now: T, random: seq([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.code.code).toHaveLength(8);
    for (const ch of made.code.code) expect(PAIRING_ALPHABET).toContain(ch);
    expect(made.code.code).not.toMatch(/[01OIl]/);
    expect(made.code.expiresAt).toBe(T + PAIRING_TTL_MS);
    /* **只读起步**：默认角色就是 viewer */
    expect(made.code.roles).toEqual(["viewer"]);
  });

  it("只有能管成员的人能发码（viewer 不行）", () => {
    let space: SpaceRoster = roster();
    const invited = newPairingCode(space, { createdBy: "local", now: T, random: seq([0.5]) });
    if (!invited.ok) throw new Error("发码失败");
    space = { ...space, codes: [invited.code] };
    const joined = redeemPairingCode(space, { code: invited.code.code, memberId: "alice", now: T });
    if (!joined.ok) throw new Error("入团失败");
    space = joined.roster;

    const byViewer = newPairingCode(space, { createdBy: "alice", now: T, random: seq([0.5]) });
    expect(byViewer.ok).toBe(false);
    if (!byViewer.ok) expect(byViewer.code2).toBe("not-allowed");
  });

  it("⭐ 兑码：只读起步（viewer）；一码一人（用过即废）；过期/陌生码给人话", () => {
    let space = roster();
    const made = newPairingCode(space, { createdBy: "local", now: T, random: seq([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) });
    if (!made.ok) throw new Error("发码失败");
    space = { ...space, codes: [made.code] };
    const code = made.code.code;

    const alice = redeemPairingCode(space, { code, memberId: "alice", displayName: "Alice", now: T + 1000 });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;
    expect(alice.member.roles, "被邀请者不是只读起步").toEqual(["viewer"]);
    expect(alice.member.invitedBy).toBe("local");
    space = alice.roster;

    /* 一码一人：bob 拿同一张码 → used */
    const bob = redeemPairingCode(space, { code, memberId: "bob", now: T + 2000 });
    expect(bob.ok).toBe(false);
    if (!bob.ok) expect(bob.reason).toBe("used");

    /* 已经在空间里的人再兑 → 说清"你已经在里面了" */
    const again = redeemPairingCode(space, { code, memberId: "alice", now: T + 2000 });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("already-member");

    /* 过期 */
    const late = redeemPairingCode(
      { ...space, codes: [{ ...space.codes[0]!, usedBy: undefined, expiresAt: T + 10 }] } as SpaceRoster,
      { code, memberId: "carol", now: T + 20 },
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("expired");

    /* 陌生码（含小写/空格都要能对得上：兑码时大写化 + trim） */
    const lower = redeemPairingCode(space, { code: ` ${code.toLowerCase()} `, memberId: "carol", now: T });
    expect(lower.ok).toBe(false);
    if (!lower.ok) expect(lower.reason).toBe("used"); /* 码认出来了（大小写不敏感），只是被用过 */
  });

  it("发码可以指定角色（owner 直接给 admin）；指定空角色落回 viewer（只读起步是兜底）", () => {
    const withAdmin = newPairingCode(roster(), { createdBy: "local", roles: ["admin"], now: T, random: seq([0.5]) });
    if (!withAdmin.ok) throw new Error("发码失败");
    expect(withAdmin.code.roles).toEqual(["admin"]);
    const blank = newPairingCode(roster(), { createdBy: "local", roles: [], now: T, random: seq([0.5]) });
    if (!blank.ok) throw new Error("发码失败");
    expect(blank.code.roles).toEqual(["viewer"]);
  });
});

describe("3.1 · 成员管理（三条不许发生的事）", () => {
  /** 一个已入团的空间（alice=viewer，bob=admin）。 */
  function spaceWith(): SpaceRoster {
    let space = roster();
    const a = newPairingCode(space, { createdBy: "local", roles: ["viewer"], now: T, random: seq([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) });
    const b = newPairingCode(space, { createdBy: "local", roles: ["admin"], now: T, random: seq([0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]) });
    if (!a.ok || !b.ok) throw new Error("发码失败");
    space = { ...space, codes: [a.code, b.code] };
    const ra = redeemPairingCode(space, { code: a.code.code, memberId: "alice", now: T });
    if (!ra.ok) throw new Error("入团失败");
    const rb = redeemPairingCode(ra.roster, { code: b.code.code, memberId: "bob", now: T });
    if (!rb.ok) throw new Error("入团失败");
    return rb.roster;
  }

  it("改角色：admin 能改；**不能改自己**；不能改主人；viewer 不能改别人", () => {
    const space = spaceWith();
    expect(setMemberRoles(space, { by: "bob", memberId: "alice", roles: ["specialist"] }).ok).toBe(true);
    const self = setMemberRoles(space, { by: "bob", memberId: "bob", roles: ["owner"] });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.reason).toBe("self");
    const boss = setMemberRoles(space, { by: "bob", memberId: "local", roles: ["viewer"] });
    expect(boss.ok).toBe(false);
    if (!boss.ok) expect(boss.reason).toBe("not-allowed");
    const byViewer = setMemberRoles(space, { by: "alice", memberId: "alice", roles: ["admin"] });
    expect(byViewer.ok).toBe(false);
  });

  it("角色必须是那四个里的；给了空/坏值落回 viewer（不编角色）", () => {
    const space = spaceWith();
    const got = setMemberRoles(space, { by: "bob", memberId: "alice", roles: ["宇宙级"] as never });
    expect(got.ok).toBe(true);
    if (got.ok) expect(rolesIn(got.roster, "alice")).toEqual(["viewer"]);
    for (const role of MEMBER_ROLES) {
      const one = setMemberRoles(space, { by: "bob", memberId: "alice", roles: [role] });
      expect(one.ok).toBe(true);
    }
  });

  it("移除成员：能管成员的人能移；**移不了主人**；不在名册给 no-member", () => {
    const space = spaceWith();
    const gone = removeFromSpace(space, { by: "bob", memberId: "alice" });
    expect(gone.ok).toBe(true);
    if (gone.ok) expect(rolesIn(gone.roster, "alice")).toBeNull();
    const boss = removeFromSpace(space, { by: "bob", memberId: "local" });
    expect(boss.ok).toBe(false);
    const nobody = removeFromSpace(space, { by: "bob", memberId: "carol" });
    expect(nobody.ok).toBe(false);
    if (!nobody.ok) expect(nobody.reason).toBe("no-member");
  });
});
