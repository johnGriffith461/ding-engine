import {
  LOCAL_USER,
  MAIN_AGENT,
  resumeSession,
  type Actor,
  type LogInput,
  type LogRecord,
  type ResumedSession,
} from "./core/events";
import { diffSnapshot, snapshotOf, type Snapshot, type SnapshotDiff } from "./core/snapshot";
import type { MemberRole } from "./core/members";
import type { ExecutorContext, ToolExecutor } from "./ports/executor";
import type { HealthStore } from "./ports/health";
import { noopHealth } from "./ports/health";
import { noopHooks, type HooksPort } from "./ports/hooks";
import type { SessionStore } from "./ports/store";
import type { ConfirmMode } from "../shared/ipc";
import {
  buildToolSet,
  createToolRegistry,
  offeredToolNames,
  type ToolEntry,
  type ToolRegistry,
} from "./runtime/registry";
import { envSecret, type SecretPort } from "./ports/secret";
import { runTurn, type TurnEvent } from "./runtime/loop";
import type { ReasoningEffort } from "./runtime/protocols/reasoning";

/**
 * 内核的公开 API（Phase 1 D1 冻结）。
 *
 * ## 这一层的职责只有一件：**把端口和内核装配起来**
 *
 * 在这之前，"跑一轮"这件事的装配散在两个宿主里各写一遍：桌面在
 * `electron/ipc/ai.ts`（建工具集、写会话日志、补 requestId、记 provider 健康、
 * 合批发事件），CLI 则根本没有。于是"引擎"只是几个能被 import 的函数 ——
 * 谁的装配漏了一步，谁的 agent 就少一样能力（子智能体点停不停那件事就是这么来的）。
 *
 * 现在装配只有一份：**宿主给端口，内核给行为**。
 *
 * ```
 * const engine = createEngine({ store, executor, health });
 * const out = await engine.run({ sessionId, provider, messages, mode: "按需确认" });
 * ```
 *
 * ## 三条不变量在这份文件里的落点
 *
 * | 不变量 | 落点 |
 * |---|---|
 * | 状态 = fold(events) | `resume()`：读记录 → `resumeSession` 投影，**没有第二份"翻译回消息列表"** |
 * | 日志即真相 | `run()` 里**发事件与记日志同一个出口**（`record()`） |
 * | 错误即结果 | `run()` 不因为工具失败/未知工具/闸门拦截而中断 —— 那些都是 tool result |
 */

/** 宿主提供给内核的东西（四个，缺一不可，只有 health 可以省）。 */
export type EnginePorts = {
  /** 会话事件的持久化。 */
  store: SessionStore;
  /** 工具执行体（宿主绑定真实工具）。 */
  executor: ToolExecutor;
  /** provider 健康账本（省略 = 不记）。 */
  health?: HealthStore;
  /**
   * **凭据解析**（V5-4 4.1）：`keyRef` → 明文密钥。
   *
   * 省略 = 只读环境变量（`envSecret`）—— **那是不碰文件系统的那一半**，
   * 也正是最小嵌入面（`ding-engine-core`）的全部能力。
   * CLI / 桌面注入 `runtime/credentials.ts` 的 `resolveSecret`：
   * 多出来的来源是凭据库与桌面加密库（要 fs / safeStorage，那是宿主的事）。
   */
  secret?: SecretPort;
  /**
   * **插件钩子**（V5-4 4.1）：`session:start` / `tool:before` / `tool:after` / `turn:end`。
   *
   * 省略 = 没有钩子（`noopHooks`）。装插件要读盘、要跑外部代码 —— 那是宿主的事；
   * Node 宿主注入 `runtime/pluginHost.ts` 的 `pluginHooks`。
   */
  hooks?: HooksPort;
  /** 额外的工具来源（MCP 工具 / Phase 8 的插件工具）。 */
  tools?: readonly ToolEntry[];
  /** 只要内置里的这些（宿主能力不同：CLI 登记不了落到桌面界面 store 上的工具）。省略 = 全部。 */
  include?: readonly string[];
};

