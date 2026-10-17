import { AGENT_TOOLS } from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";

/**
 * **错误回注的三件套**（Factor 9：把错误压缩进上下文，而不是抛栈）。
 *
 * ## 为什么它们必须住在一起
 *
 * "工具出错时模型看见什么"一共只有三种情形：
 *
 * | 情形 | 什么时候发生 | 模型该学到什么 |
 * |---|---|---|
 * | 未知工具 | 模型调了一个不存在的名字 | 没有这个工具 + **可用的有哪些** |
 * | 闸门拦截 | 用户档位要求确认，调用**没有执行** | 没执行、在等谁、**别再试** |
 * | 执行失败 | 工具自己报错（路径不在白名单、命令超时…） | 失败了 + 原因 |
 *
 * 它们原来各自散在三个文件里：`shared/agentTools.ts`（未知工具）、
 * `engine/core/policy.ts`（闸门）、以及"失败"根本没有一句自己的话 ——
 * 失败是执行体随手 `new Error(...)` 抛出来的。
 *
 * 后果不是"不好看"，是**两个宿主会对同一件事说不同的话**：
 * 桌面点"允许"后失败给一句、CLI 里失败给另一句，模型据此学到的行为也不一样。
 * 收在一起之后，"模型看见的错误"这件事只有这一个文件能改。
 *
 * ## 三句话各自的硬要求（单测盯着）
 *
 * - 未知工具：**要列出可用工具**，否则模型只会换个名字继续猜；
 * - 闸门拦截：要同时说清"没执行"与"别重试" —— 少了前者用户以为事做完了，
 *   少了后者模型会在同一轮里反复试同一个工具；
 * - 执行失败：`name` 与 `reason` 都要出现（只说"失败了"等于没说）。
 *
 * ⚠️ 这些话是**给模型看的**，不是给用户看的。界面上那一行由
 * `shared/agentTools.ts` 的 `describeToolResult` 生成 —— 那是另一件事，别混。
 */

/**
 * 模型调了一个不存在的工具。
 *
 * @param name 它调的那个名字
 * @param reason 可选的更具体原因（例如 schema 校验失败的信息）
 * @returns 一句话
 */
export function unknownToolNotice(name: string, reason?: string): string {
  const known = AGENT_TOOLS.map((t) => t.name).join(" / ");
  const head = `没有名为「${name}」的工具。可用工具：${known}。`;
  return reason ? `${head}（参数问题：${reason}）请修正后重试。` : `${head}请改用其中一个。`;
}

/**
 * 这次调用被闸门拦下、**还没有执行**。
 *
 * @param name 工具名
 * @param mode 当前档位
 * @returns 一句话
 */
export function pendingApprovalNotice(name: string, mode: ConfirmMode): string {
  return `已把这次「${name}」交给用户确认（当前档位：${mode}），**还没有执行**。请不要重试，直接把需要确认的事告诉用户。`;
}

/**
 * 工具执行失败。
 *
 * ⚠️ 它的形状是**透传**：执行体自己给的那句原因（"这个路径不在可读写范围内"）
 * 原样保留，只在执行体没给原因时补一句兜底。这样做的理由很实际 ——
 * 各工具那句原因是**它们自己最清楚**的事（比如"能写的范围是哪些"），
 * 在这里统一改写只会把有用的信息洗掉。
 *
 * @param name 工具名
 * @param reason 执行体给的原因（可能没有）
 * @returns 一句话
 */
export function toolFailedNotice(name: string, reason?: string): string {
  const detail = (reason ?? "").trim();
  return detail || `「${name}」执行失败（没有给出原因）。`;
}

/**
 * 软限额提示（Phase 13.2）。
 *
 * 方案原文：「超额前**软限额**提示（**提示，不硬断**）」——两个要点都在措辞里：
 *   · 说清"已经花了多少、限额多少"（用户要的是数字，不是"注意用量"这种空话）；
 *   · 说清"**不会拦你**"——否则用户会以为下一轮跑不动了，反而不敢用。
 *
 * @param spentUsd 到今天为止已花（美元）
 * @param limitUsd 用户设的软限额
 * @param fraction 已用比例（>=1 表示已超）
 * @returns 给人看的一句话
 */
export function softLimitNotice(spentUsd: number, limitUsd: number, fraction: number): string {
  /*
   * ⚠️ 小额要**多给两位小数**：¥0.0014 用 toFixed(2) 会显示成 "$0.00"，
   * 而那句话读起来就成了"已用 $0.00 / $0.01" —— 看着像坏了。
   * 一元以下给四位，其余两位（用户看的是量级，不是账单）。
   */
  const money = (v: number) => (v < 1 ? v.toFixed(4) : v.toFixed(2));
  const over = fraction >= 1;
  /*
   * ⚠️ 口径（审计 P152）：这个数是**按目录单价估算**的，不是账单 ——
   * 同一句里的限额却是用户自己设的真值。一句里两个 "$x" 一个实测口径一个估算口径
   * 而不标注，是把账本自己立的那条规矩（`ledger.ts` 的 `formatTotal` 写"约 …（按目录单价估）"）
   * 在这里破掉了。
   */
  const head = over
    ? `今天的用量已经超过你设的软限额（约 $${money(spentUsd)}（按目录单价估），限额 $${money(limitUsd)}）`
    : `今天的用量快到软限额了（约 $${money(spentUsd)}（按目录单价估） / $${money(limitUsd)}，${Math.round(fraction * 100)}%）`;
  return `${head}。**这只是提示，不会拦你** —— 想调就改 config.json 里的 softLimitUsd，想去掉就设成 0。`;
}

/** 软限额的默认阈值（方案没规定数，这里给 0 = 不提示 —— 不该替用户设一个他没同意的额度）。 */
export const SOFT_LIMIT_DEFAULT_USD = 0;
