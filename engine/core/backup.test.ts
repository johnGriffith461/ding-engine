import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeKv, kvList, kvReadByKey, kvWrite, kvWriteKey, looksLikeForeignPathKey } from "../adapters/kvStore";
import { createSqliteSessionStore } from "../adapters/sqliteStore";
import { chatSessionId, taskSessionId, type LogInput } from "./events";
import {
  BACKUP_VERSION,
  UNMAPPABLE_STORE_KEY,
  applyBackup,
  buildBackup,
  describeBackup,
  validateBackup,
  type BackupPayload,
} from "./backup";

/**
 * 备份 / 恢复（Phase 12.3）。
 *
 * 方案的验收是「**恢复后评测集重放行为一致 —— 数据是用户的**」。
 *
 * ⚠️ 2026-10-16（审计 G74）：这套测试原来把**真正的风险面 mock 掉了** ——
 * `writeStore` 只是往数组里 push（从不落 KV）、备份里的键写成 `"demo"`（不是真键形状）、
 * roundtrip 还把 `at` **主动归零**再比。于是"恢复会覆盖用户现在的设置"这条硬规矩
 * 坏得彻底（P99/P123/P196）而它照样全绿。现在改成：
 *
 *   · 配置型 store **真落 KV**（`kvWrite`/`kvReadByKey`）、**真键形状**（`<数据目录>/tasks.json`）；
 *   · 恢复前先在 KV 放一份**新的**值，断言恢复之后它**还在**（覆盖 = 立刻红）；
 *   · 时间戳不许被断言成 0（真时间戳；恢复侧不保留原始 at 是 P31 那件事，见 ⑦）。
 */

const dirs: string[] = [];
const opened: Array<{ close: () => void }> = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  opened.length = 0;
});