/** 跑一轮的请求。 */
export type EngineRunRequest = {
  /**
   * 这一轮属于哪段会话（宿主决定：工作台给任务 id、聊天给对话 id）。
   *
   * ⚠️ **可以不给** —— 起标题、翻译这类附带请求不是 agent 回合，
   * 记进去只会让日志里多出一堆无主的请求（既有产品语义就是这样）。
   * 不给 = 这一轮**不入库**：没有日志、没有账本，但照样跑。
   */
  sessionId?: string;
  provider: string;
  model?: string;
  system?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /**
   * **这一轮之前的对话历史**（可选，2026-10-16，审计 P127）。
   *
   * 存在的理由：`ding resume <id> --continue` 承诺"接着跑完、新一轮看得见上次做到哪"，
   * 而原来 `run()` 收的只有一条 user 消息、**也不读 `ports.store.load(...)`** ——
   * 所谓"继续"就是**没有任何历史的凭空重跑**（同一句话再问一遍，模型当然从头来）。
   * 现在宿主可以把还原出来的历史交进来，它排在 `messages` 前面，
   * 并且**一起进 `request` 记录**（不变量 1：记下来的就是模型真看见的）。
   *
   * ⚠️ 只收"已经完成"的历史。被打断那一轮的半截输出**不在这里** ——
   * 那是宿主的事（`cmdResume` 会如实说明带了什么、没带什么）。
   */
  history?: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  /** 思考强度（见 ）：不给 = 不发，与以前完全一致。 */
  reasoningEffort?: ReasoningEffort;
  /** 闸门档位。 */
  mode: ConfirmMode;
  /** 给不给工具（起标题、翻译这类附带请求不给 —— 它们拿到工具会真的动手）。 */
  useTools?: boolean;
  /**
   * 只要这些工具（**角色白名单**，可选；2026-10-16，审计 P126）。
   *
   * 与 `buildToolSet` / `offeredToolNames` 的 `only` 是同一个口径（一套东西一个词）。
   * 谁在用：`ding recipe run` —— 模板 JSON 里声明了 `tools`，而那条白名单
   * **原来一行都没接**（只出现在 `recipe show` 的文案里），于是"第二层防护"是自述。
   * 省略 = 不限制（主对话就是这样）。
   */
  only?: readonly string[];
  /** 步数上限（父 4 / 子 6 是各自的经验值，作为参数传进来）。 */
  maxSteps?: number;
  /**
   * **谁发起的这一轮**（C5，2026-10-17）。
   *
   * 缺省 = `LOCAL_USER`（本机单用户）。它是 `request` 记录的 actor；
   * 这一轮里 agent 写的事件一律标 `MAIN_AGENT` —— 两种标注都由内核在**记录出口那一处**
   * 统一做（每个 emit 点各标一次迟早会漏，见 `run()` 里 `record` 的说明）。
   *
   * ⚠️ 与 C1 的"会话归属"是**两回事**（V5-1 3.5 会给 `ownerActor`）：
   * 这里是"这一句谁说的"，那里是"这段会话归谁"。
   */
  actor?: Actor;
  /**
   * **这段会话归谁**（C1，V5-1 3.5 加）。
   *
   * 只在**新建**会话那一刻生效（归属是创建时的事实，之后不再改）；
   * 已有会话的归属与这里不同时，`append` 会拒绝并抛错（宿主把它当"这一轮落不了盘"报）。
   *
   * 缺省 = 不声明归属（存储按兼容口径落 `local`）—— 老宿主/老调用方零迁移成本。
   * V5-2/3 的成员身份接上来之后，宿主会把真实成员传进来。
   */
  ownerActor?: Actor;
  /**
   * **发起人的角色**（C2，V5-1 3.6b）：人轴那一侧，与工具档位叠加判工具调用。
   *
   * 缺省 = 不声明（本机单用户）→ 按 **owner** 处理（老路径一字不变）。
   * 判定规则与矩阵在 `engine/core/policy.ts` 的 `decideForMember` / ADR-007；
   * ⚠️ V5-2 把成员 token 映射接上之后，"未认证/查不到"一律按 **viewer**（安全默认）。
   */
  memberRoles?: readonly MemberRole[];
  abortSignal?: AbortSignal;
  /**
   * 宿主的**上屏出口**（可选，同步调用，与 `runTurn` 的 `onEvent` 同一个位置）。
   *
   * ⚠️ 有了它内核**照样自己落盘**：这个出口只用来"边跑边显示"，
   * 不是日志的第二份来源。两者出自同一个 emit 点，所以界面上看到的
   * 与日志里记的**顺序与内容一致**（这正是 C2 收敛时定下的口径）。
   */
  onEvent?: (event: TurnEvent) => void;
  /**
   * **上游报错原文**的出口（诊断用，可选；2026-10-16）。
   *
   * 界面不要用它 —— 那是 `onEvent` 里那句人话的事。它给的是
   * "要做判定的装置"（评测/验收脚本）：只有原文里才有 `ETIMEDOUT 127.0.0.1:58855`
   * 这种能分辨"产品坏了"与"本机那会儿回环不通"的信息。见 `TurnRequestInput.onRawError`。
   */
  onRawError?: (raw: string) => void;
};

