import { generateKeyPairSync, sign as signBytes, createPublicKey, createPrivateKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installFromDir, pluginPaths, readLedger } from "./pluginStore";
import { readTrust, trustFileOf } from "./pluginTrust";
import { digestOfPluginDir, verifyPluginSignature } from "../runtime/pluginSignature";
import { checkManifest } from "../runtime/plugins";

/**
 * **插件签名挂发布者身份**（V5-4 任务 4.4）的回归。
 *
 * 判据按"用户真正会遇到的四种情形"排：
 *   ① **v1 插件（没签名）照样装**（兼容不是口号）；
 *   ② 签过名的装上，状态是 `unverified`（第一次见）→ 再装一次 → `trusted`（同一把钥匙）；
 *   ③ **文件被改过一个字节** → 拒装（这就是签名存在的全部意义）；
 *   ④ **同一个发布者 id 换了一把钥匙** → 拒装（身份被换掉这件事必须拦在装之前）。
 *
 * 另外单独钉住"清单校验"那一层：`publisher` 与 `signature` **成对**出现 ——
 * 单边出现是清单错误，不是"半个签名"。
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为（Windows） */
    }
  }
});
const tmpDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

/** 造一个插件目录（清单 + 入口）。 */
function makePlugin(dir: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "ding-plugin.json"),
    JSON.stringify(
      { name: "hello-plugin", version: "1.0.0", description: "打个招呼的示例插件", permissions: [], engines: { ding: ">=0.2.0" }, ...extra },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(path.join(dir, "index.mjs"), "export const tools = {};\n", "utf8");
  return dir;
}

/** 用真钥匙签一个目录（与 `scripts/plugin-sign.mjs` 同一条算法）。 */
function signPlugin(dir: string, publisherId: string, privateKeyPem?: string): { publicKey: string; privateKey: string } {
  const keys = privateKeyPem
    ? { privateKey: privateKeyPem, publicKey: Buffer.from(createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" })).toString("base64") }
    : (() => {
        const pair = generateKeyPairSync("ed25519");
        return {
          privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          publicKey: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })).toString("base64"),
        };
      })();

  const manifestFile = path.join(dir, "ding-plugin.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
  manifest.publisher = { id: publisherId, key: keys.publicKey };
  delete manifest.signature;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");

  const digest = digestOfPluginDir(dir, manifest, keys.publicKey);
  const signature = signBytes(null, Buffer.from(digest, "utf8"), createPrivateKey(keys.privateKey)).toString("base64");
  manifest.signature = signature;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), "utf8");
  return keys;
}

