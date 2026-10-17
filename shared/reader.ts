/**
 * AI 阅读（`chat/read-web`，§155）。
 *
 * ## 证据
 *
 * 文案逐字取自 `docs/evidence-readweb.txt`（`copilot_*` 12 条）：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 *
 * | 键 | 文案 |
 * |---|---|
 * | `copilot_enter_immersive_mode` | 进入 AI 阅读 |
 * | `copilot_hide_sidebar` | 隐藏侧栏 |
 * | `copilot_recent` | 最近阅读 |
 * | `copilot_sidebar_menu_outline / page / chart` | 大纲 / 页面 / 图表 |
 * | `copilot_sidebar_desc_outline / page / chart` | 智能展示文件的大纲结构 / 页面检索 / 展示文件中包含的图片表格 |
 *
 * ## 本机版做到哪一步
 *
 * 本体是"给个链接或文件，它抓下来读"。本机版**不做网络抓取**（没有那个能力，
 * 也不该假装有），所以内容来源是**用户粘进来的文本**或**已有的 AI 文档**。
 *
 * 侧栏那三件事**全是本地能算准的**，所以它们是这一版的主体：
 * - **大纲**：从 Markdown 标题抽出层级结构；
 * - **页面**：按固定行数折页后检索（本机版没有真实分页 —— 见 `LINES_PER_PAGE`）；
 * - **图表**：把 Markdown 表格抠出来、数一下图片。
 */

/** 界面文案（**逐字取自证据**）。 */
export const READER_LABELS = {
  enter: "进入 AI 阅读",
  hideSidebar: "隐藏侧栏",
  showSidebar: "显示侧栏",
  recent: "最近阅读",
  outline: "大纲",
  page: "页面",
  chart: "图表",
  descOutline: "智能展示文件的大纲结构",
  descPage: "页面检索",
  descChart: "展示文件中包含的图片表格",
  empty: "还没有内容 —— 把一段文字粘进来，或从 AI 文档里打开",
  noOutline: "这份内容里没有标题层级",
  noChart: "这份内容里没有表格或图片",
} as const;

/** 侧栏三个页签。 */
export const READER_TABS = ["outline", "page", "chart"] as const;
export type ReaderTab = (typeof READER_TABS)[number];

/**
 * 多少行折成一"页"。
 *
 * ⚠️ 本体读的是**真文件**（PDF/网页），有真实分页；
 * 本机版读的是粘进来的文本，所以这里定一个固定的折页口径 ——
 * **这是实现差异**，写在界面上（标题就写「第 N 页」而不是假装是真的页码）。
 */
export const LINES_PER_PAGE = 40;

/** 大纲里的一项。 */
export type OutlineItem = {
  /** 层级：1 = 一级标题（`#`）。 */
  level: number;
  text: string;
  /** 它在原文里的行号（从 1 开始）。 */
  line: number;
  /** 折页之后的页号（从 1 开始）。 */
  page: number;
};

/** 检索到的一处。 */
export type HitItem = {
  page: number;
  line: number;
  /** 命中的那一行（截断后），便于列表里直接看。 */
  text: string;
};

/** 抽出来的一个表格。 */
export type TableBlock = {
  /** 表头（第一行）。 */
  header: string[];
  /** 数据行数（不含表头与分隔行）。 */
  rows: number;
  line: number;
  page: number;
};

/** 折页：第几行属于第几页（从 1 开始）。 */
export function pageOfLine(line: number, per = LINES_PER_PAGE): number {
  if (line < 1) return 1;
  return Math.floor((line - 1) / per) + 1;
}

/** 一行的缩进前空白（表格判断要用）。 */
const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isTableSep = (line: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(line);

/**
 * 这一行是不是代码围栏（` ``` `）。
 *
 * 提出来是为了让「围栏里的东西不算内容」这个口径**只有一份**：
 * `parseOutline` 与 `extractCharts` 都按它推进 `inFence` 状态。
 */
const isFence = (line: string): boolean => /^\s*```/.test(line);

/**
 * 从文本里抽大纲。
 *
 * 只认 Markdown 的 `#` 标题（本体的文档本来就是 Markdown 口径）。
 * **代码块里的 `#` 不算** —— 那是注释，不是标题（这条容易漏，`shared/reader.test.ts` 钉了它；
 * 围栏这一步与 `extractCharts` 共用 `isFence`，别让两处口径再分家）。
 *
 * @param text 全文
 * @param per 每页行数
 * @returns 大纲项（按出现顺序）
 */
export function parseOutline(text: string, per = LINES_PER_PAGE): OutlineItem[] {
  const out: OutlineItem[] = [];
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({
      level: (m[1] ?? "#").length,
      text: (m[2] ?? "").trim(),
      line: i + 1,
      page: pageOfLine(i + 1, per),
    });
  }
  return out;
}

