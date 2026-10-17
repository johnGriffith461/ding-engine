import { describe, expect, it } from "vitest";

import { modelIdsFromJson, modelsUrlFor } from "./modelsFetch";

/**
 * 拉取模型清单（2026-10-16）—— 钉两件纯逻辑：**响应怎么解析**与**地址怎么拼**。
 *
 * 网络那半在主进程（`electron/ipc/ai.ts`），不在这里测；这里测的是"拿到响应之后"
 * —— 而那正是各家形状不一样、最容易猜错的地方。
 */
describe("拉取模型清单", () => {
  it("OpenAI 形状：data[].id", () => {
    const got = modelIdsFromJson({ object: "list", data: [{ id: "gpt-4o-mini" }, { id: "o3" }] });
    expect(got).toEqual(["gpt-4o-mini", "o3"]);
  });

  it("中转的两种简化形状：models 是字符串数组 / 对象数组", () => {
    expect(modelIdsFromJson({ models: ["deepseek-chat", "qwen-plus"] })).toEqual(["deepseek-chat", "qwen-plus"]);
    expect(modelIdsFromJson({ models: [{ id: "glm-4" }, { name: "kimi" }] })).toEqual(["glm-4", "kimi"]);
  });

  it("去重 + 排序 + 剔空（重复名字各家都有）", () => {
    expect(modelIdsFromJson({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { id: "  " }] })).toEqual(["a", "b"]);
  });

  it("⭐ 认不出来就返回空数组 —— **不猜**（别拿 baseURL 编一个模型名出来）", () => {
    expect(modelIdsFromJson({ error: { message: "无效的 key" } })).toEqual([]);
    expect(modelIdsFromJson(null)).toEqual([]);
    expect(modelIdsFromJson("不是 JSON 对象")).toEqual([]);
  });

  it("RPC 风格（清单在 result 里）也认", () => {
    expect(modelIdsFromJson({ result: { data: [{ id: "m1" }] } })).toEqual(["m1"]);
  });

  it("地址规整：三种常见填法都要对", () => {
    expect(modelsUrlFor("https://api.x.com")).toBe("https://api.x.com/v1/models");
    expect(modelsUrlFor("https://api.x.com/v1")).toBe("https://api.x.com/v1/models");
    expect(modelsUrlFor("https://api.x.com/v1/chat/completions")).toBe("https://api.x.com/v1/models");
    expect(modelsUrlFor("https://api.x.com/v1/")).toBe("https://api.x.com/v1/models");
  });
});
