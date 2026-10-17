import fs from "node:fs";
import path from "node:path";

import { allProviders } from "../../engine/runtime/providers";
import { hasSecret, credentialsPath, invalidateCredentialCache } from "../../engine/runtime/credentials";
import { CONFIRM_MODES, type ConfirmMode } from "../../shared/ipc";
import { MODEL_CATALOG } from "../../engine/runtime/models";
import { readConfig, writeConfig, type CliConfig } from "./config";

/**
 * 首次配置向导（Phase 11.3）。
 *
 * 方案原文：「交互式配 provider key（不逼用户手工编辑配置文件）→ 选模型
 * （目录表按 verifiedAt 推荐默认值）→ 选工作目录」，验收是**新用户全程 ≤ 5 分钟**。
 *
 * ## 为什么它长成"纯逻辑 + 注入 IO"这个样子
 *
 * 向导最大的风险不是写不出来，是**没人能验**：它要人在终端里敲键盘。
 * 所以这里把两件事分开：
 *
 *   · **逻辑**（问什么、怎么收窄、算出什么配置）——纯函数，单测能一遍遍跑；
 *   · **IO**（怎么问、怎么读一行、怎么显示）——注入进来，测试里换成一个"预先写好的答案序列"。
 *
 * 这样"新用户 ≤ 5 分钟"这条可以被自动重放（Phase 10.4 要的"首跑路径可自动重放"），
 * 而不是靠某次手工演示。
 *
 * ## 它**不改用户的机器**，只做两件事
 *
 * 1. 把 key 写进 `~/.dsh/.credentials.yaml`（**只写它自己那一行**，不碰别的键）；
 * 2. 把 provider / model / dirs / mode 写进 `~/.ding/config.json`。
 *
 * 其余什么都不动（不装东西、不改 PATH、不写注册表）。
 *
 * ## ⚠️ 这份 key 是**明文**（审计 P114/P120，如实记）
 *
 * CLI 这台机器上没有系统钥匙串集成（`engine/adapters/secretStore.ts` 的 `secretsEncrypted()`
 * 在 CLI 下恒 false），所以向导**没法**加密 —— 它写的就是明文。
 * 桌面端（Electron）「设置里填一次」那条路才走 `safeStorage`（DPAPI/Keychain）加密。
 * 真要减少明文面：用环境变量，或者去桌面端填。向导里那句提示就是照这个说的（不许写成"已加密"）。
 *
 * ⚠️ `writeFileSync(..., { mode: 0o600 })` **在 Windows 上不生效**（NTFS 走 ACL，
 * Node 的 mode 只影响只读位）—— 所以那句"权限 600"已经从用户可见的话里删掉了：
 * 平台做不到的事不当承诺念（审计 P120）。
 */

/** 向导的 IO（测试里换成预设答案）。 */
export type WizardIo = {
  /** 问一句，返回用户输入（已 trim）。 */
  ask: (question: string, opts?: { default?: string; secret?: boolean }) => Promise<string>;
  /** 显示一行（不带问题）。 */
  say: (line: string) => void;
};

/** 向导的结局。 */
export type WizardResult = {
  /** 有没有真的写盘。 */
  wrote: boolean;
  /** 写进配置的那些值（也用于报给用户看）。 */
  config: CliConfig;
  /** 配了哪家的 key（不打印明文）。 */
  providerWithKey?: string;
  /** 中途退出（用户按了 Ctrl+C / 输入空）时的原因。 */
  skipped?: string;
};

/** 选一家"最可能有 key"的 provider：优先已经在环境里配好的，其次表里的第一家。 */
function suggestProvider(): string {
  const withKey = allProviders().find((p) => p.id !== "strata" && hasSecret(p.keyRef));
  if (withKey) return withKey.id;
  // 表里第一家非本机的（顺序就是"推荐顺序"，见 providers.ts）
  return allProviders().find((p) => p.id !== "strata")?.id ?? "deepseek";
}

/**
 * 按"目录表里的核实日期"推荐一个默认模型。
 *
 * 方案原文说"目录表按 verifiedAt 推荐默认值" —— 也就是**优先刚核实过的**。
 * 目录表里没有 verifiedAt 那条模型时，退回该 provider 的第一个模型（不编）。
 */
export function suggestModel(providerId: string): string {
  const def = allProviders().find((p) => p.id === providerId);
  if (!def) return MODEL_CATALOG[0]?.id ?? "";
  /*
   * 目录表按 id 匹配该 provider 的模型名（模型名与 provider 的 models 列可能写法不同，
   * 所以先精确命中，再退回 provider 自带的第一个）。
   */
  const inCatalog = def.models
    .map((m) => MODEL_CATALOG.find((spec) => spec.id === m))
    .filter((spec): spec is NonNullable<typeof spec> => Boolean(spec))
    .sort((a, b) => (b.verifiedAt ?? "").localeCompare(a.verifiedAt ?? ""));
  return inCatalog[0]?.id ?? def.models[0] ?? "";
}

