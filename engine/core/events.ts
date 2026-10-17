import {
  SPAWN_AGENT_TOOL,
  blockedToTraces,
  describeToolResult,
  type ToolTrace,
} from "../../shared/agentTools";
import type { AiStreamEvent } from "../../shared/ipc";
import { pendingGates } from "./gates";

/**
 * 会话事件日志 + **一轮对话的投影**（C2）。
 *
 * ## 这一层解决的是什么
 *
 * 原来"主进程发事件 → 渲染层各解析一遍"被实现了 **四遍**：工作台 `store.ts`、
 * 聊天 `chatStore.ts`、悬浮助手 `FloatingAssistant.tsx`，加上主进程自己构造事件那一处。
 * 四份代码要同时答对同一批问题：工具调用的**参数**怎么与结果配对、
 * 哪一条是"等你确认"（**没执行**）、界面那一行怎么写、用量从哪来。
 * 于是它们**慢慢答得不一样**（实测：工作台不接 `usage`、聊天不展开子智能体上交的调用）。
 *
 * 现在这些答案只有一份：**`applyEvent`**。
 * 它同时是"流式增量"与"日志投影"——
 *
 * ```
 * projectTurn(events)  =  finishTurn(events.reduce(applyEvent, emptyTurn()))
 * 流式那一侧           =  每来一条事件就 applyEvent 一次（同一个函数）
 * ```
 *
 * 同一条路算出来的东西，不可能两边不一致。
 *
 * ## 硬不变量（C2 的验收核心，原本记在 `docs/PLAN-C2-Agent运行时收敛.md`）
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 *
 * - **INV-1**：模型这一轮看见的内容必须能从会话日志重建 —— 所以日志记的是
 *   **事件本身**（含 `usage`、含工具的参数与输出），不是"渲染后的样子"。
 * - **INV-2**：同一段日志投影出来的东西，两条路径必须相同 —— 由本文件保证（只有一份实现）。
 * - **INV-3**：被拦下的动作要能从日志看出"它当时被拦了" —— `pending` 是投影里的一等字段。
 *
 * ⚠️ **本文件是纯逻辑**（不 import fs/electron）：主进程与渲染进程都 import 它，
 * 所以它必须能在 `pnpm test` 里被直接断言。
 */

/** 日志里的一条：流事件 + 它在会话里的位置。 */
export type LoggedEvent = AiStreamEvent & {
  /** 会话内单调递增（从 1 开始）。日志乱序/缺行时能自证。 */
  seq: number;
  /** 落日志的时刻（epoch ms）。 */
  at: number;
  /**
   * 谁写下的（C5）。**可选**是刻意的（V5 §1 的"身份向后兼容"不变量：
   * 新增字段带默认值，旧写入方零迁移成本）；读回来一定在（`parseLogLine` 填）。 */
  actor?: Actor;
};

/**
 * 日志的**首行**：这一轮**模型实际看见的东西**。
 *
 * ## 为什么必须记它（INV-1 的落点）
 *
 * "模型看见的内容必须能从会话日志重建"——只记事件流是**不够**的：
 * 事件只说"模型回了什么、调了什么工具"，不说它**当时看着什么**回的
 * （系统提示词里有没有长期记忆？历史里那几条被折成了什么样？用的是哪个模型？）。
 * 而这些恰恰是事后最需要回答的问题（"它为什么不知道我早说过"）。
 *
 * ## 如实说明两点
 *
 * 1. **这是"记录"而不是"重建"**：请求原样落盘，所以此刻它当然可查。
 *    C3（上下文窗口单一负责人）/ C2-4（装配收敛）完成之后，装配变成
 *    **由日志可推导**的纯函数，那时这一行可以退化成"只记输入"
 *    （记忆库快照、人设 id）——在没有那一步之前**不许假装它已经能重建**。
 * 2. **历史会在每一轮重复落盘**（第 N 轮的请求里带着前 N-1 轮），
 *    所以单个会话的日志体积是**平方级**增长。本机版几十轮的量级（几百 KB）可接受；
 *    真到要瘦身时应当由 C3 统一决定（它管上下文，也就该管这份记录）。
 */
export type TurnRequest = {
  requestId: string;
  seq: number;
  at: number;
  type: "request";
  /** 谁发起的这一轮（C5；缺省读回 `legacy`，见 `actorOf`）。 */
  actor?: Actor;
  provider: string;
  model: string;
  /** 模型看见的 system（**原样**，主进程不加工）。 */
  system?: string;
  /** 模型看见的消息（旧 → 新）。 */
  messages: { role: string; content: string }[];
  toolPolicy?: string;
  useTools?: boolean;
  /**
   * 这一轮**下发给模型的工具名**（2026-10-14 补）。
   *
   * 只有 `useTools: true` 是看不出"够得着什么"的：新加的工具有没有真的下发、
   * 某个档位下是不是被隐藏了，事后都得靠复现。
   * 记下来之后这两类问题一条日志就能回答（也让"注入正确"可断言）。
   */
  tools?: string[];
};


