/**
 * MCP（Model Context Protocol）连接的**纯逻辑**（2026-10-14）。
 *
 * ## 为什么补它（对照参考实现的自问）
 *
 * goose 的 README 写着"接 70+ 扩展，走 MCP 这个开放标准"；opencode 的文档把
 * "MCP server"列为**第二种工具来源**。我们这边原本一个都没有 ——
 * 也就是说：**别人家的能力可以无限接，我们只能用它自己长出来的 13 个工具。**
 * 这是差距里最实的一条，不是界面问题。
 *
 * ## 与产品里那个空占位的关系
 *
 * 插件页「管理」下有个 **连接器** 页签，一直写着"本机版不含连接器体系"。
 * MCP server **就是**连接器：一条命令 + 参数，连上之后它把自己的工具交出来。
 * 所以这一轮把那个占位换成真的。
 *
 * ## 这一层只管"形状"，不管进程
 * 起进程、握手、调用都在主进程（`electron/ipc/mcpClient.ts`）——
 * 这里只做配置的规整与命名，好让它能在 vitest 里被直接断言。
 */

/** 工具名前缀：`mcp__<server>__<tool>`。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 一个 MCP server 的配置。 */
export type McpServerConfig = {
  /** 短名（进工具名，所以只允许 `[a-z0-9_-]`）。 */
  name: string;
  /** 命令（可执行文件）。 */
  command: string;
  /** 传给命令的参数。 */
  args?: string[];
  /** 额外的环境变量。 */
  env?: Record<string, string>;
  /** `false` = 保留配置但不连接。 */
  enabled?: boolean;
};

/** 落盘形状。 */
export type McpConfig = { servers: McpServerConfig[] };

/** 最多连几个（连太多会让每次请求的工具定义膨胀，也会拖慢启动）。 */
export const MAX_MCP_SERVERS = 8;

/** 文案（本机自定：证据里没有 MCP 的界面文案 —— 连接器那个页签只有"还没有添加连接器"）。 */
export const MCP_LABELS = {
  empty: "还没有连接器 —— 在配置文件里加一个 MCP server，它就会把自己的工具交给 agent",
  openConfig: "打开配置文件",
  reload: "重新连接",
  /** 工具数那行的前缀 */
  tools: "提供",
  status: {
    on: "已连接",
    off: "未启用",
    error: "连接失败",
    starting: "连接中…",
  },
} as const;

export function emptyMcpConfig(): McpConfig {
  return { servers: [] };
}

/** 名字合法吗（它会进工具名，所以只允许安全字符）。 */
export function isValidServerName(name: string): boolean {
  return /^[a-z0-9_-]{1,24}$/.test(name);
}

/**
 * 从磁盘读回来的东西一律不可信。
 *
 * 规矩与其它 store 一致：**坏值兜成空表**，不许把界面或工具集搞崩。
 * 名字不合法的直接丢掉（否则工具名会长出奇怪的东西）。
 */
export function normalizeMcpConfig(raw: unknown): McpConfig {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { servers?: unknown }).servers)
      ? (raw as { servers: unknown[] }).servers
      : [];
  const seen = new Set<string>();
  /** 塌缩之后的短名（`-` 与 `_` 会撞成同一个）——工具名的实际碰撞面。 */
  const seenLocal = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const command = typeof o.command === "string" ? o.command.trim() : "";
    if (!isValidServerName(name) || !command) continue;
    /*
     * ⚠️ 去掉的是两种"重复"（审计 P07）：
     *   · **同名**（原样重复）；
     *   · **塌缩后同名** —— `sanitize` 把 `-` 换成 `_`，于是 `my-server` 与 `my_server`
     *     会生成**同一个** `mcp__…__…` 工具名。工具名撞了之后的后果现在可钉死：
     *     `engine/runtime/registry.ts` 的 `byName.set` 是后写覆盖（模型看到最后一个连接器的
     *     schema），而 `electron/ipc/mcpStore.ts` 的调用路由取第一条 —— 名字一样、两边指向不同。
     * （同一个连接器内部两个工具名塌缩后相同那一种还没收口：那要在装配工具表的地方按
     *  `(server, tool)` 去重，属 `electron/ipc/mcpStore.ts`，不在本轮范围，如实记。）
     */
    const local = sanitize(name);
    if (seen.has(name) || seenLocal.has(local)) continue;
    seen.add(name);
    seenLocal.add(local);
    const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : undefined;
    const env =
      o.env && typeof o.env === "object" && !Array.isArray(o.env)
        ? Object.fromEntries(
            Object.entries(o.env as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
          ) as Record<string, string>
        : undefined;
    servers.push({
      name,
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      ...(o.enabled === false ? { enabled: false } : {}),
    });
    if (servers.length >= MAX_MCP_SERVERS) break;
  }
  return { servers };
}

/** 把一段文本里的非法字符换成下划线（工具名要能安全地出现在各处）。 */
function sanitize(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/**
 * MCP 工具在本机工具集里的名字。
 *
 * `mcp__<server>__<tool>`：前缀一眼能认出"这是外部来的"（闸门要按这个区分对待），
 * 双下划线分隔是因为 MCP 工具名自己常带单下划线（`read_file` 之类）。
 *
 * @param server server 短名
 * @param tool 该 server 给的工具名
 * @returns 本机用的工具名
 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitize(server)}__${sanitize(tool)}`;
}

/** 反过来：本机工具名 → server 与原始工具名。（认不出来返回 null。） */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0 || at >= rest.length - 2) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

/** 是不是 MCP 工具（闸门按这个判断"要不要按外部工具对待"）。 */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * 这个工具在当前状态下该不该注入给模型。
 *
 * @param server 配置
 * @param connected 是否已连上
 * @returns 该不该把它的工具交给模型
 */
export function serverUsable(server: McpServerConfig, connected: boolean): boolean {
  return server.enabled !== false && connected;
}

/**
 * 给界面用的一句话：这个 server 现在什么状态。
 *
 * @param server 配置
 * @param status 连接状态
 * @param toolCount 它给了几个工具
 * @returns 中文短句
 */
export function serverStatusLine(
  server: McpServerConfig,
  status: "on" | "off" | "error" | "starting",
  toolCount: number,
): string {
  if (server.enabled === false) return MCP_LABELS.status.off;
  if (status === "error") return MCP_LABELS.status.error;
  if (status === "starting") return MCP_LABELS.status.starting;
  return `${MCP_LABELS.status.on} · ${MCP_LABELS.tools} ${toolCount} 个工具`;
}
