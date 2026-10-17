import fs from "node:fs";
import path from "node:path";

import { credentialsPath, hasSecret, resolveSecret } from "./credentials";
import { allProviders, firstAvailableProvider, getProvider } from "./providers";
import { MODEL_CATALOG, STALE_DAYS, UNKNOWN_MODEL_BUDGET, isStale } from "./models";
import { CONFIRM_MODES, type ConfirmMode } from "../../shared/ipc";
import { sqliteRuntimeName } from "../adapters/sqliteDriver";
import { probeSandbox } from "../adapters/sandbox";
import { credentialProtection, secretsEncrypted } from "../adapters/secretStore";
import { createSqliteSessionStore } from "../adapters/sqliteStore";

/**
 * 一键自检（Phase 11.4；2026-10-17 从 `hosts/cli/doctor.ts` 搬进 `engine/runtime/`）。
 *
 * ## 为什么在 engine 而不是 CLI 宿主里
 *
 * 桌面版也要跑同一套自检（「反馈」那颗按钮导出的诊断包就复用这里的检查项，
 * 见 `electron/ipc/diagnostics.ts`）——而 `hosts/**` **不进 Electron 构建**
 * （tsconfig.electron.json 的 exclude），桌面 import 宿主文件会把那条边界捅穿。
 * 自检本身不认宿主：它只依赖 engine 的适配器（凭据/模型/沙箱/SQLite）与注入进来的
 * 配置视图，放 engine 才两边都够得着。**检查项只有这一份实现**。
 * CLI 侧的调用口径（配置从 `config.json` 收窄、合法键表）留在 `hosts/cli/doctor.ts`。
 *
 * ## 与 `ding plugins doctor` 的区别
 *
 * ⚠️ `ding doctor`（整装自检）与 `ding plugins doctor`（只查插件）是两件事。
 *
 * ## 方案的硬要求（11.4 的验收）
 *
 * > 每项失败都给出"下一步怎么做"的人话指引；**失败项 100% 带 actionable 指引**。
 *
 * 所以这里的 `Check` 形状里 `next` 是**必填**（不是可选）—— 不写下一步就编译不过。
 * 那比"记得写"可靠。
 *
 * ## 检查项与"为什么是这些"
 *
 * | 检查 | 挡的是哪一类"跑不起来" |
 * |---|---|
 * | 运行时 | Bun/Node 版本太低（`node:sqlite`/`bun:sqlite` 都没有）—— 真判版本号（P201） |
 * | 数据目录可写 | 装到了只读目录 / 权限不足 —— 建库会失败，但报错在很深的地方 |
 * | 会话库可开 | 旧库损坏 / 磁盘满 —— 这是"以前能用现在不能用"最常见的一种 |
 * | 凭据 | 一条 key 都没有 → 任何 provider 都用不了（**首次使用最常见的一格**） |
 * | provider 可用性 | 配了 provider 名但那条没有 key（"我明明配了啊"） |
 * | 模型 | 钉的模型不在目录表里 / 目录表数据过期超 90 天 |
 * | 配置合法性 | 写了不认识的键或档位（被静默丢掉却不报错，行为悄悄变）—— 按已知键白名单比对原文（P202） |
 * | 工作目录 | 配的目录不存在（工具会一律报"不在可写范围内"） |
 * | 沙箱 | **如实说"没有隔离"**（Phase 14 之前就是这样，不装） |
 */

/** 一项自检。 */
export type Check = {
  /** 报出来的一行标题。 */
  name: string;
  /** 过没过。 */
  ok: boolean;
  /** 现状（一句话，带具体数字/路径）。 */
  detail: string;
  /**
   * **过了也要写**：过的时候是"不用做什么"，没过的时候是"下一步做什么"。
   *
   * ⚠️ 必填是刻意的（方案 11.4 的验收是"失败项 100% 带 actionable 指引"）——
   * 可选字段会有人不写，必填字段不会。
   */
  next: string;
};

