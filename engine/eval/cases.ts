import { omittedNote, shouldCompact } from "../core/context";
import { KEEP_RECENT_TOKENS_MIN, MAX_KEEP_TOKENS, keepTokensFor } from "../runtime/budget";
import { MODEL_CATALOG } from "../runtime/models";
import type { EvalCase } from "./types";
import { compaction2, conversation2, gates2, subagents2, teams2, tools2 } from "./cases2";

/** 目录表里登记过的模型 id（"上限"那条要拿上下文最大的那个来试）。 */
const MODEL_IDS = MODEL_CATALOG.map((m) => m.id);

/**
 * 评测集（Phase 10.1）。
 *
 * ## 写用例的口径
 *
 * 每条都断**三样**：事件序列（过程对不对）+ 关键文案（回注有没有到）+ 产物（有没有真动手）。
 * 只断其中一样的话，下面这些都能"通过"而产品是坏的：
 *   · 只断最终文本 → "模型编了个答案"与"它真读了文件"长得一样；
 *   · 只断事件序列 → "工具返回了空内容"也算调过了；
 *   · 只断产物 → "文件在"不能说明过程里没有乱来（比如它其实调了别的工具）。
 *
 * ## 路径怎么写
 *
 * 用 `{{dir}}` 占位（工作目录是运行时才建的，写死绝对路径会跟着临时目录漂）。
 *
 * ## ⚠️ 首版覆盖
 *
 * 下面这些是**接通评测装置**的第一批（六类各若干条）。方案 10.1 的目标是 ≥60 条 ——
 * 装置已经通了，继续加用例是机械活（每加一条就是往这个数组里再加一项）。
 * 这一批的特点是：**每条都能指出它挡的是哪一种坏**，不写"为了凑数"的格子。
 */

/** 纯对话：不给工具、或用不上工具的那种回合。 */
const conversation: EvalCase[] = [
  {
    id: "chat-single",
    category: "纯对话",
    title: "单轮问答：一句话进、一句话出，且有账本",
    turns: ["你好"],
    replies: [[{ say: "你好，我是 Ding Harness。" }]],
    expect: { events: ["text", "done"], copy: ["我是 Ding Harness"], minSteps: 1, usage: true },
  },
  {
    id: "chat-no-tools",
    category: "纯对话",
    title: "不给工具时，模型不该吐出任何工具调用",
    turns: ["随便聊一句"],
    replies: [[{ say: "好。" }]],
    useTools: false,
    expect: {
      events: ["text", "done"],
      eventsAbsent: ["tool-call"],
      minSteps: 1,
      /*
       * ⭐ 2026-10-16（审计 P153 落地）：不只断"它没调工具"，还断"**工具根本没下发**" ——
       * 前者可能是它调了但被拒；后者才是"模型看不到，就不会试"这条设计。
       * 判据读的是假 provider 收到的请求体（`bodies` 一直记着，此前全仓零读取）。
       */
      toolsNotSent: ["read_file", "write_file", "run_command", "search_files"],
    },
  },
  {
    id: "chat-two-turns",
    category: "纯对话",
    title: "两轮对话各自收尾（第二轮不该把第一轮当没发生）",
    turns: ["我叫阿洁", "我叫什么？"],
    replies: [[{ say: "记住了。" }], [{ say: "你叫阿洁。" }]],
    expect: { events: ["text", "done", "text", "done"], copy: ["你叫阿洁"], minSteps: 2 },
  },
  {
    id: "chat-empty-reply",
    category: "纯对话",
    title: "模型一个字都不吐时，这一轮也要正常收尾（不能卡住）",
    turns: ["（空回）"],
    replies: [[{ say: "" }]],
    expect: { events: ["done"], minSteps: 1 },
  },
  {
    id: "chat-empty-then-real",
    category: "纯对话",
    title: "空回之后再问一轮，照样能出内容",
    turns: ["第一句", "第二句"],
    replies: [[{ say: "" }], [{ say: "这次有内容了。" }]],
    expect: { events: ["done", "done"], copy: ["这次有内容了"], minSteps: 2 },
  },
];

