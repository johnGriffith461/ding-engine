import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { ProtocolAdapter } from "./types";

/**
 * **OpenAI 兼容**协议（我们最常用的一种：官方直连、中转站、本地推理都走它）。
 *
 * ⚠️ `name` 传的是**协议名**而不是 provider id：它只进日志与遥测的标签，
 * 用协议名才不会因为"换了个中转站"而让同一份记录看起来是两回事。
 */
export const openaiCompatible: ProtocolAdapter = {
  id: "openai-compatible",
  label: "OpenAI 兼容",
  createModel: ({ baseURL, apiKey, model, headers }) =>
    createOpenAICompatible({
      name: "openai-compatible",
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    })(model),
};