/**
 * **是谁写下了这条记录**（C5）—— 形状与四种 kind 的取舍在 `./actor.ts`（拆出去的理由也写在那儿：
 * 本文件顶着巨石守卫的天花板，而 actor 的取舍值几十行注释）。
 *
 * 这里 import + 转发（既有 import 一律不变）：`events.ts` 仍是记录形状的公开面。
 */
import { normalizeActor, type Actor } from "./actor";
export { actorOf, normalizeActor, LEGACY_ACTOR, LOCAL_USER, MAIN_AGENT, SYSTEM_ACTOR, type Actor, type ActorKind } from "./actor";

/*
 * 两条审批记录（决策 / 授权）与它们的收窄函数也搬出去了（同一套理由：本文件顶着
 * 巨石守卫的天花板）。**两型原样 re-export** —— 既有 import 一律不变，
 * 契约面（`record.approval.keys` / `record.approval-grant.keys`）读的就是它们。
 */
import {
  normalizeApprovalGrantRecord,
  normalizeApprovalRecord,
  type ApprovalGrantRecord,
  type ApprovalRecord,
} from "./records/approvals";
export type { ApprovalGrantRecord, ApprovalRecord } from "./records/approvals";


/** 日志里可能出现的一条记录。 */
export type LogRecord = LoggedEvent | TurnRequest | ApprovalRecord | ApprovalGrantRecord;

/**
 * 会话 id 的前缀：**会话日志要能分清"这是哪条路写下来的"**。
 *
 * 为什么需要：F3 要让聊天历史从日志恢复，就得**列出**聊天会话 ——
 * 而工作台任务也往同一个目录写日志。没有前缀时，"列出来的是聊天还是任务"只能靠猜。
 *
 * ⚠️ 加前缀之前的旧日志（`c1.jsonl` / `tmv….jsonl`）不会被列出来。
 * 它们是 C2 当天写的、只用于排错，**不当作数据迁移**（要说的话：旧日志不参与恢复）。
 */
export const SESSION_PREFIX = { chat: "chat-", task: "task-", cli: "cli-" } as const;

/** 聊天会话的日志 id（由对话 id 得到）。 */
export function chatSessionId(conversationId: string): string {
  return `${SESSION_PREFIX.chat}${conversationId}`;
}

/** 工作台任务会话的日志 id（由任务 id 得到）。 */
export function taskSessionId(taskId: string): string {
  return `${SESSION_PREFIX.task}${taskId}`;
}

/**
 * CLI 会话的日志 id（Phase 2）。
 *
 * 单独一类而不是蹭 `task-`：`ding run` 与工作台任务是**两件不同的事**，
 * 混在一个前缀里之后，"列出来的这些到底是 CLI 跑的还是界面里点的"就只能靠猜。
 */
export function cliSessionId(runId: string): string {
  return `${SESSION_PREFIX.cli}${runId}`;
}

/** 一条日志 id 是不是聊天会话（列会话时用）。 */
export function isChatSessionId(sessionId: string): boolean {
  return sessionId.startsWith(SESSION_PREFIX.chat);
}

/**
 * 从聊天会话的日志 id 反推对话 id（恢复历史时用）。
 *
 * @param sessionId 日志 id
 * @returns 对话 id；不是聊天会话就给空串
 */
export function conversationIdOf(sessionId: string): string {
  return isChatSessionId(sessionId) ? sessionId.slice(SESSION_PREFIX.chat.length) : "";
}

/**
 * 投影的输入：日志里的记录、**还没落盘的**记录（缺 `seq`/`at`），或裸的流事件。
 *
 * 后两者是流式那一侧用的（事件先到界面、日志在同一个出口处顺手记）：
 * 同一个 `applyEvent` 两边都吃，这正是"两边不会算出不同结果"的落点。
 */
export type TurnInput = LogRecord | LogInput | ProjectableEvent | AiStreamEvent;

/**
 * 投影**真正需要**的最小形状：一个判别字段 + 各分支的字段。
 *
 * ⚠️ 刻意**不含 `requestId`**：那个字段是 IPC 归并用的（`aiClient` 按它认自己那次请求），
 * 而主循环（`engine/runtime/loop.ts`）与子智能体压根没有它 ——
 * 若投影要求带上它，两条路就得往事件里塞一个假 id（"为了通过类型检查而编数据"）。
 */
export type ProjectableEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output?: unknown; error?: string }
  | { type: "done"; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; message: string }
  /*
   * 一次委派的进度（Phase 7.3）：**不忽略** —— 它是团队进展的唯一记录。
   * 形状与 `AiStreamEvent` 里那条一致，只是不带 `requestId`（与其余流事件同理）。
   */
  | {
      type: "delegation";
      delegationId: string;
      agent: string;
      task: string;
      status: "started" | "finished";
      ok?: boolean;
      summary?: string;
      steps?: number;
      error?: string;
    }
  /*
   * 「一步结束了」：投影**忽略**它（它不改变正文/工具/用量，只用来数步数）。
   * 列在这里是为了让主循环（`runTurn`）的事件能**直接**喂进投影，不必到处 cast。
   */
  | { type: "step-finish" };

