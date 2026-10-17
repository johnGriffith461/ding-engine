/**
 * **用 `ding-engine-core` 跑一轮**（第三方最小示例 · 最小嵌入面）。
 *
 * 与 `run.mjs` 的分别：这一份只用**最小面**（事件 + 主循环），
 * **一行文件系统都不碰** —— 会话记录放内存里，密钥从环境变量来。
 * 这正是"嵌进别的程序 / 别的运行时"要的那一半。
 *
 * 用 `require` 写（不是 `import`）—— 所以文件名是 `.cjs`：顺带证明产物
 * 两种写法都能用（`run.mjs` 那边走的是 `import`）。
 *
 * 跑法与 `run.mjs` 同一套环境变量。
 */
const { createEngine } = require("ding-engine-core");

/** 内存里的一段会话库（实现 `engine/ports/store` 那个形状）。 */
function memoryStore() {
  const logs = new Map();
  let seq = 0;
  return {
    async append(sessionId, records) {
      const stored = records.map((record) => ({ ...record, seq: (seq += 1), at: record.at ?? Date.now() }));
      logs.set(sessionId, [...(logs.get(sessionId) ?? []), ...stored]);
      return stored;
    },
    async load(sessionId) {
      return { records: logs.get(sessionId) ?? [], skipped: 0 };
    },
    async search() {
      return [];
    },
    async list() {
      return [];
    },
    async prune() {
      return { deleted: [], kept: logs.size };
    },
    close() {},
  };
}

(async () => {
  const provider = process.env.DING_PROVIDER ?? "strata";
  const model = process.env.DING_MODEL ?? "deepseek-flash";

  const engine = createEngine({
    store: memoryStore(),
    /* 没有工具：`useTools` 不给就不会有工具调用走到这里 */
    executor: { run: async () => ({ ok: false, error: "这个例子没有接工具执行体" }) },
    /* 密钥解析没给 = 默认只读环境变量（就是上面那两个） */
  });

  const said = [];
  const result = await engine.run({
    sessionId: "chat-core-demo",
    provider,
    model,
    messages: [{ role: "user", content: "用一句话介绍你自己" }],
    mode: "按需确认",
    onEvent: (event) => {
      if (event.type === "text") said.push(event.text);
    },
  });

  console.log(`跑通了吗：${result.ok}${result.error ? `（${result.error}）` : ""}`);
  console.log(`模型说了：${said.join("")}`);
  console.log(`记录（内存里的）：${result.records.length} 条`);

  if (!result.ok) process.exitCode = 1;
  else console.log(`\nSDK-DEMO-OK records=${result.records.length}`);
})();
