/**
 * 命令行解析（Phase 9 从 `ding.ts` 拆出来）。
 *
 * ⚠️ 拆出来不只是为了短：`ding.ts` 一 import 就会执行 `main()` ——
 * 于是**它的内部函数没法被单测**（import 它就等于跑一遍 CLI）。
 * 而"`--k=v`、`-k v`、`--flag` 三种写法都认"这种事恰恰是最该被单测钉住的
 * （它错了不会崩，只会表现为"某个参数没生效"）。
 */

/** 解析结果。 */
export type Parsed = {
  /**
   * 子命令。
   *
   * ⚠️ 没有位置参数时是**空串**，不是 `"help"`：`ding --provider strata`（只给旗标）
   * 应当进交互模式，而 `ding help` 才是要帮助。第一版把空串也当 help，
   * 于是"带旗标进 REPL"永远进不去（表现成"打印了一屏帮助"，看着不像 bug）。
   */
  command: string;
  args: string[];
  flags: Map<string, string[]>;
  /**
   * 参数层面的**错**（2026-10-16，审计 P50/P219）：值旗标缺值、`--k=` 空值这类。
   * 只在出错时出现；入口拿到就报错退出（静默放行只会表现成"参数没生效"）。
   */
  problems?: string[];
  /**
   * **不认识的旗标**（审计 P220）：拼错的开关以前完全无声。只在非空时出现；
   * 入口按它报错（而不是把 `--por 8080` 收成两个无关的东西继续跑）。
   */
  unknown?: string[];
};

/**
 * **哪些旗标带值**（Phase 9 的必需品，不是装饰）。
 *
 * ⚠️ 没有这张表就只能"看到下一个不是 `-` 开头的就当成它的值"，于是
 * ```
 * ding --json sessions        → json = "sessions"，**没有子命令** → 进交互模式
 * ```
 * —— 用户要的是"用 JSON 列会话"，得到的是"进了 REPL"。这类错不会崩，
 * 只会让人以为命令没实现（单测里那条就是为它写的）。
 *
 * 表里的才吃下一个参数；其余一律当**开关**（`--json` / `--yes` / `--dev`）。
 * 带值的也可以写成 `--k=v`（那种写法不看这张表）。
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "dir",
  "provider",
  "model",
  "mode",
  "steps",
  "out",
  "by",
  "kind",
  "export",
  "grant",
  "search",
  "hook",
  "hook-secret",
  "token",
  "bind",
  "port",
  "cwd",
  /*
   * `--data-dir`（2026-10-16，审计 P129）：让 `ding backup` / `ding restore` 能显式
   * 指定"备份哪一个数据根"。桌面的数据在 `app.getPath("userData")`，CLI 默认在
   * `~/.ding` —— 没有这个旗标时，用户只能靠环境变量猜，而备份命令**不会报错**，
   * 于是很容易产出一份"会话 0 段 / store 0 项"的空备份还以为备份好了。
   */
  "data-dir",
  /*
   * `--member <id>:<口令>`（可重复；V5-2 2.2）：成员 token。
   *
   * 与 `--token`（单口令 = 本机主人）并存：**认证机制不变、身份细化** ——
   * 成员各自一把口令，服务端据此知道"现在是谁在请求"（owner 过滤与 2.3 的 actor 都靠它）。
   * 成员口令**不自动生成**（生成出来的必须打印，而打印多份凭据是坏习惯）——
   * 用成员就得自己给口令，这条写在 `ding serve --help` 上。
   */
  "member",
]);

/**
 * **不开关**的旗标（`--json` / `--yes` / `--continue` 这类，出现即可）。
 *
 * 这张表只用来判"这个旗标我们认不认识"（拼错要报错 —— 审计 P220），
 * 不含值语义；值语义在 `VALUE_FLAGS`。
 *
 * ⚠️ 加新旗标时这张表也要加（`hosts/cli/args.test.ts` 里那条守卫会扫源码
 * 把 `flag(p, "x")` / `flags.has("y")` 读过的名字都对一遍，漏了就红）。
 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "yes",
  "dev",
  "continue",
  "update-baseline",
  "list",
  "cost",
  "sessions",
  "keep-provenance",
  /*
   * `--force`（2026-10-16，审计 P214）：备份的输出路径**已存在**时，只有显式给
   * 它才允许覆盖 —— 不给就报错退出。备份是"最后一份能救回数据的东西"，
   * 悄悄覆盖它比不写还糟。
   */
  "force",
  "h",
  "help",
]);

