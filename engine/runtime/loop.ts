import { stepCountIs, streamText, type ToolSet } from "ai";

import { blockedReason, realModelBlocked as gateBlocked } from "./modelGate";
import { reasoningProviderOptions, type ReasoningEffort } from "./protocols/reasoning";

import type { StepUsage } from "../../shared/cost";
import type { HealthStore } from "../ports/health";
import { noopHealth } from "../ports/health";
import { envSecret, type SecretPort } from "../ports/secret";
import { getProvider, protocolOf } from "./providers";
import { adapterFor } from "./protocols";
import { humanFailure } from "../../shared/errors";

/**
 * **一份主循环**（C2-3）。
 *
 * ## 它替代了什么
 *
 * 在它之前，"调一次模型、把流读出来"这件事有**两份**实现：
 * `ai.ts:164-196`（IPC 那条，`stepCountIs(4)`）与 `subagent.ts:90-101`
 * （子智能体那条，`stepCountIs(6)`）。两份各自长出了不同的毛病
 * （实测差异清单原本记在 `docs/PLAN-C2-Agent运行时收敛.md` §1.1）：
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 *
 * | 能力 | 父级 | 子级（改造前） |
 * |---|---|---|
 * | `abortSignal`（能中止） | ✅ | ❌ **子智能体点停不停** |
 * | `tool-error` 事件 | ✅ | ❌ 那一支压根没有 |
 * | provider 健康标记 | ✅ | ❌ 跑成功也不记 |
 * | 模型可用性校验 | ✅ 不在清单就退默认 | ❌ 只判真值 |
 * | `usage` | ✅ 回传渲染层 | ⚠️ 只被压成一行文案 |
 *
 * ## 两条路的差别现在只剩**参数**
 *
 * 步数上限（父 4 / 子 6）是**参数**（`maxSteps`），不是两条代码路径；
 * 事件怎么用（转给渲染层 + 落日志 / 自己收集成报告）由 `onEvent` 决定。
 *
 * ⚠️ **参数差异不许被"顺手统一"**：4 与 6 是各自的经验值，统一会改变行为与成本。
 */

/** 这一轮的用量（provider 给的；拿不到就是 undefined —— **不编**）。 */
export type TurnUsage = StepUsage;

/**
 * 卡住看门狗默认多久（毫秒）—— 见 `TurnRequestInput.stallTimeoutMs`。
 *
 * 2 分钟"一块数据都没来"。正常模型首字节远快于此（本机实测个位数秒），
 * 所以不会误杀正常模型；而它正好挡住"连接建了但一块都不吐"这种**没有出口**的等待。
 */
export const STALL_TIMEOUT_DEFAULT_MS = 2 * 60 * 1000;

/** 看门狗触发时那句人话（界面与日志共用同一句）。 */
export function stallMessage(ms: number): string {
  return `provider 超过 ${Math.round(ms / 1000)} 秒没有任何输出（连接卡住了，已中止这一轮）`;
}

/**
 * 循环吐出的事件（**与 `AiStreamEvent` 分开**）。
 *
 * 为什么不让循环直接吐 `AiStreamEvent`：那个类型里有 `requestId`（IPC 归并用），
 * 而子智能体根本没有 requestId。所以这里用**同形但不含 requestId** 的事件，
 * IPC 那条在 `ai.ts` 里补上 requestId —— 那才是"传输"该干的事
 * （`shared/sessionLog.ts` 的 `ProjectableEvent` 就是这个形状，投影直接吃）。
 */
