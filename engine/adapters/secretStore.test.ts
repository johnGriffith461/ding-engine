import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SECRETS_FILE,
  credentialProtection,
  registerSecretCipher,
  readSecrets,
  secretsEncrypted,
  writeSecret,
  type SecretCipher,
} from "./secretStore";

/**
 * 密钥库的验收（Phase 14.2；审计 P114 · P118 · P119 · P120 的常驻回归）。
 *
 * ## 这一组要挡住的是什么
 *
 * 密钥这一族坏起来**不报错**：写失败会静默、读不出来会静默、"以为加密了其实是明文"
 * 更会静默（磁盘上有个 `secrets.dat`，看起来已经保护好了）。所以判据都得落在
 * **磁盘上到底有什么**与**用户被告知了什么**，而不是"函数返回了 ok"。
 *
 * 四条对应：
 *   · **P118** 合并写之前必须先能读出旧值 —— 一次临时解密失败**拒绝写**，
 *     不许"读不到就当没有"（那会把其余密钥全清光还报 `ok: true`）；
 *   · **P119** `ding doctor` 的「凭据保护」那一格要能答出三种真实状态（原来零测试）；
 *   · **P114** `writeSecret`/`readSecrets` 不是零调用死代码（桌面那条路真的接上了），
 *     且**用户可见的话**不许与实现不一致（导书写明文就得说明文）；
 *   · **P120** `mode: 0o600` 在 Windows 上不成立 → 不许当承诺念给用户；
 *     「旧明文配置一次性迁移」没做 → 必须列在 `SAFETY.md` 第五节的「没有做的」里。
 */

const ROOT = path.resolve(__dirname, "..", "..");

const dirs: string[] = [];
afterEach(() => {
  // 全局加密能力是进程级的：用例之间必须还原（否则后面的用例看见上一个的钥匙串）
  registerSecretCipher(null);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发占用：系统回收，不因此判红 */
    }
  }
});

function freshDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "dh-secret-"));
  dirs.push(d);
  return d;
}

/**
 * 一个假钥匙串：可切到「解不开」。
 *
 * ⚠️ 那个开关就是 P118 的诱因本身：DPAPI 抖动 / blob 损坏 / 换了用户 ——
 * `decrypt` 抛异常，而**文件还在**（于是"读不到"不等于"没有"）。
 */
