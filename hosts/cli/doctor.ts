import {
  runDoctor as runDoctorCore,
  configIssues as configIssuesCore,
  type Check,
  type ConfigIssues,
  type DoctorInput as CoreDoctorInput,
} from "../../engine/runtime/doctor";
import { CONFIG_KEYS, normalizeConfig } from "./config";

/**
 * `ding doctor` 的 **CLI 侧包装**（2026-10-17）。
 *
 * 自检本体搬去了 `engine/runtime/doctor.ts`（理由写在那个文件头：桌面也要跑同一套，
 * 而 `hosts/**` 不进 Electron 构建）。这个文件只负责**收 CLI 那半**：
 *
 *   · 配置从 `config.json` 收窄（engine 不认识 CLI 的配置文件）；
 *   · "配置文件合法"那格按 `CONFIG_KEYS` 白名单比对。
 *
 * 对 `cmdSetup.ts` / 测试与任何 `import … from "./doctor"` 的调用方，
 * 名字与签名**一个都没变**（`export *` 把 engine 那半边原样转发）。
 */

export * from "../../engine/runtime/doctor";

/** CLI 侧的 doctor 输入：`rawConfig` 是原文，收窄在下面的包装器里做。 */
export type DoctorInput = Omit<CoreDoctorInput, "config">;

/**
 * 跑整套自检（CLI 口径）。
 *
 * @param input 数据目录 / 平台信息 / 配置原文
 * @returns 检查项（`next` 必填，见 engine 那侧的类型说明）
 */
export function runDoctor(input: DoctorInput): Check[] {
  return runDoctorCore({
    ...input,
    config: { normalized: normalizeConfig(input.rawConfig), allowedKeys: CONFIG_KEYS },
  });
}

/** 按 CLI 的合法键表看一遍配置原文（签名与原来一致：收窄在里面对接）。 */
export function configIssues(raw: unknown): ConfigIssues {
  return configIssuesCore(raw, CONFIG_KEYS);
}
