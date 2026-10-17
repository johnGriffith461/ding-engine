import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";

/**
 * CLI 的**配置**（Phase 9）。
 *
 * ## 它解决的问题
 *
 * 在这之前，每次跑 `ding run` 都要把 `--provider` / `--model` / `--mode` 再写一遍 ——
 * 而"我这台机器上默认用哪家"是个**长期偏好**，不是每轮的参数。
 *
 * ## 文件位置与名字（一处如实说明）
 *
 * 方案里写的是 `~/.ding/config`，这里用的是 **`config.json`**（同一个目录）：
 * 带扩展名编辑器才会当 JSON 高亮，而它就是个 JSON。
 * ⚠️ 为了不让人因为这条差异踩空：**两种名字都读**（`config.json` 优先，
 * 没有就读无扩展名的 `config`），写只写 `config.json`。
 *
 * ## 配置的**优先级**（写清楚，因为它决定"改了为什么没生效"）
 *
 * ```
 * 命令行显式参数  >  环境变量（DH_PROVIDER 等）  >  config.json  >  内置默认
 * ```
 *
 * 只有"显式给了"才覆盖 —— 不给就一路回落。这样 CI 里用环境变量、
 * 日常用配置文件、临时用命令行，三者不打架。
 */

/** 配置项。 */
export type CliConfig = {
  /** 默认 provider（不填就挑第一个有密钥的）。 */
  provider?: string;
  /** 默认模型（不填用该 provider 的第一个）。 */
  model?: string;
  /** 默认闸门档位。 */
  mode?: ConfirmMode;
  /** 默认工作目录（可多个）。 */
  dirs?: string[];
  /**
   * 软限额（美元，Phase 13.2）。**0 或没设 = 不提示**。
   *
   * 方案的口径是"**提示，不硬断**" —— 它只是一句话，不会拦住任何一轮。
   * 默认不设是刻意的：替用户定一个他没同意的额度，比不提示更烦人。
   */
  softLimitUsd?: number;
};

/** 配置文件位置。 */
export function configPaths(dataDir: string): { primary: string; legacy: string } {
  return { primary: path.join(dataDir, "config.json"), legacy: path.join(dataDir, "config") };
}

/**
 * 配置文件里**允许**出现的键（与 `CliConfig` 一一对应）。
 *
 * ⚠️ 这张表是 doctor 的"配置文件合法"那格"按**原文**比对"用的（审计 P202 / NEW-N7-8）：
 * `normalizeConfig` 会把不认识的键与类型不符的值**静默丢掉**，于是只看收窄后的值
 * 就永远报"合法"—— 而用户看到的表现是"我明明配了啊"。
 * （2026-10-17 从 doctor 搬到这里：配置的合法键属于配置模块，自检只借它用。）
 */
export const CONFIG_KEYS = ["provider", "model", "mode", "dirs", "softLimitUsd"] as const;

/** 收窄从磁盘读回来的配置（**磁盘不可信**：坏值一律丢掉，别让它影响一次真实运行）。 */
export function normalizeConfig(raw: unknown): CliConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: CliConfig = {};
  if (typeof o.provider === "string" && o.provider.trim()) out.provider = o.provider.trim();
  if (typeof o.model === "string" && o.model.trim()) out.model = o.model.trim();
  if (o.mode !== undefined) out.mode = normalizeConfirmMode(o.mode);
  if (typeof o.softLimitUsd === "number" && Number.isFinite(o.softLimitUsd) && o.softLimitUsd > 0) {
    out.softLimitUsd = o.softLimitUsd;
  }
  if (Array.isArray(o.dirs)) {
    const dirs = o.dirs.filter((d): d is string => typeof d === "string" && d.trim() !== "");
    if (dirs.length) out.dirs = dirs;
  }
  return out;
}

/**
 * 读配置（两种文件名都认，`config.json` 优先）。
 *
 * ⚠️ 读不动**不抛**：配置坏了不该让命令跑不起来 —— 回落到空配置（于是全用命令行与默认值），
 * 而把原因报给调用方去显示。
 *
 * @param dataDir 数据目录
 * @returns 配置与提示（提示只在读文件出问题时才有）
 */
export function readConfig(dataDir: string): { config: CliConfig; note?: string } {
  const { primary, legacy } = configPaths(dataDir);
  const file = existsSync(primary) ? primary : existsSync(legacy) ? legacy : null;
  if (!file) return { config: {} };
  try {
    return { config: normalizeConfig(JSON.parse(readFileSync(file, "utf8"))) };
  } catch (error) {
    return { config: {}, note: `配置文件读不动（${path.basename(file)}：${error instanceof Error ? error.message : String(error)}），已当空配置` };
  }
}

/**
 * 写配置（原子：先写临时文件再改名）。
 *
 * @param dataDir 数据目录
 * @param config 完整配置（调用方先读再改再写，避免覆盖掉别人写的项）
 */
export function writeConfig(dataDir: string, config: CliConfig): string {
  const { primary } = configPaths(dataDir);
  mkdirSync(path.dirname(primary), { recursive: true });
  const tmp = `${primary}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmp, primary);
  return primary;
}

/** 环境变量覆盖（CI/脚本用；显式命令行仍在它之上）。 */
export function configFromEnv(): CliConfig {
  const out: CliConfig = {};
  if (process.env.DH_PROVIDER?.trim()) out.provider = process.env.DH_PROVIDER.trim();
  if (process.env.DH_MODEL?.trim()) out.model = process.env.DH_MODEL.trim();
  if (process.env.DH_MODE?.trim()) out.mode = normalizeConfirmMode(process.env.DH_MODE.trim());
  if (process.env.DH_DIRS?.trim()) {
    const dirs = process.env.DH_DIRS.split(/[;,]/)
      .map((d) => d.trim())
      .filter(Boolean);
    if (dirs.length) out.dirs = dirs;
  }
  return out;
}

/**
 * 合并三层：内置默认 ← 配置文件 ← 环境变量。
 *
 * ⚠️ 命令行**不在这里**：它是"这一次"的，由各命令自己叠在最上面
 * （这里只负责"长期偏好"那两层）。混进来的话，`ding config` 显示的
 * 就不是"配置"而是"这一次的运行参数"了。
 */
export function effectiveConfig(dataDir: string): { config: CliConfig; note?: string } {
  const file = readConfig(dataDir);
  const env = configFromEnv();
  return {
    config: { ...file.config, ...env },
    ...(file.note ? { note: file.note } : {}),
  };
}

/** 给人看的一句话（`ding config` 的默认输出）。 */
export function describeConfig(config: CliConfig): string {
  const lines = [
    `provider：${config.provider ?? "（没设，挑第一个有密钥的）"}`,
    `model：${config.model ?? "（没设，用该 provider 的第一个）"}`,
    `档位：${config.mode ?? "（没设，默认「按需确认」）"}（可选：${CONFIRM_MODES.join(" / ")}）`,
    `工作目录：${config.dirs?.length ? config.dirs.join(" / ") : "（没设，用当前目录）"}`,
  ];
  return lines.join("\n");
}
