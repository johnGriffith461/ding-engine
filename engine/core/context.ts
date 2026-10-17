import type { ChatMessage } from "../../shared/ipc";

/**
 * 上下文窗口的**唯一负责人**（C3）。
 *
 * ## 它替代了什么
 *
 * 在这之前，"历史发多少给模型"由**两处各管一段**：
 *
 * | 位置 | 原来怎么管 | 后果 |
 * |---|---|---|
 * | `src/workbench/history.ts` | 先硬截断到**最近 20 条** | 20 条消息通常远不到 2 万 token → **压缩阈值几乎不可能触发**（压了个寂寞） |
 * | `src/workbench/compaction.ts` | 再对"剩下那 20 条"按 20000 token 切 | 计量与切分都只长在工作台这一侧 |
 * | `src/ai/chatStore.ts` | **什么都不做（全量发）** | F3 之后聊天历史会一直涨 → 迟早顶爆上下文 |
 *
 * 现在：**计量一份、切分一份**，两条路都调它。谁是"该发多少"的负责人只有这一个文件。
 *
 * ## 切割点的硬规矩
 *
 * 1. **只在消息边界切**：一条消息内部可能带着工具调用与结果（工作台把工具行折进步骤正文，
 *    见 `history.ts` 的 `withToolLines`）。从中间切开会把"调用的参数"和"它的结果"分开 ——
 *    那正是手册点名"切割点不许落在 tool result 上"要防的事。
 *    本模块按**整条消息**取舍，所以这条规矩是**结构上成立**的，不靠调用方记得。
 * 2. **最后一条永远留下**（无论它多大）：那是用户刚说的话，丢掉它这轮就没意义了。
 * 3. **保留下来的第一条必须是 user**：否则它会以"助手的一句话"开头，
 *    模型会以为自己刚才说过那句（历史上真踩过）。
 *
 * ⚠️ 关于"给模型输出留额度"（原来是 `RESERVE_TOKENS = 16384`，全仓零引用）：
 * 它**这一轮被删掉了**（C3 是手册指定的裁定时机）。原因不是"用不上"，是**没有前提**：
 * 要留额度就得知道**每个模型的上下文上限**，而 `electron/ipc/aiProviders.ts` 里
 * 压根没有这个字段（我们只知道"有哪几个模型"，不知道"它们能装多少"）。
 * 硬编一个数就是编数据。等 provider 带上真实上限，这里加一个 `reserveTokens` 参数即可
 * —— 那时它是"上限减去保留"，而不是现在这个凭空定的 16384。
 */

/**
 * 保留最近多少 token 的历史（pi 的 `keep`）。
 *
 * 取值理由：够几轮连续对话（含工具输出），又不至于把一次请求撑得很大。
 * ⚠️ 它是**我们自己定的额度**，不是"模型的上限"（见文件头那条：我们不知道上限）。
 */
export const KEEP_RECENT_TOKENS = 20000;

/**
 * 粗糙但**方向保守**的 token 估算。
 *
 * 中英混排：CJK 一字算 1，其余按 4 字符 1 个算。
 * 只用来判断"该保留多少"，不追求精确 —— 所以宁可**估多**（早切一点没坏处，估少了会真的超）。
 *
 * ⚠️ 这是**唯一**一份计量（原来长在 `compaction.ts` 里）。
 *
 * @param text 文本
 * @returns 估算的 token 数
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    // 中日韩统一表意文字 + 全角标点 + 中文标点
    if (/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 一组消息的估算总量。
 *
 * @param messages 消息
 * @returns 估算的 token 数
 */
/**
 * 用**真实用量**校准估算（补完④）。
 *
 * ## 为什么要它
 *
 * `estimateTokens` 是"中文一字、英文 4 字符"的**估算**，与 provider 真实计费口径之间
 * 有个固定偏差（中文标点、代码、JSON 结构都会偏）。而 provider **每轮都告诉我们真值**
 * （`usage.inputTokens`）—— 拿它反推一个系数，比死用估算准得多。
 *
 * 口径：
 * - `estimated` 为 0 或 `actual` 拿不到 → 返回 1（**不校准**：不编一个系数）；
 * - 结果**夹在 0.5–2**：真实的计费口径不该与估算差出一倍以上，
 *   超出多半是"这一轮估的对象不对"（比如没算进工具 schema），夹住比放任安全。
 *
 * ⚠️ 它**只调额度，不改内容**：系数只影响"留多少历史"，不影响发什么。
 *
 * @param estimated 我们对"上一轮发出去的东西"的估算
 * @param actual provider 给的上一轮 `inputTokens`
 * @returns 校准系数（真实 ÷ 估算）
 */
