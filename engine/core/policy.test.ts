import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIRM_MODES, normalizeConfirmMode } from "@shared/ipc";
import {
  TOOL_POLICY,
  decide,
  decideForMember,
  injectableTools,
  policyOf,
} from "@engine/core/policy";
import { MEMBER_ROLES, type MemberRole } from "@engine/core/members";
import { pendingApprovalNotice } from "@engine/core/notices";
import { pluginToolName } from "@engine/runtime/plugins";
import { AGENT_TOOLS } from "@shared/agentTools";

/**
 * 审批闸门的判定矩阵（§143）。
 *
 * 这一组是整改「全部允许是个装饰」的核心证据：**三个档位 × 三类工具** 的每一种组合
 * 都必须有明确判定，而且"关掉"与"要确认"必须是**两种不同的结果**。
 */
describe("策略表", () => {
  it("三个档位的文案与实机一致（改一个都会让 chip 与本体对不上）", () => {
    expect(CONFIRM_MODES).toEqual(["全部允许", "按需确认", "每步确认"]);
  });

  it("⭐ 未声明的工具默认按**只读**放行（Cline 口径：需要复核的必须显式声明）", () => {
    expect(policyOf("some_new_tool")).toEqual({ kind: "read" });
    expect(decide("按需确认", "some_new_tool")).toBe("run");
  });

  it("⭐ 每个工具的性质都声明了（加工具时别漏 declare —— 漏了就悄悄变成「默认放行」）", () => {
    for (const t of AGENT_TOOLS) {
      expect(TOOL_POLICY[t.name], `${t.name} 没在 TOOL_POLICY 里声明`).toBeTruthy();
    }
    expect(policyOf("memory_save").kind).toBe("write");
    expect(policyOf("memory_list").kind).toBe("read");
    // 定时任务是"会反复自己跑"的东西，必须算写类（按需确认档要拦它）
    expect(policyOf("schedule_create").kind).toBe("write");
    expect(policyOf("schedule_list").kind).toBe("read");
    /*
     * ⭐ 写文件必须是**写**类（2026-10-14 补）。
     *
     * 这是这张表里最"硬"的一条：`memory_save` 写的是本产品自己的记忆库、
     * `canvas_add_node` 改的是画布，而 `write_file` **在用户的文件目录里建/覆盖真文件** ——
     * 覆盖不可逆。写成 read 就等于"按需确认档下不问"，那正是这道闸存在的意义。
     * 上面那圈通用检查只能保证"声明过"，保证不了"声明的对不对"，所以单列一条。
     */
    expect(policyOf("write_file").kind).toBe("write");
    expect(decide("按需确认", "write_file")).toBe("ask");
  });

  /*
   * ⭐ 插件来的工具与 MCP 来的工具，**同一道闸**（2026-10-16，审计 P02）。
   *
   * 这两类都是「别人写的代码，名字之下可能是读也可能是删库」—— 判定必须一致。
   * 原来只有 MCP 那一半被按「写」拦，插件工具掉到"未声明默认只读"，
   * 于同一份风险在这里直接放行。这一条第一次让两种前缀都被检查：
   * 用的名字也是**实现自己那份**（`pluginToolName`），不是在这里手抄前缀 ——
   * 手抄的话前缀一改，判定与注册表就会各说各话。
   */
  it("⭐ 插件工具默认按**写**（与 MCP 同一口径），不是默认放行的只读", () => {
    const name = pluginToolName("demo", "whatever");
    expect(policyOf(name).kind).toBe("write");
    expect(decide("按需确认", name)).toBe("ask");
    // 与 MCP 的判定必须**逐字一致**，不许一严一松
    expect(policyOf(name).kind).toBe(policyOf("mcp__srv__whatever").kind);
    // 但「全部允许」档下照样直跑（那一档的定义就是用户说他都同意）
    expect(decide("全部允许", name)).toBe("run");
  });
});