export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; output?: unknown; error?: string }
  /**
   * 一步结束 —— 数步数用，**投影会忽略它**（它不改变内容，所以不落盘）。
   *
   * ⚠️ 从 Phase 13.3 起它还带**这一步的用量与序号**：长回合要能说"现在第几步、已用多少 token"
   * （方案 13.3："长回合进度叙述（当前步骤 / 已用 token / 预估剩余），CLI 与桌面一致"）。
   *
   * 为什么挂在它身上而不是新加一种事件：`step-finish` 本来就在**每一步**发一次，
   * 而它不落盘（见 `engine/index.ts` 的说明）—— 加字段既不会污染日志，
   * 也不会让读日志的人多一条要认识的类型。缺用量时**不编**（没有就是没有）。
   */
  | { type: "step-finish"; step?: number; usage?: TurnUsage }
  | { type: "done"; usage?: TurnUsage }
  | { type: "error"; message: string }
  /**
   * 一次委派的进度（Phase 7.3）。
   *
   * ⚠️ 它**不是** SDK 流里来的 —— 是工具执行体（派活的那个）直接吐给引擎的。
   * 放在同一套事件里，是因为对宿主与投影来说它就是"这一轮里发生的一件事"，
   * 不需要第二条通道（第二条通道 = 第二处要记得记日志的地方）。
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
    };

/** 一次调用的输入。 */
/*
 * ⚠️ 这里**没有** `maxOutputTokens`（C5 裁定）：它原来是"有管道没水源"的 ——
 * 契约里有 `maxTokens`、主进程也接了，但**渲染层从没传过**（`src/` 全仓零命中），
 * 端到端一次都没生效。按手册"要么被用要么被删"，删掉这条管道。
 * **要用的时候再加回来**，并且那时**同时**要有界面上的水源（否则又是一条空管道）。
 * （provider 自己的默认输出上限一直生效，不受这里影响。）
 */
export type TurnRequestInput = {
  provider: string;
  model?: string;
  system?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature?: number;
  /** 工具集；不给就是"不带工具"的一轮（起标题、翻译这类）。 */
  tools?: ToolSet;
  /** 步数上限（父 4 / 子 6 都是这个参数）。 */
  maxSteps?: number;
  /**
   * 思考强度（2026-10-16）：用户明确选的低 / 中 / 高。
   *
   * ⚠️ **不给就是不给**：这一轮不发任何思考相关参数，走各家默认（与以前完全一致）。
   * 给的方式由  按协议翻（三家写法不一样，映射只有那一处）。
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * 中止信号。
   *
   * ⚠️ 子智能体**必须**拿到父级的那个：用户点停时，子智能体还在跑就是"停不下来"。
   */
  abortSignal?: AbortSignal;
  /**
   * **上游报错原文**的出口（诊断用；2026-10-16）。
   *
   * 为什么需要它：给用户看的那句是 `humanError` 翻过的"人话"（`连不上 provider…`），
   * 而原文里才有**可判定的信息**（`connect ETIMEDOUT 127.0.0.1:58855`）。
   * 评测/验收要分辨"产品真的坏了"与"这台机器那一会儿回环不通"，
   * 而人话把这两件事抹成了同一句 —— 于是只能再开一条**只给装置看**的口子。
   *
   * ⚠️ 它**不是给界面用的**：界面继续只吃 `TurnEvent.error.message`（人话）。
   * 谁把它直接糊到用户面前，就是又造了一个"把 SDK 堆栈丢给用户"的问题。
   */
  onRawError?: (raw: string) => void;
  /**
   * **卡住看门狗**：多久没有任何一块流数据就判定"连接卡住了"（毫秒；`0` = 关掉）。
   *
   * 2026-10-16（审计 P37）：原来这一整轮**没有任何整体超时** —— provider 建了连接
   * 但一块都不吐（网络黑洞、上游排队、代理挂住）时，`for await (result.fullStream)`
   * 会一直等下去，界面上那个"正在生成"永远转圈（用户唯一的出路是点停止，
   * 而停止按钮在某些状态里还不一定可用）。
   *
   * 默认 2 分钟没有任何一块：正常模型的首字节远快于此（本机实测个位数秒），
   * 所以这个值不会误杀正常慢模型；真要跑长任务那是"每块之间"的间隔，不是总时长。
   * 测试传小值（打桩 provider 卡住）。
   */
  stallTimeoutMs?: number;
};

/** 一次调用的结果（两条路都能用：IPC 那条主要靠 `onEvent`，子智能体主要靠它）。 */
export type TurnOutcome = {
  ok: boolean;
  /** 失败原因（给人看的一句话）。 */
  error?: string;
  /** 是否被中止（**中止不算失败**：那是用户意图，不该把 provider 判死）。 */
  aborted: boolean;
  /** 真正用的 provider / model（解析后的）。 */
  provider: string;
  model: string;
};

