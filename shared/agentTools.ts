import { z } from "zod";
import { isMcpTool, parseMcpToolName } from "./mcp";
import { MEMORY_TEXT_LIMIT } from "./memory";
import { MAX_CUSTOM_MINUTES, MIN_CUSTOM_MINUTES, REPEAT_VALUES } from "./schedule";
import { READ_MAX_BYTES } from "./drive";

/**
 * **工具协议**的规格层（§141）。
 *
 * 为什么单独一层：工具的**声明**（名字、说明、参数 schema）要在两处用 ——
 * 主进程交给模型（`streamText({ tools })`）、测试里校验参数与回注文案；
 * 而**执行**只在主进程（那里才有 store 与文件系统）。
 * 所以把"声明"放共享层当**唯一事实来源**，执行单独绑定 —— 避免两处各写一份 schema。
 *
 * 这一层是研究结论的直接落地（`docs/优化计划.md` 批次 1）：
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 *  - 工具的 schema 与实际校验同一处（opencode 的 `tool({ inputSchema })` 口径）；
 *  - 参数在进业务之前就被校验（schema 不合格 → 当 tool result 回注给模型，见 `unknownToolNotice`）；
 *  - 工具名是**稳定的字符串**（决定权限策略表怎么挂，批次 2）。
 */

/** 一条工具的声明。 */
export type AgentToolSpec = {
  name: string;
  description: string;
  /** zod schema —— 既是给模型的参数说明，也是执行前的校验。 */
  schema: z.ZodTypeAny;
};

/**
 * 一次读文件最多给模型多少字。
 *
 * ⚠️ **真身**在 `engine/runtime/tools/readTool.ts` 的 `MODEL_MAX_CHARS`（那里才截断）；
 * 这里这份是**写进工具说明给模型看**的。两处必须同值（审计 P57），由
 * `src/sharedContract.test.ts ①` 读两处源码对账 —— 收成一处要 engine 那侧 import 这里
 * （不在本轮范围，如实记）。
 */
export const READ_FILE_MODEL_CHARS = 8000;
/**
 * 「写文件」的正文上限：**字节**，**就是读回来那个上限**（审计 P234）—— 写侧当年按
 * 字符算（200000 字），中文 20 万字写得进去、落盘 600KB、下一轮读不回来（死档）。
 * 取同一个数修的就是它；`engine/runtime/tools/writeCaps.test.ts` 的往返用例钉着。
 */
export const WRITE_FILE_MODEL_BYTES = READ_MAX_BYTES;

/** 给模型看的「最多多少字」：按 UTF-8 最坏 3 字节/码元折算。**不是第二道闸**，只是把上限说成人话。 */
export const WRITE_FILE_MODEL_CHARS = Math.floor(WRITE_FILE_MODEL_BYTES / 3);

export const MEMORY_SAVE_TOOL = "memory_save";
export const MEMORY_LIST_TOOL = "memory_list";

/**
 * 「记住一条」的说明。
 *
 * 写清楚**什么时候该用**（研究里 Cline 强调"需要复核的工具必须显式声明"，
 * 工具的 description 就是它的说明书）：用户明确要求"记住"时才存，
 * 不要把这次对话的内容随手记进去 —— 记忆是**跨会话长期注入**的，写错会一直影响后续。
 */
export const MEMORY_SAVE_DESC = [
  "把一条**长期有效**的事实或偏好存进用户的「记忆」；之后每次对话都会自动带上。",
  "只在用户明确要求「记住」「以后都按这个来」时使用。",
  "不要存一次性的任务内容、也不要存模型的推测。",
].join("");

export const MEMORY_SAVE_INPUT = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(MEMORY_TEXT_LIMIT)
    .describe(`要记住的内容，一句话（最多 ${MEMORY_TEXT_LIMIT} 字）`),
});

export const MEMORY_LIST_DESC = "列出当前记住的全部条目（每条一句）。";
export const MEMORY_LIST_INPUT = z.object({});

export const SCHEDULE_CREATE_TOOL = "schedule_create";
export const SCHEDULE_LIST_TOOL = "schedule_list";

/**
 * 「建定时任务」的说明。
 *
 * 依据：本体技能面板里就有这条命令（`shot-skills-panel-2.png` 的「定时任务
 * 创建、查看、更新或删除定时任务」）—— 也就是说它的 agent 真能做这件事。
 *
 * ⚠️ 说明里写清"只在用户明确要求定时/提醒时用"：定时任务是**会反复自己跑**的东西，
 * 被模型随手建一个的后果比写错一条记忆严重得多。
 */
export const SCHEDULE_CREATE_DESC = [
  "创建一个定时任务：到点按 `prompt` 自动跑一次。",
  "只在用户**明确要求**定时/提醒/每天/每周做某事时使用。",
  "标题写短（像任务名），prompt 写清到时候要做什么。",
].join("");

/** 重复方式的值表 —— **从 `./schedule` 转出**（审计 P58：原来这里另有一份同名数组，迟早漏改一处）。 */
export { REPEAT_VALUES };

export const SCHEDULE_CREATE_INPUT = z.object({
  title: z.string().trim().min(1).max(30).describe("任务标题，短一些，例如「每日行业新闻」"),
  prompt: z.string().trim().min(1).max(200).describe("到点要执行的那句话，例如「汇总今天的行业新闻」"),
  repeat: z.enum(REPEAT_VALUES).describe("重复方式：noRepeat / hourly / daily / weekly / custom"),
  customMinutes: z
    .number()
    .int()
    /* 边界从 `./schedule` 来（审计 P58：原来是这里裸写的 5 与 60*24*30） */
    .min(MIN_CUSTOM_MINUTES)
    .max(MAX_CUSTOM_MINUTES)
    .optional()
    .describe(`repeat=custom 时的间隔分钟数（${MIN_CUSTOM_MINUTES} ~ ${MAX_CUSTOM_MINUTES}）`),
  /*
   * 钟点（Phase 16）。用户说「每天早上 8 点汇总」时，模型该填这两个 ——
   * 在这之前 `repeat=daily` 只能表达"从现在起每 24 小时"，配不出"每晚几点"。
   */
  atHour: z.number().int().min(0).max(23).optional().describe("repeat=daily/weekly 时的钟点（0-23）；不填＝从现在起每 24 小时"),
  atMinute: z.number().int().min(0).max(59).optional().describe("配合 atHour 的分钟（0-59，默认 0）"),
});

