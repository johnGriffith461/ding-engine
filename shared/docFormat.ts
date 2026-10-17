/**
 * AI 文档的「调整语气」与「调整格式」（§168，证据 `aiDoc_keyboard_actionBar_*`）。
 *
 * ## 为什么这两件放在一起
 *
 * 它们在界面上是同一个位置的两个菜单（`_actionBar_tone` / `_actionBar_tools`），
 * 但**实现方式完全不同**，而这个差别很值得说清楚：
 *
 * | | 怎么实现 | 代价 |
 * |---|---|---|
 * | **调整语气** | 交给模型重写一遍（更学术 / 更口语化 …） | 一次模型调用 |
 * | **调整格式** | **纯本地文本变换**（给小标题加 `##`） | 零成本、瞬时 |
 *
 * 格式这件事**根本不需要模型** —— 把"给小标题加 `##`"做成一次模型调用，
 * 既慢又可能被改坏内容（模型很爱顺手润色）。所以这里是一条纯函数。
 */

/** 语气档位（**逐字取自证据**）。 */
export const DOC_TONES = ["academic", "conversational", "flair", "professional", "socialMedia"] as const;
export type DocTone = (typeof DOC_TONES)[number];

/** 语气档位的显示名（逐字）。 */
export const DOC_TONE_LABEL: Record<DocTone, string> = {
  academic: "更学术",
  conversational: "更口语化",
  flair: "更有文采",
  professional: "更专业",
  socialMedia: "更有网感",
};

/** 格式档位（**逐字取自证据**：标题 / 小标题 / 副标题 / 正文）。 */
export const DOC_FORMATS = ["h1", "h2", "h3", "text"] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

/** 格式档位的显示名（逐字）。 */
export const DOC_FORMAT_LABEL: Record<DocFormat, string> = {
  h1: "标题",
  h2: "小标题",
  h3: "副标题",
  text: "正文",
};

/** 两个菜单的标题（逐字）。 */
export const DOC_KEYBOARD_LABELS = {
  tone: "调整语气",
  tools: "调整格式",
} as const;

/** 每个格式档位对应的 Markdown 前缀（`正文` 是空串 = 去掉标题标记）。 */
export const FORMAT_PREFIX: Record<DocFormat, string> = { h1: "# ", h2: "## ", h3: "### ", text: "" };

/**
 * 语气档位要发过去的指令。
 *
 * @param tone 语气档位
 * @returns 系统/用户提示里那句要求
 */
export function toneInstruction(tone: DocTone): string {
  const how: Record<DocTone, string> = {
    academic:
      "改成学术写法：用词准确克制、多用客观陈述，避免口语与情绪化表达；术语该用就用，不要为了通俗而稀释意思。",
    conversational:
      "改成口语化写法：像当面说话一样自然，句子短一些，可以用「你」来称呼读者；但不要加表情符号与网络黑话。",
    flair:
      "写得更有文采：句子节奏有变化，该具体的地方给具体画面，避免平铺直叙；但不要堆砌辞藻，也不要改变原意。",
    professional:
      "改成职业书面语：结论先行、表述干脆，去掉含糊的修饰与重复，读起来像一个做事的人在汇报。",
    socialMedia:
      "改成社交平台上的写法：开头一句就要抓人，分段短、信息密度高，节奏明快；但不要用夸张的标题党措辞。",
  };
  return `${how[tone]}保持原文的事实、观点与结构不变，只调整表达方式。直接给出改后的全文，不要解释你改了什么。`;
}

/** 一段文本的范围（`doc.body` 里的下标）。 */
export type TextRange = { start: number; end: number };

/**
 * 把光标/选区扩成"要动的那些整行"。
 *
 * 规矩（都是用户能预期的）：
 * - 有选区 → 覆盖**整行**（比如只选了半句，也把那一行算上，否则会切出一个半个标题）；
 * - 只有光标 → 就当它落在哪一行，动那一行。
 *
 * @param body 全文
 * @param range 选区或光标位置
 * @returns 要动的行区间（`from` 含、`to` 不含，都是**行下标**）
 */
export function linesInRange(body: string, range: TextRange): { from: number; to: number } {
  const src = String(body ?? "");
  const start = Math.max(0, Math.min(range.start, src.length));
  const end = Math.max(start, Math.min(range.end, src.length));
  const lineStart = src.slice(0, start).split("\n").length - 1;
  // 选区结束在行首时，不该把下一行也带上（这是编辑器里的常见做法）
  const upTo = end > start && src[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = src.slice(0, upTo).split("\n").length - 1;
  return { from: lineStart, to: Math.max(lineStart, lineEnd) };
}

/**
 * 给选中的行套一个格式（**纯本地变换，不调模型**）。
 *
 * 处理方式：先去掉原有的 `#` 标记（避免叠加成 `### ## 小标题`），再加新的。
 * `正文` 就是"去掉标记"。
 *
 * @param body 全文
 * @param kind 格式档位
 * @param range 选区（省略则整篇）
 * @returns 新正文（**没有变化时返回原串**，免得平白多一个版本）
 */
export function applyFormat(body: string, kind: DocFormat, range?: TextRange): string {
  const src = String(body ?? "");
  if (!src.trim()) return src;
  const prefix = FORMAT_PREFIX[kind];
  const all = src.split("\n");
  const { from, to } = range
    ? linesInRange(src, range)
    : { from: 0, to: Math.max(0, all.length - 1) };

  let changed = false;
  for (let i = from; i <= to && i < all.length; i += 1) {
    const line = all[i] ?? "";
    // 空行不动（否则会给空行加一个孤零零的 `# `）
    if (!line.trim()) continue;
    const stripped = line.replace(/^\s*#{1,6}\s+/, "");
    const next = `${prefix}${stripped}`;
    if (next !== line) {
      all[i] = next;
      changed = true;
    }
  }
  return changed ? all.join("\n") : src;
}

/**
 * 这个格式档位现在**是不是已经生效**（界面上用来标当前项 / 判断"点了会不会变"）。
 *
 * @param body 全文
 * @param kind 格式档位
 * @param range 选区
 * @returns 已经全是该格式则 true
 */
export function isFormatApplied(body: string, kind: DocFormat, range?: TextRange): boolean {
  const before = String(body ?? "");
  return applyFormat(before, kind, range) === before;
}