/**
 * 落盘前的记录：还没分配 `seq`/`at`。
 *
 * ⚠️ **必须用分配式 `Omit`**：`Omit<联合类型, K>` 只会留下各成员的**公共字段**，
 * 于是 `text` / `toolCallId` 这些都会被抹掉，调用方传什么都报"属性不存在"。
 * 这是 TypeScript 的既有行为（不是这里写错了），所以显式展开一遍联合。
 */
export type LogInput = LogRecord extends infer T ? (T extends LogRecord ? Omit<T, "seq" | "at"> : never) : never;

/**
 * 一轮对话的投影（**可显示/可落库的成品**）。
 *
 * 这是"这一轮发生了什么"的**唯一**说法：正文、工具、用量、成败。
 * 两条界面路径都从这个对象取值，不再各自解析事件流。
 */
/** 投影里的一条委派（团队进展的一行）。 */
export type DelegationView = {
  delegationId: string;
  agent: string;
  task: string;
  /** `started` = 还在跑；`finished` = 有结论了（成功或失败）。 */
  status: "started" | "finished";
  ok?: boolean;
  summary?: string;
  steps?: number;
  error?: string;
  /** 开始时刻（epoch ms）；有它才能看出"跑了多久"。 */
  at: number;
};

export type TurnView = {
  /** 正文（原样累积，**含产物标签** —— 提取成卡片是界面的事，不属于"发生过什么"）。 */
  text: string;
  /** 工具调用的留痕（按发生顺序；`pending` 就是"被拦下了、还没执行"）。 */
  traces: ToolTrace[];
  /**
   * 这一轮派出去的活（Phase 7.3）。
   *
   * ⚠️ **它是"任意时刻的团队进展"**：`started` 的那条会一直在，
   * 直到收到配对的 `finished`。所以**中途重放**（被打断的会话）也能看出
   * "哪几个专家当时在跑" —— 这正是把它做成独立事件而不是塞进工具结果的理由。
   */
  delegations?: DelegationView[];
  /** 真实用量（provider 给的；拿不到就是 undefined —— **不编**）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** 这一轮以错误收尾时的那句话（含"已中止"）。 */
  error?: string;
  /** 收到 `done`（或 `error`）—— 这一轮已经结束。 */
  done: boolean;
};

/**
 * 累积中的状态 = 成品 + **还没配对的调用**。
 *
 * ⚠️ 为什么要把"只有调用、还没结果"的那些单独放（而不是混进 `traces`）：
 * 一次工具调用是**两条事件**（`tool-call` 带参数、`tool-result` 带结果）。
 * 混进 `traces` 的话，流式途中界面上会闪出一条**空行**的留痕，
 * 而且每个调用方都得记得"显示前先过滤没结果的" —— 那是等着被漏掉的设计。
 * 放在这里之后，`traces` 永远是可显示的，不用谁记得。
 */
export type TurnState = TurnView & {
  /** 内部：等结果的调用（配对完就移出）。 */
  waiting: { toolCallId: string; name: string; input?: unknown }[];
  /** 内部：委派进度（按 `delegationId` 就地更新，不重复追加）。 */
  delegations: DelegationView[];
  /**
   * 内部：这一轮里出现过的**决策记录**（谁批的、批成什么样）。
   *
   * ⚠️ 为什么要留一份（审计 P51）：`traces` 只是"父级手上有的留痕"，
   * 而**展开的子智能体待批项**（`finishTurn` 的 `expandBlocked`）要到收尾时才挂上去 ——
   * 于是"给那条待批项的批准记录"在 `traces` 里**找不到对应留痕**，
   * 原来那一支会直接把它当"日志被截过"忽略掉。后果：重放时那条留痕**永远停在
   * 「等你确认」**（用户明明点过），并且它继续占着 `pending` 名单 —— INV-3/INV-2 同时破。
   *
   * 所以决策记录一律留住，由 `finishTurn` 在**展开之后**再套一遍
   * （套法只有一份：`withApprovals`，两条路都从那里出）。
   *
   * ⚠️ 类型用 `ApprovalLike`（只要"改留痕要用的那几个字段"）：流式那一侧喂进来的
   * 是**还没落盘**的决策记录（没有 `seq`/`at`），而落盘重放那一侧带 `seq`/`at` ——
   * 两种都要能进来，内部也不需要更多字段。
   */
  approvals: ApprovalLike[];
};

/** 空白的一轮。 */
export function emptyTurn(): TurnState {
  return { text: "", traces: [], done: false, waiting: [], delegations: [], approvals: [] };
}

