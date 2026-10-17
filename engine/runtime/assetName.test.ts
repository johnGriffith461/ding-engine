import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { safeLowerHint, stampOf, uniqueFilePath } from "./assetName";

/**
 * 落盘文件名的唯一化（**审计 P11 / P21**）。
 *
 * ## 这两条缺陷的判据长什么样
 *
 * · **P11**：名字里**不许有大写**（`toISOString` 的 `T` 会进 `dshasset://` 的 host，
 *   而 standard 协议把 host 小写化 → 盘上那份取不回来）；
 * · **P21**：同一时刻的两次落盘**必须拿到两个名字**（原来是"截到分钟/秒"，后者无声盖前者）。
 *
 * 这两条都**不靠读源码**判定：把 `stampOf` 改回 `toISOString().slice(0,15)`，
 * "不许有大写"与"同一毫秒两次不撞"都会红。
 */
describe("生成/导出文件的名字（P11 / P21）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dh-assetname-"));
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("⭐ 时间戳里**没有大写**（大写 T 就是 P11 那条「取不回来」的根因）", () => {
    const stamp = stampOf(new Date(2026, 9, 16, 1, 45, 12, 345));
    expect(stamp).not.toMatch(/[A-Z]/);
    expect(stamp).toBe("20261016-014512-345");
  });

  it("⭐ 同一时刻（甚至同一毫秒）两次落盘拿到**两个**名字 —— 后写的不会盖掉先写的", () => {
    const at = new Date(2026, 9, 16, 1, 45, 12, 345);
    fs.mkdirSync(tmp, { recursive: true });
    const a = uniqueFilePath(tmp, "gen", ".png", at);
    fs.writeFileSync(a, "first");
    const b = uniqueFilePath(tmp, "gen", ".png", at);
    expect(b).not.toBe(a);
    fs.writeFileSync(b, "second");
    expect(fs.readFileSync(a, "utf8")).toBe("first");
    expect(fs.readFileSync(b, "utf8")).toBe("second");
  });

  it("重名时按 -2 / -3 递增（可预期，不是随机串）", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5, 6);
    fs.mkdirSync(tmp, { recursive: true });
    const first = uniqueFilePath(tmp, "x", ".png", at);
    fs.writeFileSync(first, "1");
    const second = uniqueFilePath(tmp, "x", ".png", at);
    expect(second.endsWith("-2.png")).toBe(true);
    fs.writeFileSync(second, "2");
    const third = uniqueFilePath(tmp, "x", ".png", at);
    expect(third.endsWith("-3.png")).toBe(true);
  });

  it("hint 收成小写安全字符（能当 dshasset:// 的 host 用）", () => {
    expect(safeLowerHint("GPT-Image_2")).toBe("gpt-image2");
    expect(safeLowerHint("！！")).toBe("gen");
    expect(safeLowerHint("a".repeat(80)).length).toBeLessThanOrEqual(24);
  });
});
