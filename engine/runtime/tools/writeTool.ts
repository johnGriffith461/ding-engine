import fs from "node:fs/promises";
import path from "node:path";
import { insideDirs } from "./drivePaths";
import { WRITE_FILE_MODEL_BYTES, WRITE_FILE_MODEL_CHARS } from "../../../shared/agentTools";

/**
 * 「写文件」工具的执行体（2026-10-14）。
 *
 * ## 为什么单独一个文件
 * 与 `readTool.ts` 同一个理由：这里**只依赖 `node:` 与纯函数**，不 `import electron` ——
 * 于是边界判断的每一条分支都能在 `src/**` 的 vitest 里被直接调用、被钉住
 * （主进程那边收不到测试）。写文件是**不可逆**的那一类动作，
 * 每一条拒绝理由都得有断言盯着，不能靠"真起个应用手点一遍"来验。
 *
 * ## 边界（与 `drive:read` / `read_file` 是同一道墙）
 * 目录白名单走同一个 `insideDirs`（用户的云盘 / 产物 / 导出目录），
 * 墙外一律写不了。**默认不覆盖**：同名文件存在就报错并把"怎么才覆盖"说清楚 ——
 * 覆盖是不可逆的，让模型每次都显式要一次。
 */

/**
 * 一次写入的**字节**上限 —— 与读回上限、改动上限**同一个数**（审计 P234）。
 *
 * 为什么要从 shared import 而不是在这里再写一个 200_000：
 * 这个数同时出现在"工具说明（给模型看）"和"执行体（真拦）"两处，
 * 各写一份的话，"说明里 200000、执行体里 20000"这种漂移没人会立刻发现 ——
 * 模型照着说明写、被拒，然后开始瞎猜。**一个数只有一份来源。**
 *
 * 为什么是**字节**而不是字符（这就是 P234 修的那条）：
 * 写进去的东西**下一轮就要被读回来**（`readTool.READ_MAX_BYTES`）**并且要能被改**
 * （`editTool` 量的是同一个 `stat.size`），那两处天生是字节口径（`stat.size`）。
 * 按字符算的时候：中文正文 20 万字 = 落盘 600KB，写得进去、读不出来 ——
 * 用户手上多了一个自己打不开的死档。现在写侧也按字节算（同一个数），
 * 于是"写进去的一定读得回来、改得动"是**一条能证明的不变量**（见
 * `writeCaps.test.ts` 的往返用例）。
 */
export const WRITE_MAX_BYTES = WRITE_FILE_MODEL_BYTES;

/**
 * 说明里那个"最多多少字"（UTF-8 最坏 3 字节/码元折算）。
 *
 * ⚠️ **不是第二道闸**（闸只有上面那条字节上限）：它只用于把上限说成人话，
 * 由 `writeCaps.test.ts` 钉住"它没超过字节预算"。留着这个名字是因为
 * 调用方（测试与说明）原来就按"字"理解这个上限。
 */
export const WRITE_MAX_CHARS = WRITE_FILE_MODEL_CHARS;

/** 写文件的结果。 */
export type WriteFileResult =
  | { ok: true; path: string; chars: number; bytes: number; created: boolean }
  | { ok: false; error: string };

/**
 * 明确**写不了**的扩展名（这些是二进制格式，用文本写进去只会得到一个坏文件）。
 *
 * ⚠️ 这是**黑名单**而不是白名单，是有意的：认不出来的扩展名（`.log` / `.env` /
 * `.toml` / 没有扩展名）**照样放行** —— 白名单会把"用户自己的冷门文本格式"一并挡在门外，
 * 那不是安全，是坏掉。要挡的只是"确定是二进制"的那些。
 */
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "tif", "tiff", "avif",
  "pdf", "docx", "xlsx", "pptx", "zip", "gz", "tar", "7z", "rar",
  "mp3", "wav", "m4a", "flac", "ogg", "mp4", "mov", "webm", "mkv", "avi",
  "exe", "dll", "so", "dylib", "woff", "woff2", "ttf", "otf", "sqlite", "db",
]);

/** 取扩展名（小写、不含点）；没有扩展名返回空串。 */
function extOf(name: string): string {
  const base = String(name ?? "").trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  // `dot <= 0` 同时挡掉"没有扩展名"与"`.gitignore` 这种以点开头的名字"
  return dot <= 0 ? "" : base.slice(dot + 1);
}