/**
 * 把一条流事件并进累积状态（**纯函数**：返回新对象，不改入参）。
 *
 * ## 这里做的每一项判断，都是从原来四份实现里收出来的
 *
 * | 判断 | 为什么必须只有一份 |
 * |---|---|
 * | 参数按 `toolCallId` 配对 | 放行时要**原样执行**那份参数；丢了就只能重问用户 |
 * | `pending` = "没执行" | 界面文案、历史折行、放行按钮都以它为准；判错会让用户以为事做完了 |
 * | `line` 由 `describeToolResult` 生成 | 界面那行小字与历史里那行**必须同一句话**（§144 的口径） |
 * | 子智能体上交的调用展开成待批准项 | 工作台做了、聊天没做 —— 那是**同一件事的两个答案**（见 `expandBlocked`） |
 *
 * ⚠️ 非流事件（`request`，见 `TurnRequest`）**原样跳过**：它是"输入记录"，
 * 不是"发生过的事"。拿它当事件用的后果是把它当成一次报错（原来那条"不是 text/done 就当 error"
 * 的兜底就是这么坏的）。
 *
 * @param state 上一步的状态
 * @param event 新事件（或日志里的输入记录）
 * @returns 新状态
 */
export function applyEvent(state: TurnState, event: TurnInput): TurnState {
  if (event.type === "request") return state;

  if (event.type === "text") return { ...state, text: state.text + event.text };

  if (event.type === "tool-call") {
    return {
      ...state,
      waiting: [
        ...state.waiting,
        {
          toolCallId: event.toolCallId,
          name: event.toolName,
          ...(event.input === undefined ? {} : { input: event.input }),
        },
      ],
    };
  }

  if (event.type === "tool-result") {
    const called = state.waiting.find((w) => w.toolCallId === event.toolCallId);
    const ok = !event.error;
    const pending = isPendingOutput(event.output);
    const trace: ToolTrace = {
      toolCallId: event.toolCallId,
      name: event.toolName,
      ok,
      line: describeToolResult(event.toolName, ok, event.output, event.error, called?.input),
      ...(pending ? { pending: true } : {}),
      ...(called?.input === undefined ? {} : { input: called.input }),
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(event.error ? { error: event.error } : {}),
    };
    /*
     * ⭐ **按 `toolCallId` 幂等**：同一个 id 的结果第二次到达时是**替换**，不是再追加一条。
     *
     * 为什么这条必须成立：日志是追加写的，而追加会重试（`retryAsync`）——
     * 一次"写进去一半就失败"之后重试，可能让**同一条事件在日志里出现两次**。
     * 重放这种日志时，用户会看到同一个动作写了两行。按 id 幂等之后，
     * "事件重复"与"动作重复"就分开了：前者被吸收，后者本来就不会发生。
     */
    const seen = state.traces.findIndex((t) => t.toolCallId === event.toolCallId);
    const traces =
      seen >= 0 ? state.traces.map((t, i) => (i === seen ? trace : t)) : [...state.traces, trace];
    return {
      ...state,
      traces,
      // 配对掉了就从等待队列里移出（同一个 id 只配一次）
      waiting: state.waiting.filter((w) => w.toolCallId !== event.toolCallId),
    };
  }

  if (event.type === "done") {
    return { ...state, done: true, ...(event.usage ? { usage: event.usage } : {}) };
  }

  if (event.type === "approval") {
    /*
     * 用户批了/拒了（INV-3）：把那条留痕**就地改成结论**。
     *
     * ⚠️ 这同时是 F3 的关键一步 —— 聊天历史恢复时，"等确认"那条要能回到
     * **它真正的样子**（已批准 → 结果那行；已拒绝 → 你已拒绝），
     * 而不是重启后又冒出一个"允许/拒绝"按钮（用户会以为自己的决定丢了）。
     *
     * ⚠️ 两条都要做（审计 P51）：
     *   ① 就地改（`traces` 里能找到的那条，例如被闸门拦下的普通调用）；
     *   ② **一律记进 `approvals`** —— 展开的子智能体待批项**不在** `traces` 里
     *      （它由 `finishTurn` 在收尾时挂上去），只做①的话这条决策会被静默吞掉。
     *      两条路的结果由 `finishTurn` 收口成同一个（同一个 `withApprovals`）。
     */
    const approvals = [...state.approvals, event];
    const idx = state.traces.findIndex((t) => t.toolCallId === event.toolCallId);
    if (idx < 0) return { ...state, approvals };
    const traces = state.traces.map((t, i) => (i === idx ? resolvedTrace(t, event) : t));
    return { ...state, traces, approvals };
  }

  if (event.type === "delegation") {
    /*
     * 按 `delegationId` **就地更新**（不是追加一条新的）：
     * 同一个专家的 `started` 与 `finished` 是**一件事的两端**，
     * 追加的话界面上会出现"三个专家在跑"+"三个专家跑完了"两组，
     * 而重启重放时更糟 —— 会看到六个。
     */
    const idx = state.delegations.findIndex((d) => d.delegationId === event.delegationId);
    const next: DelegationView = {
      delegationId: event.delegationId,
      agent: event.agent,
      task: event.task,
      status: event.status,
      at: "at" in event && typeof (event as { at?: unknown }).at === "number" ? (event as { at: number }).at : Date.now(),
      ...(event.ok === undefined ? {} : { ok: event.ok }),
      ...(event.summary === undefined ? {} : { summary: event.summary }),
      ...(event.steps === undefined ? {} : { steps: event.steps }),
      ...(event.error === undefined ? {} : { error: event.error }),
    };
    const delegations = idx >= 0 ? state.delegations.map((d, i) => (i === idx ? { ...next, at: d.at } : d)) : [...state.delegations, next];
    return { ...state, delegations };
  }

  /*
   * 授权记录**不改变这一轮的内容**（它改的是"谁能批"），所以投影里显式忽略 ——
   * 写这一支不是多此一举：它把"这是刻意的"写在代码里，而不是靠下面那句兜底
   * （兜底那条注释说的正是"不认识 ≠ 失败"，但**认识的也可以不改内容**）。
   */
  if (event.type === "approval-grant") return state;

  if (event.type === "error") return { ...state, done: true, error: event.message };

  /*
   * ⚠️ **其余类型一律忽略**，不许落进"error"那一支。
   *
   * 这是本项目已经踩过一次的坑（`chatStore.ts` 里那段注释留着记录）：
   * 原来那句兜底是"不是 text / done 就当 error"，于是**加了工具事件之后**，
   * 每次调工具都被记成一次报错。同样的形状会再犯 ——
   * 以后给 `AiStreamEvent` 加一种事件（比如 reasoning），这里若沿用兜底，
   * 用户就会看到"出错了"而其实什么都没坏。
   *
   * 代价是"未知事件被静默忽略"。这是刻意的取舍：**不认识 ≠ 失败**。
   */
  return state;
}

