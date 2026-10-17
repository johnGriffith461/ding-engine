/**
 * 审批闸门的**判定层**（§143，优化计划批次 2；Phase 1 D5 内迁进内核）。
 *
 * ## 为什么要有这一层
 *
 * 输入区那个 chip（「全部允许 / 按需确认 / 每步确认」）**早就画在那里了**，
 * 但全文没有任何地方读它 —— 也就是说它是个**装饰**：标签在承诺一道闸，而闸不存在。
 *
 * 研究结论（`docs/research-B-permission-subagent.md`）给的形态很明确：
 * ⚠️（该依据未入库、本机也找不到 —— 决策链断在这里，无法复核；以本文件里的断言与实现为准）
 * - 策略**按工具名**声明（Cline 的 `toolPolicies`）；
 * - **未声明的默认放行**，需要复核的必须显式收紧；
 * - 粒度是**每次工具调用**，不是全局开关；
 * - 关掉一个工具 = **让它从模型视野里消失**（`enabled:false`），
 *   而不是让模型反复调用然后被拒。
 *
 * ## 判定只有三种结果
 *
 * | 结果 | 含义 |
 * |---|---|
 * | `run` | 直接执行（今天的行为） |
 * | `ask` | **不执行**，把这次调用交给用户确认 |
 * | `hide` | 工具根本不注入给模型（它看不到，也就不会试） |
 *
 * ⚠️ **档位词表在契约里**（`shared/ipc.ts` 的 `CONFIRM_MODES` / `ConfirmMode`）：
 * 它出现在跨进程字段上，"有哪些档位"是界面与内核都要认的同一份。
 * 这里管的是**策略**："这个档位下，这个工具该 run / ask / hide"。
 */
import { MCP_TOOL_PREFIX } from "../../shared/mcp";
import { isPluginTool } from "../runtime/plugins";
import type { ConfirmMode } from "../../shared/ipc";
import { rolesOf, type MemberRole } from "./members";

/** 工具的读写性质 —— 决定"按需确认"档要不要拦它。 */
export type ToolKind = "read" | "write";

export type ToolPolicy = {
  kind: ToolKind;
  /** `false` = 从注入列表里去掉（模型看不到）。省略即启用。 */
  enabled?: boolean;
};

/**
 * 策略表。
 *
 * **未列出的工具默认按 `read` 放行** —— 与 Cline 一致：需要复核的必须显式声明。
 * 这个默认是有意的：加新工具时"忘了声明"应当表现为**照常能用**，
 * 而不是"悄悄变成一个必须点确认的卡"（后者会让人以为产品坏了）。
 */
export const TOOL_POLICY: Record<string, ToolPolicy> = {
  memory_save: { kind: "write" },
  memory_list: { kind: "read" },
  /*
   * 定时任务是**会反复自己跑**的东西（写类）—— 放到"按需确认"档里必须问。
   * 顺手说明为什么"按需确认"这一档有意义：它拦的正是这类**有后续影响**的动作，
   * 而不是把只读查询也一起拦下（那样每次都点确认，闸很快就被人无视）。
   */
  schedule_create: { kind: "write" },
  schedule_list: { kind: "read" },
  // 往画布加节点也是写（会改用户的画布内容）
  canvas_add_node: { kind: "write" },
  /*
   * 派子智能体算**写**：它会花一次真实的模型调用（成本），而且能做一串动作。
   * 所以「按需确认」档下要问一次 —— 用户同意的是"花这笔钱去办这件事"。
   *
   * ⚠️ 注意这不替代子智能体内部的闸门：它自己那套工具**照样按同一个档位判**
   * （审批穿透）。两层是叠加的，不是二选一。
   */
  spawn_agent: { kind: "write" },
  /*
   * 一支小队同样是**写**：它会花**几倍**的模型调用（并行几个专家），
   * 而且专家里有能写盘、能跑命令的角色。所以「按需确认」档下要问一次 ——
   * 用户同意的是"花这笔钱、并且让这几个角色动手"。
   */
  spawn_agents: { kind: "write" },
  /*
   * 读文件是**只读**：它不改用户的任何东西，只是把用户自己目录里的文本念给模型听。
   * 所以「按需确认」档下不拦（拦就变成"看一眼文件都要点一次确认"，闸很快会被无视）；
   * 「每步确认」档下当然还是问（那一档的定义就是无论读写都要问）。
   *
   * ⚠️ 显式写出来而不是靠"默认 read"：这条策略表**加工具时必须逐条声明**
   * （`permissions.test.ts` 盯着这件事）—— 默认放行是个便利，不是让人省掉声明的理由。
   */
  read_file: { kind: "read" },
  /* 列文件同样是只读（只读文件名与大小，不读正文）。 */
  list_files: { kind: "read" },
  /*
   * 写文件是**写**，而且是这里最"硬"的一个写：
   * `memory_save` 写的是本产品自己的记忆库、`canvas_add_node` 改的是画布，
   * 而这一条**在用户的文件目录里建/覆盖真文件** —— 覆盖是不可逆的。
   * 所以「按需确认」档下必须问一次，而且**不能**像 `read_file` 那样走"默认只读放行"。
   */
  write_file: { kind: "write" },
  /* 看目录只读（只是把目录结构念出来）。 */
  list_dir: { kind: "read" },
  /* 找文件只读（读文件内容来匹配，但不写任何东西）。 */
  search_files: { kind: "read" },
  /* 改文件是写：它直接改用户磁盘上的文件，而且改的是**已有内容**（比新建更容易毁东西）。 */
  edit_file: { kind: "write" },
  /*
   * ⭐ 跑命令是这张表里**最重**的一条 —— 它不是"改某个文件"，而是把 shell 交出去：
   * 能做用户在这台机器上能做的一切（装东西、删东西、联网）。
   *
   * 所以「按需确认」档下必须问，而且这是**唯一**能让用户看见"要跑什么"的机会
   * （审批卡片上的参数摘要就是命令原文，见 `toolArgsSummary`）。
   * 说明：我们**没有**做真正的沙箱（主进程与渲染进程同权限），
   * 真隔离要靠系统级手段 —— 这是如实记下的边界，不是"已经有了"。
   */
  run_command: { kind: "write" },
};