describe("decide：三档 × 三类工具", () => {
  it("全部允许 —— 读写都直接跑（这是今天的行为，不能改）", () => {
    expect(decide("全部允许", "memory_save")).toBe("run");
    expect(decide("全部允许", "memory_list")).toBe("run");
  });

  it("按需确认 —— 只拦**会改东西的**，只读的照走", () => {
    expect(decide("按需确认", "memory_save")).toBe("ask");
    expect(decide("按需确认", "memory_list")).toBe("run");
  });

  it("每步确认 —— 不管读写都要问", () => {
    expect(decide("每步确认", "memory_save")).toBe("ask");
    expect(decide("每步确认", "memory_list")).toBe("ask");
  });

  it("⭐ 关掉的工具**在任何档位**都是 hide —— 不是被拒，是模型看不到", () => {
    TOOL_POLICY.__test_disabled = { kind: "read", enabled: false };
    try {
      for (const mode of CONFIRM_MODES) {
        expect(decide(mode, "__test_disabled"), mode).toBe("hide");
      }
    } finally {
      delete TOOL_POLICY.__test_disabled;
    }
  });

  it("⭐ ask 与 hide 必须是两种结果（否则「关掉」会退化成「每次都问」）", () => {
    TOOL_POLICY.__gone = { kind: "write", enabled: false };
    try {
      // 同一个档位下：关掉的 → hide（模型看不到）；没关的写入类 → ask（要问）
      expect(decide("每步确认", "__gone")).toBe("hide");
      expect(decide("每步确认", "memory_save")).toBe("ask");
      expect(decide("每步确认", "__gone")).not.toBe(decide("每步确认", "memory_save"));
    } finally {
      delete TOOL_POLICY.__gone;
    }
  });
});