/**
 * 决策记录里"改留痕"要用的那几个字段。
 *
 * ⚠️ 故意**不用** `ApprovalRecord` 整个类型：投影要能吃"还没落盘的决策记录"
 * （流式那一侧 `ApprovalRecord` 一定满足它），内部函数用这个子集就够。
 */
type ApprovalLike = { toolCallId: string; line: string; ok?: boolean; output?: unknown; error?: string };

/**
 * 把"等确认"的那条留痕换成**结论**（用户批了/拒了之后的样子）。
 *
 * ⚠️ `pending` 要**摘掉**（不是置 false）：`pending: false` 与"没有这个字段"
 * 在 `ToolTraceList` 那里是两回事（前者仍算"可处置"的候选）。这也是
 * `normalizeToolTraces` 用 `...(x.pending === true ? …)` 的原因。
 *
 * @param trace 原来那条（`pending: true`）
 * @param record 决策记录
 * @returns 结论留痕
 */
function resolvedTrace(trace: ToolTrace, record: ApprovalLike): ToolTrace {
  const { pending: _pending, ...rest } = trace;
  return {
    ...rest,
    ok: record.ok ?? rest.ok,
    line: record.line,
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.error ? { error: record.error } : {}),
  };
}

/**
 * 把留痕套上决策记录（**同一个 toolCallId 只有一份结论**）。
 *
 * 这是"决策被看见"的唯一收口点：`finishTurn` 拿到的 `traces` 可能包含
 * **展开出来的子智能体待批项**（`expandBlocked`），而 `applyEvent` 那一支
 * 只看得到父级自己的 `traces`（见 `TurnState.approvals` 的说明）——
 * 于是这里必须再套一遍，否则子智能体那条的批准会被静默吞掉（审计 P51）。
 *
 * 幂等：套两次与套一次结果相同（`resolvedTrace` 只是覆盖那几个字段）。
 */
function withApprovals(traces: readonly ToolTrace[], approvals: readonly ApprovalLike[]): ToolTrace[] {
  if (!approvals.length) return [...traces];
  const byId = new Map<string, ApprovalLike>();
  for (const a of approvals) byId.set(a.toolCallId, a); // 同一个 id 出现多次时以最后一条为准
  return traces.map((t) => {
    const record = byId.get(t.toolCallId);
    return record ? resolvedTrace(t, record) : t;
  });
}

/**
 * 这条工具输出是不是"被闸门拦下、**还没执行**"。
 *
 * 判据取自工具执行的返回形状（`electron/ipc/tools.ts` 的 `gated()`）：
 * `{ pending: true, notice }`。**只有 `=== true` 算**，别把别的东西误判成待确认 ——
 * 误判的后果是界面给一个假的"允许"按钮，或者把真待确认的当成已执行。
 *
 * @param output 工具输出
 * @returns 是否待用户确认
 */
export function isPendingOutput(output: unknown): boolean {
  return (output as { pending?: unknown } | null | undefined)?.pending === true;
}

export type ProjectOptions = {
  /**
   * 把子智能体上交的调用展开成**父级上的待批准留痕**（§176）。
   *
   * ⚠️ 这是一个**策略**开关，不是两套逻辑：展开用的 `blockedToTraces` 只有一份。
   * 现状：工作台开、聊天关 —— 那条差异记在 C2 方案的"两条路径差异"清单里
   * （统一它会让聊天多出可放行的按钮，属行为变更，单独决定）。
   */
  expandBlocked?: boolean;
};

