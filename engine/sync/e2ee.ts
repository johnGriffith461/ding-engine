/**
 * **E2EE 内容层**（V5-2 任务 2.4）：内容事件加密，控制事件走明文可信层。
 *
 * ## 机制（对齐 Excalidraw 的房间号 + 密钥 fragment 模式）
 *
 * ```
 *   https://<中继>/r/<房间号>#<密钥>        ← 房间号公开（中继要用它路由）
 *                            ↑
 *          密钥在 **fragment** 里：按 HTTP 语义，fragment **从不发给服务端**。
 * ```
 *
 * 于是中继"**零知识**"：它看得见"哪个房间、谁在发、发了多少条"，
 * 看不见任何**内容**（payload 是 AES-GCM 密文）。
 *
 * ## 为什么控制事件**必须**明文（这是取舍，不是疏漏）
 *
 * M3 的调研结论：**零知识与审批路由不相容** —— 审批/接管/邀请这类事件，
 * 中继要能**据它做协调**（路由给谁、谁接管了、超时怎么算）。
 * 全加密的话中继就只是个哑管道，协调职责没法履行（而 V5 §4 明写中继承担协调）。
 *
 * 所以分两层：
 *
 * | 层 | 事件 | 中继看得见什么 |
 * |---|---|---|
 * | 内容层（**加密**） | 文本、画布/节点内容、工具参数与结果 | 只有密文与长度 |
 * | 控制层（**明文**） | 审批、接管、邀请、取消 | 事件类型与路由信息（当事人身份） |
 *
 * ⚠️ 明文的控制事件**不要塞内容**（"审批那件事的正文"该走内容层）——
 * 测试里钉着这一条。
 *
 * ## 用什么加密
 *
 * WebCrypto（`globalThis.crypto.subtle`）—— Node 19+ / Electron / Bun 都有，
 * **零依赖**，而且我们不需要自造算法（AES-256-GCM 是标准件，
 * 自己写密码学是本项目明确的红线）。
 */

/** 加密算法（写进密文里，将来换代时读得出来这是哪一代）。 */
export const E2EE_ALG = "A256GCM";

/** 一个房间的秘密：房间号（公开）+ 密钥（只在 fragment 里）。 */
export type RoomSecret = {
  roomId: string;
  /** base64url 的 32 字节密钥。 */
  key: string;
};

/**
 * 控制层的类型（**明文**那一层，见文件头的表）。
 *
 * 加新类型要过一遍"中继需不需要据它协调"这个问题 —— 不需要就该走内容层。
 */
export const CONTROL_EVENT_TYPES = ["approval", "takeover", "invite", "cancel", "claim"] as const;

/** 这个事件类型走明文控制层吗。 */
export function isControlEvent(type: string): boolean {
  return (CONTROL_EVENT_TYPES as readonly string[]).includes(type);
}

/** 密文载荷（中继看得见的就是这个形状）。 */
export type SealedPayload = {
  alg: typeof E2EE_ALG;
  /** 每条一个随机 IV（**绝不复用**：GCM 复用 IV 会要命，见 `sealEvent`）。 */
  iv: string;
  /** 密文（base64url；含 GCM 的认证标签）。 */
  ct: string;
};

/* ────────────────────── base64url ────────────────────── */

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * base64url → 字节。
 *
 * ⚠️ 返回的是**自己那份 ArrayBuffer 上的** Uint8Array（不用 `Buffer` 的视图）：
 * WebCrypto 的 `BufferSource` 要 `ArrayBuffer`，而 Node 的 `Buffer` 视图可能是
 * `ArrayBufferLike`（含 SharedArrayBuffer）—— 直接传会在类型检查那一关就报
 * （两套 tsconfig 里报得还不一样）。拷一份最省事也最稳。
 */
function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

/* ────────────────────── 密钥 ────────────────────── */

/**
 * 造一个房间秘密（随机密钥 + 房间号）。
 *
 * @param roomId 房间号（公开；通常就是同步流的 id）
 * @returns 秘密（密钥那份**只该出现在 fragment 或内存里**，别写日志）
 */