/** doctor 的输入（宿主给：数据目录、配置、平台信息）。 */
export type DoctorInput = {
  dataDir: string;
  configPath: string;
  rawConfig: unknown;
  /** 平台描述（`win32 x64 / Node 24.18.0` 这种）。 */
  runtime: string;
  /** 是不是 Bun 单二进制那条路。 */
  bunBinary: boolean;
  /**
   * 运行时版本（只有测试会传；生产走 `process.versions`）。
   *
   * 为什么要有这个口子：`runtime` 那只是**给人看的一句话**，而"版本够不够"必须按
   * **真的版本号**判 —— 拿那句展示文本去解析会让判据跟着文案变（审计 P201 正是
   * "这一格恒 ok:true、承诺的版本检查没有代码"）。
   */
  versions?: { node?: string; bun?: string };
  /**
   * 宿主的**配置视图**（engine 不认识宿主各自的配置文件）。
   *
   * · `normalized`：收窄后的 provider / model / dirs。
   *   CLI 传 `normalizeConfig(rawConfig)`（`hosts/cli/doctor.ts` 的包装器负责收起）；
   *   桌面传 settings.json 折算出来的默认通道（`electron/ipc/diagnostics.ts`）。
   * · `allowedKeys`：配置文件里**允许**出现的键 —— "配置文件合法"那格按**原文**比对用
   *   （审计 P202：收窄会把不认识的键静默丢掉，只看收窄值就永远报"合法"）。
   *
   * 省略 = 这个宿主没有配置层：那几格按"没配"报，而不是编一个默认值出来。
   */
  config?: {
    normalized: { provider?: string; model?: string; dirs?: string[] };
    allowedKeys: readonly string[];
  };
  /**
   * 不适用于本宿主的检查（按 `Check.name`）。
   *
   * 桌面没有"工作目录"这个概念 —— 与其显示一句不成立的现状
   * （"没配（每次跑用当前目录）"），不如**不显示这一格**（诚实优先于凑数）。
   */
  skip?: readonly string[];
};

/**
 * 跑起本程序**至少**要什么版本（按它会用的 SQLite 驱动算）。
 *
 * · Node：`node:sqlite` 从 **22.5.0** 起才有（见 `engine/adapters/sqliteDriver.ts`）——
 *   低于它连库都打不开，CLI 每条命令都崩。
 * · Bun：`bun:sqlite` 从 **1.0.0** 起（同一个文件里的另一条驱动）。
 */
export const RUNTIME_FLOOR = {
  node: { major: 22, minor: 5, label: "22.5.0（node:sqlite 从那版起才有）" },
  bun: { major: 1, minor: 0, label: "1.0.0（bun:sqlite 从那版起才有）" },
} as const;