/**
 * 收尾：把累积状态变成成品。
 *
 * - 只留在等待队列里的调用**不进 `traces`**（"调了一半"不是发生过的事）；
 * - 按策略展开子智能体上交的调用。
 *
 * 流式那一侧**每次要显示时都调它**（很便宜：一趟 filter），
 * 这样"什么时候显示"不会变成另一处要记的规矩。
 *
 * @param state 累积状态
 * @param opts 见 `ProjectOptions`
 * @returns 可显示/可落库的投影
 */
export function finishTurn(state: TurnState, opts: ProjectOptions = {}): TurnView {
  const { text, traces, usage, error, done, delegations } = state;
  /*
   * ⚠️ 展开与"套决策记录"的**顺序**有意义：先展开（子智能体上交的待批项进场），
   * 再套决策记录 —— 反过来的话，给那些待批项的批准记录会找不到对应留痕（审计 P51）。
   */
  let final: readonly ToolTrace[] = traces;
  if (opts.expandBlocked) {
    const expanded: ToolTrace[] = [];
    for (const trace of traces) {
      expanded.push(trace);
      if (trace.name !== SPAWN_AGENT_TOOL || !trace.ok) continue;
      const report = trace.output as { blocked?: SubagentBlockedLike[] } | undefined;
      expanded.push(...blockedToTraces(report?.blocked));
    }
    final = expanded;
  }
  const base: TurnView = {
    text,
    traces: withApprovals(final, state.approvals),
    done,
    // 一条都没有就不出现这个字段（与 usage 同一个口径：没有 ≠ 空数组）
    ...(delegations.length ? { delegations: [...delegations] } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
  };
  return base;
}

/** `SubagentReport.blocked` 的形状（只取这里用得到的部分，避免多一处强类型耦合）。 */
type SubagentBlockedLike = { toolCallId: string; name: string; input?: unknown };

/**
 * 一段会话的标题（F3：界面上那份会话列表要从日志重建）。
 *
 * 取**第一条 request 里最后一条用户消息**的第一行，截到 `max` 字 ——
 * 与聊天侧"会话标题取第一句话"的口径一致（`chatStore.ts` 里那句
 * `title: trimmed.slice(0, 24)`）。日志里没有用户消息时给空串，由调用方兜底。
 *
 * @param records 会话日志
 * @param max 最多几个字
 * @returns 标题（可能为空）
 */
export function conversationTitle(records: readonly LogRecord[], max = 24): string {
  const first = records.find((r) => r.type === "request") as TurnRequest | undefined;
  const user = [...(first?.messages ?? [])].reverse().find((m) => m.role === "user");
  const text = (user?.content ?? "").trim().split("\n")[0]?.trim() ?? "";
  return text.slice(0, max);
}

/**
 * **state = fold(events)**（不变量 1）。
 *
 * 与 `projectTurn` 的区别只在于**收没收尾**：这里给的是**累积状态**
 * （`TurnState`，里面还留着"只有调用、还没结果"的 `waiting`），
 * 而 `projectTurn` 会再过一遍 `finishTurn` 把它变成可显示的成品。
 *
 * ⚠️ 两者必须都从这一个函数出去。原来是各写一遍 reduce —— 只要有两处，
 * 就会有一天"fold 认某条事件、projectTurn 不认"（本项目在"同一状态两处算"上
 * 栽过的次数已经够多了）。
 *
 * @param records 记录（按发生顺序；`request` 这类输入记录会被 `applyEvent` 跳过）
 * @returns 累积状态
 */
export function fold(records: readonly TurnInput[]): TurnState {
  let state = emptyTurn();
  for (const record of records) state = applyEvent(state, record);
  return state;
}

/**
 * 把一串记录投影成一轮（`fold` + 收尾）。
 *
 * @param records 这一轮的记录（按发生顺序；`request` 记录会被跳过）
 * @param opts 见 `ProjectOptions`
 * @returns 投影
 */
export function projectTurn(records: readonly TurnInput[], opts: ProjectOptions = {}): TurnView {
  return finishTurn(fold(records), opts);
}

/** 一段会话里的一轮：它的**输入**（模型看见了什么）与它的**投影**。 */
export type TurnChunk = {
  /**
   * 这一轮的请求记录。
   *
   * ⚠️ 可能是 `null` —— 日志开头若有"没有 request 的记录"（比如日志被截过头、
   * 或写入顺序被打断），它们会自成一截。**不丢**（那仍然是发生过的事），
   * 但调用方要能看见它没有输入记录。
   */
  request: TurnRequest | null;
  view: TurnView;
};

/**
 * 把整段日志按**轮**切开，每轮给出"输入 + 投影"。
 *
 * ## 为什么需要它（F3）
 *
 * 单轮的投影（`projectTurn`）够界面**边流边显示**用；但"重启之后把聊天历史恢复出来"
 * 需要的是**整段会话**：哪几轮、每轮用户说了什么、模型回了什么、哪些调用被批过。
 * 切分点就是 `request` 记录 —— 它本来就是"一轮的开始"。
 *
 * @param records 会话日志（按 `seq` 顺序）
 * @param opts 见 `ProjectOptions`
 * @returns 按轮切的片段（顺序与日志一致）
 */
export function splitTurns(records: readonly LogRecord[], opts: ProjectOptions = {}): TurnChunk[] {
  const chunks: TurnChunk[] = [];
  /**
   * 每一截的**累积状态**（与 `chunks` 一一对应）。
   *
   * ⚠️ 必须单独留着它，不能每来一条记录就从 `view` 反推（那是我第一版写的，**真踩了**）：
   * `view` 是**成品**，里面没有"等配对的调用"（`finishTurn` 会把它们剔掉）。
   * 从 view 反推 → 下一条 `tool-result` 找不到它那次调用的**参数** →
   * 恢复出来的留痕没有 `input` → 用户重启后点「允许」执行的是**空参数**
   * （实测报错：`Cannot read properties of undefined (reading 'text')`）。
   */
  const states: TurnState[] = [];
  let current = -1;

  /** 把一条记录并进第 i 截。 */
  const feed = (i: number, record: TurnInput): void => {
    states[i] = applyEvent(states[i], record);
    chunks[i].view = finishTurn(states[i], opts);
  };

  /**
   * 决策记录要**回溯**到它对应的那一轮。
   *
   * ⚠️ 这是实测出来的形状：用户看到「等你确认」之后可能想一会儿才点，
   * 那时这一轮早就 `done` 了 —— 于是决策记录落在**下一轮**（甚至更后面）。
   * 只往"当前这一截"里塞的话，重启后那条留痕会**永远停在"等确认"**
   * （用户点过了，界面却又冒出一个按钮）。所以按 `toolCallId` 从后往前找它属于哪一截。
   *
   * @param record 决策记录
   * @returns 是否已落到某一截里
   */
  const feedBack = (record: Extract<TurnInput, { type: "approval" }>): boolean => {
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      if (chunks[i].view.traces.some((t) => t.toolCallId === record.toolCallId)) {
        feed(i, record);
        return true;
      }
    }
    return false;
  };

  /** 开新一截（状态与成品一起建，保证两个数组永远对齐）。 */
  const open = (request: TurnRequest | null): void => {
    chunks.push({ request, view: projectTurn([], opts) });
    states.push(emptyTurn());
    current = chunks.length - 1;
  };

  for (const record of records) {
    if (record.type === "request") {
      open(record);
      continue;
    }
    if (current < 0) open(null);
    // 决策记录先回溯；找不到归属（日志被截过）就按"当前这一截"处理（会被忽略，不凭空造留痕）
    if (record.type === "approval" && feedBack(record)) continue;
    feed(current, record);
  }
  return chunks;
}