describe("插件签名（V5-4 4.4）", () => {
  it("① v1 插件（没有 publisher/signature）照样装 —— 状态记成 unsigned", () => {
    const dataDir = tmpDir("dh-sig-a-");
    const plugin = makePlugin(path.join(tmpDir("dh-sig-src-"), "hello-plugin"));
    const got = installFromDir({ paths: pluginPaths(dataDir), from: plugin });
    expect(got.ok, got.ok ? "" : got.errors.join("\n")).toBe(true);
    if (!got.ok) return;
    expect(got.plugin.signature).toEqual({ trust: "unsigned" });
    /* 台账里也记着（重启之后还答得上来"这个插件是谁签的"） */
    expect(readLedger(pluginPaths(dataDir)).ledger.installed[0]?.signature).toEqual({ trust: "unsigned" });
  });

  it("② 签名插件：装上 → unverified（第一次见）→ 再装 → trusted（同一把钥匙）", () => {
    const dataDir = tmpDir("dh-sig-b-");
    const plugin = makePlugin(path.join(tmpDir("dh-sig-src-"), "hello-plugin"));
    const keys = signPlugin(plugin, "acme");
    const paths = pluginPaths(dataDir);

    const first = installFromDir({ paths, from: plugin });
    expect(first.ok, first.ok ? "" : first.errors.join("\n")).toBe(true);
    if (!first.ok) return;
    expect(first.plugin.signature).toEqual({ publisher: { id: "acme", key: keys.publicKey }, trust: "unverified" });
    /* TOFU：钥匙被钉在信任表里了 */
    expect(readTrust(paths).publishers).toEqual([expect.objectContaining({ id: "acme", key: keys.publicKey })]);

    const second = installFromDir({ paths, from: plugin });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plugin.signature).toEqual({ publisher: { id: "acme", key: keys.publicKey }, trust: "trusted" });
  });

  it("③ 签完之后改一个字节：拒装（签名存在的全部意义）", () => {
    const dataDir = tmpDir("dh-sig-c-");
    const plugin = makePlugin(path.join(tmpDir("dh-sig-src-"), "hello-plugin"));
    signPlugin(plugin, "acme");
    /* 签名之后再动入口 —— 这是最像"投毒"的那一步 */
    writeFileSync(path.join(plugin, "index.mjs"), "export const tools = {}; // 偷偷加一行\n", "utf8");

    const got = installFromDir({ paths: pluginPaths(dataDir), from: plugin });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.errors.join("\n")).toContain("签名验不过");
    /* 拒在拷贝之前：插件目录里不该留下半个装好的东西 */
    expect(readLedger(pluginPaths(dataDir)).ledger.installed).toEqual([]);
  });

  it("④ 同一个发布者 id 换了一把钥匙：拒装（身份不能被顺手换掉）", () => {
    const dataDir = tmpDir("dh-sig-d-");
    const paths = pluginPaths(dataDir);
    const first = makePlugin(path.join(tmpDir("dh-sig-src-"), "hello-plugin"));
    signPlugin(first, "acme");
    expect(installFromDir({ paths, from: first }).ok).toBe(true);

    /* 另一个目录、同一个 id、另一把钥匙（典型的冒充形状） */
    const second = makePlugin(path.join(tmpDir("dh-sig-src-"), "hello-plugin"));
    signPlugin(second, "acme");
    const got = installFromDir({ paths, from: second });
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.errors.join("\n")).toContain("换了一把钥匙");
    /* 信任表里仍是第一次那把（没有被覆盖） */
    expect(readTrust(paths).publishers).toHaveLength(1);
  });

  it("清单校验：publisher 与 signature 必须成对（单边出现是清单错误）", () => {
    const base = { name: "hello-plugin", version: "1.0.0", description: "打个招呼的示例插件", permissions: [], engines: { ding: ">=0.2.0" } };
    const key = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" })).toString("base64");

    const onlyPublisher = checkManifest({ ...base, publisher: { id: "acme", key } });
    expect(onlyPublisher.ok).toBe(false);
    if (!onlyPublisher.ok) expect(onlyPublisher.errors.join("\n")).toContain("signature");

    const onlySignature = checkManifest({ ...base, signature: "AAAA" });
    expect(onlySignature.ok).toBe(false);

    const badKey = checkManifest({ ...base, publisher: { id: "acme", key: "短" }, signature: "AAAA" });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.errors.join("\n")).toContain("ed25519 公钥");

    /* 合法的成对出现：清单通过，两个字段都留下 */
    const good = checkManifest({ ...base, publisher: { id: "acme", name: "ACME", key }, signature: "AAAA" });
    expect(good.ok, good.ok ? "" : good.errors.join("\n")).toBe(true);
    if (good.ok) expect(good.manifest.publisher?.id).toBe("acme");
  });

  it("验签本身：换钥匙 / 换签名都对不上（摘要覆盖发布者公钥）", () => {
    const plugin = makePlugin(path.join(tmpDir("dh-sig-src-"), "hello-plugin"));
    const keys = signPlugin(plugin, "acme");
    const manifest = JSON.parse(readFileSync(path.join(plugin, "ding-plugin.json"), "utf8")) as {
      publisher: { id: string; key: string };
      signature: string;
    };

    const raw = JSON.parse(readFileSync(path.join(plugin, "ding-plugin.json"), "utf8")) as unknown;
    expect(verifyPluginSignature({ dir: plugin, rawManifest: raw, publisher: manifest.publisher, signature: manifest.signature }).ok).toBe(true);

    /* 摘要里带着发布者公钥 —— 把 key 换成另一把（签名不动）就对不上 */
    const other = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" })).toString("base64");
    const swapped = verifyPluginSignature({ dir: plugin, rawManifest: raw, publisher: { id: "acme", key: other }, signature: manifest.signature });
    expect(swapped.ok).toBe(false);

    /* 钥匙形状不对：给一句能看懂的话，而不是抛异常 */
    const badKey = verifyPluginSignature({ dir: plugin, rawManifest: raw, publisher: { id: "acme", key: "不是钥匙" }, signature: manifest.signature });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.reason).toBe("bad-key");
    expect(keys.publicKey).toBe(manifest.publisher.key);
    expect(trustFileOf(pluginPaths(tmpDir("dh-sig-e-")))).toContain("trusted-publishers.json");
  });
});