/** 把 `24.18.0` 这类版本串切成数字（拿不到就返回 `null`，**不猜**）。 */
function versionParts(text: string | undefined): { major: number; minor: number } | null {
  if (!text) return null;
  const match = /^(\d+)\.(\d+)/.exec(text.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * 运行时版本够不够（审计 P201 / NEW-N7-7）。
 *
 * @returns 不够时给一句"差在哪、怎么升"；够（或拿不到版本号）时 `null`
 */
export function runtimeVersionProblem(versions: { node?: string; bun?: string }): string | null {
  const bun = versions.bun;
  const floor = bun ? RUNTIME_FLOOR.bun : RUNTIME_FLOOR.node;
  const got = versionParts(bun ?? versions.node);
  if (!got) return null; // 版本号拿不到：不假装检查过（那一格会如实说"没读出版本"）
  const low = got.major < floor.major || (got.major === floor.major && got.minor < floor.minor);
  if (!low) return null;
  return `${bun ? "Bun" : "Node"} ${bun ?? versions.node} 低于下限 ${floor.label} —— SQLite 驱动不存在，库打不开。`;
}

/** 配置原文里的问题（全是"收窄会被丢掉、但 doctor 该告诉你"的那类）。 */
export type ConfigIssues = {
  /** 不认识的键（拼错 / 改名 / 已删掉的项）。 */
  unknownKeys: string[];
  /** 值类型不对的键。 */
  badTypes: string[];
  /** `mode` 写了个陌生的档位（原文，原样报给用户看）。 */
  badMode?: unknown;
};

/**
 * 按已知键白名单看一遍配置**原文**（审计 P202 / NEW-N7-8）。
 *
 * 判据一律落在**原文**上，不用收窄后的值 —— 收窄过的值永远"合法"。
 *
 * @param raw 配置文件原文（不可信，可能是任何东西）
 * @param allowedKeys 这个宿主的配置文件**允许**出现的键（CLI 是一组，桌面是另一组）
 */
export function configIssues(raw: unknown, allowedKeys: readonly string[]): ConfigIssues {
  const out: ConfigIssues = { unknownKeys: [], badTypes: [] };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    out.badTypes.push("整个文件（不是对象）");
    return out;
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!allowedKeys.includes(key)) out.unknownKeys.push(key);
  }
  const isText = (v: unknown) => typeof v === "string" && v.trim() !== "";
  if (o.provider !== undefined && !isText(o.provider)) out.badTypes.push("provider（要非空字符串）");
  if (o.model !== undefined && !isText(o.model)) out.badTypes.push("model（要非空字符串）");
  if (o.mode !== undefined && !CONFIRM_MODES.includes(o.mode as ConfirmMode)) out.badMode = o.mode;
  if (o.dirs !== undefined && !(Array.isArray(o.dirs) && o.dirs.every(isText))) {
    out.badTypes.push("dirs（要字符串数组）");
  }
  if (
    o.softLimitUsd !== undefined &&
    !(typeof o.softLimitUsd === "number" && Number.isFinite(o.softLimitUsd) && o.softLimitUsd > 0)
  ) {
    out.badTypes.push("softLimitUsd（要正数）");
  }
  return out;
}