/**
 * 一次「被拦下、还没处置」的调用（`resume` 要把它们重新摆到界面上）。
 *
 * ⚠️ 与 `ToolTrace.pending` 的区别：那是**留痕上的一个标记**，这是**待办本身** ——
 * 带上 `input` 是因为放行时要**原样执行**那份参数（参数丢了就只能重问用户一次）。
 */
export type PendingApproval = {
  toolCallId: string;
  name: string;
  input?: unknown;
};

/** 从一整段日志还原出来的会话（`resume` 的纯逻辑那一半）。 */
export type ResumedSession = {
  /** 按轮切的片段（顺序与日志一致）。 */
  turns: TurnChunk[];
  /** 还没处置的待确认调用（重启之后要重新摆到界面上，别让用户以为自己的决定丢了）。 */
  pending: PendingApproval[];
  /**
   * **还在跑、没等到结论的委派**（Phase 7.3）。
   *
   * 重启之后这些不会自己接着跑（进程没了），但它们**必须被看见** ——
   * 否则用户会以为"那三个专家还在干活"，或者反过来"怎么多花了那么多钱却没结果"。
   */
  runningDelegations: DelegationView[];
  /**
   * **归属校验没过**（C1，V5-1 3.5）：这段会话是别人的，所以上面三个字段都是空的。
   *
   * ⚠️ 为什么要有这个字段而不是"回空对象就完事"：空会话与"不是你的"在界面上
   * 该说不一样的话 —— 前者是"这段历史是空的"，后者是"没有可给你的内容"。
   * 存储那一层已经把内容拦住了（`load(..., {owner})`），这里只是把它**如实标出来**。
   */
  denied?: "owner";
};

