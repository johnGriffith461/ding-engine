import type { MemberRole } from "./members";

/**
 * **任务路由**（V5-3 任务 3.2）：把"这件事交给谁"做成**校验过的结构化输出**，
 * 而不是关键词匹配。
 *
 * ## 形态（参照 FastClaw 的控制器：`The controller returns validated JSON
 * selecting single/parallel/sequential/none`）
 *
 * 一次**隔离的**控制调用（不碰会话上下文、不给工具）拿到一段 JSON，这里**校验**它：
 *
 * ```json
 * { "mode": "single" | "parallel" | "sequential" | "none",
 *   "members": ["alice", ...], "reason": "一句话" }
 * ```
 *
 * 校验四条（任何一条不过 → 拒，回落到"不协调"）：
 *   ① 形状对（mode 在那四个里、members 是字符串数组）；
 *   ② 成员**都在名册里**（模型编一个名字出来 = 直接拒，别把活派给不存在的人）；
 *   ③ 人数在界内（parallel ≤ `MAX_PARALLEL`，顺序执行 ≤ `MAX_SEQUENTIAL`）；
 *   ④ `none` 不带人（自相矛盾就拒）。
 *
 * ## 显式 @ 绕过协调
 *
 * 用户点名（`@alice 你来看这个`）时**不叫控制器** —— 人已经指了，再让一次模型调用
 * 去"决定"是浪费与不尊重（而且它可能改成别人）。
 *
 * ## 有界共享历史（48K 字符 / 单条 12K 档）
 *
 * 协调要看见"大家说了什么"，但不能把这台机器上的全部历史灌给每个成员 ——
 * 所以给**有界**的一份：单条超过 12K 截断（并如实说明），总长超过 48K 从最早的那些丢
 * （并如实说"还有 N 条没展开"）。与 `memoryPromptBlock` 的"静默截断不许有"同一条纪律。
 *
 * ## 纯逻辑
 *
 * 不 import fs/electron/node:*。
 */

/** 路由模式（照控制器的四个选择）。 */
export const ROUTE_MODES = ["single", "parallel", "sequential", "none"] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

/** 并行上限（派活是有成本的：每个成员一次模型调用）。 */
export const MAX_PARALLEL = 4;
/** 顺序执行的上限（再多就该拆成两件事做）。 */
export const MAX_SEQUENTIAL = 6;

/** 共享历史预算（FastClaw 的口径：48K 总 / 单条 12K）。 */
export const SHARED_HISTORY_CHARS = 48_000;
export const SHARED_MESSAGE_CHARS = 12_000;

/** 名册里的一个人（路由只关心 id 与显示名）。 */
export type RoutableMember = { id: string; displayName: string; roles?: readonly MemberRole[] };

/** 一次路由决定。 */
export type RouteDecision =
  | { ok: true; mode: RouteMode; members: string[]; reason?: string }
  | {
      ok: false;
      /** `shape` 形状不对；`unknown-member` 名册里没有；`too-many` 人数越界；`contradiction` 自相矛盾；`not-json` 压根不是 JSON。 */
      code: "shape" | "unknown-member" | "too-many" | "contradiction" | "not-json";
      message: string;
    };

/**
 * 校验控制器给的那段 JSON。
 *
 * @param raw 控制器输出（字符串或已解析的对象）
 * @param roster 名册（成员必须在里面 —— 编出来的名字一律拒）
 * @returns 决定或拒绝原因
 */
export function parseRouteDecision(raw: unknown, roster: readonly RoutableMember[]): RouteDecision {
  let value: unknown = raw;
  if (typeof raw === "string") {
    /* 控制器常把 JSON 包在解释里：抓第一段 `{...}`（贪心到最后一个 `}` —— 常见的围栏写法） */
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return { ok: false, code: "not-json", message: "控制器输出里没有 JSON 对象" };
    try {
      value = JSON.parse(raw.slice(start, end + 1)) as unknown;
    } catch {
      return { ok: false, code: "not-json", message: "控制器输出里那段不是合法 JSON" };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "shape", message: "路由决定必须是一个对象" };
  }
  const o = value as { mode?: unknown; members?: unknown; reason?: unknown };
  if (typeof o.mode !== "string" || !(ROUTE_MODES as readonly string[]).includes(o.mode)) {
    return { ok: false, code: "shape", message: `mode 只能是 ${ROUTE_MODES.join(" / ")}（收到 ${JSON.stringify(o.mode)}）` };
  }
  const mode = o.mode as RouteMode;
  const membersRaw = o.members === undefined ? [] : o.members;
  if (!Array.isArray(membersRaw) || membersRaw.some((m) => typeof m !== "string" || !m.trim())) {
    return { ok: false, code: "shape", message: "members 必须是字符串数组" };
  }
  const members = [...new Set((membersRaw as string[]).map((m) => m.trim()))];

  if (mode === "none") {
    if (members.length) return { ok: false, code: "contradiction", message: "mode=none 却带了成员（自相矛盾）" };
    return { ok: true, mode, members, ...(typeof o.reason === "string" ? { reason: o.reason } : {}) };
  }
  if (!members.length) return { ok: false, code: "contradiction", message: `mode=${mode} 却没点名成员` };

  const known = new Set(roster.map((m) => m.id));
  const unknown = members.filter((m) => !known.has(m));
  if (unknown.length) {
    return { ok: false, code: "unknown-member", message: `名册里没有：${unknown.join(" / ")}（不把活派给不存在的人）` };
  }
  const cap = mode === "parallel" ? MAX_PARALLEL : mode === "sequential" ? MAX_SEQUENTIAL : 1;
  if (members.length > cap) {
    return { ok: false, code: "too-many", message: `mode=${mode} 最多 ${cap} 个成员（收到 ${members.length} 个 —— 派活是要花钱的）` };
  }
  return { ok: true, mode, members, ...(typeof o.reason === "string" ? { reason: o.reason } : {}) };
}

