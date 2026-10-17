import { describe, expect, it } from "vitest";
import type { AiStreamEvent } from "@shared/ipc";
import {
  actorOf,
  applyEvent,
  emptyTurn,
  finishTurn,
  isPendingOutput,
  LEGACY_ACTOR,
  logLine,
  parseLog,
  parseLogLine,
  projectTurn,
  splitTurns,
  chatSessionId,
  taskSessionId,
  isChatSessionId,
  conversationIdOf,
  type LogRecord,
  type ApprovalRecord,
  fold,
  resumeSession,
} from "@engine/core/events";
import { diffSnapshot, snapshotOf } from "@engine/core/snapshot";

/**
 * C2：会话事件的投影（**一份实现，两条路径共用**）。
 *
 * ## 为什么这些断言必须存在
 *
 * 这段"事件 → 留痕/正文/用量"的推导原来被写了**四遍**（工作台、聊天、悬浮助手、
 * 主进程），于是它们慢慢答得不一样：实测工作台**不接 usage**（`done` 事件被丢掉）、
 * 聊天**不展开**子智能体上交的调用。收敛成一份之后，**这一份必须被钉住** ——
 * 否则下一次"再抄一份"就又把答案分裂开。
 *
 * ⚠️ 断言的是**能证伪的行为**（参数有没有配上、pending 判对没有、坏行会不会拖倒整段），
 * 不是"函数被调过"。
 */

const T = (n: number) => 1_700_000_000_000 + n;

/**
 * 事件的输入形状（还没带 requestId）。
 *
 * ⚠️ 不能写成 `Omit<AiStreamEvent, "requestId">`：`Omit` 作用在**联合类型**上
 * 只会留下各成员的公共字段，于是 `text` / `toolCallId` 全被抹掉，
 * 传什么都报属性不存在。所以显式展开一遍联合（与 `shared/sessionLog.ts` 的 `LogInput` 同一个道理）。
 */
type EvInput = AiStreamEvent extends infer U ? (U extends AiStreamEvent ? Omit<U, "requestId"> : never) : never;

/** 造一条事件（省掉每个用例重复写 requestId）。 */
const ev = (e: EvInput): AiStreamEvent => ({ requestId: "r1", ...e } as AiStreamEvent);

/**
 * 造一条**决策记录**（`approval` 不在 `AiStreamEvent` 里 —— 它是日志自己的记录类型：
 * 它记的不是"模型说了什么"，而是"用户批了什么"）。
 */
const appr = (e: Omit<ApprovalRecord, "seq" | "at">) => e;

describe("applyEvent · 正文与收尾", () => {
  it("文本按到达顺序累积；done 之前不算结束", () => {
    let state = emptyTurn();
    expect(state.done).toBe(false);
    state = applyEvent(state, ev({ type: "text", text: "你" }));
    state = applyEvent(state, ev({ type: "text", text: "好" }));
    expect(state.text).toBe("你好");
    expect(state.done).toBe(false);

    state = applyEvent(state, ev({ type: "done" }));
    expect(finishTurn(state).done).toBe(true);
  });

  it("done 带 usage 就接住（**拿不到就不编**：没有就是 undefined）", () => {
    const withUsage = projectTurn([ev({ type: "done", usage: { inputTokens: 10, outputTokens: 3 } })]);
    expect(withUsage.usage).toEqual({ inputTokens: 10, outputTokens: 3 });

    expect(projectTurn([ev({ type: "done" })]).usage).toBeUndefined();
  });

  it("error 记下来并算结束（界面据此收尾，不必再等 done）", () => {
    const view = projectTurn([ev({ type: "text", text: "半" }), ev({ type: "error", message: "已中止" })]);
    expect(view.error).toBe("已中止");
    expect(view.done).toBe(true);
    // 已经出来的半句话不丢 —— 用户看得见"说到哪儿断的"
    expect(view.text).toBe("半");
  });
});

describe("applyEvent · 不认识的事件", () => {
  it("⭐⭐ 未知类型**忽略**，不许当报错（「不是 text/done 就当 error」那个坑不能再犯）", () => {
    // 以后会加新事件类型（比如 reasoning）；那时若沿用兜底，用户会看到「出错了」而其实什么都没坏
    const unknown = { requestId: "r1", type: "reasoning", text: "想一下" } as unknown as AiStreamEvent;
    const view = projectTurn([ev({ type: "text", text: "好" }), unknown]);
    expect(view.error).toBeUndefined();
    expect(view.done).toBe(false); // 它也不是"结束"
    expect(view.text).toBe("好");
  });
});

