/* `TextRange` 是"字符串里的一段"这种通用形状，与格式那半边共用一份定义 */
import type { TextRange } from "./docFormat";
/**
 * AI 文档（§152）。
 *
 * ## 证据
 *
 * 整套界面文案**逐字取自本体前端包**（`docs/evidence-aidoc.txt`，124 条 `aiDoc_*`）。  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 * 对应路由 `/chat/new-doc` 与 `/chat/write`（线上包独有的路由级接口）。
 *
 * 所以这里的每个标签都不是我编的：
 *
 * | 键 | 文案 |
 * |---|---|
 * | `aiDoc_feature_name` | AI 文档 |
 * | `aiDoc_actionBar_concise` | 缩写 |
 * | `aiDoc_actionBar_longer` | 扩写 |
 * | `aiDoc_actionBar_refine` | 润色 |
 * | `aiDoc_actionBar_summary` | 总结概括 |
 * | `aiDoc_emptyDoc_title_placeholder` | 添加标题 |
 * | `aiDoc_emptyDoc_text_placeholder` | 记录你的想法 |
 * | `aiDoc_titleBar_saved` | 已保存 |
 * | `aiDoc_writing_hint` | 撰写中... |
 * | `aiDoc_copyDocText` | 复制全文 |
 * | `aiDoc_untitled_docName` | 未命名文档 |
 * | `aiDoc_history_title` / `_versionName_latest` / `_backToVersion` | 历史记录 / 最新版 / 回到此版本 |
 *
 * ## 与画布"写作助手"的区别
 *
 * 画布那个（`canvasGenerate.WRITING_ACTIONS`）改的是**某个节点的文字**，就地改；
 * 这里是**一份独立文档**（有自己的标题、历史版本、导出）。两者文案相近，但对象不同 ——
 * 本体也是两个功能（`canvas_writing_shortcuts_*` 与 `aiDoc_actionBar_*`）。
 */

/** 操作条上的动作（id 与本体文案一一对应）。 */
export const DOC_ACTIONS = ["concise", "longer", "refine", "summary"] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

/** 动作 → 界面文案（逐字取自 `aiDoc_actionBar_*`）。 */
export const DOC_ACTION_LABEL: Record<DocAction, string> = {
  concise: "缩写",
  longer: "扩写",
  refine: "润色",
  summary: "总结概括",
};

/** 一个历史版本。 */
export type DocVersion = {
  /** 版本号（从 1 开始，越大越新）。 */
  v: number;
  /** 那一版的正文（**整篇存**：这才是"回到此版本"能还原的东西）。 */
  body: string;
  title: string;
  at: number;
  /** 这一版是怎么来的（界面上"历史记录"里要写清）。 */
  reason: string;
};

/**
 * 历史版本上限（P18）。
 *
 * ⚠️ 原来是**无上限**：正文框每敲一键就 append 一份**整篇正文**，一份文档写 5000 字、
 * 中间敲 N 次，内存与落盘都按 O(N × 正文长度) 长 —— 大文档能把它撑爆。
 * 超出上限就丢**最旧**的几版（"回到此版本"只对还留着的版本有效）。
 */
export const DOC_VERSION_LIMIT = 50;

/**
 * 同一种改动在这个时间窗内**合并成一版**（P18：逐键记版）。
 *
 * 判据是"上一条历史与这次同源（`reason` 相同）且刚发生过" —— 连打一串字算一次编辑，
 * 而不是几百次。窗口比 `docStore` 的 400ms 落盘防抖宽一些，才盖得住连续击键。
 */
export const DOC_VERSION_MERGE_MS = 1000;

/** 版本数组的收口：超上限只留最近的（顺带保住"别让界面卡死"这条底线）。 */
function trimVersions(versions: DocVersion[]): DocVersion[] {
  return versions.length > DOC_VERSION_LIMIT ? versions.slice(-DOC_VERSION_LIMIT) : versions;
}

export type Doc = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  /** 历史版本（旧 → 新）；最后一版就是当前内容。 */
  versions: DocVersion[];
};

/** 标题的字数口径（与任务标题一致：上位 `moa_comms_taskTitleLimit` = 16 字）。 */
export const DOC_TITLE_LIMIT = 16;

/** 没有标题时的兜底（`aiDoc_untitled_docName`）。 */
export const UNTITLED_DOC = "未命名文档";

/** 界面上的占位（`aiDoc_emptyDoc_*`）。 */
export const DOC_TITLE_PLACEHOLDER = "添加标题";
export const DOC_TEXT_PLACEHOLDER = "记录你的想法";

/** 状态文案（`aiDoc_titleBar_*`）。 */
export const DOC_SAVED_LABEL = "已保存";
export const DOC_WRITING_LABEL = "撰写中...";

/**
 * 造一份空文档。
 *
 * @param id 文档 id
 * @param now 时间戳
 * @returns 新文档（**带一个初始版本**：历史里"创建了文档"那一行要有东西可指）
 */
