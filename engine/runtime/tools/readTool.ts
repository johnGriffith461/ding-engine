import fs from "node:fs/promises";
import path from "node:path";
import { insideDirs } from "./drivePaths";

/**
 * 「读文件」工具的执行体（2026-10-14）。
 *
 * ## 为什么单独一个文件
 * 与 `drivePaths.ts` 同一个理由：这个文件**只依赖 `node:` 与纯函数**，
 * 不 `import electron` —— 于是它能在 `src/**` 的 vitest 里被直接调用做真断言
 * （主进程那边的 vitest 配置收不到）。边界判断、截断、各种"读不到"的分支
 * 都能在这里被钉住，不用真启一个应用。
 *
 * ## 与 `drive:read` 是**同一道边界**
 * 目录白名单走同一个 `insideDirs`，大小上限沿用同一个数 ——
 * 两边各写一份的话，"界面上能读的"和"agent 能读的"迟早会分叉，
 * 而分叉的方向通常是**其中一边变松**（那才是危险的那边）。
 */

/**
 * 一次读取的字节上限：与 `drive:read` 一致（超过就不读，别把几兆塞进内存）。
 *
 * ⚠️ 它同时是**写入与改动的上限**（审计 P234）：`writeTool.WRITE_MAX_BYTES` 与
 * `editTool.EDIT_MAX_BYTES` 都直接取这个数，所以"写得进去的东西一定读得回来、
 * 改得动"是一条能证明的不变量，而不是三个数碰巧一样大。
 * 与 `shared/drive.ts` 那个同值由 `src/sharedContract.test.ts ②` 对账。
 */
export const READ_MAX_BYTES = 200_000;

/** 给模型的正文上限（超出截断，并注明原文长度）。 */
export const MODEL_MAX_CHARS = 8000;

/** 读文件的结果。 */
export type ReadFileResult =
  | { ok: true; text: string; chars: number; truncated: boolean; totalChars: number }
  | { ok: false; error: string };

/** 按文件名找文件时最多往下看几层目录（云盘是浅结构，深挖没意义）。 */
const NAME_SEARCH_DEPTH = 3;

/**
 * 按**文件名**在可读目录里找文件（2026-10-14 补）。
 *
 * ## 为什么需要
 * `read_file` 一开始只认绝对路径 —— 可模型**根本不知道路径**：
 * 用户说"把云盘里的季度总结.md 读一下"，模型手上只有这个名字，
 * 而文件实际在 `<userData>/drive/季度总结.md`。于是这个工具在真实场景里用不起来
 * （只有"用户把完整路径给了它"这一种情况能 work）。
 *
 * @param name 文件名；可以带子目录（如 `报告/季度.md`）
 * @param dirs 可读目录白名单
 * @returns 命中的绝对路径（可能多个；由调用方决定"多个怎么办"）
 */
export async function findByFileName(name: string, dirs: readonly string[]): Promise<string[]> {
  const wanted = name.replace(/\\/g, "/").replace(/^\.\//, "");
  const hits: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > NAME_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; /* 读不了的目录跳过（不是错误：可能刚被删） */
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const normalized = full.replace(/\\/g, "/");
      if (wanted.includes("/") ? normalized.endsWith(`/${wanted}`) : entry.name === wanted) {
        hits.push(full);
      }
    }
  };

  for (const dir of dirs) await walk(dir, 1);
  return hits;
}

/**
 * 读一个用户目录里的文本文件，读成"给模型看的样子"。
 *
 * ⚠️ **失败一律如实回报**（哪一步失败、为什么），不返回空串：
 * 模型的默认行为是"看不到就猜"，而一句准确的"读不到，因为 X"能让它说实话
 * 或者换一条路（12-factor 的 Factor 9：错误要压缩成上下文的一部分）。
 *
 * @param rawPath 模型给过来的路径（**不可信**）
 * @param dirs 允许读取的目录白名单（绝对路径）
 * @param maxChars 给模型的正文上限
 * @returns 读到的正文，或者一条说清原因的失败
 */