describe("applyEvent · 工具调用（参数配对 + pending）", () => {
  it("⭐ 参数按 toolCallId 配上，留痕那一行由 describeToolResult 生成", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "主人喜欢美式" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 3 } }),
    ]);
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].input).toEqual({ text: "主人喜欢美式" });
    expect(view.traces[0].line).toContain("已保存");
    // 参数摘要挂在那一行末尾（§175 的口径）
    expect(view.traces[0].line).toContain("主人喜欢美式");
    expect(view.traces[0].pending).toBeUndefined();
  });

  it("⭐⭐ 被闸门拦下的那一条：`pending:true` 保留，且**没有输出**（它没执行）", () => {
    const output = { pending: true, notice: "这一步需要你确认" };
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output }),
    ]);
    expect(view.traces[0].pending).toBe(true);
    expect(view.traces[0].line).toContain("等你确认");
    expect(view.traces[0].line).toContain("还没执行");
  });

  it("⚠️ 判 pending 只认 `=== true`（别的形状一律当已执行，不能凭空给「允许」按钮）", () => {
    expect(isPendingOutput({ pending: true })).toBe(true);
    // 这些都不算：字符串 "true"、1、字段名不同
    expect(isPendingOutput({ pending: "true" })).toBe(false);
    expect(isPendingOutput({ pending: 1 })).toBe(false);
    expect(isPendingOutput({ pendingApproval: true })).toBe(false);
    expect(isPendingOutput(undefined)).toBe(false);
    expect(isPendingOutput(null)).toBe(false);
    // 工具真返回的业务数据里恰好有 pending 字段时…只有 true 才算（其余形状由各工具自己保证）
    expect(isPendingOutput({ ok: true })).toBe(false);
  });

  it("⭐ 只有调用、没有结果的那半截**不进**留痕（「发生过的事」不该有半截）", () => {
    const state = applyEvent(
      emptyTurn(),
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } }),
    );
    expect(finishTurn(state).traces).toEqual([]);
  });

  it("工具失败也是一条留痕（错误当结果回注，别让它消失）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", error: "磁盘满了" }),
    ]);
    expect(view.traces[0].ok).toBe(false);
    expect(view.traces[0].error).toBe("磁盘满了");
  });

  it("⭐ 同一条调用的事件重复到达时，留痕按 toolCallId **幂等替换**（日志追加写会重试，重放不能多出一行）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_list", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_list", output: { count: 2 } }),
      // 追加写重试造成的重复
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_list", output: { count: 2 } }),
    ]);
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].toolCallId).toBe("c1");
  });

  it("一条回复里的**多次**调用各自留痕（按 id 分辨，不能按工具名）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "一" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 1 } }),
      ev({ type: "tool-call", toolCallId: "c2", toolName: "memory_save", input: { text: "二" } }),
      ev({ type: "tool-result", toolCallId: "c2", toolName: "memory_save", output: { count: 2 } }),
    ]);
    expect(view.traces.map((t) => t.toolCallId)).toEqual(["c1", "c2"]);
    expect(view.traces.map((t) => (t.input as { text: string }).text)).toEqual(["一", "二"]);
  });
});

