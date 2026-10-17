# ding-engine

**Ding Harness 的完整能力面**（Node 侧）：`ding-engine-core` + 那些**要 IO** 的部件 ——
SQLite 存储、工具执行体、凭据库、插件装载、以及把这一整套接起来的**装配**。

产品和这个包用的是**同一份代码**（`hosts/cli/assembly.ts`）：
不是"再实现一遍给外面用"，所以"文档上能跑"与"产品里能跑"不会漂。

## 用法（10 分钟那条路）

```js
const { buildEngine } = require("ding-engine");

// ① 工作目录（工具能碰的范围）+ 数据目录（会话记录放哪）
const built = await buildEngine([process.cwd()], ".ding-data");

try {
  // ② 跑一轮：真实工具、真实落盘、事件边跑边出
  const result = await built.engine.run({
    sessionId: "task-demo",
    provider: "strata",              // 需要先配好密钥（见下）
    model: "deepseek-flash",
    messages: [{ role: "user", content: "看一下这个项目有什么文件" }],
    mode: "按需确认",                 // 写操作会拦下来等确认
    useTools: true,
    maxSteps: 8,
    onEvent: (event) => console.log(event.type, event.type === "text" ? event.text : ""),
  });
  console.log("跑完了吗：", result.ok, "记录条数：", result.records.length);
} finally {
  built.close();                     // 关掉会话库
}
```

## 密钥从哪来

`resolveSecret(keyRef)` 按这个优先级找：**环境变量 → `~/.dsh/.credentials.yaml` → 桌面加密库**。
最少只要给环境变量：

```bash
STRATA_BASE_URL=http://127.0.0.1:8080/v1   # 本地服务
STRATA_API_KEY=sk-...                      # 或 DEEPSEEK_API_KEY 等，见 providers 表
```

## 公开面

`packages/engine/src/index.ts` 是**唯一**的落脚点（API 冻结清单指着它）。
里面分七组：引擎 / 装配 / 存储 / 工具执行体 / 凭据与插件 / provider 目录 / 档位词表。

## 边界（如实说）

- 产物是 **CommonJS**（与主仓 CLI 同一条构建路）；`import` 与 `require` 都能用。
- 这个包里没有 UI、没有 MCP 连接器宿主、没有画布 —— 那些属于桌面/CLI 宿主。
- 版本口径见主仓 [`RELEASE.md`](../../RELEASE.md)（破坏性变更要 ADR + major + 迁移指南）。
