# ding-engine-core

**Ding Harness 的最小嵌入面**：事件模型（日志即真相）+ 主循环（`createEngine`）。
**无 IO** —— 不需要文件系统、不需要子进程、不需要宿主运行时就能跑一轮真回合。

这个边界不是声明出来的，是**机器判的**：主仓的 `src/engineCoreBoundary.test.ts`
从 `engine/index.ts` 走一遍 import 闭包，闭包里出现 `node:*` / `electron` 就红。

## 它给你什么

- `createEngine(ports)` → 引擎：`run` / `resume` / `replay` / `record`
- 六项契约与事件模型：actor（C5）、会话归属（C1）、角色 × 档位的闸门（C2/C3）、
  成本账本（`engine/core/ledger`）、以及"错误即结果"的回注文案
- 事件/记录的投影（`engine/core/events`）、快照与 diff

## 它要你给什么（端口）

| 端口 | 你要给的 | 不给会怎样 |
|---|---|---|
| `store` | 会话记录的持久化（`SessionStore`）—— 内存、SQLite、云盘都行 | **必填**（没有它就没有"日志即真相"） |
| `executor` | 工具怎么真跑（`ToolExecutor`） | **必填**（工具调用会走到它） |
| `secret` | `keyRef` → 密钥 | 默认只读环境变量 |
| `hooks` | 插件钩子（`session:start` / `tool:before` / `tool:after` / `turn:end`） | 默认没有钩子 |
| `health` | provider 健康账本 | 默认不记 |

## 用法（最小一跑）

```js
const { createEngine } = require("ding-engine-core");

const engine = createEngine({
  store: myMemoryStore,        // 实现 engine/ports/store.ts 那个形状
  executor: { run: async () => ({ ok: true, output: {} }) },
});

const result = await engine.run({
  sessionId: "chat-demo",
  provider: "strata",          // 或任何列在 providers 表里的
  messages: [{ role: "user", content: "你好" }],
  mode: "按需确认",
  onEvent: (e) => process.stdout.write(`${e.type}\n`),
});
```

完整可跑的例子在 `examples/sdk-turn`（主仓 `docs/` 口径见 本目录的 `README.md`）。

## 边界（如实说）

- 产物是 **CommonJS**（与主仓 CLI 同一条构建路）—— `import` 与 `require` 都能用；
- **不含**：SQLite 存储、工具的真实执行体、插件装载、凭据库、桌面/CLI 的装配。
  那些在 `ding-engine`（完整能力面）。
- 版本口径见主仓 [`RELEASE.md`](../../RELEASE.md)；破坏性变更要 ADR + major。