/** 跑完整套自检。**不抛异常**：谁的机器都不该因为自检本身崩掉。 */
export function runDoctor(input: DoctorInput): Check[] {
  const out: Check[] = [];
  /**
   * 宿主配置视图：CLI 是 `config.json` 收窄出来的，桌面是 settings.json 折算出来的。
   * 没给 = 这个宿主没有配置层（那几格按"没配"报）。
   */
  const cfg = input.config?.normalized ?? {};
  const allowedKeys = input.config?.allowedKeys ?? [];

  /* ① 运行时：够不够新 + **这个平台有哪些能力不可用**（如实标注，不装全能） */
  {
    const box = probeSandbox();
    const gaps: string[] = [];
    if (!box.bounded) gaps.push("命令的资源上限（Windows 才有作业对象实现）");
    if (!secretsEncrypted()) gaps.push("密钥的加密存储（CLI 侧没有系统钥匙串入口）");
    const versions = input.versions ?? { node: process.versions.node, bun: (process.versions as { bun?: string }).bun };
    const tooOld = runtimeVersionProblem(versions);
    const gotVersion = versions.bun ? `Bun ${versions.bun}` : `Node ${versions.node}`;
    out.push({
      name: "运行时",
      /*
       * ⚠️ 这一格原来**恒 ok:true**（审计 P201 / NEW-N7-7）：文件头的表写着它挡
       * "Bun/Node 版本太低（node:sqlite/bun:sqlite 都没有）"，实现却只看沙箱与密钥，
       * 从不看版本 —— 一屏绿勾里有一格是纯装饰。现在真判版本。
       */
      ok: !tooOld,
      detail:
        `${input.runtime}，SQLite 驱动走 \`${sqliteRuntimeName()}:sqlite\`` +
        (versions.node || versions.bun ? `（${gotVersion}）` : "（读不出版本号）") +
        (gaps.length ? `；本平台**没有**：${gaps.join("、")}` : ""),
      next: tooOld
        ? `换到 ${versions.bun ? "Bun 1.0.0" : "Node 22.5.0"} 或更新的版本：低于它时 \`node:sqlite\`/\`bun:sqlite\` 不存在，建库那一步会直接抛`
        : gaps.length
          ? "这些是已知的平台差异（README 的「平台覆盖」一节列了全表）—— 别把它们当成已具备的保护"
          : "无需处理（这一格只在你看到 migrate/upgrade 提示时才需要动）",
    });
  }

  /* ② 数据目录可写 */
  {
    let ok = false;
    let detail = "";
    try {
      fs.mkdirSync(input.dataDir, { recursive: true });
      const probe = path.join(input.dataDir, ".doctor-probe");
      fs.writeFileSync(probe, "ok", "utf8");
      fs.rmSync(probe, { force: true });
      ok = true;
      detail = input.dataDir;
    } catch (error) {
      detail = `${input.dataDir}：${(error as Error)?.message?.slice(0, 80) ?? "写不进去"}`;
    }
    out.push({
      name: "数据目录可写",
      ok,
      detail,
      next: ok
        ? "无需处理"
        : "换个可写目录：`DH_DATA_DIR=<某个你有权限的目录> ding …`，或给这个目录写权限",
    });
  }

  /* ③ 会话库能打开（"以前能用现在不能用"最常见的一种） */
  {
    const dbFile = path.join(input.dataDir, "sessions.db");
    const existed = fs.existsSync(dbFile);
    let ok = false;
    let detail = "";
    if (!existed) {
      /*
       * ⚠️ 库**不存在**时不去 open（审计 P213 / NEW-N7-19）：`createSqliteSessionStore`
       * 一打开就建库，于是"只报告、不动机器"的自检会在用户的数据目录里多留一个
       * `sessions.db`（可能还有 -wal / -shm）。不存在就说"还没有"，报的是现状。
       */
      ok = true;
      detail = `还没有会话库（第一次跑会自动建）：${dbFile}`;
    } else {
      try {
        const store = createSqliteSessionStore(input.dataDir);
        void store.list();
        store.close();
        ok = true;
        detail = `已存在，能打开：${dbFile}`;
      } catch (error) {
        detail = `${dbFile}：${(error as Error)?.message?.slice(0, 100) ?? "打不开"}`;
      }
    }
    out.push({
      name: "会话库可打开",
      ok,
      detail,
      next: ok
        ? "无需处理"
        : existed
          ? `库可能损坏或磁盘满。先备份再重建：把 ${dbFile} 改名（例如加 .bak）后重跑，旧库里的事件还在那个文件里`
          : "检查磁盘剩余空间，再重跑一次",
    });
  }

  /* ④ 凭据：一条都没有的话后面什么都别谈 */
  const providers = allProviders().filter((p) => p.id !== "strata");
  const withKey = providers.filter((p) => hasSecret(p.keyRef));
  {
    const file = credentialsPath();
    const ok = withKey.length > 0;
    out.push({
      name: "模型凭据",
      ok,
      detail: ok
        ? `${withKey.length} 家可用：${withKey.map((p) => p.id).join(" / ")}（key 来自环境变量或 ${file}）`
        : `一条都读不到（找过环境变量与 ${file}）`,
      /*
       * ⚠️ 这段指引原来教的是**读不到的写法**（审计 P198 / NEW-N7-4）：
       * 它让人往凭据文件里写顶格的一行 `DEEPSEEK_API_KEY: sk-…`，而读取端
       * （`engine/runtime/credentials.ts` 的 `parseRefs`）**只在 `refs:` 段内、且缩进一层**的
       * 行里认键 —— 照那句话写完，下次跑仍然"一条都读不到"，这一格每次照旧红。
       * 这正是向导里那个"写成扁平格式"的真 bug 在指引里的复活。
       */
      next: ok
        ? "无需处理"
        : `跑一次 \`ding init\` 会带你配好；或手动往 ${file} 里加一段（键要缩进在 \`refs:\` **下面一层**，顶格那行读不到）：\n` +
          `       refs:\n         DEEPSEEK_API_KEY: sk-…`,
    });
  }

  /* ⑤ provider：配了名字但那条没 key（"我明明配了啊"） */
  {
    const wanted = cfg.provider;
    const def = wanted ? getProvider(wanted) : undefined;
    if (!wanted) {
      const pick = firstAvailableProvider(resolveSecret);
      out.push({
        name: "默认 provider",
        ok: Boolean(pick),
        detail: pick ? `没配，按"第一个有密钥的"选：${pick.id}` : "没配，而且没有一家有密钥",
        next: pick
          ? `想固定下来就写进配置：ding config set provider ${pick.id}`
          : "先配一条 key：跑 `ding init`（三件事两分钟），或按上一格的说明写进凭据文件",
      });
    } else if (!def) {
      out.push({
        name: "默认 provider",
        ok: false,
        detail: `配置里写的是「${wanted}」，但内置表里没有这家`,
        next: `改成表里的一家（ding models 能看到全部），或删掉这项：ding config unset provider`,
      });
    } else {
      const has = hasSecret(def.keyRef);
      out.push({
        name: "默认 provider",
        ok: has,
        detail: has ? `${def.id}（${def.label}）` : `${def.id} 没有密钥（找的是 ${def.keyRef}）`,
        next: has ? "无需处理" : `给 ${def.id} 配 ${def.keyRef}，或者换一家：ding config set provider <有 key 的那家>`,
      });
    }
  }

  /* ⑥ 模型：钉的那个在不在目录表里 + 目录表数据新不新鲜 */
  {
    const model = cfg.model;
    if (model) {
      const known = MODEL_CATALOG.some((m) => m.id === model);
      out.push({
        name: "默认模型",
        ok: known,
        detail: known ? `${model}（目录表里有它）` : `${model} 不在目录表里`,
        next: known
          ? "无需处理"
          : `换一个：ding config set model <ding models 里列出的>；未登记模型也能跑，但上下文按保守默认 ${UNKNOWN_MODEL_BUDGET.contextWindow}，单价未知`,
      });
    }
    const stale = MODEL_CATALOG.filter((m) => isStale(m)).length;
    const ok = stale === 0;
    out.push({
      name: "模型目录新鲜度",
      ok,
      detail: ok
        ? `全部在 ${STALE_DAYS} 天内核实过（共 ${MODEL_CATALOG.length} 条）`
        : `${stale}/${MODEL_CATALOG.length} 条的核实日期超过 ${STALE_DAYS} 天`,
      next: ok ? "无需处理" : "刷新快照：pnpm vendor:models（会重算价格与上下文）",
    });
  }

  /* ⑦ 配置合法性：写错的值不该悄悄改变行为 */
  {
    const issues = configIssues(input.rawConfig, allowedKeys);
    const ok = !issues.unknownKeys.length && !issues.badTypes.length && issues.badMode === undefined;
    const problems: string[] = [];
    if (issues.badMode !== undefined) problems.push(`mode 写的是 ${JSON.stringify(issues.badMode)}，不认识`);
    if (issues.unknownKeys.length) problems.push(`不认识的配置项：${issues.unknownKeys.join(" / ")}`);
    if (issues.badTypes.length) problems.push(`类型不对：${issues.badTypes.join(" / ")}`);
    out.push({
      name: "配置文件合法",
      ok,
      detail: ok ? input.configPath : problems.join("；"),
      next: ok
        ? "无需处理"
        : `档位只能写：${CONFIRM_MODES.join(" / ")}；可写的键只有：${allowedKeys.join(" / ")}` +
          `（拼错或写错类型的项会被**静默丢掉**，表现就是"我明明配了啊"）。改不掉就删掉它：ding config unset <键>`,
    });
  }

  /* ⑧ 工作目录：配了但不存在的目录，工具会一律报"不在可写范围内" */
  {
    const dirs = cfg.dirs ?? [];
    const missing = dirs.filter((d) => !fs.existsSync(d));
    const ok = missing.length === 0;
    out.push({
      name: "工作目录",
      ok,
      detail: dirs.length === 0 ? "没配（每次跑用当前目录）" : ok ? dirs.join(" / ") : `这些不存在：${missing.join(" / ")}`,
      next: ok
        ? dirs.length === 0
          ? "想让 agent 固定看某个目录：ding config set dirs <目录>"
          : "无需处理"
        : "删掉失效项或改对路径：ding config unset dirs 后重设",
    });
  }

  /* ⑨ 命令隔离（Phase 14.1）：**如实说清有哪一层、没有哪一层** */
  {
    const box = probeSandbox();
    out.push({
      name: "命令隔离",
      ok: true, // 不是"必须过"的检查项 —— 没有沙箱也能用，只是要知道边界
      /*
       * ⚠️ "**不是安全边界**"这句**两种情况都要说**：作业对象挡的是失控，不是恶意 ——
       * 有沙箱时不说这句，用户会以为"有沙箱 = 安全"，而那正是最危险的误解
       * （SAFETY.md 里那句"挡的是失控，不是恶意"就是同一件事的另一种写法）。
       */
      detail: box.found
        ? `${box.note}（**不是安全边界**：命令仍以你的身份跑，能读能写能联网）`
        : "run_command **没有沙箱**：它和 ding 同权限跑（闸门会先问，但问过之后就是全权限）",
      next: box.found
        ? "知道边界就好：它挡的是失控（吃光内存 / 起无数子进程 / 留孤儿），不是恶意"
        : "想有资源上限：pnpm sandbox:build（需要 Rust）。它挡的是失控，不是恶意",
    });
  }

  /* ⑩ 凭据保护（Phase 14.2）：说清我们的密钥是不是加密存的 */
  {
    const protection = credentialProtection(input.dataDir);
    out.push({
      name: "凭据保护",
      ok: true,
      detail: protection.detail,
      next: protection.next,
    });
  }

  /* 宿主不适用的检查按名字剔掉（见 `DoctorInput.skip`）——**剔掉不是改成绿** */
  const skip = new Set(input.skip ?? []);
  return skip.size ? out.filter((c) => !skip.has(c.name)) : out;
}

