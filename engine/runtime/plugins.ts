/**
 * **插件清单与校验**（Phase 8.1）。
 *
 * ## 一句话哲学（沿用闸门那条）
 *
 * > **看不到就不会试** —— 未声明的能力**不予注入**。
 *
 * 插件的 manifest 里没声明 `hooks:register`，它导出的钩子就**不会被调用**；
 * 没声明 `tools:register`，它的工具**不会进注册表**。这不是"注入了但拦着"，
 * 是根本没有那根线。
 *
 * ## 权限分两类（这一条是这份代码最要紧的诚实之处）
 *
 * | 类别 | 例子 | v1 是否**真的**拦得住 |
 * |---|---|---|
 * | **能力注入类** | `tools:register` / `hooks:register` | ✅ 拦得住：不给那个权限，那条线就不接 |
 * | **资源访问类** | `fs:read` / `fs:write` / `net` / `exec` | ❌ **拦不住**（v1 插件与宿主同进程、同权限） |
 *
 * ⚠️ 第二类**必须**在安装界面与文档里说清"这是声明、不是沙箱"。
 * 一个看着像权限、实际不生效的东西，比没有权限声明更坏 ——
 * 用户会据此做出错误的信任判断。方案里也写了这一条：
 * **v1 进程内执行 + 权限声明 + 安装确认；Worker / 容器隔离列 v2**。
 *
 * 那第二类为什么还要声明？因为它仍是**有用的**：安装时用户看到
 * "这个插件要读文件、要联网"，就能决定装不装 —— 那是**知情**，不是**限制**。
 */

/** 插件可以申请的能力。 */
export type PluginPermission =
  /* ── 能力注入类（v1 真的拦） ── */
  | "tools:register"
  | "hooks:register"
  /* ── 资源访问类（v1 只声明、不拦） ── */
  | "fs:read"
  | "fs:write"
  | "net"
  | "exec";

/** 全部权限（校验"有没有写错名字"时用）。 */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  "tools:register",
  "hooks:register",
  "fs:read",
  "fs:write",
  "net",
  "exec",
];

/** v1 **真的**拦得住的那两种（见文件头那张表）。 */
export const ENFORCED_PERMISSIONS: readonly PluginPermission[] = ["tools:register", "hooks:register"];

/** 生命周期点（Phase 8.3）。 */
export type HookName = "session:start" | "tool:before" | "tool:after" | "turn:end";

export const HOOK_NAMES: readonly HookName[] = ["session:start", "tool:before", "tool:after", "turn:end"];

/** 插件清单。 */
/** 发布者（`publisher` 字段）：身份是 `id`，证据是 `key`。 */
export type PluginPublisher = {
  /** 发布者 id（与插件名同一套形状：小写字母开头、小写字母/数字/连字符，2–41 字符）。 */
  id: string;
  /** 给人看的名字（可选）。 */
  name?: string;
  /** ed25519 公钥（base64 的 SPKI DER）—— 只放公钥，私钥永远不进插件。 */
  key: string;
};

export type PluginManifest = {
  name: string;
  version: string;
  description: string;
  /**
   * 它提供哪些工具（**名字**）。
   *
   * 声明与实现必须一致：声明了却没有对应导出 → 装载时报错（不静默少一个工具）。
   */
  tools?: readonly string[];
  /** 它挂在哪些生命周期点上。声明之外的钩子**不会被调用**。 */
  hooks?: readonly HookName[];
  /** 申请的权限（**必填**，可以是空数组 —— 那是"我什么权限都不要"）。 */
  permissions: readonly PluginPermission[];
  /** 兼容的宿主版本（`engines.ding`，语义化范围，例如 `>=0.2.0`）。 */
  engines: { ding: string };
  /**
   * **发布者与签名**（V5-4 4.4；可选 —— 不给就是 v1 插件，照样能装能跑）。
   *
   * 签名覆盖的是**整棵目录的文件清单**（算法在 `runtime/pluginSignature.ts`），
   * 于是"装完之后改一个字节"能被验出来。两者**必须成对**：只有 publisher 没有
   * signature（或者反过来）是清单错误 —— 单边出现的话，"有身份"与"有签名"
   * 就都能各自假装成功。
   */
  publisher?: PluginPublisher;
  /** 上面那把钥匙对文件清单的签名（base64）。 */
  signature?: string;
  /**
   * 入口文件（相对插件目录），默认 `index.mjs`。
   *
   * ⚠️ 这是我加的字段（方案里那份清单没写入口）—— 没有它就无法装载任何东西。
   * 只允许**插件目录内的相对路径**：绝对路径或 `../` 会让"装一个插件"
   * 变成"让它在任意位置执行一个文件"。
   */
  main?: string;
};

