/**
 * 云盘的文件分类与排序（阶段 11.5）。
 *
 * 云盘页原来是**遍历得到的静态行** —— 那是把"当时看到的那几个文件名"当成了实现，
 * 换成真实目录之后一行都不对。这里把"扩展名 → 类型"和排序口径做成纯逻辑，
 * 主进程与界面两边共用。
 *
 * 分类口径对齐上位的产物类型（proto `ArtifactResourceType`）与云盘 tab：
 * 文档 / 表格 / 演示 / 图片 / 画布 / 代码 / 其他。
 */

/** 文件类目。 */
export type DriveKind = "doc" | "sheet" | "slides" | "image" | "canvas" | "code" | "other";

/** 类目的显示名与图标底色（界面用）。 */
export const DRIVE_KIND_META: Record<DriveKind, { label: string; tone: string }> = {
  doc: { label: "文档", tone: "is-doc" },
  sheet: { label: "表格", tone: "is-sheet" },
  slides: { label: "演示", tone: "is-slides" },
  image: { label: "图片", tone: "is-image" },
  canvas: { label: "画布", tone: "is-canvas" },
  code: { label: "代码", tone: "is-code" },
  other: { label: "其他", tone: "is-other" },
};

/** 扩展名 → 类目。加一种格式只加一行。 */
const EXT_KIND: Record<string, DriveKind> = {
  md: "doc",
  markdown: "doc",
  txt: "doc",
  docx: "doc",
  doc: "doc",
  pdf: "doc",
  rtf: "doc",
  xlsx: "sheet",
  xls: "sheet",
  csv: "sheet",
  pptx: "slides",
  ppt: "slides",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  svg: "image",
  bmp: "image",
  html: "code",
  htm: "code",
  json: "canvas",
  py: "code",
  js: "code",
  ts: "code",
  tsx: "code",
  css: "code",
  sh: "code",
  yml: "code",
  yaml: "code",
};

/**
 * 按扩展名判断类目。
 *
 * `json` 归画布是有意的：这个工作台里落盘的 json 主要是画布文档与产物元数据，
 * 归到"代码"里会让画布产物看不见。认不出来的扩展名归"其他"，不硬猜。
 *
 * @param name 文件名
 * @returns 类目
 */
export function kindOf(name: string): DriveKind {
  const base = String(name ?? "").trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "other";
  return EXT_KIND[base.slice(dot + 1)] ?? "other";
}

/** 云盘里的一条文件。 */
export type DriveEntry = {
  name: string;
  /** 绝对路径（主进程给的）。 */
  path: string;
  bytes: number;
  /** 落盘时间（毫秒）。 */
  createdAt: number;
  /** 最近修改时间（毫秒）—— 界面上的「最近访问」列用它。 */
  modifiedAt: number;
  kind: DriveKind;
  /**
   * 来自哪个来源目录，界面上做区分。
   *
   * ⚠️ 这几个值**必须与主进程 `driveStore.sources()` 白名单一一对应** ——
   * `dshasset://file/<origin>/<名字>` 那条协议只认这几个目录（§166）。
   */
  origin: "artifact" | "export" | "drive" | "asset";
};

/**
 * 来源的显示名（**一处映射**）。
 *
 * 原来界面上是两个写死的 if（产物 / 导出），加第四个来源时就得记着再去改一处 ——
 * 这种"加一个枚举值要改 N 个地方"的写法迟早漏。集中成一张表。
 */
export const ORIGIN_LABEL: Record<DriveEntry["origin"], string> = {
  artifact: "产物",
  export: "导出",
  drive: "",
  /** 生成图片落的那本"素材"（`aiCreation_asset_*` 那一组叫素材） */
  asset: "素材",
};

/**
 * 给**工具留痕 / 模型**看的来源名。
 *
 * ⚠️ 与 `ORIGIN_LABEL` 是**同一处映射**，只补上 `drive` 的名字（审计 P104）：
 * 界面上自己那一栏不用标来源，所以 `ORIGIN_LABEL.drive` 是空串；
 * 而工具留痕里不能留空（否则模型看到「在目录」这种断句）。
 * 原来 `shared/fileList.ts` 另抄了一份表，asset 在那边叫「生成图」——
 * 同一批文件界面上叫素材、留痕里叫生成图，用户按界面名问、模型答另一个名。
 * 「同一个来源两个名」这种事只会在加第四个来源时暴露，所以这里**只留这一处**：
 * 改这个值就是改两边（`src/fileList.test.ts` 有一条同源断言盯着）。
 */
