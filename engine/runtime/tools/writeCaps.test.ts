import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WRITE_FILE_MODEL_BYTES, WRITE_FILE_DESC, WRITE_FILE_MODEL_CHARS } from "../../../shared/agentTools";
import { READ_MAX_BYTES, readFileForModel } from "./readTool";
import { EDIT_MAX_BYTES, editFileForModel } from "./editTool";
import { WRITE_MAX_BYTES, WRITE_MAX_CHARS, writeFileForModel } from "./writeTool";

/**
 * 「写进去的东西**读得回来**」—— 上限只有一个字节口径（审计 P234）。
 *
 * ## 这条守卫挡的是什么
 *
 * 三道闸原来各说各的：
 *   · 写（`writeTool`）：**字符**上限 200000（`content.length`）；
 *   · 读（`readTool`）：**字节**上限（`stat.size`，200000）；
 *   · 改（`editTool`）：也量 `stat.size`，却挂着一个叫 `_CHARS` 的名字。
 *
 * 后果不是"限制松了一点"，是**中文正文能写不能读**：
 * 20 万汉字写得进去（落盘 600KB），下一轮 `read_file` 直接撞 `READ_MAX_BYTES` ——
 * 用户手上多了一个自己打不开的死档，而模型以为写成功了。
 *
 * ## 现在的口径
 *
 * 只认**字节**，而且只有**一个数**：`WRITE_MAX_BYTES === READ_MAX_BYTES === EDIT_MAX_BYTES`
 * （都从 `shared/drive.ts` 的 `READ_MAX_BYTES` 来）。说明里那句"最多多少字"
 * （`WRITE_FILE_MODEL_CHARS`）是**折算**出来的，不是第二道闸。
 *
 * ⚠️ 下面第一条是**往返用例**，它按符号常量写（`"甲".repeat(WRITE_MAX_CHARS)`），
 * 所以在"退回字符口径"的世界里也照样编译、照样跑 —— 那时它会红，
 * 因为按那个口径能写进去的正文（66 万字节）已经读不回来了。
 */

let ROOT = "";
const dirs = () => [path.join(ROOT, "drive")];

beforeAll(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "dh-writecaps-"));
  mkdirSync(path.join(ROOT, "drive"), { recursive: true });
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔占着，系统会回收 */
  }
});

describe("三道闸一个字节口径（P234）", () => {
  it("⭐ 上限只有一个数：写 = 读 = 改 = shared 那一份", () => {
    expect(WRITE_MAX_BYTES, "写上限不是读回那个数 —— 又长出第二份了").toBe(READ_MAX_BYTES);
    expect(EDIT_MAX_BYTES, "改文件的上限与写不一致").toBe(READ_MAX_BYTES);
    expect(WRITE_FILE_MODEL_BYTES).toBe(READ_MAX_BYTES);
    /* 说明里那个"字数"是折算的：最坏 3 字节/码元，它不该越过字节预算 */
    expect(WRITE_FILE_MODEL_CHARS).toBe(Math.floor(WRITE_MAX_BYTES / 3));
    expect(WRITE_MAX_CHARS).toBe(WRITE_FILE_MODEL_CHARS);
    expect(3 * WRITE_MAX_CHARS).toBeLessThanOrEqual(WRITE_MAX_BYTES);
  });

  it("⭐ 说明与实现同一个数（说明里改写 20 万字而实现按字节拦，就是 P234 那条）", () => {
    expect(WRITE_FILE_DESC, "说明里的字节上限与执行体不是同一个数").toContain(String(WRITE_MAX_BYTES));
    expect(WRITE_FILE_DESC, "说明里没写清单位（模型会按「字」理解，中文就撞墙）").toContain("字节");
    expect(WRITE_FILE_DESC).toContain(String(WRITE_MAX_CHARS));
  });

  it("⭐ 写到上限的中文正文：**读得回来、也改得动**（两处都曾经撞上限）", async () => {
    const target = path.join(ROOT, "drive", "长文.md");
    const content = "甲".repeat(WRITE_MAX_CHARS); // 最坏情况：每字 3 字节
    const written = await writeFileForModel(target, content, dirs());
    expect(written.ok, "按上限写竟然失败了").toBe(true);
    if (!written.ok) return;

    /* 落盘大小正好压在读回上限上（不是"写得下、读不下"） */
    expect(statSync(target).size).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(written.bytes).toBeLessThanOrEqual(READ_MAX_BYTES);

    const read = await readFileForModel(target, dirs());
    expect(read.ok, "刚写好的正文读不回来 —— 上限不是同一个口径（P234 的原样重现）").toBe(true);

    /* `replaceAll`：这段正文本来就重复（判据要的是"文件大到这个上限还改得动"，不是唯一性） */
    const edited = await editFileForModel(target, "甲".repeat(10), "乙", dirs(), true);
    expect(edited.ok, "刚写好的文件改不动（改的上限也不是同一个口径）").toBe(true);
  });

  it("超一个字节就拒绝（判据是字节，不是字）", async () => {
    const over = "甲".repeat(WRITE_MAX_CHARS + 1); // 200_001 字节
    const got = await writeFileForModel(path.join(ROOT, "drive", "超一点.md"), over, dirs());
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.error).toContain("字节");
    expect(got.error).toContain("太长");
  });

  it("英文照旧能写满整个字节预算（不许因为改口径就把它一起缩掉）", async () => {
    const target = path.join(ROOT, "drive", "ascii.txt");
    const got = await writeFileForModel(target, "a".repeat(WRITE_MAX_BYTES), dirs());
    expect(got.ok, "ASCII 写到字节上限就失败了 —— 收窄过头了").toBe(true);
  });
});
