import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { findSandboxBinary, probeSandbox, resetSandboxProbeCache } from "./sandbox";

/**
 * 沙箱二进制的**查找顺序**与**探测缓存**（**审计 P117 / P98**）。
 *
 * ## P117：注释与实现不符的三处
 *
 * `findSandboxBinary` 的文件头一直写着「显式配置 → 仓库构建产物 → **PATH**」，
 * 而代码里**根本没有 PATH 查找**；`DING_SANDBOX` 指到不存在的路径时**静默忽略**
 * （用户以为指定了那份，实际在用别的或没有）。
 *
 * 这一组钉：**PATH 上那份真的会被找到**、**配错的那个确实被说出来**。
 * 把 `pathCandidates` 从候选里删掉、或把 misconfigured 那段注释掉，这一组就红。
 *
 * ## P98：热路径不该每条命令都 spawn 一次探测
 *
 * `planSandboxed` 在**每条 `run_command`** 上被调用，而探测是
 * `spawnSync(..., {timeout:10_000})` —— 沙箱二进制在但响应慢时整段主进程都停住。
 * 判据用**对象身份**：同一个候选环境下两次 `probeSandbox()` 应当拿到**同一个对象**
 * （= 真的走了缓存），而 `{refresh:true}` 必须重新探（那是 doctor 与"刚编出来"的用法）。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dh-sandbox-find-"));
const binDir = path.join(tmp, "bins");
const emptyDir = path.join(tmp, "empty");
const cwdDir = path.join(tmp, "cwd");
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(emptyDir, { recursive: true });
fs.mkdirSync(cwdDir, { recursive: true });
const NAME = process.platform === "win32" ? "ding-sandbox.exe" : "ding-sandbox";
const SEP = process.platform === "win32" ? ";" : ":";

const origPath = process.env.PATH;
const origConfigured = process.env.DING_SANDBOX;
let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  resetSandboxProbeCache();
  /*
   * 让"仓库构建产物"那两条候选落空：把 cwd 指到一个空目录。
   * （本机真的编过 `pnpm sandbox:build` 时，不这么做就会先命中仓库里那份，测不到 PATH。）
   */
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
});

afterEach(() => {
  cwdSpy?.mockRestore();
  cwdSpy = null;
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origConfigured === undefined) delete process.env.DING_SANDBOX;
  else process.env.DING_SANDBOX = origConfigured;
  resetSandboxProbeCache();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("查找顺序（P117）", () => {
  it("⭐ PATH 上那份真的会被找到（注释里一直写着、代码里原来没有）", () => {
    delete process.env.DING_SANDBOX;
    const fake = path.join(binDir, NAME);
    fs.writeFileSync(fake, "not a real binary", "utf8");
    process.env.PATH = `${binDir}${SEP}${emptyDir}`;
    expect(findSandboxBinary()).toBe(fake);
  });

  it("⭐ DING_SANDBOX 配错（路径不存在）会被**说出来**，不是静默忽略", () => {
    const bogus = path.join(tmp, "nope", NAME);
    process.env.DING_SANDBOX = bogus;
    process.env.PATH = emptyDir; // 也没有别的候选可命中
    expect(findSandboxBinary()).toBe("");
    const info = probeSandbox();
    expect(info.found).toBe(false);
    expect(info.note, "配错的 DING_SANDBOX 必须出现在给用户看的那句话里").toContain("DING_SANDBOX");
    expect(info.note).toContain(bogus);
  });
});

describe("探测缓存（P98）", () => {
  it("⭐ 热路径两次探测拿到**同一个对象**（真的没重复 spawn）", () => {
    process.env.PATH = emptyDir;
    delete process.env.DING_SANDBOX;
    const first = probeSandbox();
    const second = probeSandbox();
    expect(second, "两次探测不是同一个对象 —— 缓存没生效（每条 run_command 都会 spawn 一次）").toBe(first);
  });

  it("`{refresh:true}` 会重新探（doctor 与「刚编出来」要的就是它）", () => {
    process.env.PATH = emptyDir;
    delete process.env.DING_SANDBOX;
    const first = probeSandbox();
    const refreshed = probeSandbox({ refresh: true });
    expect(refreshed).not.toBe(first);
  });
});