export const ORIGIN_LABEL_FOR_MODEL: Record<DriveEntry["origin"], string> = {
  ...ORIGIN_LABEL,
  drive: "云盘",
};

/**
 * 云盘的标签页（§157 按证据补齐）。
 *
 * 本体就是 **全部 / 我的 / 最近 / AI 文档** 这四个（`drive_tab_all|myFiles|recent|AIDocs`）；
 * `starred`（收藏）是本机版自己加的一个，保留着 —— **只增不减**，
 * 因为已经有验收在点它。
 */
export type DriveTab = "all" | "recent" | "mine" | "aidocs" | "starred";

/**
 * 按 tab 取文件列表。
 *
 * @param entries 全部文件
 * @param tab 当前 tab
 * @param starred 收藏的名字集合
 * @returns 排好序的列表
 */
export function selectEntries(entries: DriveEntry[], tab: DriveTab, starred: Set<string>): DriveEntry[] {
  if (tab === "starred") return sortByName(entries.filter((e) => starred.has(e.name)));
  if (tab === "recent") return sortByRecent(entries);
  if (tab === "aidocs") return sortByRecent(entries.filter(isAiDocEntry));
  // 「全部」与「我的」在本机版是同一批文件（本机没有"别人的文件"），区别只在以后接成员时
  return sortByName(entries);
}

/**
 * 「AI 文档」收什么（`drive_tab_AIDocs`）。
 *
 * 定义：**智能体产出**的文档与画布 —— 这些能回到对话里接着改；
 * 上传进来的文件不算（它的"前任"不在这台机器的对话里）。
 *
 * ⚠️ 原来这里写着「判据与 `shared/driveOps.ts` 的 `isAiDoc` 保持一致」——
 * 那个文件随云盘页一起拆掉了（2026-10-16），现在**只有这一份**判据
 * （`isAiDocEntry` 就是它）。
 */
export function isAiDocEntry(entry: DriveEntry): boolean {
  return entry.origin === "artifact" && (entry.kind === "doc" || entry.kind === "canvas");
}

/**
 * 按最近修改倒序（「最近」tab 的口径）。
 * 时间相同时退回按名字，保证顺序**稳定**（否则每次渲染都在跳）。
 */
export function sortByRecent(entries: DriveEntry[]): DriveEntry[] {
  return [...entries].sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name, "zh"));
}

/** 按名字（「我的」tab 的口径，中文按拼音序）。 */
export function sortByName(entries: DriveEntry[]): DriveEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/**
 * 把字节数说成人话。
 * @param bytes 字节数
 * @returns 例如 `890 B` / `12.4 KB` / `1.2 MB`
 */
export function formatBytes(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 把时间戳说成人话（云盘表格里的「7月2日 15:04」）。
 * @param at 毫秒时间戳
 * @param now 当前时间（调用方传入，便于测试）
 * @returns 例如 `7月2日 15:04`；今年以外带年份
 */
export function formatDriveTime(at: number, now: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}年${md}`;
}

/**
 * 统计各类目数量（界面上给 tab 旁的计数）。
 * @param entries 文件列表
 * @returns 类目 → 数量（只含出现过的类目）
 */
export function countByKind(entries: DriveEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of entries) out[entry.kind] = (out[entry.kind] ?? 0) + 1;
  return out;
}

/**
 * 一份文件的文本上限（超过就不往阅读器 / 工具里塞 —— 界面会卡住）。
 *
 * 2026-10-16：原来住在 `shared/driveFiles.ts`（云盘的改名 + 读取那支）。
 * 云盘页拆掉之后，只剩这一个常量还有人用（`electron/ipc/driveStore.ts` 与读文件工具），
 * 所以并进这里 —— 一个常量不值得单独一支文件。
 *
 * ⚠️ 值与 `engine/runtime/tools/readTool.ts` 的 `READ_MAX_BYTES` **必须一样**
 * （审计 P56：那边 200_000、这边原来是 200 * 1024 = 204800，两份值不同，
 * 而 readTool 的注释自称"与 `drive:read` 一致"）。同值由
 * `src/sharedContract.test.ts ②` 直接读两处源码对账。
 *
 * ⚠️ 2026-10-16（审计 P234）：这一份现在**被 `shared/agentTools.ts` 取用了** ——
 * 写文件的上限（`WRITE_FILE_MODEL_BYTES`）就是从这儿拿的，于是"写 / 读 / 改"三道闸
 * 共用一个字节预算，而不是三处各写一个 200_000（那段注释原来写着"收成一处要
 * engine 那侧 import 这里（不在本轮范围）"；这一轮做的就是它）。
 */
export const READ_MAX_BYTES = 200_000;
