import { createHash, createPublicKey, verify as verifyBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { PluginPublisher } from "./plugins";

/**
 * **插件签名的算法那一半**（V5-4 任务 4.4：签名挂发布者身份）。
 *
 * ## 签的是什么（两个面，分开算完一起进摘要）
 *
 * 1. **文件面**：整棵目录逐文件 sha256（按路径排序，排除 `node_modules` / `.git`）；
 * 2. **清单面**：`ding-plugin.json` 里那份 JSON（**去掉 `signature` 字段本身**，
 *    键排序后规范化）。
 *
 * 为什么清单要单独一个面 —— 签名**写在清单里**，所以它不能同时"被清单的字节覆盖"：
 * 那是先有鸡还是先有蛋（写进签名 = 清单变了 = 摘要变了）。把清单按"除签名之外的
 * 全部字段"规范化进摘要，两个面就都盖住了：改任何一个文件、改清单里任何一个字段，
 * 摘要都会变。
 *
 * ```
 * digest = sha256( "ding-plugin-sig/1" ␀ canonicalJSON({files, manifest(no signature), publisher}) )
 * ```
 *
 * ⚠️ 由此有一条硬规矩：**签名的插件必须用 `ding-plugin.json` 装清单**
 * （`package.json#ding` 那条渠道不签 —— package.json 自己也在文件面里，
 * 没有地方放一个"不被自己覆盖"的签名字段）。没签名的插件两条渠道都能用。
 *
 * ## 为什么是"验不过就拒"而不是"给个警告"
 *
 * 一个签名只有在**能拦住东西**的时候才有意义：验不过还让装，它就只是装饰，
 * 而用户看到"已签名"会以为有人替他核过。所以：**有签名就必须验得过**。
 * 没有签名（v1 插件）照样能装 —— 那是"没有签名"，不是"签名坏了"，
 * 台账里记成不同的状态（见 `pluginTrust.ts`）。
 */

/** 一份文件摘要（文件面里的一条）。 */
type FileDigest = { path: string; sha256: string };

/** 计算摘要时一律跳过的目录。 */
const SKIP_DIRS = new Set(["node_modules", ".git"]);
/** 签名的插件用这份清单（见文件头那条硬规矩）。 */
export const SIGNED_MANIFEST_FILE = "ding-plugin.json";

/** 规范化 JSON：键排序、递归（同一份内容只有一种写法，否则"同一个清单"会有两个摘要）。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * 算一个插件目录的**签名摘要**（十六进制）。
 *
 * @param dir 插件目录
 * @param rawManifest 磁盘上那份清单的**原始** JSON（不是 `checkManifest` 规范化过的那份 ——
 *   签名是作者对**他写下的字节**做的，规范化会丢掉他没写的默认值）
 * @param publisherKey 发布者公钥（进摘要 —— 换钥匙就换摘要）
 * @returns 摘要（64 位十六进制）
 */
export function digestOfPluginDir(dir: string, rawManifest: unknown, publisherKey: string): string {
  const files: FileDigest[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) {
        /* 清单文件不进文件面（它进的是清单面 —— 见文件头"两个面"） */
        if (!prefix && entry.name === SIGNED_MANIFEST_FILE) continue;
        files.push({ path: rel, sha256: createHash("sha256").update(readFileSync(full)).digest("hex") });
      }
    }
  };
  walk(dir, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifest = { ...((rawManifest ?? {}) as Record<string, unknown>) };
  delete manifest.signature;
  const canonicalBody = JSON.stringify({ v: 1, files, manifest: JSON.parse(canonical(manifest)), publisher: publisherKey });
  return createHash("sha256").update(`ding-plugin-sig/1\u0000${canonicalBody}`).digest("hex");
}

/** 一次验签的结果。 */
export type SignatureVerdict =
  | { ok: true; digest: string }
  /** `bad-key`：公钥读不出来；`bad-signature`：验不过（改过文件 / 不是这把钥匙签的）。 */
  | { ok: false; reason: "bad-key" | "bad-signature"; message: string };

/**
 * 验一次插件签名。
 *
 * @param input.dir 插件目录（真文件 —— 摘要算的是它，不是清单里写的）
 * @param input.rawManifest 磁盘上那份清单的原始 JSON
 * @param input.publisher 发布者（`{id, name?, key}`）
 * @param input.signature 清单里的 `signature`（base64）
 * @returns 结论；验不过时 `message` 要能直接给用户看
 */
export function verifyPluginSignature(input: {
  dir: string;
  rawManifest: unknown;
  publisher: PluginPublisher;
  signature: string;
}): SignatureVerdict {
  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(input.publisher.key, "base64"), format: "der", type: "spki" });
  } catch {
    return {
      ok: false,
      reason: "bad-key",
      message: "发布者公钥读不出来（publisher.key 应该是 base64 的 ed25519 公钥，SPKI DER 格式）—— 这份签名没法验",
    };
  }

  const digest = digestOfPluginDir(input.dir, input.rawManifest, input.publisher.key);
  let ok = false;
  try {
    ok = verifyBytes(null, Buffer.from(digest, "utf8"), publicKey, Buffer.from(input.signature, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) {
    return {
      ok: false,
      reason: "bad-signature",
      message:
        `签名验不过（发布者 ${input.publisher.id}）：要么文件（或清单）在签名之后被改过，` +
        `要么这不是这把钥匙签的。拒绝安装 —— 请向发布者要一份未被改动的包。`,
    };
  }
  return { ok: true, digest };
}
