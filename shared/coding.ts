/**
 * 创作广场 / 应用生成（`chat/coding`，§159）。
 *
 * ## 证据
 *
 * 文案逐字取自 `docs/evidence-coding.txt`（`coding_*` **260 条**）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 那 260 条里**大半是云端功能**（投稿审核、创作挑战赛、举报、分享链接、跨用户排行）——
 * 那些**不做**（没有后端，也不该假装有）。
 *
 * 本机版做的是**有本地含义的那一部分**：
 *
 * | 证据 | 本机版 |
 * |---|---|
 * | `coding_create_center` 创作广场 | 一个页面 |
 * | `coding_launch_page_type_*` 七个分类 | 筛选（逐字对齐） |
 * | `coding_launch_page_apps_search*` 搜索 / 找到 N 个 / 暂未搜索到 | 真搜索 |
 * | `coding_launch_page_time_slot` 近 {N} 天 | 时间范围 |
 * | `coding_launch_page_preview_button` 预览应用 | 用系统程序打开 |
 * | `coding_launch_page_remix` 创作同款 | 把它变成一个任务填回输入区 |
 * | `coding_launch_page_top_apps` Top 应用排行 | ⚠️ 本机版口径（见下） |
 *
 * ## ⚠️ "应用"和"排行"在本机版是什么
 *
 * - **应用** = 我产出的**网页产物**（`artifacts/` 里的 `.html`）。
 *   这是真东西：智能体确实会产出可以打开的网页。
 * - **排行**在本体是**多用户热度**；本机只有你一个人，所以那套排不出来。
 *   本机版按「**最近更新**」排，并在界面上**写明这个口径**——
 *   假装有热度排行比不排行更坏（数字一细看就露）。
 */

/** 界面文案（**逐字取自证据**）。 */
export const CODING_LABELS = {
  /** `coding_create_center` / `coding_launch_page_create_center_tab` */
  center: "创作广场",
  /** `coding_launch_page_create_button` */
  createApp: "创作应用",
  /** `coding_launch_page_apps_search` */
  search: "搜索应用",
  /** `coding_launch_page_apps_search_none` */
  searchNone: "暂未搜索到匹配的应用",
  /** `coding_launch_page_detail` */
  detail: "查看详情",
  /** `coding_launch_page_remix` / `coding_app_page_remix_button` */
  remix: "创作同款",
  /** `coding_launch_page_preview_button` */
  preview: "预览应用",
  /** `coding_launch_page_top_apps` */
  topApps: "Top 应用排行",
  /** `coding_launch_page_more` */
  more: "查看更多",
  /** `coding_app_page_introduction` */
  introduction: "应用介绍",
  /** `coding_app_page_more_from` 的模板 */
  moreFrom: "更多来自于 {s_userName}",
  /** `coding_launch_page_apps_search_result` 的模板 */
  searchResult: "找到 {s_number} 个应用",
  /** `coding_failure_redirect_page_wording` */
  notFound: "该应用不存在",
  /** `coding_launch_page_time_slot` 的模板 */
  timeSlot: "近 {s_number} 天",
  /** `coding_site_update_title_2` / `_3` */
  createMode: "创作模式",
  chatMode: "问答模式",
  /** `coding_chat_mode_new_placeholder` */
  chatPlaceholder: '输入"@"唤起常用语，或粘贴代码快速提问',
  /** `coding_safe_tips_pc` */
  safeTips: "本地部署，注意内容合规与信息安全",
  /** `coding_safe_edit_tips` */
  editedTips: "用户已编辑",
} as const;

/**
 * 七个分类（`coding_launch_page_type_*`，逐字）。
 *
 * 顺序也照证据（数据看板 → … → 网站设计），只在最前面加了「全部」（本机版的筛选需要）。
 */
export const CODING_CATEGORIES = [
  "数据看板",
  "教育培训",
  "游戏娱乐",
  "其他",
  "汇报演示",
  "效率工具",
  "网站设计",
] as const;
export type CodingCategory = (typeof CODING_CATEGORIES)[number];

/** 分类下拉的选项（「全部」+ 七类）。 */
export function categoryOptions(): Array<{ value: CodingCategory | "all"; label: string }> {
  return [{ value: "all", label: "全部" }, ...CODING_CATEGORIES.map((c) => ({ value: c, label: c }))];
}

/** 时间范围（`近 {N} 天`；`0` 表示不限）。 */
export const CODING_TIME_SLOTS = [7, 30, 0] as const;

/**
 * 时间范围的说法。
 * @param days 天数（0 = 不限）
 * @returns 例如 `近 7 天`；不限时给「全部时间」
 */
export function timeSlotLabel(days: number): string {
  return days > 0 ? `近 ${days} 天` : "全部时间";
}

/** 广场里的一个应用。 */
export type CodingApp = {
  /** 应用名（产物文件名去掉扩展名）。 */
  name: string;
  /** 磁盘路径。 */
  path: string;
  bytes: number;
  /** 最近更新时间。 */
  updatedAt: number;
  category: CodingCategory;
};

/**
 * 从文件名猜分类。
 *
 * ⚠️ 这是**猜**，猜不中就归「其他」（证据里本来就有这一类）。
 * 本体的分类是**作者在投稿时选的**，本机版没有那个环节 —— 见 §159 的差异说明。
 *
 * @param name 应用名
 * @returns 猜到的分类
 */