/** 工具调用：读、写、搜、跑。 */
const tools: EvalCase[] = [
  {
    id: "tool-read",
    category: "工具调用",
    title: "读文件：内容真的回到模型手里",
    turns: ["看看 note.txt"],
    fixtures: { "note.txt": "备忘：明天十点开会" },
    replies: [
      [{ call: [{ name: "read_file", args: { path: "{{dir}}/note.txt" } }] }],
      [{ say: "文件里写着：明天十点开会。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      copy: ["明天十点开会"],
      minSteps: 2,
      usage: true,
      /* 反过来的那一半：该给的工具一个都不能少（审计 P153） */
      toolsSent: ["read_file", "list_dir"],
    },
  },
  {
    id: "tool-write-allow",
    category: "工具调用",
    title: "「全部允许」下写文件：真落盘，字一个不差",
    turns: ["写个文件"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/out.txt", content: "落盘内容 123" } }] }],
      [{ say: "写好了。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], files: ["out.txt"], minSteps: 2 },
  },
  {
    id: "tool-read-missing",
    category: "工具调用",
    title: "读不存在的文件：失败**是结果**，不该中断整轮",
    turns: ["读一个不存在的文件"],
    replies: [
      [{ call: [{ name: "read_file", args: { path: "{{dir}}/nope.txt" } }] }],
      [{ say: "这个文件不在。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      toolErrors: ["read_file"],
      copy: ["这个文件不在"],
      minSteps: 2,
    },
  },
  {
    id: "tool-list-dir",
    category: "工具调用",
    title: "列目录：看得到刚刚放进去的文件名",
    turns: ["目录里有什么"],
    fixtures: { "a.md": "A", "b.md": "B" },
    replies: [[{ call: [{ name: "list_dir", args: { path: "{{dir}}", depth: 1 } }] }], [{ say: "有 a.md 和 b.md。" }]],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["a.md"], minSteps: 2 },
  },
  {
    id: "tool-search",
    category: "工具调用",
    title: "搜内容：命中那一行的原文回到模型手里",
    turns: ["搜一下预算"],
    fixtures: { "doc.md": "第一章\n预算是三千块\n第三章" },
    replies: [
      [{ call: [{ name: "search_files", args: { pattern: "预算", path: "{{dir}}" } }] }],
      [{ say: "搜到了：预算是三千块。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["预算是三千块"], minSteps: 2 },
  },
  {
    id: "tool-multi-step",
    category: "工具调用",
    title: "连调两个工具（读 → 写），两步都要走完",
    turns: ["把 a.md 抄成 b.md"],
    mode: "全部允许",
    fixtures: { "a.md": "原文内容" },
    replies: [
      [{ call: [{ name: "read_file", args: { path: "{{dir}}/a.md" } }] }],
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/b.md", content: "原文内容" } }] }],
      [{ say: "抄好了。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "tool-call", "tool-result", "done"], files: ["b.md"], minSteps: 3 },
  },
];

/** 闸门审批：三个档位下的三种结局。 */
const gates: EvalCase[] = [
  {
    id: "gate-write-ask",
    category: "闸门审批",
    title: "「按需确认」下写文件被拦：待决挂上、文件没落盘、回注说清「还没执行」",
    turns: ["帮我写个文件"],
    mode: "按需确认",
    replies: [
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/gated.txt", content: "不该落盘" } }] }],
      [{ say: "这一步需要你确认。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      copy: ["还没有执行"],
      filesAbsent: ["gated.txt"],
      gate: "pending",
      minSteps: 2,
    },
  },
  {
    id: "gate-read-pass",
    category: "闸门审批",
    title: "「按需确认」下读文件**直接放行**（只有会改东西的才问）",
    turns: ["读一下"],
    mode: "按需确认",
    fixtures: { "r.txt": "只读内容" },
    replies: [[{ call: [{ name: "read_file", args: { path: "{{dir}}/r.txt" } }] }], [{ say: "读到了。" }]],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["只读内容"], gate: "none", minSteps: 2 },
  },
  {
    id: "gate-every-step",
    category: "闸门审批",
    title: "「每步确认」下**读也要问**（档位真的收紧了）",
    turns: ["读一下"],
    mode: "每步确认",
    fixtures: { "r.txt": "只读内容" },
    replies: [[{ call: [{ name: "read_file", args: { path: "{{dir}}/r.txt" } }] }], [{ say: "需要你确认。" }]],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["还没有执行"], gate: "pending" },
  },
  {
    id: "gate-run-command-ask",
    category: "闸门审批",
    title: "「按需确认」下跑命令也被拦（会改东西的都问）",
    turns: ["跑个命令"],
    mode: "按需确认",
    replies: [
      [{ call: [{ name: "run_command", args: { command: "echo hi", workdir: "{{dir}}" } }] }],
      [{ say: "需要你确认再跑。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["还没有执行"], gate: "pending" },
  },
  {
    id: "gate-no-retry",
    category: "闸门审批",
    title: "被拦之后模型**不该重试同一个调用**（回注里明确说了别重试）",
    turns: ["写文件"],
    mode: "按需确认",
    replies: [
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/again.txt", content: "x" } }] }],
      [{ say: "那我等你确认。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      copy: ["不要重试"],
      filesAbsent: ["again.txt"],
      gate: "pending",
      minSteps: 2,
    },
  },
];

/** 子智能体：委派出去了、进度事件在、成本上卷。 */
const subagents: EvalCase[] = [
  {
    id: "sub-spawn-one",
    category: "子智能体",
    title: "派一个自包含任务出去：专家真的跑了一轮（结论从工具结果回来）",
    /*
     * ⚠️ 这里**不断言 delegation 事件**，是实测出来的形状：
     * `spawn_agent`（单数）走 `runSubagent`，它是**同步**的一轮 —— 结论直接在工具结果里，
     * 不上报 `onDelegation`（只有 `spawn_agents` 那条团队路才上报进度）。
     * 第一版用例按"每次委派都有进度事件"写，于是红；红的是**用例的假设**，不是产品。
     * 这条形状值得记住：要"看得到谁在跑"得用团队那条路。
     */
    turns: ["让一个专家去查一件事"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agent", args: { task: "查一下这个仓库有多少个测试文件" } }] }],
      [{ say: "专家回来了。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], eventsAbsent: ["delegation"], minSteps: 2 },
  },
  {
    id: "sub-spawn-parallel",
    category: "子智能体",
    title: "一次派两件活：两次委派都要有进度",
    turns: ["两件事一起办"],
    mode: "全部允许",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: {
                tasks: [
                  { agent: "researcher", task: "查一件事" },
                  { agent: "writer", task: "写一段话" },
                ],
              },
            },
          ],
        },
      ],
      [{ say: "两件都回来了。" }],
    ],
    expect: { events: ["tool-call", "delegation", "done"], delegations: 2, minSteps: 2 },
  },
  {
    id: "sub-gate-no-leak",
    category: "子智能体",
    title: "派团队这个动作**本身**就被闸门看着（按需确认下先问，不偷偷派活）",
    /*
     * ⚠️ 这里原本想验的是"闸门不穿透"（子级被拦不该在父级冒出待决），实测**验不到**，
     * 而且原因值得记下来：
     *   · `spawn_agent` / `spawn_agents` 在策略表里是 **write 类** ——
     *     按需确认下，**派活这个动作自己就要先问**，所以团队根本跑不起来；
     *   · 内置三个角色的 `mode` 都**没写死**，`resolveAgentMode(父, undefined)` 直接继承父级 ——
     *     于是"父级允许、子级被拦"这个组合在 CLI 这条路上到不了。
     * 也就是说：**不穿透是结构上的性质（子级的受阻记在报告的 blocked 里），
     * 今天没有一条路能把它跑出来**。硬造一个假宿主去测，测的是假宿主。
     * 所以这一格改成验**能验到的那件事**：派活要先问。
     */
    turns: ["让专家团队去各写一个文件"],
    mode: "按需确认",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: {
                tasks: [
                  { agent: "writer", task: "写第一份" },
                  { agent: "writer", task: "写第二份" },
                ],
              },
            },
          ],
        },
      ],
      [{ say: "需要你确认再派。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      eventsAbsent: ["delegation"],
      copy: ["还没有执行"],
      gate: "pending",
      minSteps: 2,
    },
  },
  {
    id: "sub-usage-rolls-up",
    category: "子智能体",
    title: "团队的开销要上卷到父级账本（不能凭空消失）",
    turns: ["派个团队并记账"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agents", args: { tasks: [{ agent: "runner", task: "做一件小事" }] } }] }],
      [{ say: "做完了。" }],
    ],
    expect: { events: ["delegation", "done"], delegations: 1, usage: true, minSteps: 2 },
  },
];

/** 多 agent 协作：多个专家并行 + 汇总。 */
const teams: EvalCase[] = [
  {
    id: "team-two-experts",
    category: "多 agent 协作",
    title: "两个专家并行：两次委派 + 父级收尾",
    turns: ["两个人分头做"],
    mode: "全部允许",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: {
                tasks: [
                  { agent: "researcher", task: "甲" },
                  { agent: "runner", task: "乙" },
                ],
              },
            },
          ],
        },
      ],
      [{ say: "两边的结果我合在一起了。" }],
    ],
    expect: { events: ["delegation", "tool-result", "done"], delegations: 2, copy: ["合在一起"], minSteps: 2 },
  },
  {
    id: "team-three-experts",
    category: "多 agent 协作",
    title: "三个专家（不同角色）：三条委派进度都要有",
    turns: ["三个人分头做"],
    mode: "全部允许",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: {
                tasks: [
                  { agent: "researcher", task: "甲" },
                  { agent: "writer", task: "乙" },
                  { agent: "runner", task: "丙" },
                ],
              },
            },
          ],
        },
      ],
      [{ say: "三份都回来了。" }],
    ],
    expect: { events: ["delegation", "done"], delegations: 3, minSteps: 2 },
  },
  {
    id: "team-unknown-agent",
    category: "多 agent 协作",
    title: "派了一个不存在的专家：整轮照样收尾（失败被关在那一格里）",
    /*
     * ⚠️ 实测结论：未知角色**不会让工具抛错** —— `runTeam` 把那一格记成 `ok:false` 的报告项，
     * 工具照常成功返回（也就是说"失败"是**结果的一部分**，不是异常）。
     * 第一版用例期待 `toolErrors`，于是红；红的是假设。
     * 这里断的是真正要紧的那件事：**父级这一轮没有被带崩**（有 done、没有 error）。
     */
    turns: ["派给一个不存在的专家"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agents", args: { tasks: [{ agent: "不存在的角色", task: "随便" }] } }] }],
      [{ say: "这个角色没有，我换个方式。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], eventsAbsent: ["error"], minSteps: 2 },
  },
  {
    id: "team-then-single",
    category: "多 agent 协作",
    title: "先派团队、再自己补一刀：团队与单次委派混用都记账",
    turns: ["先分开做，再补一件事"],
    mode: "全部允许",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: {
                tasks: [
                  { agent: "researcher", task: "甲" },
                  { agent: "writer", task: "乙" },
                ],
              },
            },
          ],
        },
      ],
      [{ call: [{ name: "spawn_agent", args: { task: "再补一件事" } }] }],
      [{ say: "都办完了。" }],
    ],
    expect: { events: ["delegation", "delegation", "done"], delegations: 3, usage: true, minSteps: 3 },
  },
];

