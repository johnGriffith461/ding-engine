/**
 * 搜索历史（§162）。
 *
 * ## 证据
 *
 * | 键 | 文案 |
 * |---|---|
 * | `search_history` | **全部搜索记录** |
 * | `search_history_clear` | **清空全部搜索记录** |
 * | `drive_search_history_sectionHeader` | **搜索历史** |
 * | `drive_searchWindow_history_tooltip_empty` | 清空 |
 *
 * ## ⚠️ 为什么必须落盘（不能只放内存）
 *
 * §156 撞过一次：把"当前选中的智能体"放在 `localStorage` 里，
 * **强杀进程再开就没了**（localStorage 是延迟落盘的，缓冲区随进程一起丢）。
 * 搜索历史是"用户会觉得它一直在"的东西 —— 重启就空会显得像坏了。
 * 所以走**主进程的同步原子写**。
 *
 * ## 一条给用户看的规矩
 *
 * 同一个词搜第二遍，**挪到最前、不重复一条** ——
 * 否则历史里会堆一排一模一样的词，而"最近搜过什么"这件事反而看不出来。
 */

/** 界面文案（逐字取自证据）。 */
export const SEARCH_HISTORY_LABELS = {
  /** `drive_search_history_sectionHeader` */
  section: "搜索历史",
  /** `search_history` */
  all: "全部搜索记录",
  /** `search_history_clear` */
  clearAll: "清空全部搜索记录",
  /** `drive_searchWindow_history_tooltip_empty`（那个按钮的 tooltip） */
  clear: "清空",
} as const;

/** 搜索范围（两处搜索各自一份历史）。 */
export type HistoryScope = "skills" | "files";

/** 每个范围最多留几条（再多也没人看，还会把文件撑大）。 */
export const HISTORY_LIMIT = 10;

/** 少于这么长的词不记（"看"、"1" 这种搜过等于没搜）。 */
export const HISTORY_MIN_LEN = 2;

/** 整个历史文件的形状。 */
export type SearchHistory = Record<HistoryScope, string[]>;

/** 空历史。 */
export function emptyHistory(): SearchHistory {
  return { skills: [], files: [] };
}

/**
 * 记一条搜索。
 *
 * 规矩：
 * 1. **空的、太短的不记**（`HISTORY_MIN_LEN`）；
 * 2. **同一个词不重复**（大小写不敏感），再搜一次就**挪到最前**；
 * 3. 超过上限砍掉最旧的。
 *
 * @param list 该范围现在的历史
 * @param query 这次搜的词
 * @param limit 最多几条
 * @returns 新数组（不改原数组）
 */
export function pushHistory(list: readonly string[], query: string, limit = HISTORY_LIMIT): string[] {
  const word = String(query ?? "").trim();
  if (word.length < HISTORY_MIN_LEN) return [...list];
  const lower = word.toLowerCase();
  const rest = list.filter((x) => x.toLowerCase() !== lower);
  return [word, ...rest].slice(0, limit);
}

/**
 * 从历史里去掉一条。
 *
 * @param list 历史
 * @param query 要去掉的那条（大小写不敏感）
 * @returns 新数组
 */
export function removeHistory(list: readonly string[], query: string): string[] {
  const lower = String(query ?? "").trim().toLowerCase();
  return list.filter((x) => x.toLowerCase() !== lower);
}

/**
 * 收窄磁盘上读回来的历史（**磁盘内容一律不可信**）。
 *
 * @param raw 任意值
 * @param limit 每个范围最多几条
 * @returns 合法历史
 */
export function normalizeHistory(raw: unknown, limit = HISTORY_LIMIT): SearchHistory {
  const out = emptyHistory();
  if (!raw || typeof raw !== "object") return out;
  const src = raw as Record<string, unknown>;
  for (const scope of ["skills", "files"] as const) {
    const list = src[scope];
    if (!Array.isArray(list)) continue;
    const kept: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      const word = item.trim();
      if (word.length < HISTORY_MIN_LEN) continue;
      if (kept.some((x) => x.toLowerCase() === word.toLowerCase())) continue;
      kept.push(word);
      if (kept.length >= limit) break;
    }
    out[scope] = kept;
  }
  return out;
}

/**
 * 这个范围有没有历史（界面据此决定要不要显示那一段）。
 *
 * @param history 历史
 * @param scope 范围
 * @returns 有则 true
 */
export function hasHistory(history: SearchHistory, scope: HistoryScope): boolean {
  return (history[scope] ?? []).length > 0;
}

/** 范围的中文名（历史段落的小标题用）。 */
export function scopeLabel(scope: HistoryScope): string {
  return scope === "skills" ? "技能" : "云盘";
}
