/**
 * **用 `ding-engine` 跑一轮**（第三方最小示例 · 完整能力面）。
 *
 * 这个文件是**真能跑**的，不是伪代码：CI 里由 `scripts/verify-sdk.mjs`
 * 把两个包打成 tarball、装进一个干净工程、再把本文件原样跑一遍。
 *
 * 跑法：
 *   npm i ding-engine
 *   STRATA_BASE_URL=http://127.0.0.1:8080/v1 STRATA_API_KEY=sk-... node run.mjs
 *
 * 没有任何本地服务也没关系：`STRATA_BASE_URL` 指向**任何 OpenAI 兼容端点**即可。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEngine } from "ding-engine";

/* ① 两个目录：工作目录（工具能碰的范围）与数据目录（会话记录放哪） */
const workdir = process.argv[2] ?? process.cwd();
const dataDir = mkdtempSync(path.join(os.tmpdir(), "ding-sdk-demo-"));
const provider = process.env.DING_PROVIDER ?? "strata";
const model = process.env.DING_MODEL ?? "deepseek-flash";

console.log(`工作目录：${workdir}`);
console.log(`数据目录：${dataDir}`);
console.log(`模型：${provider} / ${model}\n`);

/* ② 装配：与产品（`ding serve` / 桌面）用的是同一份代码 */
const built = await buildEngine([workdir], dataDir);

try {
  const sessionId = "task-sdk-demo";

  /* ③ 跑一轮：事件边跑边出（`onEvent` 就是界面/终端看到的那个出口） */
  const result = await built.engine.run({
    sessionId,
    provider,
    model,
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
    mode: "按需确认",
    useTools: true,
    maxSteps: 4,
    onEvent: (event) => {
      if (event.type === "text") process.stdout.write(event.text);
      else if (event.type !== "step-finish") console.log(`\n[事件] ${event.type}`);
    },
  });

  console.log(`\n\n跑通了吗：${result.ok}${result.error ? `（${result.error}）` : ""}`);
  console.log(`这一轮落盘 ${result.records.length} 条记录`);

  /* ④ 日志即真相：从记录里读回这一段会话（重启之后界面就是这么恢复的） */
  const resumed = await built.engine.resume(sessionId);
  console.log(`从日志读回：${resumed.turns.length} 轮对话，${resumed.pending.length} 条待确认`);

  /* 没跑通就是失败（退出码非零）—— 别让"打印了一行字"看起来像成功 */
  if (!result.ok) process.exitCode = 1;
  else console.log(`\nSDK-DEMO-OK records=${result.records.length}`);
} finally {
  /* ⑤ 关掉会话库（不然 Windows 上临时目录删不掉） */
  built.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 尽力而为 */
  }
}