function fakeCipher(opts: { available?: () => boolean } = {}): SecretCipher & { broken: boolean } {
  const c = {
    name: "测试钥匙串",
    broken: false,
    available: opts.available ?? ((): boolean => true),
    // ⚠️ 假的也要**真的遮住明文**（base64），否则"明文没落盘"那条断言测不出东西
    encrypt: (plain: string): Buffer => Buffer.from(`enc:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8"),
    decrypt: (blob: Buffer): string => {
      if (c.broken) throw new Error("DPAPI 解不开（换了用户或机器）");
      const text = blob.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("不是我们写的 blob");
      return Buffer.from(text.slice(4), "base64").toString("utf8");
    },
  };
  return c;
}

/** 直接读出 `secrets.dat` 里解码后的内容（用来验"盘上到底还有什么"）。 */
function onDisk(dir: string): Record<string, string> {
  const file = path.join(dir, SECRETS_FILE);
  const text = readFileSync(file, "utf8");
  return JSON.parse(Buffer.from(text.slice(4), "base64").toString("utf8")) as Record<string, string>;
}

describe("密钥库 · 写（审计 P118 / P114）", () => {
  let dir = "";
  beforeEach(() => {
    dir = freshDir();
  });

  it("没有加密能力时**拒绝写**，且磁盘上不留任何东西（CLI 那条路的现状）", () => {
    registerSecretCipher(null);
    expect(secretsEncrypted()).toBe(false);
    const got = writeSecret(dir, "DEEPSEEK_API_KEY", "sk-1");
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toContain("不写明文");
    expect(readSecrets(dir)).toEqual({});
    expect(() => onDisk(dir)).toThrow(); // 文件根本没建
  });

  it("有加密能力时：写进去的是**密文**（明文不许落在盘上）", () => {
    registerSecretCipher(fakeCipher());
    expect(writeSecret(dir, "DEEPSEEK_API_KEY", "sk-secret").ok).toBe(true);
    const raw = readFileSync(path.join(dir, SECRETS_FILE), "utf8");
    expect(raw.startsWith("enc:")).toBe(true);
    expect(raw.includes("sk-secret"), "明文落盘了").toBe(false);
    expect(readSecrets(dir)).toEqual({ DEEPSEEK_API_KEY: "sk-secret" });
  });

  it("⭐ 读不出旧值时必须**拒绝写**（一次临时解密失败不许把其余密钥清光）", () => {
    const cipher = fakeCipher();
    registerSecretCipher(cipher);
    expect(writeSecret(dir, "A_KEY", "sk-a").ok).toBe(true);
    expect(writeSecret(dir, "B_KEY", "sk-b").ok).toBe(true);
    expect(onDisk(dir)).toEqual({ A_KEY: "sk-a", B_KEY: "sk-b" });

    // 钥匙串抖了：文件还在，但这次解不开
    cipher.broken = true;
    const got = writeSecret(dir, "C_KEY", "sk-c");
    expect(got.ok, "读不出旧值却照样写了 —— 这一写会把 A/B 清掉").toBe(false);
    if (!got.ok) expect(got.reason).toContain("拒绝写");

    // 抖动过去之后：A/B 一条都没少，且没有偷偷写下 C
    cipher.broken = false;
    expect(onDisk(dir)).toEqual({ A_KEY: "sk-a", B_KEY: "sk-b" });
    expect(readSecrets(dir)).toEqual({ A_KEY: "sk-a", B_KEY: "sk-b" });
  });

  it("对照：正常时是**合并写**（加一条，不动其余）", () => {
    registerSecretCipher(fakeCipher());
    writeSecret(dir, "A_KEY", "sk-a");
    expect(writeSecret(dir, "C_KEY", "sk-c").ok).toBe(true);
    expect(onDisk(dir)).toEqual({ A_KEY: "sk-a", C_KEY: "sk-c" });
  });

  it("`readSecrets`（读那条路）解不开就**当没有** —— 与「写」那条路分开是刻意的", () => {
    const cipher = fakeCipher();
    registerSecretCipher(cipher);
    writeSecret(dir, "A_KEY", "sk-a");
    cipher.broken = true;
    // 读：表现为"要重新填一次 key"（换了机器/用户是正常场景），不是崩
    expect(readSecrets(dir)).toEqual({});
    // 写：同一个状态必须拒绝（上一条已钉住）
    expect(writeSecret(dir, "B_KEY", "sk-b").ok).toBe(false);
  });
});

describe("凭据保护那一格（审计 P119：三种状态都要答得出，且有测试盯着）", () => {
  it("还没存过：如实说「还没有存过」", () => {
    const dir = freshDir();
    const legacy = path.join(freshDir(), "none.yaml");
    const got = credentialProtection(dir, { legacyPath: legacy });
    expect(got.detail).toContain("还没有存过");
    expect(got.detail).not.toContain("明文");
  });

  it("存过且能加密：说清**已加密**与是哪一层（不再恒答「还没有存过」）", () => {
    const dir = freshDir();
    registerSecretCipher(fakeCipher());
    writeSecret(dir, "A_KEY", "sk-a");
    const got = credentialProtection(dir, { legacyPath: path.join(freshDir(), "none.yaml") });
    expect(got.detail).toContain("已加密");
    expect(got.detail).toContain("测试钥匙串");
    expect(got.next).toBe("无需处理");
  });

  it("有文件但解不开：如实说「解不开」，不假装已加密、也不说成没存过", () => {
    const dir = freshDir();
    writeFileSync(path.join(dir, SECRETS_FILE), "junk", "utf8");
    registerSecretCipher(null);
    const got = credentialProtection(dir, { legacyPath: path.join(freshDir(), "none.yaml") });
    expect(got.detail).toContain("解不开");
    expect(got.detail).not.toContain("还没有存过");
    expect(got.detail).not.toContain("已加密");
    expect(got.next).toMatch(/桌面端|环境变量/);
  });

  it("那条旧明文文件在时：说明文、说清**我们自己的向导也写它**（不许写成「别家的、只读」）", () => {
    const dir = freshDir();
    const legacy = path.join(freshDir(), "credentials.yaml");
    writeFileSync(legacy, "refs:\n  A_KEY: sk-plain\n", "utf8");
    const got = credentialProtection(dir, { legacyPath: legacy });
    expect(got.detail).toContain(legacy);
    expect(got.detail).toContain("明文");
    expect(got.detail, "把那条文件说成别家的、我们只读 —— 实际 ding init 向导会写它").toContain("ding init");
    expect(got.next).toMatch(/明文|环境变量/);
  });
});

describe("真话守卫（审计 P114 / P120 / D3 复核）：自述必须与实现一致", () => {
  it("⭐ 桌面那条写 key 的路真的调 `writeSecret`（它不再是零调用死代码）", () => {
    const src = readFileSync(path.join(ROOT, "electron/ipc/secretStore.ts"), "utf8");
    expect(src, "没有调用 writeSecret").toMatch(/writeSecret\(/);
    expect(src, "桌面没注册加密能力").toMatch(/registerSecretCipher\(/);
    expect(src, "桌面没注册密钥目录（存了也读不回来）").toMatch(/registerSecretDir\(/);
  });

  it("⭐ 运行时读 key 的第三段真的接进了 secretStore（存进去的能读回来）", () => {
    const src = readFileSync(path.join(ROOT, "engine/runtime/credentials.ts"), "utf8");
    expect(src).toMatch(/require\("\.\.\/adapters\/secretStore"\)/);
    expect(src).toMatch(/revealSecretFromStore/);
  });

  it("⭐ 向导那条用户可见的话不许承诺「权限 600」（Windows 上不成立）", () => {
    const src = readFileSync(path.join(ROOT, "hosts/cli/wizard.ts"), "utf8");
    /*
     * 判据只扫**代码**（把块注释与行注释剥掉）：注释里解释"为什么不再说 600"是好事，
     * 该红的是**用户会读到的那句**。剥注释是朴素做法（不引解析器），够用。
     */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code, "向导又在用户面前承诺 600 权限了").not.toMatch(/权限\s*600/);
    // 而且要**说明文**：CLI 这台机器上就是没加密，这话必须说
    expect(src).toContain("**明文**");
  });

  it("⭐ SAFETY.md 第二节两张表必须与实现一致（桌面加密 / CLI 那条是明文；不写成「别家的、只读」）", () => {
    const text = readFileSync(path.join(ROOT, "SAFETY.md"), "utf8");
    const section = text.slice(text.indexOf("## 二、密钥"), text.indexOf("## 三、会话数据"));
    expect(section.length, "没找到 SAFETY.md 第二节").toBeGreaterThan(100);
    expect(section).toContain("safeStorage");
    expect(section).toContain("credentials.yaml");
    expect(section, "第二节没有一处说明文 —— 而 CLI 向导就是写明文").toContain("明文");
    expect(section, "把那条文件说成「只读不动」而向导会写它 = 不实").toContain("ding init");
  });

  it("⭐ 「旧明文配置一次性迁移并提示」没做，就必须列在第五节的「没有做的」里", () => {
    const text = readFileSync(path.join(ROOT, "SAFETY.md"), "utf8");
    const miss = text.slice(text.indexOf("## 五、没有做的"), text.indexOf("## 六、"));
    expect(miss.length, "没找到 SAFETY.md 第五节").toBeGreaterThan(100);
    expect(miss, "没做的迁移没有列进「没有做的」").toMatch(/旧明文|迁移/);
  });

  it("简陋但必要：密钥文件常量与 doctor 那格的名字都对得上", () => {
    expect(SECRETS_FILE).toBe("secrets.dat");
    /*
     * ⚠️ 2026-10-17：doctor 本体从 `hosts/cli/doctor.ts` 搬到了 `engine/runtime/doctor.ts`
     * （桌面也要跑同一套自检，而 hosts/** 不进 Electron 构建；CLI 那侧只剩包装器）。
     * 这条判据盯的是"自检真的调了凭据那格的实现"，所以跟着实现走。
     */
    const doctor = readFileSync(path.join(ROOT, "engine/runtime/doctor.ts"), "utf8");
    expect(doctor).toContain("credentialProtection");
    mkdirSync(freshDir(), { recursive: true });
  });
});
