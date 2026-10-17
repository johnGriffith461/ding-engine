import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 沙箱（Phase 14.1）的**宿主侧接线**。
 *
 * ## 这一层做什么
 *
 * `run_command` 要跑的命令，经 `ding-sandbox` 那个独立进程执行 —— 于是它有：
 *   · 内存上限（超过就死）、子进程数上限（挡 fork 炸弹）；
 *   · **随沙箱一起死**（命令起的那堆子进程不会留下当孤儿）。
 *
 * ## 这一层**不**做什么（重要，别把它当安全边界）
 *
 * 命令仍以**当前用户身份**运行：能读你的文件、能联网、能改能删。
 * 挡住的是"失控"，不是"恶意"。Windows 之外目前只是直通（没有 seccomp/seatbelt）。
 * 这些话在 `SAFETY.md` 与 `ding doctor` 里都如实写着 —— 代码注释与文档必须是同一件事。
 *
 * ## 什么时候走沙箱
 *
 * 找到 `ding-sandbox` 就用它；找不到就直通，**并让调用方知道**（返回 `bounded: false`）——
 * 静默降级比报错更坏：用户会以为有隔离。
 */

/** 沙箱能力。 */
export type SandboxInfo = {
  /** 找到二进制了吗。 */
  found: boolean;
  /**
   * 本平台**声明**支持隔离（`found` 且 `--probe` 这么答）。
   *
   * ⚠️ 口径要说清（2026-10-16，审计 P115）：这是**平台级**说法，不是"这一条命令
   * 真的被限制住了"的执行事实。Rust 侧不再只回显 `cfg!(windows)`，而是**真的试着
   * 建一次作业对象 + 把上限设上去**（`win::probe_bounded(DEFAULT_MEMORY_MB,
   * DEFAULT_PROCESSES)`），建得起来才答 true —— 受限容器 / 被策略拦下的会话里
   * 它会如实答 false。可**每一次执行**到底有没有进作业，沙箱只在 stderr 上喊一句，
   * 仍**没有给宿主侧的结构化出口**：`run_bounded` 之后那条命令是不受限的直通、
   * 上层这里也还是 `true`。那一半（逐条上报）不在这份工单里。
   * 所以调用方转述时不要把 `bounded` 说成"这条命令受限了"。
   */
  bounded: boolean;
  /** 二进制路径（找不到时为空串）。 */
  binary: string;
  /** 本平台的名字（写进 doctor / 日志）。 */
  platform: string;
  /**
   * 沙箱**自己报的**默认内存上限（MB）、默认子进程数上限。
   *
   * ⚠️ 这两个数**以沙箱为准**（2026-10-16，审计 P122）：`--probe` 从某一版起会带上
   * `defaultMemoryMb` / `defaultProcesses`，而宿主侧原来另外硬写了一份
   * （`SANDBOX_MEMORY_MB` / `SANDBOX_PROCESSES`）—— 同一个默认值两处各写一遍，
   * 改一边就漂。现在：**沙箱报了就用它报的**，没报（更老的二进制 / 答不出能力）
   * 才回落到下面那两个常量。所以这两个字段在老二进制上是常量值，不是"缺省"。
   */
  memoryMb: number;
  /** 子进程数上限（口径同上）。 */
  processes: number;
  /** 找不到的原因（给用户看的一句话）。 */
  note: string;
};

/**
 * `process.resourcesPath`（打包态的 `resources/` 目录）。
 *
 * ⚠️ 这个字段是 **Electron 独有**的，`@types/node` 里没有；而 `tsconfig.cli.json` 只带
 * `types: ["node"]` —— 同一份源码要供两个宿主编，CLI 那份就会在这里报
 * `Property 'resourcesPath' does not exist on type 'Process'`（2026-10-16 审计 G40/G95
 * 顺带撞到的：`pnpm cli:build` 当时根本编不过，因为这条 npm 产物此前**没有任何门在看**）。
 *
 * 取舍：**不能**为了 CLI 编得过就把这两行删掉 —— 桌面打包态真的靠它找沙箱（README 那句
 * "安装包带着 ding-sandbox.exe"就是这个）。所以做一次显式的、带说明的收窄，
 * 而不是 `any` 糊过去：非 Electron 环境下它就是 `undefined`，行为与原来一致。
 */