export const SCHEDULE_LIST_DESC = "列出已有的定时任务（标题、重复方式、下次运行时间）。";
export const SCHEDULE_LIST_INPUT = z.object({});

export const CANVAS_ADD_NODE_TOOL = "canvas_add_node";

/** 本版支持的节点类型 —— **只放字段名已核实过的两种**。 */
export const CANVAS_NODE_KINDS = ["markdown", "code"] as const;

/**
 * 「往画布加节点」的说明。
 *
 * 依据：本体技能面板里就有「创建画布」这条命令（`shot-skills-panel-2.png`）。
 *
 * ⚠️ 支持的类型**故意只有两种**：画布上每种节点的 data 字段不同
 * （`markdown` 用 `text`、`code` 用 `code`、`image` 要 url……）。
 * 只放开**已经核实过字段名**的那两种 —— 其余的等核实了再加，
 * 而不是先放出去、让模型写出一个字段名不对的节点。
 */
export const CANVAS_ADD_NODE_DESC = [
  "往画布上加一个节点。",
  "kind 只支持 markdown（文本）与 code（代码）；text 是节点内容。",
  "画布没打开时会自动打开它。用户明确要求「放到画布上」「做个画布节点」时才用。",
].join("");

export const CANVAS_ADD_NODE_INPUT = z.object({
  kind: z.enum(CANVAS_NODE_KINDS).describe("节点类型：markdown 或 code"),
  text: z.string().min(1).max(2000).describe("节点内容（Markdown 原文或代码）"),
  lang: z.string().max(20).optional().describe("kind=code 时的语言，例如 python / ts"),
});

/* ============================================================
 * 子智能体（§150）
 *
 * 依据 cline 的 `spawn_agent`：**它有自己的一份上下文**，
 * 做完只回一份**汇合摘要**（不是它整段对话），成本要能上卷到父级。
 * ============================================================ */

export const LIST_FILES_TOOL = "list_files";

/**
 * 「列文件」的说明（2026-10-14）。
 *
 * 与 `read_file` 是一对：只读会让 agent"只能处理用户报了名字的文件" ——
 * 用户问"我云盘里有哪些东西""把云盘里的文档整理成目录"时会卡住。
 * 列出来之后，"先看有什么、再决定读哪个"这条路才通。
 */
export const LIST_FILES_DESC = [
  "列出用户**云盘 / 产物 / 导出目录**里的文件（名字、大小、在哪个目录）。",
  "用户问「我有哪些文件」「帮我看看云盘里有什么」，或者你不知道该读哪个文件时用它。",
  "只列文件名与大小，**不含正文**；要看内容再对具体文件用 read_file。",
].join("");

export const LIST_FILES_INPUT = z.object({});

export const READ_FILE_TOOL = "read_file";

/**
 * 「读文件」的说明（2026-10-14）。
 *
 * ## 为什么要有这个工具
 * 在此之前，agent **看不见用户提到的任何文件**：任务里说"把云盘里的季度总结改成三行"，
 * 它手上既没有内容、也没有读文件的手段，只能编或者反问。
 * 我们自己已经有两个功能把这件需求摆在那里了 ——
 * 悬浮窗的「问问豆包」（提示词里写的是"读一下这个文件：<路径>"）与聊天里的引用/资料，
 * 都在指望"模型能自己拿到文件内容"。这一条把它补上。
 *
 * ## 边界（在 description 里对模型说清楚，它会因此少撞墙）
 * 只读**用户自己的云盘 / 产物 / 导出目录**里的文本文件（与界面上那几个目录是同一批），
 * 目录之外一律读不到；非文本、空文件、超大文件都会如实回报，不会假装读到了。
 *
 * ⚠️ 名字与参数是本机版自己定的（本体那侧没有可引用的工具名）；
 * 但"agent 得能读用户提到的文件"这件事，是我们已经发出去的功能所要求的 —— 如实记着。
 */
export const READ_FILE_DESC = [
  "读取用户**云盘 / 产物 / 导出目录**里的一个文本文件，返回它的正文。",
  "用户提到某个文件的路径、或者需要看文件内容才能完成任务时用它。",
  "路径可以是完整绝对路径，**也可以只给文件名**（会在用户的云盘/产物目录里按名字找）。",
  "只给文件名而目录里有多个同名时，会返回候选路径让你指定 —— 不会替你猜一个读。",
  `单次最多返回 ${READ_FILE_MODEL_CHARS} 字，超出会截断并注明原文长度。`,
  "目录之外的文件、二进制文件、空文件都会如实说明读不到，不要凭路径猜测内容。",
].join("");

export const READ_FILE_INPUT = z.object({
  path: z.string().trim().min(1).describe("要读的文件的绝对路径"),
});

export const WRITE_FILE_TOOL = "write_file";

/**
 * 「写文件」的说明（2026-10-14）。
 *
 * ## 为什么要有这个工具
 * `read_file` / `list_files` 之后，agent 能**看**用户的文件了，但仍然**写不了** ——
 * 于是"把云盘里的调研内容整理成一份纪要""把这几个要点存成 markdown"这类任务
 * 只能把内容吐在对话里，让用户自己复制粘贴。
 * 界面上早就有对它的期待：「从对话创建文档」、AI 文档、画布产物 ——
 * 都是"产出要落到用户能再打开的地方"，而不是留在聊天记录里。
 *
 * ## 边界（在 description 里对模型说清楚，它会因此少撞墙）
 * 只能写到用户的**云盘 / 产物 / 导出目录**（与 `read_file` 同一道墙）；
 * **默认不覆盖** —— 同名文件存在就报错，要覆盖必须显式 `overwrite: true`；
 * 只写 UTF-8 文本（图片/压缩包/音视频这类二进制格式明确拒绝）。
 *
 * ⚠️ 与 `read_file` 同一个口径：名字与参数是本机版自己定的（本体那侧没有可引用的工具名）。
 * 这条工具在**审批闸门**里声明为 **write**（`shared/permissions.ts`）——
 * 「按需确认」档下会先问一次，因为新建/覆盖是用户目录里**不可逆**的改动。
 */