/**
 * 上下文压缩。
 *
 * ⚠️ 这一类的判据**不在回合里**：压缩是**宿主**的编排（它决定发多少历史），
 * 而它的"尺子"（阈值、保留多少、回注什么话）在核心里。
 * 所以这一类直接测核心里那把尺子 —— 把它塞进回合流反而要造一个假宿主，
 * 那样测的是假宿主，不是产品。
 *
 * （这一类等 V 形 `runCase` 支持"纯函数格子"之后接进来；见下面 `coreCases` 的说明。）
 */
const compaction: EvalCase[] = [
  {
    id: "compact-threshold",
    category: "上下文压缩",
    kind: "core",
    title: "压缩阈值：短历史不压、长历史才压（阈值是判据，不是感觉）",
    coreCheck: () => {
      const short = [{ role: "user" as const, content: "你好" }];
      if (shouldCompact(short)) return "一句话的历史被判成需要压缩（阈值算错了）";
      // 单条超大消息：按 4 字符 ≈ 1 token 的估算，6 万字符远超 2 万的默认保留量
      const long = [{ role: "user" as const, content: "字".repeat(60_000) }];
      if (!shouldCompact(long)) return "6 万字符的历史没被判成需要压缩";
      return null;
    },
  },
  {
    id: "compact-keep-floor",
    category: "上下文压缩",
    kind: "core",
    title: "保留量有下限：模型上限再小也要留住最近的一段",
    coreCheck: () => {
      const keep = keepTokensFor("一个根本不存在的模型");
      if (keep < KEEP_RECENT_TOKENS_MIN) return `保留量 ${keep} 小于下限 ${KEEP_RECENT_TOKENS_MIN}（会把最近的话也压掉）`;
      return null;
    },
  },
  {
    id: "compact-keep-ceiling",
    category: "上下文压缩",
    kind: "core",
    title: "保留量有上限：模型上下文再大也不跟着放大（那是静默的单轮成本）",
    coreCheck: () => {
      const biggest = MODEL_IDS.reduce((a, b) => (keepTokensFor(a) >= keepTokensFor(b) ? a : b), MODEL_IDS[0] ?? "");
      const keep = keepTokensFor(biggest);
      if (keep > MAX_KEEP_TOKENS) return `保留量 ${keep} 超过了上限 ${MAX_KEEP_TOKENS}（${biggest}）`;
      return null;
    },
  },
  {
    id: "compact-note-copy",
    category: "上下文压缩",
    kind: "core",
    title: "压缩回注**逐字**：用户与模型看到的必须是同一句话",
    coreCheck: () => {
      const note = omittedNote("summarized");
      if (!note.includes("更早的对话已压缩为摘要")) return `回注文案变了：「${note}」`;
      const trimmed = omittedNote("trimmed");
      if (!trimmed.includes("已省略")) return `直接丢弃时的回注文案变了：「${trimmed}」`;
      if (note === trimmed) return "两种模式回注了同一句话（用户分不清是压缩还是丢弃）";
      return null;
    },
  },
];

/** 全量评测集（第一批 + 第二批）。 */
export const EVAL_CASES: EvalCase[] = [
  ...conversation,
  ...tools,
  ...gates,
  ...subagents,
  ...teams,
  ...compaction,
  ...conversation2,
  ...tools2,
  ...gates2,
  ...subagents2,
  ...teams2,
  ...compaction2,
];
