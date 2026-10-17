/**
 * `@` 常用语（§161）。
 *
 * ## 证据
 *
 * 逐字只有一条，但足够定下**触发方式与这句话的形态**：
 *
 * > `coding_chat_mode_new_placeholder`：**输入"@"唤起常用语，或粘贴代码快速提问**
 *
 * 也就是说：`@` 一敲，就是一个"常用语"选单。
 *
 * ## ⚠️ 常用语**内容**是本机自定的
 *
 * 本体那份列表**在服务端**（跟着账号/场景下发），包里没有。
 * 所以词条内容是本机版自己写的一小组（解释代码 / 找 bug / 补测试…），
 * **这一点如实记在 §161**：触发方式照证据，词条不假装是原版那份。
 */

/** 界面文案（触发方式那句逐字取自证据）。 */
export const PHRASE_LABELS = {
  /** `coding_chat_mode_new_placeholder` */
  triggerHint: '输入"@"唤起常用语，或粘贴代码快速提问',
  /** 搜不到时（自定措辞，证据里没有这一条） */
  empty: "没有匹配的常用语",
  /** 选单标题 */
  title: "常用语",
} as const;

/** 一条常用语。 */
export type Phrase = {
  id: string;
  /** 选单里显示的名字。 */
  title: string;
  /** 选中后填进输入区的正文。 */
  text: string;
  /** 归类（选单里分组用）。 */
  group: string;
};

/**
 * 本机版的常用语（**内容自定**，见文件头说明）。
 *
 * 挑选标准：**每一句都能直接开工**（带清楚的对象与要求），
 * 而不是"帮我看看"这种说了等于没说的。
 */
export const PHRASES: readonly Phrase[] = [
  { id: "explain-code", title: "解释这段代码", text: "解释下面这段代码在做什么，逐段说清关键逻辑与边界情况：\n\n", group: "读代码" },
  { id: "find-bug", title: "找出潜在 bug", text: "找出下面这段代码里的潜在 bug 与风险点，按严重程度排序，并给出修法：\n\n", group: "读代码" },
  { id: "explain-error", title: "解释这个报错", text: "解释这个报错的原因，并给我可操作的排查步骤：\n\n", group: "读代码" },
  { id: "add-comments", title: "加上注释", text: "给下面这段代码加上有用的注释（只解释「为什么」，别复述「做了什么」）：\n\n", group: "改代码" },
  { id: "add-tests", title: "补单元测试", text: "给下面这段代码补单元测试，覆盖正常路径、边界与错误分支：\n\n", group: "改代码" },
  { id: "optimize", title: "优化性能", text: "找出下面这段代码的性能瓶颈并优化，说明每处改动的收益与代价：\n\n", group: "改代码" },
  { id: "refactor", title: "重构得更清晰", text: "把下面这段代码重构得更清晰（拆函数、起好名字、减少嵌套），保持行为不变：\n\n", group: "改代码" },
  { id: "write-readme", title: "写一份 README", text: "给这个项目写一份 README：它是做什么的、怎么跑起来、目录结构、常见问题。项目信息：\n\n", group: "写文档" },
] as const;

/** 所有分组（选单里按这个顺序）。 */
export function phraseGroups(): string[] {
  return [...new Set(PHRASES.map((p) => p.group))];
}

/** 一次 `@` 触发的状态。 */
export type AtTrigger = {
  /** 触发词从正文的哪个下标开始（`@` 的位置）。 */
  start: number;
  /** 光标位置（替换到哪儿）。 */
  end: number;
  /** `@` 后面已经敲的字（用来筛常用语）。 */
  query: string;
};

/**
 * 光标处是不是正在 `@` 唤起。
 *
 * 三条规矩（每条都对应一种"不该弹"的情形）：
 * 1. **`@` 前面必须是开头或空白** —— 否则 `a@b.com` 这种邮箱一敲 @ 就弹选单；
 * 2. **`@` 与光标之间不能有空白** —— 敲了空格就是"这句话写完了"，选单该收；
 * 3. 从光标**往前找最近的 `@`**，中间一旦碰到空白就说明不是触发词。
 *
 * @param text 输入区全文
 * @param caret 光标位置
 * @returns 触发信息；没在触发则 null
 */
export function detectAtTrigger(text: string, caret: number): AtTrigger | null {
  const src = String(text ?? "");
  const pos = Math.max(0, Math.min(caret, src.length));
  // 往前扫，最多扫一段（`@` 后的查询词不会太长）
  const from = Math.max(0, pos - 32);
  for (let i = pos - 1; i >= from; i -= 1) {
    const ch = src[i] ?? "";
    if (ch === "@") {
      const before = i === 0 ? "" : (src[i - 1] ?? "");
      if (before && !/\s/.test(before)) return null; // 邮箱/句中的 @，不触发
      return { start: i, end: pos, query: src.slice(i + 1, pos) };
    }
    if (/\s/.test(ch)) return null; // 中间有空白 → 不是在写触发词
  }
  return null;
}

/**
 * 按查询词筛常用语（标题或正文里包含）。
 *
 * @param query `@` 后面的字
 * @param list 词库（默认本机那份）
 * @returns 命中列表（保持词库顺序）
 */
export function filterPhrases(query: string, list: readonly Phrase[] = PHRASES): Phrase[] {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((p) => p.title.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
}

/**
 * 选中一条常用语：把 `@查询词` 换掉，光标落到末尾。
 *
 * @param text 原文
 * @param trigger 触发信息
 * @param phrase 选中的常用语
 * @returns 新正文与新光标位置
 */
export function applyPhrase(
  text: string,
  trigger: AtTrigger,
  phrase: Phrase,
): { text: string; caret: number } {
  const src = String(text ?? "");
  const before = src.slice(0, trigger.start);
  const after = src.slice(trigger.end);
  const inserted = phrase.text;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