export const WRITE_FILE_DESC = [
  "在用户的**云盘 / 产物 / 导出目录**里写一个文本文件（UTF-8），返回落点。",
  "适合：把整理好的内容落成一份文件（纪要 / 清单 / 报告 / 代码片段）留给他以后打开。",
  "**默认不覆盖**：已经存在同名文件时会返回失败；确实要覆盖就再调一次并把 overwrite 设成 true。",
  "只写文本：图片、压缩包、音视频这类二进制格式会被拒绝（那些要用生成或上传）。",
  `单次正文上限 ${WRITE_FILE_MODEL_BYTES} 字节（UTF-8；约 ${WRITE_FILE_MODEL_CHARS} 个汉字，一串英文能写到同样的字节数），超了先拆成几个文件。`,
  "目录之外的路径写不了；写不进去会把原因说清楚，别换个相近的路径反复试。",
].join("");

export const WRITE_FILE_INPUT = z.object({
  path: z.string().trim().min(1).describe("目标文件的绝对路径（或只给文件名，会写到云盘根目录）"),
  content: z.string().describe("要写入的正文（UTF-8 文本）"),
  overwrite: z.boolean().optional().describe("允许覆盖同名文件；不传即不允许（默认拒绝覆盖）"),
});

export const LIST_DIR_TOOL = "list_dir";

/**
 * 「看目录」的说明（2026-10-14）。
 *
 * 与 `search_files` 一起补的是同一件事：**干活之前先看清楚有什么**。
 * 原来只有 `list_files`（列云盘四个目录的顶层），想看一个项目的结构做不到。
 */
export const LIST_DIR_DESC = [
  "看一个目录的结构（缩进树，目录带 `/`、文件带大小）。",
  "第一次接触一个目录、或者不确定某个文件在哪一层时，先用它看一眼。",
  "`pattern` 可以按名字过滤（如 `*.ts` / `*.{ts,tsx}`）；`depth` 默认 2、最大 4。",
  "`.git` / `node_modules` / `dist` / `release` 这类目录**不会进去**（一次列举几十万行没有意义）。",
].join("");

export const LIST_DIR_INPUT = z.object({
  path: z.string().trim().optional().describe("要看哪个目录（绝对路径）；不传就用你授权目录的第一个"),
  depth: z.number().int().min(0).max(4).optional().describe("往下看几层，默认 2"),
  pattern: z.string().trim().optional().describe("按文件名过滤，如 *.md"),
});

export const SEARCH_FILES_TOOL = "search_files";

/**
 * 「找文件」的说明（2026-10-14）。
 *
 * 依据 opencode 的 `grep`（正则/字面量、`include` 过滤、默认 100 条上限）。
 * 它补的是"知道要找什么、但不知道在哪个文件里"这一步 ——
 * 没有它，agent 只能一个文件一个文件地 `read_file` 试，几轮就把上下文烧光了。
 */
export const SEARCH_FILES_DESC = [
  "在授权目录里按**内容**找（默认正则；`literal: true` 表示按原样文本找）。",
  "想知道「哪个文件里提到了 X」「这个函数在哪定义」时用它，比逐个 read_file 快得多。",
  "结果形如 `相对路径:行号: 那一行内容` —— 拿到路径再用 read_file / edit_file。",
  "`include` 可以只搜某类文件（如 `*.ts`）；默认最多给 100 条命中，超了会说明。",
].join("");

export const SEARCH_FILES_INPUT = z.object({
  pattern: z.string().min(1).describe("要找的内容（正则，或 literal:true 时的原样文本）"),
  path: z.string().trim().optional().describe("在哪个目录里找；不传就用你授权目录的第一个"),
  include: z.string().trim().optional().describe("只搜匹配这个文件名模式的文件，如 *.ts"),
  literal: z.boolean().optional().describe("把 pattern 当成普通文本而不是正则（默认 false）"),
  limit: z.number().int().min(1).max(1000).optional().describe("最多给多少条命中，默认 100"),
});

export const EDIT_FILE_TOOL = "edit_file";

/**
 * 「改文件」的说明（2026-10-14）。
 *
 * 依据 opencode 的 `edit`：**精确文本替换**，默认必须唯一。
 * 为什么不让它"整篇重写"：重写要先把全文读回来，中间任何一步出岔子
 * 就会把用户整个文件毁掉 —— 改一行不该有这种风险。
 */
export const EDIT_FILE_DESC = [
  "在一个**已存在的**文件里把某一段文字换成另一段（精确匹配）。",
  "改已有文件用这个，别用 write_file 整篇重写 —— 重写要先把全文抄回来，抄错一个字就毁了整个文件。",
  "`oldText` 必须与文件里**逐字一致**（空格和缩进都算），要带够上下文让它只匹配一处。",
  "默认要求唯一匹配：命中多处会失败并告诉你在哪几行；确实要全改就传 replaceAll。",
  "新建文件用 write_file；这里只改已有的。",
].join("");

export const EDIT_FILE_INPUT = z.object({
  path: z.string().trim().min(1).describe("要改的文件（绝对路径，或只给文件名）"),
  oldText: z.string().min(1).describe("要替换掉的原文（逐字，含空格与缩进）"),
  newText: z.string().describe("换成什么（空串表示删掉这段）"),
  replaceAll: z.boolean().optional().describe("替换全部命中；不传则必须唯一匹配"),
});

export const RUN_COMMAND_TOOL = "run_command";

/**
 * 「跑命令」的说明（2026-10-14）。
 *
 * 依据 opencode 的 `bash`（默认 2 分钟超时、输出留尾部、`workdir` 优先于命令里 `cd`、
 * "优先用专用工具"这句提示）。它是"agent 能干活"与"只能聊天"的分水岭：
 * 装依赖、跑测试、看环境、调用本机工具，全靠它。
 *
 * ⚠️ 说明里必须写清两件事，否则模型会反复撞墙：
 *   ① 它是**前台同步**的（没有后台任务概念），长任务要调大 timeout；
 *   ② 别写交互式命令（等输入的那种会一直挂到超时）。
 */