/** 取一个工具的策略；没声明就当只读。 */
export function policyOf(name: string): ToolPolicy {
  /*
   * ⭐ **连接器（MCP）来的工具，默认按「写」对待**（2026-10-14）。
   *
   * 这条**故意违反**上面"未声明默认只读"的便利：
   * 那张表能默认放行，是因为**我们自己写的工具我们知道它干什么**；
   * 而 MCP 工具是**别人写的进程**，名字之下可能是读、也可能是删库、
   * 发邮件、下单 —— 我们**不知道**。对不知道的东西默认放行，
   * 等于把"按需确认"这道闸对最有风险的一类工具有效地关掉。
   *
   * 「按需确认」档下它们会被问一次，而审批卡片上会显示**要发给哪个连接器的什么参数**
   * （见 `shared/agentTools.ts` 的 `toolArgsSummary`）。
   *
   * 「全部允许」档下它们照样直接跑 —— 那一档的定义就是"用户说他都同意"。
   *
   * ⭐ **插件来的工具同理**（2026-10-16，审计 P02）。
   *
   * 这里原来是**同一个洞的另一半**：`plugin__` 前缀的工具名不在 `TOOL_POLICY` 表里，
   * 于是掉到本函数最后那行「默认只读」—— 同一份风险（别人写的代码、名字之下
   * 可能是读也可能是删库）在 MCP 那侧被按「写」拦住，在插件这侧却直接放行。
   * 两道闸对同一件事给出两种判定，弱的那个就是实际生效的那个。
   *
   * 前缀常量不在这里重抄一遍：`plugin__` 的拼法是 `plugins.ts` 的 `pluginToolName` 定的，
   * 抄一份到策略层迟早漂 —— 直接问那个模块。
   */
  if (name.startsWith(MCP_TOOL_PREFIX) || isPluginTool(name)) return { kind: "write" };
  return TOOL_POLICY[name] ?? { kind: "read" };
}

/** 一次判定的结果。 */
export type Verdict = "run" | "ask" | "hide";

/**
 * 判定一次工具调用。
 *
 * @param mode 用户选的档位
 * @param name 工具名
 * @returns `run` / `ask` / `hide`
 */
export function decide(mode: ConfirmMode, name: string): Verdict {
  const policy = policyOf(name);
  // 关掉的工具在任何档位下都不注入 —— 这是"关掉"的正确含义
  if (policy.enabled === false) return "hide";
  if (mode === "全部允许") return "run";
  // 每步确认：无论读写都要问
  if (mode === "每步确认") return "ask";
  // 按需确认：只拦会改东西的
  return policy.kind === "write" ? "ask" : "run";
}

/**
 * 该档位下**应当注入给模型**的工具名。
 *
 * `hide` 的不在这里 —— 注意区别：不是"注入了但会被拒"，而是**模型看不到**。
 * 这个区别有实际意义：模型看不到就不会在回复里说"我去调用 xxx"然后失败。
 *
 * @param mode 档位
 * @param all 全部工具名
 * @returns 要注入的名字（保持原顺序）
 */
