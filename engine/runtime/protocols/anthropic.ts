import { createAnthropic } from "@ai-sdk/anthropic";

import type { ProtocolAdapter } from "./types";

/**
 * **Anthropic 原生 Messages API**（Phase 5.2）。
 *
 * ## 为什么值得单独一个协议（而不是继续用 OpenAI 兼容）
 *
 * Anthropic 的 OpenAI 兼容层**丢东西**，最要紧的是 **prompt caching**：
 * 原生协议用 `cache_control` 显式标注"这一段可缓存"，而兼容层不做这件事。
 * 在长系统提示词 + 长历史的场景里，这一项直接决定每轮的钱
 * （缓存命中与未命中的输入价差一个数量级）。
 *
 * ⚠️ 缓存控制**怎么开**属于"这一轮的请求怎么组装"，是 Phase 6 PoC 要评估的第一项
 * （`providerOptions` 的可控性）。这个 adapter 只负责"把话说对"（协议正确），
 * 不负责"替调用方开缓存" —— 那是一个产品决定，该由上层显式给出。
 */
export const anthropic: ProtocolAdapter = {
  id: "anthropic",
  label: "Anthropic 原生",
  createModel: ({ baseURL, apiKey, model, headers }) =>
    createAnthropic({
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    })(model),
};
