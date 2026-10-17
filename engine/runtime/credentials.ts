import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 凭据读取（只读，绝不回传明文给渲染进程）。
 *
 * 优先级：环境变量 → `~/.dsh/.credentials.yaml`（DSH 的凭据库）。
 * 渲染进程只能拿到"某个 provider 有没有可用 key"这种布尔信息与一份脱敏的模型清单，
 * key 本体只在主进程里用来发请求。
 */

/** 凭据文件位置（可用 DSH_CREDENTIALS_FILE 覆盖，便于换机器）。 */
export function credentialsPath(): string {
  const override = process.env.DSH_CREDENTIALS_FILE;
  if (override) return override;
  return path.join(os.homedir(), ".dsh", ".credentials.yaml");
}

/**
 * 极简 YAML 读取：只需要支持 `refs:` 下一层的 `KEY: value`。
 * 不引 yaml 依赖 —— 文件格式由另一个程序写死，结构固定。
 */
function parseRefs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;

  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      refsIndent = indent;
      continue;
    }
    if (!inRefs) continue;
    // 回到同级或更外层，说明 refs 段结束
    if (indent <= refsIndent) break;

    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (!value) continue;
    // 去掉可能的引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }

  return out;
}

/**
 * 缓存。
 *
 * ⚠️ **必须按文件路径分开**（2026-10-15 修）：原来只记时间戳，于是换了凭据文件
 * （`DSH_CREDENTIALS_FILE` 变过、或者用户在向导里刚写完一份新的）之后，
 * 30 秒内读到的还是**上一个文件**的内容 —— 表现是"刚配好，doctor 却说没配"。
 * 这条是 `hosts/cli/wizard.test.ts` 逮到的：它每个用例换一个凭据文件。
 */
let cache: { at: number; file: string; refs: Record<string, string> } | null = null;

/**
 * 让凭据缓存失效。
 *
 * ⚠️ **写完凭据必须调它**（向导那条路）：否则"刚写完、紧接着读"会在 30 秒内
 * 拿到写之前的快照 —— 表现是"向导说配好了，自检却说没有 key"。
 * 缓存是给"每次发请求读一次盘"省开销的，不是给"写完还读旧的"用的。
 */
export function invalidateCredentialCache(): void {
  cache = null;
}

/**
 * 读 refs 段（带 30s 缓存，避免每次发请求都读盘）。
 *
 * 缓存键是**文件路径 + 时间**：换了文件立刻失效（不清缓存就读到别人的 key 才是更坏的）。
 */
export function readCredentialRefs(): Record<string, string> {
  const now = Date.now();
  const file = credentialsPath();
  if (cache && cache.file === file && now - cache.at < 30_000) return cache.refs;

  let refs: Record<string, string> = {};
  try {
    if (fs.existsSync(file)) {
      // 先按 UTF-8 解，失败再退到 latin1（BOM/编码异常时至少不崩）
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      refs = parseRefs(text);
    }
  } catch {
    refs = {};
  }

  cache = { at: now, file, refs };
  return refs;
}

/**
 * 取某个 key 的实际值。
 * @param envName 环境变量名 / 凭据引用名
 * @returns 明文密钥；没有则 null
 */
export function resolveSecret(envName: string): string | null {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const fromFile = readCredentialRefs()[envName];
  if (fromFile && fromFile.trim()) return fromFile.trim();
  /*
   * 第三段：**桌面加密库**（safeStorage / DPAPI / Keychain）。
   *
   * 2026-10-16 补：用户能在设置里填 key 之后，存进去的那条必须能被读回来 ——
   * 否则「存了还是说没密钥」。没注册目录（CLI / 测试）时它返回 null，行为与以前一样。
   */
  try {
    const mod = require("../adapters/secretStore") as {
      revealSecretFromStore?: (name: string) => string | null;
    };
    const fromStore = mod.revealSecretFromStore?.(envName);
    if (fromStore) return fromStore;
  } catch {
    /* 引擎不该因为读不到加密库而炸 */
  }
  return null;
}

/** 该 key 是否可用（不返回明文）。 */
export function hasSecret(envName: string): boolean {
  return resolveSecret(envName) !== null;
}