export function injectableTools(mode: ConfirmMode, all: readonly string[]): string[] {
  return all.filter((name) => decide(mode, name) !== "hide");
}

/* ============================================================
 * 人轴：成员角色（C2，V5-1 3.6b / 3.6c）
 * ============================================================ */

/** 两轴叠加之后的一次判定。 */
export type MemberDecision =
  | { verdict: "run" }
  | { verdict: "ask" }
  | { verdict: "hide" }
  /** 工具轴这边会放行/待批，但**这个人**没这个权限 —— 直接拒（并回注人话）。 */
  | { verdict: "deny"; notice: string };

/**
 * **两轴叠加矩阵**（ADR-007 的落点，逐条在 `policy.test.ts` 里有断言）。
 *
 * | 工具轴 \ 人轴 | owner | admin | specialist | viewer |
 * |---|---|---|---|---|
 * | `hide` | hide | hide | hide | hide |
 * | 读 + `run` | run | run | run | run |
 * | 读 + `ask` | ask | ask | ask | ask |
 * | 写 + `run` | run | run | run | **deny** |
 * | 写 + `ask` | ask | ask | ask | **deny** |
 *
 * 三句话概括这张表（ADR-007 里的"为什么"就是它们）：
 *
 * · **角色是上限，档位是旋钮**：档位只能在角色允许的范围内收紧或放松。
 *   所以 viewer 的写操作在「全部允许」档下**也拒** —— 那一档说的是"我信这个模型"，
 *   不是"改写文件的人是谁"。
 * · **hide 与角色无关**：工具没注入给模型，跟"谁在用"没关系（模型根本不知道它存在）。
 * · **读不受人轴影响**：只读操作对任何角色都一样（拦它只会让只读成员什么都干不了）。
 *
 * @param member 发起人（`undefined` = **不知道是谁** —— 本机单用户阶段按 owner 处理；
 *   ⚠️ V5-2 把成员 token 映射接上之后，"未认证/查不到"一律按 **viewer** 处理，
 *   那是多用户系统的安全默认 —— 这条边界记在 ADR-007 里，别混）
 * @param mode 工具档位
 * @param name 工具名
 * @returns 判定（`deny` 带一句给模型的回注）
 */
export function decideForMember(
  member: { roles: readonly MemberRole[] } | undefined,
  mode: ConfirmMode,
  name: string,
): MemberDecision {
  const tool = decide(mode, name);
  if (tool === "hide") return { verdict: "hide" };
  /* 不知道是谁（本机单用户）= owner：老路径一字不变 */
  const roles: readonly MemberRole[] = member ? rolesOf(member) : ["owner"];
  /* "只读成员" = 只有 viewer 这一个角色（多角色是并集，带 admin 的人当然能写） */
  const onlyViewer = roles.length === 1 && roles[0] === "viewer";
  if (onlyViewer && policyOf(name).kind === "write") {
    /*
     * ⭐ 这张表最有产品含义的一格（V5 §3.6 举的例子）：viewer 的写操作
     * **直接拒**，不是"交给有权限的人批"。理由两条：
     *   ① 让只读成员去点一个"允许"按钮，点了也不该生效 —— 那是把权限问题
     *      伪装成审批问题（用户会以为"批了就能做"）；
     *   ② 模型该**尽早**知道这条路走不通（错误即结果，Factor 9），
     *      而不是花一轮去等一个不会成立的批准。
     */
    return { verdict: "deny", notice: viewerDeniedNotice(name) };
  }
  return { verdict: tool };
}

/**
 * 「只读成员被拒」的那句话（给模型看的回注）。
 *
 * 为什么写这么直接：模型看到"被拒"之后**能做对的事**只有两件 ——
 * 停下、或者把这件事交给有权限的人。所以这句话要同时说清"为什么"与"下一步"。
 */
export function viewerDeniedNotice(name: string): string {
  return (
    `「${name}」需要写权限，而当前成员是**只读成员**（viewer）：这次调用**没有执行**，直接拒绝。` +
    `请不要重试；把这件事交给所有者/管理员，或请他们给这个成员相应的角色。`
  );
}

/*
 * ⚠️ `normalizeConfirmMode` 搬到契约里了（`shared/ipc.ts`）—— 它只是"读回来的值
 * 是不是那三个档位之一"，属于词表的守卫，不属于策略判定。
 */

/*
 * ⚠️ `pendingApprovalNotice` 搬去 `engine/core/notices.ts` 了（Phase 3.1）——
 * 与"未知工具 / 执行失败"是一组（Factor 9 的错误回注三件套），
 * 三者住在一起，两个宿主才不会对同一件事说两样的话。
 */