describe("子智能体上交的调用（§176）", () => {
  const events: AiStreamEvent[] = [
    ev({ type: "tool-call", toolCallId: "s1", toolName: "spawn_agent", input: { task: "查一下" } }),
    ev({
      type: "tool-result",
      toolCallId: "s1",
      toolName: "spawn_agent",
      output: {
        ok: true,
        summary: "查完了",
        steps: 2,
        toolCalls: ["memory_save"],
        blocked: [{ toolCallId: "b1", name: "memory_save", input: { text: "它想存的" } }],
      },
    }),
  ];

  it("开 expandBlocked：上交的那条变成**父级上的待批准项**（带参数，才能原样执行）", () => {
    const view = projectTurn(events, { expandBlocked: true });
    expect(view.traces).toHaveLength(2);
    expect(view.traces[1].pending).toBe(true);
    expect(view.traces[1].name).toBe("memory_save");
    expect(view.traces[1].input).toEqual({ text: "它想存的" });
    // 顺序：先那条"子智能体完成了"，再挂上交的待批准项
    expect(view.traces[0].name).toBe("spawn_agent");
  });

  it("关 expandBlocked（聊天侧的现状）：只留子智能体那一条，不额外造按钮", () => {
    expect(projectTurn(events).traces).toHaveLength(1);
  });

  it("⚠️ 工具这一层**报错**时才是「没跑成」：那种情况下它连 report 都没有，自然没有可展开的东西", () => {
    const errored = [
      events[0],
      ev({ type: "tool-result", toolCallId: "s1", toolName: "spawn_agent", error: "拿不到 provider" }),
    ];
    const view = projectTurn(errored, { expandBlocked: true });
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].ok).toBe(false);
  });

  it("报告自身 ok:false 但**闸门真拦下过东西**时照旧展开（这是原工作台的行为，用户该看到它想做什么）", () => {
    const failed = [
      events[0],
      ev({
        type: "tool-result",
        toolCallId: "s1",
        toolName: "spawn_agent",
        output: { ok: false, blocked: [{ toolCallId: "b1", name: "memory_save", input: { text: "它想存的" } }] },
      }),
    ];
    const view = projectTurn(failed, { expandBlocked: true });
    expect(view.traces).toHaveLength(2);
    expect(view.traces[1].pending).toBe(true);
  });
});

