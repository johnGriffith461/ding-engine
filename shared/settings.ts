/**
 * 设置页的分类与文案（§182，**逐字取自证据** `settings_*`）。
 *
 * ## 依据
 *
 * 本体设置页不是一坨平铺的开关，而是**分类导航**（`settings_navigation` = 设置分类）：
 *
 * | 键 | 文案 |
 * |---|---|
 * | `settings_navigation` | 设置分类 |
 * | `settings_memory_on_off` | 记忆 |
 * | `settings_memory_on` / `_off` | 已开启 / 已关闭 |
 * | `settings_clear_context_new` | 开启新话题 |
 * | `settings_clear_context_toast_new` | 已开启新话题 |
 * | `settings_defaultNewChatModel` | 新对话默认模型 |
 * | `settings_modelSelection_useLast` | 记忆上次 |
 * | `settings_item_doubaoWebsite_cn` | 豆包官网 |
 * | `settings_label_user_policy_cn` | 用户协议 |
 */
export const SETTINGS_LABELS = {
  /** `settings_navigation` */
  navigation: "设置分类",
  /** `settings_memory_on_off` */
  memory: "记忆",
  /** `settings_memory_on` */
  memoryOn: "已开启",
  /** `settings_memory_off` */
  memoryOff: "已关闭",
  /** `settings_clear_context_new` */
  newTopic: "开启新话题",
  /** `settings_clear_context_toast_new` */
  newTopicDone: "已开启新话题",
  /** `settings_defaultNewChatModel` */
  defaultModel: "新对话默认模型",
  /** `settings_modelSelection_useLast` */
  useLast: "记忆上次",
  /** `settings_item_doubaoWebsite_cn` */
  website: "项目主页",
  /** `settings_label_user_policy_cn` */
  userPolicy: "用户协议",
} as const;

/**
 * 记忆开关的状态文案（逐字两句）。
 *
 * @param on 开着没有
 * @returns 已开启 / 已关闭
 */
export function memoryStateLabel(on: boolean): string {
  return on ? SETTINGS_LABELS.memoryOn : SETTINGS_LABELS.memoryOff;
}

/**
 * 「关于」页的标题（`settings_about_app` = `关于%s`）。
 *
 * @param name 产品名
 * @returns 例如 `关于豆包工作`
 */
export function aboutTitle(name: string): string {
  return `关于${String(name ?? "").trim()}`;
}

/** 设置分类的一项。 */
export type SettingsSection = { id: string; label: string };

/**
 * 分类导航（顺序即界面顺序）。
 *
 * @returns 分类列表
 */
export function settingsSections(): SettingsSection[] {
  return [
    { id: "profile", label: "个人资料" },
    { id: "account", label: "账号" },
    { id: "general", label: "通用" },
    { id: "about", label: "关于" },
  ];
}

/* ─────────────────── 新对话默认模型（§183） ─────────────────── */

/** 「记忆上次」这一档的值（空串 = 没钉，跟着上次走）。 */
export const PINNED_NONE = "";

/** 界面上显示"记忆上次"那一项的文案（证据 `settings_modelSelection_useLast`）。 */
export function pinnedLabel(pinned: string): string {
  return pinned ? pinned : SETTINGS_LABELS.useLast;
}

/** 一个可选的通道（provider + model 合成一项）。 */
export type RouteOption = { provider: string; model: string; label: string };

/**
 * 把 provider 列表摊成"可选的模型项"。
 *
 * @param providers 主进程给的 provider 信息
 * @returns 每一项的 label 是 `provider · model`
 */
export function routeOptions(providers: readonly { id: string; models: readonly string[]; available?: boolean }[]): RouteOption[] {
  const out: RouteOption[] = [];
  for (const p of providers) {
    if (p.available === false) continue;
    for (const m of p.models) out.push({ provider: p.id, model: m, label: `${p.id} · ${m}` });
  }
  return out;
}

/**
 * 这次请求该用哪个通道（§183）。
 *
 * ## 规则（两句话说得清）
 *
 * - **新对话** + 钉了默认 → 用钉的那个；
 * - 其它情况（老对话里、或者没钉）→ 跟着上次走。
 *
 * ⚠️ 为什么要区分"新对话"：默认模型**不该劫持一段正在进行的对话** ——
 * 用户在那段对话里手动换过模型，再发一句又被拽回默认，那是很讨厌的事。
 *
 * ## 钉的那个不能用了怎么办
 *
 * 退回"上次"（而不是硬发一个已经失效的模型）。调用方可以据此提示一句 ——
 * **静默换通道**是最坏的一种：用户以为在用 A，其实在用 B。
 *
 * @param input.pinned 钉的默认（空串 = 记忆上次）
 * @param input.last 上次用的
 * @param input.fresh 是不是新对话
 * @param input.available 现在可用的那些（用来判断钉的那个还在不在）
 * @returns 该用哪个 + 它是怎么来的
 */
