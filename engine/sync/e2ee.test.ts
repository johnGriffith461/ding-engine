import { describe, expect, it } from "vitest";

import {
  CONTROL_EVENT_TYPES,
  E2EE_ALG,
  isControlEvent,
  newRoomSecret,
  openContent,
  openEvent,
  parseRoomLink,
  roomLink,
  sealContent,
  sealEvent,
  type SealedPayload,
} from "./e2ee";
import { createSyncRelay } from "./relay";

/**
 * E2EE 内容层（V5-2 任务 2.4）。
 *
 * 四条判据（方案的验收 + 两条纪律）：
 *   ① 往返：密封 → 打开，一字不差；算法/IV 每条都不同；
 *   ② **中继零知识**：把密文真推给中继，它那侧（以及它存下来的字节里）
 *      **找不到任何明文**；
 *   ③ **控制事件明文**：审批这类要走明文（中继要据它协调），
 *      而且它**不该带内容正文**（审批流转也不受加密影响）；
 *   ④ 链接：房间号公开、密钥只在 fragment（有人塞进 query = 取不到 = 等于没加密）。
 */

describe("2.4 · 内容加密往返", () => {
  it("⭐ 密封 → 打开：一字不差（含中文、嵌套对象、大一点的内容）", async () => {
    const secret = newRoomSecret("room-1");
    const payload = { text: "把背景换成夜色", nodes: [{ id: "n1", data: { text: "甲" } }], n: 42 };
    const sealed = await sealContent(payload, secret.key);
    expect(sealed.alg).toBe(E2EE_ALG);
    expect(sealed.ct).not.toContain("夜色");
    expect(await openContent(sealed, secret.key)).toEqual(payload);
  });

  it("每条一个随机 IV（复用 IV 是 GCM 的灾难级错误 —— 这里不给调用方犯错的机会）", async () => {
    const secret = newRoomSecret("room-1");
    const a = await sealContent({ x: 1 }, secret.key);
    const b = await sealContent({ x: 1 }, secret.key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("密钥不对 / 密文被改 → **抛**（不返回乱码）：解不出来就该是解不出来", async () => {
    const secret = newRoomSecret("room-1");
    const other = newRoomSecret("room-1");
    const sealed = await sealContent({ x: 1 }, secret.key);
    await expect(openContent(sealed, other.key)).rejects.toBeTruthy();

    /* 改一个字符 → 认证标签失败（也是抛） */
    const tampered: SealedPayload = { ...sealed, ct: `${sealed.ct.slice(0, -2)}${sealed.ct.slice(-2) === "AA" ? "BB" : "AA"}` };
    await expect(openContent(tampered, secret.key)).rejects.toBeTruthy();
  });
});

describe("2.4 · 中继零知识（真推给中继看）", () => {
  it("⭐ 内容事件过中继之后：中继那侧找不到明文（payload 与整条记录里都没有）", async () => {
    const relay = createSyncRelay();
    relay.createStream("room-1");
    const claimed = relay.claim("room-1", "手机");
    const epoch = claimed.ok ? claimed.epoch : 0;

    const secret = newRoomSecret("room-1");
    const content = { type: "text", payload: { text: "机密：预算表在 D 盘" } };
    const sealedOnce = await sealEvent(content, secret.key);
    expect(sealedOnce.sealed).toBe(true);

    const pushed = relay.push("room-1", {
      producerId: "p1",
      epoch,
      events: [{ id: "e-1", seq: 1, type: content.type, payload: sealedOnce.payload }],
    });
    expect(pushed.ok).toBe(true);

    /* 中继"看得见"的全部东西（它存下来的那一条）里，不许出现明文 */
    const pulled = relay.pull("room-1", { from: 0 });
    expect(pulled.ok).toBe(true);
    if (!pulled.ok) return;
    const seenByRelay = JSON.stringify(pulled.events);
    expect(seenByRelay).not.toContain("机密");
    expect(seenByRelay).not.toContain("预算表");
    expect(seenByRelay, "中继连事件类型都看不见就协调不了（类型本来就是公开的）").toContain("text");

    /* 另一端（有密钥）解得回来 */
    const back = await openEvent({ type: pulled.events[0]!.type, payload: pulled.events[0]!.payload }, secret.key);
    expect(back).toEqual(content.payload);
  });
});

describe("2.4 · 控制事件走明文可信层（取舍，不是疏漏）", () => {
  it("审批/接管/邀请/取消都在明文名单里；内容类不在", () => {
    for (const type of CONTROL_EVENT_TYPES) expect(isControlEvent(type), type).toBe(true);
    expect(isControlEvent("text")).toBe(false);
    expect(isControlEvent("node.create")).toBe(false);
    expect(isControlEvent("tool-result")).toBe(false);
  });

  it("⭐ 控制事件**不加密**（中继要据它协调），内容事件**一定加密**", async () => {
    const secret = newRoomSecret("room-1");
    const approval = await sealEvent({ type: "approval", payload: { toolCallId: "c1", approved: true } }, secret.key);
    expect(approval.sealed, "审批被加密了 —— 中继就没法据它协调").toBe(false);
    expect(approval.payload).toEqual({ toolCallId: "c1", approved: true });

    const text = await sealEvent({ type: "text", payload: { text: "机密" } }, secret.key);
    expect(text.sealed).toBe(true);
    expect(JSON.stringify(text.payload)).not.toContain("机密");
  });

  it("⭐ 审批流转**不受加密影响**：明文的审批事件经中继之后一字不变（路由信息还在）", async () => {
    const relay = createSyncRelay();
    relay.createStream("room-1");
    const claimed = relay.claim("room-1", "端-A");
    const epoch = claimed.ok ? claimed.epoch : 0;
    const secret = newRoomSecret("room-1");

    const control = { type: "approval", payload: { toolCallId: "c1", approved: true, approvers: ["alice"] } };
    const wire = await sealEvent(control, secret.key);
    expect(wire.sealed).toBe(false);
    relay.push("room-1", { producerId: "p1", epoch, events: [{ id: "e-1", seq: 1, type: control.type, payload: wire.payload }] });

    const pulled = relay.pull("room-1", { from: 0 });
    if (!pulled.ok) return;
    /* 中继那条记录里，审批的**路由信息**（谁批、待谁批）原样可见 —— 这是协调的原料 */
    const payload = pulled.events[0]!.payload as { approvers?: string[] };
    expect(payload.approvers).toEqual(["alice"]);
    /* 另一端打开：控制事件不过加解密那一道 */
    expect(await openEvent({ type: pulled.events[0]!.type, payload: pulled.events[0]!.payload }, secret.key)).toEqual(
      control.payload,
    );
  });
});

describe("2.4 · 房间链接：房间号公开、密钥只在 fragment", () => {
  it("⭐ 链接形态对得上；解析回得来", () => {
    const secret = newRoomSecret("room-42");
    const link = roomLink("https://relay.example/", secret);
    expect(link.startsWith("https://relay.example/r/room-42#")).toBe(true);
    expect(link.endsWith(secret.key)).toBe(true);
    expect(parseRoomLink(link)).toEqual(secret);
  });

  it("⭐ 密钥塞进 query（`?key=`）取不到 —— query 会进服务端日志，等于没加密", () => {
    const secret = newRoomSecret("room-42");
    expect(parseRoomLink(`https://relay.example/r/room-42?key=${secret.key}`)).toBeNull();
    expect(parseRoomLink("https://relay.example/r/room-42#")).toBeNull();
    expect(parseRoomLink("不是链接")).toBeNull();
  });

  it("`fragment 不发给服务端`这条纪律的机器形态：把链接当请求目标时，服务端那一半不含密钥", () => {
    /*
     * 无需真的发一次请求：URL 语义就写明了这点 ——
     * `url.hash` 是"客户端自己拿着的"，`requestTarget` 才是上网的那一半。
     */
    const secret = newRoomSecret("room-7");
    const link = roomLink("https://relay.example", secret);
    const url = new URL(link);
    const requestTarget = `${url.pathname}${url.search}`; // 真实发出去的那一半（不含 hash）
    expect(requestTarget).not.toContain(secret.key);
    expect(url.hash.slice(1)).toBe(secret.key);
  });
});
