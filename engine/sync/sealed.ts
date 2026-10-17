import { CONTROL_EVENT_TYPES, openContent, sealContent, type SealedPayload } from "./e2ee";
import type { SyncPayload } from "./merge";

/**
 * **同步内容层的加密**（V5-2 2.4 真正用起来的那一步；ADR-0018）。
 *
 * ## 分工（与 ADR-0014 的原则一致）
 *
 * | 哪一类记录 | 怎么走 | 为什么 |
 * |---|---|---|
 * | 内容（`request` / `text` / `tool-call` / `tool-result` / `done` / `error` / `delegation`） | **封起来** | 那是用户的东西，中继不该看见 |
 * | 控制（`approval` / `approval-grant`，以及 `e2ee.CONTROL_EVENT_TYPES` 里那几个外来的类型） | **明文** | 审批与接管要能被**路由**——零知识与"让云端帮你路由审批"天生不相容（M3 的结论，ADR-0014 记着） |
 *
 * ## 为什么在这里判"哪一类"
 *
 * 判断只有一处（`isSealedRecord`），两端都问它 —— 各写一份的话，
 * "一端封了、另一端按明文读"这种错会表现为"另一端少了一段历史"（最难查的形状）。
 */

export type SyncFrame = { id: string; type: "record"; payload: SyncPayload | { sealed: SealedPayload } };

/** 这条记录该封吗（控制类走明文，其余封起来）。 */
export function isSealedRecord(type: string): boolean {
  return !(CONTROL_EVENT_TYPES as readonly string[]).includes(type) && type !== "approval" && type !== "approval-grant";
}

/**
 * 把一条帧**按需要封起来**（明文帧原样返回 —— 调用方不必分支）。
 *
 * @param frame `frameOf` 出来的明文帧
 * @param key 房间密钥（不给 = 明文房间，与从前一字不差）
 */
export async function sealFrame(frame: SyncFrame, key: string | undefined): Promise<SyncFrame> {
  if (!key) return frame;
  const record = (frame.payload as SyncPayload).record as { type?: string } | undefined;
  const type = typeof record?.type === "string" ? record.type : "";
  if (!isSealedRecord(type)) return frame;
  const sealed = await sealContent(frame.payload, key);
  /* ⚠️ 帧 **id 不变**（它是按明文内容算的）：两端与中转站都按它去重，而它掺了密钥见不得光 */
  return { id: frame.id, type: "record", payload: { sealed } };
}

/**
 * 把拉回来的一页**按需要打开**（明文帧原样过）。
 *
 * @param frames 中继给的帧
 * @param key 房间密钥（不给时遇到密文帧会**如实报错**，不静默丢）
 */
export async function openFrame(
  frame: { id?: string; type: string; payload: unknown },
  key: string | undefined,
): Promise<{ id: string; type: string; payload: SyncPayload }> {
  const payload = frame.payload as { sealed?: SealedPayload } | null | undefined;
  const sealed = payload?.sealed;
  if (!sealed) return { id: String(frame.id ?? ""), type: frame.type, payload: frame.payload as SyncPayload };
  if (!key) {
    throw new Error(
      `这一条是加密的，但这次同步没给房间密钥（--key）——不给就**打不开**：加密房间里两端必须都持有密钥`,
    );
  }
  const opened = (await openContent(sealed, key)) as SyncPayload;
  return { id: String(frame.id ?? ""), type: frame.type, payload: opened };
}
