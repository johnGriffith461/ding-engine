/**
 * 持久化的**纯逻辑层**（C1）。
 *
 * ## 为什么要有这一层
 *
 * 这个仓库里原来有 12 个模块各写一份几乎逐字重复的"读 json / 写 json"：
 * `agentStore` / `artifactStore` / `codingStore` / `docStore` / `libraryStore` /
 * `memoryStore` / `readerStore` / `scheduleStore` / `searchStore` / `taskStore` /
 * `appSettings` / `remote`。它们各有各的毛病：
 *
 * - **`memoryStore` 连原子写都没有**（裸 `writeFileSync`，断电/崩溃留半截 JSON）；
 * - **一个都没有重试**（Windows 上"文件被占用"是一次性的，重试一次就过了，不重试就是丢数据）；
 * - **只有一个有 `version`**（画布），而且**没有任何迁移分支** —— 那个版本号是装饰品。
 *
 * 后果不是"代码不优雅"，是**同一条保证在每个模块里的强度都不一样**：
 * 换个人去改第 13 个模块时，他抄到的那一份是强是弱全凭运气。
 *
 * ## 分层
 *
 * - **本文件**：信封（envelope）+ 版本 + 前向迁移 + 重试。**不 import 任何 node/electron 的东西**，
 *   所以能被 `pnpm test` 直接断言（这正是它与 `electron/ipc/jsonStore.ts` 分开的原因）。
 * - `electron/ipc/jsonStore.ts`：拿本文件的判断去真的读写磁盘（原子写 + 重试）。
 *
 * ## 信封长什么样
 *
 * ```json
 * { "__schema": 1, "data": { ...真正的业务数据... } }
 * ```
 *
 * ⚠️ **旧数据是"裸"的**（历史上直接 `JSON.stringify(业务数据)`），所以"没有 `__schema`"
 * 必须被读成**版本 0** 并走迁移，而不是被当成坏文件丢掉 ——
 * 这是 C1 的硬要求：**旧数据必须能读**。
 *
 * 用 `__schema` 而不是随便一个 `v`：业务数据自己也可能有 `v` 字段，
 * 撞上就会把用户数据解读成信封（那是**静默丢数据**，最难查的一种）。
 */

/** 当前代码认识的信封版本。加一次迁移就在这里 +1。 */
export const SCHEMA_VERSION = 1;

/** 落盘信封。 */
export type Envelope<T> = { __schema: number; data: T };

/** 把业务数据装进信封。 */
export function wrap<T>(data: T, version: number = SCHEMA_VERSION): Envelope<T> {
  return { __schema: version, data };
}

/** 这是不是一个信封（区分"裸的旧数据"）。 */
export function isEnvelope(raw: unknown): raw is Envelope<unknown> {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    typeof (raw as { __schema?: unknown }).__schema === "number" &&
    "data" in (raw as object)
  );
}

/**
 * 一步迁移：把**版本 from** 的数据升成 **版本 from + 1** 的数据。
 *
 * 迁移表按"起点版本"索引，`migrations[0]` 就是从裸数据（版本 0）到版本 1 的那一步。
 */
export type Migration = (data: unknown) => unknown;

/** 读信封的结果。 */
export type UnwrapResult<T> =
  | {
      ok: true;
      data: T;
      /** 磁盘上是第几版（裸数据算 0）。 */
      from: number;
      /** 是否跑过迁移（跑过就应当回写一次，让磁盘也升上来）。 */
      migrated: boolean;
    }
  | {
      ok: false;
      /**
       * 拒绝的理由（进日志/状态栏）。
       *
       * ⚠️ `ok: false` 时调用方**不许回写** —— 见下面 `foreign` 的说明。
       */
      reason: string;
      /** 给调用方一个能用的空值，让应用起得来。 */
      data: T;
      /** 磁盘上的版本比本代码**新**：本程序不认识它，绝不能覆盖。 */
      foreign: true;
    };

