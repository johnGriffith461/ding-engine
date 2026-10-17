/**
 * AI 智能体（`chat/bot/create`，§156）。
 *
 * ## 证据
 *
 * 文案逐字取自 `docs/evidence-bot.txt`（`create_bot_*` 49 条，从本体前端包抠出来）：  ⚠️（该依据未入库、本机也找不到 —— 无法复核；判据以本文件里的断言为准）
 *
 * | 键 | 文案 |
 * |---|---|
 * | `create_bot_title` | **创建 AI 智能体** |
 * | `create_bot_name` / `_name_placeholder` | 名称 / 输入名称 |
 * | `create_bot_description` / `_prompt_title` | 设定描述 |
 * | `create_bot_prompt_placeholder` | 示例：你是一位经验丰富的英语老师… |
 * | `create_bot_background_header` | 背景（CEO / 医生 / 老师 / 图书馆员 / 运动员 / 超级巨星） |
 * | `create_bot_characteristic_header` | 特征（温和 / 强势 / 冷酷 / 乐观 / 害羞 / 善妒） |
 * | `create_bot_hobby_header` | 兴趣嗜好（书籍 / 舞蹈 / 游戏 / 电影 / 绘画 / 摄影 / 体育） |
 * | `create_bot_setting_header` | 场景设定（在家 / 在咖啡馆 / 在公园 / 在办公室 / 在夜店 / 旅行） |
 * | `create_bot_one_click_fill` | **一键完善** |
 * | `create_bot_qualities_btn` | **开始聊天** |
 * | `create_bot_done` / `_cancel` | 完成 / 取消 |
 * | `create_bot_failed` | 创建 AI 智能体失败 |
 *
 * ## 与本体的差异（如实）
 *
 * 本体这些是**云端**智能体（有头像生成、有封禁策略、能 `discover` 别人的）。
 * 本机版只做**本机这一份**：建好、存在本地、能在对话里选用。
 * 头像生成 / 违规封禁 / 发现别人 —— **不做**（没有后端，也不该假装有）。
 */

/** 表单上的四组标签（键名与证据一一对应）。 */
export const AGENT_TAG_GROUPS = ["background", "characteristic", "hobby", "setting"] as const;
export type AgentTagGroup = (typeof AGENT_TAG_GROUPS)[number];

/** 每组的中文标题（逐字取自证据）。 */
export const AGENT_GROUP_LABEL: Record<AgentTagGroup, string> = {
  background: "背景",
  characteristic: "特征",
  hobby: "兴趣嗜好",
  setting: "场景设定",
};

/**
 * 每组可选项（**逐字取自证据**）。
 *
 * ⚠️ 本体这些标签是**服务端下发**的（所以两处繁简混用，例如「溫和」就是繁体）。
 * 这里照抄原文，**不擅自简化** —— 逐字对齐比"看着整齐"重要。
 */
export const AGENT_TAGS: Record<AgentTagGroup, readonly string[]> = {
  background: ["CEO", "医生", "老师", "图书馆员", "运动员", "超级巨星"],
  characteristic: ["温和", "强势", "冷酷", "乐观", "害羞", "善妒"],
  hobby: ["书籍", "舞蹈", "游戏", "电影", "绘画", "摄影", "体育"],
  setting: ["在家", "在咖啡馆", "在公园", "在办公室", "在夜店", "旅行"],
};

/** 界面文案（逐字取自证据）。 */
export const AGENT_LABELS = {
  title: "创建 AI 智能体",
  name: "名称",
  namePlaceholder: "输入名称",
  description: "设定描述",
  promptTitle: "设定描述",
  promptPlaceholder:
    "示例：你是一位经验丰富的英语老师，拥有激发学生学习热情的教学方法。你善于运用幽默和实际应用案例，使对话充满趣味。",
  oneClickFill: "一键完善",
  fastFillWindow: "一键完善智能体信息",
  fastFillConfirm: "确认",
  fastFillSkip: "跳过",
  start: "开始聊天",
  done: "完成",
  cancel: "取消",
  failed: "创建 AI 智能体失败",
} as const;

/** 一个本机智能体。 */
export type Agent = {
  id: string;
  name: string;
  /** 设定描述（会作为系统提示词的一部分）。 */
  description: string;
  background: string[];
  characteristic: string[];
  hobby: string[];
  setting: string[];
  createdAt: number;
};

/**
 * 校验（界面上「创建」按钮能不能点、为什么不能点都据此）。
 *
 * @param draft 表单内容
 * @returns 出错说明；通过则返回 null
 */
