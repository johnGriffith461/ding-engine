/**
 * Recipe 模板（Phase 18）——**可分享的任务模板**。
 *
 * 方案原文：「可分享 / 可安装的任务模板（Goose 式 recipes）——用户复用他人调好的
 * **提示词 + 工具组合 + 闸门档位**，是生态冷启动的燃料」。
 *
 * ## 它和"专家（AgentSpec）"不是一回事
 *
 * | | 是什么 | 用户怎么用 |
 * |---|---|---|
 * | AgentSpec | **角色**（研究员 / 写作 / 跑命令） | 派活时说"让研究员去查" |
 * | Recipe | **一件具体的事**（提示词 + 建议的工具范围 + 档位） | 一行命令跑起来，或把它分享给别人 |
 *
 * ## 为什么是纯 JSON（而不是某种"包"）
 *
 * 分享的门槛越低越好：一个 JSON 文件可以贴进聊天、进 gist、进 issue。
 * 里面**不含任何可执行代码** —— 所以"装上就跑了别人的代码"这件事在 Recipe 上不存在
 * （工具仍走我们自己的闸门与注册表；Recipe 只是"一句话 + 一点偏好"）。
 *
 * ## 与本机能力的对齐
 *
 * Recipe 里能声明的东西**只能是我们真有的**：工具名对不上 `AGENT_TOOLS` 就在导入时报错 ——
 * 不静默忽略（"以为按模板跑了、其实工具没生效"是最难查的一种）。
 */

import { AGENT_TOOLS, SPAWN_AGENTS_TOOL, SPAWN_AGENT_TOOL } from "../../shared/agentTools";
import { CONFIRM_MODES, type ConfirmMode } from "../../shared/ipc";

/** 一份 Recipe。 */
export type Recipe = {
  /** 稳定 id（分享与引用都用它）。 */
  id: string;
  title: string;
  /** 一句话说清它解决什么。 */
  description: string;
  /** 到点要做的那句话（喂给 agent 的正文）。 */
  prompt: string;
  /**
   * 建议的工具白名单（可选）。**空的 = 用默认全套**。
   *
   * 为什么要白名单：模板作者知道"这件事不该动文件"，写上就少一次越界的机会
   * （闸门仍然会拦写与执行 —— 这是两层的第二层）。
   */
  tools?: string[];
  /** 建议的闸门档位（可选）。只在**比当前更严**时生效（与 subagent 同一条规矩）。 */
  mode?: ConfirmMode;
  /** 需要的工作目录（可选；不给就用当前）。 */
  dirs?: string[];
  /** 作者（分享时写谁写的；不填就是"本机"）。 */
  author?: string;
  /**
   * **模板归谁**（V5-3 3.7；成员 id）。
   *
   * `author` 是"给人看的署名"，这一格是**归属**（与 C1 的会话归属、C5 的 actor
   * 同一个 id 空间）—— 分享出去之后"这是谁的模板"要能查。
   * 缺省 `local`（旧模板与手写文件的兼容口径）。
   */
  owner?: string;
};

/** 模板归属的默认值（本机用户；与 C1/C4/C5 同一个 id 空间）。 */
export const LOCAL_RECIPE_OWNER = "local";

/** 内置 Recipe（跟着产品走的几个；用户自己的从文件导入）。 */
export const BUILTIN_RECIPES: readonly Recipe[] = [
  {
    id: "daily-digest",
    title: "每日汇总",
    description: "把今天在这个目录里发生的事整理成一段简报（配合定时任务就是「每晚汇报」）",
    prompt:
      "把这个工作目录里今天改动过的文件读一遍，写一段不超过 300 字的简报：改了什么、为什么改（能从内容看出来就说，看不出来就别猜）、有没有留下待办。",
    tools: ["list_dir", "read_file", "search_files"],
    mode: "按需确认",
  },
  {
    id: "repo-triage",
    title: "仓库初诊",
    description: "第一次进一个陌生仓库：先弄清它是什么、怎么跑、哪里最容易出问题",
    prompt:
      "先读 README 与包描述，再列目录、看主要源码的入口。用不超过 20 行说清：这个项目是干什么的、怎么跑起来、主要模块在哪、有没有明显的坑（缺文档 / 缺测试 / 硬编码路径）。",
    tools: ["list_files", "list_dir", "read_file", "search_files"],
  },
  {
    id: "doc-to-task-list",
    title: "把文档拆成待办",
    description: "把一份需求或设计文档拆成可执行的待办清单（每条带验收口径）",
    prompt:
      "读我指定的文档，把它拆成待办清单。每条一句话、动词开头，并在后面用括号写清「怎么算做完了」。有歧义的地方单独列一节问我，不要自己定。",
    tools: ["list_dir", "read_file", "search_files"],
  },
  {
    id: "bug-report-repro",
    title: "把报错变成可复现步骤",
    description: "拿到一段报错，先复现再定位（不许直接猜原因）",
    prompt:
      "我会给你一段报错或一份缺陷描述。你的任务是：① 先复现它（跑命令 / 读代码），② 给出代码级的根因（指到具体文件与行为），③ 说清你试过什么。**在复现之前不要提修复方案**。",
    tools: ["list_dir", "read_file", "search_files", "run_command"],
    mode: "按需确认",
  },
];

