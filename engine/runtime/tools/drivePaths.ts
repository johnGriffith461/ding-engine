import fs from "node:fs";
import path from "node:path";

/**
 * 云盘路径的**归属判断**（A1）。
 *
 * ## 为什么单独一个文件
 *
 * 这条判断原来长在 `driveStore.ts` 里（`insideOwnedDirs`），而那个文件**顶层 `import` 了 `electron`**。
 * 后果有两个：
 *
 * 1. 这份"判断"在 Electron 之外**一行都跑不了** —— 想验它只能真启一个应用；
 * 2. 本项目主进程**没有测试基础设施**（`vitest.config.ts` 只收 `src/` 下的 `*.test.ts`），
 *    于是它没有任何断言钉着：`drive:read` 与 `drive:rename` 漏掉这次校验时，
 *    **没有任何一条测试会红**。
 *
 * 抽到这个文件之后，依赖只剩 `node:path`（**不 import electron**）：
 * 主进程照旧用，`src/workbench/drivePaths.test.ts` 也能直接 `import` 它做真断言
 * （`tsconfig.json` 的 `include` 本就含 `electron`）。
 *
 * ⚠️ 判断口径**与原实现逐字一致**（`rel === ""` 即"目录自身"仍然放行）——
 * A1 只要求让两个漏掉的 handler **走同一道校验**，不改这道校验本身的语义，
 * 否则 `remove` / `duplicate` / `reveal` / `open` 的行为会跟着一起变。
 * "目录自身"那一路另由各 handler 自己挡（例如 `rename` 要求源必须是普通文件）。
 *
 * ⚠️ 2026-10-16（审计 P04）：上面那句"逐字一致"从这份改动起只对**返回值**成立 ——
 * 归属判断本身改成了按真实路径（`realpathSync`）比对，junction / 符号链接不能再穿墙。
 * 返回给调用方的仍是 `path.resolve` 的那份（见 `insideDirs` 里的说明）。
 *
 * @param raw 渲染进程给的路径（**不可信**，见下）
 * @param dirs 允许的目录白名单（绝对路径）
 * @returns 通过校验的绝对路径；不通过返回 `null`
 */
export function insideDirs(raw: string, dirs: readonly string[]): string | null {
  /*
   * 跨进程边界上必须挡一手：不校验的话渲染进程传任意路径，
   * 就能让主进程删它 / 打开它 / 读它 —— 叠加 `electron/main.ts` 的 `sandbox: false`
   * （渲染进程与主进程同权限），这个口子的含义不只是"越权读一个文件"。
   */
  const resolved = path.resolve(String(raw ?? ""));
  /*
   * ⭐ **归属判断按真实路径做**（2026-10-16，审计 P04）。
   *
   * 原来只比 `path.resolve` 的**字面**结果：`C:\owned\link\secret.txt` 字面上确实
   * 在 `C:\owned` 里，但 `link` 若是指向 `C:\secret` 的 junction / 符号链接，
   * 真正落点就在白名单外 —— 白名单被绕过，而四类落点（读/写/改/跑）共用这一处判断。
   *
   * 判**内容**用真实路径（`realpathSync`），**返回**的仍是上面那份 `resolved`：
   * 调用方拿到的路径与改动前逐字一致（现有断言与"大小写不敏感"那条都依赖它），
   * 改的只是"这个落点算不算在白名单里"这一个结论。
   */
  const realResolved = realPathFor(raw);
  for (const dir of dirs) {
    const rel = path.relative(realPathFor(dir), realResolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return resolved;
  }
  return null;
}

/**
 * 求一个路径的**真实**（符号链接/junction 展开后）绝对路径。
 *
 * `fs.realpathSync` 对**还不存在**的路径会抛（新建文件、写盘前的探路都要经过这里），
 * 所以从叶子往上找第一个存在的祖先、展开它、再把剩下的片段拼回来 ——
 * 这样"待创建的新文件"也能拿到它将来真正落在哪。
 *
 * ⚠️ 到根还展不开时退回 `path.resolve`（物理上不存在的位置没什么可展开的），
 * 不抛 —— 这个函数在热路径上（每个工具调用都走），不能因为一个怪路径把工具打死。
 */
function realPathFor(p: string): string {
  const abs = path.resolve(String(p ?? ""));
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}
