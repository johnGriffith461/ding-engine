# ding-engine

**Ding Harness 的引擎与 SDK**：事件溯源内核 + Node 侧完整能力面。

| 包 | 是什么 |
|---|---|
| `ding-engine-core` | 最小嵌入面：事件模型 + 主循环（**无 IO**） |
| `ding-engine` | 完整能力面：最小面 + SQLite / 工具执行体 / 凭据库 / 插件 / 装配 |

这个仓是从主仓 `DingHarness` **拆出来的**（`scripts/split-engine-repo.mjs`）：
同一份代码、同一套测试口径 —— 主仓的 CI 每 push 都跑 `pnpm verify:sdk`
（两个包真构建 → 真打包 → 干净工程里跑通两种用法）。

```bash
pnpm install
pnpm verify          # 构建两个包 + 打包冒烟（零出网：假模型端点）
```

十分钟上手：[`examples/sdk-turn/README.md`](examples/sdk-turn/README.md)。
版本与发布口径：[`RELEASE.md`](RELEASE.md)（破坏性变更要 ADR + major + 迁移指南）。

## 边界（如实说）

- 这个仓**不含**桌面与 CLI 宿主（它们在主仓）；这里只有引擎、SDK 与最小示例。
- 主仓是唯一开发处，这里是**发布用的拆分**：改代码请改主仓，再按需重新拆。