/**
 * 把"模型给的路径"解析成**绝对落点**。
 *
 * ## 为什么必须支持"只给文件名"
 * 模型**不知道** `<userData>/drive/` 这串绝对路径（它看不到用户目录长什么样）。
 * `read_file` 那边已经踩过同一个坑：只认绝对路径的工具在真实对话里用不起来 ——
 * 用户说"存成一份纪要"，模型手上只有"纪要.md"这个名字。
 * 所以只给文件名时落到**第一个可写目录**（用户的云盘根），
 * 这与云盘页"新建文件就在云盘根"是同一个行为。
 *
 * ⚠️ 拼出来的路径**照样要过白名单**：`path.join` 会把 `../` 解掉，
 * 于是"名字里带 `..`"的那种偷跑会被 `insideDirs` 挡在门外。
 *
 * @param rawPath 模型/界面给的路径（不可信）
 * @param dirs 可写目录白名单（绝对路径）
 * @returns 通过校验的绝对落点；不通过返回 `null`
 */
export function resolveWriteTarget(rawPath: string, dirs: readonly string[]): string | null {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return null;
  const bare = !raw.includes("/") && !raw.includes("\\");
  if (!bare) return insideDirs(raw, dirs);
  if (!dirs.length) return null;
  return insideDirs(path.join(dirs[0], raw), dirs);
}

/**
 * 写一个文本文件到用户的云盘 / 产物 / 导出目录。
 *
 * @param rawPath 目标路径（**渲染进程/模型给的，一律不可信**）
 * @param content 正文（UTF-8）
 * @param dirs 允许写的目录白名单（绝对路径）
 * @param overwrite 是否允许覆盖已存在的同名文件（默认 `false`）
 * @returns 写成功给出落点与字节数；写不了给出**能照着做**的理由
 */
export async function writeFileForModel(
  rawPath: string,
  content: string,
  dirs: readonly string[],
  overwrite = false,
): Promise<WriteFileResult> {
  const target = resolveWriteTarget(rawPath, dirs);
  if (!target) {
    /*
     * 不说"权限不足"：把**能写的范围**讲清楚，模型才知道下一步该怎么办
     * （改个文件名放到云盘里，而不是反复试同一个墙外的路径）。
     */
    return { ok: false, error: "这个路径不在可写范围内（只能写用户的云盘 / 产物 / 导出目录）" };
  }

  if (typeof content !== "string") {
    return { ok: false, error: "正文不是文本" };
  }
  /*
   * ⚠️ 判据是**字节**（审计 P234）：落盘大小就是字节，读回（`READ_MAX_BYTES`）与改动
   * （`editTool`）量的也是字节。按字符判时"中文 20 万字"能写进去、600KB 落盘，
   * 下一轮读不回来 —— 那是把限制放错了单位。
   */
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WRITE_MAX_BYTES) {
    return {
      ok: false,
      error: `正文太长（${bytes} 字节，上限 ${WRITE_MAX_BYTES} 字节，约 ${WRITE_MAX_CHARS} 个汉字）—— 拆成几个文件写`,
    };
  }

  const ext = extOf(target);
  if (BINARY_EXT.has(ext)) {
    return {
      ok: false,
      error: `写文件只写 UTF-8 文本，写不了 .${ext} 这种二进制格式（图片/压缩包/音视频要用生成或上传，不是这个工具）`,
    };
  }

  /*
   * 先看目标现在是什么。
   * `stat` 失败当"不存在"处理（新文件是正常路径），但**目录要单独挡** ——
   * 那是"这个工具不干这个"，不是"不存在"，说清楚模型才不会换个名字接着撞。
   */
  let existing: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    existing = await fs.stat(target);
  } catch {
    existing = null;
  }
  if (existing?.isDirectory()) {
    return { ok: false, error: "这个路径上已经有一个目录了，换个文件名" };
  }
  if (existing && !overwrite) {
    return {
      ok: false,
      error: "已经有一个同名文件了（要覆盖就把 overwrite 设成 true，或者换个文件名）",
    };
  }

  try {
    /* 允许模型建子目录（"把资料整理进 deliveries/" 这类任务要用），
       但仍然在刚才那道白名单之内 —— `insideDirs` 判的是最终落点。 */
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  } catch (e) {
    return { ok: false, error: `写不进去（${e instanceof Error ? e.message : String(e)}）` };
  }

  return {
    ok: true,
    path: target,
    chars: content.length,
    bytes: Buffer.byteLength(content, "utf8"),
    created: !existing,
  };
}

/**
 * 把结果说成**一句话**（界面留痕与回给模型的都用它）。
 *
 * 同一个函数给两边用是刻意的：各写一份的话，"界面上说新建了"与
 * "模型被告知覆盖了"迟早会分叉，而分叉的方向通常是其中一边说谎。
 *
 * @param result `writeFileForModel` 的结果
 * @param rawPath 原样回显的路径（失败时用；成功时用落点的绝对路径）
 * @returns 一句话
 */
export function describeWriteResult(result: WriteFileResult, rawPath: string): string {
  if (!result.ok) return `写不了「${rawPath}」：${result.error}`;
  return result.created
    ? `新建了「${path.basename(result.path)}」（${result.chars} 字）`
    : `覆盖了「${path.basename(result.path)}」（${result.chars} 字）`;
}