/** 自检结果的结构化形态（JSON 输出与诊断包共用这一份，别再各写一遍）。 */
export function doctorReport(checks: readonly Check[]): { ok: boolean; failed: number; checks: Check[] } {
  return {
    ok: checks.every((c) => c.ok),
    failed: checks.filter((c) => !c.ok).length,
    checks: [...checks],
  };
}

/** 把自检结果写成给人看的文本。 */
export function formatDoctor(checks: readonly Check[], opts: { json: boolean }): string {
  if (opts.json) {
    return JSON.stringify(doctorReport(checks), null, 2);
  }
  const lines = ["ding doctor —— 一键自检", ""];
  for (const c of checks) {
    lines.push(`${c.ok ? "✓" : "✗"} ${c.name}：${c.detail}`);
    if (!c.ok) lines.push(`    下一步：${c.next}`);
  }
  const failed = checks.filter((c) => !c.ok);
  lines.push("");
  lines.push(
    failed.length
      ? `有 ${failed.length} 项需要处理（上面每一项都写了下一步）。`
      : `全部通过（${checks.length} 项）。`,
  );
  return lines.join("\n");
}

/** 一行摘要（`ding run` 之类的地方可以顺手打一句）。 */
export function doctorSummary(checks: readonly Check[]): string {
  const failed = checks.filter((c) => !c.ok);
  return failed.length ? `${failed.length} 项待处理：${failed.map((c) => c.name).join(" / ")}` : "自检全通过";
}

/**
 * 保留给将来的"跑一次就自动修"（现在只报告，不改用户的机器）。
 *
 * ⚠️ 这句话必须与实现一致（审计 P213 / NEW-N7-19）。这一格原来写的是
 * "只报告，不动你的机器（除了一次探针写入，写完就删）"，而实现还会：
 * `mkdirSync` 数据目录（不存在时）、以及**打开会话库**——而打开即建库，
 * 于是它会在数据目录里留下一个 `sessions.db`。现在会话库那条改成"不存在就不 open"
 * （见 ③ 的注释），写下来的是**真的**剩下这两件事。
 */
export const DOCTOR_NOTE = `doctor 只报告、不改你的设置：它至多做两件"碰一下机器"的事 —— 数据目录不存在时建它、往里面写一个探针文件（写完就删）。会话库不存在时它**不会**替你建（只在已有库时试打开）。`;