afterEach(() => {
  for (const s of opened) s.close();
  for (const d of dirs) closeKv(d);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function openStore(d: string) {
  const store = createSqliteSessionStore(d);
  opened.push(store);
  return store;
}

const req = (text: string, requestId = "r1"): LogInput => ({
  requestId,
  type: "request",
  provider: "strata",
  model: "m",
  messages: [{ role: "user", content: text }],
  toolPolicy: "按需确认",
  tools: [],
});

/** 恢复时用不到会话的口子时的占位（纯 store 用例用）。 */
const noSessions = {
  loadSession: async () => ({ records: [] }),
  appendSession: async () => [],
};

describe("备份与恢复（Phase 12.3）", () => {
  it("① roundtrip：配置型 store 真落 KV、真键形状，读回来还是同一份", async () => {
    const src = tempDir("dh-backup-");
    const store = openStore(src);
    const sid = chatSessionId("bk");
    await store.append(sid, [req("第一句"), { requestId: "r1", type: "text", text: "回一句" }]);
    await store.append(sid, [{ requestId: "r2", type: "text", text: "第二句的回答" }]);
    const before = await store.load(sid);

    /*
     * 写一份**真的**配置型 store：键就是 KV 的真实键形状（相对数据目录，见 kvStore.kvStoreKey）。
     * 备份里带走的正是 `kvList` 给的那个键 —— 而不是手写的 "demo"。
     */
    const storeFile = path.join(src, "tasks.json");
    kvWrite(src, storeFile, { __schema: 1, data: { items: ["甲"] } });
    const listed = kvList(src);
    expect(listed.map((e) => e.key)).toEqual(["tasks.json"]);

    const payload = buildBackup({
      fromDataDir: src,
      sessions: [{ sessionId: sid, records: before.records }],
      stores: listed.map((e) => ({ key: e.key, value: e.value })),
      config: { provider: "strata", mode: "按需确认" },
    });
    expect(payload.kind).toBe("ding-harness-backup");
    expect(payload.version).toBe(BACKUP_VERSION);
    expect(payload.summary.records).toBe(before.records.length);

    // 换一个干净的数据目录恢复（模拟"换机器"）
    const fresh = tempDir("dh-backup2-");
    /*
     * ⚠️ 这个 store **不放进 `opened`**：它要在 `finally` 里删目录之前先关掉 ——
     * Windows 上库文件被句柄占着时删目录是硬失败（`SessionStore.close` 的注释记过这条）。
     */
    const target = createSqliteSessionStore(fresh);
    try {
      const report = await applyBackup(payload, {
        loadSession: (id) => target.load(id),
        appendSession: (id, recs) => target.append(id, recs),
        readStore: (key) => kvReadByKey(fresh, key),
        writeStore: (key, value) => kvWriteKey(fresh, key, value),
        writeConfig: () => undefined,
      });

      expect(report.recordsAdded).toBe(before.records.length);
      expect(report.recordsSkipped).toBe(0);
      expect(report.stores).toBe(1);
      expect(report.storesSkipped).toBe(0);
      expect(report.configRestored).toBe(true);
      // 配置型 store 按**同一把键**读得回来（值是信封，原样放回）
      expect(kvReadByKey(fresh, "tasks.json")).toEqual({ __schema: 1, data: { items: ["甲"] } });
      // 键与机器无关：换个数据目录，键还是 "tasks.json"
      expect(kvList(fresh).map((e) => e.key)).toEqual(["tasks.json"]);

      const after = await target.load(sid);
      /* 判据是**投影一致**，不是文件字节一致 —— 存储自己会重新编号，那是它的权利 */
      expect(JSON.stringify(after.records.map((r) => ({ ...r, seq: 0, at: 0 })))).toBe(
        JSON.stringify(before.records.map((r) => ({ ...r, seq: 0, at: 0 }))),
      );
      expect(after.records.length).toBe(before.records.length);
    } finally {
      target.close();
    }
  });

  it("② 恢复**不删不覆盖**：备份比现在旧时，现在的数据还在", async () => {
    const d = tempDir("dh-backup-");
    const store = openStore(d);
    const sid = taskSessionId("live");

    // 先做一份"三天前的备份"
    await store.append(sid, [req("那时候的一句话")]);
    const old = await store.load(sid);
    const payload = buildBackup({ fromDataDir: d, sessions: [{ sessionId: sid, records: old.records }], stores: [] });

    // 之后用户又聊了一堆（同一个会话、后面又追加了记录）
    await store.append(sid, [{ requestId: "r2", type: "text", text: "后来又说的话" }]);
    const now = await store.load(sid);
    expect(now.records.length).toBeGreaterThan(old.records.length);

    // 恢复那份旧备份
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      writeStore: () => undefined,
    });

    expect(report.recordsAdded, "旧备份不该再往库里塞重复记录").toBe(0);
    expect(report.recordsSkipped).toBe(old.records.length);
    const after = await store.load(sid);
    // 现在的记录**一条都没少**（"后来又说的话"还在）
    expect(after.records.length).toBe(now.records.length);
    expect(JSON.stringify(after.records)).toContain("后来又说的话");
  });

  it("③ 坏备份要说清哪里坏，而不是崩（含 version 下界与记录形状）", () => {
    expect(validateBackup(null)).toEqual({ ok: false, reason: expect.stringContaining("不是一个对象") });
    expect(validateBackup({})).toEqual({ ok: false, reason: expect.stringContaining("不是本程序的备份") });
    expect(validateBackup({ kind: "ding-harness-backup", version: BACKUP_VERSION + 1, sessions: [], stores: [] })).toEqual({
      ok: false,
      // ⚠️ 更高版本的备份**不猜着恢复**：可能有不认识的字段，恢复出来是半截数据
      reason: expect.stringContaining("升级之后再恢复"),
    });
    expect(validateBackup({ kind: "ding-harness-backup", version: 1, sessions: {}, stores: [] })).toEqual({
      ok: false,
      reason: expect.stringContaining("sessions"),
    });

    /*
     * ⚠️ P145：原来只挡"版本更高"，于是 `0` / 负数 / `NaN` 全能过
     * （`typeof NaN === "number"` 且 `NaN > 1` 为 false）。版本号是格式契约的地基，
     * 这三个必须拒绝 —— 下面三条就是那三个。
     */
    for (const bad of [0, -1, Number.NaN, 1.5]) {
      const got = validateBackup({ kind: "ding-harness-backup", version: bad, sessions: [], stores: [] });
      expect(got.ok, `version=${String(bad)} 不该通过校验`).toBe(false);
    }
    // 记录形状也要说得清（不是"能恢复"）
    const shaped = (sessions: unknown): unknown => ({ kind: "ding-harness-backup", version: 1, sessions, stores: [] });
    expect(validateBackup(shaped([{ sessionId: "", records: [] }]))).toEqual({
      ok: false,
      reason: expect.stringContaining("sessionId"),
    });
    expect(validateBackup(shaped([{ sessionId: "a..b", records: [] }]))).toEqual({
      ok: false,
      reason: expect.stringContaining(".."),
    });
    expect(validateBackup(shaped([{ sessionId: "chat-x", records: [1] }]))).toEqual({
      ok: false,
      reason: expect.stringContaining("不是对象"),
    });
    // stores 里的 key 也必须收窄
    expect(validateBackup({ kind: "ding-harness-backup", version: 1, sessions: [], stores: [{ value: 1 }] })).toEqual({
      ok: false,
      reason: expect.stringContaining("key"),
    });

    const good = buildBackup({ fromDataDir: d0(), sessions: [], stores: [] });
    const checked = validateBackup(JSON.parse(JSON.stringify(good)));
    expect(checked.ok).toBe(true);
  });

  it("④ 清单（`--list`）说的是实话；**本机完整路径不进可分享文件**（P145）", () => {
    const payload: BackupPayload = buildBackup({
      fromDataDir: "C:/Users/someone/AppData/Roaming/Ding Harness",
      sessions: [
        { sessionId: chatSessionId("a"), records: [req("x", "r1") as never] },
        { sessionId: chatSessionId("b"), records: [req("x", "r1") as never, req("y", "r2") as never] },
      ],
      stores: [],
      now: new Date("2026-10-15T00:00:00Z"),
    });
    // 默认只记目录名：完整路径带用户名/机器名，而这个文件是要拿去分享的
    expect(payload.fromDataDir).toBe("Ding Harness");
    expect(JSON.stringify(payload)).not.toContain("someone");
    // 想要完整出处就显式说
    const kept = buildBackup({ fromDataDir: "C:/Users/someone/AppData/Roaming/Ding Harness", sessions: [], stores: [], keepProvenance: true });
    expect(kept.fromDataDirFull).toBe("C:/Users/someone/AppData/Roaming/Ding Harness");

    const text = describeBackup(payload);
    expect(text).toContain("Ding Harness");
    expect(text).toContain("会话 2 段");
    expect(text).toContain("记录 3 条");
    // 最大的那段排前面
    expect(text.indexOf(chatSessionId("b"))).toBeLessThan(text.indexOf(chatSessionId("a")));
  });

  it("⑤ 恢复时给空备份：不报错，报告是零", async () => {
    const d = tempDir("dh-backup-");
    const store = openStore(d);
    const payload = buildBackup({ fromDataDir: d, sessions: [], stores: [] });
    const report = await applyBackup(payload, {
      loadSession: (id) => store.load(id),
      appendSession: (id, recs) => store.append(id, recs),
      writeStore: () => undefined,
    });
    expect(report).toEqual({
      sessions: 0,
      recordsAdded: 0,
      recordsSkipped: 0,
      stores: 0,
      storesSkipped: 0,
      storesUnavailable: 0,
      configRestored: false,
    });
  });

  it("⑥ ⭐ P99/P123/P196：本机已有的配置型 store **跳过**，不动用户现在的设置", async () => {
    const target = tempDir("dh-backup-");
    // 本机现在这份（用户这三天改过的）值
    kvWrite(target, path.join(target, "tasks.json"), { __schema: 1, data: { items: ["当前"] } });

    // 一份三天前的备份，带着同一个键的旧值
    const payload = buildBackup({
      fromDataDir: target,
      sessions: [],
      stores: [{ key: "tasks.json", value: { __schema: 1, data: { items: ["三天前"] } } }],
    });

    const report = await applyBackup(payload, {
      ...noSessions,
      readStore: (key) => kvReadByKey(target, key),
      writeStore: (key, value) => kvWriteKey(target, key, value),
    });

    // 报告如实：补入 0 项、跳过 1 项
    expect(report.stores).toBe(0);
    expect(report.storesSkipped).toBe(1);
    // 用户的当前值**没有被旧值抹掉** —— 这条一红就说明"无条件覆盖"回来了
    expect(kvReadByKey(target, "tasks.json")).toEqual({ __schema: 1, data: { items: ["当前"] } });

    // 而**本机没有**的键照样补进来（"只补"那一半也要成立）
    const again = await applyBackup(
      buildBackup({ fromDataDir: target, sessions: [], stores: [{ key: "memory.json", value: { __schema: 1, data: { items: ["新"] } } }] }),
      { ...noSessions, readStore: (key) => kvReadByKey(target, key), writeStore: (key, value) => kvWriteKey(target, key, value) },
    );
    expect(again.stores).toBe(1);
    expect(again.storesSkipped).toBe(0);
    expect(kvReadByKey(target, "memory.json")).toEqual({ __schema: 1, data: { items: ["新"] } });
  });

  it("⑥b ⭐ P100/P128：旧格式（外机绝对路径）的键**明确报出来**，不假装恢复了", async () => {
    const target = tempDir("dh-backup-");
    /*
     * 宿主（cmdBackup）的判据是"键长得像别的盘/别的机器的路径"：
     * 真绝对路径（`C:\Users\alice\...`）与盘相对畸形（`C:foo`）都算 —— 后者不猜。
     */
    const hostRead = (key: string) => (looksLikeForeignPathKey(key) ? UNMAPPABLE_STORE_KEY : kvReadByKey(target, key));
    const payload = buildBackup({
      fromDataDir: target,
      sessions: [],
      stores: [
        { key: "C:\\Users\\alice\\AppData\\Roaming\\Ding Harness\\tasks.json", value: { __schema: 1, data: { items: ["外机"] } } },
        { key: "C:tasks.json", value: { __schema: 1, data: { items: ["盘相对畸形"] } } },
      ],
    });
    const report = await applyBackup(payload, {
      ...noSessions,
      readStore: hostRead,
      writeStore: (key, value) => kvWriteKey(target, key, value),
    });
    expect(report.stores).toBe(0);
    expect(report.storesUnavailable, "两个外机键都该被报成「用不了」").toBe(2);
    // 没有往一串没人会查的键上写东西
    expect(kvList(target)).toEqual([]);
  });

  it("⑦ G74(b)：roundtrip 不许把记录的时间戳抹成 0（备份留住原始 at）", async () => {
    const src = tempDir("dh-backup-");
    const store = openStore(src);
    const sid = chatSessionId("ts");
    await store.append(sid, [req("带时间戳的一句")]);
    const before = await store.load(sid);
    expect(before.records[0].at).toBeGreaterThan(0);

    const payload = buildBackup({ fromDataDir: src, sessions: [{ sessionId: sid, records: before.records }], stores: [] });
    // 备份文件里**留住**原始 at（原来是断言 at:0 再比 —— 等于把这个性质写成"丢了没关系"）
    expect(payload.sessions[0].records[0].at).toBe(before.records[0].at);

    const fresh = tempDir("dh-backup2-");
    const target = createSqliteSessionStore(fresh);
    try {
      await applyBackup(payload, {
        loadSession: (id) => target.load(id),
        appendSession: (id, recs) => target.append(id, recs),
        writeStore: () => undefined,
      });
      const after = await target.load(sid);
      /*
       * 恢复进来的记录必须带着**真实**的时间戳（不是 0/undefined）。
       * ⚠️ "恢复保留指纹机原始 at" 是 P31（`append` 里 `const at = Date.now()`）那件事，
       * 落在 `engine/adapters/sqliteStore.ts`（本单不动它）；这里钉住的是"不许归零"。
       */
      for (const r of after.records) {
        expect(typeof r.at).toBe("number");
        expect(r.at).toBeGreaterThan(0);
      }
    } finally {
      target.close();
    }
  });

  it("⑧ ⭐ P210：跨机器同 id 会话按**内容**判重，一条都不丢", async () => {
    const machineA = tempDir("dh-backup-a-");
    const machineB = tempDir("dh-backup-b-");
    const sid = chatSessionId("cross");

    // A 机：10 条互不相同的内容
    const a = openStore(machineA);
    const ten: LogInput[] = Array.from({ length: 10 }, (_, i) => req(`A 机第 ${i} 句`, `ra${i}`));
    await a.append(sid, ten);
    const before = await a.load(sid);
    expect(before.records.length).toBe(10);
    const payload = buildBackup({ fromDataDir: machineA, sessions: [{ sessionId: sid, records: before.records }], stores: [] });

    /*
     * B 机：同一段会话 id，但本地已经有 **3 条完全不同的内容**（seq 1/2/3 与 A 机撞车）。
     * 按 `seq` 判重的旧实现会把备份里的 seq 1..3 当"已存在"静默丢掉 —— 那正是 P210。
     */
    const b = openStore(machineB);
    await b.append(sid, [req("B 机第 1 句", "rb0"), req("B 机第 2 句", "rb1"), req("B 机第 3 句", "rb2")]);

    const report = await applyBackup(payload, {
      loadSession: (id) => b.load(id),
      appendSession: (id, recs) => b.append(id, recs),
      writeStore: () => undefined,
    });

    expect(report.recordsSkipped, "内容完全不同，不该被当重复跳过").toBe(0);
    expect(report.recordsAdded, "备份里的 10 条一条都不许丢").toBe(10);
    const after = await b.load(sid);
    expect(after.records.length).toBe(13);
    expect(JSON.stringify(after.records)).toContain("A 机第 0 句");
    expect(JSON.stringify(after.records)).toContain("B 机第 3 句");
  });
});

/** 一个稳定的临时目录（只给 ③ 里"造一份合法备份"用）。 */
function d0(): string {
  return tempDir("dh-backup-good-");
}
