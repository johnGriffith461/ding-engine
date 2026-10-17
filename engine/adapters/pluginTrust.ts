import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PluginPublisher } from "../runtime/plugins";
import type { PluginPaths } from "./pluginStore";

/**
 * **发布者信任表**（V5-4 任务 4.4）。
 *
 * ## 它记什么
 *
 * `发布者 id → 公钥`（第一次见到就钉住，TOFU —— 与 ssh 的 known_hosts 同一套直觉）。
 * 于是"同一个 id 换了一把钥匙"这件事**看得见**，而不是悄悄生效。
 *
 * ## 三态（台账与界面都按这三态说话，别混）
 *
 * | 状态 | 怎么来的 | 含义 |
 * |---|---|---|
 * | `unsigned` | 清单里没有 `publisher`/`signature` | v1 插件：**照样能装能跑**，只是没人担保 |
 * | `unverified` | 签名验过了，但**第一次**见这个 id+key | 签名是真的，身份还没被复核过 |
 * | `trusted` | 签名验过，且 id+key 与信任表里那条**一致** | 还是那个人签的那把钥匙 |
 *
 * ⚠️ `trusted` 不等于"安全"：它说的是"**同一把钥匙**，和上一次是同一个发布者"。
 * 第一次装的时候没人能替你判断那位发布者该不该信 —— 这一条如实写在界面上，
 * 不靠一个绿色的"已信任"把它盖过去。
 *
 * ## 冲突（硬拒）
 *
 * 同一个 id 带着**另一把**钥匙来 → 拒绝安装。理由：id 是身份，钥匙是身份的证据；
 * 证据换了要么是发布者在正式轮换（那要走一次显式操作，不是"装个插件顺手换了"），
 * 要么是有人在冒充。两种都不该由安装动作**默认**接受。
 */

/** 信任表里的一条。 */
export type TrustedPublisher = {
  id: string;
  key: string;
  /** 第一次见到（epoch ms）。 */
  addedAt: number;
  /** 最后一次见到（epoch ms）——"这半年没动过"这件事本身是信息。 */
  lastSeenAt: number;
};

/** 信任表的形状（落盘 JSON）。 */
export type PublisherTrust = { publishers: TrustedPublisher[] };

/** 信任表文件放在台账旁边（同一层：都是"我们的账"，不是插件的内容）。 */
export function trustFileOf(paths: PluginPaths): string {
  return path.join(path.dirname(paths.ledger), "trusted-publishers.json");
}

/** 读信任表；读不出来给空表（**不抛** —— 表坏了不该让插件全装不上，但也绝不假装"信过"）。 */
export function readTrust(paths: PluginPaths): PublisherTrust {
  const file = trustFileOf(paths);
  if (!existsSync(file)) return { publishers: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { publishers?: unknown };
    const list = Array.isArray(parsed.publishers) ? parsed.publishers : [];
    const out: TrustedPublisher[] = [];
    for (const raw of list) {
      const item = raw as { id?: unknown; key?: unknown; addedAt?: unknown; lastSeenAt?: unknown };
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (!id || !key) continue;
      out.push({
        id,
        key,
        addedAt: typeof item.addedAt === "number" ? item.addedAt : 0,
        lastSeenAt: typeof item.lastSeenAt === "number" ? item.lastSeenAt : 0,
      });
    }
    return { publishers: out };
  } catch {
    return { publishers: [] };
  }
}

/** 写信任表（结构固定，破坏性写入一次到位）。 */
export function writeTrust(paths: PluginPaths, trust: PublisherTrust): void {
  const file = trustFileOf(paths);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(trust, null, 2)}\n`, "utf8");
}

/** 登记一次（TOFU）：第一次钉住、之后只更新 `lastSeenAt`；**换钥匙一律拒**。 */
export function rememberPublisher(
  paths: PluginPaths,
  publisher: PluginPublisher,
  now = Date.now(),
): { ok: true; added: boolean; trust: "unverified" | "trusted" } | { ok: false; message: string } {
  const trust = readTrust(paths);
  const known = trust.publishers.find((p) => p.id === publisher.id);
  if (!known) {
    const added: TrustedPublisher = { id: publisher.id, key: publisher.key, addedAt: now, lastSeenAt: now };
    writeTrust(paths, { publishers: [...trust.publishers, added] });
    return { ok: true, added: true, trust: "unverified" };
  }
  if (known.key !== publisher.key) {
    return {
      ok: false,
      message:
        `发布者 ${publisher.id} 换了一把钥匙：信任表里记的是另一把（${known.addedAt ? new Date(known.addedAt).toISOString().slice(0, 10) : "更早"} 钉的）。` +
        `拒绝安装 —— 轮换钥匙要走一次显式操作（先删掉 ` +
        `${path.basename(trustFileOf(paths))} 里那条），别让"装个插件"顺手把身份换掉。`,
    };
  }
  writeTrust(paths, {
    publishers: trust.publishers.map((p) => (p.id === publisher.id ? { ...p, lastSeenAt: now } : p)),
  });
  return { ok: true, added: false, trust: "trusted" };
}