export async function readFileForModel(
  rawPath: string,
  dirs: readonly string[],
  maxChars: number = MODEL_MAX_CHARS,
): Promise<ReadFileResult> {
  /*
   * 先按路径认；认不出来、而且给的**不是绝对路径**时，再按文件名找一次。
   * 顺序很重要：路径能认出来就别用名字搜（同名文件可能有多个）。
   * 为什么需要这一步见 `findByFileName` 的说明 —— 模型经常只知道文件名。
   */
  const byPath = insideDirs(rawPath, dirs);
  if (!byPath && !path.isAbsolute(rawPath)) {
    const hits = await findByFileName(rawPath, dirs);
    if (hits.length === 1) return readResolved(hits[0], maxChars);
    if (hits.length > 1) {
      /*
       * ⚠️ 同名多个**不猜**：把候选原样给模型（它才知道该读哪一个）。
       * 猜一个读下去是最坏的结果 —— 读错了文件还理直气壮地总结。
       */
      return {
        ok: false,
        error: `找到 ${hits.length} 个同名文件，请用完整路径指定一个：${hits.join(" / ")}`,
      };
    }
    return { ok: false, error: `没找到叫「${rawPath}」的文件（也可以直接给完整路径）` };
  }
  if (!byPath) {
    /*
     * 不说"权限不足"这种含糊话：把**能读的范围**讲清楚，
     * 模型才知道下一步该找用户要文件、还是从文件列表里挑一个。
     */
    return { ok: false, error: "这个路径不在可读范围内（只能读用户的云盘 / 产物 / 导出目录）" };
  }
  return readResolved(byPath, maxChars);
}

/**
 * 读一个**已经通过校验**的绝对路径。
 *
 * 抽出来是为了让两条入口（给的路径 / 按名字找到的路径）共用同一段
 * "stat → 大小 → 读 → 二进制判定 → 截断" —— 否则"按名字找"那条迟早会少一步检查。
 *
 * @param target 已通过白名单校验的绝对路径
 * @param maxChars 给模型的正文上限
 * @returns 读到的正文，或者一条说清原因的失败
 */
async function readResolved(target: string, maxChars: number): Promise<ReadFileResult> {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return { ok: false, error: "文件不存在，或者读不了（检查一下路径）" };
  }
  if (stat.isDirectory()) {
    /* 目录不是"读不到"，而是"这个工具不干这个" —— 说清区别，模型才不会反复试。 */
    return { ok: false, error: "这是一个目录，不是文件" };
  }
  if (stat.size > READ_MAX_BYTES) {
    return { ok: false, error: `文件太大（${Math.round(stat.size / 1024)}KB，上限 ${Math.round(READ_MAX_BYTES / 1024)}KB）` };
  }

  let text: string;
  try {
    text = await fs.readFile(target, "utf8");
  } catch {
    return { ok: false, error: "读出错（可能是二进制文件或编码不是 UTF-8）" };
  }

  /*
   * 二进制文件用 utf8 强读会得到一堆替换字符（U+FFFD）——
   * 与其把垃圾喂给模型，不如直说"这像是二进制文件"。
   * 判据：替换字符占比超过 1%（正常文本几乎不会有）。
   */
  const replacement = (text.match(/\uFFFD/g) ?? []).length;
  if (text.length > 0 && replacement / text.length > 0.01) {
    return { ok: false, error: "这看起来是二进制文件（不是文本），读不了" };
  }

  const total = text.length;
  const truncated = total > maxChars;
  const shown = truncated ? text.slice(0, maxChars) : text;
  return { ok: true, text: shown, chars: shown.length, truncated, totalChars: total };
}

/** 工具返回给模型的那一句话（成败都在这儿收口，界面上那行留痕也用它）。 */
export function describeReadResult(result: ReadFileResult, filePath: string): string {
  const name = path.basename(filePath);
  if (!result.ok) return `读不了「${name}」：${result.error}`;
  if (result.truncated) {
    return `读了「${name}」（前 ${result.chars} 字，原文 ${result.totalChars} 字）`;
  }
  return `读了「${name}」（${result.chars} 字）`;
}