/** 把一行 key 追加/替换进凭据文件（**只碰这一个键**）。 */
/**
 * 把一条 key 写进凭据文件（**只碰这一个键**）。
 *
 * ⚠️ 格式是 `refs:` 下面**缩进一层**的 `KEY: value` —— 不是扁平的一行。
 * 第一版按扁平写了一行，而读取端（`parseRefs`）只在 `refs:` 段里找键 ——
 * 于是**写进去的 key 永远读不到**（表现是「向导说配好了，实际没有」）。
 * 这条是 `wizard.test.ts` 逮到的：它验的是「写完能读回来」，不是「文件里有那几个字」。
 *
 * 写法上刻意**不做完整 YAML 解析**：只在这个文件的 `refs:` 段内替换/追加那一行，
 * 段外的东西（注释、别人的键、别的段）原样保留。
 */
export function writeSecret(refName: string, value: string): { ok: boolean; file: string; error?: string } {
  const file = credentialsPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "") : "";
    const lines = existing.split(/\r?\n/);
    const refsAt = lines.findIndex((line) => /^refs:\s*$/.test(line.trim()));

    if (refsAt < 0) {
      // 还没有 refs 段：整段新加（原文件内容保留）
      const kept = [...lines];
      while (kept.length && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();
      if (kept.length) kept.push("");
      kept.push("refs:", `  ${refName}: ${value}`);
      fs.writeFileSync(file, kept.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      invalidateCredentialCache();
      return { ok: true, file };
    }

    // 有 refs 段：段内同名那一行丢掉，在段尾追加新的
    const refsIndent = (lines[refsAt] ?? "").length - (lines[refsAt] ?? "").trimStart().length;
    const sameKey = new RegExp(`^\\s*${refName}\\s*:`);
    const kept: string[] = [];
    let end = refsAt + 1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (i > refsAt) {
        const indent = line.length - line.trimStart().length;
        if (line.trim() && indent <= refsIndent) break; // 段结束
        end = i + 1;
        if (sameKey.test(line)) continue;
      }
      kept.push(line);
    }
    const tail = lines.slice(end);
    while (kept.length && (kept[kept.length - 1] ?? "").trim() === "") kept.pop();
    const out = [...kept, `  ${refName}: ${value}`, ...(tail.some((l) => l.trim()) ? [""] : []), ...tail];
    fs.writeFileSync(file, out.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    invalidateCredentialCache();
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, error: (error as Error)?.message ?? "写不进去" };
  }
}

/**
 * 跑一遍向导。
 *
 * ⚠️ 依赖里**只有 `dataDir`**（审计 P221 / NEW-N7-30）：原来还有一个
 * `hasUsableProvider` 入参，但它**从没被读过** —— `ding init` 传 `false`、
 * `ensureConfigured` 传真值，两条路跑出来一样。删掉它而不是"真用"：
 * 向导该按 `suggestProvider()` + 现场 `hasSecret()` 判断（那就是这台机器的真实情况），
 * 从外面再传一个同样的布尔只是第二份会漂的口径。
 *
 * @param io 问答通道
 * @param deps 依赖（数据目录；测试里指到临时目录）
 * @returns 结局
 */
