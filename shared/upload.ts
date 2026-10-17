/**
 * 上传任务的状态与文案（§170，证据 `drive_upload_*`）。
 *
 * ## 证据
 *
 * | 键 | 文案 |
 * |---|---|
 * | `drive_upload_status_notStarted` | 未开始 |
 * | `drive_upload_status_uploading` | 正在上传 |
 * | `drive_upload_status_parsing` | 正在解析 |
 * | `drive_upload_status_uploaded` | 已完成 |
 * | `drive_upload_status_paused` | 已暂停 |
 * | `drive_upload_status_parseFail` | 解析失败 |
 * | `drive_upload_status_formatUnsupported` | 暂不支持该文件类型 |
 * | `drive_upload_status_sum` | 已上传 {s_successNumber} 个，{s_failNumber} 个上传失败 |
 * | `drive_upload_tooltip_close` / `_hideWindow` / `_showWindow` | 关闭 / 收起 / 展开 |
 *
 * ## 本机版如实做到的粒度
 *
 * 本体的上传是**流式**的（有 paused / parsing 这些中间态）。
 * 本机版的导入是**一次复制**：所以状态只有
 * **正在上传 → 已完成 / 失败**，`正在解析` / `已暂停` 这两档**不会出现**（不假装有）。
 */

/** 任务状态（本机版真的会出现的三种 + 两档保留给以后）。 */
export const UPLOAD_STATUSES = ["notStarted", "uploading", "parsing", "uploaded", "paused", "failed"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** 状态的说法（逐字取自证据）。 */
export const UPLOAD_STATUS_LABEL: Record<UploadStatus, string> = {
  notStarted: "未开始",
  uploading: "正在上传",
  parsing: "正在解析",
  uploaded: "已完成",
  /** 本机版用不到（没有可暂停的流），留着是为了与证据一一对应 */
  paused: "已暂停",
  failed: "解析失败",
};

/** 失败原因（也是逐字的）。 */
export type UploadFailReason = "formatUnsupported" | "parseFail" | "inappropriateContent";

/** 失败原因的说法。 */
export const UPLOAD_REASON_LABEL: Record<UploadFailReason, string> = {
  formatUnsupported: "暂不支持该文件类型",
  parseFail: "解析失败",
  inappropriateContent: "该文件不合规",
};

/** 面板上的三个按钮（逐字）。 */
export const UPLOAD_PANEL_LABELS = {
  close: "关闭",
  collapse: "收起",
  expand: "展开",
} as const;

/**
 * 主进程回来的单条结果。
 *
 * 与 `electron/ipc/driveStore.ts` 的 `ImportItem` **形状对齐**（那边是权威）。
 */
export type ImportItem = {
  /** 原文件名。 */
  name: string;
  /** 成功与否。 */
  ok: boolean;
  /** 失败原因（`ok=false` 时有）。 */
  reason?: UploadFailReason;
  /** 落进云盘之后叫什么（重名会加序号）。 */
  savedAs?: string;
};

/** 界面上的一个任务。 */
export type UploadTask = ImportItem & { status: UploadStatus };

/**
 * **不接的文件类型**。
 *
 * ⚠️ 这是一个**拒绝清单**，不是白名单 —— 白名单会把用户手里那些少见但正当的格式
 * （`.psd`、`.zip`、`.epub`…）一并挡在门外，那种"保险"代价太大。
 * 这里只挡**可执行与安装包**那一类：云盘是放内容的地方，不是分发程序的地方。
 */
export const UNSUPPORTED_EXT = [
  // 可执行 / 动态库
  "exe",
  "dll",
  "com",
  "scr",
  "cpl", // 控制面板项：双击即执行
  "pif", // 16 位程序的信息文件：在旧壳里就是可执行入口
  "jar", // Java 程序包（有 JRE 的机器双击就跑）
  // 安装包
  "msi",
  "msp",
  "msix",
  "appx",
  // 脚本宿主（Windows Script Host / HTML 应用）
  "bat",
  "cmd",
  "ps1",
  "vbs",
  "vbe",
  "wsf",
  "hta", // HTML Application：由 mshta.exe 执行，与 .exe 同级
  // 快捷方式与注册表
  "lnk",
  "reg",
] as const;

/**
 * 这个文件名能不能接。
 *
 * @param name 文件名
 * @returns 不支持则 true
 */
export function isUnsupported(name: string): boolean {
  const base = String(name ?? "").trim().toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return (UNSUPPORTED_EXT as readonly string[]).includes(base.slice(dot + 1));
}

/**
 * 把主进程的结果变成任务列表（新来的排前面）。
 *
 * @param items 主进程给的结果
 * @returns 任务列表（成功=已完成、失败=解析失败）
 */
export function toTasks(items: readonly ImportItem[]): UploadTask[] {
  return items.map((item) => ({
    ...item,
    status: item.ok ? "uploaded" : "failed",
  }));
}

/**
 * 汇总那一句（`drive_upload_status_sum` = 已上传 N 个，M 个上传失败）。
 *
 * @param tasks 任务列表
 * @returns 例如 `已上传 2 个，1 个上传失败`
 */
export function summarize(tasks: readonly UploadTask[]): string {
  const done = tasks.filter((t) => t.status === "uploaded").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  return `已上传 ${done} 个，${failed} 个上传失败`;
}

/**
 * 一条任务要显示的那句话（状态 + 失败原因）。
 *
 * @param task 任务
 * @returns 例如 `解析失败（暂不支持该文件类型）`
 */
export function taskLine(task: UploadTask): string {
  const base = UPLOAD_STATUS_LABEL[task.status];
  if (task.status !== "failed" || !task.reason) return base;
  return `${base}（${UPLOAD_REASON_LABEL[task.reason]}）`;
}

/** 面板要不要显示（没有任何任务时不该占着地方）。 */
export function shouldShowPanel(tasks: readonly UploadTask[]): boolean {
  return tasks.length > 0;
}

/* ─────────────────────────── 拖拽上传（§171） ─────────────────────────── */

/**
 * 拖拽区/入口上的文案（**逐字取自证据**）。
 *
 * ⚠️ 证据里**没有**"拖进来"/"松开"这种专有文案（`drop`/`拖拽` 一条都搜不到）——
 * 所以这里不编新词，直接用证据里那两句已有的：`drive_upload_file` / `drive_upload_image`。
 */
export const UPLOAD_HINTS = {
  /** `drive_upload_file` */
  file: "上传文件",
  /** `drive_upload_image` */
  image: "上传图片",
} as const;

/**
 * 成功之后的提示（`drive_toast_uploaded_number` = 已上传 {s_uploadNo} 个文件）。
 *
 * @param n 成功个数
 * @returns 例如 `已上传 3 个文件`
 */
export function uploadedNote(n: number): string {
  return `已上传 ${n} 个文件`;
}