/** 校验一份导入的 Recipe（**磁盘与外部文件都不可信**）。 */
export function validateRecipe(raw: unknown): { ok: true; recipe: Recipe } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "不是一个对象" };
  const r = raw as Partial<Recipe>;
  if (typeof r.id !== "string" || !r.id.trim()) return { ok: false, reason: "缺 id" };
  if (typeof r.title !== "string" || !r.title.trim()) return { ok: false, reason: "缺 title" };
  if (typeof r.prompt !== "string" || !r.prompt.trim()) return { ok: false, reason: "缺 prompt（没它就不是模板）" };

  /*
   * 工具名要对得上我们真有的那些 —— 对不上就**报错**。
   * 静默忽略的后果是"按模板跑了、工具却一个没生效"，而用户看不出来。
   */
  if (r.tools !== undefined) {
    if (!Array.isArray(r.tools)) return { ok: false, reason: "tools 不是数组" };
    const known = new Set<string>(AGENT_TOOLS.map((t) => t.name));
    for (const t of r.tools) {
      if (typeof t !== "string" || !known.has(t)) {
        return { ok: false, reason: `不认识的工具：${String(t)}（可用的见 ding agents 或 README）` };
      }
    }
  }
  if (r.mode !== undefined && !(CONFIRM_MODES as readonly string[]).includes(r.mode)) {
    return { ok: false, reason: `不认识的档位：${String(r.mode)}（可选：${CONFIRM_MODES.join(" / ")}）` };
  }
  if (r.dirs !== undefined && (!Array.isArray(r.dirs) || r.dirs.some((d) => typeof d !== "string"))) {
    return { ok: false, reason: "dirs 里必须都是字符串" };
  }

  return {
    ok: true,
    recipe: {
      id: r.id.trim(),
      title: r.title.trim(),
      description: typeof r.description === "string" ? r.description : "",
      prompt: r.prompt,
      ...(r.tools?.length ? { tools: [...r.tools] } : {}),
      ...(r.mode ? { mode: r.mode } : {}),
      ...(r.dirs?.length ? { dirs: [...r.dirs] } : {}),
      ...(typeof r.author === "string" && r.author.trim() ? { author: r.author.trim() } : {}),
      /* 归属：坏值/缺省一律落本机（与 C1 的 owner 兼容口径一致） */
      owner: typeof r.owner === "string" && r.owner.trim() ? r.owner.trim() : LOCAL_RECIPE_OWNER,
    },
  };
}

/**
 * 把一份 Recipe 与当前档位合起来，算出**这一轮真的用什么档位**。
 *
 * 规矩与子智能体那条一致：**只会更严，不会更松** ——
 * 模板不能把你的"每步确认"降成"全部允许"（那等于模板能替你放开权限）。
 */
export function resolveRecipeMode(current: ConfirmMode, recipe: Recipe): ConfirmMode {
  if (!recipe.mode) return current;
  const rank: Record<ConfirmMode, number> = { 全部允许: 0, 按需确认: 1, 每步确认: 2 };
  return rank[recipe.mode] >= rank[current] ? recipe.mode : current;
}

/** 内置 + 导入的合起来（导入的与内置同名时**导入的覆盖**——用户自己改过的那份说了算）。 */
export function mergeRecipes(imported: readonly Recipe[]): Recipe[] {
  const byId = new Map<string, Recipe>();
  for (const r of BUILTIN_RECIPES) byId.set(r.id, r);
  for (const r of imported) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 导出成分享用的 JSON（固定字段顺序，diff 起来干净）。 */
export function recipeToJson(recipe: Recipe): string {
  return (
    JSON.stringify(
      {
        id: recipe.id,
        title: recipe.title,
        description: recipe.description,
        prompt: recipe.prompt,
        ...(recipe.tools ? { tools: recipe.tools } : {}),
        ...(recipe.mode ? { mode: recipe.mode } : {}),
        ...(recipe.dirs ? { dirs: recipe.dirs } : {}),
        ...(recipe.author ? { author: recipe.author } : {}),
        /* 归属**一定要导出去**（分享出去之后"这是谁的模板"要跟着走） */
        owner: recipe.owner ?? LOCAL_RECIPE_OWNER,
      },
      null,
      2,
    ) + "\n"
  );
}

/** 空 Recipe 的骨架（`ding recipe new` 用）。 */
export const SPAWN_TOOL_HINT = `想让它派活，工具白名单里加 ${SPAWN_AGENT_TOOL} / ${SPAWN_AGENTS_TOOL}`;