export const RUN_COMMAND_DESC = [
  "在本机跑一条 shell 命令，返回输出与退出码。",
  "适合：装依赖、跑测试/构建、调用命令行工具、看环境信息、用脚本批量处理文件。",
  "默认在**你授权的第一个目录**里跑；要换地方就传 workdir（比在命令里 cd 更可靠）。",
  "默认 2 分钟超时，慢的命令请自己传 timeout（毫秒，0 表示不限时）。输出太长时只保留最后 2000 行。",
  "**不要用交互式命令**（等输入的那种会一直挂到超时）；要读文件/改文件/找东西，优先用 read_file / edit_file / search_files。",
].join("");

export const RUN_COMMAND_INPUT = z.object({
  command: z.string().trim().min(1).describe("要执行的命令行"),
  workdir: z.string().trim().optional().describe("在哪个目录里执行（绝对路径）；不传就用授权目录的第一个"),
  timeout: z.number().int().min(0).optional().describe("超时毫秒数，默认 120000；0 表示不限时"),
});

export const SPAWN_AGENT_TOOL = "spawn_agent";

/**
 * 最多嵌套几层。
 *
 * **1** = 子智能体不能再派子智能体。理由：任务是"把一件独立的事办完并回报"，
 * 再往下派只会让"这件事归谁做"变模糊，而且成本会指数膨胀。
 * 这一层限制靠**不给子智能体注入 `spawn_agent`** 实现
 * （不是"注入了但会被拒" —— 那样模型会试一次才失败）。
 */
export const MAX_SUBAGENT_DEPTH = 1;

export const SPAWN_AGENT_DESC = [
  "派一个子智能体去独立办一件事，它做完回一份要点。",
  "适合：能独立完成的子任务（查一批资料、分别处理几个来源、互相独立的几件事）。",
  "不适合：与当前对话强相关的一小步 —— 那种直接自己做，别绕一层。",
  "交给它的 `task` 要**自包含**（它看不到你们这段对话）。",
].join("");

export const SPAWN_AGENT_INPUT = z.object({
  task: z.string().trim().min(1).max(500).describe("自包含的任务说明（它看不到当前对话）"),
  context: z.string().max(2000).optional().describe("需要一并交代的背景材料"),
});

/*
 * ── Phase 7.2：**一支小队**（coordinator / specialist）────────────────────
 *
 * 与 `spawn_agent` 的关系说清楚（这是**一个实现的两种入口**，不是两份实现）：
 *
 * - `spawn_agents` 是本体：一次派 N 件活，**并行**跑，各自按 AgentSpec 拿工具白名单与档位；
 * - `spawn_agent` 留作单件入口（`tasks` 只有一项）—— 模型写单个任务时更自然，
 *   而且既有日志/验收里全是这个名字，**改名会让历史记录与验收脚本一起失效**。
 *
 * ⚠️ 为什么值得多一个工具：并行是**语义上的一步**。让模型"派三次 spawn_agent"
 * 做不到并行（它得等前面回来才发下一条），而"一次说清三件事"能让三个专家同时干活。
 */
export const SPAWN_AGENTS_TOOL = "spawn_agents";

export const SPAWN_AGENTS_DESC = [
  "把一件事**拆成几件**，交给几个各有所长的专家**同时**办，然后把几份要点汇合回来。",
  "适合：互不依赖的几件事（一边查资料一边跑命令、三个来源分别读一遍）。",
  "不适合：有先后依赖的步骤 —— 那种一步步来，别硬凑成一队。",
  "每个专家只能办它那个角色的活（研究员只读、写手只写、跑命令的只跑），",
  "而且**审批闸门对它同样有效**：它会把「想做但没被批准」如实告诉你。",
  "`task` 要**自包含**（专家看不到你们这段对话）。",
].join("");

export const SPAWN_AGENTS_INPUT = z.object({
  tasks: z
    .array(
      z.object({
        agent: z.string().trim().min(1).describe("用哪个专家（researcher / writer / runner）"),
        task: z.string().trim().min(1).max(500).describe("自包含的任务说明（它看不到当前对话）"),
        context: z.string().max(2000).optional().describe("这件活要一并交代的背景材料"),
      }),
    )
    .min(1)
    .max(4)
    .describe("要同时办的几件事（最多 4 件：再多会把成本与等待时间一起放大）"),
});

/**
 * 子智能体的提示词。
 *
 * 关键要求：**只回要点报告，不要把过程复述一遍**（Factor 10 的"小上下文"）——
 * 它那几轮的完整记录如果全灌回父级，等于白折腾一层。
 *
 * @param task 任务说明
 * @param context 背景材料
 * @returns `system` 与 `user`
 */
export function subagentPrompt(task: string, context?: string): { system: string; user: string } {
  const system = [
    "你是一个**子智能体**：只办交给你这一件事，办完就回一份要点。",
    "",
    "## 回报的规矩",
    "- 只给**要点**：做了什么、结论是什么、拿到哪些具体结果（数字、名字、原文关键句）。",
    "- **不要**把过程一步步复述一遍，也不要写寒暄与客套。",
    "- 需要工具就用；工具说要用户确认的，**如实写进回报**（别假装做完了）。",
    "- 做不到就说做不到，不要编。",
  ].join("\n");
  const user = context?.trim() ? `任务：${task}\n\n交代的背景：\n${context.trim()}` : `任务：${task}`;
  return { system, user };
}

/** 子智能体回报的结构（父级据此写留痕、上卷成本）。 */
export type SubagentReport = {
  ok: boolean;
  /** 要点报告。 */
  summary: string;
  /** 用了几步（模型轮次）。 */
  steps: number;
  /** 调过哪些工具（名字，按顺序）。 */
  toolCalls: string[];
  /** 需要用户确认而**没执行**的动作（审批穿透的证据）。 */
  /**
   * 被闸门拦下、**没有执行**的调用（§176 起是结构化的：工具名 + 参数都留下）。
   */
  blocked: SubagentBlocked[];
  /** token 用量，用于成本上卷。 */
  usage?: { inputTokens?: number; outputTokens?: number };
  error?: string;
};