/**
 * 把 provider 的错误翻成给人看的一句话。
 *
 * ⚠️ 这是原来 `ai.ts` 里的 `humanError`：**两条路共用**（子智能体的失败也要说人话，
 * 而不是把 SDK 的原始报错丢给用户）。
 *
 * @param error 抛出来的东西
 * @returns 一句话
 */
export function humanError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "已中止";
  const raw = error instanceof Error ? error.message : String(error);
  /*
   * ⚠️ 话术**不再长在这里**（Phase 13.1）：统一到 `shared/errors.ts`。
   * 之前文本侧与图像侧各写一份，同一个 429 在两边显示不同的话
   * （"触发限流，稍后重试" vs "被限流或额度用完了"）—— 用户看到的是两个产品。
   */
  return humanFailure(raw, { fallbackLimit: 200 });
}

/**
 * 解析"这一轮到底发给谁"：provider 存不存在、有没有密钥、模型名认不认。
 *
 * ⚠️ 单独抽出来是因为两条路都需要它、但**时机不同**：
 * `ai:chat` 必须在**同步返回**里给出 `{provider, model}`（渲染层拿它显示），
 * 而 `runTurn` 是在异步体里才知道。一份实现、两处调用，避免"两处各写一遍模型回落规则"。
 *
 * @param providerId provider id
 * @param model 请求里带的模型名（可选）
 * @returns 解析结果（失败时给一句给人看的话）
 */
/**
 * 「禁止真实模型」这道闸（`DSH_NO_REAL_MODEL`）。
 *
 * ## 为什么它必须真的存在
 *
 * CI 的 workflow 里一直写着这个变量，注释还承诺"万一有人把真调模型的验收加进来，
 * 这个变量会让它们立刻失败而不是悄悄烧钱"—— 而**仓库里没有任何代码读它**。
 * 也就是说那句承诺是空的：闸门画在墙上，门是开的。
 *
 * （实测过代价：跑一条验收脚本 `accept-tools.mjs` 会真的打 provider，
 * 它往输入框里填提示词然后点发送。整批 99 条跑一遍就是 99 次真调用。）
 *
 * ⚠️ 2026-10-16（审计 P53）：判定**搬去 `./modelGate`** —— 原来只有这一条路
 * 问闸，图像/视频/探测四条路都绕开它（开着闸照样真出网，有记账为证）。
 * 现在这里只留调用点，判定与文案在那一份里。
 *
 * @param baseURL provider 的地址
 * @returns 是否该拒
 */
function realModelBlocked(baseURL: string): boolean {
  return gateBlocked(baseURL);
}

export function resolveTurnTarget(
  providerId: string,
  model?: string,
  /**
   * **凭据解析**（V5-4 4.1 端口化）：默认只读环境变量 —— 那是**不碰文件系统**的那一半。
   * 宿主（CLI / 桌面）注入 `runtime/credentials.ts` 的 `resolveSecret` 之后，
   * 凭据库与桌面加密库也一并生效（注入点见 `EnginePorts.secret`）。
   */
  secret: SecretPort = envSecret,
): { ok: true; provider: NonNullable<ReturnType<typeof getProvider>>; model: string } | { ok: false; error: string } {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, error: `未知 provider：${providerId}` };
  if (realModelBlocked(provider.baseURL)) {
    return { ok: false, error: blockedReason(provider.label, provider.baseURL) };
  }
  if (!secret(provider.keyRef)) {
    return { ok: false, error: `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）` };
  }
  const picked = model && provider.models.includes(model) ? model : (provider.models[0] ?? "");
  return { ok: true, provider, model: picked };
}

/**
 * 主循环要用到的**外部能力**（Phase 1 D1：内核不再直接 import 宿主的东西）。
 *
 * ⚠️ 只放"内核不能自己造"的东西：现在只有 provider 健康账本 ——
 * 记到哪儿是宿主的事（桌面写 userData、CLI 单跑不必记、测试给假的）。
 * **可选**是因为它纯属记账，缺了不影响跑一轮；默认 `noopHealth` 而不是 `undefined`，
 * 免得循环里到处 `?.`（那会让"没给"与"不用记"两种意思混在一起）。
 */
