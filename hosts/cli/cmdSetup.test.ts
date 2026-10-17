import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgv } from "./args";
import { cmdInit } from "./cmdSetup";

/**
 * `ding init` 的接线与文案（2026-10-16，审计第 6 单）。
 *
 * ## P199 —— API key 输入脱敏（源码级判据，**未实机验**）
 *
 * `askMasked` 的逻辑已经写成"关掉 rl → raw 读 → 重建 rl"，但**本机（以及 CI）
 * 没有 TTY**：`!stdin.isTTY` 时它直接走 `plainFallback()`，那条遮蔽路径一次都跑不到。
 * 所以这里只能把**写法**钉住（关 rl 的时机、raw 模式、逐字符打 `*`、finally 里重建 rl 的顺序），
 * 并如实记"未实机验" —— 不假装跑过。
 *
 * ## P198（第二处）—— 非交互指引教的凭据格式必须**读得到**
 *
 * `doctor` 那句已改成 `refs:` + 缩进一层；`ding init` 非交互分支里那段话是**同一段错**
 * （教人写顶格一行），照它写完下次跑仍然"一条都读不到"。这里真跑一次 `cmdInit`
 * （把 stdin 强制成非 TTY），断言它印出来的形状与读取端一致。
 */

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function freshDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dh-cmdsetup-"));
  tmpDirs.push(d);
  return d;
}

const read = (rel: string): string => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");

describe("P199 —— askMasked 的写法判据（未实机验：本机无 TTY）", () => {
  it("⭐ 关掉 rl → raw 逐字符读（打 *）→ finally 里重建 rl", () => {
    const src = read("hosts/cli/cmdSetup.ts");
    // ① 非 TTY 直接退回普通问法（不装"我遮蔽了"）
    expect(/!stdin\.isTTY\)\s*return plainFallback\(\)/.test(src), "非 TTY 时没有退回普通问法").toBe(true);
    // ② 先关 rl（否则两个消费者抢同一路 data，readline 自己会把字符回显出来）
    const closeAt = src.indexOf("rlRef.current.close()");
    const rawAt = src.indexOf("stdin.setRawMode(true)");
    expect(closeAt, "没有关掉 readline").toBeGreaterThan(-1);
    expect(rawAt, "没有进 raw 模式").toBeGreaterThan(-1);
    expect(closeAt, "先开 raw 再关 rl —— 遮蔽是假的（会被 readline 回显）").toBeLessThan(rawAt);
    // ③ 每个可见字符打一个 *（不回显原文）
    expect(src, "没有打 * 的遮蔽回显").toContain('process.stdout.write("*")');
    // ④ 无论成败都要把 rl 还回去（后面还有问题要问）
    expect(/finally\s*\{[\s\S]{0,200}rlRef\.current = createInterface\(/.test(src), "finally 里没重建 readline").toBe(true);
    // ⑤ secret 选项真的被读到（原来声明了却没人实现）
    expect(/opts\?\.secret\s*\?\s*askMasked\(/.test(src), "ask 没按 secret 分流").toBe(true);
  });
});

describe("P198 —— 非交互指引教的是读得到的写法", () => {
  it("⭐ ding init 非交互分支印出的凭据格式带 refs: 段（顶格那行读不到）", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    /* 强制成非 TTY：否则 cmdInit 会进交互分支、在测试里挂住 */
    const stdin = process.stdin as { isTTY?: boolean };
    const prev = stdin.isTTY;
    stdin.isTTY = false;
    try {
      const code = await cmdInit(parseArgv(["init"]), freshDir());
      expect(code).toBe(2);
    } finally {
      stdin.isTTY = prev;
    }

    const text = out.join("");
    expect(text, "指引没提 refs 段 —— 照它写出来的 key 读不到").toContain("refs:");
    expect(text).toContain("DEEPSEEK_API_KEY");
    expect(/下面一层|缩进/.test(text), "没说清键要缩进在 refs 下面一层").toBe(true);
    expect(text, "还在教顶格一行").not.toContain("把 key 写进");
  });
});