describe("INV-2：流式与投影走的是同一条路", () => {
  it("逐条 applyEvent 的结果 = 一次性 projectTurn（否则「边流边显示」与「事后重建」会不一致）", () => {
    const events: AiStreamEvent[] = [
      ev({ type: "text", text: "先查" }),
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_list", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_list", output: { count: 2 } }),
      ev({ type: "text", text: "，共 2 条" }),
      ev({ type: "done", usage: { inputTokens: 5, outputTokens: 7 } }),
    ];

    let streamed = emptyTurn();
    for (const event of events) streamed = applyEvent(streamed, event);

    expect(finishTurn(streamed)).toEqual(projectTurn(events));
  });

  it("任何时刻看留痕都是「可显示的」（没有空行：半截调用不会漏出去）", () => {
    let state = emptyTurn();
    const seen: string[] = [];
    for (const event of [
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 1 } }),
    ]) {
      state = applyEvent(state, event);
      for (const t of finishTurn(state).traces) seen.push(t.line);
    }
    expect(seen.every((line) => line.length > 0)).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe("日志行（jsonl）", () => {
  it("序列化 → 解析：往返一致（含 seq/at；actor 由读端补齐，见下一条）", () => {
    const line = logLine(ev({ type: "text", text: "你好" }), 3, T(3));
    expect(line.endsWith("\n")).toBe(true);
    const { records, skipped } = parseLog(line);
    expect(skipped).toBe(0);
    expect(records).toEqual([
      { requestId: "r1", type: "text", text: "你好", seq: 3, at: T(3), actor: LEGACY_ACTOR },
    ]);
  });

  it("⭐ C5 读兼容（V5 §3.1 明文口径）：老记录（没有 actor）读回 actor=legacy，不改磁盘", () => {
    /* 一条**actor 维度上线之前**写下的行：字段就是那时候的样子 */
    const old = `${JSON.stringify({ seq: 1, at: T(1), requestId: "r1", type: "text", text: "旧话" })}\n`;
    const { records } = parseLog(old);
    expect(records[0]?.actor, "老记录没有拿到 legacy 兜底").toEqual({ id: "legacy", kind: "legacy" });
    expect(actorOf(records[0]).id).toBe("legacy");
    /* 磁盘上那份**没被改**（读兼容不是迁移：我们只填读回来的对象） */
    expect(old).not.toContain("actor");
  });

  it("actor 写进去就原样读回来（新记录）；形状坏掉时兜底 legacy，而不是判成坏行", () => {
    const line = logLine(
      { requestId: "r1", type: "text", text: "新话", actor: { id: "local", kind: "user" } },
      1,
      T(1),
    );
    expect(parseLogLine(line)?.actor).toEqual({ id: "local", kind: "user" });

    /* 手改坏 / 被截断的 actor：**不该把这一行判成坏行**（记录讲的事仍然成立） */
    const broken = `${JSON.stringify({ seq: 2, at: T(2), requestId: "r1", type: "text", text: "还被认", actor: "谁啊" })}\n`;
    const parsed = parseLog(broken);
    expect(parsed.skipped, "actor 坏掉把整行判成了坏行").toBe(0);
    expect(parsed.records[0]?.actor).toEqual({ id: "legacy", kind: "legacy" });
  });

  it("⭐ 坏行只跳过它自己（断电/强杀留下的半行不许让整段历史消失）", () => {
    const text = [
      logLine(ev({ type: "text", text: "一" }), 1, T(1)),
      '{"seq":2,"at":1700000000002,"requestId":"r1","ty', // 写到一半断了
      "不是 json",
      logLine(ev({ type: "done" }), 3, T(3)),
    ].join("\n");
    const { records, skipped } = parseLog(text);
    expect(records.map((e) => e.seq)).toEqual([1, 3]);
    expect(skipped).toBe(2);
  });

  it("缺 seq/at、类型不认识的行都算坏行（宁可跳过，不要拿半个事件去投影）", () => {
    const text = [
      '{"requestId":"r1","type":"text","text":"没有 seq"}',
      '{"seq":1,"requestId":"r1","type":"text","text":"没有 at"}',
      '{"seq":1,"at":1,"requestId":"r1","type":"未来才有的事件"}',
      '{"seq":1,"at":1,"requestId":"r1","type":"done"}',
    ].join("\n");
    const { records, skipped } = parseLog(text);
    expect(records).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it("乱序落盘时按 seq 归位（追加写的日志不怕这个，但读的人不该受影响）", () => {
    const text = [logLine(ev({ type: "text", text: "后" }), 2, T(2)), logLine(ev({ type: "text", text: "前" }), 1, T(1))].join("\n");
    const { records } = parseLog(text);
    expect(records.map((e) => (e as { text: string }).text)).toEqual(["前", "后"]);
    // 归位之后投影出来才是对的顺序
    expect(projectTurn(records).text).toBe("前后");
  });
});

describe("决策记录（INV-3）：谁批的、批了之后是什么结果", () => {
  /** 一条被闸门拦下的调用（真实形状：pending 信封）。 */
  const blocked = [
    ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "主人喜欢美式" } }),
    ev({
      type: "tool-result",
      toolCallId: "c1",
      toolName: "memory_save",
      output: { pending: true, notice: "这一步需要你确认" },
    }),
  ];

  it("⭐⭐ 批准：留痕从「等你确认」变成结论（pending 摘掉、那一行换成结果）", () => {
    const view = projectTurn([
      ...blocked,
      appr({
        type: "approval",
        toolCallId: "c1",
        name: "memory_save",
        approved: true,
        ok: true,
        output: { count: 1 },
        line: "⚙ 记忆：已保存，当前 1 条（写入「主人喜欢美式」）",
      }),
    ]);
    expect(view.traces[0].pending).toBeUndefined();
    expect("pending" in view.traces[0]).toBe(false); // 摘掉，不是置 false
    expect(view.traces[0].line).toContain("已保存");
    expect(view.traces[0].output).toEqual({ count: 1 });
  });

  it("⭐⭐ 拒绝：也留痕（原来拒绝连 IPC 都不发，重启后无从查证）", () => {
    const view = projectTurn([
      ...blocked,
      appr({ type: "approval", toolCallId: "c1", name: "memory_save", approved: false, line: "⚙ 记忆：你已拒绝" }),
    ]);
    expect(view.traces[0].pending).toBeUndefined();
    expect(view.traces[0].line).toContain("你已拒绝");
  });

  it("决策记录找不到对应留痕时忽略（日志被截过也不许凭空造一条）", () => {
    const view = projectTurn([
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: {} }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { count: 1 } }),
      appr({ type: "approval", toolCallId: "查无此调用", name: "memory_save", approved: true, line: "x" }),
    ]);
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0].line).toContain("已保存");
  });

  it("决策记录能往返落盘（缺 approved 的行算坏行，不拿半条去重放）", () => {
    const good = logLine(
      appr({ type: "approval", toolCallId: "c1", name: "memory_save", approved: true, line: "⚙ 记忆：已保存" }),
      1,
      T(1),
    );
    const bad = '{"seq":2,"at":1,"requestId":"r1","type":"approval","toolCallId":"c2","line":"缺 approved"}';
    const { records, skipped } = parseLog([good, bad].join("\n"));
    expect(skipped).toBe(1);
    expect(records).toHaveLength(1);
    expect((records[0] as { approved: boolean }).approved).toBe(true);
  });
});

