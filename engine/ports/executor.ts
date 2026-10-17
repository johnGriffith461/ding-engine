import type { ConfirmMode } from "../../shared/ipc";

/**
 * 工具执行的端口（Phase 1 D1 冻结）。
 *
 * ## 为什么执行体是端口而不是内核的一部分
 *
 * 内核负责"该不该执行"（策略、闸门、步数），**不负责"怎么执行"**：
 * `write_file` 落到哪个目录、`run_command` 用哪个 shell、`memory_save` 写哪个文件，
 * 全是**宿主的**事 —— 桌面宿主接的是用户授权的目录 + 各 store，
 * CLI 宿主接的是配置里的目录 + 一个纯文件系统实现。
 *
 * 所以内核只认一句话：**给我工具名和参数，我给你一个结果**。
 *
 * ## 结果的形状
 *
 * 与现有 `runToolOnce` 完全一致（`{ ok, output?, error? }`），一个字段都不改 ——
 * 这样"用户点允许后执行"那条既有路径可以原地接上来，不必先把返回值翻译一遍。
 *
 * ⚠️ **失败也是一种结果**（不变量 3，Factor 9）：`ok: false` 不抛异常，
 * 内核把它当一次工具结果回注给模型。执行体的契约是"永远返回一个结果"，
 * 而不是"出错就 throw" —— 抛出来的东西会中断整轮，那正是要防的。
 */
export type ToolResult = {
  ok: boolean;
  /** 给模型看的结果（形状由各工具自己定；投影会用 `describeToolResult` 生成那一行）。 */
  output?: unknown;
  /** 失败原因（一句话，给人看）。 */
  error?: string;
};

/**
 * 一次执行要用到的上下文。
 *
 * ⚠️ 字段与主进程现存的 `ToolEnv` **同名同义**，为的是让桌面宿主那侧
 * 不用写一层翻译（翻译层是"两个形状慢慢分叉"的起点）。
 */
export type ExecutorContext = {
  /** 闸门档位。执行体**不再自己判**（内核判过了），它只是需要知道，例如往下传。 */
  mode: ConfirmMode;
  /** 这一轮的 provider / model（`spawn_agent` 派子智能体时要沿用同一个）。 */
  provider: string;
  model?: string;
  /** 这一轮的中止信号：用户点停时，工具内部（子智能体、跑命令）也得停。 */
  signal?: AbortSignal;
  /** 嵌套深度（防止子智能体再派子智能体）。 */
  depth?: number;
  /**
   * **这段会话归谁的 id**（C3，V5-1 3.7a）：拦住一次调用时，默认的"待谁批"就是它。
   *
   * 缺省 = 本机单用户（判定层用 `DEFAULT_APPROVER` = `local` 兜底）—— 老路径一字不变。
   * 这是**归属**（谁能批这一段会话里的待决），不是"谁在说话"（那是 actor，C5）。
   */
  owner?: string;
  /**
   * 上报**委派进度**（Phase 7.3）。
   *
   * 派活的执行体在"某个专家开始/结束"时调它一次；内核负责把它记成 `delegation` 事件
   * 并转给宿主上屏。执行体自己**不碰**日志与 IPC —— 它只报告"发生了什么"。
   */
  onDelegation?: (event: {
    delegationId: string;
    agent: string;
    task: string;
    status: "started" | "finished";
    ok?: boolean;
    summary?: string;
    steps?: number;
    error?: string;
  }) => void;
};

/**
 * 执行一个工具。
 *
 * ⚠️ **调用它 = 已经过闸门**。"需不需要用户确认"是内核的判定（`engine/core/policy.ts`），
 * 端口这一层不重复判 —— 两处都判的结果是"用户点了允许、还是执行不了"。
 */
export type ToolExecutor = {
  run(name: string, input: unknown, ctx: ExecutorContext): Promise<ToolResult>;
};
