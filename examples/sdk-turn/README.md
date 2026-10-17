# 用 SDK 跑一轮（10 分钟）

两个包，两条路 —— 按你要嵌的东西选：

| 包 | 是什么 | 什么时候用 |
|---|---|---|
| `ding-engine-core` | 事件模型 + 主循环，**无 IO** | 嵌进别的程序/别的运行时；存储与工具你自己给 |
| `ding-engine` | 最小面 + SQLite/工具执行体/凭据库/插件/装配 | 在 Node 里跑一个真的 agent（和产品同一份实现） |

## 第 1 步：装

```bash
npm i ding-engine-core     # 或者
npm i ding-engine
```

> 还没发布到 npm 时：`npm i <仓库>/packages/engine-core`（本地路径安装），
> 或者先 `pnpm sdk:build` 再 `npm i <仓库>/packages/engine-core`。

## 第 2 步：给一个模型端点

引擎不认识"哪家的模型"，它认的是 provider 表里的条目（`providers.ts`）。
最少给两个环境变量（`strata` 这一家读它们，指向**任何 OpenAI 兼容端点**都行）：

```bash
STRATA_BASE_URL=http://127.0.0.1:8080/v1
STRATA_API_KEY=sk-...
```

> 别的 provider 用它们各自的环境变量名（DeepSeek 是 `DEEPSEEK_API_KEY` 等）：
> `listProviders()` 会把你**配好**的那些列出来。

## 第 3 步：跑

```bash
node run.mjs          # 完整面：真落盘（SQLite）、真工具、边跑边出事件
node core-only.cjs    # 最小面：会话记录放内存里，一行文件系统都不碰
```

两个文件都在本目录，都是**真能跑**的（CI 里由 `pnpm verify:sdk` 把两个包打成
tarball、装进一个干净工程、原样跑它们）。

## 你会看到什么

```
工作目录：…
数据目录：…
模型：strata / deepseek-flash

我是 Ding Harness 的引擎。
[事件] done

跑通了吗：true
这一轮落盘 3 条记录
从日志读回：1 轮对话，0 条待确认
```

"从日志读回"那一步是这套引擎的核心口径：**日志即真相** ——
界面重启之后的恢复、成本账本、审计留痕，读的都是同一份记录。

## 下一步

- 想接工具：`buildEngine([工作目录], 数据目录)` 里的第一个参数就是"工具能碰的范围"，
  写操作在「按需确认」档下会被拦下来等确认（`result.records` 里那一条 `tool-result`
  带着 `pending: true` 与 `approvers`）。
- 想接自己的存储/执行体：用 `createEngine({ store, executor, ... })`（最小面），
  端口形状见 `engine/ports/*.ts`。
- 版本口径与破坏性变更流程：[`RELEASE.md`](../../RELEASE.md)。