describe("⭐ 展开出来的子智能体待批项：它的决策记录不许被吞（审计 P51 / INV-2·INV-3）", () => {
  /*
   * ## 这条缺陷的形状
   *
   * 子智能体上交的调用**不在**父级 `traces` 里 —— 它是 `finishTurn(expandBlocked)`
   * 收尾时**展开**出来的。而 `applyEvent` 处理决策记录时只翻 `state.traces`，
   * 于是"给那条展开项的批准"找不到对应留痕 → 被当成"日志被截过"静默忽略。
   *
   * 后果两件（都是用户能撞上的）：① 重启后那条留痕**永远停在「等你确认」**，
   * 用户以为自己的决定丢了；② 它还占着待办名单，界面又给一次按钮。
   *
   * ⚠️ 判据必须是"**重放之后那条留痕的样子**"与"待办名单里还有没有它"，
   * 而不是"函数被调用过" —— 后者在修复前也成立（吞掉也是调用过）。
   */
  const spawn = [
    ev({ type: "tool-call", toolCallId: "s1", toolName: "spawn_agent", input: { task: "查一下" } }),
    ev({
      type: "tool-result",
      toolCallId: "s1",
      toolName: "spawn_agent",
      output: {
        ok: true,
        summary: "查完了",
        blocked: [{ toolCallId: "b1", name: "memory_save", input: { text: "它想存的" } }],
      },
    }),
  ];
  const approved = appr({
    type: "approval",
    toolCallId: "b1",
    name: "memory_save",
    approved: true,
    ok: true,
    line: "⚙ 记忆：已保存，当前 1 条",
  });

  it("对照：没批过时它确实是待批项（装置先自证在判）", () => {
    const view = projectTurn(spawn, { expandBlocked: true });
    expect(view.traces.find((t) => t.toolCallId === "b1")?.pending).toBe(true);
  });

  it("单轮投影：批过之后那条展开出的留痕是**结论**", () => {
    const view = projectTurn([...spawn, approved], { expandBlocked: true });
    const b1 = view.traces.find((t) => t.toolCallId === "b1");
    expect(b1?.pending).toBeUndefined();
    expect(b1?.line).toContain("已保存");
  });

  it("⭐⭐ 整段重放（splitTurns）：决策落在它那一轮，留痕不再是「等你确认」", () => {
    // 真实形状：用户在那一轮结束很久之后才点「允许」→ 决策记录落在日志末尾
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [{ role: "user", content: "查一下" }] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "s1", toolName: "spawn_agent", input: { task: "查一下" } },
      {
        seq: 3,
        at: T(3),
        requestId: "r1",
        type: "tool-result",
        toolCallId: "s1",
        toolName: "spawn_agent",
        output: { ok: true, summary: "查完了", blocked: [{ toolCallId: "b1", name: "memory_save", input: { text: "它想存的" } }] },
      },
      { seq: 4, at: T(4), requestId: "r1", type: "done" },
      { seq: 5, at: T(5), type: "approval", toolCallId: "b1", name: "memory_save", approved: true, ok: true, line: "⚙ 记忆：已保存，当前 1 条" },
    ] as unknown as LogRecord[];

    const resumed = resumeSession(records, { expandBlocked: true });
    expect(resumed.turns).toHaveLength(1);
    const b1 = resumed.turns[0]!.view.traces.find((t) => t.toolCallId === "b1");
    expect(b1, "展开出来的留痕丢了").toBeTruthy();
    expect(b1?.pending, "批过的留痕又停在「等你确认」").toBeUndefined();
    expect(b1?.line).toContain("已保存");
    // 参数照旧活着（放行时要用它原样执行）
    expect(b1?.input).toEqual({ text: "它想存的" });
    // ⭐ 决策没丢的另一面：待办名单里不该再有它
    expect(resumed.pending, "用户点过的决定又冒出一个待办").toEqual([]);
  });
});

