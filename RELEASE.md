# 发布策略（引擎包）

这份文档管两件事：**版本怎么定**、**破坏了怎么办**。它进仓（`docs/` 不入库 —— 见
`.gitignore` 与 `CHANGELOG.md` 开头那条说明），所以它是可复核的那一份出处。

## 一、版本号

严格 [semver](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

| 改了什么 | 怎么升 |
|---|---|
| 加一个公开导出、给可选参数加默认值、修 bug（行为不变） | **minor** / patch |
| 删公开导出、改签名、改语义（同样的调用给出不同结果）、改端口形状 | **major** |
| 只改内部实现、注释、测试 | **patch** |

**首个独立仓版本 = `0.1.0`**（对应主仓 v0.3.0 之后的引擎仓起点）。
`ding-engine-core` 与 `ding-engine` **同版本号**（后者依赖前者的具体版本 ——
版本一漂，装的就不是同一份契约了）；这条由 `src/sdkApiFreeze.test.ts` 盯着。

⚠️ `0.x` 阶段的惯例是"minor 也可以破坏"。**这个项目不这么干**：既然把
"日志即真相"当承诺，就不该在版本号上玩花活 —— SDK 冻结清单（`packages/api.frozen.json`）
一旦发出去，破坏性变更一律走下面的流程（major）。

## 二、破坏了怎么办（三件套，缺一不可）

1. **ADR**：在 `ADR/` 写一份新的（是什么、为什么必须破坏、备选方案为什么不行）；
2. **major**：升大版本号；
3. **迁移指南**：写进 `CHANGELOG.md` 的 `### 迁移` 一节 —— 至少给"旧写法 → 新写法"
   的对照，和"不迁移会怎样"（编译错？运行时 undefined？）的如实描述。

清单本身（`packages/api.frozen.json`）在第 1 步之后、第 2 步之前更新 —— 顺序反了的话，
门会红一次，而那次红是**对的**：它提醒你 ADR 还没写。

## 三、兼容窗口

- **保持兼容**：一个大版本内（`0.1.x` → `0.1.y`）公开面只加不减；
- **标注弃用**：要拿掉的东西，先在大版本内的**至少一个 minor** 里标 `@deprecated`
  （JSDoc + `CHANGELOG.md` 的 `### 弃用` 一节），并给出替代写法；
- **拿掉**：下一个 major 才真的删。

一句话：**一个东西不许在一次发布里从"能用"直接变成"没了"** —— 中间至少要隔一个 minor。

## 四、CHANGELOG

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的口径：分
`新增 / 变更 / 修复 / 弃用 / 移除 / 迁移`，每一条说**用户看得见的差异**，
不只写"重构了 XX"。本仓的 `CHANGELOG.md` 从 v0.1.0 起就在这个口径上（见它的开头）。

## 五、npm 发布与主仓 tag 的联动

发布是**一个序列**，不是一次 `npm publish`：

1. 主仓这边：测试绿（`pnpm test`）→ SDK 冒烟绿（`pnpm verify:sdk`）→ 契约门与冻结门绿；
2. `pnpm sdk:build` 出产物 → `CHANGELOG.md` 把 `未发布` 改成版本号 + 日期；
3. 打 tag（主仓 `vX.Y.Z`，引擎包 `ding-engine-core@X.Y.Z` / `ding-engine@X.Y.Z`）；
4. `npm publish`（两个包，先 core 再 engine —— 后者依赖前者）。

⚠️ **第 4 步要主人授权**（对外发布不可逆）。2026-10-16 的决定是**主仓 CLI 暂不发 npm**；
引擎包同一个口径：产物与流程都备好，`npm publish` 那一下由人拍。
在那之前，"能不能装"的证据是 `pnpm verify:sdk`（本地 tarball → 干净工程 → 跑通一轮）。

## 六、这条策略自己怎么被验证

- `src/sdkApiFreeze.test.ts`：公开面清单对账 + 版本一致 + **本文档里那三个词必须在**
  （ADR / major / 迁移指南）—— 文档删了、改口了，门会红；
- `scripts/verify-sdk.mjs`（`pnpm verify:sdk`）：两个包真构建、真打包、干净工程里真跑；
- CI：`.github/workflows/ci.yml` 跑上面两条（示例在仓内，所以"示例仓 CI 验证"
  在这里 = 那条 `verify:sdk` 的步骤）。
