/**
 * **拉取模型清单**（2026-10-16，主人的话：「如果说用户自己填写 API 的话，咱们可以给整一个
 * 自动拉取模型的功能」）。
 *
 * ## 为什么要有它
 *
 * 我们的 provider 表里每个模型名都是**手写死的**（deepseek-chat / qwen-plus …）。用户把自己
 * 的 key（甚至自己的中转地址）填进来时，那些名字对不对、他这家中转到底有哪些模型，只能靠猜 ——
 * 猜错的代价是"选了却报错"。所以这里按 OpenAI 兼容的约定去问一句：`GET {baseURL}/models`。
 *
 * ## 这一层只做**纯解析**
 *
 * 网络在调用方（主进程，`electron/ipc/ai.ts`）—— 这里只有"把响应体翻成模型名列表"这一件事，
 * 于是它能在 vitest 里直接被钉住（不用起 Electron、不用真 key）。
 *
 * ⚠️ 各家的响应**不是一种形状**（实测过三类）：
 *   · OpenAI / 大多数中转：`{ data: [{ id: "gpt-4o-mini" }, …] }`
 *   · 有些中转：`{ models: ["a", "b"] }` 或 `{ models: [{ id }] }`
 *   · 少数把 id 写成 `model` / `name`
 * 所以解析要宽容；但**宽容不等于编**：一个名字都认不出来时返回空数组 + 说明，不猜。
 */

/** 从 `/models` 的响应体里挑出模型名（去重、排序、剔除空项）。 */
export function modelIdsFromJson(raw: unknown): string[] {
  const out = new Set<string>();
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  };
  const pick = (v: unknown): void => {
    if (typeof v === "string") push(v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      push(o.id ?? o.model ?? o.name);
    }
  };

  if (Array.isArray(raw)) raw.forEach(pick);
  else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.data)) o.data.forEach(pick);
    if (Array.isArray(o.models)) o.models.forEach(pick);
    /* 有些网关把清单放在 `result` 里（RPC 风格） */
    if (o.result && typeof o.result === "object") return modelIdsFromJson(o.result);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * 把用户填的地址规整成"能直接拼 `/models`"的样子。
 *
 * 用户会填成 `https://api.x.com`、`https://api.x.com/v1`、甚至 `…/v1/chat/completions` ——
 * 三种都得能对（前者补 `/v1`，后者截掉尾巴）。**不猜别的**：只处理这三种形态。
 */
export function modelsUrlFor(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, "");
  const cut = base.replace(/\/chat\/completions$/, "");
  if (/\/v\d+$/.test(cut)) return `${cut}/models`;
  return `${cut}/v1/models`;
}
