/**
 * provider 健康状态的端口（Phase 1 D1 冻结）。
 *
 * ## 它替掉了什么
 *
 * 内核主循环原来**直接 import 主进程的 `aiProbe`** —— 而 `aiProbe` 要 `app.getPath("userData")`，
 * 也就是"内核为了记一句'这家 provider 验证过了'，把自己绑死在 Electron 上"。
 * CLI 宿主（Node）压根没有 `app`，于是那一段要么崩、要么只能复制一份。
 *
 * 现在内核只知道两件事：**跑通了叫我一声**、**跑砸了告诉我原因**。
 * 落到哪儿（Electron 的 userData / CLI 的配置目录 / 一个假实现）是宿主的事。
 *
 * ## 为什么两个方法都不返回 Promise
 *
 * 原始调用点就是**即发即忘**的（`markProviderOk(...)` 不带 await，写失败也只打日志）。
 * 让端口变成 async 会诱使调用方以为"写完了才算跑通"——那不是这里要表达的意思。
 * 真实实现内部自己排队串行化（并发读-改-写会互相覆盖）。
 */
export type HealthStore = {
  /** 这一家**真的**跑通了一次（界面上才敢说"可用"）。 */
  markOk(providerId: string): void;
  /**
   * 这一家跑砸了，`note` 是给人看的一句话。
   *
   * ⚠️ 中止（用户点停）**不算**跑砸 —— 那是用户意图，不该把 provider 判死。
   * 这条规矩的落点在主循环里（它知道是不是中止），不在实现里。
   */
  markFailed(providerId: string, note: string): void;
};

/**
 * 什么都不记的实现。
 *
 * 用途是**测试与单跑**：CLI 里 `ding run` 跑一轮就退出，没有"下次启动时界面要显示
 * 哪家验证过"这回事；内核单测更不应该去碰磁盘。
 *
 * 它是**显式的**（而不是把 `health` 设成可选、在循环里判两遍 `?.`）：
 * 端口是必填的，"不需要记"要用一个实现去表达，而不是用"没给"去表达。
 */
export const noopHealth: HealthStore = {
  markOk: () => undefined,
  markFailed: () => undefined,
};