function resourcesPathOf(): string {
  const value = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  return typeof value === "string" ? value : "";
}

/**
 * 找 `ding-sandbox`。
 *
 * 顺序（2026-10-16，审计 P117 把这句**改成与代码一致**；原来是"→ PATH"而代码里
 * 根本没有 PATH 查找，且有两条自述与实现不符）：
 *
 * 1. `DING_SANDBOX`（显式指定，排第一 —— 验收与打包产物要能钉住一个确定的路径）；
 * 2. 打包态：`resources/`（`extraResources` 落点）与 exe 同级；
 * 3. 开发态：`<cwd>/sandbox/target/{release,debug}/`；
 * 4. `PATH`（**这条以前只写在注释里**：现在真的找了）。
 *
 * ⚠️ 两个如实记下的边界：
 *   · `DING_SANDBOX` **写错（路径不存在）不再静默忽略** —— 那会让用户以为
 *     "我指定了那份"，实际在用别的（或没有）。写错的路径进 `probeSandbox().note`；
 *   · 第 2 条里的"exe 同级"用的是 `process.execPath`，**开发态那是 node.exe** ——
 *     也就是"Node 安装目录里的 ding-sandbox 会被信任"。打包态它才是应用目录；
 *     这一条保留是因为打包后确实需要它，但它的含义在这里写清。
 */
export function findSandboxBinary(): string {
  const configured = process.env.DING_SANDBOX?.trim();
  if (configured && existsSync(configured)) return configured;

  const name = process.platform === "win32" ? "ding-sandbox.exe" : "ding-sandbox";
  /*
   * ⚠️ **打包态那两条不能少**（2026-10-16 补）：
   *
   * 之前这里只看 `process.cwd()` —— 而装出来的应用 cwd 是"用户从哪儿启动的"，
   * 于是**安装包里就算带了沙箱也找不到**（README 那句 ✅ 与现实不符，主人正是这么发现的）。
   * 现在显式看两处打包位置：`extraResources` 落地的 `resources/`（`process.resourcesPath`），
   * 以及 exe 自己所在目录。dev 态那两条保持不动。
   */
  const candidates = [
    /* 打包态：`extraResources` 把 ding-sandbox 放在 resources/ 下（见 package.json 的 build） */
    ...(resourcesPathOf() ? [path.join(resourcesPathOf(), name)] : []),
    /* 打包态：与 exe 同级（⚠️ dev 态这里其实是 node.exe 所在目录，见上面说明） */
    path.join(path.dirname(process.execPath), name),
    /* 开发态：cargo 的产物（`pnpm sandbox:build` 编到这儿） */
    path.join(process.cwd(), "sandbox", "target", "release", name),
    path.join(process.cwd(), "sandbox", "target", "debug", name),
    /* PATH（P117：注释一直写着这一条，代码里到这一刻才真的有） */
    ...pathCandidates(name),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "";
}

/**
 * 在 `PATH` 里找那个可执行文件（审计 P117）。
 *
 * 最后才找它：PATH 上那份可能是别人装的旧版/别的什么，显式路径与仓库产物应当优先。
 */
function pathCandidates(name: string): string[] {
  const sep = process.platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(sep)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.join(d, name));
}

