import { createGoogleGenerativeAI } from "@ai-sdk/google";

import type { ProtocolAdapter } from "./types";

/**
 * **Google Gemini 原生**（Phase 5.2）。
 *
 * Gemini 有 OpenAI 兼容端点，但原生协议多两样我们看得见的东西：
 * 工具调用的 `functionDeclarations` 形态、以及 `safetySettings` ——
 * 后者在"模型莫名其妙不回答"时是唯一能解释原因的开关。
 */
export const google: ProtocolAdapter = {
  id: "google",
  label: "Google Gemini 原生",
  createModel: ({ baseURL, apiKey, model, headers }) =>
    createGoogleGenerativeAI({
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    })(model),
};