/*
 * ⚠️ 这张表必须放在**所有常量声明之后**（§150 踩过）：
 * 它引用了上面那些 `const`，而 `const` 只是提升不初始化 —— 放前面会在**加载时**
 * 直接抛 TDZ 错误，整个模块起不来（不是运行时才出问题）。
 *
 * **顺序即注入给模型的顺序**。
 */
/**
 * 子智能体里**被闸门拦下**的一次调用（§176）。
 *
 * ## 为什么把它做成结构化的
 *
 * 原来 `blocked` 存的是**显示用的字符串**（`describeToolResult` 的输出）——
 * 于是父级只能告诉用户「子智能体有 1 项没办成」，**却没有让它办成的办法**：
 * 字符串里没有工具名、没有参数，谁都执行不了。
 *
 * 结构化之后，父级可以把它们**挂成自己步上的待批准项**，
 * 复用 §144 那套「放行就地执行」的按钮 —— 用户点一下，那次调用就真的执行了。
 *
 * 依据 12-factor-agents 与 opencode 的做法：**跨边界的审批必须能带上下文回来**；
 * 不能因为「发生在子智能体里」就变成一条无法处置的通知。
 */
/** 小队报告的形状（只取这里用得到的部分，避免与 `engine/runtime/team.ts` 强耦合）。 */
export type TeamReportLike = {
  ok: boolean;
  summary: string;
  /** 有几个成员失败（如实报，不掩盖）。 */
  failed?: number;
  members: { agent: string; ok: boolean }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  blocked?: SubagentBlocked[];
  error?: string;
};

export type SubagentBlocked = {
  toolCallId: string;
  name: string;
  input?: unknown;
};

/**
 * 把子智能体上交的调用变成**父级步上的待批准留痕**（§176）。
 *
 * 生成的每一条都是 `pending: true` —— 界面据此给出「允许 / 拒绝」两个按钮。
 *
 * @param blocked 子智能体上交的调用
 * @param reason 它们是从哪儿来的（写进那一行，让用户知道不是本轮的调用）
 * @returns 待批准留痕
 */
export function blockedToTraces(
  blocked: readonly SubagentBlocked[] | undefined,
  reason = "子智能体想做但没被批准",
): ToolTrace[] {
  return (blocked ?? []).map((b) => ({
    toolCallId: b.toolCallId,
    name: b.name,
    ok: true,
    pending: true,
    line: `⚙ ${toolLabel(b.name)}：${reason}（等你确认）`,
    ...(b.input === undefined ? {} : { input: b.input }),
  }));
}

/**
 * 从落盘的（不可信）数据里恢复工具留痕（§176）。
 *
 * ## 这是顺带逮到的一个真缺陷
 *
 * 步骤恢复时原来**只恢复 `id/role/text/at` 这几项，把 `tools` 整个丢了** ——
 * 于是**重启之后工具留痕全没了**。后半句更要紧：
 * 一条 `pending: true`（等用户点确认）的留痕，重启后会**消失得无影无踪** ——
 * 用户看不到它、也批不了它，而那次调用永远停在那里。
 *
 * 这与 §143/§144 的整个设计相冲：**闸门的意义就是"用户看得见并决定"**。
 *
 * ## 规矩
 *
 * 磁盘上的东西不可信（§49 那次的教训）：逐项类型检查，缺 `id` 或 `name` 的直接丢。
 *
 * @param raw 落盘的数组
 * @returns 干净的留痕
 */
export function normalizeToolTraces(raw: unknown): ToolTrace[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => {
      const name = typeof x.name === "string" ? x.name : "";
      const toolCallId = typeof x.toolCallId === "string" ? x.toolCallId : "";
      if (!name || !toolCallId) return null;
      const trace: ToolTrace = {
        toolCallId,
        name,
        ok: x.ok !== false,
        line: typeof x.line === "string" ? x.line : toolLabel(name),
        ...(x.pending === true ? { pending: true } : {}),
      };
      if ("input" in x) trace.input = x.input;
      if ("output" in x) trace.output = x.output;
      if (typeof x.error === "string") trace.error = x.error;
      return trace;
    })
    .filter((x): x is ToolTrace => x !== null);
}

/**
 * 把**新算出来的**待批准留痕并入**界面上已有的**那一份，并且**已有优先**。
 *
 * ## 为什么必须"已有优先"（C2 撞到的一个真回归）
 *
 * 留痕现在由投影算出来（`shared/sessionLog.ts`）。流式过程中每来一条 `tool-result`
 * 都会重算一次投影 —— 如果界面直接**用投影覆盖**列表，那么：
 * 用户点了「允许」→ 那条留痕被标成已执行（这是**渲染进程的状态**）→
 * 但投影里它仍然是 `pending: true`（主进程不知道谁批过）→ 下一次覆盖
 * **把「允许」抹掉、按钮又冒出来**。
 *
 * 所以合并规则是：**按 `toolCallId` 认人，界面已有的那条说了算**（它带着用户的决定），
 * 投影只负责补上"这一轮新出现的"那些。
 *
 * @param existing 界面上已有的（可能含用户已处置的）
 * @param incoming 投影刚算出来的
 * @returns 合并后的列表（顺序沿用 existing，新项追加在后）
 */
export function mergeToolTraces(existing: readonly ToolTrace[], incoming: readonly ToolTrace[]): ToolTrace[] {
  const seen = new Set(existing.map((t) => t.toolCallId));
  return [...existing, ...incoming.filter((t) => !seen.has(t.toolCallId))];
}

/*
 * ⚠️ `list_files` 曾经**不在**这张表里（它只出现在 `electron/ipc/tools.ts` 手抄的那份对象里）。
 * Phase 1 D5 把那段手抄换成"注册表直接吃这张表"之后，它当场消失了 ——
 * 而且**什么都不报**：没有类型错误、没有测试红，只是模型少了一个工具。
 * 这是"两处各写一份"最典型的代价：删掉其中一处时，另一处不会喊。
 *
 * 现在补进来，并由 `engine/runtime/registry.test.ts` 盯着"表里的都在"与"在的都不少"。
 */