/** 一轮的结局。 */
export type EngineRunResult = {
  ok: boolean;
  error?: string;
  aborted: boolean;
  provider: string;
  model: string;
  /** 这一轮吐出的事件（宿主拿去上屏；快照设施拿去落 fixture）。 */
  events: TurnEvent[];
  /** 这一轮落盘的记录（含首行 `request`）。 */
  records: LogRecord[];
  /** 这一次请求的 id（宿主按它归并流片段）。 */
  requestId: string;
  /**
   * 落盘失败的原因（**一条都不许静默丢**，2026-10-16，审计 P38）。
   *
   * 原来 `void record(...)` 的拒绝没人接：桌面侧 `unhandledRejection` 只写 boot.log
   * （= 静默丢记录，直接违反文件头那条 INV-1「日志即真相」），CLI 侧没有 handler，
   * Node 默认把进程打死。现在拒绝被接住、原因带回给宿主，且**不把整轮判失败**
   * （记录写不进去是"记录"的事，不是这一轮的事）。
   */
  recordErrors?: string[];
};

export type Engine = {
  /** 跑一轮，并把这一轮完整记进会话日志。 */
  run(request: EngineRunRequest): Promise<EngineRunResult>;
  /**
   * 从日志还原一段会话（重启之后把界面恢复到"那一刻的样子"）。
   *
   * @param sessionId 会话 id
   * @param opts.owner 归属校验（C1）：给了而与这段会话的 owner 不同 → 返回**空会话**
   *   并置 `denied: "owner"`（不返回任何内容，也不说"它存在但不是你的"）
   */
  resume(sessionId: string, opts?: { owner?: string }): Promise<ResumedSession>;
  /** 重放一份快照并与它自己录下来的投影 diff（快照验收的执行器）。 */
  replay(fixture: Snapshot): Promise<SnapshotDiff>;
  /** 录一份快照（把一段会话的记录与投影一起存下来）。 */
  record(sessionId: string): Promise<Snapshot | null>;
  /** 注册表（`ding models` / 插件页要列工具时用）。 */
  tools: ToolRegistry;
};

/**
 * 建一个引擎。
 *
 * ⚠️ **不在这里读任何全局路径**：数据放哪、密钥从哪来、工具落到哪个目录，
 * 全是宿主给端口时决定的事。这正是"桌面与 CLI 平权"在工程上的含义 ——
 * 内核没有"当前是哪个宿主"这个概念。
 *
 * @param ports 见 `EnginePorts`
 * @returns 引擎
 */
