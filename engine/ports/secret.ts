/**
 * **凭据端口**（V5-4 任务 4.1）。
 *
 * 内核不认识"凭据库"这个东西 —— 它只要一个"这个引用名对应的密钥是什么"的函数。
 * 有了这一格，最小嵌入面（`ding-engine-core`）不需要 `node:fs` / `node:os`
 * 也能跑一轮真回合，而 CLI / 桌面照样能读它们各自的凭据来源。
 *
 * 谁注入什么：
 * · CLI / 桌面 → `runtime/credentials.ts` 的 `resolveSecret`（环境变量 → 凭据库 → 桌面加密库）；
 * · 不注入 → `envSecret`（**只读环境变量**，无 IO）。
 */
export type SecretPort = (keyRef: string) => string | null;

/**
 * 默认的凭据解析：**只读环境变量**。
 *
 * 取名与 `keyRef` 对齐（provider 表里的那一格就是"环境变量名 / 凭据引用名"）。
 * 返回值口径与 `resolveSecret` 一致：没有给 `null`（不是空串 —— 空串会让
 * `if (!secret(...))` 这类判断看起来"配了但值是空的"，那是另一种难查）。
 */
export const envSecret: SecretPort = (keyRef) => {
  const value = process.env[keyRef];
  return value && value.trim() ? value.trim() : null;
};