/**
 * 页面检索。
 *
 * @param text 全文
 * @param query 关键词（空串返回空 —— 别把"没输关键词"当成"命中全部"）
 * @param per 每页行数
 * @param limit 最多几条
 * @returns 命中列表
 */
export function findHits(text: string, query: string, per = LINES_PER_PAGE, limit = 50): HitItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: HitItem[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i += 1) {
    const raw = lines[i] ?? "";
    if (!raw.toLowerCase().includes(q)) continue;
    const trimmed = raw.trim();
    out.push({
      page: pageOfLine(i + 1, per),
      line: i + 1,
      text: trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed,
    });
  }
  return out;
}

/** 单元格拆开（去掉两端的 `|`，再按 `|` 分）。 */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * 抽图表：Markdown 表格 + 图片计数。
 *
 * ⚠️ **代码围栏里的不算**（2026-10-16，审计 P243）：围栏里出现 `| a | b |` 的示例、
 * 或者教人写图片语法的 `![x](y)`，那是**这份内容里的代码**，不是它的表格与图片。
 * 原先这里没有围栏这一步，于是「图表」页签会报出根本不存在的表与图（数量与页号都进界面）——
 * 而同文件 `parseOutline` 早就按围栏跳过 `#`，同一份内容里两处口径相反。
 * 现在两边共用 `isFence`，判据在 `shared/reader.test.ts`（围栏里像图表、围栏外是真图表）。
 *
 * @param text 全文
 * @param per 每页行数
 * @returns 表格块与图片张数
 */
export function extractCharts(text: string, per = LINES_PER_PAGE): { tables: TableBlock[]; images: number } {
  const lines = text.split("\n");
  const tables: TableBlock[] = [];
  let images = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 图片：Markdown 语法 `![alt](url)`
    images += (line.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
    /*
     * 表格：`| a | b |` 后面紧跟一行 `| --- | --- |`。
     * 只有两行都齐才算表格 —— 光看第一行会把"正文里刚好有竖线的句子"也算进去。
     */
    if (!isTableRow(line)) continue;
    const next = lines[i + 1] ?? "";
    if (!isTableSep(next)) continue;
    let rows = 0;
    for (let j = i + 2; j < lines.length && isTableRow(lines[j] ?? ""); j += 1) rows += 1;
    tables.push({ header: cells(line), rows, line: i + 1, page: pageOfLine(i + 1, per) });
  }
  return { tables, images };
}

/** 阅读面板顶部那几项统计。 */
export function readingStats(text: string): { chars: number; paragraphs: number; headings: number } {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  return {
    chars: text.replace(/\s/g, "").length,
    paragraphs,
    headings: parseOutline(text).length,
  };
}

/** 「最近阅读」里那一条。 */
export type Reading = {
  id: string;
  title: string;
  text: string;
  at: number;
};

/** 从内容里取一个像样的标题（第一行标题，或第一行非空文本）。 */
export function readingTitle(text: string): string {
  const first = parseOutline(text)[0];
  if (first) return first.text.slice(0, 40);
  const line = text.split("\n").find((l) => l.trim());
  return (line ?? "未命名内容").trim().slice(0, 40);
}

/**
 * 收窄磁盘上读回来的"最近阅读"（**磁盘内容一律不可信**）。
 *
 * @param raw 任意值
 * @param limit 最多保留几条
 * @returns 合法列表（新的在前）
 */
export function normalizeReadings(raw: unknown, limit = 20): Reading[] {
  if (!Array.isArray(raw)) return [];
  const out: Reading[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    if (typeof r.text !== "string") continue;
    out.push({
      id: r.id,
      title: typeof r.title === "string" && r.title ? r.title : readingTitle(r.text),
      text: r.text,
      at: typeof r.at === "number" ? r.at : 0,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
