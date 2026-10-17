/**
 * 「禁止真实模型」这道闸（`DSH_NO_REAL_MODEL`）——**唯一一份判定**。
 *
 * ## 为什么抽出来（2026-10-16，审计 P53）
 *
 * 这道闸原来只长在文本轮里（`loop.ts` 的 `resolveTurnTarget`），于是：
 * **开着「别调远程」仍然真去连了远程域名**（审计实机记账为证）。
 * 图像生成、图像编辑、视频生成与轮询、provider 可用性探测 —— 四条路各写各的
 * `fetch(provider.baseURL…)` / `generateText(…)`，**一处都没有问过这道闸**。
 *
 * 现在：所有远程出口都必须过 `assertRealModelAllowed`（或走 `fetchRemote`），
 * 判定只有这一份。`electron/ipc/modelGate.test.ts` 里有一条**源码守卫**扫
 * `imageGen.ts` / `videoGen.ts` / `aiProbe.ts`，新写的裸 `fetch(` 会被判红。
 *
 * ## 判据是「地址」而不是「哪个 provider」
 *
 * 指向 `127.0.0.1` / `localhost` / `::1` 的（本地假服务、本地推理）照常放行 ——
 * 那正是"不烧钱地测"该走的路。解析不出主机名时**当远程拦掉**：
 * 宁可拦错一次，不要放过一次真花钱的调用。
 */

/** 闸开着时，这个地址算不算"远程"。 */
export function realModelBlocked(url: string): boolean {
  if (!process.env.DSH_NO_REAL_MODEL?.trim()) return false;
  return !isLoopbackUrl(url);
}

/** 地址是不是指向本机（解析不出来 → 当作不是）。 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** 拒掉时那句给人看的话（文本轮与图像/视频/探测说同一句，用户不用学两遍）。 */
export function blockedReason(what: string, url: string): string {
  return `DSH_NO_REAL_MODEL 已设置：拒绝调用远程地址（${what} → ${url}）。只有指向本机的任务才允许跑。`;
}

/**
 * 要发远程请求之前调它。
 *
 * @param what 这次是什么事（「生成图片」「探测 provider」…，进错误文案）
 * @param url 目标地址
 * @throws 闸开着且目标不是本机时抛一个带人话的 Error
 */
export function assertRealModelAllowed(what: string, url: string): void {
  if (realModelBlocked(url)) throw new Error(blockedReason(what, url));
}

/**
 * 过闸的 `fetch`：**electron 主进程里碰远程一律走它**。
 *
 * 用法与 `fetch` 一致；差别只是先问这道闸。被拦下时**返回被拒的 Promise**
 * （而不是同步抛）—— 跟 `fetch` 的约定一致，调用方一律 `await`/`.catch` 就行。
 */
export async function fetchRemote(url: string, what: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
  assertRealModelAllowed(what, url);
  return fetch(url, init);
}
