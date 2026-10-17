/**
 * 构建 SDK 包（V5-4 4.1）：`packages/<name>` → 独立可发布的 npm 包。
 *
 * ## 为什么是 tsc + CommonJS（而不是打包器 + ESM）
 *
 * 与主仓 CLI 的构建同一条路（`scripts/build-cli.mjs`）：tsc 直出 CJS。
 * 理由只有一条 —— **CJS 的解析规则允许省略扩展名**，而这个代码库的几千条
 * 相对 import 全是省略扩展名的。要出 ESM 就得先改全部 import（或者加一个
 * 会改语义的重写步骤），那两件事都比"产物是 CJS"贵得多。
 * Node 对 CJS 的互操作支持 `import`（具名导出也能认），消费方无感。
 *
 * ⚠️ `dist/` 里放一个 `{"type":"commonjs"}` 标记：根 package.json 是 ESM，
 * 不放的话 Node 会拿 ESM 规则解释产物 —— 一跑就 `require is not defined`
 * （与 CLI 那条同一个坑，见 `build-cli.mjs` 的第一条）。
 *
 * 用法：`node scripts/build-sdk.mjs engine-core` / `node scripts/build-sdk.mjs engine`
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const PACKAGES = {
  "engine-core": { dir: "packages/engine-core", entry: "dist/packages/engine-core/src/index.js" },
  engine: { dir: "packages/engine", entry: "dist/packages/engine/src/index.js" },
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(PACKAGES);
for (const name of names) {
  const pkg = PACKAGES[name];
  if (!pkg) {
    console.error(`[sdk] ✗ 不认识这个包：${name}（可用：${Object.keys(PACKAGES).join(" / ")}）`);
    process.exit(1);
  }
  const dir = path.join(ROOT, pkg.dir);
  const dist = path.join(dir, "dist");

  /* 先清空：tsc 不删旧产物，留着会把上个版本的文件一起发布出去（CLI 那条踩过） */
  rmSync(dist, { recursive: true, force: true });
  process.stdout.write(`[sdk] ${name}：编译（tsc -p ${pkg.dir}/tsconfig.build.json）…\n`);
  /* 直接跑 typescript 的 JS 入口（不吃 npx 在 Windows 上的 .cmd 限制，见 build-cli.mjs） */
  try {
    execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
      cwd: dir,
      stdio: "inherit",
    });
  } catch {
    /* 编译错误上面已经原样打出来了 —— 这里只把"哪一步坏了"说清楚，别甩一坨栈 */
    console.error(`[sdk] ✗ ${name} 编译失败（上面的错误就是原因）`);
    process.exit(1);
  }
  writeFileSync(path.join(dist, "package.json"), '{"type":"commonjs"}\n', "utf8");

  const entry = path.join(dir, pkg.entry);
  if (!existsSync(entry)) {
    console.error(`[sdk] ✗ ${name} 的入口没生成：${pkg.entry}`);
    process.exit(1);
  }
  process.stdout.write(`[sdk] ✓ ${name} → ${pkg.dir}/dist（入口 ${pkg.entry}）\n`);
}
