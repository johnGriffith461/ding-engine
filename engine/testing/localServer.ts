/**
 * 测试用的本地服务：**绑一个真的连得上的回环端口**。
 *
 * ## 为什么要共用一份（2026-10-16）
 *
 * 这台机器上实测过一件事：短时间内反复 bind/close 回环端口时，会出现一段
 * **"这批端口连不上"的窗口** —— 端口绑得上，但从同一个进程里连它一直不返回
 * （黑洞，不是拒绝）。`listen(0)` 拿到这样的端口，测试就会以
 * `connect ETIMEDOUT 127.0.0.1:<port>` 收场 —— 看起来像产品坏了，其实是环境。
 *
 * 这跟"评测偶发红"是同一件事，当时的修法在 `engine/eval/fakeProvider.ts` 里
 * （`listenReachablePort`：绑完自己发一次 HTTP 自检，不通就换端口重绑）。
 * 但 `modelGate.test.ts` / `team.test.ts` 这些**自己绑服务器**的测试还各写各的，
 * 于是同一台机器上、同一时刻，一边绿一边红。
 *
 * 现在把那份知识收在这里一份：谁都用它绑，别各自再抄一遍。
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 绑一个**连得上**的回环端口。
 *
 * 判据是"连得上"而不是"绑得上"：绑完自己发一次 GET `/__self-check`，
 * 回的**不是 404/501**（说明服务器真的在处理请求）才算数；不通就换端口重绑。
 *
 * @param server 已经建好的 server（还没 listen）
 * @param attempts 最多试几个端口（默认 8；每次失败约 600ms）
 * @returns 真正可用的端口号
 */
/**
 * 自检请求用的路径。
 *
 * ⚠️ 谁在数"自己的服务器收到了几个请求"（比如"拦下时一个字节都不发"那条），
 * **要跳过这个路径** —— 那是装置自己的探针，不是业务请求。测试里数错它就会假红。
 */
export const SELF_CHECK_PATH = "/__self-check";

export async function listenReachable(server: Server, attempts = 8): Promise<number> {
  const probe = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: SELF_CHECK_PATH, method: "GET", agent: false, timeout: 600 },
        (res) => {
          res.resume();
          res.on("end", () => resolve(true));
          res.on("error", () => resolve(false));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    if (await probe(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(
    "连着试了 " + attempts + " 个回环端口都连不上 —— 这台机器的回环当时有一段是不通的（环境问题，重跑通常就好）",
  );
}

/**
 * 建一个"什么都不做"的假服务：任何请求都回 200 空响应。
 *
 * @returns server（还没 listen；用 `listenReachable(server)` 拿端口）
 */
export function createIdleServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
}
