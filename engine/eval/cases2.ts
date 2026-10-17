import { KEEP_RECENT_TOKENS, calibrationOf, estimateTokens, omittedNote, planContext, shouldCompact, totalTokens } from "../core/context";
import { KEEP_RATIO, KEEP_RECENT_TOKENS_MIN, MAX_KEEP_TOKENS, budgetOf, describeBudget, keepTokensFor } from "../runtime/budget";
import { MODEL_CATALOG, UNKNOWN_MODEL_BUDGET, isStale } from "../runtime/models";
import type { EvalCase } from "./types";

/**
 * 第二批用例（2026-10-15）—— 把评测集从 28 条补到方案要求的 ≥60 条。
 *
 * ## 补的时候守的规矩
 *
 * 每一条都要能说出**它挡的是哪一种坏**。凑数的格子（"再问一遍同样的问题"）不写 ——
 * 它们只会让通过率好看，不会让产品更可靠。
 *
 * 三个方向是这一批的重点：
 *   ① **边界**（空输入、超长、非法参数、并发重复）—— 真实使用里最先撞到的就是这些；
 *   ② **不做**（不该调工具时没调、不该写盘时没写、拿不到的工具没有被"假装调用"）；
 *   ③ **算得对**（上下文计量与保留额度的数字 —— 这一层错了不会报错，只会悄悄多花钱）。
 */

/** 目录表里登记过的模型 id（上下文最大的那个用来验上限）。 */
const MODEL_IDS = MODEL_CATALOG.map((m) => m.id);
const BIGGEST_MODEL = MODEL_IDS.reduce((a, b) => (keepTokensFor(a) >= keepTokensFor(b) ? a : b), MODEL_IDS[0] ?? "");

/** 纯对话（补 4 条）。 */
export const conversation2: EvalCase[] = [
  {
    id: "chat-long-input",
    category: "纯对话",
    title: "超长输入也要走完（不许在入口处被截断成空）",
    turns: ["把下面这段记下来：" + "字".repeat(3000)],
    replies: [[{ say: "记下了。" }]],
    expect: { events: ["text", "done"], copy: ["记下了"], minSteps: 1 },
  },
  {
    id: "chat-multi-chunk",
    category: "纯对话",
    title: "模型分多段吐字：每段都要到（不是只留最后一段）",
    turns: ["分三段说"],
    replies: [[{ say: "第一段。第二段。第三段。", chunks: ["第一段。", "第二段。", "第三段。"] }]],
    expect: { events: ["text", "done"], copy: ["第一段", "第二段", "第三段"], minSteps: 1 },
  },
  {
    id: "chat-empty-turn-text",
    category: "纯对话",
    title: "用户发了一句空的：也要有个收尾（不能挂住）",
    turns: [""],
    replies: [[{ say: "你没说什么。" }]],
    expect: { events: ["done"], minSteps: 1 },
  },
  {
    id: "chat-three-turns-remember",
    category: "纯对话",
    title: "三轮之后还记得第一轮（历史没在中间被丢掉）",
    turns: ["记住一个数：四十二", "再记住一个：七", "我让你记的第一个数是多少？"],
    replies: [[{ say: "好。" }], [{ say: "好。" }], [{ say: "四十二。" }]],
    expect: { events: ["done", "done", "done"], copy: ["四十二"], minSteps: 3, usage: true },
  },
];

