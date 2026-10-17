import { describe, expect, it } from "vitest";

import { PROTOCOLS, adapterFor } from "./index";
import type { Protocol } from "../models";

/**
 * 协议适配层（Phase 5.2）。
 *
 * ## 这组断言挡的是什么
 *
 * 协议分层之后，"加一家 provider"变成加一条配置 —— 而配置写错（协议名拼错、
 * 忘了登记 adapter）**不会在编译期报错**，只会在用户真发一次请求时
 * 以 `undefined is not a function` 的形式炸。
 * 所以这里把"每个协议都有 adapter""未知协议要抛而不是静默回落"钉住。
 */

const ALL: Protocol[] = ["openai-compatible", "anthropic", "google"];

describe("协议注册表", () => {
  it("⭐ 每种协议都登记了 adapter（少一个就编译不过，这条是给运行时再兜一层）", () => {
    for (const p of ALL) {
      expect(PROTOCOLS[p], `${p} 没有 adapter`).toBeTruthy();
      expect(PROTOCOLS[p].id).toBe(p);
      expect(PROTOCOLS[p].label.length, `${p} 没有给人看的名字`).toBeGreaterThan(1);
    }
  });

  it("⭐ 未知协议**抛**，不许静默回落到某一家", () => {
    // 静默回落最坏：用户以为在调 Anthropic，实际发去了 OpenAI 格式的地址，
    // 报错会指向完全无关的地方（"密钥无效"）。
    expect(() => adapterFor("不存在的协议" as Protocol)).toThrow(/没有登记这个协议/);
  });

  it("每个 adapter 都能建出一个模型句柄（不发请求：建句柄是纯装配）", () => {
    for (const p of ALL) {
      const model = adapterFor(p).createModel({ baseURL: "https://example.com/v1", apiKey: "k", model: "m" });
      expect(model, `${p} 没建出模型句柄`).toBeTruthy();
      // AI SDK 的 LanguageModel 是个带这些字段的对象/函数 —— 断言它至少不是 undefined
      expect(typeof model).not.toBe("undefined");
    }
  });

  it("没有密钥也建得出来（「有没有密钥」是上层的事，不是装配的事）", () => {
    const model = adapterFor("openai-compatible").createModel({ baseURL: "https://example.com/v1", model: "m" });
    expect(model).toBeTruthy();
  });

  it("额外请求头能传下去（中转站常要求自带来源标识）", () => {
    const model = adapterFor("openai-compatible").createModel({
      baseURL: "https://example.com/v1",
      apiKey: "k",
      model: "m",
      headers: { "HTTP-Referer": "https://example.com", "X-Title": "Ding Harness" },
    });
    // 句柄本身不暴露 headers，但**建得出来**这一点必须成立（传错类型会当场抛）
    expect(model).toBeTruthy();
  });
});