export type TurnDeps = {
  health?: HealthStore;
  /**
   * **凭据解析**（V5-4 4.1）：内核不认识"凭据库"这个东西 —— 它只要一个
   * "这个引用名对应的密钥是什么"的函数。默认 `envSecret` 只读环境变量（无 IO），
   * 宿主注入 `resolveSecret` 之后才读凭据库 / 桌面加密库。见 `ports/secret.ts`。
   */
  secret?: SecretPort;
};

/**
 * 步数上限的**兜底换算**（2026-10-16，审计 P49）。
 *
 * `stepCountIs(NaN)` 的判据恒假 —— 上限会**恒不成立**：`ding run --steps` 漏个值，
 * "最多跑几步"这道防失控闸就等于被拆掉了，而表现只是"参数好像没生效"。
 *
 * 校验在 CLI 入口做（坏值报错退出）；这里是**第二道**：非有限值退回默认，
 * 而不是把闸拆掉。`0` / 负值抬到 1（"只跑一步"仍然比"没有闸"安全）。
 *
 * @param raw 宿主给的上限（可能来自命令行/配置，**不可信**）
 * @returns 真正交给 `stepCountIs` 的有限整数
 */
export function effectiveMaxSteps(raw: number | undefined): number {
  if (raw === undefined) return 6;
  if (!Number.isFinite(raw)) return 6;
  return Math.max(1, Math.trunc(raw));
}

/**
 * 跑一轮（**内核里唯一的主循环**）。
 *
 * 它负责：解析 provider/密钥/模型 → 建客户端 → 跑 `streamText` → 把 `fullStream`
 * 翻成 `TurnEvent` → 记 provider 健康 → 收尾时把 `usage` 交给调用方。
 *
 * 调用方负责：事件怎么用（`onEvent`）、以及**给不给工具**（`tools`）。
 *
 * @param input 见 `TurnRequestInput`
 * @param onEvent 每个事件的出口（同步调用；抛异常会中断这一轮）
 * @param deps 见 `TurnDeps`（宿主注入的外部能力）
 * @returns 结局（成败 / 中止 / 真正用的模型）
 */