export function validateAgent(draft: Pick<Agent, "name" | "description">): string | null {
  if (!draft.name.trim()) return "请先填名称";
  if (draft.name.trim().length > 20) return "名称太长了（最多 20 字）";
  if (!draft.description.trim()) return "请先填设定描述";
  if (draft.description.trim().length > 800) return "设定描述太长了（最多 800 字）";
  return null;
}

/**
 * 把选中的标签折成一句人话，附在设定描述后面。
 *
 * 为什么要折进去而不是只存着：模型看不到我们的数组 ——
 * 只有写进提示词它才知道"这个智能体是个温和的老师、喜欢摄影、常在咖啡馆"。
 *
 * @param agent 智能体（或表单草稿）
 * @returns 拼好的提示词片段；没有标签时返回空串
 */
export function agentTagLine(agent: Pick<Agent, AgentTagGroup>): string {
  const parts: string[] = [];
  for (const g of AGENT_TAG_GROUPS) {
    const picked = agent[g] ?? [];
    if (picked.length) parts.push(`${AGENT_GROUP_LABEL[g]}：${picked.join("、")}`);
  }
  return parts.join("；");
}

/**
 * 这个智能体的**系统提示词**。
 *
 * @param agent 智能体
 * @returns 系统提示词（名称 + 设定描述 + 标签 + 一条"保持人设"的要求）
 */
export function agentSystemPrompt(agent: Pick<Agent, "name" | "description"> & Pick<Agent, AgentTagGroup>): string {
  const lines = [`你现在扮演「${agent.name.trim()}」。`, "", agent.description.trim()];
  const tags = agentTagLine(agent);
  if (tags) lines.push("", `人设要点 —— ${tags}`);
  lines.push("", "始终以这个身份说话，不要跳出角色；也不要提到「这是一段设定」。");
  return lines.join("\n");
}

/** 造一个智能体（表单提交时用）。 */
export function makeAgent(id: string, draft: Omit<Agent, "id" | "createdAt">, now: number): Agent {
  const clean = (list: string[]): string[] => [...new Set(list.map((x) => x.trim()).filter(Boolean))];
  return {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    background: clean(draft.background),
    characteristic: clean(draft.characteristic),
    hobby: clean(draft.hobby),
    setting: clean(draft.setting),
    createdAt: now,
  };
}

/** 列表里那一行的人话（名称 + 标签摘要）。 */
export function agentSummary(agent: Agent): string {
  const tags = agentTagLine(agent);
  return tags ? `${agent.name} · ${tags}` : agent.name;
}

/**
 * 收窄磁盘上读回来的智能体（**磁盘内容一律不可信**）。
 *
 * @param raw 任意值
 * @returns 合法列表（按创建时间，旧的在前）
 */
export function normalizeAgents(raw: unknown): Agent[] {
  if (!Array.isArray(raw)) return [];
  const out: Agent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || !a.id) continue;
    if (typeof a.name !== "string" || !a.name.trim()) continue;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    out.push({
      id: a.id,
      name: a.name.trim(),
      description: typeof a.description === "string" ? a.description : "",
      background: list(a.background),
      characteristic: list(a.characteristic),
      hobby: list(a.hobby),
      setting: list(a.setting),
      createdAt: typeof a.createdAt === "number" ? a.createdAt : 0,
    });
  }
  return out.sort((x, y) => x.createdAt - y.createdAt);
}

/** `agents.json` 的整体形状（智能体 + 当前选中的那个）。 */
export type AgentFile = {
  agents: Agent[];
  /** 当前在用的那个（**必须落盘**，不能只放本地存储 —— 见 §156 的教训）。 */
  selected: string;
};

/**
 * 收窄整个 `agents.json`。
 *
 * ⭐ **为什么"当前选中的"也要落盘**：原来把它放在 `localStorage` 里，
 * 而 localStorage 是**延迟落盘**的 —— 强杀进程（或断电）时缓冲区里的写入会丢。
 * 验收里就是这么撞到的：智能体本身在（主进程同步原子写），"正在使用"却没了。
 * 凡是**要跨重启活下来的状态**，都走主进程那条落盘路。
 *
 * @param raw 任意值（也兼容旧形状：直接就是一个数组）
 * @returns 规整后的整体
 */
export function normalizeAgentFile(raw: unknown): AgentFile {
  // 兼容旧文件（之前存的就是一个数组）
  if (Array.isArray(raw)) return { agents: normalizeAgents(raw), selected: "" };
  if (!raw || typeof raw !== "object") return { agents: [], selected: "" };
  const o = raw as Record<string, unknown>;
  const agents = normalizeAgents(o.agents);
  const selected = typeof o.selected === "string" ? o.selected : "";
  // 选中的那个要是不在了就当作没选（否则会一直以为自己在用一个不存在的智能体）
  return { agents, selected: agents.some((a) => a.id === selected) ? selected : "" };
}