describe("splitTurns（F3：聊天历史按轮恢复）", () => {
  const conv = [
    { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "第一句" }] },
    { seq: 2, at: T(2), requestId: "r1", type: "text", text: "第一答" },
    { seq: 3, at: T(3), requestId: "r1", type: "done" },
    { seq: 4, at: T(4), requestId: "r2", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "第二句" }] },
    { seq: 5, at: T(5), requestId: "r2", type: "text", text: "第二答" },
    { seq: 6, at: T(6), requestId: "r2", type: "done", usage: { inputTokens: 9, outputTokens: 4 } },
  ] as unknown as LogRecord[];

  it("⭐ 按 request 切成两轮，各自带着自己的输入与投影", () => {
    const chunks = splitTurns(conv);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].request?.messages[0].content).toBe("第一句");
    expect(chunks[0].view.text).toBe("第一答");
    expect(chunks[1].view.text).toBe("第二答");
    expect(chunks[1].view.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("一轮里的工具与被批过的调用都跟着那一轮（恢复出来的历史才完整）", () => {
    const records = [
      conv[0],
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "x" } },
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { pending: true } },
      { seq: 4, at: T(4), requestId: "r1", type: "approval", toolCallId: "c1", name: "memory_save", approved: true, ok: true, line: "⚙ 记忆：已保存" },
      { seq: 5, at: T(5), requestId: "r1", type: "done" },
    ] as unknown as LogRecord[];
    const [chunk] = splitTurns(records);
    expect(chunk.view.traces).toHaveLength(1);
    expect(chunk.view.traces[0].pending).toBeUndefined();
    expect(chunk.view.traces[0].line).toContain("已保存");
  });

  it("开头若有「没有 request」的记录，自成一截而**不丢**（那仍是发生过的事）", () => {
    const records = [{ seq: 1, at: T(1), requestId: "r0", type: "text", text: "半截" }, ...conv] as unknown as LogRecord[];
    const chunks = splitTurns(records);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].request).toBeNull();
    expect(chunks[0].view.text).toBe("半截");
  });

  it("空日志给空数组（第一次跑是正常的）", () => {
    expect(splitTurns([])).toEqual([]);
  });
});

describe("会话 id（F3：聊天的日志要能列出来，而且要能反推回对话）", () => {
  it("前缀区分两条路；聊天 id 能反推回对话 id", () => {
    expect(chatSessionId("c1")).toBe("chat-c1");
    expect(taskSessionId("t-123")).toBe("task-t-123");
    expect(isChatSessionId("chat-c1")).toBe(true);
    expect(isChatSessionId("task-t-123")).toBe(false);
    expect(conversationIdOf("chat-c-1700-3")).toBe("c-1700-3");
    expect(conversationIdOf("task-t-123")).toBe("");
  });
});

describe("splitTurns · 参数不能丢（真验收抓到的那一条）", () => {
  it("⭐⭐ 恢复出来的留痕必须带 `input`（否则重启后点「允许」执行的是空参数）", () => {
    /*
     * 这条是 accept-chathistory 端到端跑出来的真缺陷：
     * 第一版 splitTurns 每来一条记录都从**成品投影**反推状态，
     * 而成品里没有"等配对的调用"（`finishTurn` 会把它们剔掉）——
     * 于是 `tool-result` 找不到那次调用的参数，恢复出来的留痕 `input` 是空的，
     * 用户重启后点「允许」时执行体拿到 undefined，报
     * `Cannot read properties of undefined (reading 'text')`。
     *
     * 断言只看一件事：**参数活着穿过日志**。
     */
    const records = [
      { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "记住 42" }] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "幸运数字是 42" } },
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { pending: true } },
      { seq: 4, at: T(4), requestId: "r1", type: "done" },
    ] as unknown as LogRecord[];

    const [chunk] = splitTurns(records);
    expect(chunk.view.traces).toHaveLength(1);
    expect(chunk.view.traces[0].input).toEqual({ text: "幸运数字是 42" });
    expect(chunk.view.traces[0].pending).toBe(true);
  });

  it("决策记录回溯到它那一轮时，参数同样还在（恢复后能直接放行）", () => {
    const records = [
      { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "记住 42" }] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "幸运数字是 42" } },
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "memory_save", output: { pending: true } },
      { seq: 4, at: T(4), requestId: "r1", type: "done" },
      // 下一轮开始之后用户才点「允许」（真实形状）
      { seq: 5, at: T(5), requestId: "r2", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "还有别的吗" }] },
      { seq: 6, at: T(6), type: "approval", toolCallId: "c1", name: "memory_save", approved: true, ok: true, line: "⚙ 记忆：已保存，当前 1 条" },
    ] as unknown as LogRecord[];

    const chunks = splitTurns(records);
    expect(chunks).toHaveLength(2);
    // 决策落在**它自己那一轮**（第一轮），不是后一轮
    expect(chunks[0].view.traces[0].input).toEqual({ text: "幸运数字是 42" });
    expect(chunks[0].view.traces[0].pending).toBeUndefined();
    expect(chunks[1].view.traces).toHaveLength(0);
  });
});