/** 校验结果。 */
export type ManifestCheck =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; errors: string[] };

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** 这个相对路径会不会跑出插件目录（绝对路径、`..`、盘符都算）。 */
function path_isEscape(p: string): boolean {
  const normalized = p.split(String.fromCharCode(92)).join("/");
  return normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").includes("..");
}

/**
 * 校验一份清单（**磁盘与网络来的东西一律不可信**）。
 *
 * ⚠️ 错误信息要**能直接给用户看**：安装失败时他看到的就是这几句，
 * 所以每一条都说清"哪个字段、错在哪、该怎么办"。
 *
 * @param raw 未知形状的输入（来自 `package.json` 的扩展字段或 `ding-plugin.json`）
 * @returns 校验结果
 */
export function checkManifest(raw: unknown): ManifestCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["清单不是一个对象"] };
  }
  const m = raw as Record<string, unknown>;

  const name = typeof m.name === "string" ? m.name.trim() : "";
  if (!NAME_RE.test(name)) {
    errors.push(`name 不合法：${JSON.stringify(m.name)}（要求小写字母开头，只含小写字母/数字/连字符，2–41 字符）`);
  }

  const version = typeof m.version === "string" ? m.version.trim() : "";
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    errors.push(`version 不合法：${JSON.stringify(m.version)}（要求语义化版本，例如 1.0.0）`);
  }

  const description = typeof m.description === "string" ? m.description.trim() : "";
  if (description.length < 8) {
    errors.push("description 太短（至少要能让人看懂这个插件干什么）");
  }

  /*
   * ⚠️ `permissions` **必填**，而且不接受"省略"。
   *
   * 允许省略的话，"这个插件要什么权限"就变成了"作者记得写没写" ——
   * 而省略与"什么都不要"在外观上完全一样。强制显式写出（哪怕是空数组），
   * 安装界面才能如实说"它没有申请任何权限"，而不是"它没说"。
   */
  if (!Array.isArray(m.permissions)) {
    errors.push("permissions 必填（可以是空数组 []，表示不申请任何权限）—— 不允许省略");
  }
  const permissions: PluginPermission[] = [];
  if (Array.isArray(m.permissions)) {
    for (const p of m.permissions) {
      if (typeof p !== "string" || !PLUGIN_PERMISSIONS.includes(p as PluginPermission)) {
        errors.push(`permissions 里有不认识的项：${JSON.stringify(p)}（可用：${PLUGIN_PERMISSIONS.join(" / ")}）`);
        continue;
      }
      permissions.push(p as PluginPermission);
    }
    if (new Set(permissions).size !== permissions.length) errors.push("permissions 有重复项");
  }

  const tools = Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  if (m.tools !== undefined && !Array.isArray(m.tools)) errors.push("tools 必须是字符串数组");
  if (tools.length && !permissions.includes("tools:register")) {
    // 声明了工具却没申请注册权限 —— 这是"作者忘了"，不是"我们替他决定"
    errors.push("声明了 tools 却没有申请 `tools:register` 权限（两者必须一致）");
  }

  const hooks: HookName[] = [];
  if (m.hooks !== undefined) {
    if (!Array.isArray(m.hooks)) errors.push("hooks 必须是字符串数组");
    else {
      for (const h of m.hooks) {
        if (typeof h !== "string" || !HOOK_NAMES.includes(h as HookName)) {
          errors.push(`hooks 里有不认识的点：${JSON.stringify(h)}（可用：${HOOK_NAMES.join(" / ")}）`);
          continue;
        }
        hooks.push(h as HookName);
      }
    }
  }
  if (hooks.length && !permissions.includes("hooks:register")) {
    errors.push("声明了 hooks 却没有申请 `hooks:register` 权限（两者必须一致）");
  }

  const main = typeof m.main === "string" ? m.main.trim() : undefined;
  if (main !== undefined) {
    if (!main || path_isEscape(main)) {
      errors.push(`main 只允许插件目录内的相对路径（收到：${JSON.stringify(m.main)}）`);
    }
  }

  /* 发布者与签名（V5-4 4.4）：**成对出现**，且各自形状要对 */
  let publisher: PluginPublisher | undefined;
  const hasAnySignatureField = m.publisher !== undefined || m.signature !== undefined;
  if (hasAnySignatureField) {
    const raw = m.publisher as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push("publisher 必须是对象：{id, name?, key}（有 signature 就必须有 publisher，两者成对）");
    } else {
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const key = typeof raw.key === "string" ? raw.key.trim() : "";
      const label = typeof raw.name === "string" ? raw.name.trim() : undefined;
      if (!NAME_RE.test(id)) {
        errors.push(`publisher.id 不合法：${JSON.stringify(raw.id)}（与插件名同一套形状：小写字母开头，2–41 字符）`);
      }
      /* ed25519 SPKI DER 的 base64 长度不会低于 40；一眼能看出"这不是个钥匙" */
      if (key.length < 40 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
        errors.push("publisher.key 应该是 base64 的 ed25519 公钥（SPKI DER）—— 私钥不许进插件");
      }
      if (id && key) publisher = { id, key, ...(label ? { name: label } : {}) };
    }
    const signature = typeof m.signature === "string" ? m.signature.trim() : "";
    if (!signature) errors.push("有 publisher 就必须有 signature（两者成对 —— 单边出现等于两边都能假装成功）");
    else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) errors.push("signature 应该是 base64");
  }

  const engines = m.engines as { ding?: unknown } | undefined;
  if (!engines || typeof engines.ding !== "string" || !engines.ding.trim()) {
    errors.push("engines.ding 必填（说明它兼容的宿主版本，例如 \">=0.2.0\"）");
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      name,
      version,
      description,
      ...(tools.length ? { tools } : {}),
      ...(hooks.length ? { hooks } : {}),
      permissions,
      engines: { ding: (engines as { ding: string }).ding },
      ...(publisher ? { publisher } : {}),
      ...(publisher && typeof m.signature === "string" ? { signature: m.signature.trim() } : {}),
      ...(main ? { main } : {}),
    },
  };
}

