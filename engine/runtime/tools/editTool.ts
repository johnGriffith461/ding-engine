import fs from "node:fs/promises";
import path from "node:path";

import { WRITE_MAX_BYTES, resolveWriteTarget } from "./writeTool";

/**
 * 「改文件」工具的执行体（2026-10-14）。
 *
 * ## 为什么必须有它（而不是"重写整个文件"）
 * 「写文件」只能整文件覆盖：想让 agent 把某个文件里的一行改掉，
 * 它得把全文读回来、改一个字、再整篇写回去 —— 中间任何一步出岔子（截断、并发改动）
 * 就**把用户整个文件毁了**。参考实现里这一条是标配（opencode 的 `edit`、
 * Cline 的 `replace_in_file`），语义也一致：**精确文本替换**。
 *
 * ## 语义（照 opencode `tool/plugin/edit.ts` 的规矩，逐条注明）
 * - `oldText` 要**逐字一致**（含缩进）；找不到就报错，不猜；
 * - **默认必须唯一**：命中多处就失败，并告诉你命中了几处、在哪几行 ——
 *   这是"别在没看清的地方乱改"的护栏（opencode 原文：multiple matches FAIL
 *   unless replaceAll is true）；
 * - `replaceAll: true` 才替换全部（改名这类"本来就该全改"的操作用它）；
 * - 空 `oldText` / 新旧相同 → 各自给一句明确的话（别让它以为改成功了）。
 *
 * ## 两处本机自己加的（参考实现没有）
 * 1. **行尾保持**：文件是 CRLF 就还按 CRLF 写回去。不这么做的话，
 *    一次小改会把整文件的行尾换掉 —— 在 git 里就是"整文件重写"（本仓为此吃过三条红的守卫）。
 * 2. **弯引号/破折号的容忍重试**：中文文本里 `“ ” ’ —` 与 `" " ' -` 肉眼几乎一样，
 *    模型抄错一个字符就整条失败。所以第一次逐字找不到时，会在
 *    "忽略这些排版差异"的口径下再找一次，命中就照改，**并在结果里说明是按哪种口径命中的**
 *    （不隐瞒：让读的人知道这次不是逐字匹配）。
 */

/**
 * 一次编辑的上限：**字节**，与写文件、读回同一个数（审计 P234）。
 *
 * ⚠️ 它原来是 `EDIT_MAX_CHARS = WRITE_MAX_CHARS` 而拿去比 `stat.size` ——
 * **名字说字符、量的却是字节**：写侧当年按字符（中文能写出 600KB 的文件），
 * 这里按字节，于是"刚让模型写好的中文长文立刻改不动"。三处（写 / 读 / 改）
 * 现在统一在同一个字节预算上：改文件不会比写文件更宽，也不会更窄。
 */
export const EDIT_MAX_BYTES = WRITE_MAX_BYTES;

/** 结果。 */
export type EditFileResult =
  | { ok: true; path: string; replaced: number; line: number; fuzzy: boolean }
  | { ok: false; error: string };

/** 排版差异的归一：弯引号 / 破折号 / 全角空格 → 直引号 / 直线 / 普通空格。 */
function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201C\u201D]/g, (c) => (c === "\u2018" || c === "\u2019" ? "'" : '"'))
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u3000/g, " ")
    .replace(/\u00a0/g, " ");
}

/** 数一段文本在另一段里出现的次数。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/**
 * 在一个已存在的文件里做精确替换。
 *
 * @param rawPath 目标文件（不可信；与写文件同一条白名单，也支持只给文件名）
 * @param oldText 要替换掉的原文（逐字）
 * @param newText 换成什么
 * @param dirs 允许改的目录白名单
 * @param replaceAll 是否替换全部（默认 false = 必须唯一）
 * @returns 成功给出落点与替换了几处；失败给出**能照着做**的理由
 */