/**
 * Phase 1 D2-D3：**事件溯源**（state = fold(events)）与 `resume`。
 *
 * 这三条是"换代"最实质的那部分：恢复不再靠"从日志翻译回消息列表"，
 * 而是**重放事件流**。所以判据必须是"往返一致"，而不是"函数被调用过"。
 */
describe("fold · 事件溯源（state = fold(events)）", () => {
  it("⭐ fold 与 projectTurn 的累积部分一致（同一份折叠，不是两份实现）", () => {
    const records = [
      ev({ type: "text", text: "答案" }),
      ev({ type: "text", text: "是 42" }),
      ev({ type: "tool-call", toolCallId: "c1", toolName: "memory_save", input: { text: "42" } }),
      ev({ type: "done", usage: { inputTokens: 3, outputTokens: 4 } }),
    ];
    const state = fold(records);
    const view = projectTurn(records);
    // projectTurn = fold + finishTurn：两者的正文/用量/结束标记必须一致
    expect(state.text).toBe(view.text);
    expect(state.usage).toEqual(view.usage);
    expect(state.done).toBe(view.done);
  });

  it("fold 保留**还没配对**的调用（那是 finishTurn 才剔掉的东西）", () => {
    const state = fold([ev({ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } })]);
    expect(state.waiting).toHaveLength(1);
    expect(state.traces).toHaveLength(0); // "调了一半"不是发生过的事
  });

  it("⭐ 重放往返一致：fold(events) 的结果可再次折叠而不变（幂等 + 确定性）", () => {
    const records = [
      ev({ type: "text", text: "先读一下" }),
      ev({ type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.md" } }),
      ev({ type: "tool-result", toolCallId: "c1", toolName: "read_file", output: { ok: true, text: "内容" } }),
      ev({ type: "text", text: "读到了" }),
      ev({ type: "done", usage: { inputTokens: 10, outputTokens: 5 } }),
    ];
    const once = fold(records);
    const twice = fold(records);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // 再折一遍同一批（重放的典型形状：日志被读第二遍）结果不变
    expect(JSON.stringify(fold([...records]))).toBe(JSON.stringify(once));
  });
});

describe("resume · 从日志还原会话", () => {
  it("⭐ 待办清单 = 收尾后仍 pending 的那些（已批过的不算）", () => {
    const records = [
      { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "写个文件" }] },
      { seq: 2, at: T(2), requestId: "r1", type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a.md", content: "x" } },
      { seq: 3, at: T(3), requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true } },
      { seq: 4, at: T(4), requestId: "r1", type: "tool-call", toolCallId: "c2", toolName: "write_file", input: { path: "b.md", content: "y" } },
      { seq: 5, at: T(5), requestId: "r1", type: "tool-result", toolCallId: "c2", toolName: "write_file", output: { pending: true } },
      { seq: 6, at: T(6), requestId: "r1", type: "done" },
      // 用户只批了第一条
      { seq: 7, at: T(7), type: "approval", toolCallId: "c1", name: "write_file", approved: true, ok: true, line: "✎ 写文件：已写入 a.md" },
    ] as unknown as LogRecord[];

    const resumed = resumeSession(records);
    expect(resumed.turns).toHaveLength(1);
    // 只有 c2 还等着 —— 从**原始事件**里挑会挑出两条假待办（c1 早就批过了）
    expect(resumed.pending).toHaveLength(1);
    expect(resumed.pending[0]).toMatchObject({ toolCallId: "c2", name: "write_file" });
    expect(resumed.pending[0].input).toEqual({ path: "b.md", content: "y" });
  });

  it("空日志还原成空会话（不是报错）", () => {
    expect(resumeSession([])).toEqual({ turns: [], pending: [], runningDelegations: [] });
  });
});

