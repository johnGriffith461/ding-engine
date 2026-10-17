/**
 * 定时任务的调度模型（阶段 11.6）。
 *
 * 口径照上位：**调度字段不是 cron 表达式**，而是枚举 `repeat_type`。
 * 上位的枚举是（从它前端包里读到的）：
 * ```
 * repeatType { Unspecified:0, NoRepeat:1, Hourly:2, Daily:3, Weekly:4, Custom:5 }
 * runEnv     { Unspecified:0, Cloud:1, LocalDevice:2 }
 * jobStatus  { Unspecified:0, Running:1, Paused:2, Finished:3, Deleted:4 }
 * ```
 * 上位把自然语言（「每周四 16 点」）交给服务端解析（`job_cron/schedule/parse`）。
 * 这里是单机版，没有那个解析服务，所以 **Custom 档退化成"每 N 分钟"** ——
 * 这是**有意降级**，不是假装能做自然语言解析。
 */

/** 重复方式。 */
export type RepeatType = "noRepeat" | "hourly" | "daily" | "weekly" | "custom";

/**
 * 重复方式的**运行时值表**（§178）。
 *
 * 类型只在编译期存在；磁盘上读回来的是字符串，判断它合不合法只能用值表。
 * （这两个必须一起改 —— 加了新的档位而忘了这里，归一化就会把新数据丢掉。）
 */
export const REPEAT_VALUES = ["noRepeat", "hourly", "daily", "weekly", "custom"] as const;

/** 任务状态（上位 `jobStatus`）。 */
export type JobStatus = "running" | "paused" | "finished" | "deleted";

/** 任务状态的运行时值表。 */
export const JOB_STATUSES = ["running", "paused", "finished", "deleted"] as const;

/** 一个定时任务。 */
export type CronJob = {
  id: string;
  title: string;
  /** 到点要执行的那句话。 */
  prompt: string;
  repeat: RepeatType;
  /** `custom` 档用的间隔分钟数（其它档忽略）。 */
  customMinutes?: number;
  /**
   * `daily` / `weekly` 的**钟点**（0–23 时，Phase 16 的 P0 缺口）。
   *
   * 为什么要它：在这之前 daily 是"从创建时刻起算的 24 小时" ——
   * 于是"每天早上 8 点汇总"配不出来（你 11:37 创建，它就永远在 11:37 跑）。
   * 而"每晚汇总"正是这个功能最常见的用法。
   *
   * 不填 = 保持原行为（从创建/上次执行起算的固定间隔）—— **不改老任务的时间**。
   */
  atHour?: number;
  /** 配合 `atHour` 的分（默认 0）。 */
  atMinute?: number;
  status: JobStatus;
  createdAt: number;
  /** 上次执行时间；从未跑过为 null。 */
  lastRunAt: number | null;
  /** 下次执行时间；已结束/已暂停为 null。 */
  nextRunAt: number | null;
  /** 执行历史（最近的在前，界面上只显示几条）。 */
  runs: CronRun[];
};

/** 一次执行记录。 */
export type CronRun = {
  at: number;
  /** 是否成功；失败时 `error` 有说明。 */
  ok: boolean;
  error?: string;
  /**
   * 这次跑出来的工作台任务 id。
   *
   * 为什么记它：任务页要能算出「这个定时任务累计用了多少」——
   * 用量挂在任务的各步上（`steps[].usage`），没有这条线就无从算起。
   * ⚠️ **老记录没有这个字段**（那时还没记），所以它是可选的：
   * 拿不到就**不显示用量**，不编一个数出来。
   */
  taskId?: string;
};

/** 各档的固定间隔（毫秒）。`custom` 不在表里，它由 `customMinutes` 决定。 */
const FIXED_INTERVAL: Partial<Record<RepeatType, number>> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** custom 档的合法间隔范围（分钟）。太小会把机器打满。 */
export const MIN_CUSTOM_MINUTES = 5;
export const MAX_CUSTOM_MINUTES = 60 * 24 * 30;

/** 重复方式的中文名（界面上用）。 */
export const REPEAT_LABEL: Record<RepeatType, string> = {
  noRepeat: "不重复",
  hourly: "每小时",
  daily: "每天",
  weekly: "每周",
  custom: "自定义间隔",
};