/**
 * 解信封 + 跑前向迁移。
 *
 * 四种情形（都有测试钉着，见 `src/workbench/persist.test.ts`）：
 *
 * | 磁盘上是什么 | 怎么办 |
 * |---|---|
 * | 空 / `null` / 坏 JSON（调用方已 catch） | 给 `initial()`，不迁不报 |
 * | **裸数据**（无 `__schema`）= 版本 0 | 从 `migrations[0]` 起一步步升到当前版 |
 * | 版本 < 当前 | 从那个版本起一步步升 |
 * | 版本 = 当前 | 原样用 |
 * | **版本 > 当前** | ⚠️ **拒绝**：给 `initial()` + `foreign: true`，**不许回写** |
 *
 * ⚠️ **版本 0 的迁移缺省是"原样"**（`migrations` 里没写 `0` 就等于恒等函数）。
 * 这条默认是**必须**的：信封是这一轮才加的，磁盘上现存的用户文件**全是**裸数据（版本 0）；
 * 如果"缺迁移"一律算失败，那么上线的那一天就是**清库那一天**。而"0 → 1"这一步在
 * 绝大多数模块里本来就只是"把裸 payload 当成数据"（信封不改业务形状）。
 * **版本 1 以上**缺迁移仍然算失败 —— 那时候的形状变化是作者自己引入的，不许猜。
 *
 * 最后一条（版本更新时拒绝）是刻意的保守：降级运行（旧版本的程序配上了新版本的数据）时，
 * 我们能做的正确的事只有"别动它"。硬读进来再存回去 = **把用户的数据降级销毁**，
 * 而这正是本项目 `§178.6 / §179.6 / §181.6` 反复采取的同一取舍（"不改用户文件，更保守"）。
 *
 * @param raw 已经 `JSON.parse` 过的东西（`undefined` 表示文件不存在）
 * @param opts.version 本代码期望的版本
 * @param opts.migrations 迁移表（按起点版本索引；缺哪一步就视为"迁不动"）
 * @param opts.initial 兜底值
 * @returns 读完的结果
 */
export function unwrap<T>(
  raw: unknown,
  opts: { version?: number; migrations?: Record<number, Migration>; initial: () => T },
): UnwrapResult<T> {
  const version = opts.version ?? SCHEMA_VERSION;
  const migrations = opts.migrations ?? {};

  // 文件不存在 / 空 → 新库
  if (raw === undefined || raw === null) {
    return { ok: true, data: opts.initial(), from: version, migrated: false };
  }

  const enveloped = isEnvelope(raw);
  const from = enveloped ? (raw as Envelope<unknown>).__schema : 0;
  const payload = enveloped ? (raw as Envelope<unknown>).data : raw;

  if (from > version) {
    return {
      ok: false,
      reason: `磁盘上的数据是第 ${from} 版，本程序只认识到第 ${version} 版 —— 已保留原样、不做覆盖`,
      data: opts.initial(),
      foreign: true,
    };
  }

  let current = payload;
  let at = from;
  while (at < version) {
    /*
     * ⚠️ 版本 0 缺省是"原样"（见上面的长注释）：信封是这一轮才加的，
     * 磁盘上现存的用户文件全是裸数据，缺了这条默认就等于**上线那天清库**。
     * 版本 ≥ 1 缺迁移仍然算失败 —— 那时形状变化是作者自己引入的，不许猜。
     */
    const step = migrations[at] ?? (at === 0 ? (d: unknown) => d : undefined);
    if (!step) {
      // 迁移链断了：宁可给兜底值并说清楚，也不要"读进去一半"
      return {
        ok: false,
        reason: `缺第 ${at} → ${at + 1} 版的迁移，无法把数据升到当前版`,
        data: opts.initial(),
        foreign: true,
      };
    }
    current = step(current);
    at += 1;
  }

  return { ok: true, data: current as T, from, migrated: at !== from };
}

/**
 * 重试一个可能失败的异步动作。
 *
 * ⚠️ **为什么要它**：Windows 上写文件失败**大部分是一次性的**（杀软扫描、索引器占用、
 * 另一个进程刚关掉句柄）。不重试 = 把一次瞬时冲突记成"永久写不进去"，
 * 而用户看到的是"东西没了"。
 *
 * 重试之间要**等一下**（默认 40ms × 递增）：立刻重试大概率撞上同一个冲突。
 *
 * @param fn 要重试的动作（抛异常即视为失败）
 * @param opts.attempts 最多试几次（含第一次）
 * @param opts.delayMs 首次等待毫秒（之后按 2 倍递增）
 * @returns `fn` 的返回值
 * @throws 全部试完还是失败 → 抛最后一次的错
 */
export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.delayMs ?? 40;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(base * 2 ** i);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