describe("injectableTools：hide 的不进注入列表", () => {
  it("默认（全部允许）下全部注入", () => {
    expect(injectableTools("全部允许", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("⚠️ 被关掉的不在列表里 —— 模型看不到它（区别于「注入了但会被拒」）", () => {
    TOOL_POLICY.__gone = { kind: "write", enabled: false };
    try {
      expect(injectableTools("全部允许", ["memory_save", "__gone"])).toEqual(["memory_save"]);
      expect(injectableTools("每步确认", ["memory_save", "__gone"])).toEqual(["memory_save"]);
    } finally {
      delete TOOL_POLICY.__gone;
    }
  });

  it("保持原顺序", () => {
    expect(injectableTools("按需确认", ["b", "a", "c"])).toEqual(["b", "a", "c"]);
  });
});

describe("normalizeConfirmMode：磁盘上的东西不可信", () => {
  it("合法值原样通过", () => {
    for (const m of CONFIRM_MODES) expect(normalizeConfirmMode(m)).toBe(m);
  });

  it("乱七八糟的值一律回落到**安全默认**「按需确认」（Phase 11.5）", () => {
    /*
     * ⚠️ 回落目标在 Phase 11.5 改了：原来回「全部允许」（= 改造前的行为，向后兼容），
     * 现在回「按需确认」。理由写在 `shared/ipc.ts` 那段注释里：
     * 磁盘上的值是**不可信**的，而"不可信时选哪一侧"就是安全默认的定义 ——
     * 选放开那一侧等于"配置坏掉 = 悄悄全放开"，那是反的。
     */
    for (const bad of [undefined, null, "", "EveryStep", 3, {}, []]) {
      expect(normalizeConfirmMode(bad)).toBe("按需确认");
    }
  });
});

describe("被拦下时回给模型的话", () => {
  it("说清三件事：没执行 / 等谁 / 别再试", () => {
    const msg = pendingApprovalNotice("memory_save", "按需确认");
    expect(msg).toContain("memory_save");
    expect(msg).toContain("按需确认");
    expect(msg).toContain("还没有执行");
    expect(msg).toContain("不要重试");
  });
});

/**
 * 两轴叠加矩阵（C2，V5-1 3.6b / 3.6c；ADR-007 的那张表**逐格**在这里）。
 *
 * 这一组是 C2 的核心证据：**工具档位 × 成员角色**的每一种组合都有明确判定 ——
 * 而且 `deny`（人轴不够）与 `ask`（工具轴要问）必须分得开：
 * 前者"没执行、也不等人批"，后者"等用户点一下"。
 */
describe("两轴矩阵：工具档位 × 成员角色（ADR-007）", () => {
  /** 取一个角色的判定（用一个只读工具与一个写类工具各问一次）。 */
  const verdict = (roles: MemberRole[], mode: Parameters<typeof decide>[0], name: string) =>
    decideForMember({ roles }, mode, name).verdict;

  const READ = "read_file";
  const WRITE = "write_file";
  /**
   * `hide` 那一格要一个**被关掉的工具**。
   *
   * ⚠️ 内置工具目前一个都没有 `enabled:false`（"关掉某个工具"这条能力还没有界面入口），
   * 所以这里**临时**往策略表里塞一条、用完删掉。为什么不用一个真的关掉的工具：
   * 没有 —— 为了测这一格去编一个"默认关着的工具"才是更坏的事（产品里多一个幽灵状态）。
   * 同一文件内的用例是顺序跑的，插完就删，不会漏给别的用例。
   */
  const HIDDEN = "__test_hidden_tool";
  beforeEach(() => {
    TOOL_POLICY[HIDDEN] = { kind: "write", enabled: false };
  });
  afterEach(() => {
    delete TOOL_POLICY[HIDDEN];
  });

  it("⭐ 矩阵逐格：4 角色 × 5 种（hide / 读·写 × run·ask）", () => {
    /* 期望值就照 ADR-007 那张表抄 —— 改判定必须同时改这里，改不动就说明矩阵漂了 */
    const table: Record<MemberRole, { readRun: string; readAsk: string; writeRun: string; writeAsk: string; hidden: string }> = {
      owner: { readRun: "run", readAsk: "ask", writeRun: "run", writeAsk: "ask", hidden: "hide" },
      admin: { readRun: "run", readAsk: "ask", writeRun: "run", writeAsk: "ask", hidden: "hide" },
      specialist: { readRun: "run", readAsk: "ask", writeRun: "run", writeAsk: "ask", hidden: "hide" },
      /* ⭐ 唯一不同的一行：viewer 的写操作在两个档位下都 **deny**（角色是上限） */
      viewer: { readRun: "run", readAsk: "ask", writeRun: "deny", writeAsk: "deny", hidden: "hide" },
    };
    for (const role of MEMBER_ROLES) {
      const want = table[role];
      expect(verdict([role], "全部允许", READ), `${role} × 读×全部允许`).toBe(want.readRun);
      expect(verdict([role], "每步确认", READ), `${role} × 读×每步确认`).toBe(want.readAsk);
      expect(verdict([role], "全部允许", WRITE), `${role} × 写×全部允许`).toBe(want.writeRun);
      expect(verdict([role], "每步确认", WRITE), `${role} × 写×每步确认`).toBe(want.writeAsk);
      expect(verdict([role], "全部允许", HIDDEN), `${role} × hide`).toBe(want.hidden);
    }
  });

  it("⭐ viewer 被拒时带回注人话（说清为什么 + 下一步，模型不该重试）", () => {
    const got = decideForMember({ roles: ["viewer"] }, "全部允许", WRITE);
    expect(got.verdict).toBe("deny");
    if (got.verdict !== "deny") return;
    expect(got.notice).toContain("只读成员");
    expect(got.notice).toContain(WRITE);
    expect(got.notice, "没告诉模型不要重试").toContain("不要重试");
    expect(got.notice, "没告诉模型下一步该找谁").toMatch(/所有者|管理员/);
  });

  it("角色是**并集**：带 admin 的多角色成员照样能写（不至于被 viewer 卡住）", () => {
    expect(verdict(["viewer", "admin"], "全部允许", WRITE)).toBe("run");
    expect(verdict(["viewer", "specialist"], "全部允许", WRITE)).toBe("run");
  });

  it("不知道是谁（本机单用户）= owner：老路径一个字都不变", () => {
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      for (const name of [READ, WRITE]) {
        expect(decideForMember(undefined, mode, name).verdict, `${mode} × ${name}`).toBe(decide(mode, name));
      }
    }
  });

  it("`ask` 与 `deny` 是两回事：ask 的 notice 说「等你确认」，deny 的 notice 说「没执行、别等」", () => {
    const asked = decideForMember({ roles: ["admin"] }, "每步确认", WRITE);
    const denied = decideForMember({ roles: ["viewer"] }, "每步确认", WRITE);
    expect(asked.verdict).toBe("ask");
    expect(denied.verdict).toBe("deny");
    if (denied.verdict === "deny") expect(denied.notice).not.toContain("交给用户确认");
  });
});