export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  { name: SPAWN_AGENTS_TOOL, description: SPAWN_AGENTS_DESC, schema: SPAWN_AGENTS_INPUT },
  { name: MEMORY_SAVE_TOOL, description: MEMORY_SAVE_DESC, schema: MEMORY_SAVE_INPUT },
  { name: MEMORY_LIST_TOOL, description: MEMORY_LIST_DESC, schema: MEMORY_LIST_INPUT },
  { name: SCHEDULE_CREATE_TOOL, description: SCHEDULE_CREATE_DESC, schema: SCHEDULE_CREATE_INPUT },
  { name: SCHEDULE_LIST_TOOL, description: SCHEDULE_LIST_DESC, schema: SCHEDULE_LIST_INPUT },
  { name: CANVAS_ADD_NODE_TOOL, description: CANVAS_ADD_NODE_DESC, schema: CANVAS_ADD_NODE_INPUT },
  { name: SPAWN_AGENT_TOOL, description: SPAWN_AGENT_DESC, schema: SPAWN_AGENT_INPUT },
  { name: LIST_FILES_TOOL, description: LIST_FILES_DESC, schema: LIST_FILES_INPUT },
  { name: LIST_DIR_TOOL, description: LIST_DIR_DESC, schema: LIST_DIR_INPUT },
  { name: SEARCH_FILES_TOOL, description: SEARCH_FILES_DESC, schema: SEARCH_FILES_INPUT },
  { name: READ_FILE_TOOL, description: READ_FILE_DESC, schema: READ_FILE_INPUT },
  { name: WRITE_FILE_TOOL, description: WRITE_FILE_DESC, schema: WRITE_FILE_INPUT },
  { name: EDIT_FILE_TOOL, description: EDIT_FILE_DESC, schema: EDIT_FILE_INPUT },
  { name: RUN_COMMAND_TOOL, description: RUN_COMMAND_DESC, schema: RUN_COMMAND_INPUT },
];

/** 按名字取声明；没有就是 `undefined`（→ 走"未知工具"那条路）。 */
export function toolSpec(name: string): AgentToolSpec | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

/*
 * ⚠️ `unknownToolNotice` 搬去 `engine/core/notices.ts` 了（Phase 3.1）。
 *
 * 它是**给模型看**的错误回注，与"未知工具 / 闸门拦截 / 执行失败"是一组，
 * 三者住在一起才能保证两个宿主对同一件事说同一句话。
 * 本文件剩下的 `toolLabel` / `toolLine` / `describeToolResult` 是**给界面看**的文案，
 * 性质不同，所以留在契约层。
 */

/** 工具名 → 给人看的短标签（界面文案与测试共用一份）。 */
export function toolLabel(name: string): string {
  if (name === MEMORY_SAVE_TOOL || name === MEMORY_LIST_TOOL) return "记忆";
  if (name === SCHEDULE_CREATE_TOOL || name === SCHEDULE_LIST_TOOL) return "定时任务";
  if (name === CANVAS_ADD_NODE_TOOL) return "画布";
  if (name === SPAWN_AGENT_TOOL) return "子智能体";
  if (name === READ_FILE_TOOL) return "读文件";
  if (name === LIST_FILES_TOOL) return "列文件";
  if (name === SPAWN_AGENTS_TOOL) return "派小队";
  if (name === WRITE_FILE_TOOL) return "写文件";
  if (name === EDIT_FILE_TOOL) return "改文件";
  if (name === LIST_DIR_TOOL) return "看目录";
  if (name === SEARCH_FILES_TOOL) return "找文件";
  if (name === RUN_COMMAND_TOOL) return "跑命令";
  /*
   * 连接器（MCP）工具：标签带上**哪个连接器** ——
   * 留痕里只写"连接器"等于没说，用户要判断的是"它把这个动作交给了谁"。
   */
  if (isMcpTool(name)) {
    const parsed = parseMcpToolName(name);
    return parsed ? `连接器·${parsed.server}` : "连接器";
  }
  /* 插件工具（`plugin__<插件名>__<工具名>`）：标签带上**哪个插件**，否则看不出留痕是谁干的。
     前缀与 `engine/runtime/plugins.ts` 的 `pluginToolName` 一致（那边生名、这边认名）。 */
  if (name.startsWith("plugin__")) {
    const rest = name.slice("plugin__".length);
    const at = rest.indexOf("__");
    const plugin = at > 0 ? rest.slice(0, at) : rest;
    return plugin ? `插件·${plugin}` : "插件";
  }
  return name;
}

/**
 * 把一次工具调用压成界面上的一行小字（**行内展示**，不抢正文）。
 *
 * 为什么要在界面上留一行：模型"调了工具"这件事用户应当看得见 ——
 * 否则"记忆被写进去了"就成了暗箱操作。这与本项目反复清的
 * "看着有、其实没用"是**反过来的**要求：**真做了的事要看得出来**。
 */
export function toolLine(name: string, ok: boolean, detail?: string): string {
  const label = toolLabel(name);
  if (!ok) return `⚙ ${label}失败${detail ? `：${detail}` : ""}`;
  // 成功时**必须有分隔**：写成「⚙ 记忆已完成」会黏成一坨（测试逮到过）
  return `⚙ ${label}：${detail ?? "已完成"}`;
}

/**
 * 把一次工具调用的**结果**压成一小段可读文本（给模型看、也给界面看）。
 *
 * 为什么不直接把 JSON 塞给用户：工具结果是机器字段（`{ok,count,note}`），
 * 界面上要的是"记住了 3 条"。这里做一次，界面与测试共用同一份措辞。
 *
 * @param name 工具名
 * @param ok 成功与否
 * @param output 原始结果（成功时）
 * @param error 错误信息（失败时）
 * @returns 一行文本
 */
