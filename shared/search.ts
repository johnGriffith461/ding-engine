/**
 * 搜索（§160）—— 技能搜索与云盘搜索共用的匹配逻辑与文案。
 *
 * ## 证据
 *
 * | 键 | 文案 |
 * |---|---|
 * | `search_skills_input_placeholder` | **搜索技能** |
 * | `search_skills_empty_info` | **无匹配的技能** |
 * | `drive_searchWindow_placeholder` | **搜索文件** |
 * | `drive_searchWindow_title` | **云盘搜索** |
 * | `drive_searchWindow_result_empty` | **未搜索到匹配的文件** |
 * | `drive_search_noResult` | 暂无搜索结果 |
 * | `search_history` / `search_history_clear` | 全部搜索记录 / 清空全部搜索记录 |
 *
 * ## 为什么抽出来共用
 *
 * 两处搜索的**匹配口径必须是同一条**。各写一份的话，会出现
 * "技能搜索认空格分词、云盘搜索不认"这种**用户能感觉到、但很难说清**的差别。
 */

/** 界面文案（逐字取自证据；两处搜索共用）。 */
export const SEARCH_LABELS = {
  /** `search_skills_input_placeholder` */
  skills: "搜索技能",
  /** `search_skills_empty_info` */
  skillsEmpty: "无匹配的技能",
  /** `drive_searchWindow_placeholder` */
  files: "搜索文件",
  /** `drive_searchWindow_title` */
  filesTitle: "云盘搜索",
  /** `drive_searchWindow_result_empty` */
  filesEmpty: "未搜索到匹配的文件",
  /** `drive_search_noResult` */
  noResult: "暂无搜索结果",
  /** `search_history` / `search_history_clear` —— 记下来，本机版还没做搜索历史 */
  history: "全部搜索记录",
  historyClear: "清空全部搜索记录",
  /*
   * ── 下面三条是**本机自定措辞**（§160 的补全，2026-10-14）──────────
   * 证据里没有对应键（本体那三个输入框的清除/计数文案没被采到），
   * 所以**不假装是原版那份** —— 按本项目一贯的做法：能对上的逐字用证据，对不上的如实标自定。
   */
  /** 输入框里那颗清除键的可访问名（图标按钮，见 `uiCraft` 守卫 ⑧） */
  clear: "清除",
  /** 空态里的出路（原来只有一句"无匹配"，没有可点的东西） */
  clearFilter: "清除筛选",
  /** 命中计数：`命中 N 条` */
  hitsPrefix: "命中",
  hitsSuffix: "条",
} as const;

/**
 * 命中计数那句话（**本机自定措辞**，见上面 `SEARCH_LABELS` 的说明）。
 *
 * 为什么要有它：搜索完只看到结果变少，**不知道筛掉了多少** ——
 * 用户会怀疑"是不是目录本身就少了几条"。有个数字就一目了然。
 *
 * @param count 命中几条
 * @returns 例如 `命中 3 条`
 */
export function hitLabel(count: number): string {
  return `${SEARCH_LABELS.hitsPrefix} ${count} ${SEARCH_LABELS.hitsSuffix}`;
}

/** 搜索范围（决定空态说哪句）。 */
export type SearchScope = "skills" | "files";

/**
 * 把查询切成词（空格分词，**多词是 AND**）。
 *
 * @param query 用户输入
 * @returns 小写去重的词表（空输入给空数组 = 不筛）
 */
export function tokensOf(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of String(query ?? "").toLowerCase().split(/\s+/)) {
    const t = raw.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/**
 * 这段文字是否命中**全部**词（AND）。
 *
 * @param text 被搜的文字
 * @param tokens 词表（空表 → 恒真，即"没输就全给"）
 * @returns 是否命中
 */
export function matchesAll(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = String(text ?? "").toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * 命中程度（用来排序，**不只是筛**）。
 *
 * 搜"看板"时，叫「看板」的应该排在「销售看板（旧）」前面 ——
 * 只筛不排的话，结果顺序取决于文件系统，用户会觉得"搜得不准"。
 *
 * @param name 名字
 * @param tokens 词表
 * @returns 3 = 完全相等；2 = 以任一词开头；1 = 含全部词；0 = 不命中
 */
export function matchRank(name: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1;
  const lower = String(name ?? "").toLowerCase();
  if (!matchesAll(name, tokens)) return 0;
  if (tokens.some((t) => lower === t)) return 3;
  if (tokens.some((t) => lower.startsWith(t))) return 2;
  return 1;
}

/**
 * 按命中程度筛选并排序。
 *
 * @param items 待搜列表
 * @param query 查询
 * @param key 取"被搜文字"的函数（通常取名字）
 * @returns 新数组（命中程度高的在前；同分按名字稳定排序）
 */
export function searchItems<T>(items: readonly T[], query: string, key: (item: T) => string): T[] {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return [...items];
  return items
    .map((item) => ({ item, rank: matchRank(key(item), tokens) }))
    .filter((x) => x.rank > 0)
    .sort((a, b) => b.rank - a.rank || key(a.item).localeCompare(key(b.item), "zh"))
    .map((x) => x.item);
}

/**
 * 空态该说哪一句（有结果时返回空串 —— 有结果不用说话）。
 *
 * @param scope 搜索范围
 * @param count 命中数
 * @returns 空态文案或空串
 */
export function emptyLabelFor(scope: SearchScope, count: number): string {
  if (count > 0) return "";
  return scope === "skills" ? SEARCH_LABELS.skillsEmpty : SEARCH_LABELS.filesEmpty;
}

/** 输入框占位（两处各一句）。 */
export function placeholderFor(scope: SearchScope): string {
  return scope === "skills" ? SEARCH_LABELS.skills : SEARCH_LABELS.files;
}
