import { describe, expect, it } from "vitest";

import { AGENT_SPECS, agentNames, agentRoster, findAgent, resolveAgentMode } from "./agents";
import { AGENT_TOOLS } from "../../shared/agentTools";
import { CONFIRM_MODES, type ConfirmMode } from "../../shared/ipc";

/**
 * agent 定义数据化（Phase 7.1）。
 *
 * ## 这组断言挡的是什么
 *
 * "再加一个专家"现在只是加一条声明 —— 而**声明写错不会报错**：
 * 白名单里写了个不存在的工具名（那位专家就少一个工具，没人会发现）、
 * 名字重复（`findAgent` 取到哪一条取决于顺序）、
 * 或者某个 agent 声明了更松的档位（**绕过用户的审批设置**）。
 * 这三类都不报错、只在运行期表现为"怪怪的"，所以在这里钉死。
 */

describe("AgentSpec 表的自洽", () => {
  it("名字唯一且非空（`findAgent` 按名字取，重复会让结果取决于顺序）", () => {
    const names = agentNames();
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_-]*$/);
  });

  it("⭐ 工具白名单里的名字**都真的存在**（写错一个名字 = 那位专家少一个工具，没人会喊）", () => {
    const known = new Set(AGENT_TOOLS.map((t) => t.name));
    for (const spec of AGENT_SPECS) {
      for (const name of spec.tools ?? []) {
        expect(known.has(name), `${spec.name} 的白名单里有不存在的工具：${name}`).toBe(true);
      }
    }
  });

  it("每个 agent 都说明了自己是干什么的（coordinator 挑人就看这句）", () => {
    for (const spec of AGENT_SPECS) {
      expect(spec.description.length, `${spec.name} 的说明太短`).toBeGreaterThan(10);
      expect(spec.systemPrompt.length, `${spec.name} 没有系统提示`).toBeGreaterThan(20);
      expect(spec.maxSteps).toBeGreaterThan(0);
    }
  });

  it("⭐ 研究员的工具集里**没有**写工具（职责隔离，不是靠提示词劝）", () => {
    const researcher = findAgent("researcher")!;
    expect(researcher.tools).toBeDefined();
    for (const forbidden of ["write_file", "edit_file", "run_command"]) {
      expect(researcher.tools).not.toContain(forbidden);
    }
  });

  it("名单文本给 coordinator 看时只有名字与说明（不泄露 maxSteps 这种内部参数）", () => {
    const roster = agentRoster();
    expect(roster).toContain("researcher");
    expect(roster).not.toContain("maxSteps");
    expect(roster).not.toContain("systemPrompt");
  });
});

describe("档位只能更严，不能更松", () => {
  it("⭐ agent 没声明档位 → 用调用方（用户的）", () => {
    for (const mode of CONFIRM_MODES) expect(resolveAgentMode(mode)).toBe(mode);
  });

  it("⭐ agent 声明了更松的档位 → **不生效**（否则等于某个专家悄悄绕过用户的审批）", () => {
    expect(resolveAgentMode("每步确认", "全部允许")).toBe("每步确认");
    expect(resolveAgentMode("按需确认", "全部允许")).toBe("按需确认");
  });

  it("agent 声明了更严的档位 → 生效", () => {
    expect(resolveAgentMode("全部允许", "每步确认")).toBe("每步确认");
    expect(resolveAgentMode("按需确认", "每步确认")).toBe("每步确认");
  });

  it("三档之间两两都成立（不是只对某两个组合对）", () => {
    const rank: Record<ConfirmMode, number> = { 全部允许: 0, 按需确认: 1, 每步确认: 2 };
    for (const caller of CONFIRM_MODES) {
      for (const agent of CONFIRM_MODES) {
        expect(rank[resolveAgentMode(caller, agent)], `${caller} + ${agent}`).toBe(Math.max(rank[caller], rank[agent]));
      }
    }
  });
});
