import { describe, expect, it } from "vitest";
import { assembleSystem } from "@engine/core/assembly";

/**
 * C2-4：系统提示词的装配（**一份实现，两条路共用**）。
 *
 * ## 为什么这些断言必须存在
 *
 * "这一轮给模型的 system 由哪几块拼成"原来写在**两条路各自的代码里**，
 * 于是聊天侧压根没有记忆与人设（实测：工作台问得出"我怎么称呼你"，聊天问不出）。
 * 收成一份之后，**顺序与空块处理必须被钉住** ——
 * 它是最容易被"顺手调个顺序"而没有任何测试会红的地方。
 */

describe("assembleSystem", () => {
  it("按 base → persona → memory → abilities → extra 的顺序拼，双换行分隔", () => {
    const out = assembleSystem({ base: "任务要求", persona: "人设", memory: "记忆", abilities: "能力", extra: "补充" });
    expect(out).toBe("任务要求\n\n人设\n\n记忆\n\n能力\n\n补充");
  });

  it("⭐ 空块/空白块直接跳过，不留空段（否则 system 里会出现连续空行）", () => {
    expect(assembleSystem({ base: "任务", memory: "   ", abilities: "能力" })).toBe("任务\n\n能力");
    expect(assembleSystem({ base: "任务", persona: "", abilities: undefined })).toBe("任务");
  });

  it("一块都没有时给空串（调用方据此可以干脆不发 system）", () => {
    expect(assembleSystem({})).toBe("");
    expect(assembleSystem({ base: "  ", persona: "\n" })).toBe("");
  });

  it("⭐ 各块两端空白被去掉（块自己带着换行时不会与分隔符叠出空行）", () => {
    expect(assembleSystem({ base: "\n任务\n", memory: " 记忆 \n" })).toBe("任务\n\n记忆");
  });

  it("只给一块时不产生分隔符（单块是最常见的情形：起标题、翻译这类）", () => {
    expect(assembleSystem({ base: "只这一块" })).toBe("只这一块");
  });
});
