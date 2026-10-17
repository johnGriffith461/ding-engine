import fs from "node:fs/promises";
import path from "node:path";

import { insideDirs } from "./drivePaths";
import { REGEX_MAX_LINE_CHARS, unsafeRegexReason } from "./regexGuard";

/**
 * 「找文件」与「看目录」两个工具的执行体（2026-10-14）。
 *
 * ## 为什么要有它们
 * agent 想在用户的目录里干活，第一件事是**知道那儿有什么**。
 * 原来只有 `list_files`（只列云盘那四个目录的顶层）与 `read_file`（要报得出名字）——
 * 于是"这个项目里哪个文件定义了 X""看看这个目录的结构"这类最基本的事它做不到。
 * 参考实现里这是两条标配工具（opencode 的 `grep` + `glob`）。
 *
 * ## 口径（照 opencode 抄的默认值，逐条注明）
 * - 命中上限 **100**（opencode `DEFAULT_SEARCH_LIMIT = 100`），超了截断并说明；
 * - `search_files` 支持正则或**字面量**（`literal: true`）、可选 `include` 过滤（`*.ts` / `*.{ts,tsx}`）；
 * - 结果形如 `相对路径:行号: 行内容` —— 模型下一步就能拿路径去 `read_file` / `edit_file`。
 *
 * ## 两条本机自己加的护栏（如实记：这是取舍，不是标准做法）
 * 1. **跳过形式化目录与文件**：`.git` / `node_modules` / `dist` / `dist-electron` / `release`
 *    一律不进去（否则一次搜索就是几十万行，纯浪费上下文）；
 * 2. **硬上限**：最多访问 20000 个文件、单个文件超过 1MB 不读、含 NUL 的按二进制跳过。
 *    被跳过的东西会在结果里**如实说明**（"跳过了 3 个目录"），不悄悄少给。
 */

/** 搜索命中上限（opencode 同值）。 */
export const SEARCH_DEFAULT_LIMIT = 100;
/** 一次搜索最多看多少个文件（防呆；不是"正确性"参数）。 */
export const SEARCH_MAX_FILES = 20_000;
/** 单个文件超过这个大小就不搜内容了（1MB）。 */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** 看目录的默认/最大深度。 */
export const LIST_DIR_DEFAULT_DEPTH = 2;
export const LIST_DIR_MAX_DEPTH = 4;
/** 一次列目录最多给多少条。 */
export const LIST_DIR_MAX_ENTRIES = 300;

/** 永不进入的目录名。 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-electron", "release", "$RECYCLE.BIN", "System Volume Information"]);

/** 是不是"明显二进制"（有 NUL 就当二进制：与 readTool 的口径一致）。 */
function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * `include` 的极简 glob → 正则。
 *
 * 支持 `*.ts`、`*.{ts,tsx}`、`README*` 这几种；**不支持**带目录层级的通配（如 `src 下所有 ts`）
 * （用得上它的场景，靠 `path` 参数指定目录即可）。如实记着这个边界：
 * 不支持时不是"匹配不到"，而是会退化成"按文件名匹配"。
 */
function includeMatcher(include: string): RegExp {
  const brace = include.match(/^(.*)\{([^}]*)\}(.*)$/);
  const expand = brace ? brace[2].split(",").map((alt) => `${brace[1]}${alt}${brace[3]}`) : [include];
  const parts = expand.map((p) => p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."));
  return new RegExp(`^(?:${parts.join("|")})$`, "i");
}

/** 一次遍历的产物。 */
type Walked = { files: string[]; skippedDirs: number; stopped: boolean };

/** 从 root 往下走，收集文件绝对路径（跳过 SKIP_DIRS，带上限）。 */
async function walk(root: string, maxDepth: number): Promise<Walked> {
  const files: string[] = [];
  let skippedDirs = 0;
  let stopped = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= SEARCH_MAX_FILES) {
        stopped = true;
        break;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) {
          skippedDirs += 1;
          continue;
        }
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (e.isFile()) files.push(full);
    }
    if (stopped) break;
  }
  return { files, skippedDirs, stopped };
}

/** 一次内容检索的结果。 */
export type SearchFilesResult =
  | {
      ok: true;
      matches: string[];
      scanned: number;
      skippedDirs: number;
      truncated: boolean;
      /** 有多少行因为太长只看了前 `REGEX_MAX_LINE_CHARS` 个字符（如实计数，不悄悄少看）。 */
      trimmedLines: number;
    }
  | { ok: false; error: string };

/**
 * 在授权目录里按**内容**找（正则或字面量）。
 *
 * @param input 检索参数
 * @param dirs 允许搜的目录白名单
 * @param signal 中止信号（用户点停时别把剩下的文件全部扫完）
 * @returns 形如 `相对路径:行号: 行内容` 的命中列表
 */
