import { envSecret, type SecretPort } from "../ports/secret";
import type { Protocol } from "./models";

/**
 * provider 抽象层（PLAN 3.2）。
 *
 * 全部走 OpenAI 兼容协议，所以换 provider 只改这里的表，业务代码不动。
 * 表里的 keyRef 是"环境变量名 / 凭据引用名"，不是密钥本体。
 *
 * ## ⚠️ baseURL 是**惰性**取的（2026-10-14 改）
 *
 * 原来那两处 `process.env.XXX_BASE_URL ?? "默认"` 写在**模块初始化**里，于是
 * "环境变量"其实只在**第一次 import 这个模块时**生效一次：之后改 process.env 没有任何用。
 * 后果有两层：
 *   · 单测里没法把它指到一个假服务上（模块早就被 import 过了）——
 *     而"不连真服务地测主循环"正是最该有的那条测试；
 *   · 宿主在启动后再改配置（切本地端点）会静默不生效。
 *
 * 现在只在**用到时**读一次。改的只是时机，默认值与语义一字不变。
 */

/*
 * ⚠️ provider id 从"五个字面量的联合类型"改成 `string`（Phase 5.2）：
 * 数量开始涨（官方直连 + 中转 + 自建端点），每加一家都要改联合类型、
 * 改渲染层的下拉、改四处 `as ProviderId`。而它们对代码的意义只有一个：
 * **是个稳定的键**。真正约束行为的是 `protocol`，那个仍然是封闭的词表。
 */
export type ProviderId = string;

export type ProviderDef = {
  id: string;
  /** 展示名。 */
  label: string;
  /** OpenAI 兼容 baseURL（表里给的是**默认值**）。 */
  baseURL: string;
  /** 覆盖 baseURL 的环境变量名（清醒地写在表里，而不是藏在那行的 `??` 里）。 */
  baseURLEnv?: string;
  /** 凭据引用名。 */
  keyRef: string;
  /** 可选模型（第一个是默认）。 */
  models: string[];
  /**
   * **这一家说哪种协议**（Phase 5.2）。
   *
   * ⚠️ 必填，而且是**线路格式**，不是"哪家公司"。中转站把 claude 用 OpenAI 格式转出来，
   * 那它的协议就是 `openai-compatible` —— 引擎据此选 adapter，不看模型是谁家的。
   */
  protocol: Protocol;
  /**
   * 覆盖模型清单的环境变量名（逗号分隔）。
   *
   * 存在的理由很实际：**模型名会变**，而它是配置不是数据。表里给的是 2026-10-15
   * 从官方/目录里列到的真名；用户手上的账号能开哪些、名字有没有变，
   * 让他们用环境变量覆盖比我们猜要靠谱。
   */
  modelsEnv?: string;
  /** 备注：走本机 / 中转 / 官方直连，以及这个模型清单是哪来的。 */
  note: string;
};

/**
 * 表本体（`baseURL` 是默认值；要拿覆盖后的值请走 `allProviders()` / `getProvider()`）。
 *
 * ## 模型清单是哪来的（2026-10-15，如实记）
 *
 * 全部**列出来的**，不是凭印象写的：
 * - `anthropic` / `google` / `openai` 三家：models.dev 仓库里各自 `models/` 目录的**当日文件名**；
 * - `openrouter`：models.dev 的 `models.json`（OpenRouter 目录快照）里的 `vendor/model` 全名；
 * - 原有的五家：沿用本项目既有的清单（那是用户实际在用的名字）。
 *
 * 都能用 `<PROVIDER>_MODELS` 环境变量覆盖（模型名会变，而它是配置不是数据）。
 */