/**
 * 算下一次该跑的时间。
 *
 * @param job 任务
 * @param from 从哪个时间点往后算（通常是"现在"）
 * @returns 下次执行的时间戳；不重复任务跑过一次后返回 null
 */
export function nextRunAt(job: CronJob, from: number): number | null {
  if (job.status !== "running") return null;

  if (job.repeat === "noRepeat") {
    // 没跑过就等第一次；跑过就结束
    return job.lastRunAt === null ? from : null;
  }

  if (job.repeat === "custom") {
    const minutes = clampCustomMinutes(job.customMinutes);
    return from + minutes * 60 * 1000;
  }

  /*
   * ⭐ **有钟点就按钟点算**（Phase 16）：daily/weekly 填了 `atHour` 时，
   * 下一次是"往后数到那个钟点"，而不是"从这一刻起加 24 小时"。
   *
   * 两条要注意的：
   *   · **当天那个钟点已经过了** → 落到第二天（否则一创建就会立刻跑一次）；
   *   · **weekly 还要看星期**：老行为是"每 7 天"，没有"星期几"的概念 ——
   *     所以这里保持"每 7 天的那个钟点"（不假装有星期几），这是**如实**的简化。
   */
  const clock = job.atHour;
  if ((job.repeat === "daily" || job.repeat === "weekly") && typeof clock === "number") {
    const period = FIXED_INTERVAL[job.repeat];
    if (!period) return null;
    const hour = Math.min(Math.max(Math.trunc(clock), 0), 23);
    const minute = Math.min(Math.max(Math.trunc(job.atMinute ?? 0), 0), 59);
    const base = new Date(from);
    const candidate = new Date(base);
    candidate.setHours(hour, minute, 0, 0);
    /* 当天那个钟点已经过了（或就是此刻）→ 往后推一个周期 */
    if (candidate.getTime() <= from) candidate.setTime(candidate.getTime() + period);
    return candidate.getTime();
  }

  const interval = FIXED_INTERVAL[job.repeat];
  return interval ? from + interval : null;
}

/**
 * 把 custom 间隔夹进合法范围。
 *
 * 不夹取的话，用户填 0 或负数会让调度器**每帧都在触发**；
 * 填一个天文数字又等于永不触发。
 *
 * @param minutes 用户填的分钟数
 * @returns 合法间隔
 */
export function clampCustomMinutes(minutes: number | undefined): number {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return 60;
  return Math.min(MAX_CUSTOM_MINUTES, Math.max(MIN_CUSTOM_MINUTES, Math.round(n)));
}

/**
 * 校验一个任务能不能建。
 *
 * @param job 草稿
 * @returns 错误说明；能建则返回 null
 */
export function validateJob(
  job: Pick<CronJob, "title" | "prompt" | "repeat" | "customMinutes"> & { atHour?: number; atMinute?: number },
): string | null {
  if (!String(job.title ?? "").trim()) return "给这个定时任务起个名字";
  if (!String(job.prompt ?? "").trim()) return "写清到点要做什么";
  if (job.repeat === "custom") {
    const n = Number(job.customMinutes);
    if (!Number.isFinite(n)) return "自定义间隔要填分钟数";
    if (n < MIN_CUSTOM_MINUTES) return `间隔不能小于 ${MIN_CUSTOM_MINUTES} 分钟`;
    if (n > MAX_CUSTOM_MINUTES) return `间隔不能大于 ${MAX_CUSTOM_MINUTES} 分钟`;
  }
  /*
   * 钟点（Phase 16）：填了就要在 0–23 / 0–59 之内 ——
   * 不合法时报错而不是悄悄夹住：用户填了 25 点，他不会希望它变成 1 点。
   */
  for (const [value, max, what] of [
    [job.atHour, 23, "小时"],
    [job.atMinute, 59, "分钟"],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > max || Math.trunc(value) !== value) {
      return `${what}要是 0–${max} 的整数`;
    }
  }
  return null;
}

/**
 * 把一批任务里"该跑了"的挑出来。
 *
 * @param jobs 全部任务
 * @param now 当前时间
 * @returns 到点的任务（按到期时间从早到晚）
 */