/**
 * **注入决策**：给这份清单 + 用户批准的那一组权限，实际接哪几条线。
 *
 * ⚠️ 这是"权限"在 v1 **真的**生效的地方（另一类只声明不拦，见文件头）。
 * 规则：**能力注入类权限必须同时出现在两处** —— 清单声明了、用户也批了。
 * 任一处没有，那根线就不接。
 *
 * @param manifest 清单
 * @param granted 用户在安装时批准的那一组（通常是清单的全集，但用户可以拒绝其中几项）
 * @returns 实际接上的能力
 */
export function grantedCapabilities(
  manifest: PluginManifest,
  granted: readonly PluginPermission[],
): { tools: boolean; hooks: boolean; withheld: PluginPermission[] } {
  const has = (p: PluginPermission) => manifest.permissions.includes(p) && granted.includes(p);
  const withheld = ENFORCED_PERMISSIONS.filter((p) => manifest.permissions.includes(p) && !granted.includes(p));
  return { tools: has("tools:register"), hooks: has("hooks:register"), withheld };
}

/**
 * 插件工具在注册表里的名字（**带前缀**）。
 *
 * ⚠️ 前缀不是装饰：不带的话，一个插件可以叫 `write_file` 把内置工具顶掉 ——
 * 而"谁把谁顶掉了"在界面上完全看不出来。与 MCP 的 `mcp__` 同一个道理。
 *
 * @param plugin 插件名
 * @param tool 它自己那边的工具名
 */
export function pluginToolName(plugin: string, tool: string): string {
  return `plugin__${plugin}__${tool}`;
}

/** 这个工具名是不是插件来的（`describeToolResult` 与界面据此判分支）。 */
export function isPluginTool(name: string): boolean {
  return name.startsWith("plugin__");
}

/** 从插件工具名里拆出插件名与工具名。 */
export function parsePluginToolName(name: string): { plugin: string; tool: string } | null {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "plugin") return null;
  return { plugin: parts[1] ?? "", tool: parts.slice(2).join("__") };
}