/**
 * 缓存上一次探测（2026-10-16，审计 P98）。
 *
 * `planSandboxed` 在**每条 `run_command`** 上被调用，而它每次都 `spawnSync(binary,
 * ["--probe"], {timeout:10_000})` —— 沙箱二进制在但响应慢时，**主进程事件循环整段停住**
 * （正在流式吐字的模型输出也跟着停）。原来的注释说"不缓存 —— 用户可能刚编出来就重跑 doctor"：
 * 那是给 doctor 说的，而代价落在了热路径上。
 *
 * 现在的口径：**热路径用缓存**，需要立刻看到新情况的调用方传 `{refresh:true}`
 * （doctor 就是这么用的）。
 */
let probeCache: SandboxInfo | null = null;

/** 问一次能力（跑 `--probe`；`refresh` 跳过缓存）。 */
export function probeSandbox(opts: { refresh?: boolean } = {}): SandboxInfo {
  if (!opts.refresh && probeCache) return probeCache;
  const info = probeSandboxNow();
  probeCache = info;
  return info;
}

/** 清掉探测缓存（测试与"用户刚编出来"的场合用）。 */
export function resetSandboxProbeCache(): void {
  probeCache = null;
}

/** 真的去问一次（不做缓存判断）。 */
function probeSandboxNow(): SandboxInfo {
  const configured = process.env.DING_SANDBOX?.trim();
  const binary = findSandboxBinary();
  if (!binary) {
    /*
     * P117：`DING_SANDBOX` 写了但不存在 —— **说出来**（原来静默往下找）。
     * 用户以为自己指定了那份沙箱、实际可能一份都没有，这种"以为"必须被打破。
     */
    const misconfigured = configured
      ? `（注意：DING_SANDBOX 指到了一个不存在的位置：${configured} —— 已忽略它）`
      : "";
    return {
      found: false,
      bounded: false,
      binary: "",
      platform: process.platform,
      memoryMb: SANDBOX_MEMORY_MB,
      processes: SANDBOX_PROCESSES,
      note: `没有 ding-sandbox（编它：pnpm sandbox:build）；命令将不受限地跑${misconfigured}`,
    };
  }
  const got = spawnSync(binary, ["--probe"], { encoding: "utf8", timeout: 10_000 });
  const out = (got.stdout ?? "").trim();
  try {
    const parsed = JSON.parse(out) as {
      bounded?: boolean;
      platform?: string;
      defaultMemoryMb?: number;
      defaultProcesses?: number;
    };
    const bounded = parsed.bounded === true;
    return {
      found: true,
      bounded,
      binary,
      platform: parsed.platform ?? process.platform,
      /* 沙箱报的就用它报的；更老的二进制没有这两个字段 → 回落到宿主侧那份常量 */
      memoryMb: positiveOrDefault(parsed.defaultMemoryMb, SANDBOX_MEMORY_MB),
      processes: positiveOrDefault(parsed.defaultProcesses, SANDBOX_PROCESSES),
      note: bounded
        ? "命令在作业对象里跑：有内存与子进程数上限，且随沙箱一起结束（不留孤儿）"
        : `本平台（${parsed.platform ?? process.platform}）还没有隔离实现，命令只是直通`,
    };
  } catch {
    return {
      found: true,
      bounded: false,
      binary,
      platform: process.platform,
      memoryMb: SANDBOX_MEMORY_MB,
      processes: SANDBOX_PROCESSES,
      note: `ding-sandbox 答不出能力（输出：${out.slice(0, 60) || "（空）"}）`,
    };
  }
}