export function dueJobs(jobs: CronJob[], now: number): CronJob[] {
  return jobs
    .filter((job) => job.status === "running" && job.nextRunAt !== null && job.nextRunAt <= now)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
}

/**
 * 跑完之后更新任务。
 *
 * @param job 任务
 * @param now 执行时刻
 * @param ok 是否成功
 * @param error 失败说明
 * @returns 更新后的任务
 */
export function afterRun(job: CronJob, now: number, ok: boolean, error?: string, taskId?: string): CronJob {
  const next = nextRunAt({ ...job, lastRunAt: now }, now);
  return {
    ...job,
    lastRunAt: now,
    nextRunAt: next,
    // 不重复的任务跑一次就结束
    status: next === null ? "finished" : job.status,
    runs: [{ at: now, ok, ...(error ? { error } : {}), ...(taskId ? { taskId } : {}) }, ...job.runs].slice(0, RUNS_IN_MEMORY),
  };
}

/**
 * 把下次执行时间说成人话。
 *
 * @param nextRunAt 下次执行时间；null 表示不再执行
 * @param now 当前时间
 * @returns 例如 `12 分钟后` / `3 小时后` / `已结束`
 */
export function describeNextRun(nextRunAt: number | null, now: number): string {
  if (nextRunAt === null) return "已结束";
  const delta = nextRunAt - now;
  if (delta <= 0) return "即将执行";
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

/**
 * 造一个新任务。
 *
 * @param id 任务 id
 * @param title 标题
 * @param prompt 到点要执行的话
 * @param repeat 重复方式
 * @param env 运行环境
 * @param now 创建时刻
 * @param customMinutes custom 档的间隔
 * @returns 新任务
 */
export function makeJob(
  id: string,
  title: string,
  prompt: string,
  repeat: RepeatType,
  now: number,
  customMinutes?: number,
  atHour?: number,
  atMinute?: number,
): CronJob {
  const base: CronJob = {
    id,
    title: title.trim(),
    prompt: prompt.trim(),
    repeat,
    ...(repeat === "custom" ? { customMinutes: clampCustomMinutes(customMinutes) } : {}),
    ...(atHour !== undefined && (repeat === "daily" || repeat === "weekly") ? { atHour: Math.trunc(atHour) } : {}),
    ...(atMinute !== undefined && (repeat === "daily" || repeat === "weekly") ? { atMinute: Math.trunc(atMinute) } : {}),
    status: "running",
    createdAt: now,
    lastRunAt: null,
    nextRunAt: null,
    runs: [],
  };
  return { ...base, nextRunAt: nextRunAt(base, now) };
}

/* ────────────────────── 从磁盘恢复任务（§178） ────────────────────── */

/**
 * 每条任务在内存里保留的**执行历史**条数（`afterRun` 每跑一次就剪一次）。
 *
 * ⚠️ 它与下面那个 `RUNS_KEPT` **不是一回事**，所以是两个数（审计 P58：
 * 原来是裸写的 `20`，看着像随手写的、也看不出与 `RUNS_KEPT` 什么关系）：
 *   · 这里 20 —— **运行期**的上限：跑一次往前面插一条，超出就丢最旧的；
 *   · `RUNS_KEPT` 50 —— **从磁盘收回来**时容忍的上限（旧版本落过更长的一串，
 *     别因为"现在的上限是 20"就把用户已有的历史当场砍掉）。
 * 有测试按 20 钉着（`src/workbench/schedule.test.ts:157`），改它要一起改那边。
 */
export const RUNS_IN_MEMORY = 20;

/** 执行历史最多留几条（界面上只显示几条，多的没必要一直带着）。 */
export const RUNS_KEPT = 50;

/**
 * 把落盘的（不可信）数据收窄成合法的定时任务（§178）。
 *
 * ## 为什么必须做这件事
 *
 * 原来渲染侧是这样读回来的：
 *
 * ```ts
 * const raw = (await shell.schedules.load()) as CronJob[];   // ← 直接断言
 * const jobs = raw.map((job) => { const next = job.nextRunAt; ... });
 * ```
 *
 * 主进程那边只做了一句最小过滤（`"id" in x`），而主进程的注释写着
 * 「字段不全会由渲染层的默认值兜」—— **可渲染层根本没有默认值，只有一次断言**。
 * 于是一个手改过的 / 旧版本的 `schedules.json`（比如 `repeat` 是别的词、
 * `nextRunAt` 是字符串）会**直接进到界面与 ticker 里**：
 * 下次运行时间显示成 `Invalid Date`，到点判断全乱。
 *
 * ## 取舍（哪三种情况怎么处理）
 *
 * | 情况 | 处理 | 为什么 |
 * |---|---|---|
 * | 没有 `id` / `id` 重复 | **丢掉** | 管不了的任务留着只会添乱 |
 * | `repeat` 不认识 | **丢掉** | 算不出下次运行时间，留着就是个永远不响的坑 |
 * | `status` 不认识 | 当成 `paused` | ⚠️ **坏的不能当 running** —— 否则它会自己跑起来 |
 * | 其它字段坏了 | 给安全默认值 | 标题空着难看，但比崩了强 |
 *
 * @param raw 落盘的原始值
 * @returns 合法的任务列表（顺序保持）
 */
export function normalizeJobs(raw: unknown): CronJob[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CronJob[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const j = item as Record<string, unknown>;

    const id = typeof j.id === "string" ? j.id.trim() : "";
    if (!id || seen.has(id)) continue;

    const repeat = j.repeat as RepeatType;
    if (!(REPEAT_VALUES as readonly string[]).includes(repeat)) continue;

    // custom 档没有合法间隔就跑不起来 —— 与其留个哑的，不如丢掉
    const customMinutes = typeof j.customMinutes === "number" ? j.customMinutes : undefined;
    if (repeat === "custom") {
      if (customMinutes === undefined) continue;
      if (customMinutes < MIN_CUSTOM_MINUTES || customMinutes > MAX_CUSTOM_MINUTES) continue;
    }

    /*
     * 钟点（Phase 16）：磁盘上的值不可信 —— 不在范围内就当没填（回落老行为），
     * **不是**夹到边界：夹出来的"每天 23 点"是用户从没要求过的时间。
     */
    const atHour =
      typeof j.atHour === "number" && Number.isFinite(j.atHour) && j.atHour >= 0 && j.atHour <= 23
        ? Math.trunc(j.atHour)
        : undefined;
    const atMinute =
      typeof j.atMinute === "number" && Number.isFinite(j.atMinute) && j.atMinute >= 0 && j.atMinute <= 59
        ? Math.trunc(j.atMinute)
        : undefined;

    seen.add(id);
    const status = j.status as JobStatus;
    out.push({
      id,
      title: typeof j.title === "string" ? j.title : "",
      prompt: typeof j.prompt === "string" ? j.prompt : "",
      repeat,
      ...(repeat === "custom" && customMinutes !== undefined ? { customMinutes } : {}),
      ...(atHour !== undefined && (repeat === "daily" || repeat === "weekly") ? { atHour } : {}),
      ...(atMinute !== undefined && (repeat === "daily" || repeat === "weekly") ? { atMinute } : {}),
      /*
       * ⚠️ 不认识的 status 一律当 `paused`。
       * 当成 running 的话，一个坏字段就能让任务自己跑起来 —— 那比"少跑一次"严重得多。
       */
      status: (JOB_STATUSES as readonly string[]).includes(status) ? status : "paused",
      createdAt: typeof j.createdAt === "number" && Number.isFinite(j.createdAt) ? j.createdAt : 0,
      lastRunAt: typeof j.lastRunAt === "number" && Number.isFinite(j.lastRunAt) ? j.lastRunAt : null,
      nextRunAt: typeof j.nextRunAt === "number" && Number.isFinite(j.nextRunAt) ? j.nextRunAt : null,
      runs: Array.isArray(j.runs)
        ? j.runs
            .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
            .filter((r) => typeof r.at === "number" && Number.isFinite(r.at))
            .slice(0, RUNS_KEPT)
          .map((r) => ({
            at: r.at as number,
            ok: r.ok !== false,
            ...(typeof r.error === "string" ? { error: r.error } : {}),
            /* 老记录没有这一项 → 就当没有（不是坏数据） */
            ...(typeof r.taskId === "string" && r.taskId ? { taskId: r.taskId } : {}),
          }))
        : [],
    });
  }
  return out;
}