export function makeDoc(id: string, now: number): Doc {
  return {
    id,
    title: "",
    body: "",
    createdAt: now,
    updatedAt: now,
    versions: [{ v: 0, body: "", title: "", at: now, reason: "创建了文档" }],
  };
}

/** 显示用的标题（空标题回落到「未命名文档」—— 本体就是这个兜底）。 */
export function docTitle(doc: Pick<Doc, "title">): string {
  return doc.title.trim() || UNTITLED_DOC;
}

/**
 * 改一次文档（用户手改，或操作条跑完），并把**旧内容**推进历史。
 *
 * @param doc 原文档
 * @param patch 要改的字段
 * @param reason 这次改动的由来（写进历史）
 * @param now 时间戳
 * @returns 新文档
 */
export function applyDocEdit(
  doc: Doc,
  patch: { title?: string; body?: string },
  reason: string,
  now: number,
): Doc {
  const title = patch.title === undefined ? doc.title : patch.title.slice(0, DOC_TITLE_LIMIT * 3);
  const body = patch.body === undefined ? doc.body : patch.body;
  // 没有任何变化就不记一版（否则"点一下按钮"就多一条历史）
  if (title === doc.title && body === doc.body) return doc;
  const last = doc.versions[doc.versions.length - 1];
  const nextV = (last?.v ?? 0) + 1;
  /*
   * P18：同源且刚发生的改动**并上一版**（连打一串字 = 一次编辑，不是几百次）。
   * `last.v > 0` 是刻意的：不把开头那条「创建了文档」吃掉 —— 历史面板要有个起点。
   */
  const mergeIntoLast = Boolean(last) && last!.v > 0 && last!.reason === reason && now - last!.at <= DOC_VERSION_MERGE_MS;
  const versions = mergeIntoLast
    ? [...doc.versions.slice(0, -1), { v: last!.v, body, title, at: now, reason }]
    : [...doc.versions, { v: nextV, body, title, at: now, reason }];
  return {
    ...doc,
    title,
    body,
    updatedAt: now,
    versions: trimVersions(versions),
  };
}

/**
 * 回到某个历史版本。
 *
 * 语义与"撤销"不同：**不是把中间那些版本删掉**，而是把那一版的内容
 * **再写一遍**成一个新版本（`aiDoc_history_restoredAction`：「还原自 %s 的版本」）。
 * 这样"还原"本身也可再被还原 —— 历史是单调的，不会因为一次误还原就断掉。
 *
 * @param doc 文档
 * @param v 目标版本号
 * @param now 时间戳
 * @returns 新文档；版本号不存在时原样返回
 */
export function restoreDocVersion(doc: Doc, v: number, now: number): Doc {
  const target = doc.versions.find((x) => x.v === v);
  if (!target) return doc;
  const nextV = (doc.versions[doc.versions.length - 1]?.v ?? 0) + 1;
  return {
    ...doc,
    title: target.title,
    body: target.body,
    updatedAt: now,
    // 还原本身就是一次改动 → 也进历史、也受上限约束（P18）
    versions: trimVersions([
      ...doc.versions,
      { v: nextV, body: target.body, title: target.title, at: now, reason: `还原自 v${v} 的版本` },
    ]),
  };
}

/**
 * 操作条上的动作 → 给模型的指令。
 *
 * 共同要求写在下面那段里：**只改文字，不要加解释、不要加标题、不要用代码块**。
 * 这几条是"就地改"能不能用的前提 —— 模型一旦开始客套（"以下是润色后的内容："），
 * 结果就不能直接替换正文了。
 *
 * @param action 动作
 * @returns 指令正文
 */
export function docActionInstruction(action: DocAction): string {
  const how: Record<DocAction, string> = {
    concise: "把它缩写：保留全部要点与关键数字，去掉重复与铺陈，篇幅明显短于原文。",
    longer: "把它扩写：补充必要的细节、例子与过渡，篇幅明显长于原文；不要改变原意。",
    refine: "把它润色：用语更准确顺畅、句子更连贯；不改变内容与观点。",
    summary: "把它总结概括：只留最要紧的结论与要点，压缩成一段。",
  };
  return [
    how[action],
    "",
    "硬要求：",
    "1. 只输出改完之后的正文本身，**不要**任何前言、说明、点评。",
    "2. 不要用代码块包裹。",
    "3. 不要添加原文没有的事实。",
  ].join("\n");
}