/** 编排好的命令行（跑一条命令所需的一切）。 */
export type SandboxPlan = {
  /** 实际要 spawn 的可执行文件。 */
  file: string;
  /** 它的参数。 */
  args: string[];
  /** 有没有隔离（`false` = 直通；调用方应当如实转述）。 */
  bounded: boolean;
  /**
   * 这份计划**用的是不是沙箱那条路**（与 `bounded` 不是一回事）。
   *
   * `bounded` 回答"有没有真隔离"（非 Windows 上沙箱在、但没有隔离实现 → false）；
   * 而"要不要走沙箱那个进程"是另一件事。审计 P116 的回落逻辑要按**这个**判断
   * （沙箱起不来时，只有"本来打算走沙箱"才该退回直通）。
   */
  usedSandbox: boolean;
  /**
   * `args` **原样**拼成命令行（`windowsVerbatimArguments`），一个字符都不让 Node 转义。
   * 直通路要它（理由见 `planFor`），沙箱路不要（那边的参数由 CRT 规则解析）。
   */
  verbatimArgv: boolean;
  /**
   * 额外要设的环境变量。
   *
   * ⚠️ 走沙箱时命令本身**走这里**而不是 argv（见下面 `planFor` 的说明）——
   * Windows 上 `cmd.exe` 要的是一整条原始命令行，argv 传过去会被引号转义规则弄坏。
   */
  env: Record<string, string>;
  /** 一句话说明（写进日志/回注，让用户知道这条命令是不是受限的）。 */
  note: string;
};

/**
 * **回落**上限（沙箱没报或者报了个不可用的值时才用）。
 *
 * ⚠️ 这两个数**不是**"Rust 那边那一份的复制"了（2026-10-16，审计 P122）：
 * `--probe` 会带上 `defaultMemoryMb` / `defaultProcesses`，计划里的默认值
 * **以沙箱报的为准**（`SandboxInfo.memoryMb` / `.processes`）。这里留着是因为：
 *   · 更老的二进制不报这两个字段；
 *   · 沙箱答不出能力时（`--probe` 输出解析不了）也得有个数，
 *     否则 `run_command` 会因为"问不到上限"而整个用不了。
 * 数量级与 Rust 侧的 `DEFAULT_MEMORY_MB` / `DEFAULT_PROCESSES` 一致（2048 / 32）。
 */
export const SANDBOX_MEMORY_MB = 2048;
export const SANDBOX_PROCESSES = 32;

/**
 * 上限值的收窄：**只认正整数**，别的（0 / 负数 / 小数 / NaN / 字符串）一律回落。
 *
 * ## 为什么 0 不能放行（审计 P122）
 *
 * Rust 侧实测过：作业对象那两个字段带上限标志时，**0 不是"没有上限"而是让约束整个失效** ——
 * `--memory-mb 0` 让 `SetInformationJobObject` 当场失败、`--processes 0` 让命令进不了作业，
 * 两条路都变成"命令照跑、不受限"，而调用方以为自己设了个上限。
 * 新版沙箱把 0 按用法错误拒掉（退出码 2），但**不能假设对面是新的** ——
 * 老二进制会静默放行。所以这一层自己就不送 0：落到默认上限，宁可"宽"也不"无"。
 *
 * @param value 想要的值（不可信）
 * @param fallback 回落值
 * @returns 一个 ≥1 的整数
 */
function positiveOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/**
 * 给一条命令编排"怎么跑它"。**纯函数**：能力由调用方传进来（`planSandboxed` 负责去问）。
 *
 * 拆开是为了让两条路**都能被测到**：本机编过 `pnpm sandbox:build` 时走沙箱那条，
 * 没编过时走直通那条 —— 只看 `probeSandbox()` 的话，测到的永远只是本机这一条，
 * 另一条要等 CI 或用户机器上才第一次执行（那正是直通路的引号缺陷躲过整轮开发的原因）。
 *
 * @param command 用户/模型给的那条命令行
 * @param info 沙箱能力（`probeSandbox()` 的结果）—— **默认上限也取自它**（审计 P122）
 * @param opts.memoryMb / processes 上限（省略用 `info` 报的；`info` 没报才用常量；
 *   给了 0 / 负数这种无效值时同样回落到默认 —— 见 `positiveOrDefault`）
 * @returns 计划（`file` + `args`），调用方直接 spawn 它
 */