/**
 * **从日志还原会话**（`resume` 的纯逻辑那一半 —— 读盘那一半在引擎里）。
 *
 * ## 它替代了什么
 *
 * 原来是"从日志**翻译**回消息列表"：渲染层拿一堆记录自己拼，拼出来的东西与
 * 日志里的真相可以不一致（谁也没法证明它俩相等）。
 * 现在没有任何"翻译"：`splitTurns` 就是日志本身的形状，界面显示的就是它。
 *
 * ⚠️ `pending` 是从**收尾后**的留痕里挑的 —— 因为决策记录会**回溯**应用到它对应的
 * 那一轮（用户可能在那轮结束很久之后才点允许），所以已经批过的那条**不再是 pending**。
 * 从原始事件流里挑会挑出一堆"其实早就批过"的假待办。
 *
 * @param records 整段会话日志（按 `seq` 升序）
 * @param opts 见 `ProjectOptions`
 * @returns 按轮切片 + 待确认清单
 */
export function resumeSession(records: readonly LogRecord[], opts: ProjectOptions = {}): ResumedSession {
  const turns = splitTurns(records, opts);
  /*
   * ⚠️ 待办清单由 `engine/core/gates.ts` 挑（那里是这个语义的负责人）。
   * 这里原来自己写了一段 for —— 而"审批闸门的语义"只能有一处，
   * 否则界面上的待办与本函数还原出来的清单会慢慢分叉。
   */
  const runningDelegations: DelegationView[] = [];
  for (const chunk of turns) {
    for (const d of chunk.view.delegations ?? []) {
      if (d.status === "started") runningDelegations.push(d);
    }
  }
  return { turns, pending: pendingGates(turns), runningDelegations };
}

/* ────────────────────── 落盘：一行一条 ────────────────────── */

/**
 * 序列化成**一行**（换行结尾），供 `.jsonl` 追加。
 *
 * 为什么是 jsonl 而不是一个 JSON 数组：日志是**追加写**的。
 * 数组每次都要重写整个文件（越写越慢，而且写到一半崩掉就整段没了）；
 * 一行一条时，**坏掉的只是那一行**。
 *
 * @param record 要落的记录（流事件或输入记录）
 * @param seq 会话内的序号
 * @param at 时刻
 * @returns 一行文本
 */
export function logLine(record: LogInput, seq: number, at: number): string {
  return `${JSON.stringify({ seq, at, ...record })}\n`;
}

/**
 * 把一条记录里的 `actor` 收窄 —— **读兼容的唯一收口**（实现在 `./actor.ts`，
 * 三种情况的口径也写在那儿：老记录 / 形状坏 / 正常）。
 */
/** 解析一行；不合法返回 null（**调用方跳过它，不放弃整段**）。 */
export function parseLogLine(line: string): LogRecord | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.seq !== "number" || typeof o.at !== "number") return null;
  if (typeof o.type !== "string") return null;
  /* actor 只有这一处收窄（读回来的每条记录都带着它；见 normalizeActor 的三条口径） */
  o.actor = normalizeActor(o.actor);
  /*
   * ⚠️ `requestId` 只对**流事件**是必需的（它们要按它归并到某一次请求）。
   * 决策记录（`approval`）可以没有 —— 用户可能在那一轮结束很久之后才点确认，
   * 那时渲染层手里已经没有 requestId 了（见 `ApprovalRecord` 的说明）。
   */
  if (o.type === "request") {
    if (typeof o.requestId !== "string") return null;
    // 输入记录：必须真带着消息数组（不然"模型看见过什么"是空的）
    if (!Array.isArray(o.messages)) return null;
    return o as TurnRequest;
  }
  /* 审批两型（决策 / 授权）的收窄在 `./records/approvals.ts` —— 形状规矩写在那边 */
  if (o.type === "approval") return normalizeApprovalRecord({ ...o });
  if (o.type === "approval-grant") return normalizeApprovalGrantRecord({ ...o });
  if (typeof o.requestId !== "string") return null;
  /*
   * 委派进度：`delegationId` / `agent` / `status` 少一样就不是一条能重放的记录
   * （缺 agent 的那条重放出来会是一个没有名字的专家，比丢掉它更坏）。
   */
  if (o.type === "delegation") {
    if (typeof o.delegationId !== "string" || typeof o.agent !== "string" || typeof o.task !== "string") return null;
    if (o.status !== "started" && o.status !== "finished") return null;
    return o as LoggedEvent;
  }
  const known = ["text", "tool-call", "tool-result", "done", "error"];
  if (!known.includes(o.type)) return null;
  return o as LoggedEvent;
}

/**
 * 解析整段日志。
 *
 * ⚠️ **坏行只跳过它自己**：日志是"发生过什么"的记录，一行写入被打断
 * （断电、强杀进程）不该让整段历史消失。跳过的行数**报出来**，不静默吞。
 *
 * @param text 整个 `.jsonl` 文件的内容
 * @returns 记录（按 `seq` 升序）与坏行数
 */
export function parseLog(text: string): { records: LogRecord[]; skipped: number } {
  const records: LogRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLogLine(line);
    if (parsed) records.push(parsed);
    else skipped += 1;
  }
  records.sort((a, b) => a.seq - b.seq);
  return { records, skipped };
}
