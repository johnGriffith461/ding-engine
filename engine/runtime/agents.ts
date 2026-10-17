import type { ConfirmMode } from "../../shared/ipc";

/**
 * **agent 定义数据化**（Phase 7.1）。
 *
 * ## 它替代了什么
 *
 * 在此之前，"一个 agent 是什么"是**散在代码里的**：人设写在 `persona` 里、
 * 工具白名单写在提示词里、步数上限写死在 `runTurn` 的调用参数里、闸门档位跟着调用方走。
 * 于是"再加一个专家"这件事没有落点 —— 只能再写一段 if，或者干脆不加。
 *
 * 现在一个 agent 就是一条**声明**：名字、系统提示、能用哪些工具、几步之内、什么档位。
 * 加一个专家 = 加一条记录；它同时出现在 coordinator 的候选名单里、
 * 出现在 CLI 的 `ding agents` 里，也决定了它自己的闸门与步数。
 *
 * ## 三条约束（都是"防呆"，不是防坏）
 *
 * 1. **工具白名单是白名单**：列了就只能用那些。研究员**拿不到** `write_file` ——
 *    不是"提示词劝他别写"，是**工具根本不在他的工具集里**（模型看不到，就不会试）。
 * 2. **档位可以更严，不可以更松**：`mode` 省略 = 沿用调用方（用户的档位）。
 *    写死的档位只能比调用方**更严**（见 `resolveAgentMode`）——
 *    否则就成了"某个 agent 悄悄绕过用户的审批设置"。
 * 3. **步数是自己的**：研究员 8 步、写手 6 步，各自的经验值（与主循环参数同一套口径）。
 */

/** 一个 agent 的声明。 */
export type AgentSpec = {
  /** 标识（注册表键、日志与 `ding agents` 里显示的就是它）。 */
  name: string;
  /** 一句话说明"让他干什么"（coordinator 挑人时看的就是这句）。 */
  description: string;
  /** 系统提示词。 */
  systemPrompt: string;
  /**
   * 工具白名单（**空数组 = 不给工具**；省略 = 全部）。
   *
   * ⚠️ "省略"与"空数组"不是一回事：前者是"不限制"，后者是"什么都不给"。
   * 想造一个只会说话、不会动手的 agent，就得显式写 `tools: []`。
   */
  tools?: readonly string[];
  /**
   * 闸门档位。**只允许比调用方更严**（见 `resolveAgentMode`）。
   */
  mode?: ConfirmMode;
  /** 步数上限。 */
  maxSteps: number;
};

/**
 * 闸门档位按"严格程度"排序（越小越松）。
 *
 * ⚠️ 这是**唯一**一处把三个中文档位排出顺序的地方 —— 别在别处再写一遍比较。
 */
const STRICTNESS: Record<ConfirmMode, number> = {
  全部允许: 0,
  按需确认: 1,
  每步确认: 2,
};

/**
 * 取这个 agent **实际生效**的档位。
 *
 * 规则：**只能更严，不能更松**。
 * - agent 没写档位 → 用调用方的（用户设的）；
 * - agent 写了 → 取两者里**更严**的那个。
 *
 * ⚠️ 为什么不让 agent 放宽：档位是**用户的**设置。一个 agent 若能把
 * "每步确认"降成"全部允许"，那就等于"某个专家悄悄绕过了用户的审批" ——
 * 而用户看不到任何迹象。
 *
 * @param caller 调用方（用户）的档位
 * @param agent agent 自己声明的档位（可省）
 * @returns 实际生效的档位
 */
export function resolveAgentMode(caller: ConfirmMode, agent?: ConfirmMode): ConfirmMode {
  if (!agent) return caller;
  return STRICTNESS[agent] >= STRICTNESS[caller] ? agent : caller;
}

/**
 * 内置 agent（Phase 7.2 的 specialist）。
 *
 * ⚠️ 工具白名单是**按"这个角色该不该碰"**分的，不是按"能不能跑通"分的：
 * 研究员拿不到写盘与跑命令，是因为"查资料"这件事不该改任何东西 ——
 * 这与闸门是**两层**（闸门挡的是用户不批，白名单挡的是角色不该）。
 */
export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    name: "researcher",
    description: "只读地查清楚一件事：列目录、搜内容、读文件，然后给要点。不改任何东西。",
    systemPrompt: [
      "你是一个**只读**的研究员。你的任务是查清楚一件事，然后给一份要点报告。",
      "你可以列目录、搜内容、读文件；**你没有任何写或跑的权限**（工具集里就没有）。",
      "报告要短：结论在前，证据（文件路径 + 关键行）在后。不要复述原文。",
      "查不到就直说查不到，不要猜 —— 也不要因为查不到就编一个像样的答案。",
    ].join("\n"),
    tools: ["list_dir", "search_files", "read_file", "list_files"],
    maxSteps: 8,
  },
  {
    name: "writer",
    description: "把已经定下来的内容写成文件：读得到、写得下、改得动，但不跑命令。",
    systemPrompt: [
      "你是一个写作执行者。任务里已经说明要写什么、写到哪。",
      "你只做一件事：把内容**准确**落到文件里。不做别的发挥。",
      "写完报告三件事：写了哪个文件、多少字、有没有覆盖已有文件。",
    ].join("\n"),
    tools: ["list_dir", "read_file", "write_file", "edit_file", "search_files"],
    maxSteps: 6,
  },
  {
    name: "runner",
    description: "在授权目录里跑命令并如实回报：退出码、输出、有没有超时。",
    systemPrompt: [
      "你是一个命令执行者。在授权目录里跑命令，如实回报结果。",
      "**不许**为了让结果好看而改述输出：退出码是多少就报多少，报错原文照抄关键行。",
      "命令有副作用（删、覆盖、装东西）时，先把要执行的命令原样写出来再执行。",
    ].join("\n"),
    tools: ["list_dir", "read_file", "run_command", "search_files"],
    maxSteps: 6,
  },
];

/** 按名字取一个 agent 声明。 */
export function findAgent(name: string | undefined): AgentSpec | undefined {
  if (!name) return undefined;
  return AGENT_SPECS.find((a) => a.name === name);
}

/** 全部 agent 的名字（给人看/给提示词列候选）。 */
export function agentNames(): string[] {
  return AGENT_SPECS.map((a) => a.name);
}

/**
 * 给 coordinator 看的候选名单（一句话一段）。
 *
 * ⚠️ 拼进提示词的是**这份**，不是把 `AGENT_SPECS` 整个 stringify ——
 * 系统提示词里不该出现 `maxSteps: 8` 这种内部参数（模型既看不懂也用不上）。
 *
 * @returns 多行文本；没有 agent 时给空串
 */
export function agentRoster(): string {
  if (!AGENT_SPECS.length) return "";
  return AGENT_SPECS.map((a) => `- ${a.name}：${a.description}`).join("\n");
}
