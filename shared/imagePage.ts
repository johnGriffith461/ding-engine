/**
 * 生成图片独立页（`chat/create-image`，§165）。
 *
 * ## 证据
 *
 * | 键 | 文案 |
 * |---|---|
 * | `aiCreation_canvas_toolbar_imageGenerator` | **图片生成** |
 * | `aiCreation_canvas_imageGenerator_inputPlaceholder` | **描述你想生成的图片** |
 * | `aiCreation_canvas_task_retry` | **重新生成** |
 * | `aiCreation_canvas_html_save_img` | **保存图片** |
 * | `aiCreation_asset_action_download` | **下载** |
 * | `aiCreation_canvas_download_saveSuccess` | 保存成功 |
 * | `aiCreation_canvas_download_saveFailed` | **保存失败，请重试** |
 * | `aiCreation_asset_download_failed` | **下载失败，请重试** |
 * | `aiCreation_asset_category_image` | 图片 |
 *
 * ## 为什么这个页面很薄
 *
 * **生成能力与整套尺寸选择早就在画布里了**（`src/canvas/GeneratePanel.tsx`，
 * 335 行，含三档模式 × 8 比例 × 3 档位 + 确定性规整）。
 * 本体的 `create-image` 是**另一个入口**（独立页），不是另一套实现 ——
 * 所以这里**复用那个面板**，只在外面加"这一页独有的东西"：**最近生成**。
 *
 * > 这条是 §163/§164 学到的：**先查再写**。原本打算"实现生成图片"，
 * > 查完发现只差一个入口与一份列表。
 */

/** 界面文案（逐字取自证据；自定的那两条标了"自定"）。 */
export const IMAGE_PAGE_LABELS = {
  title: "图片生成",
  placeholder: "描述你想生成的图片",
  retry: "重新生成",
  save: "保存图片",
  download: "下载",
  saveSuccess: "保存成功",
  saveFailed: "保存失败，请重试",
  downloadFailed: "下载失败，请重试",
  /** 自定：证据里没有"最近生成"这一段（本体生成结果落进素材库） */
  recent: "最近生成",
  recentEmpty: "还没有生成过 —— 写一句描述试试",
  /** `aiCreation_asset_category_image` */
  category: "图片",
} as const;

/** 一次生成的记录。 */
export type Generation = {
  /** 可直链的 url（主进程给的）。 */
  url: string;
  /** 落盘文件名。 */
  name: string;
  prompt: string;
  model: string;
  size: string;
  at: number;
};

/** 最近生成最多留几条（再多也不看，还会把内存撑起来）。 */
export const GENERATION_LIMIT = 12;

/**
 * 记一次生成。
 *
 * 规矩：
 * 1. **同一个 url 不重复**（同一张图重复收会让人以为生成了两次）；
 * 2. 新的在最前；
 * 3. 超过上限砍最旧的。
 *
 * @param list 现有列表
 * @param item 新的记录
 * @param limit 上限
 * @returns 新数组（不改原数组）
 */
export function addGeneration(
  list: readonly Generation[],
  item: Generation,
  limit = GENERATION_LIMIT,
): Generation[] {
  const rest = list.filter((g) => g.url !== item.url);
  return [item, ...rest].slice(0, limit);
}

/**
 * 给"保存图片"起个文件名。
 *
 * ⚠️ 不编造扩展名之外的信息：拿不到就用提示词前几个字 + 时间戳；
 * 提示词里的路径分隔符等**必须清掉**（否则下载会变成一个奇怪的路径）。
 *
 * @param gen 一次生成
 * @param ext 扩展名（默认 png）
 * @returns 安全的文件名
 */
export function downloadName(gen: Pick<Generation, "url" | "name" | "prompt" | "at">, ext = "png"): string {
  const fromUrl = (() => {
    try {
      const path = new URL(gen.url).pathname;
      /*
       * ⚠️ `pathname` 是**百分号编码**的（`%E7%85%A7%E7%89%87-1.png`）——
       * 直接拿去当文件名会得到一串乱码，用户根本认不出自己存了什么。
       * 解不开（坏编码）就退回后面的兜底，别让一个名字把整件事搞崩。
       */
      let base = "";
      try {
        base = decodeURIComponent(path.split("/").pop() ?? "");
      } catch {
        base = "";
      }
      return /\.(png|jpe?g|webp)$/i.test(base) ? base : "";
    } catch {
      return "";
    }
  })();
  if (fromUrl) return fromUrl;
  if (/\.(png|jpe?g|webp)$/i.test(gen.name ?? "")) return gen.name;
  const clean = (gen.prompt ?? "")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    // `..` 单独留着虽然已经逃不出去（分隔符都没了），但名字里带它看着就像穿越，一起收掉
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const stamp = new Date(gen.at || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${clean || "图片"}-${stamp}.${ext}`;
}

/** 「重新生成」用：是否还能用同一句话再生成一次。 */
export function canRetry(gen: Pick<Generation, "prompt"> | null): boolean {
  return Boolean(gen && gen.prompt.trim());
}

/**
 * 视频生成页的文案（§174，**逐字取自证据**）。
 *
 * 放在这个文件里是因为它和图片页**共用同一套生成记录逻辑**
 * （`addGeneration` / `downloadName` / `canRetry`）—— 两个页面是兄弟。
 */
export const VIDEO_PAGE_LABELS = {
  /** `aiCreation_canvas_toolbar_videoGenerator` */
  title: "视频生成",
  /** `aiCreation_landingPage_placeholder_describeVideo` */
  placeholder: "描述你想要的视频",
  /** `aiCreation_asset_category_video` */
  category: "视频",
  /** 段标题：与图片页同一个词（证据里没有单独给视频的那一个） */
  recent: IMAGE_PAGE_LABELS.recent,
  /** `aiCreation_asset_history_empty_description` —— 证据原话是"图片和视频"都在这儿 */
  recentEmpty: "生成的图片和视频会显示在这里",
} as const;