export async function runTurn(
  input: TurnRequestInput,
  onEvent: (event: TurnEvent) => void,
  deps: TurnDeps = {},
): Promise<TurnOutcome> {
  const health = deps.health ?? noopHealth;
  const secret = deps.secret ?? envSecret;

  /*
   * ⭐ provider / 模型 / 「禁真模型」闸**只有一份判定**：`resolveTurnTarget`。
   *
   * ⚠️ 这里原来自己又写了一遍（getProvider + 查密钥 + 模型回落）。于是上面那句
   * 注释"规则只有一份（resolveTurnTarget），这里用的也是它"**是假的** ——
   * 而代价实测到了：给 `resolveTurnTarget` 加上的防烧钱闸，
   * 通过 `ding run` 走这条路时**完全没生效**，一次真调用照打出去。
   *
   * 被复制一份的判定，就是会被绕过的那一份。
   */
  const target = resolveTurnTarget(input.provider, input.model, secret);
  if (!target.ok) {
    onEvent({ type: "error", message: target.error });
    return { ok: false, error: target.error, aborted: false, provider: input.provider, model: "" };
  }
  const provider = target.provider;
  const model = target.model;

  const apiKey = secret(provider.keyRef);
  if (!apiKey) {
    const message = `${provider.label} 没有可用密钥（需要 ${provider.keyRef}）`;
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted: false, provider: provider.id, model: "" };
  }

  /*
   * ⭐ **卡住看门狗**（2026-10-16，审计 P37，见 `stallTimeoutMs` 的说明）。
   *
   * 做法：给这一轮一个**自己的** `AbortSignal`（用户的中止也接进来），
   * 每收到一块流数据就把定时器往后推；定时器一响就 abort —— 于是那个
   * "永远等不到"的 `for await` 会当场抛出，落进下面的 catch 变成一句人话。
   * 与用户中止分开记（`stalled`）：前者是用户意图（不算 provider 失败），
   * 后者是 provider 的锅（要 markFailed）。
   */
  const stallMs = input.stallTimeoutMs ?? STALL_TIMEOUT_DEFAULT_MS;
  const watchdog = new AbortController();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const armStall = () => {
    if (stallMs <= 0) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      watchdog.abort();
    }, stallMs);
  };
  const stopStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
  };
  const onUserAbort = () => watchdog.abort();
  input.abortSignal?.addEventListener("abort", onUserAbort, { once: true });

  try {
    /*
     * ⭐ **协议只在这里分一次**（Phase 5.2）。
     *
     * 在这之前这一行写死的是 `createOpenAICompatible` —— 想接 Anthropic 原生
     * （哪怕只为了它的 prompt caching）都得改这个函数，而这个函数还管着
     * 事件流、用量、健康记账。
     *
     * 现在：adapter 负责"把话说对"，本函数负责"把流翻成 TurnEvent"。
     * 换协议、换 SDK，**下面那一整段一个字都不用动** —— 这正是 Phase 6 的硬约束。
     */
    const adapter = adapterFor(protocolOf(provider.id));
    const client = adapter.createModel({ baseURL: provider.baseURL, apiKey, model });
    /*
     * 这一轮**真的**花了多久 —— 吞吐量（tok/s）的分母。
     * 量的是"从发请求到 provider 把用量交回来"这一段；界面上那个数因此是实测，不是估的。
     */
    const startedAt = Date.now();
    const result = streamText({
      model: client,
      messages: input.messages,
      ...(input.system ? { system: input.system } : {}),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      /* 思考强度：没选就是 undefined，一个字段都不多发（见 reasoning.ts 的口径） */
      ...(reasoningProviderOptions(protocolOf(provider.id), input.reasoningEffort) === undefined
        ? {}
        : { providerOptions: reasoningProviderOptions(protocolOf(provider.id), input.reasoningEffort) }),
      ...(input.abortSignal || watchdog ? { abortSignal: watchdog.signal } : {}),
      ...(input.tools
        ? { tools: input.tools, stopWhen: stepCountIs(effectiveMaxSteps(input.maxSteps)) }
        : {}),
    });

    /** 到这一步为止发过几次"一步结束"（Phase 13.3：进度叙述要用步号）。 */
    let steps = 0;
    /** 这一轮有没有见过"一步结束"（见下面 `finish-step` 那段）。 */
    let sawStepFinish = false;

    armStall();
    for await (const part of result.fullStream) {
      armStall(); // 每一块都把看门狗往后推（"卡住"= 两块之间太久，不是总时长）
      if (input.abortSignal?.aborted) break;
      if (part.type === "text-delta") {
        onEvent({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "tool-call") {
        onEvent({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        continue;
      }
      if (part.type === "tool-result" || part.type === "tool-error") {
        /*
         * 工具抛错**不中断这一轮**：AI SDK 把它变成 `tool-error`，
         * 我们照样当一次工具结果回注（goose / 12-factor 的口径：错误也是结果）。
         * ⚠️ 子智能体那条原来**没有这一支** —— 于是它的工具报错会被整轮吞掉。
         */
        const failed = part.type === "tool-error";
        onEvent({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          ...(failed
            ? { error: part.error instanceof Error ? part.error.message : String(part.error) }
            : { output: part.output }),
        });
        continue;
      }
      /*
       * ⭐ **一步结束**（2026-10-15 修，Phase 6 的 PoC 逮出来的）。
       *
       * ⚠️ 这里原来认的是 `finish` —— 而 `finish` 是**整轮结束**，不是"一步结束"。
       * 于是 `step-finish` 一次调用只发一次，数出来的步数永远是 1
       * （子智能体的"几步"因此靠 `工具调用数 + 1` 兜底，是个近似值）。
       *
       * AI SDK 的 fullStream 里，**每步**的边界是 `finish-step`（前面配 `start-step`）。
       * 实测：maxSteps=3 的一轮里发了 3 次请求、3 个 `finish-step`、末尾才 1 个 `finish`。
       *
       * `step-finish` 是"数步数用"的事件（投影会忽略它，所以计数修正不影响界面与日志）。
       */
      if (part.type === "finish-step") {
        sawStepFinish = true;
        steps += 1;
        /*
         * 这一步的用量：AI SDK 的 `finish-step` 带 `usage`（与末尾 `finish` 同形）。
         * 拿不到就不带（**不编**）—— 界面上宁可显示"已用 N token（还差这一步）"，
         * 也不要显示一个编出来的数。
         */
        const su = (part as { usage?: StepUsage }).usage;
        onEvent({
          type: "step-finish",
          step: steps,
          ...(su ? { usage: su } : {}),
        });
        continue;
      }
      /*
       * 末尾的 `finish`：**兜底**用 —— 万一某个 provider/SDK 版本不发 `finish-step`，
       * 至少还有一次计数（否则会报 0 步，比多报一步更坏）。
       */
      if (part.type === "finish") {
        if (!sawStepFinish) onEvent({ type: "step-finish" });
        continue;
      }
      if (part.type === "error") throw part.error;
    }

    /*
     * ⭐ 看门狗响了（审计 P37）：**这是失败，不是用户中止** ——
     * provider 那边的连接卡住了，要 markFailed 并在界面说清"没有数据进来"。
     */
    if (stalled) {
      const message = stallMessage(stallMs);
      input.onRawError?.(`no stream data for ${stallMs}ms`);
      health.markFailed(provider.id, message);
      onEvent({ type: "error", message });
      return { ok: false, error: message, aborted: false, provider: provider.id, model };
    }

    if (input.abortSignal?.aborted) {
      // 中止是用户意图：**不判 provider 失败**，也不当作错误结局
      return { ok: true, aborted: true, provider: provider.id, model };
    }

    let usage: TurnUsage | undefined;
    try {
      const final = await result.usage;
      /*
       * ⚠️ 除了输入/输出，还要把 provider 的**缓存明细**带回去（2026-10-14）：
       * AI SDK 给了 `inputTokenDetails.noCacheTokens / cacheReadTokens / cacheWriteTokens`，
       * 而这里**原来只取了两个字段就把对象丢了** —— 于是界面上"缓存命中/缓存读取"永远没有数据，
       * 不是"provider 没给"，是我们没接。缺字段照旧**不编**（有就带上，没有就不带）。
       */
      const d = final.inputTokenDetails;
      usage = {
        inputTokens: final.inputTokens,
        outputTokens: final.outputTokens,
        ...(typeof d?.noCacheTokens === "number" ? { noCacheTokens: d.noCacheTokens } : {}),
        ...(typeof d?.cacheReadTokens === "number" ? { cacheReadTokens: d.cacheReadTokens } : {}),
        ...(typeof d?.cacheWriteTokens === "number" ? { cacheWriteTokens: d.cacheWriteTokens } : {}),
        elapsedMs: Date.now() - startedAt,
      };
    } catch {
      usage = undefined; // 拿不到就不给（**不编**）
    }
    onEvent({ type: "done", ...(usage ? { usage } : {}) });
    // 真的跑通了 —— 把这家 provider 标成"已验证"（界面上才敢说可用）
    health.markOk(provider.id);
    return { ok: true, aborted: false, provider: provider.id, model };
  } catch (error) {
    /*
     * 看门狗触发时 SDK 抛的是 AbortError（是我们自己 abort 的）——
     * 同样要按"provider 卡住"报，不能落进下面那句"已中止"（那会让用户以为是自己点了停止）。
     */
    if (stalled) {
      const message = stallMessage(stallMs);
      input.onRawError?.(`no stream data for ${stallMs}ms`);
      health.markFailed(provider.id, message);
      onEvent({ type: "error", message });
      return { ok: false, error: message, aborted: false, provider: provider.id, model };
    }
    const message = humanError(error);
    /* 原文只喂给装置（见 `TurnRequestInput.onRawError` 的说明） */
    input.onRawError?.(error instanceof Error ? error.message : String(error));
    const aborted = Boolean(input.abortSignal?.aborted);
    if (!aborted) health.markFailed(provider.id, message);
    onEvent({ type: "error", message });
    return { ok: false, error: message, aborted, provider: provider.id, model };
  } finally {
    /* 两种出口（正常/异常）都要收拾定时器与监听，否则长会话里越堆越多 */
    stopStall();
    input.abortSignal?.removeEventListener("abort", onUserAbort);
  }
}
