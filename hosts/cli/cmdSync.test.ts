import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { createSyncRelay } from "../../engine/sync/relay";
import { chatSessionId, type LogInput } from "../../engine/core/events";
import { boot, cleanupDirs, stopEverything } from "../server/testKit";
import { syncSession } from "./cmdSync";

/**
 * **`ding sync`：两端同步的产品客户端**（V5-2 的那半；ADR-0017）。
 *
 * 这一组用的是**真服务**（`ding serve` 那一套：真中继 + 真 token + 真 HTTP 路由），
 * 客户端走 `fetch` —— 所以它验的是"两台设备真的能通过一台服务同步同一段会话"：
 *   ① 本机把记录推上去、另一台（另一个数据目录）拉下来并合并；
 *   ② 反向也通，两端**记录内容一致**；
 *   ③ **再同步一次两边都不多一条**（幂等：内容寻址 id 认得出"这条我有了"）；
 *   ④ 本地没有这段会话时**不猜归属**（要么 `--owner`，要么拒绝）。
 */

afterEach(async () => {
  await stopEverything();
});

const tmp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dh-cli-sync-"));
  cleanupDirs.push(dir);
  return dir;
};

describe("ding sync（同步客户端）", () => {
  it("⭐ 两台设备经一台服务同步同一段会话：推/拉/合并都对，再同步一次不多一条", async () => {
    const { port, token } = await boot({ relay: createSyncRelay() });
    const sid = chatSessionId("cli-sync");
    const dirA = tmp();
    const dirB = tmp();

    /* 两端各自先有一段历史 */
    const a = createSqliteSessionStore(dirA);
    await a.append(sid, [
      { requestId: "r1", type: "request", provider: "strata", model: "m", messages: [{ role: "user", content: "A 说的" }] },
      { requestId: "r1", type: "text", text: "A 答的" },
    ] as LogInput[]);
    a.close();
    const b = createSqliteSessionStore(dirB);
    await b.append(sid, [
      { requestId: "r1", type: "request", provider: "strata", model: "m", messages: [{ role: "user", content: "B 说的" }] },
      { requestId: "r1", type: "text", text: "B 答的" },
    ] as LogInput[]);
    b.close();

    const to = `http://127.0.0.1:${port}`;
    /* A 推 → B 拉（B 会先把**自己**的两条也推上去 —— 一轮同步就是"推自己 + 拉别人"） */
    const fromA = await syncSession({ dataDir: dirA, sessionId: sid, to, token, producerId: "device-A" });
    expect(fromA.pushed).toBe(2);
    const fromB = await syncSession({ dataDir: dirB, sessionId: sid, to, token, producerId: "device-B" });
    expect(fromB.applied, "B 该合并 A 那两条").toBe(2);
    /* 一轮的**顺序是"先推自己、再拉别人"** —— B 推的时候还没合并 A 的，所以是 2 条 */
    expect(fromB.pushed, "B 自己那两条推上去").toBe(2);

    /* A 再拉一轮：把 B 的（以及 B 转手回来的自己的）都处理掉 */
    const fromA2 = await syncSession({ dataDir: dirA, sessionId: sid, to, token, producerId: "device-A" });
    expect(fromA2.applied, "A 该只合并 B 那两条").toBe(2);
    expect(fromA2.localAfter).toBe(4);

    /* 判据：两端内容一致（按 requestId + type + text 比，不比 seq —— 那是本机编号） */
    const read = (dir: string) => {
      const store = createSqliteSessionStore(dir);
      return store.load(sid).then((r) => {
        store.close();
        return r.records;
      });
    };
    const sig = (records: readonly unknown[]) =>
      records
        .map((r) => JSON.stringify({ requestId: (r as { requestId?: string }).requestId, type: (r as { type?: string }).type, text: (r as { text?: string }).text ?? null }))
        .sort();
    expect(sig(await read(dirA))).toEqual(sig(await read(dirB)));
    expect((await read(dirA)).length).toBe(4);

    /* 幂等：再各同步一轮，谁也不该多出记录 */
    const againA = await syncSession({ dataDir: dirA, sessionId: sid, to, token, producerId: "device-A" });
    const againB = await syncSession({ dataDir: dirB, sessionId: sid, to, token, producerId: "device-B" });
    expect(againA.applied + againB.applied, "重复同步多出了记录").toBe(0);
    expect((await read(dirA)).length).toBe(4);
    expect((await read(dirB)).length).toBe(4);
  });

  it("⭐ 本地没有这段会话：不猜归属（不给 --owner 就拒绝）", async () => {
    const { port, token } = await boot({ relay: createSyncRelay() });
    const dir = tmp();
    await expect(
      syncSession({ dataDir: dir, sessionId: chatSessionId("cli-sync-missing"), to: `http://127.0.0.1:${port}`, token, producerId: "device-X" }),
    ).rejects.toThrow(/不猜/);
  });

  it("口令不对：当场说清（不静默当空流）", async () => {
    const { port } = await boot({ relay: createSyncRelay() });
    const dir = tmp();
    const sid = chatSessionId("cli-sync-auth");
    const store = createSqliteSessionStore(dir);
    await store.append(sid, [{ requestId: "r1", type: "text", text: "本地一条" } as LogInput]);
    store.close();
    const got = await syncSession({ dataDir: dir, sessionId: sid, to: `http://127.0.0.1:${port}`, token: "sk-不对", producerId: "device-X" }).catch(
      (error: Error) => error,
    );
    expect(got instanceof Error, "错口令居然同步成功了").toBe(true);
  });
});