const PROVIDER_TABLE: ProviderDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek 官方",
    protocol: "openai-compatible",
    baseURL: "https://api.deepseek.com/v1",
    keyRef: "DEEPSEEK_API_KEY",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelsEnv: "DEEPSEEK_MODELS",
    note: "官方直连，最稳",
  },
  {
    id: "tokenrhythm",
    label: "tokenrhythm 中转",
    protocol: "openai-compatible",
    baseURL: "https://tokenrhythm.studio/v1",
    keyRef: "A_API_KEY",
    models: ["deepseek-flash", "deepseek-chat", "gpt-4o-mini"],
    modelsEnv: "TOKENRHYTHM_MODELS",
    note: "中转，便宜",
  },
  {
    id: "apikeyfan",
    label: "apiKeyFan 中转",
    protocol: "openai-compatible",
    baseURL: "https://api.apikey.fan/v1",
    baseURLEnv: "APIKEYFAN_BASE_URL",
    keyRef: "APIKEYFAN_API_KEY",
    models: ["deepseek-flash", "deepseek-chat"],
    modelsEnv: "APIKEYFAN_MODELS",
    note: "多模型中转（baseURL 可用 APIKEYFAN_BASE_URL 覆盖）",
  },
  {
    id: "apihub",
    label: "API_HUB 中转",
    protocol: "openai-compatible",
    baseURL: "https://api.apihub.top/v1",
    baseURLEnv: "API_HUB_BASE_URL",
    keyRef: "API_HUB_API_KEY",
    models: ["deepseek-chat", "deepseek-v3", "gpt-4o-mini", "claude-3-5-sonnet"],
    modelsEnv: "API_HUB_MODELS",
    note: "多模型中转（baseURL 可用 API_HUB_BASE_URL 覆盖）",
  },
  {
    id: "qianwen",
    label: "通义千问",
    protocol: "openai-compatible",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyRef: "QIANWEN_API_KEY",
    models: ["qwen-plus", "qwen-max", "qwen-turbo"],
    modelsEnv: "QIANWEN_MODELS",
    note: "阿里兼容模式",
  },
  /*
   * ── Phase 5.2 新增：协议分层之后，加一家只加一条配置 ──
   *
   * ⚠️ 这三家走的是**原生协议**，不是 OpenAI 兼容层。理由各不相同，都写在各条的 note 里
   * （最要紧的一条：Anthropic 的缓存控制只有原生协议才有）。
   */
  {
    id: "anthropic",
    label: "Anthropic 官方",
    protocol: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    keyRef: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
    modelsEnv: "ANTHROPIC_MODELS",
    note: "原生 Messages API（兼容层不给 prompt caching）。模型名取自 models.dev 当日清单",
  },
  {
    id: "google",
    label: "Google Gemini 官方",
    protocol: "google",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    keyRef: "GOOGLE_API_KEY",
    models: ["gemini-2.5-pro", "gemini-3.5-flash", "gemini-3.1-pro-preview"],
    modelsEnv: "GOOGLE_MODELS",
    note: "原生协议（多 safetySettings 与 functionDeclarations）。模型名取自 models.dev 当日清单",
  },
  {
    id: "openai",
    label: "OpenAI 官方",
    protocol: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    keyRef: "OPENAI_API_KEY",
    models: ["gpt-5.4-mini", "gpt-4o-mini"],
    modelsEnv: "OPENAI_MODELS",
    note: "官方端点本身就是 OpenAI 协议。模型名取自 models.dev 当日清单",
  },
  {
    id: "openrouter",
    label: "OpenRouter（一站式）",
    protocol: "openai-compatible",
    baseURL: "https://openrouter.ai/api/v1",
    keyRef: "OPENROUTER_API_KEY",
    models: [
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-5.4-mini",
      "deepseek/deepseek-chat",
      "qwen/qwen-plus",
      "google/gemini-2.5-pro",
    ],
    modelsEnv: "OPENROUTER_MODELS",
    note: "一站式数百模型（OpenAI 协议）。模型名是 vendor/model 全名，取自 models.dev 快照",
  },
  {
    id: "strata",
    label: "本地 abliterated",
    protocol: "openai-compatible",
    baseURL: "http://127.0.0.1:8080/v1",
    baseURLEnv: "STRATA_BASE_URL",
    keyRef: "STRATA_API_KEY",
    models: ["deepseek-flash"],
    note: "需要自己先起本地服务",
  },
];

/**
 * 全部 provider（**带上环境变量里的 baseURL 覆盖**）。
 *
 * 每次调用都现算：这一层读的是进程环境，而环境是可能变的（宿主切端点、测试指到假服务）。
 *
 * @returns provider 定义（新的数组，调用方改它不会污染表）
 */
export function allProviders(): ProviderDef[] {
  return PROVIDER_TABLE.map((p) => {
    const override = (p.modelsEnv ? process.env[p.modelsEnv]?.trim() : "") || "";
    const models = override
      ? override
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : p.models;
    return {
      ...p,
      models: models.length ? models : p.models,
      baseURL: (p.baseURLEnv ? process.env[p.baseURLEnv]?.trim() : "") || p.baseURL,
    };
  });
}

/** 取某一家**实际生效**的协议（不认识这家就按 OpenAI 兼容处理，别把请求发歪）。 */
export function protocolOf(providerId: string): Protocol {
  return getProvider(providerId)?.protocol ?? "openai-compatible";
}

/** 脱敏后的 provider 信息（可安全回传渲染进程）。 */
export type ProviderInfo = {
  id: ProviderId;
  label: string;
  models: string[];
  note: string;
  /** 是否检测到可用 key。 */
  available: boolean;
  /** 密钥的引用名（只是名字，不是密钥本体；设置里填 key 要用它）。 */
  keyRef: string;
};

/**
 * 列出所有 provider 及其可用性。
 *
 * `secret` 不给 = 只看环境变量（V5-4 4.1 的端口化）：宿主（CLI / 桌面 / 自检）
 * 一律显式传自己的凭据解析，否则"用户在设置里填的 key"会被当成没配。
 */
export function listProviders(secret: SecretPort = envSecret): ProviderInfo[] {
  return allProviders().map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    note: p.note,
    /* 2026-10-16：设置页「填 key」要知道写到哪个名字下（只是名字，不是密钥） */
    keyRef: p.keyRef,
    available: secret(p.keyRef) !== null,
  }));
}

/** 按 id 取 provider 定义（已应用 baseURL 覆盖）。 */
export function getProvider(id: string): ProviderDef | undefined {
  return allProviders().find((p) => p.id === id);
}

/** 第一个有 key 的 provider（用来自动选默认值）。`secret` 的口径同上。 */
export function firstAvailableProvider(secret: SecretPort = envSecret): ProviderDef | undefined {
  return allProviders().find((p) => secret(p.keyRef) !== null);
}
