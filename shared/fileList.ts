import { ORIGIN_LABEL_FOR_MODEL, type DriveEntry } from "./drive";

/**
 * 「列文件」工具要说的那段话（2026-10-14）。
 *
 * ## 为什么单独一个纯模块
 * 与 `readTool.ts` 同一个理由：主进程那边没有测试基础设施，纯函数抽出来才能在
 * `src/**` 的 vitest 里钉住。这里要钉的是三件容易做错的事：
 *   · **上限**：文件多的时候不能把整个目录塞进上下文（截断并**说明总量**）；
 *   · **空目录**：要说"还没有文件"，而不是回一个空串（空串会让模型以为工具坏了）；
 *   · **每条写清"哪个目录、多大"**：模型据此才知道该读哪个、以及要不要先问用户。
 */

/** 一次最多列多少个文件（超出截断，并说明总数）。 */
export const FILE_LIST_LIMIT = 100;

/**
 * 把云盘条目写成给模型看的一份清单。
 *
 * @param entries 云盘里的文件（`listDrive()` 的产物）
 * @param limit 最多列几个
 * @returns 一小段文字：每条一行，名字 + 大小 + 来源；超出时注明总数
 */
export function formatFileList(entries: readonly DriveEntry[], limit = FILE_LIST_LIMIT): string {
  if (entries.length === 0) {
    /*
     * 空目录要**说清是空的**：回一个空串的话，模型会以为"工具没返回"，
     * 然后去猜或者反复重试（这也是它最容易编内容的时候）。
     */
    return "用户的云盘 / 产物 / 导出目录里现在还没有文件。";
  }

  const shown = entries.slice(0, limit);
  const lines = shown.map((e) => {
    const size = e.bytes >= 1024 * 1024 ? `${(e.bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(e.bytes / 1024))}KB`;
    /*
     * 来源名**跟界面用同一张表**（`ORIGIN_LABEL_FOR_MODEL`，见 `shared/drive.ts`）：
     * 这里原来另抄了一份，asset 在界面上叫「素材」、在留痕里叫「生成图」（审计 P104）。
     */
    const from = ORIGIN_LABEL_FOR_MODEL[e.origin] ?? e.origin;
    return `- ${e.name}（${size}，在${from}目录）`;
  });

  const head = `共 ${entries.length} 个文件：`;
  const tail = entries.length > shown.length ? `\n（只列了前 ${shown.length} 个；要读没列出来的，直接给文件名或完整路径都行）` : "";
  return head + "\n" + lines.join("\n") + tail;
}