export function createEngine(ports: EnginePorts): Engine {
  const health = ports.health ?? noopHealth;
  /* 两个 IO 端口（V5-4 4.1）：不给 = 保守的默认（环境变量 / 没有钩子）—— 最小面就长这样 */
  const secret = ports.secret ?? envSecret;
  const hooks = ports.hooks ?? noopHooks;
  const registry = createToolRegistry({
    ...(ports.tools ? { extra: ports.tools } : {}),
    ...(ports.include ? { include: ports.include } : {}),
  });

  return {
    tools: registry,

    async run(request: EngineRunRequest): Promise<EngineRunResult> {
      const requestId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const records: LogRecord[] = [];
      /** 落盘失败的原因（见 `EngineRunResult.recordErrors`）。 */
      const recordErrors: string[] = [];
      /** 这一轮的发起人（C5）：默认本机用户；V5-2/3 接成员身份时由宿主传真实成员。 */
      const requester: Actor = request.actor ?? LOCAL_USER;

      /**
       * 落一条记录（**发事件与记日志是同一个出口** —— 两处各写一份必然漂移）。
       *
       * ⭐ **拒绝在这里就被接住**（2026-10-16，审计 P38）：调用方一律 `void record(...)`
       * （不等它，免得吐字被磁盘 IO 拖住），而原来那个 Promise 一旦拒绝就是
       * **unhandled rejection** —— 桌面侧被 boot.log 吞掉（静默丢记录），
       * CLI 侧直接按 Node 默认把进程打死。现在：原因记进 `recordErrors`，
       * 本轮照跑（记录写不进去 ≠ 这一轮没发生），宿主拿到原因就能说话。
       */
      const record = async (record: LogInput): Promise<void> => {
        if (!request.sessionId) return; // 不属于任何会话：不入库（见上面 sessionId 的说明）
        try {
          /*
           * ⭐ **谁写下的**（C5，2026-10-17）：`request` 那条 = 发起这一轮的人
           * （默认本机用户）；其余事件 = 主循环这个 agent。标注只在这一处发生 ——
           * 每个 emit 点各标一次的话，迟早有新的 emit 点忘了标（那正是"新写入全带"
           * 会烂掉的方式）。`record.actor` 若已被调用方标过就尊重它（子智能体/宿主自定义）。
           */
          const tagged: LogInput = {
            ...record,
            ...(record.actor ? {} : { actor: record.type === "request" ? requester : MAIN_AGENT }),
          } as LogInput;
          const stored = await ports.store.append(request.sessionId, [tagged], {
            ...(request.ownerActor ? { owner: request.ownerActor.id } : {}),
          });
          records.push(...stored);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          recordErrors.push(why);
          console.error(`[engine] 会话记录落盘失败（不影响本轮，但这段日志缺一条）：${why}`);
        }
      };

      /*
       * 首行：这一轮**模型实际看见了什么**（不变量 1）。
       * `tools` 记的是"够得着什么" —— 只记"用没用工具"事后回答不了
       * "新加的工具到底有没有下发"。
       *
       * ⚠️ 历史与白名单都要照实：`history` 拼进消息（模型真看见了它），
       * `only` 传给 `offeredToolNames`（不然日志会为"下发了全套"作证，而实际只下发了几件）。
       */
      const messages = [...(request.history ?? []), ...request.messages];
      await record({
        requestId,
        type: "request",
        provider: request.provider,
        model: request.model ?? "",
        ...(request.system ? { system: request.system } : {}),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        toolPolicy: request.mode,
        ...(request.useTools ? { useTools: true } : {}),
        tools: request.useTools ? offeredToolNames(registry, request.mode, 0, request.only) : [],
      });

      const events: TurnEvent[] = [];

      // 钩子：会话开始（Phase 8.3）。只看不改，异常不会影响这一轮
      await hooks.run("session:start", { sessionId: request.sessionId, provider: request.provider, model: request.model });

      /*
       * 委派进度（Phase 7.3）：执行体上报 → 内核**记成事件**并转给宿主上屏。
       *
       * ⚠️ 走同一个出口（`record` + `onEvent`）是刻意的：与工具事件、用量、中止一样，
       * "发生了什么"只有一个记录点。不然就会出现"界面上看到三个专家在跑、
       * 日志里一个都没有"这种事后查不出原因的分叉。
       */
      const ctx: ExecutorContext = {
        mode: request.mode,
        provider: request.provider,
        ...(request.model ? { model: request.model } : {}),
        ...(request.abortSignal ? { signal: request.abortSignal } : {}),
        depth: 0,
        /* C3：拦住一次调用时的默认"待谁批" = 这段会话归谁（缺省仍是本机单用户） */
        ...(request.ownerActor ? { owner: request.ownerActor.id } : {}),
        onDelegation: (event) => {
          const turnEvent: TurnEvent = { type: "delegation", ...event };
          events.push(turnEvent);
          request.onEvent?.(turnEvent);
          void record({ requestId, type: "delegation", ...event });
        },
      };
      const outcome = await runTurn(
        {
          provider: request.provider,
          ...(request.model ? { model: request.model } : {}),
          ...(request.system ? { system: request.system } : {}),
          messages,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
          ...(request.onRawError ? { onRawError: request.onRawError } : {}),
          ...(request.useTools
            ? {
                tools: buildToolSet({
                  registry,
                  mode: request.mode,
                  executor: ports.executor,
                  ctx,
                  ...(request.only?.length ? { only: request.only } : {}),
                  /* 人轴（C2）：没声明就不传 —— 判定层按 owner 兜底（老路径） */
                  ...(request.memberRoles?.length ? { memberRoles: request.memberRoles } : {}),
                  /* 钩子端口（V5-4 4.1）：最小面里它是 no-op */
                  hooks,
                }),
                maxSteps: request.maxSteps ?? 4,
              }
            : {}),
        },
        (event) => {
          events.push(event);
          // 先给宿主上屏，再落盘（落盘是排队的，不等它 —— 等它会让吐字被磁盘 IO 拖住）
          request.onEvent?.(event);
          /*
           * ⚠️ `step-finish` **不落盘**：它只用来数步数，不改变正文/工具/用量。
           * 落进去的后果不是"多一条记录"—— 是 `parseLogLine` 不认它，读回时被算成**坏行**，
           * 于是日志里凭空多出一堆"坏行"（把一个空事件记成了数据损坏）。
           */
          if (event.type === "step-finish") return;
          /*
           * ⚠️ 事件是**同步**出口（`runTurn` 的契约），而落盘是异步的。
           * 所以这里排队而不是 await：`runTurn` 内部不能等磁盘 ——
           * 等它会让"模型吐字"被磁盘 IO 拖住。顺序由 store 自己保证（它的 append 是串行的）。
           */
          void record({ requestId, ...event } as LogInput);
        },
        /* 端口往下传（V5-4 4.1）：凭据解析与健康账本都从这一处进来 */
        { health, secret },
      );

      /*
       * 中止：**记一条终止记录，并且把终态事件发给宿主**（2026-10-16，审计 P36）。
       *
       * 原来只 `await record(...)` 补日志 —— **不发事件**，于是宿主（界面/CLI）
       * 看不到这一轮的终态：界面上那个"正在生成"的指示会一直转到下一次交互为止
       * （读日志的人反而能看到"已中止"，两边说的不是一回事）。
       * 两个新宿主各自绕开过这件事（ACP 那边直接读 `outcome.aborted` 自己造 stopReason）——
       * 同一件事补两遍，说明缺的那条就在内核里。
       *
       * ⚠️ 事件仍走**已有的** `error` 类型 + 同一句话：新加一种 TurnEvent 会让
       * `engine/core/events.ts` 的投影不认它（那会变成日志里的"坏行"，见上面 step-finish 的教训）。
       */
      if (outcome.aborted) {
        const abortedEvent: TurnEvent = { type: "error", message: "已中止" };
        events.push(abortedEvent);
        request.onEvent?.(abortedEvent);
        await record({ requestId, type: "error", message: "已中止" });
      }

      await hooks.run("turn:end", { sessionId: request.sessionId, ok: outcome.ok, aborted: outcome.aborted });

      return {
        ok: outcome.ok,
        ...(outcome.error ? { error: outcome.error } : {}),
        aborted: outcome.aborted,
        provider: outcome.provider,
        model: outcome.model,
        events,
        records,
        requestId,
        ...(recordErrors.length ? { recordErrors } : {}),
      };
    },

    async resume(sessionId: string, opts?: { owner?: string }): Promise<ResumedSession> {
      /*
       * C1（V5-1 3.5）：给了 `opts.owner` 就校验归属 —— 陌生 owner **不返回内容**。
       * 存储那一层回 `denied`（不抛错），这里把它翻成"空会话 + 说清原因"：
       * 调用方拿到的不是"这段历史是空的"，而是"没有可给你的内容"。
       */
      const { records, denied } = await ports.store.load(sessionId, { ...(opts?.owner ? { owner: opts.owner } : {}) });
      if (denied === "owner") return { turns: [], pending: [], runningDelegations: [], denied: "owner" };
      return resumeSession(records);
    },

    async record(sessionId: string): Promise<Snapshot | null> {
      const { records } = await ports.store.load(sessionId);
      if (!records.length) return null;
      return snapshotOf(sessionId, records);
    },

    async replay(fixture: Snapshot): Promise<SnapshotDiff> {
      /*
       * 重放 = 拿 fixture 里的**记录**再投影一遍，与被录下来的投影比。
       * 投影是纯函数，所以这一步不碰网络、不碰模型 —— 它证明的是
       * "同样的记录，投影给出的东西一字不差"，也就是重构零漂移。
       */
      return diffSnapshot(fixture, snapshotOf(fixture.sessionId, fixture.records, fixture.recordedAt));
    },
  };
}
