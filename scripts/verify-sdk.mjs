/**
 * SDK 冒烟验收（V5-4 4.1 / 4.3 的机器证据）：
 * **把两个包打成 tarball → 装进一个干净工程 → 原样跑 `examples/sdk-turn`**。
 *
 * ## 验的是什么
 *
 * 1. **独立构建**：`packages/engine-core` 与 `packages/engine` 各自 `tsc` 出一份产物
 *    （不共用根工程的路径别名、不依赖仓库内部的相对路径约定）；
 * 2. **打包可发布**：`npm pack` 出的 tarball 里该有的都在（`files` 字段）、
 *    `exports` 映射解得开（两种写法：`import` 与 `require`）；
 * 3. **闭包边界在产物里成立**：engine-core 的 dist **不含** `node:*` 的 import；
 *    而 ding-engine 的 dist **有**（两个包是真的不同，不是改名复制）；
 * 4. **陌生人那条路能跑通**：把示例文件原样复制到干净工程里跑 ——
 *    完整面（SQLite 真落盘）与最小面（内存 store，不碰文件系统）各一轮。
 *
 * ## 不验什么（如实说）
 *
 * **没有真发布到 npm**（`npm publish` 要主人授权）。所以"能从 registry 装"这一条
 * 不在证据里；这里验到的是"装本地 tarball 能跑" —— 发布前能拦住的错，
 * 这条基本都能拦住（exports 写错、files 漏了 dist、产物炸了）。
 *
 * 用法：`node scripts/verify-sdk.mjs`（退出码非零 = 有断言红）。
 */

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bad = [];
const ok = (cond, what) => {
  if (cond) {
    console.log(`  ✓ ${what}`);
    return;
  }
  bad.push(what);
  console.error(`  ✗ ${what}`);
};

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });

/* ── ① 构建 ─────────────────────────────────────────────────────── */
console.log("① 两个包各自构建");
try {
  run(process.execPath, ["scripts/build-sdk.mjs"]);
  ok(true, "build-sdk.mjs 跑通（engine-core + engine）");
} catch (error) {
  ok(false, `构建失败：${String(error.stdout ?? "").slice(-300)}`);
  process.exit(1);
}

const coreDist = path.join(ROOT, "packages/engine-core/dist");
const engineDist = path.join(ROOT, "packages/engine/dist");
ok(existsSync(path.join(coreDist, "engine/index.js")), "engine-core 入口产物在");
ok(existsSync(path.join(coreDist, "engine/index.d.ts")), "engine-core 类型声明在");
ok(existsSync(path.join(engineDist, "packages/engine/src/index.js")), "engine 入口产物在");

/** 把一份 dist 里所有 .js 读成一个大字符串（查 import 用）。 */
const readDist = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
};

const coreCode = readDist(coreDist);
const engineCode = readDist(engineDist);
/*
 * ⚠️ 先量"读到了没有"：这一条曾经假绿过 —— 读取函数里用了一句跑不通的 `require`
 * （这个脚本自己是 ESM），于是两边都是空串，而"空串里没有 node:fs"当然成立。
 * 一条断言在"输入是空的"时也会绿，那它就不是断言。
 */
ok(
  coreCode.length > 1000 && engineCode.length > 1000,
  `两份产物都真读到了（core ${coreCode.length} 字节 / engine ${engineCode.length} 字节）`,
);
ok(!/require\("node:(fs|os|path|child_process)"\)/.test(coreCode), "engine-core 产物里没有 node:fs/os/path/child_process（最小面成立）");
ok(/require\("node:fs"\)/.test(engineCode), "ding-engine 产物里有 node:fs（完整面真的是完整面）");

/* ── ② 打包 + 装进干净工程 ───────────────────────────────────────── */
console.log("\n② 打包（npm pack）与安装");
const tmp = mkdtempSync(path.join(os.tmpdir(), "ding-sdk-verify-"));
const appDir = path.join(tmp, "app");
const nm = path.join(tmp, "node_modules");
mkdirSync(appDir, { recursive: true });
mkdirSync(path.join(nm, "@ding"), { recursive: true });

const packInto = (pkgDir) => {
  const out = execFileSync("npm", ["pack", "--pack-destination", tmp, "--json"], {
    cwd: path.join(ROOT, pkgDir),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    /*
     * 参数是**常量**（`pack --pack-destination <临时目录> --json`），所以
     * `shell: true` 在这里只是为了让 Windows 上的 `npm.cmd` 能被 spawn 出来
     * —— 那会带一条 DEP0190 告警，是预期的，不是问题。
     */
    shell: true,
  });
  /*
   * `--json` 的输出**不是纯 JSON**：npm 会在前后夹自己的 notice 行（实测过）。
   * 只要那个文件名 —— 用正则取，别跟 npm 的输出格式较劲。
   */
  const got = /"filename"\s*:\s*"([^"]+)"/.exec(out);
  if (!got) throw new Error(`从 npm pack 的输出里读不出文件名：\n${out.slice(-400)}`);
  return path.join(tmp, got[1]);
};

/**
 * 解开一个 `.tgz`（npm tarball）。
 *
 * ⚠️ 不用系统的 `tar`：Windows 自带的是 bsdtar，而它把 `C:\...` / `C:/...`
 * 当成"远程主机 C 上的路径"（`Cannot connect to C: resolve failed`，实测）。
 * 与其跟各平台的 tar 方言较劲，不如自己解 —— tar 的格式（512 字节头 + 内容）
 * 简单到不值得引依赖，而且这条路在哪个平台都一样。
 */