/**
 * **显式 @ 绕过协调**：文本里点名了成员就直连，不叫控制器。
 *
 * 认法：`@` + 成员 id 或显示名（**词首匹配**：`@alice` 认得，`mailto:a@b` 不认）。
 * 多个点名 → 按出现顺序全给（那是一次显式的"你们都来"，不需要模型裁决）。
 *
 * @param text 用户那句话
 * @param roster 名册
 * @returns 点到的成员 id（去重、按出现顺序）；一个都没点到给空数组
 */
export function explicitTargets(text: string, roster: readonly RoutableMember[]): string[] {
  const out: string[] = [];
  for (const member of roster) {
    /* id 与显示名都认（中文名没有词边界 —— 用 includes 找 `@名字`） */
    const names = [member.id, member.displayName].filter((x) => x && x.trim());
    if (names.some((name) => text.includes(`@${name}`))) out.push(member.id);
  }
  return [...new Set(out)];
}

/** 有界共享历史里的一条。 */
export type SharedHistoryItem = { from: string; text: string; at?: number };

/**
 * **有界共享历史**（48K 总 / 单条 12K）：给协调者（或每个成员）看的"大家说了什么"。
 *
 * 截断**不静默**：单条超限时在句尾标出截了多少；总数超限时给一行"还有 N 条没展开"。
 *
 * @param items 历史（按时间顺序）
 * @param opts 预算（可调，测试用）
 * @returns 拼好的文本与"丢了几条"
 */
export function boundedSharedHistory(
  items: readonly SharedHistoryItem[],
  opts: { totalChars?: number; perMessage?: number } = {},
): { text: string; dropped: number } {
  /* 不给隐藏下限：调用方给多少就是多少（测试要用小预算；生产给的是那两个常量） */
  const total = Math.max(1, Math.floor(opts.totalChars ?? SHARED_HISTORY_CHARS));
  const per = Math.max(1, Math.floor(opts.perMessage ?? SHARED_MESSAGE_CHARS));
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  /* **从最新往回取**：协调要看的是"刚说到哪儿了"，最早的可以丢 */
  for (const item of [...items].reverse()) {
    const body =
      item.text.length > per ? `${item.text.slice(0, per)}…（这条被截到 ${per} 字）` : item.text;
    const line = `${item.from}：${body}`;
    if (used + line.length > total) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1; /* +1 是换行 */
  }
  const ordered = lines.reverse();
  const more = dropped > 0 ? `\n（另有 ${dropped} 条较早的记录未展开：本次共享历史的上限是 ${total} 字）` : "";
  return { text: ordered.join("\n") + more, dropped };
}

/**
 * 自由任务（**未点名**）交给控制器的那段提示词。
 *
 * ⚠️ 控制器调用是**隔离的**：不给会话上下文、不给工具、只给名册与那句话 ——
 * 它的职责只有一件（选谁），掺进别的东西只会让它多想。
 *
 * @param input.task 用户那句话
 * @param input.roster 可选成员（显示名 + 角色，够它判断"谁合适"）
 * @param input.history 有界的共享历史（可选）
 * @returns 提示词
 */
export function routePrompt(input: {
  task: string;
  roster: readonly RoutableMember[];
  history?: string;
}): string {
  const who = input.roster
    .map((m) => `- ${m.id}（${m.displayName}${m.roles?.length ? `，${m.roles.join("/")}` : ""}）`)
    .join("\n");
  return [
    "你在做一次**任务分派**决定。只输出一个 JSON 对象，不要别的文字。",
    "",
    "可选的成员：",
    who || "（名册是空的 —— 这种情况请回 {\"mode\":\"none\"}）",
    ...(input.history ? ["", "最近的共享历史（有界摘录）：", input.history] : []),
    "",
    "待分派的任务：",
    input.task,
    "",
    `输出格式：{"mode":"single|parallel|sequential|none","members":["成员 id"],"reason":"一句话"}`,
    `约束：parallel 最多 ${MAX_PARALLEL} 人、sequential 最多 ${MAX_SEQUENTIAL} 人；`,
    "members 只能从上面名单里选（选不出来就 none）；一件事一个人做得了就别拆。",
  ].join("\n");
}
