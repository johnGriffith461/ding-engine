#!/usr/bin/env node
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEngine, type Engine, type EngineRunRequest } from "../../engine/index";
import { cliSessionId } from "../../engine/core/events";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { snapshotOf, type Snapshot } from "../../engine/core/snapshot";
import { allProviders, firstAvailableProvider, getProvider } from "../../engine/runtime/providers";
import { describeBudget } from "../../engine/runtime/budget";
import { budgetOf } from "../../engine/runtime/budget";
import { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import { formatCount, usageTotal } from "../../shared/cost";
import { buildEngine as buildEngineIn } from "./assembly";
import { cmdEval } from "./cmdEval";
import { askMasked, cmdInit, cmdDoctor } from "./cmdSetup";
import { cmdSessions } from "./cmdSessions";
import { cmdBackup, cmdRestore, desktopDataDir, resolveBackupDataDir } from "./cmdBackup";
import { renderRecords } from "./renderRecords";
import { cmdResume } from "./cmdResume";
import { cmdAcp, cmdServe } from "./cmdServe";
import { cmdSpace } from "./cmdSpace";
import { cmdSync } from "./cmdSync";
import { cmdApprovals } from "./cmdApprovals";
import { cmdRecipe } from "./cmdRecipe";
import { cmdConnect } from "./cmdConnect";
import { cmdHelp } from "./help";
import { ensureConfigured } from "./wizard";
import { configPaths, describeConfig, effectiveConfig, readConfig, writeConfig, type CliConfig } from "./config";
import { replPrecondition, runRepl } from "./repl";
import { flag, flagAll, KNOWN_FLAGS, parseArgv, parseIntFlagValue, type Parsed } from "./args";
import {
  auditLedger,
  installFromDir,
  installFromNpm,
  makePackDir,
  packNpm,
  pluginPaths,
  readLedger,
  readManifestFromDir,
  readManifestFromTarball,
  setEnabled,
  uninstall,
} from "../../engine/adapters/pluginStore";
import { loadEnabledPlugins, loadedPlugins, withheldCapabilities } from "../../engine/runtime/pluginHost";
import { ENFORCED_PERMISSIONS, PLUGIN_PERMISSIONS, checkManifest, type PluginPermission } from "../../engine/runtime/plugins";
import { AGENT_SPECS } from "../../engine/runtime/agents";

/**
 * `ding` —— **CLI 宿主**（Phase 2）。
 *
 * ## 它是"宿主"，不是"另一个引擎"
 *
 * 这个文件里没有一行 agent 逻辑：跑一轮是 `engine.run`、投影是 `engine/core/events`、
 * 工具是 `engine/runtime/tools`。它只做三件宿主该做的事：
 *
 * 1. **把端口接上**（数据存哪、工具落到哪个目录、健康账本记不记）；
 * 2. **把结果画到终端**（用投影，不另写一份"怎么显示"）；
 * 3. **解析命令**。
 *
 * 它存在的意义，是让"桌面不是唯一宿主"这件事**已经成立**（而不是"计划要成立"）——
 * 同一份内核，换个宿主就能无头跑。
 *
 * ## 四个命令
 *
 * | 命令 | 用途 |
 * |---|---|
 * | `ding run "任务"` | 无头跑一轮（文件类工具，经与桌面**同一套**闸门） |
 * | `ding sessions` | 列会话 / 导出 JSONL（可观测性的出口） |
 * | `ding record <会话 id>` | 把一段会话录成快照（Phase 1 D6 的 fixture） |
 * | `ding replay <快照文件>` | 重放并与录下来的投影 diff（**重构零漂移**的验收器） |
 *
 * ## 一条纪律：它**不碰** Electron
 *
 * 这个文件（以及它 import 的一切）不许出现 `electron` —— 一旦出现，
 * "CLI 与桌面平权"就退化成"CLI 是桌面的一部分"。所以文件工具是从
 * `engine/runtime/tools/` 拿的，不是从 `electron/ipc/`。
 */

/**
 * 数据目录：默认 `~/.ding`，可用 `DH_DATA_DIR` 覆盖（多份数据并行跑时用）。
 *
 * ⭐ **顺带认桌面的那个覆盖变量**（2026-10-16，审计 P129）。
 *
 * 桌面把数据放在 `app.getPath("userData")`（可用 `DSH_CANVAS_DATA_DIR` 覆盖，
 * 见 `electron/main.ts`），CLI 放在 `~/.ding` —— 两个根**互不相干**。
 * 后果：`ding backup` 备份的永远是 CLI 那一份，桌面那 14 个 store 与 `sessions.db`
 * **一行都没进备份**，而命令的输出让用户以为"备份好了"。
 *
 * 这里能做的（不越界改别人的 cmdBackup/backup.ts）：**同一台机器上给出同一个开关** ——
 * 你只要用同一个 `DSH_CANVAS_DATA_DIR` 启动桌面、再跑 CLI，两者就落在同一个根上，
 * 备份与恢复覆盖的才是同一批数据。`DH_DATA_DIR` 仍然优先（它更具体）。
 *
 * ⚠️ 另一半（备份/恢复时**显式说出**根在哪、以及桌面的那份在不在里面）要改
 * `hosts/cli/cmdBackup.ts` —— 那不在本工单的文件范围里。
 */
function dataDir(): string {
  return (
    process.env.DH_DATA_DIR?.trim() ||
    process.env.DSH_CANVAS_DATA_DIR?.trim() ||
    path.join(os.homedir(), ".ding")
  );
}

/**
 * 授权目录：默认当前目录，`--dir` 可重复给（与桌面的"工作区授权"是同一个概念）。
 */
function workspaceDirs(extra: readonly string[]): string[] {
  return (extra.length ? extra : [process.cwd()]).map((d) => path.resolve(d));
}

/* ────────────────────── 终端输出（走投影） ────────────────────── */

/*
 * 渲染**只有一份**（审计 P217 / NEW-N7-26）：`./renderRecords.ts` 的 `renderRecords`。
 * 这里原来另有一份 `render()`，与 `ding recipe run` 用的那份在 `view.error` /
 * `trace.pending` 两处都不一样 —— 两份口径必然漂，所以合成一份。
 */

/** 目录表里关于这个模型的那几行（`ding models --json` 用；未登记就如实说）。 */
function budgetInfo(modelId: string): Record<string, unknown> {
  const got = budgetOf(modelId);
  return {
    registered: got.registered,
    contextWindow: got.contextWindow,
    stale: got.stale,
  };
}

/* 装配（CLI_TOOLS / buildEngine / 注册表来源）已搬到 ./assembly.ts —— 见那里的说明。 */

/**
 * 建一个供本次运行使用的引擎。
 *
 * ⚠️ 每一个端口都在这里**显式**给：数据在哪、工具能碰哪些目录、健康账本记不记
 * （CLI **不记**：跑一轮就退出，"下次启动时界面显示谁验证过"这件事在 CLI 里不存在）。
 *
 * 装配顺序有个环要绕：注册表要执行体、执行体要注册表（`spawn_agent` 要造子级工具集）。
 * 所以先给执行体一个**取值函数**，等注册表建好再把它填上 —— 环在装配期解开，
 * 运行期没有 null 检查。
 */
async function buildEngine(dirs: readonly string[]): Promise<{ engine: Engine; close: () => void; plugins: string[] }> {
  /*
   * 装配在 `./assembly.ts`（Phase 10 拆出来的）—— 评测器要**用同一份装配**跑，
   * 自己拼一套端口就等于绕开产品那条路。这里只负责把本宿主的数据目录传进去。
   */
  return buildEngineIn(dirs, dataDir());
}

/**
 * 备份/恢复要用的根，并**在根与桌面不一致时当场说清**（审计 P129）。
 *
 * 不说的话，这条命令的输出会让人以为"已经备份好了"—— 而桌面那份数据
 * （`stores.db` / `sessions.db` / 画布快照）根本没进这个文件。
 * 给出可照做的下一步（用同一个 `DSH_CANVAS_DATA_DIR` 指过去）。
 *
 * ⚠️ 给了 `--data-dir` 时以它为准（那是用户**显式**指定的根，见 `resolveBackupDataDir`）——
 * 否则这里会比着 CLI 的根去提醒"桌面那份不在里面"，而用户其实已经指过去了。
 */
function warnDesktopRoot(p: Parsed): string {
  const root = resolveBackupDataDir(p, dataDir());
  const desktop = desktopDataDir();
  if (!p.flags.has("json") && desktop && path.resolve(desktop) !== path.resolve(root)) {
    process.stderr.write(
      `⚠️ 桌面应用的数据在：${desktop}\n` +
        `   这次只动 CLI 的根：${root} —— 桌面那份**不在里面**。\n` +
        `   要一起备份/恢复：用同一个目录跑两边，例如 ` +
        `DSH_CANVAS_DATA_DIR="${desktop}" ding ${p.command} …\n`,
    );
  }
  return root;
}

/* ────────────────────── 命令 ────────────────────── */

/**
 * `--json`（Phase 9）：给 CI/脚本的输出模式。
 *
 * ⚠️ 它是**输出格式**开关，不是"另一种运行方式"：同一套代码路径，
 * 只把给人看的那几行换成 JSON。所以它落在**每个命令的渲染那一处**，
 * 而**判定只有这一处**（`flag(p,"json")`）—— 名字别改来改去。
 */
async function cmdRun(p: Parsed): Promise<number> {
  const task = p.args.join(" ").trim();
  if (!task) {
    process.stderr.write('用法：ding run "任务描述" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps <整数>]\n');
    return 2;
  }

  /*
   * ⚠️ `--steps` **先验后用**（审计 P49）：坏值原来静默变 `NaN`，
   * 而 `stepCountIs(NaN)` 的判据恒假 —— "最多跑几步"这道防失控闸会**恒不成立**，
   * 表现却是"参数好像没生效"。
   */
  const steps = parseIntFlagValue(flag(p, "steps"), "steps", { min: 1, max: 1000, fallback: 8 });
  if (!steps.ok) {
    process.stderr.write(`${steps.message}\n`);
    return 2;
  }

  /*
   * 优先级：**命令行显式参数 > 环境变量 > config.json > 内置默认**
   * （见 `hosts/cli/config.ts` 的文件头 —— 三层各有各的场合：
   * CI 用环境变量、日常用配置、临时用命令行）。
   */
  const { config, note } = effectiveConfig(dataDir());
  if (note) process.stderr.write(`[配置] ${note}\n`);

  const dirs = workspaceDirs(flagAll(p, "dir").length ? flagAll(p, "dir") : (config.dirs ?? []));

  const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider()?.id;
  if (!provider || !getProvider(provider)) {
    process.stderr.write(
      `没有可用的 provider。已登记的：${allProviders().map((x) => x.id).join(" / ")}\n` +
        `配置方式：设置对应环境变量（例如 DEEPSEEK_API_KEY），或写进 ~/.dsh/.credentials.yaml。\n`,
    );
    return 3;
  }

  const mode = normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认");
  const sessionId = cliSessionId(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const { engine, close, plugins } = await buildEngine(dirs);
  for (const problem of plugins) process.stderr.write(`[plugin] ${problem}\n`);

  process.stdout.write(
    `\x1b[2m工作区：${dirs.join(" / ")}\nprovider：${provider}　档位：${mode}　会话：${sessionId}\x1b[0m\n`,
  );

  const request: EngineRunRequest = {
    sessionId,
    provider,
    ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
    system: cliSystemPrompt(dirs, mode),
    messages: [{ role: "user", content: task }],
    mode,
    useTools: true,
    maxSteps: steps.value,
  };

  /*
   * ⭐ **长回合进度叙述**（Phase 13.3）：每一步结束打一行到 **stderr**。
   *
   * 打到 stderr 是刻意的：stdout 是"结果"（`render` 出来的正文），
   * 而进度是"过程" —— 混在一起会让 `ding run ... > out.txt` 的产物里夹着进度行。
   *
   * 口径与桌面**同一个字段**（`step-finish` 的 `usage`），所以两边说的是同一件事。
   * 拿不到用量就不显示数字（**不编**）。
   */
  /** 这一轮的累计 token（先累加、后报 —— 见下面那段说明） */
  let totalTokens = 0;
  const outcome = await engine.run({
    ...request,
    onEvent: (event) => {
      if (event.type !== "step-finish") return;
      /*
       * ⚠️ **累加**（2026-10-16，审计 P150）：`step-finish` 带的是**这一步**的用量，
       * 原来每次都拿它当"已用"报出去 —— 与同一轮的账本差一倍以上。
       * 桌面那边（`taskRunner` 的进度行）读同一个字段、同一套累加，措辞也一致。
       */
      const stepTokens = usageTotal(event.usage);
      if (stepTokens !== null) totalTokens += stepTokens;
      const head = event.step ? `第 ${event.step} 步` : "一步";
      const tail = totalTokens ? `（累计已用 ${formatCount(totalTokens)} token）` : "";
      process.stderr.write(`· ${head}${tail}\n`);
    },
  });
  if (p.flags.has("json")) {
    /*
     * JSON 输出给脚本用：**只把"发生过什么"结构化**，不夹一句人话。
     * 正文与留痕出自投影（与终端渲染同一份数据），所以两种输出不会对不上。
     */
    const snap = await engine.record(sessionId);
    const view = snap?.turns.at(-1)?.view;
    console.log(
      JSON.stringify(
        {
          ok: outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
          aborted: outcome.aborted,
          provider: outcome.provider,
          model: outcome.model,
          sessionId,
          text: view?.text ?? "",
          traces: (view?.traces ?? []).map((t) => ({ name: t.name, ok: t.ok, pending: t.pending === true, line: t.line })),
          ...(view?.usage ? { usage: view.usage } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    process.stdout.write(renderRecords(outcome.records));
  }
  close();

  if (!outcome.ok && !outcome.aborted) {
    process.stderr.write(`\n\x1b[31m没跑完：${outcome.error ?? "未知原因"}\x1b[0m\n`);
    return 1;
  }
  process.stdout.write(`\n\x1b[2m会话已存：${sessionId}（ding sessions 可列出，ding record ${sessionId} 可录快照）\x1b[0m\n`);
  return 0;
}

/**
 * 成本账本（`ding sessions --cost [--by day|model]`）。
 *
 * ⚠️ 账本是**从会话日志现算的**，没有第二份"用量统计"文件 ——
 * 另存一份统计迟早会与日志漂移（那是本项目的老毛病）。所以这里的数与
 * `--export` 出来的记录**必然一致**。
 */
async function cmdRecord(p: Parsed): Promise<number> {
  const sessionId = p.args[0];
  if (!sessionId) {
    process.stderr.write("用法：ding record <会话 id> [--out <文件>]\n（会话 id 从 ding sessions 拿）\n");
    return 2;
  }
  const store = createSqliteSessionStore(dataDir());
  const { records } = await store.load(sessionId);
  store.close();
  if (!records.length) {
    process.stderr.write(`会话 ${sessionId} 里没有记录。\n`);
    return 1;
  }
  const snap = snapshotOf(sessionId, records);
  const out = flag(p, "out") ?? path.join(dataDir(), "fixtures", `${sessionId}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(snap, null, 2), "utf8");
  process.stdout.write(`已录制 ${records.length} 条记录 / ${snap.turns.length} 轮 → ${out}\n`);
  return 0;
}

async function cmdReplay(p: Parsed): Promise<number> {
  const file = p.args[0];
  if (!file) {
    process.stderr.write("用法：ding replay <快照文件>\n");
    return 2;
  }
  const fixture = JSON.parse(await fs.readFile(path.resolve(file), "utf8")) as Snapshot;
  const store = createSqliteSessionStore(dataDir());
  const engine = createEngine({ store, executor: { run: async () => ({ ok: false, error: "重放不该执行工具" }) } });
  const diff = await engine.replay(fixture);
  store.close();

  if (diff.equal) {
    process.stdout.write(`✓ 重放一致（${fixture.turns.length} 轮，diff 为零）\n`);
    return 0;
  }
  process.stderr.write(`✗ 重放有差异（${diff.differences.length} 处）：\n`);
  for (const d of diff.differences) process.stderr.write(`  - ${d}\n`);
  return 1;
}

/**
 * `ding models` —— 列 provider 与模型，并**如实**标出每个模型的上下文数据从哪来。
 *
 * ⚠️ "未登记模型"要明说：我们不知道它的上限，走的是保守默认。
 * 让人以为"这个数是模型的上限"，比不给这个数更坏（见 `engine/runtime/budget.ts`）。
 */
function cmdModels(p: Parsed = { command: "", args: [], flags: new Map() }): number {
  if (p.flags.has("json")) {
    console.log(
      JSON.stringify(
        allProviders().map((provider) => ({
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          baseURL: provider.baseURL,
          models: provider.models.map((m) => ({ id: m, ...budgetInfo(m) })),
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const provider of allProviders()) {
    process.stdout.write(`${provider.id.padEnd(12)} ${provider.label}  [${provider.models.join(", ")}]\n`);
    for (const model of provider.models) {
      process.stdout.write(`             · ${describeBudget(model)}\n`);
    }
  }
  return 0;
}

/** CLI 的系统提示词：只讲"你在哪、能做什么、边界在哪"。 */
function cliSystemPrompt(dirs: readonly string[], mode: ConfirmMode): string {
  return [
    "你是 Ding Harness 无头命令行宿主里的一个 agent。",
    `你能操作的目录（白名单）：${dirs.join("、")}。白名单之外的路径一律碰不到，不要试。`,
    "工具有：list_files / list_dir / read_file / write_file / edit_file / search_files / run_command / spawn_agent。",
    mode === "全部允许"
      ? "当前档位「全部允许」：写文件与跑命令**会直接执行**。动手前先想清楚，尤其是覆盖已有文件。"
      : `当前档位「${mode}」：会改东西的调用会被拦下、交给人确认（无头模式下没人点，等于办不成）。`,
    "做完就把结果说清楚：改了哪些文件、下一步是什么。不要复述工具返回的原文。",
  ].join("\n");
}

/**
 * `ding plugins [子命令]` —— 插件管理（Phase 8.2 / 8.4 的 CLI 那一面）。
 *
 * ⚠️ 安装要求**显式确认**（`--yes`）：`install` 会把别人的代码装进你的机器，
 * 而"权限确认"这件事在无头环境里只能靠一个明确的旗子表达 ——
 * 没有它就把权限清单打出来并**拒绝安装**（而不是替你点了"同意"）。
 */
async function cmdPlugins(p: Parsed): Promise<number> {
  const paths = pluginPaths(dataDir());
  const sub = p.args[0] ?? "list";
  const name = p.args[1];
  const ledger = () => readLedger(paths).ledger.installed;

  /*
   * 先装载一遍开着的那批 —— 因为"哪些能力被扣下了"与"装载时发现了什么问题"
   * **只有装载才知道**（不装载的话 doctor 永远说"没问题"，那正是"检查在空转"）。
   */
  await loadEnabledPlugins(ledger());
  const problems = loadedPlugins().flatMap((pl) => pl.problems.map((x) => `${pl.name}：${x}`));

  if (sub === "list") {
    const list = ledger();
    if (p.flags.has("json")) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      console.log(`还没有装任何插件（目录：${paths.root}）`);
      console.log("装一个：ding plugins install <目录> --yes");
      return 0;
    }
    for (const item of list) {
      const granted = item.granted.length ? item.granted.join(" / ") : "无";
      console.log(`${item.name}@${item.version}　${item.enabled ? "开着" : "关着"}　权限：${granted}`);
      console.log(`    ${item.description}`);
    }
    const { missing } = auditLedger(paths);
    if (missing.length) console.error(`⚠️ 这些插件的目录不在了：${missing.join(" / ")}`);
    for (const w of withheldCapabilities()) {
      console.log(`（${w.plugin} 申请了但你没批：${w.permissions.join(" / ")}）`);
    }
    for (const problem of problems) console.log(`⚠️ ${problem}`);
    return 0;
  }

  if (sub === "install") {
    if (!name) {
      console.error("用法：ding plugins install <目录|npm:包名> [--yes] [--grant tools:register,hooks:register]");
      return 2;
    }
    /*
     * 两个渠道（Phase 8.2）：本地目录 `install <目录>`，npm 包 `install npm:<包名>`。
     *
     * ⚠️ npm 那条走**两段式**：先取包（`npm pack`）、读出清单给用户看，
     * 用户加 `--yes` 之后才真装。合成一步的话，"权限确认"就只能发生在
     * **已经下载并解开之后** —— 那不叫确认，那叫通知。
     */
    const isNpm = name.startsWith("npm:");
    const packDir = isNpm ? makePackDir() : "";
    const probe = isNpm
      ? (() => {
          const packed = packNpm(name.slice(4), packDir);
          if (!packed.ok) return { note: packed.errors.join("；") };
          return readManifestFromTarball(packed.tgz);
        })()
      : readManifestFromDir(path.resolve(name));
    if (!probe.raw) {
      console.error(`读不到清单：${probe.note ?? "未知原因"}`);
      return 1;
    }
    const checked = checkManifest(probe.raw);
    if (!checked.ok) {
      console.error("清单不合法：");
      for (const e of checked.errors) console.error(`  · ${e}`);
      return 1;
    }
    const m = checked.manifest;
    console.log(`插件 ${m.name}@${m.version}`);
    console.log(`  ${m.description}`);
    console.log(`  它申请的权限：${m.permissions.length ? m.permissions.join(" / ") : "（无）"}`);
    const enforced = m.permissions.filter((x) => ENFORCED_PERMISSIONS.includes(x));
    const declaredOnly = m.permissions.filter((x) => !ENFORCED_PERMISSIONS.includes(x));
    if (enforced.length) console.log(`  · 这几项**会真的生效**（不批就不接那根线）：${enforced.join(" / ")}`);
    if (declaredOnly.length) {
      console.log(`  · 这几项 v1 **拦不住**（插件与宿主同进程同权限）—— 是"知情"不是"限制"：${declaredOnly.join(" / ")}`);
    }

    if (!p.flags.has("yes")) {
      console.error("");
      console.error("确认之后再加 `--yes` 重跑（这一步就是权限确认：不替你点同意）。");
      return 3;
    }

    const grantArg = flag(p, "grant");
    const granted = grantArg
      ? grantArg
          .split(",")
          .map((x) => x.trim())
          .filter((x): x is PluginPermission => PLUGIN_PERMISSIONS.includes(x as PluginPermission))
      : undefined;
    const got = isNpm
      ? installFromNpm({ paths, spec: name.slice(4), ...(granted ? { granted } : {}) })
      : installFromDir({ paths, from: path.resolve(name), ...(granted ? { granted } : {}) });
    if (!got.ok) {
      console.error("装不上：");
      for (const e of got.errors) console.error(`  · ${e}`);
      return 1;
    }
    console.log("");
    console.log(`✓ 装好了：${got.plugin.name}@${got.plugin.version} → ${got.plugin.dir}`);
    return 0;
  }

  if (sub === "enable" || sub === "disable") {
    if (!name) {
      console.error(`用法：ding plugins ${sub} <名字>`);
      return 2;
    }
    const got = setEnabled(paths, name, sub === "enable");
    if (!got.ok) {
      console.error(got.note ?? "没成功");
      return 1;
    }
    console.log(`✓ ${name} 已${sub === "enable" ? "打开" : "关掉"}（下次运行生效）`);
    return 0;
  }

  if (sub === "remove") {
    if (!name) {
      console.error("用法：ding plugins remove <名字>");
      return 2;
    }
    const got = uninstall(paths, name);
    if (!got.ok) {
      console.error(got.note ?? "没成功");
      return 1;
    }
    console.log(`✓ 卸载了 ${name}（台账与它拷贝进来的那份内容都清了；你给它的源目录没动）`);
    return 0;
  }

  if (sub === "doctor") {
    const { missing } = auditLedger(paths);
    const withheld = withheldCapabilities();
    console.log(`插件目录：${paths.root}`);
    console.log(`台账：${paths.ledger}${existsSync(paths.ledger) ? "" : "（还没有）"}`);
    console.log(`装载了 ${loadedPlugins().length} 个（开着的那批）`);
    if (missing.length) console.log(`⚠️ 目录不在了：${missing.join(" / ")}`);
    for (const w of withheld) console.log(`⚠️ ${w.plugin} 申请的这几项没被批准：${w.permissions.join(" / ")}`);
    for (const problem of problems) console.log(`⚠️ ${problem}`);
    if (!missing.length && !withheld.length && !problems.length) console.log("没有发现问题。");
    return 0;
  }

  console.error(`不认识的子命令：${sub}（可用：list / install / enable / disable / remove / doctor）`);
  return 2;
}

/**
 * `ding config [--json]` / `ding config set <键> <值>` / `ding config unset <键>`
 *
 * ⚠️ 只改**这一个键**：先读回来再改再写（不是覆盖整份文件）——
 * 否则以后加一个键，旧版本一跑就把新键抹掉了。
 */
function cmdConfig(p: Parsed): number {
  const dir = dataDir();
  const sub = p.args[0] ?? "show";

  if (sub === "show") {
    const { config, note } = effectiveConfig(dir);
    if (p.flags.has("json")) {
      console.log(JSON.stringify({ dataDir: dir, ...config }, null, 2));
      return 0;
    }
    if (note) console.log(`⚠️ ${note}`);
    console.log(describeConfig(config));
    console.log("");
    console.log(`配置文件：${configPaths(dir).primary}${existsSync(configPaths(dir).primary) ? "" : "（还没有，set 一次就会建）"}`);
    console.log("改：ding config set provider deepseek ｜ ding config unset model");
    return 0;
  }

  if (sub === "set") {
    const key = p.args[1];
    const value = p.args.slice(2).join(" ").trim();
    if (!key || !value) {
      console.error("用法：ding config set <provider|model|mode|dirs> <值>（dirs 用逗号分隔）");
      return 2;
    }
    if (!["provider", "model", "mode", "dirs"].includes(key)) {
      console.error(`不认识的键：${key}（可用：provider / model / mode / dirs）`);
      return 2;
    }
    const current = readConfig(dir).config;
    const next = { ...current };
    if (key === "dirs") next.dirs = value.split(",").map((d: string) => d.trim()).filter(Boolean);
    else if (key === "mode") {
      const mode = normalizeConfirmMode(value);
      if (mode !== value) {
        console.error(`「${value}」不是有效档位。可用：${CONFIRM_MODES.join(" / ")}`);
        return 2;
      }
      next.mode = mode;
    } else if (key === "provider") next.provider = value;
    else next.model = value;

    const file = writeConfig(dir, next);
    console.log(`✓ ${key} = ${key === "dirs" ? next.dirs?.join(" / ") : value}`);
    console.log(`  写进了 ${file}`);
    return 0;
  }

  if (sub === "unset") {
    const key = p.args[1] as keyof CliConfig | undefined;
    if (!key || !["provider", "model", "mode", "dirs"].includes(key)) {
      console.error("用法：ding config unset <provider|model|mode|dirs>");
      return 2;
    }
    const current = { ...readConfig(dir).config };
    delete current[key];
    writeConfig(dir, current);
    console.log(`✓ 已清掉 ${key}（回落到默认）`);
    return 0;
  }

  console.error(`不认识的子命令：${sub}（可用：show / set / unset）`);
  return 2;
}

/** `ding agents` —— 列内置的专家（Phase 7.1 的数据化在这里可见）。 */
function cmdAgents(p: Parsed = { command: "", args: [], flags: new Map() }): number {
  if (p.flags.has("json")) {
    console.log(JSON.stringify(AGENT_SPECS.map((a) => ({ name: a.name, description: a.description, tools: a.tools ?? null, maxSteps: a.maxSteps })), null, 2));
    return 0;
  }
  for (const spec of AGENT_SPECS) {
    const tools = spec.tools ? spec.tools.join(" / ") : "（不限）";
    console.log(spec.name);
    console.log(`    ${spec.description}`);
    console.log(`    工具：${tools}　步数：${spec.maxSteps}`);
  }
  return 0;
}

/**
 * 不给参数时：**进交互模式**（Phase 9）。
 *
 * ⚠️ 口径在 2026-10-16（审计 P212）**收窄过一次**，这段说明跟着改了：
 *   · 命令位置是一个 **ASCII 小写单词**（能对上 `[a-z][a-z-]*`）而**不是**已知命令
 *     → 在 `main()` 里当场报错退出 2：`ding restor …` 这种拼错不再静默进 REPL、
 *     也不再在脚本/CI 里把 stdin 吃干；
 *   · 其余的自由文本（中文、带空格的一整句）**照旧**当任务 —— 终端里 `ding 你好`
 *     这种写法很自然，进交互模式并把它当成任务，比报"未知命令"更贴近人的预期。
 * 唯一要避免的是"静默什么都不做"，所以交互模式一定会有可见的回显。
 */
async function cmdDefault(p: Parsed, devMode: boolean): Promise<number> {
  // `help` / `--help` / `-h` 在任何时候都是帮助，不进交互

  /*
   * 向导要临时借 stdin 问几句话；REPL 起来之后由它自己接管。
   * 所以这个 `rl` 在进 REPL 之前关掉（两个 readline 抢同一路输入会丢行）。
   */
  /*
   * 向导要临时借 stdin 问几句话；REPL 起来之后由它自己接管。
   * 所以这个 `rl` 在进 REPL 之前关掉（两个 readline 抢同一路输入会丢行）。
   *
   * ⚠️ 用**可变引用**（不是裸 const）：要是哪一问是"密钥"（`{secret:true}`），
   * `askMasked` 会把它关掉重建（遮蔽输入只能这么做），裸 const 之后就会
   * "关掉的是旧那个、真正在用的是新的" —— 两个 readline 抢输入，正是上面那句要避开的。
   */
  const rlRef = { current: createInterface({ input: process.stdin, output: process.stdout, terminal: false }) };
  const plainAsk = (q: string, opts?: { default?: string }) =>
    new Promise<string>((resolve) => {
      const suffix = opts?.default ? ` [${opts.default}]` : "";
      rlRef.current.question(`${q}${suffix} `, (answer) => resolve(answer.trim() || opts?.default || ""));
    });
  if (p.command === "help" || p.flags.has("help") || p.flags.has("h")) return cmdHelp(devMode, dataDir());

  /*
   * ⚠️ 先过**首次配置**这道门（Phase 11.3）。
   *
   * 原来是直接 `replPrecondition()` 报错退出 —— 一个刚装好的人看到的是
   * 「没有可用的 provider」然后进程结束（方案 U1 要的是「五分钟上手」）。
   * 现在没配就走向导：配 key → 选模型 → 选目录，两分钟。
   *
   * 非交互环境（管道 / CI）里向导**不提问**：`ensureConfigured(null, …)` 只给一句
   * 能照做的说明 —— 在 CI 里等输入的向导会把流水线卡死。
   */
  const configured = await ensureConfigured(
    process.stdin.isTTY
      ? {
          /*
           * ⚠️ 这一份 `ask` 原来**也**忽略 `opts.secret`（审计 P199 点名的第二处：
           * 首次 `ding` 走的就是这条路）。现在与 `ding init` 共用同一个遮蔽实现 ——
           * 两处各写一遍正是这条缺陷能同时存在两次的原因。
           */
          ask: (q, opts) =>
            opts?.secret ? askMasked(rlRef, `${q} `, () => plainAsk(q, opts)) : plainAsk(q, opts),
          say: (line) => process.stdout.write(line + "\n"),
        }
      : null,
    { dataDir: dataDir() },
  );
  if (!configured.ok) {
    process.stderr.write(`${configured.reason ?? "还没配好"}\n`);
    return 3;
  }
  rlRef.current.close();

  const ready = replPrecondition();
  if (!ready.ok) {
    process.stderr.write(`${ready.reason}\n`);
    return 3;
  }

  const { config, note } = effectiveConfig(dataDir());
  if (note) process.stderr.write(`[配置] ${note}\n`);

  const dirs = workspaceDirs(flagAll(p, "dir").length ? flagAll(p, "dir") : (config.dirs ?? []));
  const built = await buildEngine(dirs);
  for (const problem of built.plugins) process.stderr.write(`[plugin] ${problem}\n`);

  const provider = flag(p, "provider") ?? config.provider ?? firstAvailableProvider()!.id;
  const mode = normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认");
  const sessionId = cliSessionId(`repl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);

  try {
    return await runRepl(
      {
        engine: built.engine,
        sessionId,
        provider,
        ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
        mode,
        dataDir: dataDir(),
        renderLatest: async () => {
          const snap = await built.engine.record(sessionId);
          if (snap) process.stdout.write(renderRecords(snap.records));
        },
      },
      config,
    );
  } finally {
    built.close();
  }
}

/* ────────────────────── 入口 ────────────────────── */

/**
 * 入口。
 *
 * ⚠️ 收进一个 `main()`，**不用顶层 await**：CLI 的发布产物是 **CommonJS**
 * （见 `tsconfig.cli.json` 的说明：源码里的相对 import 不写扩展名，ESM 不认），
 * 而 CJS 里顶层 await 是语法错误。tsx 直跑时两种都行 —— 所以这个坑只有
 * 在**真的构建一次产物**时才会露出来。
 */
async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));

  /*
   * ⭐ **参数层面的错在这里拦，不在命令里各自静默**（审计 P50 / P219 / P220）：
   * 缺值的值旗标、空值、不认识的旗标 —— 从前它们全都无声通过，
   * 表现成"我明明给了 --provider"或"参数好像没生效"。
   */
  if (parsed.problems?.length) {
    process.stderr.write(`${parsed.problems.map((line) => `参数不对：${line}`).join("\n")}\n`);
    process.exit(2);
  }
  if (parsed.unknown?.length) {
    process.stderr.write(
      `不认识的旗标：${parsed.unknown.map((key) => `--${key}`).join(" / ")}（拼错了？要传字面量就用 -- 隔开）\n` +
        `可用旗标：${[...KNOWN_FLAGS].join(" / ")}\n`,
    );
    process.exit(2);
  }

  /* `--dev`：工程模式（Phase 9）。`record` / `replay` 是**验收驱动器**，不是产品表面 ——
   * 它们留在命令行里（脚本要用），但**不出现在默认帮助里**，除非显式 `--dev`。
   * 这样"给人看的命令面"与"给工程用的命令面"分得开，而两者还在同一个二进制里。 */
  const devMode = parsed.flags.has("dev");

  /*
   * ⭐ **不认识的子命令要报错，不能静默进 REPL**（2026-10-16，审计 P212）。
   *
   * 缺陷形状：这条三元链落到底就是 `cmdDefault`（进交互模式），只有 `help` 被特判。
   * 于是 `ding restore backup.json` 打成 `ding restor backup.json` 时：
   * 交互终端里"进了 REPL"（用户以为自己命令写对了），脚本/CI 里进程**吃掉 stdin 等输入** ——
   * 一个拼写错误被静默执行成了完全不同的事。
   *
   * 口径（不用新旗标、不改 args.ts）：命令位置是一个**ASCII 小写单词**（`[a-z][a-z-]*`）
   * 且不在已知命令表里 → 报错退出 2，并告诉他想跑一句话该用 `ding run "…"`。
   * 中文/带空格的自由文本**照旧**当任务（`ding 你好` 这条自然写法不受影响）。
   */
  const knownCommands = new Set([
    "run",
    "sessions",
    "record",
    "replay",
    "models",
    "plugins",
    "recipe",
    "space",
    "sync",
    "approvals",
    "serve",
    "connect",
    "acp",
    "resume",
    "backup",
    "restore",
    "doctor",
    "init",
    "eval",
    "config",
    "agents",
  ]);
  if (parsed.command && !knownCommands.has(parsed.command) && /^[a-z][a-z-]*$/.test(parsed.command)) {
    process.stderr.write(
      `不认识的命令：${parsed.command}（可用：${[...knownCommands].join(" / ")}）\n` +
        `要跑一句话当任务，用：ding run "${parsed.args.join(" ") || "…"}"\n`,
    );
    process.exit(2);
  }

  const code =
    parsed.command === "run"
      ? await cmdRun(parsed)
      : parsed.command === "sessions"
        ? await cmdSessions(parsed, dataDir())
        : parsed.command === "record"
          ? await cmdRecord(parsed)
          : parsed.command === "replay"
            ? await cmdReplay(parsed)
            : parsed.command === "models"
              ? cmdModels(parsed)
              : parsed.command === "plugins"
                ? await cmdPlugins(parsed)
                : parsed.command === "recipe"
                  ? await cmdRecipe(parsed, dataDir())
                  : parsed.command === "approvals"
                    ? await cmdApprovals(parsed)
                  : parsed.command === "sync"
                    ? await cmdSync(parsed, dataDir())
                  : parsed.command === "space"
                    ? await cmdSpace(parsed, dataDir())
                  : parsed.command === "serve"
                  ? await cmdServe(parsed, dataDir())
                  : parsed.command === "connect"
                  ? await cmdConnect(parsed)
                  : parsed.command === "acp"
                    ? await cmdAcp(parsed, dataDir())
                    : parsed.command === "resume"
                  ? await cmdResume(parsed, dataDir())
                  : parsed.command === "backup"
                  ? await cmdBackup(parsed, warnDesktopRoot(parsed))
                  : parsed.command === "restore"
                    ? await cmdRestore(parsed, warnDesktopRoot(parsed))
                    : parsed.command === "doctor"
                  ? cmdDoctor(parsed, dataDir())
                  : parsed.command === "init"
                    ? await cmdInit(parsed, dataDir())
                    : parsed.command === "eval"
                  ? await cmdEval(parsed)
                  : parsed.command === "config"
                  ? cmdConfig(parsed)
                  : parsed.command === "agents"
                    ? cmdAgents(parsed)
                    : await cmdDefault(parsed, devMode);
  process.exit(code);
}
void main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[31m出错了：${detail}[0m\n`);
  process.exit(1);
});
