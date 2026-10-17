import type { LanguageModel } from "ai";

import type { Protocol } from "../models";

/**
 * **协议适配层**（Phase 5.2）。
 *
 * ## 它解决什么
 *
 * 换代之前，"怎么调模型"这件事只有一种写法，而且是**写死在主循环里**的：
 * `createOpenAICompatible({ baseURL, apiKey })`。于是：
 * - 想接 Anthropic 的原生 Messages API（可控 prompt caching）→ 要改主循环；
 * - 想接 Gemini 原生 → 又改一次；
 * - 每次改都在**同一个函数**里加分支，而那个函数还管着事件流、用量、健康记账。
 *
 * 现在：主循环只说"给我一个模型句柄"，**协议的事在这个目录里**。
 * 加一家新 provider = 加一条 provider 配置（协议已经是现成的）；
 * 加一种**新协议** = 加一个 adapter 文件，主循环一行不动。
 *
 * ## 契约（Phase 6 的硬约束就落在这里）
 *
 * adapter 只负责**产出一个 AI SDK 的 `LanguageModel`**；把流翻成 `TurnEvent`
 * 仍然是主循环那一份（`engine/runtime/loop.ts`）。所以：
 *
 * > 换 SDK、换协议，`TurnEvent` 与 `engine/ports` 的契约都不变。
 *
 * 宿主、CLI、验收快照因此**零感知** —— 这是"换代不搬家"能不能成立的关键。
 */

/** 建模型句柄要什么。 */
export type ModelHandleInput = {
  /** 这一家实际说话的地址（provider 表给的，可能被环境变量覆盖过）。 */
  baseURL: string;
  /** 密钥（已解析；没有就不传）。 */
  apiKey?: string;
  /** 模型名。 */
  model: string;
  /**
   * 额外请求头。
   *
   * 存在的理由很具体：**中转站**（relay）常要求自带的头（来源标识、路由），
   * 而各家 SDK 都支持 `headers` —— 与其为每个中转站写一个协议，不如把它当配置。
   */
  headers?: Record<string, string>;
};

/** 一个协议适配器。 */
export type ProtocolAdapter = {
  id: Protocol;
  /** 给人看的一句话（CLI `ding models` 与报错里用）。 */
  label: string;
  /** 建模型句柄。 */
  createModel(input: ModelHandleInput): LanguageModel;
};
