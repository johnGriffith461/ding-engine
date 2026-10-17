import fs from "node:fs";
import path from "node:path";

/**
 * 落盘文件名的**唯一化**（2026-10-16，审计 P11 / P21）。
 *
 * ## 缺陷形状（两处一模一样的写法）
 *
 * `imageGen.ts` 里那份是 `new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)`
 * （:181 与 :348 各抄一份），`canvasExport.ts:76` 是 `.replace(/[:.]/g,"-").slice(0,19)`。
 * 三个毛病叠在一起：
 *
 * 1. **`toISOString` 带大写 `T`**：`2026-10-16T0145`。生成图进
 *    `dshasset://<名字>` 靠 **host** 传名字，而 standard 协议会把 host **小写化** ——
 *    于是取回时 `resolveAsset` 拿到的名字与盘上那份**大小写不一致**，
 *    在大小写敏感的文件系统上直接取不到（注释却写着"文件名只用小写安全字符"）；
 * 2. `slice(0, 15)` 截到**分钟**：同一分钟内的两次生成互相**覆盖**（后者无声盖掉前者）；
 * 3. 两份实现（:181 / :348）必然各自漂 —— 一处改了另一处不一定。
 *
 * `canvasExport.ts` 同理（秒级时间戳 + 同秒内互相覆盖），另外它的
 * `mkdirSync` / `writeFileSync` 是**主进程的同步 IO**（审计 P21）：
 * 导出一张大图时整条主进程事件循环（正在流式吐字的模型输出）都停住。
 *
 * ## 这里给什么
 *
 * 一个**纯函数**（可单测，不 import electron）+ 一个带磁盘探测的唯一化助手。
 * 调用方只决定"基名长什么样"（生成图要小写安全字符、导出图可以留中文），
 * 时间戳与去重口径在这里只有一份。
 */

/** 两位补零（毫秒三位）。 */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * 本地时间戳，**全数字**（`20261016-014512-345`）。
 *
 * 为什么不用 `toISOString`：它按 UTC 且带 `T`/`Z`/`-` —— 大写 `T` 是 P11 那条
 * "取不回来"的根因；而"按 UTC 显示生成时间"对用户也没有意义（他看的是自己的钟）。
 *
 * @param at 时刻（默认现在；测试传进去）
 * @returns `YYYYMMDD-HHMMSS-mmm`
 */
export function stampOf(at: Date = new Date()): string {
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}` +
    `-${pad(at.getMilliseconds(), 3)}`
  );
}

/**
 * 造一个**盘上还不存在**的名字：`<base>-<时间戳><ext>`，撞了就加 `-2`、`-3`…
 *
 * ⚠️ 时间戳精确到毫秒，同毫秒的两次调用（并发保存）靠后缀区分 —— 这是审计 P21
 * 那类"两次导出/两次生成互相覆盖"的正面判据。`existsSync` 探测之外还有这条路，
 * 所以"同一个毫秒内连续两次"也拿得到两个不同的名字。
 *
 * @param dir 目标目录（要已存在；调用方负责建）
 * @param base 基名（调用方保证它合法 —— 不含分隔符）
 * @param ext 扩展名（含点，例如 `.png`）
 * @param at 时刻（默认现在）
 * @returns 完整路径
 */
export function uniqueFilePath(dir: string, base: string, ext: string, at: Date = new Date()): string {
  const stem = `${base}-${stampOf(at)}`;
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let i = 2; fs.existsSync(candidate); i += 1) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
  }
  return candidate;
}

/**
 * 把一段 hint 收成**小写安全字符**（生成图的名字要能当 `dshasset://` 的 host 用）。
 *
 * @param hint 提示（一般是模型名 / 用途）
 * @param max 最长多少字符
 * @returns 只含 `[a-z0-9-]` 的名字（空则 `gen`）
 */
export function safeLowerHint(hint: string, max = 24): string {
  return hint.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, max) || "gen";
}