/** 历史记录里那一行的时间（`aiDoc_history_timestamp` 的 `%d月%d日`）。 */
export function versionStamp(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 导出时的默认文件名（`aiDoc_exportFile_defaultName_cn` = 在豆包创建的文档_%s）。 */
export function defaultExportName(doc: Doc): string {
  const stamp = new Date(doc.updatedAt).toISOString().slice(0, 10);
  return `${docTitle(doc)}_${stamp}`;
}

/**
 * 把磁盘上读回来的东西收窄成合法文档（**磁盘内容一律不可信**）。
 *
 * 与 `normalizeMemory` 同一个口径：坏数据不该让应用起不来，
 * 但也不能原样塞进界面（缺字段会在渲染时炸）。
 *
 * @param raw 任意值
 * @returns 合法的文档数组（旧 → 新按 updatedAt 排）
 */
export function normalizeDocs(raw: unknown): Doc[] {
  if (!Array.isArray(raw)) return [];
  const out: Doc[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const d = item as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id) continue;
    const versions: DocVersion[] = Array.isArray(d.versions)
      ? d.versions
          .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
          .map((v) => ({
            v: typeof v.v === "number" ? v.v : 0,
            body: typeof v.body === "string" ? v.body : "",
            title: typeof v.title === "string" ? v.title : "",
            at: typeof v.at === "number" ? v.at : 0,
            reason: typeof v.reason === "string" ? v.reason : "",
          }))
      : [];
    out.push({
      id: d.id,
      title: typeof d.title === "string" ? d.title : "",
      body: typeof d.body === "string" ? d.body : "",
      createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
      updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : 0,
      // 一版都没有时补一个初始版：历史面板要有点东西可显示
      versions: trimVersions(versions.length ? versions : [{ v: 0, body: "", title: "", at: 0, reason: "创建了文档" }]),
    });
  }
  return out.sort((a, b) => a.updatedAt - b.updatedAt);
}

/* ────────────────────── 从对话创建文档（§172） ────────────────────── */

/**
 * 文案（**逐字取自证据** `aiDoc_*`）。
 */
export const DOC_CREATE_LABELS = {
  /** `aiDoc_msgLongPressMenu_createDoc` */
  create: "创建文档",
  /** `aiDoc_msgLongPressMenu_createDoc_failed` */
  failed: "文档创建失败",
  /** `aiDoc_msgToDoc_placeholder` —— 建好之后要跟用户说的那句 */
  created: "已为你创建文档。你想如何调整这篇文档？请随时告诉我。",
  /** `aiDoc_createDoc_placeholder` */
  createdPlaceholder: "已为你生成文档",
} as const;

/** 一篇从消息里刨出来的文档（**只是数据，不落盘**）。 */
export type DocFromMessage = { title: string; body: string };

/**
 * 把一条消息变成一篇文档。
 *
 * 标题取**第一行非空文本**（截到 `DOC_TITLE_LIMIT`）——
 * 直接拿整段当标题的话，列表里每一条都是一大坨；
 * 全空则给"未命名文档"（`UNTITLED_DOC`）。
 *
 * ⚠️ 正文**原样保留**（不 trim 掉内部换行、不动用词）——
 * 这是用户看见过的那条回复，改一个字都是"篡改记录"。
 *
 * @param text 消息正文
 * @returns 文档数据；空消息给 `null`（调用方据此说"文档创建失败"）
 */
export function docFromMessage(text: string): DocFromMessage | null {
  const body = String(text ?? "");
  if (!body.trim()) return null;
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const title = (firstLine ?? "").slice(0, DOC_TITLE_LIMIT).trim() || UNTITLED_DOC;
  return { title, body };
}

/* ────────────────────── 粘贴 / 插入附件（§173） ────────────────────── */

/** 动作条上那几句（**逐字取自证据**）。 */
export const DOC_BAR_LABELS = {
  /** `aiDoc_actionBar_paste` */
  paste: "粘贴",
  /** `aiDoc_keyboard_actionBar_files` */
  attach: "插入附件",
  /** `aiDoc_actionBar_createNewDoc` */
  newDoc: "新建文档",
  /**
   * 剪贴板里没有文字时说的那句。
   *
   * ⚠️ **自定**：证据里没有这句话。但什么都不说更糟 ——
   * 点了没反应，用户会以为按钮坏了（与 §163 那条"静默死亡"同一个道理）。
   */
  pasteEmpty: "剪贴板里没有文字",
} as const;

/**
 * 在选区处插入一段文字（**替换选区**；没有选区就是插在光标处）。
 *
 * 与 `applyFormat` 一样是**纯本地变换**，不调模型。
 *
 * @param body 原正文
 * @param range 选区（省略则插到末尾）
 * @param insert 要插入的文字
 * @returns 新正文
 */
export function insertAt(body: string, range: TextRange | undefined, insert: string): string {
  const src = String(body ?? "");
  const text = String(insert ?? "");
  if (!range) return src + text;
  const start = Math.max(0, Math.min(range.start, src.length));
  const end = Math.max(start, Math.min(range.end, src.length));
  return src.slice(0, start) + text + src.slice(end);
}

/**
 * 给云盘里的一个文件造一条 Markdown 链接（§173，「插入附件」用）。
 *
 * 链接指向 `dshasset://file/<origin>/<名字>` —— 与云盘"复制链接"
 * **同一条协议**（那条协议只认白名单目录，名字放 path 里以保留大小写）。
 *
 * @param name 文件名
 * @param origin 来源目录
 * @returns `[名字](dshasset://file/origin/编码后的名字)`
 */
export function attachmentLink(name: string, origin: string): string {
  const safeName = String(name ?? "").trim() || "附件";
  const safeOrigin = String(origin ?? "drive").trim() || "drive";
  return `[${safeName}](dshasset://file/${safeOrigin}/${encodeURIComponent(safeName)})`;
}