export function calibrationOf(estimated: number, actual: number | undefined): number {
  if (!Number.isFinite(estimated) || estimated <= 0) return 1;
  if (typeof actual !== "number" || !Number.isFinite(actual) || actual <= 0) return 1;
  return Math.min(2, Math.max(0.5, actual / estimated));
}

export function totalTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

/**
 * 该不该压（历史是否已经超出保留额度）。
 *
 * @param messages 这次准备发的历史
 * @param keepTokens 保留额度
 * @returns 总量超过额度就该压
 */
export function shouldCompact(messages: readonly ChatMessage[], keepTokens = KEEP_RECENT_TOKENS): boolean {
  return totalTokens(messages) > keepTokens;
}

/**
 * 把历史切成"要压的"与"原样保留的"（两条路共用的**唯一切分**）。
 *
 * 规矩见文件头那三条（只在消息边界切 / 最后一条必留 / recent 以 user 开头）。
 *
 * @param messages 历史（旧 → 新）
 * @param keepTokens 保留额度
 * @returns `older` 要压的；`recent` 原样保留的
 */
export function planContext(
  messages: readonly ChatMessage[],
  keepTokens = KEEP_RECENT_TOKENS,
  /**
   * 校准系数（补完④）：**我们估算的单位 → 真实 token 单位**的倍率。
   * 大于 1 表示"我们低估了" → 实际保留得更少（额度除以它）。
   */
  opts: { factor?: number } = {},
): { older: ChatMessage[]; recent: ChatMessage[] } {
  const factor = Number.isFinite(opts.factor) && (opts.factor ?? 0) > 0 ? (opts.factor as number) : 1;
  /** 额度换算到"我们的估算单位"：估得偏低（factor>1）就少留一点，反之多留。 */
  const budget = keepTokens / factor;
  const recent: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    const cost = estimateTokens(msg.content);
    // `recent.length` 这个前置条件保证"最后一条无论多大都会留下"
    if (recent.length > 0 && used + cost > budget) break;
    recent.unshift(msg);
    used += cost;
  }

  const older = messages.slice(0, messages.length - recent.length);
  /*
   * 以 assistant 开头的保留段要往后挪（见文件头第 3 条）。
   *
   * ⚠️ 但**窗口永不清空**（`recent.length > 1` 这个条件）：只有一个很长的助手回复、
   * 挪走它就等于"这一轮什么历史都不发" —— 那比"以助手开头"更坏：
   * 用户的下一句紧跟在它后面，模型读到的是"我刚说过这个 → 用户接着说"，因果是顺的。
   * 反过来，发一个空历史会让模型以为"这是全新的对话"。
   *
   * 这条是第一版写成 `recent.length > 0` 时踩出来的（单测直接红）：
   * 那时候"一段只有助手消息的历史"会被整个清空。
   */
  while (recent.length > 1 && recent[0]?.role !== "user") {
    const moved = recent.shift();
    if (moved) older.push(moved);
  }
  return { older, recent };
}

/**
 * 历史被切掉时，追加到系统提示词末尾的那句话。
 *
 * 必须让模型知道"你看不到全部" —— 否则它会把"没在上下文里"当成"没发生过"，
 * 于是重复问用户已经回答过的事。
 *
 * ⚠️ 措辞变了（C3）：原来写的是"你只能看到**最近 20 条消息**"，
 * 而那个"20 条"是硬截断留下的数字 —— 现在切分按**额度**走，
 * 条数不是判据（同样 20 条，短消息与长消息差几十倍）。所以只如实说"更早的已省略/压缩"。
 *
 * @param mode `trimmed` 直接丢掉；`summarized` 压成了摘要
 * @returns 给模型看的一句话
 */
export function omittedNote(mode: "trimmed" | "summarized" = "trimmed"): string {
  return mode === "summarized"
    ? "【说明】更早的对话已压缩为摘要（见上方）。如果缺关键信息，直接说不确定，不要猜。"
    : "【说明】更早的对话已省略。如果缺关键信息，直接说不确定，不要猜。";
}
