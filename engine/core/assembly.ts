/**
 * 系统提示词的**装配**（C2-4）。
 *
 * ## 这一层解决的是什么
 *
 * "这一轮发给模型的 system 由哪几块拼成"原来写在**两条路各自的代码里**：
 * 工作台是 `store.ts` 里那行手写的数组 join（基础提示词 + 人设 + 记忆 + 能力），
 * 聊天侧只有能力块（`chatStore.ts` 的 `abilityBlock()`）。
 * 于是同一个模型在两边**看到的东西不一样** —— 实测最刺眼的一条：
 * 工作台看得到长期记忆与你的智能体人设，**聊天侧看不到**，
 * 而工具描述里却写着"以后每次对话都会自动带上"。
 *
 * 收成一份纯函数之后：
 * - 两边**输入相同则输出相同**（INV-2），差异只剩"调用方给了什么块"；
 * - 它能被单测（纯字符串拼装，最容易被"顺手改顺序"而无人生效的地方）。
 *
 * ## 顺序是有讲究的（别随手换）
 *
 * 1. `base` —— 这一轮的任务要求（工作台按"问 / 干 / 追问"三档给不同的）
 * 2. `persona` —— **你是谁**（选中的 AI 智能体：设定描述 + 标签）
 * 3. `memory` —— **你记得什么**（长期记忆）
 * 4. `abilities` —— **你能用什么**（插件 / 技能 / 伙伴里开着的那些）
 * 5. `extra` —— 其它要额外交代的（例如"更早的对话已压缩为摘要"）
 *
 * 从"身份"到"能力"再到"临时交代"：越靠后越像本次的补充说明。
 */

/** 装配的输入：**给了才拼**（空串/undefined 一律跳过，不留空段）。 */
export type AssemblyInput = {
  /** 这一轮的任务要求。 */
  base?: string;
  /** 人设（选中的 AI 智能体）。 */
  persona?: string;
  /** 长期记忆。 */
  memory?: string;
  /** 能力说明（插件 / 技能 / 伙伴）。 */
  abilities?: string;
  /** 其它临时交代（压缩提示、截断说明等）。 */
  extra?: string;
};

/** 块与块之间的分隔（**单处定义**：改这里就等于改所有调用方）。 */
export const BLOCK_SEPARATOR = "\n\n";

/**
 * 把各块拼成这一轮的系统提示词。
 *
 * @param input 见 `AssemblyInput`
 * @returns 拼好的 system；一块都没有时给空串（**不发一个空的 system**）
 */
export function assembleSystem(input: AssemblyInput): string {
  return [input.base, input.persona, input.memory, input.abilities, input.extra]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(BLOCK_SEPARATOR);
}