/** 全部认识的旗标（值旗标 ∪ 开关）。入口按它拒"不认识"的。 */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

/**
 * 极简 argv 解析（不引依赖）：`--k v` / `--k=v` / `-k v` 三种都认，
 * 其余当位置参数。哪些旗标吃值见 `VALUE_FLAGS`。
 *
 * ## 2026-10-16（审计 P50 / P219 / P220）修掉的三处静默
 *
 * 1. **值旗标缺值**原来回填 `"true"` → `Number("true") = NaN` →
 *    "最多跑几步"这道闸恒不成立（`--steps`）、端口变 NaN（`--port`）。
 *    现在记进 `problems`，入口报错退出；
 * 2. `--k=`（空值）同样记进 `problems`；
 * 3. **不认识的旗标**从前完全无声，现在记进 `unknown`，入口统一拒绝。
 *
 * `--` 之后的参数一律当位置参数（`ding run -- --por` 这种要传字面量的场合）。
 *
 * @param argv 参数（不含 node 与脚本路径）
 * @returns 解析结果（`problems` / `unknown` 只在非空时出现，保持形状最小）
 */
export function parseArgv(argv: readonly string[]): Parsed {
  const args: string[] = [];
  const flags = new Map<string, string[]>();
  const problems: string[] = [];
  const unknown: string[] = [];
  const add = (key: string, value: string) => flags.set(key, [...(flags.get(key) ?? []), value]);
  const seen = (key: string) => {
    if (!KNOWN_FLAGS.has(key)) unknown.push(key);
  };

  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (literal) {
      args.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (!token.startsWith("-")) {
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq).replace(/^-+/, "");
      const value = token.slice(eq + 1);
      seen(key);
      if (VALUE_FLAGS.has(key) && !value.trim()) problems.push(`--${key} 要一个值（现在是空的）`);
      add(key, value);
      continue;
    }
    const key = token.replace(/^-+/, "");
    seen(key);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(key)) {
      if (next !== undefined && !next.startsWith("-")) {
        add(key, next);
        i += 1;
      } else {
        add(key, "");
        problems.push(`--${key} 要一个值（后面没跟值）`);
      }
      continue;
    }
    add(key, "true");
  }
  return {
    command: args[0] ?? "",
    args: args.slice(1),
    flags,
    ...(problems.length ? { problems } : {}),
    ...(unknown.length ? { unknown } : {}),
  };
}

/** 一个整数旗标的取值判定。 */
export type IntDecision = { ok: true; value: number } | { ok: false; message: string };

/**
 * 读一个"整数 + 范围"的值旗标（审计 P49 / P111 的同一形状）。
 *
 * 坏值**不许**静默变成 `NaN` / `0`：那会让"最多跑几步"这道防失控闸恒不成立，
 * 而表现是"参数好像没生效"（最难归因的那类错）。这里返回一句能直接展示的话。
 *
 * @param raw 旗标原文（`undefined` = 没给）
 * @param name 旗标名（只用于报错文案）
 * @param min/max 允许区间（闭区间）
 * @param fallback 没给时的默认值
 */
export function parseIntFlagValue(
  raw: string | undefined,
  name: string,
  opts: { min: number; max: number; fallback: number },
): IntDecision {
  if (raw === undefined) return { ok: true, value: opts.fallback };
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
    return { ok: false, message: `--${name} 要 ${opts.min}–${opts.max} 的整数，给了「${raw}」` };
  }
  return { ok: true, value };
}

/** 取一个旗标的全部取值（可重复给）。 */
export const flagAll = (p: Parsed, name: string): string[] => p.flags.get(name) ?? [];

/** 取一个旗标的最后一个取值（`--k a --k b` → `b`）。 */
export const flag = (p: Parsed, name: string): string | undefined => flagAll(p, name).at(-1);