/** 工具调用（补 7 条）。 */
export const tools2: EvalCase[] = [
  {
    id: "tool-edit-file",
    category: "工具调用",
    title: "改文件：只改那一段，别的地方不动",
    turns: ["把标题改掉"],
    mode: "全部允许",
    fixtures: { "doc.md": "# 旧标题\n\n正文不动\n" },
    replies: [
      [{ call: [{ name: "edit_file", args: { path: "{{dir}}/doc.md", oldText: "# 旧标题", newText: "# 新标题" } }] }],
      [{ say: "改好了。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], files: ["doc.md"], minSteps: 2, usage: true },
  },
  {
    id: "tool-run-command",
    category: "工具调用",
    title: "跑命令：退出码与输出真的回到模型手里",
    turns: ["跑个 echo"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "run_command", args: { command: "echo eval-marker-42", timeout: 10000 } }] }],
      [{ say: "跑完了。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["eval-marker-42"], minSteps: 2 },
  },
  {
    id: "tool-list-files",
    category: "工具调用",
    title: "列授权目录：能看到目录本身",
    turns: ["有哪些授权目录"],
    replies: [[{ call: [{ name: "list_files", args: {} }] }], [{ say: "只有一个。" }]],
    expect: { events: ["tool-call", "tool-result", "done"], minSteps: 2 },
  },
  {
    id: "tool-write-no-overwrite",
    category: "工具调用",
    title: "写文件**默认不许覆盖**：已存在的文件不该被默默盖掉",
    turns: ["写个已存在的文件"],
    mode: "全部允许",
    fixtures: { "exists.txt": "原件" },
    replies: [
      // 不给 overwrite —— 产品口径是"不传即不允许覆盖"
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/exists.txt", content: "新的" } }] }],
      [{ say: "这个文件在，我没覆盖。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      toolErrors: ["write_file"],
      minSteps: 2,
    },
  },
  {
    id: "tool-search-no-hit",
    category: "工具调用",
    title: "搜不到东西也是正常结果（不该报错、不该编一个命中出来）",
    turns: ["搜一个不存在的词"],
    fixtures: { "a.md": "这里没有那个词" },
    replies: [
      [{ call: [{ name: "search_files", args: { pattern: "絶対に存在しない語", path: "{{dir}}" } }] }],
      [{ say: "没搜到。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["没搜到"], minSteps: 2 },
  },
  {
    id: "tool-bad-args",
    category: "工具调用",
    title: "工具参数非法（缺 path）：失败是结果，整轮照走",
    turns: ["读一个没给路径的文件"],
    replies: [
      // read_file 的 path 是必填；不给就应当被判非法
      [{ call: [{ name: "read_file", args: {} }] }],
      [{ say: "我下次把路径说清楚。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      minSteps: 2,
      /*
       * ⚠️ 2026-10-16（审计 P154）：title 说"失败是结果"，而原来 expect 里没有
       * **任何**关于"它真的失败了"的判据 —— 断言序列是绿的（调用照样发生），
       * 只有"失败"这件事没人管。`Invalid input` 是 AI SDK 的 schema 拒收文案：
       * 参数合法时它不会出现，参数被静默修好时也不会出现。
       */
      toolErrors: ["read_file"],
      toolErrorIncludes: ["Invalid input"],
    },
  },
  {
    id: "tool-two-turns-tool-use",
    category: "工具调用",
    title: "两轮都用了工具：每轮的调用都真的发生",
    turns: ["先看看目录", "再看一次"],
    replies: [
      [{ call: [{ name: "list_dir", args: { path: "{{dir}}", depth: 1 } }] }],
      [{ say: "看完了。" }],
      [{ call: [{ name: "list_dir", args: { path: "{{dir}}", depth: 1 } }] }],
      [{ say: "还是那些。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "tool-call", "tool-result", "done"], minSteps: 4 },
  },
];

/** 闸门审批（补 4 条）。 */
export const gates2: EvalCase[] = [
  {
    id: "gate-every-step-write",
    category: "闸门审批",
    title: "「每步确认」下写文件：同样先问",
    turns: ["写个文件"],
    mode: "每步确认",
    replies: [
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/every.txt", content: "x" } }] }],
      [{ say: "需要你确认。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["还没有执行"], filesAbsent: ["every.txt"], gate: "pending" },
  },
  {
    id: "gate-edit-ask",
    category: "闸门审批",
    title: "「按需确认」下改文件也被拦（改与写同属会动东西的）",
    turns: ["改一下文件"],
    mode: "按需确认",
    fixtures: { "e.md": "原文" },
    replies: [
      [{ call: [{ name: "edit_file", args: { path: "{{dir}}/e.md", oldText: "原文", newText: "改过" } }] }],
      [{ say: "要你确认。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["还没有执行"], gate: "pending", minSteps: 2 },
  },
  {
    id: "gate-lists-then-writes",
    category: "闸门审批",
    title: "同一步里读了再写：读放行、写被拦（闸门是按工具判的，不是按一步）",
    turns: ["看一眼再改"],
    mode: "按需确认",
    fixtures: { "g.md": "原" },
    replies: [
      [
        {
          call: [
            { name: "read_file", args: { path: "{{dir}}/g.md" } },
            { name: "write_file", args: { path: "{{dir}}/g2.md", content: "新" } },
          ],
        },
      ],
      [{ say: "先等你确认写那一步。" }],
    ],
    /*
     * ⚠️ 事件形状是**两个 `tool-call` 先到、再两个 `tool-result`** ——
     * 因为 SDK 是把这一步的工具调用**流完之后**才逐个执行的（实测出来的顺序）。
     * 第一版按"调一个、回一个"交替写，于是红；红的是假设。
     */
    expect: {
      events: ["tool-call", "tool-call", "tool-result", "tool-result", "done"],
      copy: ["还没有执行"],
      filesAbsent: ["g2.md"],
      gate: "pending",
      minSteps: 2,
    },
  },
  {
    id: "gate-allow-run-command",
    category: "闸门审批",
    title: "「全部允许」下跑命令：真执行（档位放开就是真放开）",
    turns: ["跑个命令"],
    mode: "全部允许",
    replies: [[{ call: [{ name: "run_command", args: { command: "echo allow-marker-7", timeout: 10000 } }] }], [{ say: "跑完了。" }]],
    expect: { events: ["tool-call", "tool-result", "done"], copy: ["allow-marker-7"], gate: "none", minSteps: 2 },
  },
];

/** 子智能体（补 4 条）。 */
export const subagents2: EvalCase[] = [
  {
    id: "sub-single-result-text",
    category: "子智能体",
    title: "单次派活：专家的结论要回到父级手里",
    turns: ["让专家看一下目录"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agent", args: { task: "列出授权目录里的文件名" } }] }],
      [{ say: "专家说目录是空的。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done"], minSteps: 2, usage: true },
  },
  {
    id: "sub-task-too-long",
    category: "子智能体",
    title: "派活的任务说明超过长度上限：被 schema 拒（不许悄悄截断）",
    turns: ["派一个超长任务"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agent", args: { task: "任务".repeat(400) } }] }],
      [{ say: "我说明短一点。" }],
    ],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      minSteps: 2,
      /*
       * ⚠️ 2026-10-16（审计 P154）：title 承诺的是"**被 schema 拒**（不许悄悄截断）"，
       * 而原来 expect 只有 events/minSteps —— 拒绝、放行 800 字、还是静默截到 500 字，
       * 事件序列**一模一样**。现在：必须失败，且失败文案是 schema 拒收那一种；
       * 一个"悄悄截断"的实现会让调用成功（error 不存在）→ 这里立刻红。
       */
      toolErrors: ["spawn_agent"],
      toolErrorIncludes: ["Invalid input"],
    },
  },
  {
    id: "sub-two-turns",
    category: "子智能体",
    title: "两轮各派一次：两次都是独立的（第二轮不该复用第一轮的结论）",
    turns: ["派一次", "再派一次"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agent", args: { task: "第一件事" } }] }],
      [{ say: "第一次回来了。" }],
      [{ call: [{ name: "spawn_agent", args: { task: "第二件事" } }] }],
      [{ say: "第二次回来了。" }],
    ],
    expect: { events: ["tool-call", "tool-result", "done", "tool-call", "tool-result", "done"], minSteps: 4 },
  },
  {
    id: "sub-delegation-window",
    category: "子智能体",
    title: "团队委派的进度事件成对（started 与 finished 都来）",
    turns: ["派两个人做两件事"],
    mode: "全部允许",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: { tasks: [{ agent: "researcher", task: "甲" }, { agent: "writer", task: "乙" }] },
            },
          ],
        },
      ],
      [{ say: "两份都回来了。" }],
    ],
    // 两个专家 → started 与 finished 各两次（这里只要求"至少 4 条委派事件"里含两次 started）
    expect: { events: ["delegation", "delegation", "delegation", "delegation", "done"], delegations: 4, minSteps: 2 },
  },
];

/** 多 agent 协作（补 4 条）。 */
export const teams2: EvalCase[] = [
  {
    id: "team-empty-tasks",
    category: "多 agent 协作",
    title: "派个空团队：不能崩，也不能凭空编出结论",
    turns: ["派一个空团队"],
    mode: "全部允许",
    replies: [[{ call: [{ name: "spawn_agents", args: { tasks: [] } }] }], [{ say: "没有要派的事。" }]],
    expect: {
      events: ["tool-call", "tool-result", "done"],
      eventsAbsent: ["error"],
      minSteps: 2,
      /* 空 tasks 被 schema 拒（审计 P154：title 说的"不能崩"要能被证伪） */
      toolErrors: ["spawn_agents"],
      toolErrorIncludes: ["Invalid input"],
    },
  },
  {
    id: "team-duplicate-role",
    category: "多 agent 协作",
    title: "同一个角色派两次：两次都要跑（不许去重成一次）",
    turns: ["让同一个角色做两件事"],
    mode: "全部允许",
    replies: [
      [
        {
          call: [
            {
              name: "spawn_agents",
              args: { tasks: [{ agent: "researcher", task: "甲" }, { agent: "researcher", task: "乙" }] },
            },
          ],
        },
      ],
      [{ say: "两件都做了。" }],
    ],
    expect: { events: ["delegation", "done"], delegations: 4, minSteps: 2 },
  },
  {
    id: "team-two-turns",
    category: "多 agent 协作",
    title: "两轮各派一次团队：两次的进度各自成对出现",
    turns: ["先派一次团队", "再派一次团队"],
    mode: "全部允许",
    replies: [
      [{ call: [{ name: "spawn_agents", args: { tasks: [{ agent: "runner", task: "甲" }] } }] }],
      [{ say: "第一次完了。" }],
      [{ call: [{ name: "spawn_agents", args: { tasks: [{ agent: "runner", task: "乙" }] } }] }],
      [{ say: "第二次完了。" }],
    ],
    expect: { events: ["delegation", "done", "delegation", "done"], delegations: 4, minSteps: 4 },
  },
  {
    id: "team-mixed-tools",
    category: "多 agent 协作",
    title: "团队与普通工具混用：读 → 派 → 写，三种都真的发生",
    turns: ["看一眼、派个人、再写下来"],
    mode: "全部允许",
    fixtures: { "src.md": "素材" },
    replies: [
      [
        {
          call: [
            { name: "read_file", args: { path: "{{dir}}/src.md" } },
            { name: "spawn_agents", args: { tasks: [{ agent: "researcher", task: "查一下" }] } },
          ],
        },
      ],
      [{ call: [{ name: "write_file", args: { path: "{{dir}}/out.md", content: "结果" } }] }],
      [{ say: "齐了。" }],
    ],
    expect: {
      events: ["delegation", "tool-result", "tool-call", "tool-result", "done"],
      files: ["out.md"],
      delegations: 2,
      minSteps: 3,
    },
  },
];

/**
 * 上下文压缩（12 条，全部是 `core` 格子）。
 *
 * 这一类验的是**核心里那把尺子**，不是回合流程（压缩是宿主的编排，见 `cases.ts` 的说明）。
 * 为什么值得单独占 12 条：这一层算错了**不会报错** —— 它只会悄悄多发几万 token 或少发关键历史，
 * 两种后果都很难在界面上看出来。
 */
export const compaction2: EvalCase[] = [
  {
    id: "compact-threshold-boundary",
    category: "上下文压缩",
    kind: "core",
    title: "阈值边界：刚好在阈值上下，判定要跟着翻",
    coreCheck: () => {
      /*
       * 估算规则（`estimateTokens`）：**CJK 一字算 1**，其余 4 字符算 1。
       * 第一版按"4 字符 1 token"估中文，于是 7.9 万字被判成需要压缩 —— 红的是我的假设。
       * 这里两种文字各测一次（规则对两种都成立才算对）。
       */
      /*
       * ⚠️ 2026-10-16（审计 P161）：这里原来把 20000 抄成裸字面量（19_000/21_000、
       * 79_000/81_000，按"CJK 一字 1 token、拉丁 4 字符 1 token"倒推）——
       * 于是合法阈值区间只剩 ±5%，把 `KEEP_RECENT_TOKENS` 从 20000 改成别的值，
       * 这四条断言会一起红（而阈值本来就是可以调的）。
       * 现在从常量推：紧贴阈值上下各取一档。
       */
      const KEEP = KEEP_RECENT_TOKENS;
      const just = [{ role: "user" as const, content: "字".repeat(KEEP - 1000) }];
      const over = [{ role: "user" as const, content: "字".repeat(KEEP + 1000) }];
      if (shouldCompact(just)) return `中文 ${KEEP - 1000} 字被判成需要压缩（CJK 一字 1 token 的规则不成立？）`;
      if (!shouldCompact(over)) return `中文 ${KEEP + 1000} 字没被判成需要压缩（阈值偏大）`;
      // 同一把尺子量拉丁字母：4 字符 1 token → 阈值附近就是 4×KEEP 个字符
      const asciiJust = [{ role: "user" as const, content: "a".repeat(KEEP * 4 - 4000) }];
      const asciiOver = [{ role: "user" as const, content: "a".repeat(KEEP * 4 + 4000) }];
      if (shouldCompact(asciiJust)) return "拉丁 7.9 万字符被判成需要压缩（4 字符 1 token 的规则不成立？）";
      if (!shouldCompact(asciiOver)) return "拉丁 8.1 万字符没被判成需要压缩";
      return null;
    },
  },
  {
    id: "compact-estimate-linear",
    category: "上下文压缩",
    kind: "core",
    title: "估算随长度线性增长（涨得不对就说明计量坏了）",
    coreCheck: () => {
      const a = estimateTokens("字".repeat(400));
      const b = estimateTokens("字".repeat(4000));
      if (a <= 0 || b <= 0) return `估算出 ${a} / ${b}，不该有 0 或负数`;
      if (Math.abs(b / a - 10) > 0.5) return `十倍长度却不是十倍估算（${a} → ${b}）`;
      return null;
    },
  },
  {
    id: "compact-total-sums",
    category: "上下文压缩",
    kind: "core",
    title: "总计量 = 各条之和（少算一条就等于多发了历史）",
    coreCheck: () => {
      const msgs = [
        { role: "user" as const, content: "一".repeat(400) },
        { role: "assistant" as const, content: "二".repeat(400) },
      ];
      const sum = estimateTokens(msgs[0].content) + estimateTokens(msgs[1].content);
      const total = totalTokens(msgs);
      if (total !== sum) return `总计量 ${total} ≠ 各条之和 ${sum}`;
      return null;
    },
  },
  {
    id: "compact-calibration",
    category: "上下文压缩",
    kind: "core",
    title: "校准系数：真实用量出来之后要往回校准（估偏低 → 系数 > 1）",
    coreCheck: () => {
      const under = calibrationOf(1000, 1300);
      if (!(under > 1)) return `低估 30% 时系数应 > 1，实际 ${under}`;
      const over = calibrationOf(1000, 700);
      if (!(over < 1)) return `高估 30% 时系数应 < 1，实际 ${over}`;
      if (calibrationOf(1000, undefined) !== 1) return "没有真实用量时应当回落到 1（不猜）";
      /*
       * ⚠️ 2026-10-16（审计 P162）：原来三个入参组合（1.3 / 0.7 / 1）全落在
       * `Math.min(2, Math.max(0.5, …))` 的**非夹持区** —— 把夹紧整段删掉照样绿，
       * 而注释正把夹紧写成理由（"不该与估算差出一倍以上…夹住比放任安全"）。
       * 现在把上下两个夹持分支都真的踩到。
       */
      /* 系数 = 真实 ÷ 估算：低估 → 系数大（夹到 2）；高估 → 系数小（夹到 0.5） */
      if (calibrationOf(1000, 100_000) !== 2) {
        return `极端低估（真实是估算的 100 倍）应当夹在上限 2，实际 ${calibrationOf(1000, 100_000)}`;
      }
      if (calibrationOf(1000, 100) !== 0.5) {
        return `极端高估（真实只有估算的 1/10）应当夹在下限 0.5，实际 ${calibrationOf(1000, 100)}`;
      }
      return null;
    },
  },
  {
    id: "compact-never-empty",
    category: "上下文压缩",
    kind: "core",
    title: "压缩**永不清空**历史：最后一条无论多大都要留下",
    coreCheck: () => {
      const huge = { role: "assistant" as const, content: "字".repeat(200_000) };
      const plan = planContext([{ role: "user" as const, content: "第一句" }, huge]);
      if (plan.recent.length === 0) return "把历史清空了 —— 那这一轮等于没有上下文";
      if (!plan.recent.includes(huge)) return "最后一条超大消息被丢掉了（模型会看不到它）";
      return null;
    },
  },
  {
    id: "compact-split-not-on-tool",
    category: "上下文压缩",
    kind: "core",
    title: "保留段不许以助手发言开头（因果断了：模型会读到「我刚说的」却没有它回应的话）",
    coreCheck: () => {
      /*
       * `ChatMessage` 只有 system / user / assistant 三种角色（工具结果不走这一层，
       * 由 SDK 自己配对）—— 所以"切割点别落在工具结果上"这条在**这一层**表现为
       * "别让保留段以 assistant 开头"：`planContext` 的注释就是这么写的（要往后挪）。
       */
      /*
       * ⚠️ 2026-10-16（审计 P155）：原来是 `planContext(msgs, 0)` —— 额度 0 时
       * 循环里的 `recent.length > 0` 前置条件保证**只收一条**，于是
       * `plan.recent.length > 1` 这个守卫**永远不成立**，这条用例恒绿：
       * 把"往后挪"那段代码整块删掉，它也照样过（数学上不可命中）。
       *
       * 现在给一个**刚好收三条**的额度（1000 一条、共 5000）：
       * 从尾部收 = [assistant("乙"), user("丙"), assistant("丁")] —— 开头是助手，
       * 必须往后挪一条；判据同时钉住"挪了"（长度 2）与"挪到哪儿去"（older 多一条）。
       */
      const msgs = [
        { role: "user" as const, content: "甲".repeat(1000) },
        { role: "assistant" as const, content: "乙".repeat(1000) },
        { role: "user" as const, content: "丙".repeat(1000) },
        { role: "assistant" as const, content: "丁".repeat(3000) },
      ];
      const plan = planContext(msgs, 5000);
      const first = plan.recent[0];
      if (!first) return "保留段为空";
      if (first.role === "assistant") return "保留段以助手发言开头（应当往后挪到用户那一句）";
      if (plan.recent.length !== 2) {
        return `保留段应当是挪过之后的 2 条（原切点 3 条、开头是助手），实际 ${plan.recent.length} 条 —— "往后挪"没发生？`;
      }
      if (plan.older.length !== 2) return `被挪出去的那条应当进 older（期望 2 条），实际 ${plan.older.length} 条`;
      return null;
    },
  },
  {
    id: "compact-keep-registered",
    category: "上下文压缩",
    kind: "core",
    title: "已登记模型的保留额度 = 上限 × 比例，且被上下限夹住",
    coreCheck: () => {
      for (const id of MODEL_IDS) {
        const spec = MODEL_CATALOG.find((m) => m.id === id);
        if (!spec) continue;
        const keep = keepTokensFor(id);
        const raw = spec.contextWindow * KEEP_RATIO;
        const want = Math.max(KEEP_RECENT_TOKENS_MIN, Math.min(raw, MAX_KEEP_TOKENS));
        if (keep !== want) return `${id}：保留额度 ${keep} ≠ 期望 ${want}（上限 ${spec.contextWindow}）`;
      }
      return null;
    },
  },
  {
    id: "compact-unknown-model",
    category: "上下文压缩",
    kind: "core",
    title: "未登记的模型：走保守默认且**如实标注**（不编一个上下文上限）",
    coreCheck: () => {
      const lookup = budgetOf("完全不存在的模型");
      if (lookup.registered) return "未登记的模型被判成已登记";
      if (lookup.contextWindow !== UNKNOWN_MODEL_BUDGET.contextWindow) return `上限 ${lookup.contextWindow} ≠ 保守默认 ${UNKNOWN_MODEL_BUDGET.contextWindow}`;
      if (keepTokensFor("完全不存在的模型") !== KEEP_RECENT_TOKENS) return "未登记模型没有用换代前那个固定值（行为会漂）";
      const text = describeBudget("完全不存在的模型");
      if (!text.includes("未登记")) return `说明里没写"未登记"：「${text}」`;
      return null;
    },
  },
  {
    id: "compact-stale-marked",
    category: "上下文压缩",
    kind: "core",
    title: "核实日期过期的模型要被标出来（旧数据不许装作新的）",
    coreCheck: () => {
      const spec = MODEL_CATALOG[0];
      if (!spec) return "目录表是空的";
      const fresh = isStale(spec, Date.parse("2020-01-01"));
      const stale = isStale(spec, Date.parse("2099-01-01"));
      if (fresh) return `${spec.id} 在它自己的核实日期附近被判成过期（阈值算反了）`;
      if (!stale) return `${spec.id} 在很久以后仍判成新鲜（过期提醒失效）`;
      if (budgetOf(BIGGEST_MODEL, Date.parse("2099-01-01")).stale !== true) return "budgetOf 没有把过期信息带出来";
      return null;
    },
  },
  {
    id: "compact-budget-text",
    category: "上下文压缩",
    kind: "core",
    title: "保留额度的说明文案**含具体数字**（用户要能看出到底留了多少）",
    coreCheck: () => {
      const text = describeBudget(MODEL_IDS[0]);
      if (!/\d/.test(text)) return `说明里一个数字都没有：「${text}」`;
      const unknown = describeBudget(undefined);
      if (!unknown) return "模型未指定时没有说明";
      return null;
    },
  },
  {
    id: "compact-note-both-modes",
    category: "上下文压缩",
    kind: "core",
    title: "两种压缩模式的回注**都写清去向**（丢掉 vs 压成摘要，用户要分得清）",
    coreCheck: () => {
      const trimmed = omittedNote("trimmed");
      const summarized = omittedNote("summarized");
      if (trimmed === summarized) return "两种模式回注了同一句话";
      if (!summarized.includes("摘要")) return `压缩模式的回注没说"摘要"：「${summarized}」`;
      // 压缩那条要给模型一句行为指引（"不确定就直说"），丢掉那条不需要
      if (!summarized.includes("不要猜")) return `压缩模式的回注缺少"不要猜"的指引：「${summarized}」`;
      return null;
    },
  },
  {
    id: "compact-budget-of-registered",
    category: "上下文压缩",
    kind: "core",
    title: "已登记模型的上限取自目录表（不是拍脑袋的另一个数）",
    coreCheck: () => {
      for (const id of MODEL_IDS.slice(0, 5)) {
        const spec = MODEL_CATALOG.find((m) => m.id === id);
        if (!spec) continue;
        const lookup = budgetOf(id);
        if (!lookup.registered) return `${id} 被判成未登记（但它在目录表里）`;
        if (lookup.contextWindow !== spec.contextWindow) {
          return `${id}：上限 ${lookup.contextWindow} ≠ 目录表里的 ${spec.contextWindow}`;
        }
      }
      return null;
    },
  },
];
