import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pendingApprovalNotice, softLimitNotice, toolFailedNotice, unknownToolNotice } from "@engine/core/notices";

/**
 * Factor 9 错误回注三件套（Phase 3.1）。
 *
 * ## 为什么这组断言值得单独立一个文件
 *
 * "工具出错时模型看见什么"一共只有三种情形，而它们原来分散在三个文件里，
 * 其中"执行失败"甚至没有一句自己的话（执行体随手 `new Error(...)`）。
 * 分散的代价是两个宿主对同一件事说不同的话 —— 那种差别**没有东西会报**，
 * 只会表现为"桌面里它能自己纠正，CLI 里它一直重试"。
 *
 * 所以这里钉两件事：
 * ① 三句话各自**必须包含**什么（缺了就红，而不是"读起来差不多"）；
 * ② 它们**只在 `engine/core/notices.ts` 定义**（别处再造一份就红）。
 */

describe("错误回注三件套 · 内容", () => {
  it("未知工具：必须**列出可用工具**（否则模型只会换个名字继续猜）", () => {
    const msg = unknownToolNotice("remember_this");
    expect(msg).toContain("没有名为「remember_this」的工具");
    expect(msg).toContain("read_file");
    expect(msg).toContain("write_file");
    expect(msg).toContain("run_command");
  });

  it("未知工具 + 参数原因：两个信息都要在（名字 + 为什么）", () => {
    const msg = unknownToolNotice("memory_save", "text 太长");
    expect(msg).toContain("memory_save");
    expect(msg).toContain("text 太长");
    expect(msg).toContain("重试");
  });

  it("⭐ 闸门拦截：必须同时说清「没执行」与「别再试」", () => {
    const msg = pendingApprovalNotice("write_file", "按需确认");
    expect(msg).toContain("write_file");
    expect(msg).toContain("按需确认");
    // 少了这句，用户会以为事已经做完了
    expect(msg).toContain("还没有执行");
    // 少了这句，模型会在同一轮里反复试同一个工具
    expect(msg).toContain("不要重试");
  });

  it("执行失败：工具名与原因都要出现（只说'失败了'等于没说）", () => {
    expect(toolFailedNotice("read_file", "这个路径不在可读写范围内")).toBe("这个路径不在可读写范围内");
    const bare = toolFailedNotice("read_file");
    expect(bare).toContain("read_file");
    expect(bare.length).toBeGreaterThan(8);
  });

  it("执行体给的原因**原样保留**（各工具那句原因是它们自己最清楚的）", () => {
    const detail = "只能写这些目录里的文件：C:\\work";
    expect(toolFailedNotice("write_file", detail)).toBe(detail);
  });
});

describe("错误回注三件套 · 单一来源", () => {
  const ROOT = path.resolve(__dirname, "..", "..");

  /** 递归收源码文件（跳过 node_modules 与测试）。 */
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sources(full, out);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }

  it("⭐ 三句话**只有一处实现**（别处再造一份 = 两个宿主开始各说各的）", () => {
    const files = [...sources(path.join(ROOT, "src")), ...sources(path.join(ROOT, "shared")), ...sources(path.join(ROOT, "engine")), ...sources(path.join(ROOT, "electron")), ...sources(path.join(ROOT, "hosts"))];
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      if (rel === "engine/core/notices.ts") continue; // 这就是那一处
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const fn of ["unknownToolNotice", "pendingApprovalNotice", "toolFailedNotice"]) {
        if (new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`).test(code)) offenders.push(`${rel} → ${fn}`);
      }
    }
    expect(offenders, `这些地方又造了一份错误回注文案 —— 请改用 engine/core/notices.ts：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("两个宿主都从同一处取（不是各自写一句）", () => {
    for (const host of ["electron/ipc/tools.ts", "hosts/cli/tools.ts"]) {
      const code = readFileSync(path.join(ROOT, host), "utf8");
      expect(code, `${host} 没有从内核的 notices 取错误回注文案`).toContain('from "../../engine/core/notices"');
      expect(code).toContain("unknownToolNotice");
    }
  });
});

describe("软限额提示（Phase 13.2：提示，不硬断）", () => {
  it("说清花了多少、限额多少、还有百分比", () => {
    const text = softLimitNotice(0.8, 1, 0.8);
    expect(text).toContain("0.80");
    expect(text).toContain("1.00");
    expect(text).toContain("80%");
  });

  it("⭐ 说清「不会拦你」——否则用户以为下一轮跑不动了，反而不敢用", () => {
    expect(softLimitNotice(0.5, 1, 0.5)).toContain("不会拦你");
    expect(softLimitNotice(2, 1, 2)).toContain("不会拦你");
  });

  it("超了就说超了（措辞与「快到了」不一样）", () => {
    const over = softLimitNotice(1.5, 1, 1.5);
    expect(over).toContain("超过");
    const near = softLimitNotice(0.9, 1, 0.9);
    expect(near).toContain("快到");
    expect(over).not.toBe(near);
  });

  it("小额不显示成 $0.00（那看着像坏了）", () => {
    const tiny = softLimitNotice(0.0014, 0.01, 0.14);
    expect(tiny).toContain("$0.0014");
    /*
     * ⚠️ 判据要精确到"那一整个数字"：`toContain("已用 $0.00")` 会被 $0.0014 **误命中**
     * （它确实以 "$0.00" 开头）—— 第一版就是这么写的，红的是断言不是产品。
     */
    /*
     * ⚠️ 这个正则原来写成 `/$$0\.00[^0-9]/` —— `$` 是**零宽断言**，两个 `$` 之后
     * 还要接 `0.00`，整个式子**永不匹配**，于是这条负断言恒真（审计 G84）。
     * 现在是 `\$`（字面量美元符），它真的会去文本里找 "$0.00 后面不是数字"。
     */
    expect(tiny).not.toMatch(/\$0\.00[^0-9]/);
  });

  it("⭐ 花的钱标了「估算」口径（审计 P152：不能与真账单同一句话不区分）", () => {
    const text = softLimitNotice(0.8, 1, 0.8);
    expect(text, "估算口径要在文案里看得见").toContain("按目录单价估");
    expect(text).toContain("约 $");
  });

  it("告诉用户怎么调、怎么关", () => {
    const text = softLimitNotice(0.5, 1, 0.5);
    expect(text).toContain("softLimitUsd");
    expect(text).toContain("0");
  });
});