export async function editFileForModel(
  rawPath: string,
  oldText: string,
  newText: string,
  dirs: readonly string[],
  replaceAll = false,
): Promise<EditFileResult> {
  const target = resolveWriteTarget(rawPath, dirs);
  if (!target) {
    return { ok: false, error: "这个路径不在可改范围内（只能改你授权目录里的文件）" };
  }
  if (typeof oldText !== "string" || oldText === "") {
    return { ok: false, error: "oldText 是空的 —— 新建文件用 write_file，这里只用来改已有文件里的某一段" };
  }
  if (oldText === newText) {
    return { ok: false, error: "新旧文本一样，改了等于没改（说明一下你到底想改成什么）" };
  }

  let raw: string;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return { ok: false, error: "这是一个目录，不是文件" };
    if (stat.size > EDIT_MAX_BYTES) {
      return { ok: false, error: `文件太大（${Math.round(stat.size / 1024)}KB），不适合整篇读进来改` };
    }
    raw = await fs.readFile(target, "utf8");
  } catch {
    return { ok: false, error: "文件不存在或者读不了（先用 read_file 看一眼它还在不在）" };
  }

  /*
   * 行尾：判一次，改完按原样写回。`eol` 只在写回时用，匹配一律在 LF 口径下做
   * （否则模型给的 `\n` 在 CRLF 文件里一条都匹配不上 —— 这是最常见的"明明抄对了却找不到"）。
   */
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const source = raw.replace(/\r\n/g, "\n");
  const wanted = oldText.replace(/\r\n/g, "\n");
  const replacement = newText.replace(/\r\n/g, "\n");

  /*
   * 命中的**位置**（在归一化坐标系里算）。`normalizeTypography` 是逐字符 1:1 替换，
   * 所以那个坐标与原文一一对应 —— 用位置而不是"文本"来做替换，
   * 才能在"容忍排版差异"那一路里**只动命中的那一段**：
   * 否则会把文件里其它弯引号也一起改成直引号（静默改用户的东西，比不改还坏）。
   */
  let hits = countOccurrences(source, wanted);
  /*
   * ⚠️ 逐字命中时也要把**位置**算出来（`from`）。
   * 第一版忘了这一句，`from` 一直是 0，于是替换发生在文件开头 ——
   * 三条测试当场红（"唯一命中"那条连行号都报成了第 1 行）。
   * 教训：把"命中文本"换成"命中位置"之后，**每一条路径都要自己算位置**。
   */
  let from = hits > 0 ? source.indexOf(wanted) : 0;
  let spanLen = wanted.length;
  let fuzzy = false;
  if (hits === 0) {
    /* 第二次：只在排版差异（弯引号 / 破折号 / 全角空格）上放宽 —— 命中了会如实说明 */
    const srcN = normalizeTypography(source);
    const oldN = normalizeTypography(wanted);
    /*
     * ⚠️ 判据是**文件那一侧**确实有排版字符（`srcN !== source`），
     * 而不是"模型给的文本变了" —— 实际情形几乎都是反过来的：
     * 文件里是中文弯引号、模型抄回来的是直引号。写成后者会**一次都不生效**
     * （第一版就是这么写的，测试当场逮到）。
     */
    const n = countOccurrences(srcN, oldN);
    if (srcN !== source && n > 0) {
      hits = n;
      fuzzy = true;
      from = srcN.indexOf(oldN);
      spanLen = oldN.length;
    }
  }

  if (hits === 0) {
    return {
      ok: false,
      error: `在「${path.basename(target)}」里找不到这段原文（要逐字一致，空格与缩进都算）—— 先 read_file 看一眼现在的样子`,
    };
  }

  /* 把命中位置都算出来（`replaceAll` 才算全部；否则只取第一处） */
  const spans: Array<{ at: number; len: number }> = [];
  {
    const space = fuzzy ? normalizeTypography(source) : source;
    const needle = source.slice(from, from + spanLen);
    let at = space.indexOf(fuzzy ? normalizeTypography(needle) : needle);
    while (at !== -1 && spans.length < 10_000) {
      spans.push({ at, len: spanLen });
      at = space.indexOf(fuzzy ? normalizeTypography(needle) : needle, at + spanLen);
    }
  }

  if (spans.length > 1 && !replaceAll) {
    const lines = spans.slice(0, 5).map((span) => source.slice(0, span.at).split("\n").length);
    return {
      ok: false,
      error: `这段原文在文件里出现了 ${spans.length} 处（第 ${lines.join(" / ")} 行附近），不确定要改哪一处 —— 把上下文写长一点让它唯一，或者用 replaceAll 全改`,
    };
  }
  const picked = replaceAll ? spans : spans.slice(0, 1);
  if (!picked.length) return { ok: false, error: "替换之后文件没有任何变化" };

  let after = "";
  let cursor = 0;
  for (const span of picked) {
    after += source.slice(cursor, span.at) + replacement;
    cursor = span.at + span.len;
  }
  after += source.slice(cursor);
  if (after === source) return { ok: false, error: "替换之后文件没有任何变化" };

  /* 第一处命中之前有几个换行 = 第几行（1 起算），给留痕用 */
  const line = source.slice(0, picked[0].at).split("\n").length;

  try {
    await fs.writeFile(target, eol === "\r\n" ? after.replace(/\n/g, "\r\n") : after, "utf8");
  } catch (e) {
    return { ok: false, error: `改完写不回去（${e instanceof Error ? e.message : String(e)}）` };
  }

  return { ok: true, path: target, replaced: picked.length, line, fuzzy };
}

/**
 * 把结果说成**一句话**（界面留痕与回给模型共用）。
 *
 * @param result 上面的结果
 * @param rawPath 原样回显的路径（失败时用）
 * @returns 一句话
 */
export function describeEditResult(result: EditFileResult, rawPath: string): string {
  if (!result.ok) return `改不了「${rawPath}」：${result.error}`;
  const how = result.replaced > 1 ? `${result.replaced} 处` : `第 ${result.line} 行`;
  const tail = result.fuzzy ? "（按忽略引号/破折号差异匹配）" : "";
  return `改了「${path.basename(result.path)}」的${how}${tail}`;
}