const extractTgz = (tarball, dest) => {
  const buf = gunzipSync(readFileSync(tarball));
  const str = (from, len) => buf.subarray(from, from + len).toString("utf8").replace(/\0.*$/s, "");
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 收尾的零块
    const name = str(off, 100);
    const sizeRaw = str(off + 124, 12).trim();
    const size = sizeRaw ? Number.parseInt(sizeRaw, 8) : 0;
    const type = String.fromCharCode(header[156] || 48); // '0'=文件 '5'=目录 'x'=pax
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    /* pax 扩展头（长名/时间戳）跳过：紧跟着的那一条才是真条目（我们的路径没那么长） */
    if (type === "x" || type === "g" || type === "L") continue;
    const rel = name.replace(/^package\//, "");
    if (!rel) continue;
    const target = path.join(dest, rel);
    if (type === "5" || name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
};

let coreTar;
let engineTar;
try {
  coreTar = packInto("packages/engine-core");
  engineTar = packInto("packages/engine");
  ok(existsSync(coreTar) && existsSync(engineTar), `两个 tarball 都出来了（${path.basename(coreTar)} / ${path.basename(engineTar)}）`);
  extractTgz(coreTar, path.join(nm, "ding-engine-core"));
  extractTgz(engineTar, path.join(nm, "ding-engine"));
  ok(existsSync(path.join(nm, "ding-engine-core", "README.md")), "tarball 里带了 README（files 字段对不对的一条实证）");
} catch (error) {
  ok(false, `打包/解包失败：${String(error.stdout ?? error.message ?? "").slice(-300)}`);
  process.exit(1);
}

/* 第三方依赖用 junction 指回仓库的 node_modules（离线、且必须是真依赖解析） */
const depsOf = (pkgDir) => Object.keys(JSON.parse(readFileSync(path.join(ROOT, pkgDir, "package.json"), "utf8")).dependencies ?? {});
const deps = new Set([...depsOf("packages/engine-core"), ...depsOf("packages/engine")]);
/* 两个包本体是解出来的 tarball，不许指回仓库（包名不带作用域，靠名单判，不能靠前缀） */
const INTERNAL = new Set(["ding-engine-core", "ding-engine"]);
for (const dep of deps) {
  if (INTERNAL.has(dep)) continue;
  const target = path.join(ROOT, "node_modules", dep);
  const link = path.join(nm, dep);
  if (!existsSync(target)) {
    ok(false, `仓库里没有这个依赖：${dep}（package.json 声明了但没装？）`);
    continue;
  }
  mkdirSync(path.dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(target, link, "junction");
}
ok(true, `第三方依赖指好了：${[...deps].filter((d) => !INTERNAL.has(d)).join(" / ")}`);

/* ── ③ 起一个假的 OpenAI 兼容端点（零出网、零花费） ──────────────── */
const fake = createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    console.log(`    [fake] 收到请求 ${req.method} ${req.url}`);
    const base = { id: "sdk-demo", object: "chat.completion.chunk", created: 0, model: "deepseek-flash" };
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "我是 Ding Harness 的引擎。" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;

const env = { ...process.env, STRATA_BASE_URL: fakeUrl, STRATA_API_KEY: "sk-sdk-verify" };

/* ── ④ 原样跑示例（先复制进干净工程 —— 从仓库路径跑会解析到仓库的 node_modules） ── */
console.log("\n③ 干净工程里跑示例");
cpSync(path.join(ROOT, "examples/sdk-turn/run.mjs"), path.join(appDir, "run.mjs"));
cpSync(path.join(ROOT, "examples/sdk-turn/core-only.cjs"), path.join(appDir, "core-only.cjs"));
writeFileSync(path.join(appDir, "workdir.txt"), "这个文件是给工作目录用的\n", "utf8");

/**
 * 跑一个示例（**异步**）。
 *
 * ⚠️ 这里必须是异步的：假端点就跑在**本进程**里，而 `execFileSync` 会把本进程的
 * 事件循环堵死 —— 子进程于是永远连不上（实测：两个例子都卡满 120 秒的失速看门狗，
 * 而"卡死"看起来像产品问题）。第一次是这么写的，断言还因此**假绿过**
 * （示例脚本无论如何都会打印 OK 那一行）。
 */
const runDemo = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("error", (error) => resolve({ code: 1, out: `${out}
${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });

const full = await runDemo("app/run.mjs");
ok(full.code === 0 && full.out.includes("跑通了吗：true"), `完整面示例跑通（ding-engine + SQLite 真落盘）\n${full.out.slice(-500)}`);
const fullRecords = Number(/records=(\d+)/.exec(full.out)?.[1] ?? 0);
/* 一轮文本回合就是 request + （文本/收尾）：条数随协议分帧变，判据只要求"确实落了盘" */
ok(fullRecords >= 2, `示例里落了记录（${fullRecords} 条）`);

const core = await runDemo("app/core-only.cjs");
ok(core.code === 0 && core.out.includes("跑通了吗：true"), `最小面示例跑通（ding-engine-core + 内存 store，不碰文件系统）\n${core.out.slice(-500)}`);

/* ── ⑤ 收尾 ─────────────────────────────────────────────────────── */
await new Promise((resolve) => fake.close(resolve));
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
} catch {
  /* 尽力而为 */
}

console.log("");
if (bad.length) {
  console.error(`✗ SDK 冒烟有 ${bad.length} 条不过：\n${bad.map((b) => `  · ${b}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("✓ SDK 冒烟全过：两个包独立构建、独立打包、干净工程里跑通两种用法（未做真发布）");
}
