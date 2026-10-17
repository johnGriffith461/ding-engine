import type { Protocol } from "../models";
import { anthropic } from "./anthropic";
import { google } from "./google";
import { openaiCompatible } from "./openaiCompatible";
import type { ProtocolAdapter, ModelHandleInput } from "./types";

/**
 * 协议注册表（Phase 5.2）。
 *
 * 顺序无所谓（按 id 查），但**必须覆盖 `Protocol` 的每一个取值** ——
 * 这条由类型保证：`Record<Protocol, ProtocolAdapter>` 少一个就编译不过。
 * 用 Record 而不是数组，就是为了让"加了新协议但忘了登记"变成**编译错误**，
 * 而不是运行时的 `undefined is not a function`。
 */
export const PROTOCOLS: Record<Protocol, ProtocolAdapter> = {
  "openai-compatible": openaiCompatible,
  anthropic,
  google,
};

/** 按协议取 adapter（未登记的协议 → 抛，而不是静默回落到某一家）。 */
export function adapterFor(protocol: Protocol): ProtocolAdapter {
  const adapter = PROTOCOLS[protocol];
  if (!adapter) throw new Error(`没有登记这个协议：${protocol}（见 engine/runtime/protocols/）`);
  return adapter;
}

export type { ProtocolAdapter, ModelHandleInput };