export async function runWizard(io: WizardIo, deps: { dataDir: string }): Promise<WizardResult> {
  io.say("看起来你还没配好模型。三件事，两分钟就能跑起来。");
  io.say("");

  /* ① provider */
  const providers = allProviders().filter((p) => p.id !== "strata");
  const suggested = suggestProvider();
  io.say("可选的 provider：");
  for (const p of providers) {
    const mark = hasSecret(p.keyRef) ? "（已有 key）" : "";
    io.say(`  ${p.id.padEnd(12)} ${p.label} ${mark}`);
  }
  const providerId = (await io.ask(`用哪家？`, { default: suggested })) || suggested;
  const def = providers.find((p) => p.id === providerId);
  if (!def) {
    return { wrote: false, config: {}, skipped: `没有这家 provider：${providerId}` };
  }

  /* ② key（已经有就不再问） */
  let providerWithKey: string | undefined;
  if (hasSecret(def.keyRef)) {
    io.say(`${def.id} 已经有 key 了（${def.keyRef}），跳过这一步。`);
    providerWithKey = def.id;
  } else {
    io.say(`需要一个 ${def.id} 的 API key。`);
    /*
     * ⚠️ 这两句是**用户可见的承诺**，必须与代码一致（审计 P120）：
     *   · CLI 下 `secretsEncrypted()` 恒 false → 这里写进去的一定是明文，就得说明文；
     *   · 不许再写"权限 600"：Windows 上不生效（NTFS ACL），念一遍等于骗人。
     * 想走系统加密只有一条路：桌面端设置里填一次（那份进 safeStorage）。
     */
    io.say(
      `会写进 ${credentialsPath()} 的 refs 段（**明文**：这台机器上 CLI 没有系统钥匙串集成；桌面端设置里填的那份才加密）。`,
    );
    io.say(`也可以跳过，改成自己设环境变量 ${def.keyRef}（更推荐 —— 不落盘）。`);
    const key = await io.ask("粘贴 key（留空则跳过）", { secret: true });
    if (key) {
      const wrote = writeSecret(def.keyRef, key);
      if (!wrote.ok) {
        io.say(`写凭据失败：${wrote.error}。你可以自己把 \`${def.keyRef}: <key>\` 写进 ${wrote.file}`);
      } else {
        providerWithKey = def.id;
        io.say(`已写入 ${wrote.file}`);
      }
    } else {
      io.say(`跳过 —— 记得设环境变量 ${def.keyRef}，否则这家用不了。`);
    }
  }

  /* ③ 模型 */
  const modelDefault = suggestModel(def.id);
  io.say("");
  io.say(`${def.id} 可用的模型里，目录表**最近核实过**的是：`);
  for (const m of def.models.slice(0, 6)) {
    const spec = MODEL_CATALOG.find((x) => x.id === m);
    io.say(`  ${m}${spec ? `  （上下文 ${spec.contextWindow.toLocaleString()}，核实于 ${spec.verifiedAt ?? "未记"}）` : "  （目录表里没有它：上下文按保守默认）"}`);
  }
  const model = (await io.ask("用哪个模型？", { default: modelDefault })) || modelDefault;

  /* ④ 工作目录 */
  io.say("");
  io.say("最后一项：让 agent 能看哪个目录（它只能在你授权的目录里读写）。");
  const dirsAnswer = await io.ask("工作目录（留空 = 每次用当前目录）", { default: "" });
  const dirs = dirsAnswer
    ? dirsAnswer
        .split(/[,，;；]/)
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => path.resolve(d))
    : [];

  /* ⑤ 安全默认档：直接告诉他默认是什么，不让他选（少一个问题，且默认是安全的那侧） */
  const mode: ConfirmMode = "按需确认";
  io.say("");
  io.say(`审批档位先用「${mode}」：读操作直接放行，写文件与跑命令会先问你。`);
  io.say(`想全放开：ding config set mode ${CONFIRM_MODES[0]}；想更严：ding config set mode ${CONFIRM_MODES[2]}`);

  const config: CliConfig = {
    provider: def.id,
    model,
    mode,
    ...(dirs.length ? { dirs } : {}),
  };
  writeConfig(deps.dataDir, config);
  io.say("");
  io.say(`配置已写入 ${path.join(deps.dataDir, "config.json")}`);
  io.say("跑一句试试：ding run \"列出当前目录里的文件\"");
  return { wrote: true, config, ...(providerWithKey ? { providerWithKey } : {}) };
}

/**
 * 启动前的那道门（Phase 11.3 + 10.4 的"首跑路径可自动重放"）。
 *
 * `ding` 进交互模式之前调用它：配好了就什么都不做；没配好就**进向导**（而不是报错退出）。
 *
 * ⚠️ 与改造前的差别：原来是 `replPrecondition()` 直接报"没有可用 provider"然后退出 ——
 * 新用户看到的就是一句冷冰冰的失败（而方案 U1 要的是"五分钟上手"）。
 *
 * @param io 问答通道（不给 = 非交互环境：只报告，不提问）
 * @param deps 数据目录等
 * @returns 是否已经可用（false 表示用户跳过或失败了）
 */
export async function ensureConfigured(
  io: WizardIo | null,
  deps: { dataDir: string },
): Promise<{ ok: boolean; reason?: string; wizard?: WizardResult }> {
  const providers = allProviders().filter((p) => p.id !== "strata");
  const cfg = readConfig(deps.dataDir).config;
  const hasAny = providers.some((p) => hasSecret(p.keyRef));
  const configured = cfg.provider && providers.some((p) => p.id === cfg.provider && hasSecret(p.keyRef));
  if (hasAny && (!cfg.provider || configured)) return { ok: true };

  if (!io) {
    return {
      ok: false,
      reason:
        "没有可用的模型凭据。跑一次 `ding init` 会带你配好（或者自己设环境变量，见 README 的「配置模型」）。",
    };
  }

  const wizard = await runWizard(io, { dataDir: deps.dataDir });
  if (wizard.skipped) return { ok: false, reason: wizard.skipped, wizard };
  const after = readConfig(deps.dataDir).config;
  const ok = Boolean(after.provider && providers.some((p) => p.id === after.provider && hasSecret(p.keyRef)));
  return {
    ok,
    ...(ok ? {} : { reason: "向导跑完了，但那家还是没有 key（跳过这一步了？）—— 设好环境变量再来。" }),
    wizard,
  };
}

/** 可用的 runtime（写进 doctor 的明细，也让"无 Node 环境"这件事可查）。 */
export function availableRuntimes(): string {
  return typeof (process.versions as { bun?: string }).bun === "string" ? "bun" : "node";
}