/**
 * 把工具**收到的参数**说成一小句（§175）。
 *
 * ## 为什么需要它
 *
 * 原来留痕只写"结果"：`⚙ 记忆：已保存，当前 3 条`。
 * 看的人立刻会问一句：**"它把什么记进去了？"** —— 而那个答案只在参数里。
 *
 * 参数是 AI SDK 在 `tool-call` 事件里给的（`part.input`），本来就拿得到；
 * 缺的只是有人把它说出来。
 *
 * ## 有边界
 *
 * 每个工具**自己**决定说哪一部分（见下面），**猜不出来就什么都不说** ——
 * 不硬编一句"已执行"糊过去（那等于把"看得见"又变回"看不见"）。
 *
 * @param name 工具名
 * @param input 模型给的参数（形状不可信，一律当 `unknown` 处理）
 * @returns 一小句；说不出来给空串
 */
export function toolArgsSummary(name: string, input: unknown): string {
  const cut = (value: unknown, n: number): string => {
    const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!text) return "";
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  const obj = (input ?? {}) as Record<string, unknown>;

  if (name === MEMORY_SAVE_TOOL) {
    const text = cut(obj.text, 40);
    return text ? `写入「${text}」` : "";
  }
  if (name === SCHEDULE_CREATE_TOOL) {
    const title = cut(obj.title, 24);
    return title ? `「${title}」` : "";
  }
  if (name === CANVAS_ADD_NODE_TOOL) {
    const kind = obj.kind === "code" ? "代码节点" : obj.kind === "markdown" ? "文本节点" : "";
    /* 真入参是 `text`（`CANVAS_ADD_NODE_INPUT`）；原来读的是不存在的 `title`，审批卡片只剩四个字（P55）。
       `title`/`content` 只作旧名兼容（有份按旧名钉着的用例在 src/workbench，不在本轮范围）。 */
    const what = cut(obj.text ?? obj.title ?? obj.content, 24);
    if (kind && what) return `${kind}「${what}」`;
    return kind;
  }
  if (name === SPAWN_AGENT_TOOL) {
    const task = cut(obj.task, 40);
    return task ? `任务：${task}` : "";
  }
  if (isMcpTool(name)) {
    /*
     * ⭐ 连接器工具的留痕要显示**参数全文**（截断到 120 字）：
     * 审批卡片上这是唯一能让用户判断"要不要让它把这个动作发出去"的东西。
     * 只写"调用连接器"等于让人在黑箱上点同意。
     */
    const args = cut(JSON.stringify(obj ?? {}), 120);
    return args && args !== "{}" ? args : "";
  }
  if (name === RUN_COMMAND_TOOL) {
    /*
     * ⭐ 命令**原文**必须出现在留痕里（截到 80 字）：这是审批卡片上唯一能让人
     * 判断"要不要让它跑"的东西。只写"跑命令"三个字，等于让用户在黑箱上点同意。
     */
    const cmd = cut(obj.command, 80);
    const dir = typeof obj.workdir === "string" && obj.workdir.trim() ? ` @${cut(obj.workdir, 40)}` : "";
    return cmd ? `${cmd}${dir}` : "";
  }
  if (name === SEARCH_FILES_TOOL) {
    const what = cut(obj.pattern, 40);
    const inc = typeof obj.include === "string" && obj.include.trim() ? `（只看 ${cut(obj.include, 20)}）` : "";
    return what ? `找「${what}」${inc}` : "";
  }
  if (name === LIST_DIR_TOOL) {
    const where = cut(obj.path, 60);
    return where ? `看「${where}」` : "";
  }
  if (name === EDIT_FILE_TOOL) {
    const raw = cut(obj.path, 80);
    const file = raw ? (raw.split(/[\\/]/).pop() ?? "") : "";
    if (!file) return "";
    return obj.replaceAll === true ? `全改「${file}」` : `改「${file}」`;
  }
  if (name === WRITE_FILE_TOOL) {
    /*
     * 写文件的留痕要说清**写哪儿**：光写"写文件"等于什么都没说 ——
     * 用户最关心的正是"它要动我哪个文件"，而这在**批准之前**就得看得见。
     *
     * ⚠️ 自己切最后一段，不用 `node:path`：这个模块**也打进渲染层**，
     * 在那边 `node:path` 是拿不到的（`shared/` 不许依赖 node 内建）。
     */
    const raw = cut(obj.path, 80);
    const file = raw ? (raw.split(/[\\/]/).pop() ?? "") : "";
    const n = typeof obj.content === "string" ? obj.content.length : 0;
    if (!file) return "";
    return obj.overwrite === true ? `覆盖「${file}」（${n} 字）` : `「${file}」（${n} 字）`;
  }
  // 其余工具没有值得说的参数（`memory_list` / `schedule_list` 之类）
  return "";
}

