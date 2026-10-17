/**
 * 模型给的正则**先过一遍安检**（2026-10-16，审计 P44）。
 *
 * ## 为什么需要
 *
 * `search_files` 的 pattern 是**模型写的**（也可能是 prompt 注入带着写的），
 * 而这里是**主进程**：一个 `(a+)+$` 撞上一行长文本，JS 的正则引擎会指数回溯，
 * 把界面冻住 —— 用户点"停止"也没用（正则跑在同一个线程里，abort 插不进去）。
 * 审计的原话是"ReDoS 冻结主进程且 abort 无效"。
 *
 * ## 三道防线（如实说清各自能挡什么）
 *
 * 1. **拒掉"量词套量词"的形状**（`(a+)+` / `(\d*)*` / `(.+){2,}`）：指数爆炸的
 *    经典形态，用一个小扫描器判（带转义与字符类的处理，不误伤 `[+*]` 这类字面量）；
 * 2. **pattern 长度上限**：超长 pattern 的组合形态没法穷举，先按长度拒一道；
 * 3. **被检索文本的行上限**：单行只拿前 N 个字符去匹配 —— 把最坏情况的输入长度钉死
 *    （minified 的几 MB 单行文件正是最危险的输入）。截过的行会**如实计数上报**。
 *
 * ⚠️ 边界如实记：这不是"正则沙箱"（JS 给不了），是**降低最坏情况**的组合拳。
 * 真要线性时间得换 ripgrep 那样的引擎 —— 那是另一个量级的工程。
 */

/** pattern 长度上限（超了不赌它安不安全）。 */
export const REGEX_MAX_LENGTH = 200;

/** 单行拿去匹配的最大字符数（超长行只取前这么多 —— 见文件头第 3 条）。 */
export const REGEX_MAX_LINE_CHARS = 2000;

/**
 * 判一个正则是不是**明显危险**。
 *
 * @param pattern 模型给的正则原文
 * @returns 危险时给一句人话（可直接回给模型/用户）；安全返回 `null`
 */
export function unsafeRegexReason(pattern: string): string | null {
  if (pattern.length > REGEX_MAX_LENGTH) {
    return `正则太长（${pattern.length} 字符，上限 ${REGEX_MAX_LENGTH}）—— 换个短一点的写法，或者用 literal: true 当字面量搜`;
  }

  /* 扫一遍：哪一层括号里出现过量词，而它自己又被量词跟着 → 指数形态 */
  const stack: Array<{ quantified: boolean }> = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i += 2; // 转义：下一个字符是字面量（`\+` 不是量词）
      continue;
    }
    if (ch === "[") {
      /* 字符类整段跳过：里面的 + * { 都是字面量 */
      i += 1;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "(") {
      stack.push({ quantified: false });
      i += 1;
      continue;
    }
    if (ch === ")") {
      const group = stack.pop();
      i += 1;
      const after = pattern[i];
      if (group?.quantified && (after === "*" || after === "+" || after === "{")) {
        return "正则里有「量词套量词」的形状（如 (a+)+）—— 匹配时间会指数爆炸，主进程会被冻住。换个写法，或用 literal: true 当字面量搜";
      }
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "{" || ch === "?") {
      if (stack.length) stack[stack.length - 1]!.quantified = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}
