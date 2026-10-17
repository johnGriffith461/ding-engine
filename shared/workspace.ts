/**
 * 「工作区」——用户**授权给 agent 的目录**（2026-10-14）。
 *
 * ## 为什么需要它
 * 在此之前，agent 能碰的地方只有应用自己的四个目录（云盘 / 产物 / 导出 / 生成图），
 * 那些目录里放的是**用户导进来的副本**。于是"帮我整理这个文件夹""在这个项目里跑一下测试"
 * 这类最正常的请求，agent 一件都做不到 —— 它有工具，但没有**能干活的地方**。
 *
 * 工作区就是那个地方：用户选一个真实目录（比如 `D:\我的项目`），授权之后
 * `read_file` / `write_file` / `edit_file` / `search_files` / `list_dir` / `run_command`
 * **全部**在这道白名单里生效（`ownedDirs()` 一份口径，不分叉）。
 *
 * ## 边界（有意的）
 * - **授权是显式的**：要用户点一次目录选择器，agent **不可能**自己把目录加进来
 *   （主进程的 `workspace:add` 只认系统对话框的结果，不接受渲染进程传路径）；
 * - **可以随时撤销**：撤销之后同一条白名单立刻收紧 —— 不需要重启；
 * - 条数有上限（`MAX_WORKSPACES`）：授权一多，"哪里能碰"就没人记得清了。
 *
 * ⚠️ 这条模块**不 import node**（`shared/` 也打进渲染层）。
 * 绝对路径的合法性判断在主进程（那里才有 `path`）。
 */

/** 最多授权几个目录。 */
export const MAX_WORKSPACES = 8;

/** 落盘的形状（C1 信封里的 `data`）。 */
export type WorkspaceList = { dirs: string[] };

/** 空列表。 */
export function emptyWorkspaces(): WorkspaceList {
  return { dirs: [] };
}

/** 文案（本机自定措辞：证据里没有"工作区"这个概念，如实标着）。 */
export const WORKSPACE_LABELS = {
  /** 输入区 ＋ 菜单里那一条 */
  add: "授权文件夹给 agent",
  /** 菜单里的小标题 */
  group: "工作区",
  /** 授权成功的回执 */
  addedNote: "已授权：agent 现在能在这个目录里读、写、跑命令",
  /** 撤销 */
  remove: "撤销",
  /** 一个都没授权时的说明 */
  empty: "还没授权任何文件夹 —— 授权之后 agent 才能在你的目录里干活",
  /** 撤销的回执 */
  removedNote: "已撤销授权",
} as const;

/** 从磁盘读回来的东西一律不可信：规整成 `{dirs: string[]}`。 */
export function normalizeWorkspaces(raw: unknown): WorkspaceList {
  const src = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { dirs?: unknown }).dirs)
      ? (raw as { dirs: unknown[] }).dirs
      : [];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const item of src) {
    if (typeof item !== "string") continue;
    const dir = item.trim();
    if (!dir) continue;
    /* Windows 上同一个目录大小写不同会当成两个 —— 去重按小写比，存原来的写法 */
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
    if (dirs.length >= MAX_WORKSPACES) break;
  }
  return { dirs };
}

/**
 * 目录在界面上怎么显示：用最后一段（`D:\我的项目\子目录` → `子目录`）。
 *
 * ⚠️ 自己切最后一段而不用 `node:path`：这个模块也打进渲染层。
 *
 * @param dir 绝对路径
 * @returns 短名字
 */
export function workspaceLabel(dir: string): string {
  const parts = String(dir ?? "").split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

/** 授权之后给用户看的那句话（带上目录短名）。 */
export function addedNote(dir: string): string {
  return `${WORKSPACE_LABELS.addedNote}（${workspaceLabel(dir)}）`;
}