export function pickRoute(input: {
  pinned: string;
  last: { provider: string; model: string };
  fresh: boolean;
  available: readonly string[];
}): { provider: string; model: string; source: "pinned" | "last" | "none"; fellBack: boolean } {
  const parse = (v: string): { provider: string; model: string } | null => {
    const [provider, ...rest] = String(v ?? "").split("/");
    const model = rest.join("/");
    return provider && model ? { provider, model } : null;
  };

  const pinned = parse(input.pinned);
  if (input.fresh && pinned) {
    // 钉的那个还在可用列表里（列表为空 = 没拿到，按"还在"处理，别误判）
    const stillThere = input.available.length === 0 || input.available.includes(input.pinned);
    if (stillThere) return { ...pinned, source: "pinned", fellBack: false };
    return { ...input.last, source: "last", fellBack: true };
  }

  if (input.last.provider) return { ...input.last, source: "last", fellBack: false };
  return { provider: "", model: "", source: "none", fellBack: false };
}

/** 钉的值怎么拼（`provider/model`；空串表示记忆上次）。 */
export function packPinned(provider: string, model: string): string {
  const p = String(provider ?? "").trim();
  const m = String(model ?? "").trim();
  return p && m ? `${p}/${m}` : PINNED_NONE;
}

/**
 * 把落盘的（不可信）`pinnedModel` 收窄（§183）。
 *
 * 规矩与别处一样（§178）：磁盘上的东西不可信。
 * 这里只认 `provider/model` 这个形状 —— **半个值当没设**，
 * 不然 `resolveChatRoute` 会拿到一个缺 model 的通道、发出一半的请求。
 *
 * @param raw 落盘的值
 * @returns 合法的 `provider/model`，或空串（= 记忆上次）
 */
export function normalizePinnedModel(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return PINNED_NONE;
  const [provider, ...rest] = value.split("/");
  const model = rest.join("/");
  return provider && model ? `${provider}/${model}` : PINNED_NONE;
}

/**
 * 钉住的默认模型**现在还能不能用**（§184）。
 *
 * ## 为什么要有这个函数
 *
 * §183 里写了「钉的失效就退回上次，并标出 `fellBack`」——
 * 但当时 `resolveChatRoute` 传给 `pickRoute` 的可用列表**是空数组**，
 * 而"列表为空 = 没拿到，按还在处理" → **兜底逻辑实际永远不会触发**。
 * 逻辑写了、路没通 —— 这正是本项目反复清的那类东西。
 *
 * 现在由这个函数（纯的）来回答"还能不能用"，两处都用它：
 * - `resolveChatRoute`：据此决定要不要退回；
 * - 设置页：据此在界面上**说一句**（不能让用户以为还在用 A，其实在用 B）。
 *
 * @param pinned 钉的值（空串 = 记忆上次，不参与判断）
 * @param available 现在可用的 `provider/model` 列表
 * @returns `unset`（没钉）/ `ok` / `dead`（钉的那个不在了）
 */
export function pinnedStatus(pinned: string, available: readonly string[]): "unset" | "ok" | "dead" {
  const value = normalizePinnedModel(pinned);
  if (!value) return "unset";
  // 列表为空 = 没拿到可用信息 → 按"还在"处理（不误报失效）
  if (available.length === 0) return "ok";
  return available.includes(value) ? "ok" : "dead";
}

/**
 * 失效时界面上那句话。
 *
 * ⚠️ **自定文案**（证据里没有这句）。但什么都不说更糟：
 * 用户以为默认模型在用，其实早就退回"上次"了 —— **静默换通道最坏**。
 *
 * @param pinned 钉的值
 * @returns 例如 `默认模型 deepseek/x 现在不可用，这次先用上次的通道`
 */
export function fallbackNote(pinned: string): string {
  const value = normalizePinnedModel(pinned);
  return `默认模型 ${value || "（未设）"}现在不可用，这次先用上次的通道`;
}
