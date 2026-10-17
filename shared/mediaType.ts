/**
 * 媒体容器判定（2026-10-16，审计 P228）。
 *
 * ## 为什么不能一律按 `.mp4` 落盘
 *
 * 视频通道的成品**按上游真实容器**说话：relay/各家模型返回的容器并不统一
 * （mp4 / webm / mov / gif 都可能）。原来一律写 `video-<时间>.mp4` 并拼成
 * `dshasset://…mp4`，于是：
 *   · 文件名与真实容器不符；
 *   · `dshasset://` 那侧按扩展名给的 MIME 也错 → 界面 `<video>` 拿到
 *     `video/mp4` 却喂了一份 webm，表现为"生成成功但放不出来"。
 *
 * ## 判定顺序：**先看魔数，再看 Content-Type，最后才回默认**
 *
 * 魔数是文件自己说的（最可靠），Content-Type 是通道头说的（中转常写错），
 * 两者都没有才回 `.mp4` —— 而那条路径在返回值里**如实标注**（`容器未知`），
 * 不假装知道。
 */

/** 常见视频容器的魔数（只看文件头几字节）。 */
function sniffByMagic(head: Uint8Array): string | null {
  if (head.length >= 12) {
    /* ISO BMFF：第 4–8 字节是 "ftyp"；再往后 4 字节是 brand（qt 的是 mov 的祖先） */
    const ftyp = String.fromCharCode(...head.subarray(4, 8));
    if (ftyp === "ftyp") {
      const brand = String.fromCharCode(...head.subarray(8, 12));
      return brand === "qt  " ? ".mov" : ".mp4";
    }
  }
  /* Matroska / WebM：EBML 头 1A 45 DF A3 */
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return ".webm";
  /* GIF87a / GIF89a */
  if (head.length >= 6 && String.fromCharCode(...head.subarray(0, 4)) === "GIF8") return ".gif";
  /* Ogg（含 OGV）*/
  if (head.length >= 4 && String.fromCharCode(...head.subarray(0, 4)) === "OggS") return ".ogv";
  return null;
}

/** Content-Type → 扩展名（只认常见的几个，别的不猜）。 */
function byContentType(contentType: string | null | undefined): string | null {
  const type = String(contentType ?? "").split(";")[0]!.trim().toLowerCase();
  switch (type) {
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    case "video/quicktime":
      return ".mov";
    case "video/x-matroska":
    case "video/mkv":
      return ".mkv";
    case "video/mpeg":
      return ".mpeg";
    case "video/ogg":
      return ".ogv";
    case "image/gif":
      return ".gif";
    default:
      return null;
  }
}

/**
 * 定一个成品该用的扩展名。
 *
 * @param contentType 响应头（可能是 null / 写错的）
 * @param head 成品开头若干字节（有就给，用于魔数判定）
 * @returns 形如 `.mp4`（判不出来就 `.mp4`，但调用方应按 `isKnown` 如实标注）
 */
export function videoExtensionFor(contentType: string | null | undefined, head?: Uint8Array): { ext: string; isKnown: boolean } {
  const magic = head && head.length ? sniffByMagic(head) : null;
  if (magic) return { ext: magic, isKnown: true };
  const typed = byContentType(contentType);
  if (typed) return { ext: typed, isKnown: true };
  return { ext: ".mp4", isKnown: false };
}