export function describeToolResult(
  name: string,
  ok: boolean,
  output?: unknown,
  error?: string,
  input?: unknown,
): string {
  /*
   * 参数摘要挂在**末尾**（§175）：结果在前、参数在后。
   * `（…）`包起来，读起来是"补一句它刚才传了什么"，
   * 而且**不改变**原来的那些断言（没给 input 时一个字符都不变）。
   */
  const withArgs = (line: string): string => {
    const args = toolArgsSummary(name, input);
    return args ? `${line}（${args}）` : line;
  };
  if (!ok) return withArgs(toolLine(name, false, error?.slice(0, 60)));
  /*
   * 被审批闸门拦下（§143）：**没执行**，在等用户点确认。
   * 这一条必须与"已完成"长得明显不同 —— 否则用户会以为事已经做完了。
   */
  const pending = output as { pending?: boolean } | undefined;
  if (pending?.pending) return withArgs(`⚙ ${toolLabel(name)}：等你确认（还没执行）`);
  /*
   * 连接器（MCP）工具：**结果由服务端说了算**（2026-10-14）。
   *
   * 特别要注意 `output.ok === false`：服务端把这次调用标成了失败（`isError`），
   * 但"工具跑到了"这件事是成立的 —— 所以外层的 `ok` 是 true。
   * 留痕必须按**服务端的结果**写"报错"，否则界面上会显示"已完成"，
   * 而模型那边拿到的是失败（这正是"界面与真相分叉"的那种毛病）。
   */
  if (isMcpTool(name)) {
    const o = output as { ok?: boolean; error?: string } | undefined;
    const parsed = parseMcpToolName(name);
    const who = parsed ? `${parsed.server} · ${parsed.tool}` : name;
    if (o?.ok === false) return withArgs(`⚙ 连接器报错：${who}${o.error ? `：${String(o.error).slice(0, 60)}` : ""}`);
    return withArgs(`⚙ 连接器已执行：${who}`);
  }
  if (name === MEMORY_SAVE_TOOL) {
    const o = output as { count?: number; note?: string } | undefined;
    if (o?.note) return withArgs(toolLine(name, true, o.note));
    const n = typeof o?.count === "number" ? o.count : undefined;
    return withArgs(toolLine(name, true, n === undefined ? "已保存" : `已保存，当前 ${n} 条`));
  }
  if (name === MEMORY_LIST_TOOL) {
    const o = output as { count?: number } | undefined;
    return withArgs(toolLine(name, true, `当前 ${typeof o?.count === "number" ? o.count : 0} 条`));
  }
  if (name === SCHEDULE_CREATE_TOOL) {
    const o = output as { title?: string; next?: string } | undefined;
    if (o?.title) return withArgs(toolLine(name, true, `已创建「${o.title}」${o.next ? `，下次 ${o.next}` : ""}`));
    return withArgs(toolLine(name, true, "已创建"));
  }
  if (name === SCHEDULE_LIST_TOOL) {
    const o = output as { count?: number } | undefined;
    return withArgs(toolLine(name, true, `当前 ${typeof o?.count === "number" ? o.count : 0} 条`));
  }
  if (name === CANVAS_ADD_NODE_TOOL) {
    const o = output as { kind?: string; opened?: boolean } | undefined;
    const what = o?.kind === "code" ? "代码节点" : "文本节点";
    return withArgs(toolLine(name, true, `已在画布上放了一个${what}${o?.opened ? "（并打开了画布）" : ""}`));
  }
  if (name.startsWith("plugin__")) {
    /*
     * 插件工具：文档一直承诺「`output.line` 就是界面上那一行留痕」，而这里原来没有分支，
     * 界面永远只显示「已完成」（审计 P205）。落进来的是插件自己那份 `{ ok, output: { line } }`
     * （宿主套信封、registry 剥外层两跳）。用前缀判而不 import `isPluginTool`：那个在 engine，
     * shared 不许依赖 engine。由 `src/pluginSamples.test.ts ③` 钉着。
     */
    const o = output as { ok?: boolean; output?: { line?: unknown }; error?: unknown } | undefined;
    if (o?.ok === false) return withArgs(toolLine(name, false, typeof o.error === "string" ? o.error.slice(0, 60) : undefined));
    const line = typeof o?.output?.line === "string" ? o.output.line.trim().slice(0, 80) : "";
    return withArgs(toolLine(name, true, line || undefined));
  }
  if (name === SPAWN_AGENT_TOOL) {
    const o = output as Partial<SubagentReport> | undefined;
    if (!o?.ok) return withArgs(toolLine(name, false, o?.error ?? "子智能体没有完成"));
    // 成本上卷：把子智能体用掉的 token 写在留痕里（用户看得见这一层花了多少）
    const tokens = (o.usage?.inputTokens ?? 0) + (o.usage?.outputTokens ?? 0);
    const cost = tokens ? `，约 ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : "";
    const blocked = o.blocked?.length ? `，${o.blocked.length} 项等你确认` : "";
    return withArgs(toolLine(name, true, `完成（${o.steps ?? 0} 步${cost}${blocked}）`));
  }
  if (name === SPAWN_AGENTS_TOOL) {
    const o = output as Partial<TeamReportLike> | undefined;
    if (!o?.members?.length) return withArgs(toolLine(name, false, o?.error ?? "小队没有跑起来"));
    /*
     * 留痕要说清**几件事、成了几件、花了多少**：
     * - "3 个专家"是用户最想知道的规模；
     * - 有失败就**明写几件失败**（不掩盖 —— 失败的那件在正文报告里也有）；
     * - token 上卷（与单个子智能体同一口径，用户看得见这一层花了多少）。
     */
    const total = o.members.length;
    const failed = o.failed ?? o.members.filter((m) => !m.ok).length;
    const tokens = (o.usage?.inputTokens ?? 0) + (o.usage?.outputTokens ?? 0);
    const cost = tokens ? `，约 ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : "";
    const blocked = o.blocked?.length ? `，${o.blocked.length} 项等你确认` : "";
    const bad = failed ? `，${failed} 个失败` : "";
    return withArgs(toolLine(name, failed === 0, `${total} 个专家${bad}${cost}${blocked}`));
  }
  return withArgs(toolLine(name, true));
}

/**
 * 工具调用在**这一步**上的留痕（step 事件化）。
 *
 * 依据 `docs/优化计划.md` 批次 1：一次模型调用 + 该步工具执行 = 一个 step，
 * 记下 `{工具名, 成败, 结果}`。回滚、快照、压缩以后都挂在这个粒度上。
 */
export type ToolTrace = {
  /**
   * AI SDK 给这次调用分配的 id。
   *
   * ⚠️ **必须记**（§144）：一次回复里可能有多**次**工具调用（实测确实会）。
   * 界面上要"放行其中某一次"时，只能按 id 找 —— 按工具名找会放行错那一次。
   */
  toolCallId: string;
  name: string;
  ok: boolean;
  /** 界面上那一行小字。 */
  line: string;
  /** 被审批闸门拦下、在等用户确认（此时**没有执行**）。 */
  pending?: boolean;
  /** 模型给的参数（原样保留：放行时要原样执行，也方便排错看出它传了什么）。 */
  input?: unknown;
  output?: unknown;
  error?: string;
};

/** 用户点了「拒绝」时那一条留痕的文案。 */
export function rejectedLine(name: string): string {
  return `⚙ ${toolLabel(name)}：你已拒绝`;
}

