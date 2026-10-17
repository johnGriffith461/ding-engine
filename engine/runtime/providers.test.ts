import { describe, expect, it, afterEach } from "vitest";

import type { Protocol } from "./models";
import { allProviders, getProvider, protocolOf } from "./providers";

/**
 * provider 表（Phase 5.2 之后：数量开始涨，协议成为一等字段）。
 *
 * ## 为什么这几条必须有
 *
 * provider 表是"加一家 provider = 加一条配置"这个承诺的落点。配置写错
 * （协议拼错、模型清单空、id 重复）不会在编译期报错 —— 只会在用户发请求时
 * 以奇怪的方式失败。所以这里把三件事钉住：**协议合法**、**id 不重复**、
 * **模型清单非空且可被环境变量覆盖**。
 */

const ALL: Protocol[] = ["openai-compatible", "anthropic", "google"];

afterEach(() => {
  delete process.env.ANTHROPIC_MODELS;
  delete process.env.OPENAI_MODELS;
});

describe("provider 表", () => {
  it("⭐ 每家都声明了合法协议（协议是必填的一等字段，不是可选注释）", () => {
    for (const p of allProviders()) {
      expect(ALL, `${p.id} 的协议`).toContain(p.protocol);
    }
  });

  it("id 不重复，且每家的模型清单非空", () => {
    const ids = allProviders().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of allProviders()) {
      expect(p.models.length, `${p.id} 没有任何模型`).toBeGreaterThan(0);
      expect(p.baseURL, `${p.id} 没有地址`).toMatch(/^https?:\/\//);
    }
  });

  it("⭐ 协议分层之后新增的三家走**原生协议**（这是 Phase 5.2 的实义）", () => {
    expect(getProvider("anthropic")?.protocol).toBe("anthropic");
    expect(getProvider("google")?.protocol).toBe("google");
    // OpenAI 官方端点本身就是 OpenAI 协议 —— 别为了"看起来分层"硬造一个协议
    expect(getProvider("openai")?.protocol).toBe("openai-compatible");
  });

  it("中转站一律按 OpenAI 兼容处理（它把别家的模型用 OpenAI 格式转出来）", () => {
    for (const id of ["tokenrhythm", "apihub", "qianwen", "openrouter", "strata"]) {
      expect(getProvider(id)?.protocol, id).toBe("openai-compatible");
    }
  });

  it("模型清单可用 `<PROVIDER>_MODELS` 覆盖（模型名会变，而它是配置不是数据）", () => {
    expect(getProvider("anthropic")?.models).toContain("claude-sonnet-4-5");
    process.env.ANTHROPIC_MODELS = "claude-sonnet-5 , claude-opus-5";
    const got = getProvider("anthropic")?.models;
    expect(got).toEqual(["claude-sonnet-5", "claude-opus-5"]);
  });

  it("覆盖成空串时**不生效**（否则用户手滑一下就没模型可用了）", () => {
    process.env.OPENAI_MODELS = "   ";
    expect(getProvider("openai")?.models.length).toBeGreaterThan(0);
  });

  it("protocolOf：不认识的 provider 按 OpenAI 兼容（别把请求发歪）", () => {
    expect(protocolOf("anthropic")).toBe("anthropic");
    expect(protocolOf("没有这家")).toBe("openai-compatible");
  });
});
