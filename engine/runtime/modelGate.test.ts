import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { SELF_CHECK_PATH, listenReachable } from "../testing/localServer";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertRealModelAllowed, blockedReason, fetchRemote, isLoopbackUrl, realModelBlocked } from "./modelGate";

/**
 * 「禁止真实模型」这道闸（2026-10-16，审计 P53）。
 *
 * ## 这条守卫要挡住的是什么
 *
 * 审计实机证明过：**开着「别调远程」仍然真去连了远程域名**（出网记账为证）——
 * 闸只长在文本轮里，图像生成 / 图像编辑 / 视频生成与轮询 / provider 探测
 * 四条路各写各的 `fetch(provider.baseURL…)`，一处都没问过这道闸。
 *
 * 这份测试两层：
 *   ① 闸本体的行为（本机放行、远程拦下、解析不出主机名也拦下）；
 *   ② **源码守卫**：那三个文件里不许再出现裸 `fetch(` / `http.request(` ——
 *      新写的远程调用没走闸，这里立刻红。
 */

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((_req, res) => res.end("ok"));
  /*
   * ⚠️ 用共用的 `listenReachable`（2026-10-16）：这台机器的回环偶尔会有一段"绑得上但连不上"，
   * 那时这一组测试会以 `connect ETIMEDOUT 127.0.0.1:…` 收场 —— 看着像产品坏了，其实是环境。
   * 判据是"连得上"而不是"绑得上"（同一件事在 `fakeProvider` 里已经栽过一次）。
   */
  origin = `http://127.0.0.1:${await listenReachable(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** 临时改开关跑一段（异步也等它跑完再恢复 —— 否则恢复比断言先到）。 */
const withGate = async <T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> => {
  const prev = process.env.DSH_NO_REAL_MODEL;
  if (value === undefined) delete process.env.DSH_NO_REAL_MODEL;
  else process.env.DSH_NO_REAL_MODEL = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DSH_NO_REAL_MODEL;
    else process.env.DSH_NO_REAL_MODEL = prev;
  }
};

describe("modelGate（闸本体）", () => {
  it("闸没开：远程地址也放行（正常跑）", async () => {
    await withGate(undefined, () => {
      expect(realModelBlocked("https://api.example.com/v1")).toBe(false);
    });
  });

  it("⭐ 闸开着：远程拦下、本机放行", async () => {
    await withGate("1", () => {
      expect(realModelBlocked("https://api.example.com/v1")).toBe(true);
      expect(realModelBlocked("http://127.0.0.1:1234/v1")).toBe(false);
      expect(realModelBlocked("http://localhost:1234/v1")).toBe(false);
      expect(realModelBlocked("http://[::1]:1234/v1")).toBe(false);
    });
  });

  it("⭐ 解析不出主机名时**当远程拦掉**（宁可拦错一次，不放过一次真花钱的调用）", async () => {
    await withGate("1", () => {
      expect(realModelBlocked("这不是一个 URL")).toBe(true);
      expect(realModelBlocked("")).toBe(true);
    });
  });

  it("拒绝的话是把真因说清的人话（含开关名与目标地址）", () => {
    const text = blockedReason("生成图片", "https://api.example.com/v1");
    expect(text).toContain("DSH_NO_REAL_MODEL");
    expect(text).toContain("生成图片");
    expect(text).toContain("api.example.com");
  });

  it("assertRealModelAllowed：拦下时抛，放行时不抛", async () => {
    await withGate("1", () => {
      expect(() => assertRealModelAllowed("探测 provider", "https://api.example.com")).toThrow(/DSH_NO_REAL_MODEL/);
      expect(() => assertRealModelAllowed("探测 provider", origin)).not.toThrow();
    });
  });

  it("⭐ fetchRemote：拦下时**一个字节都不发**；放行时才真的请求", async () => {
    let hits = 0;
    const counter = createServer((req, res) => {
      /*
       * ⚠️ 自检请求不算：`listenReachable` 会先探一下这个端口通不通，
       * 那是**装置**发的，不是被测的那条路。数进去的话"一个字节都不发"会自动变成 2。
       */
      if (req.url === SELF_CHECK_PATH) {
        res.end("ok");
        return;
      }
      hits += 1;
      res.end("ok");
    });
    const local = `http://127.0.0.1:${await listenReachable(counter)}`;
    try {
      await withGate("1", async () => {
        /* 远程：抛在发送之前（连不上才有 ECONNREFUSED；这里是我们的闸） */
        await expect(fetchRemote("https://api.example.com/x", "测试")).rejects.toThrow(/DSH_NO_REAL_MODEL/);
        /* 本机：照常发 */
        const res = await fetchRemote(local, "测试");
        expect(await res.text()).toBe("ok");
        expect(hits).toBe(1);
      });
    } finally {
      await new Promise<void>((resolve) => counter.close(() => resolve()));
    }
  });

  it("isLoopbackUrl 的小事：大小写与端口都认", () => {
    expect(isLoopbackUrl("http://LOCALHOST:9/x")).toBe(true);
    expect(isLoopbackUrl("https://10.0.0.1/x")).toBe(false);
  });
});

/**
 * ⭐ 源码守卫：**碰远程的三个文件里不许有绕过闸的网络调用**。
 *
 * 判据（故意改坏就会红）：把任何一处 `fetchRemote(` 换回裸 `fetch(`，
 * 或者新写一个 `http.request(`，这里立刻失败。
 */
describe("源码守卫：图像/视频/探测必须走闸", () => {
  const files = ["imageGen.ts", "videoGen.ts", "aiProbe.ts"].map((name) =>
    path.resolve(process.cwd(), "electron/ipc", name),
  );

  it("三个文件里没有裸 fetch( / http.request(（只许 fetchRemote 与 net.fetch(file://)）", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of text.matchAll(/([A-Za-z.]*)fetch\(/g)) {
        const prefix = match[1] ?? "";
        if (prefix.endsWith("Remote")) continue; // 过闸的
        if (prefix === "net.") continue; // Electron 本机 file:// 读，不出网
        offenders.push(`${path.basename(file)}：${prefix}fetch(`);
      }
      for (const match of text.matchAll(/(https?)\.request\(/g)) {
        offenders.push(`${path.basename(file)}：${match[1]}.request(`);
      }
    }
    expect(offenders, "这些远程调用绕开了 DSH_NO_REAL_MODEL 闸").toEqual([]);
  });

  it("provider 探测那条路显式问了闸（它的调用走 SDK，不经过 fetchRemote）", () => {
    const text = readFileSync(path.resolve(process.cwd(), "electron/ipc/aiProbe.ts"), "utf8");
    expect(text).toContain("realModelBlocked(");
    expect(text).toContain("blockedReason(");
  });
});
