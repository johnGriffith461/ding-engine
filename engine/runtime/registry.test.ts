import { describe, expect, it } from "vitest";

import { AGENT_TOOLS } from "../../shared/agentTools";
import { buildToolSet, builtinToolEntries, createToolRegistry, offeredToolNames } from "./registry";

/**
 * 工具注册表的守卫（Phase 1 D5）。
 *
 * ## 为什么要专门盯着"工具没丢"
 *
 * 这不是假想的风险 —— **它真发生过一次**：`list_files` 原来只存在于
 * `electron/ipc/tools.ts` 手抄的那份对象里、不在 `AGENT_TOOLS` 里；
 * 把那段手抄换成"注册表直接吃这张表"之后，这个工具**当场消失**，
 * 而且什么都不报：没有类型错误、没有测试红，只是模型少了一个工具，
 * 用户那边表现为"它忽然不会列文件了"。
 *
 * 所以这里钉三件事：**表里的都在**、**每个名字都能进 ToolSet**、**档位只影响注入不影响存在**。
 */

describe("工具注册表", () => {
  it("⭐ 表里的工具一个不少地出现在注册表里（`list_files` 那次教训的守卫）", () => {
    const registered = new Set(createToolRegistry().list().map((e) => e.name));
    const missing = AGENT_TOOLS.map((t) => t.name).filter((n) => !registered.has(n));
    expect(missing, `这些工具声明了却没进注册表：${missing.join(", ")}`).toEqual([]);
    expect(registered.size).toBe(AGENT_TOOLS.length);
  });

  it("`include` 是子集，不是替换（宿主暴露哪些工具 ≠ 表里有哪些）", () => {
    const only = createToolRegistry({ include: ["read_file", "write_file"] });
    expect(only.list()).toHaveLength(2);
    expect(only.list().map((e) => e.name)).toEqual(["read_file", "write_file"]);
    expect(only.get("memory_save")).toBeUndefined();
  });

  it("每条声明都带来源与 schema（schema 既是给模型的说明、也是执行前那道门）", () => {
    for (const entry of builtinToolEntries()) {
      expect(entry.source, entry.name).toBe("builtin");
      expect(entry.description.length, entry.name).toBeGreaterThan(10);
      expect(entry.inputSchema, entry.name).toBeTruthy();
    }
  });

  it("⭐ 每个登记的工具都能真的变成 ToolSet 里的一项（没有哪种档位会让它凭空消失）", () => {
    const registry = createToolRegistry();
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      const tools = buildToolSet({
        registry,
        mode,
        executor: { run: async () => ({ ok: true }) },
        ctx: { mode, provider: "p" },
      });
      // 三个档位都只影响 `hide`，而现表里没有 `enabled: false` 的工具 → 名字全在
      expect(Object.keys(tools).sort(), mode).toEqual(AGENT_TOOLS.map((t) => t.name).sort());
    }
  });

  it("`offeredToolNames` 与真正下发的 ToolSet 一致（日志里记的就是模型看见的）", () => {
    for (const mode of ["全部允许", "按需确认", "每步确认"] as const) {
      const registry = createToolRegistry();
      const tools = buildToolSet({ registry, mode, executor: { run: async () => ({ ok: true }) }, ctx: { mode, provider: "p" } });
      expect(offeredToolNames(registry, mode).sort(), mode).toEqual(Object.keys(tools).sort());
    }
  });

  it("MCP 的工具是**追加**进来的（同名的以 MCP 那份为准 —— 重连后清单会变）", () => {
    const registry = createToolRegistry({
      extra: [
        { name: "mcp__srv__do", source: "mcp", description: "服务端给的说明", inputSchema: { type: "object" } as never },
        { name: "read_file", source: "mcp", description: "顶掉同名的那个", inputSchema: { type: "object" } as never },
      ],
    });
    expect(registry.get("read_file")?.source).toBe("mcp");
    expect(registry.get("mcp__srv__do")?.description).toBe("服务端给的说明");
    // 覆盖不会让条目重复
    expect(registry.list().filter((e) => e.name === "read_file")).toHaveLength(1);
  });
});

/**
 * 两轴闸门接在**执行点**上（C2，V5-1 3.6c）。
 *
 * 判定层的矩阵在 `engine/core/policy.test.ts` 逐格钉着；这里要挡的是**接线**：
 * `deny` 必须变成"没执行 + 抛出一句人话"（模型看到"失败"并知道别重试），
 * 而**不是**一个 pending（那会让它等一个永远不会成立的批准）。
 */
describe("人轴接在执行点上（C5 之后：deny ≠ ask）", () => {
  const executor = { run: async () => ({ ok: true, output: { ran: true } }) };
  const ctx = { mode: "全部允许" as const, provider: "p" };

  it("⭐ viewer 调写类工具：不执行、抛回注（不是 pending）", async () => {
    let ran = 0;
    const registry = createToolRegistry();
    const tools = buildToolSet({
      registry,
      mode: "全部允许",
      executor: { run: async () => ((ran += 1), { ok: true }) },
      ctx,
      memberRoles: ["viewer"],
    });
    await expect((tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).rejects.toThrow(
      /只读成员/,
    );
    expect(ran, "被拒的调用还是执行了").toBe(0);
  });

  it("viewer 调**只读**工具：照常执行（人轴不该拦只读）", async () => {
    const registry = createToolRegistry();
    const tools = buildToolSet({ registry, mode: "全部允许", executor, ctx, memberRoles: ["viewer"] });
    await expect((tools.read_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).resolves.toBeTruthy();
  });

  it("admin/owner/不给角色（老路径）：写类工具照常执行", async () => {
    for (const memberRoles of [undefined, ["owner"] as const, ["admin"] as const, ["specialist"] as const]) {
      const registry = createToolRegistry();
      const tools = buildToolSet({ registry, mode: "全部允许", executor, ctx, ...(memberRoles ? { memberRoles } : {}) });
      await expect(
        (tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" }),
        `角色 ${memberRoles?.join(",") ?? "(缺省)"} 被拦了`,
      ).resolves.toBeTruthy();
    }
  });

  it("viewer + 按需确认档：写类工具是**拒**（不是等确认），只读工具不拦", async () => {
    const registry = createToolRegistry();
    const tools = buildToolSet({ registry, mode: "按需确认", executor, ctx: { ...ctx, mode: "按需确认" }, memberRoles: ["viewer"] });
    await expect((tools.write_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).rejects.toThrow(/只读成员/);
    await expect((tools.read_file!.execute as (v: unknown) => Promise<unknown>)({ path: "a.md" })).resolves.toBeTruthy();
  });
});