export function planFor(
  command: string,
  info: SandboxInfo,
  opts: {
    memoryMb?: number;
    processes?: number;
  } = {},
): SandboxPlan {
  const isWin = process.platform === "win32";
  const comSpec = isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  /*
   * ⚠️ 两条路的 shell 参数**不一样**，别图省事用同一份：
   *   · 直通那条：命令就在 argv 里（`cmd /d /s /c <命令>`）；
   *   · 沙箱那条：命令走环境变量（理由见下），所以这里**只能给固定旗标** ——
   *     把命令也留在 argv 里会让 cmd 收到两遍（第一版就是这么写的，
   *     报错长成 `Cannot find module 'C:\…\work\"…" node …'` 那种四不像）。
   */
  const shellFlags = isWin ? ["/d", "/s", "/c"] : ["-c"];

  if (!info.found) {
    /*
     * ⚠️ 直通路的引号：命令要**原样**落到 cmd 手里，Node 的转义一个都不许加。
     *
     * Node 在 Windows 上按 **CRT** 规则给每个 argv 元素加引号（`"` → `\"`），
     * 而 `cmd.exe` 不按 CRT 解析命令行 —— 于是 `node -e "…"`、带引号的路径
     * 这类**含引号的命令**到它手里会变形：实测**退出码 0、没有输出、什么都没跑**
     * （静默失效，界面上只看到"（没有输出）"）。2026-10-16 CI 第一次真跑单测时逮到，
     * 此前一直没露头，是因为开发机上编过沙箱、命令全走沙箱那条路。
     *
     * 所以这里做两件事：① 命令外面再套一层引号 —— cmd 的 `/s` 会剥掉它，
     * 里层的引号原样留下（命令自己以引号开头也不会被 `cmd` 剥错）；
     * ② `verbatimArgv: true`，让调用方关掉 Node 的转义。
     */
    return {
      file: comSpec,
      args: [...shellFlags, isWin ? `"${command}"` : command],
      verbatimArgv: isWin,
      env: {},
      bounded: false,
      usedSandbox: false,
      note: "没有沙箱（命令不受限）——编它：pnpm sandbox:build",
    };
  }
  return {
    /*
     * ⚠️ 走沙箱时**自己拼 shell**：`spawn(..., {shell:true})` 会让 Node 在**外面**再套一层 shell，
     * 那层壳不在作业对象里 —— 于是"上限"约束的是壳、真正的命令在壳外面跑。
     * 所以 shell 作为沙箱的参数显式给出，而**命令本身走环境变量**：
     *
     *   命令行从 Node 传到沙箱要过两次 CRT 引号转义，而 `cmd.exe` 不按 argv 解析
     *   （它要一整条原始命令行）—— 含引号的命令（`node -e "…"`）到 cmd 手里会变形，
     *   实测表现是**静默无输出**或"系统找不到指定的路径"。
     *   环境变量没有这层转义，沙箱那边用 `raw_arg` 原样交给 cmd，
     *   效果与"在终端里手敲一遍"一致。
     */
    file: info.binary,
    args: [
      "--memory-mb",
      String(positiveOrDefault(opts.memoryMb ?? info.memoryMb, SANDBOX_MEMORY_MB)),
      "--processes",
      String(positiveOrDefault(opts.processes ?? info.processes, SANDBOX_PROCESSES)),
      "--from-env",
      "--",
      comSpec,
      ...shellFlags,
    ],
    /* 这条路的参数是给 CRT/sandbox 自己解析的（不是给 cmd 解析的），照常让 Node 转义 */
    verbatimArgv: false,
    env: { DING_SANDBOX_COMMAND: command },
    bounded: info.bounded,
    usedSandbox: true,
    note: info.note,
  };
}

/**
 * 编排一条命令（先去问沙箱能力，再拼计划）。
 *
 * @param command 用户/模型给的那条命令行
 * @param opts 上限（省略用默认）
 * @returns 计划（`file` + `args`），调用方直接 spawn 它
 */
export function planSandboxed(
  command: string,
  opts: {
    memoryMb?: number;
    processes?: number;
  } = {},
): SandboxPlan {
  return planFor(command, probeSandbox(), opts);
}