export async function searchFilesForModel(
  input: { pattern: string; path?: string; include?: string; literal?: boolean; limit?: number },
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<SearchFilesResult> {
  const pattern = String(input.pattern ?? "");
  if (!pattern) return { ok: false, error: "pattern 是空的" };

  const start = input.path ? insideDirs(input.path, dirs) : dirs[0] ? path.resolve(dirs[0]) : null;
  if (!start) return { ok: false, error: "这个目录不在授权范围内（只能搜你授权目录里的东西）" };

  /*
   * ⭐ 正则安检（2026-10-16，审计 P44）：pattern 是**模型写的**，而这里是主进程 ——
   * 一个 `(a+)+` 撞上长行就会指数回溯把界面冻住，abort 都插不进去。
   * 字面量（`literal: true`）不过这道：它被转义过，炸不了。
   */
  if (input.literal !== true) {
    const unsafe = unsafeRegexReason(pattern);
    if (unsafe) return { ok: false, error: unsafe };
  }

  let re: RegExp;
  try {
    re = new RegExp(input.literal === true ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, "i");
  } catch (e) {
    return { ok: false, error: `正则写错了：${e instanceof Error ? e.message : String(e)}` };
  }

  const limit = Math.max(1, Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, 1000));
  const filter = input.include ? includeMatcher(input.include) : null;

  const walked = await walk(start, 8);
  const matches: string[] = [];
  let scanned = 0;
  let truncated = false;
  let trimmedLines = 0;

  for (const file of walked.files) {
    if (matches.length >= limit) {
      truncated = true;
      break;
    }
    /* 用户点停：不把剩下的文件全部扫完（审计 P44 的那半句"abort 无效"） */
    if (signal?.aborted) return { ok: false, error: "这一搜被中止了" };
    if (filter && !filter.test(path.basename(file))) continue;
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
    let buf: Buffer;
    try {
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    scanned += 1;
    const rel = path.relative(start, file).replace(/\\/g, "/");
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      const line = lines[i]!;
      /*
       * 超长行只拿前 N 个字符去匹配：把最坏的输入长度钉死
       * （minified 的几 MB 单行文件正是 ReDoS 最爱的输入）。截过的行如实计数。
       */
      const probe = line.length > REGEX_MAX_LINE_CHARS ? line.slice(0, REGEX_MAX_LINE_CHARS) : line;
      if (probe !== line) trimmedLines += 1;
      if (re.test(probe)) {
        const text = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        matches.push(`${rel}:${i + 1}: ${text.trim()}`);
      }
    }
  }

  return { ok: true, matches, scanned, skippedDirs: walked.skippedDirs, truncated, trimmedLines };
}

/** 一次列目录的结果。 */
export type ListDirResult = { ok: true; entries: string[]; truncated: boolean } | { ok: false; error: string };

/**
 * 看一个目录的结构（缩进树，带类型标记）。
 *
 * @param input path / depth / pattern（按名字过滤，如 `*.ts`）
 * @param dirs 允许看的目录白名单
 * @returns 形如 `d  src/`、`f  src/main.ts (1.2KB)` 的行
 */
export async function listDirForModel(
  input: { path?: string; depth?: number; pattern?: string },
  dirs: readonly string[],
): Promise<ListDirResult> {
  const start = input.path ? insideDirs(input.path, dirs) : dirs[0] ? path.resolve(dirs[0]) : null;
  if (!start) return { ok: false, error: "这个目录不在授权范围内" };

  const depth = Math.max(0, Math.min(input.depth ?? LIST_DIR_DEFAULT_DEPTH, LIST_DIR_MAX_DEPTH));
  const filter = input.pattern ? includeMatcher(input.pattern) : null;
  const out: string[] = [];
  let truncated = false;

  const step = async (dir: string, level: number): Promise<void> => {
    if (level > depth || truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      out.push(`${"  ".repeat(level)}?  ${path.basename(dir)}/（读不了）`);
      return;
    }
    /* 目录在前、名字排序：稳定输出，模型两次看不会以为变了 */
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= LIST_DIR_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (SKIP_DIRS.has(e.name)) continue;
      const pad = "  ".repeat(level);
      if (e.isDirectory()) {
        out.push(`${pad}d  ${e.name}/`);
        await step(path.join(dir, e.name), level + 1);
      } else if (e.isFile()) {
        if (filter && !filter.test(e.name)) continue;
        let size = 0;
        try {
          size = (await fs.stat(path.join(dir, e.name))).size;
        } catch {
          /* 拿不到大小就当 0：不为了一个数字把整次列举搞失败 */
        }
        out.push(`${pad}f  ${e.name} (${formatSize(size)})`);
      }
    }
  };

  await step(start, 0);
  return { ok: true, entries: out, truncated };
}

/** 人的读法（B/KB/MB）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 把检索结果说成**一句话**（界面留痕与回给模型共用）。
 */
export function describeSearchResult(result: SearchFilesResult, pattern: string): string {
  if (!result.ok) return `找不了「${pattern}」：${result.error}`;
  const tail = result.truncated ? "（只给了前面的命中）" : "";
  const trimmed = result.trimmedLines
    ? `；有 ${result.trimmedLines} 行太长，只看了每行前 ${REGEX_MAX_LINE_CHARS} 个字符`
    : "";
  return `找了「${pattern}」：命中 ${result.matches.length} 条（看了 ${result.scanned} 个文件）${tail}${trimmed}`;
}

/** 把列目录的结果说成**一句话**。 */
export function describeListDirResult(result: ListDirResult, where: string): string {
  if (!result.ok) return `看不了「${where}」：${result.error}`;
  const tail = result.truncated ? "（条目太多，截断了）" : "";
  return `看了「${where}」：${result.entries.length} 条${tail}`;
}

/** 供调用方拼给模型的正文（两个工具共用同一种"占位说明"口径）。 */
export function nothingFoundNote(what: string): string {
  return `（${what}：一个都没有 —— 换个词或换个目录再试，别当成"文件不存在"就换路）`;
}
