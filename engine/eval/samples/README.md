# 会话样本（Phase 10.4）

共 12 份，由 `pnpm eval:samples`（`scripts/eval-samples.ts`）生成。

**它们是真代码路径产出的会话记录**（真引擎、真事件、真投影、真落盘格式），
唯一脚本化的是模型文本；另外刻意混入了真实日志里一定会有的脏东西
（截断的 JSON、空行、被中断的回合、工具失败、闸门待决）。

为什么不是「抓一批真实聊天记录」：这台机器上的会话库是空的；而且把主人的私人对话
（哪怕脱敏）提交进公开仓是需要他本人点头的事。这两条写在生成脚本的头注里。

| 文件 | 场景 |
|---|---|
| `01-plain-qa.jsonl` | 单轮问答 |
| `02-read-file.jsonl` | 读文件后作答 |
| `03-write-allowed.jsonl` | 写文件（全部允许） |
| `04-gated-write.jsonl` | 写文件被闸门拦下（待决） |
| `05-tool-error.jsonl` | 工具失败（读不存在的文件） |
| `06-run-command.jsonl` | 跑命令并回报 |
| `07-multi-step.jsonl` | 连调两个工具 |
| `08-team-parallel.jsonl` | 并行派两个专家 |
| `09-subagent-single.jsonl` | 单次派活 |
| `10-two-turns.jsonl` | 两轮对话（带历史） |
| `11-empty-reply.jsonl` | 模型一个字都没吐 |
| `12-crash-midway.jsonl` | 上游半路断线（这一轮报错收尾） |

⚠️ 脱敏是**断言**不是承诺：`engine/eval/samples.test.ts` 会拒绝任何含绝对路径、
密钥形状、或用户目录痕迹的样本。