export function guessCategory(name: string): CodingCategory {
  const n = name.toLowerCase();
  if (/看板|大屏|数据|报表|dashboard|chart|统计/.test(n)) return "数据看板";
  if (/教学|课程|学习|教育|考试|题|老师|edu|learn/.test(n)) return "教育培训";
  if (/游戏|小游戏|贪吃蛇|俄罗斯|迷宫|game|play/.test(n)) return "游戏娱乐";
  if (/汇报|演示|ppt|幻灯|路演|总结/.test(n)) return "汇报演示";
  if (/工具|计算器|转换|生成器|效率|todo|清单|timer|倒计时/.test(n)) return "效率工具";
  if (/网站|官网|主页|落地页|landing|博客|blog|门户/.test(n)) return "网站设计";
  return "其他";
}

/**
 * 筛应用：分类 + 关键词 + 时间范围。
 *
 * @param apps 全部应用
 * @param opts 筛选条件（`query` 空串 = 不按关键词筛）
 * @returns 过滤后的列表（**不改原数组**）
 */
export function filterApps(
  apps: readonly CodingApp[],
  opts: { category?: CodingCategory | "all"; query?: string; days?: number; now?: number },
): CodingApp[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const category = opts.category ?? "all";
  const days = opts.days ?? 0;
  /*
   * ⚠️ 默认取**现在**（审计 P246）：原来是 `?? 0`，而时间范围那条条件是 `days > 0 && now > 0` ——
   * 于是"只传 `{days: 7}` 不传 now"的调用把时间筛选整个关掉：界面写着「近 7 天」，
   * 列出来的是全部。调用方想固定时间基准（测试、回放）照样可以显式传 `now`。
   */
  const now = opts.now ?? Date.now();
  return apps.filter((app) => {
    if (category !== "all" && app.category !== category) return false;
    if (q && !app.name.toLowerCase().includes(q)) return false;
    if (days > 0 && now > 0 && now - app.updatedAt > days * 24 * 3600 * 1000) return false;
    return true;
  });
}

/**
 * 搜索结果那句。
 *
 * @param count 命中数
 * @returns `找到 3 个应用`；0 个时给「暂未搜索到匹配的应用」
 */
export function searchResultLabel(count: number): string {
  return count > 0 ? `找到 ${count} 个应用` : CODING_LABELS.searchNone;
}

/**
 * Top 应用排行。
 *
 * ⚠️ **本机版口径：按最近更新排**（本体是多用户热度，本机只有你一个人，排不出来）。
 * 界面上要把这句话写明。
 *
 * @param apps 应用列表
 * @param limit 取前几个
 * @returns 排好序的列表（新的在前）
 */
export function rankApps(apps: readonly CodingApp[], limit = 5): CodingApp[] {
  return [...apps].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name, "zh")).slice(0, limit);
}

/**
 * 「创作同款」要把什么填回输入区。
 *
 * 本机版没有"应用源码 + 作者提示词"，所以这句话是**照着名字与分类组织**的 ——
 * 它得能直接丢给智能体开工（这就是这个按钮的用处）。
 *
 * @param app 应用
 * @returns 一句可执行的委托
 */
export function remixPrompt(app: CodingApp): string {
  return `照着「${app.name}」做一个类似的网页应用（分类：${app.category}）。要求：单文件 HTML，打开就能用，界面干净、移动端也能看。`;
}

/** 应用详情页里的「更多来自于」那一行。 */
export function moreFromLine(userName: string): string {
  return `更多来自于 ${userName}`;
}

/**
 * 应用名是否像个"应用"（用来从产物里挑出应用）。
 *
 * @param fileName 文件名
 * @returns 是不是网页应用
 */
export function isWebApp(fileName: string): boolean {
  return /\.html?$/i.test(fileName);
}

/**
 * 从文件名取应用名（去掉扩展名）。
 * @param fileName 文件名
 * @returns 应用名
 */
export function appNameOf(fileName: string): string {
  return fileName.replace(/\.html?$/i, "");
}

/* ─────────────────── 应用详情与喜欢（§180） ─────────────────── */

/** 详情相关文案（**逐字取自证据**）。 */
export const CODING_DETAIL_LABELS = {
  /** `coding_launch_page_detail` */
  detail: "查看详情",
  /** `coding_app_page_detail_tab` */
  detailTab: "应用详情",
  /** `coding_app_page_like_hover` */
  like: "喜欢",
  /** `coding_app_page_dislike_hover` */
  unlike: "取消喜欢",
} as const;

/**
 * 喜欢 / 取消喜欢（返回新的名单）。
 *
 * ⚠️ **本机版不做"点赞数"** —— 本体那个数字是**跨用户**的热度，
 * 本机只有你自己，编一个数字就是造假数据（与排行那条同一条规矩：
 * 排不出来就写在界面上，而不是编一个看着像的）。
 *
 * @param liked 已喜欢的应用名
 * @param name 这次点的是哪个
 * @returns 新的名单
 */
export function toggleLiked(liked: readonly string[], name: string): string[] {
  const target = String(name ?? "").trim();
  if (!target) return [...liked];
  return liked.includes(target) ? liked.filter((x) => x !== target) : [...liked, target];
}

/** 这个应用喜不喜欢（决定按钮上写「喜欢」还是「取消喜欢」）。 */
export function isLiked(liked: readonly string[], name: string): boolean {
  return liked.includes(String(name ?? "").trim());
}

/** 按钮上那句话（逐字）。 */
export function likeLabel(liked: boolean): string {
  return liked ? CODING_DETAIL_LABELS.unlike : CODING_DETAIL_LABELS.like;
}

/**
 * 从落盘的（不可信）数据里恢复喜欢名单（§180）。
 *
 * 磁盘上的东西一律当不可信处理（§178 那次的教训）：非数组给空名单，
 * 逐项只留非空字符串，并去掉重复。
 *
 * @param raw 落盘的值
 * @returns 干净的名单
 */
export function normalizeLiked(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : (raw as { liked?: unknown } | null)?.liked;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