describe("快照 · 重放 diff（重构零漂移的验收器）", () => {
  const records = [
    { seq: 1, at: T(1), requestId: "r1", type: "request", provider: "p", model: "m", messages: [{ role: "user", content: "你好" }] },
    { seq: 2, at: T(2), requestId: "r1", type: "text", text: "你好" },
    { seq: 3, at: T(3), requestId: "r1", type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
  ] as unknown as LogRecord[];

  it("⭐ 同一批记录重放：diff 为零", () => {
    const fixture = snapshotOf("chat-1", records, 123);
    expect(diffSnapshot(fixture, snapshotOf("chat-1", fixture.records, fixture.recordedAt))).toEqual({
      equal: true,
      differences: [],
    });
  });

  it("投影变了就报出来，并说清差在第几轮的哪里", () => {
    const fixture = snapshotOf("chat-1", records, 123);
    const tampered = { ...fixture, turns: [{ ...fixture.turns[0]!, view: { ...fixture.turns[0]!.view, text: "改过了" } }] };
    const diff = diffSnapshot(fixture, tampered);
    expect(diff.equal).toBe(false);
    expect(diff.differences.some((d) => d.includes("第 1 轮"))).toBe(true);
  });

  it("轮数对不上也要报（少了一轮是最危险的回归）", () => {
    const fixture = snapshotOf("chat-1", records, 123);
    const missing = { ...fixture, turns: [] };
    const diff = diffSnapshot(fixture, missing);
    expect(diff.equal).toBe(false);
    expect(diff.differences.some((d) => d.includes("轮数"))).toBe(true);
  });
});

/**
 * Phase 7.3：**委派进度**（团队进展要能从日志还原）。
 *
 * 这几条的判据都是"可证伪的行为"：started/finished 是不是**一件事的两端**、
 * 被打断的会话能不能看出"谁当时在跑"。
 */
describe("delegation · 委派进度", () => {
  const at = (n: number, e: Record<string, unknown>) => ({ seq: n, at: T(n), type: "delegation", requestId: "r1", ...e }) as unknown as LogRecord;

  it("⭐ started 与 finished 是**一件事的两端**（就地更新，不是追加两条）", () => {
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [] },
      at(2, { delegationId: "d1", agent: "researcher", task: "查一下", status: "started" }),
      at(3, { delegationId: "d1", agent: "researcher", task: "查一下", status: "finished", ok: true, summary: "查到了", steps: 3 }),
    ] as unknown as LogRecord[];
    const view = projectTurn(records);
    expect(view.delegations).toHaveLength(1);
    expect(view.delegations?.[0]).toMatchObject({ agent: "researcher", status: "finished", ok: true, summary: "查到了" });
  });

  it("⭐ 被打断的会话里，那个还在跑的委派看得出来（不能只体现在最终报告里）", () => {
    // 两个专家：一个跑完了，一个还在跑就被停掉了
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [] },
      at(2, { delegationId: "d1", agent: "researcher", task: "甲", status: "started" }),
      at(3, { delegationId: "d2", agent: "writer", task: "乙", status: "started" }),
      at(4, { delegationId: "d1", agent: "researcher", task: "甲", status: "finished", ok: true, summary: "好了" }),
      { seq: 5, at: T(5), requestId: "r1", type: "error", message: "已中止" },
    ] as unknown as LogRecord[];

    const resumed = resumeSession(records);
    expect(resumed.runningDelegations).toHaveLength(1);
    expect(resumed.runningDelegations[0]).toMatchObject({ agent: "writer", task: "乙" });
  });

  it("多个专家的进度都留着（并行时不会互相覆盖）", () => {
    const records = [
      { seq: 1, at: T(1), type: "request", requestId: "r1", provider: "p", model: "m", messages: [] },
      at(2, { delegationId: "d1", agent: "a", task: "1", status: "started" }),
      at(3, { delegationId: "d2", agent: "b", task: "2", status: "started" }),
      at(4, { delegationId: "d3", agent: "c", task: "3", status: "started" }),
    ] as unknown as LogRecord[];
    const view = projectTurn(records);
    expect(view.delegations?.map((d) => d.agent)).toEqual(["a", "b", "c"]);
  });

  it("一条委派都没有时不出现这个字段（与 usage 同一个口径：没有 ≠ 空数组）", () => {
    expect(projectTurn([ev({ type: "done" })]).delegations).toBeUndefined();
  });

  it("坏记录只跳过它自己：delegation 缺 agent 就整行不算数（不凭空造一条）", () => {
    const { records, skipped } = parseLog(MINIMAL_DELEGATION_LINES);
    expect(skipped).toBe(1);
    expect(records).toHaveLength(1);
  });
});

const MINIMAL_DELEGATION_LINES = `${JSON.stringify({ seq: 1, at: 1, requestId: "r1", type: "delegation", delegationId: "d1", agent: "a", task: "t", status: "started" })}
${JSON.stringify({ seq: 2, at: 2, requestId: "r1", type: "delegation", delegationId: "d2", task: "没有 agent", status: "started" })}
`;