export function newRoomSecret(roomId: string): RoomSecret {
  /* `getRandomValues` 给的就是普通 ArrayBuffer 上的 Uint8Array（见 `fromB64url` 的说明） */
  const key = crypto.getRandomValues(new Uint8Array(32));
  return { roomId, key: b64url(key) };
}

/** 从 base64url 密钥造一个 WebCrypto 密钥（**每次现造**，不缓存句柄：它不可序列化）。 */
async function keyOf(secretB64url: string): Promise<CryptoKey> {
  const bytes = fromB64url(secretB64url);
  if (bytes.length !== 32) throw new Error("房间密钥必须是 32 字节（base64url）");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* ────────────────────── 加解密 ────────────────────── */

/**
 * 把一段内容封成密文。
 *
 * ⚠️ **每条一个随机 IV**：GCM 在同一个密钥下复用 IV 是灾难级错误
 * （两条同 IV 的密文一异或就泄明文）。所以这里**不接 IV 参数** ——
 * 不给调用方犯错的机会。
 *
 * @param payload 内容（会被 JSON 序列化）
 * @param keyB64url 房间密钥
 * @returns 密文载荷（中继看得见的那个形状）
 */
export async function sealContent(payload: unknown, keyB64url: string): Promise<SealedPayload> {
  const key = await keyOf(keyB64url);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { alg: E2EE_ALG, iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

/**
 * 解一条密文。
 *
 * ⚠️ 密钥不对 / 密文被改 → **抛**（GCM 的认证标签会失败），**不返回垃圾**：
 * "解出来是乱码但没报错"会让上层把它当成内容显示出去。
 *
 * @param sealed 密文载荷
 * @param keyB64url 房间密钥
 * @returns 原文
 */
export async function openContent(sealed: SealedPayload, keyB64url: string): Promise<unknown> {
  if (sealed?.alg !== E2EE_ALG) throw new Error(`认不出的加密算法：${String(sealed?.alg)}`);
  const key = await keyOf(keyB64url);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64url(sealed.iv) },
    key,
    fromB64url(sealed.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

/**
 * 按**层**决定一条事件过不过加密（同步发送端用这一个口子）。
 *
 * @param event 事件（类型 + 内容）
 * @param keyB64url 房间密钥
 * @returns 要发出去的载荷与"它是不是密文"
 */
export async function sealEvent(
  event: { type: string; payload: unknown },
  keyB64url: string,
): Promise<{ sealed: boolean; payload: unknown }> {
  if (isControlEvent(event.type)) return { sealed: false, payload: event.payload };
  return { sealed: true, payload: await sealContent(event.payload, keyB64url) };
}

/**
 * 接收端：按层还原一条事件。
 *
 * @param event 收到的事件（类型 + 载荷）
 * @param keyB64url 房间密钥
 * @returns 还原后的内容
 */
export async function openEvent(
  event: { type: string; payload: unknown },
  keyB64url: string,
): Promise<unknown> {
  if (isControlEvent(event.type)) return event.payload;
  return openContent(event.payload as SealedPayload, keyB64url);
}

/* ────────────────────── 链接（房间号公开 + 密钥 fragment） ────────────────────── */

/**
 * 造一条房间链接：**房间号在路径里（会发给服务端）、密钥在 fragment 里（不会）**。
 *
 * @param baseUrl 中继地址（例如 `https://relay.example`）
 * @param secret 房间秘密
 * @returns 链接
 */
export function roomLink(baseUrl: string, secret: RoomSecret): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/r/${encodeURIComponent(secret.roomId)}#${secret.key}`;
}

/**
 * 从一条链接里取出房间号与密钥。
 *
 * ⚠️ 密钥只从 **fragment** 取（`#` 之后）：那是"服务端收不到"的那一半。
 * 有人把密钥放进 query（`?key=`）时**取不到** —— 那是对的：
 * query 会进服务端日志，等于没加密（测试里钉着这条）。
 *
 * @param link 链接
 * @returns 房间秘密；取不到给 null
 */
export function parseRoomLink(link: string): RoomSecret | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const match = /\/r\/([^/]+)$/.exec(url.pathname);
  const roomId = match ? decodeURIComponent(match[1]!) : "";
  const key = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  if (!roomId || !key) return null;
  return { roomId, key };
}
