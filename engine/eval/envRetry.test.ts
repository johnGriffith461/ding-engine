import type { Engine } from "../index";
import type { TurnEvent } from "../runtime/loop";
import { describe, expect, it } from "vitest";

import { runSuite } from "./run";
import type { EvalCase } from "./types";

/**
 * 「装置不可达」那条路的分寸（2026-10-16）。
 *
 * ## 为什么要单开这一组
 *
 * 本机实测有"随机某几条用例红"的假红：假 provider 的回环端口**绑得上、连不上**
 * （现场与判据见 `fakeProvider.ts` 的 `listenReachablePort`）。修法有两层：
 * 起服务时做一次 HTTP 自检 + 重绑（那一层在 `fakeProvider.ts`），
 * 以及这里测的这一层 —— `runSuite` 对**装置签名**的失败重跑一次，
 * 重跑仍红则标成 `environment`（不计进 `failed`）。
 *
 * 这一层最容易出事的地方**不是**"没救回来"，而是**"把产品失败也当装置放行"** ——
 * 那就是审计反复点名的"重试即算通过"。所以这组用例把**四条边**全钉住：
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | 装置不可达一次、重跑就好 | 通过，且 `retried=1`（痕迹不许抹掉） |
 * | ② | 装置始终不可达 | `environment=1`、`failed=0`（不赖产品） |
 * | ③ | **产品真的错了**（错误文案里没有回环签名） | `failed=1`、**不重跑**、`environment=0` |
 * | ④ | 真 provider 那条路（`fakeProvider:false`）出现同样的文案 | **不重跑、不放行**（真出网的问题必须让人看见） |
 */

/** 一条最小用例：断"按顺序出现 text → done"。 */
function caseOf(id: string): EvalCase {
  return {
    id,
    category: "纯对话",
    title: `装置测试用 ${id}`,
    turns: ["测试"],
    expect: { events: ["text", "done"] },
  } as EvalCase;
}

/** 造一个只会吐给定事件的假引擎（不碰网络、不碰模型 —— 测的是 runSuite 的判定）。 */
function engineThatEmits(eventsPerCall: TurnEvent[]): { engine: Engine; close: () => void } {
  const engine = {
    async run(opts: { onEvent?: (e: TurnEvent) => void }) {
      for (const e of eventsPerCall) opts.onEvent?.(e);
    },
    async resume() {
      return { turns: [] };
    },
  } as unknown as Engine;
  return { engine, close: () => undefined };
}

/** 装置签名：回环地址 + TCP 层连不上（与 `environmentFailure` 的判据同一形状）。 */
const ENV_ERROR: TurnEvent = {
  type: "error",
  message: "Cannot connect to API: connect ETIMEDOUT 127.0.0.1:58855",
} as TurnEvent;

/** 产品签名：文案里没有回环地址 —— 这类必须判红。 */
const PRODUCT_ERROR: TurnEvent = {
  type: "error",
  message: "工具 read_file 失败了：ENOENT（用例没声明）",
} as TurnEvent;

const OK_EVENTS: TurnEvent[] = [{ type: "text", text: "好" } as TurnEvent, { type: "done" } as TurnEvent];

describe("评测：装置不可达的处理分寸", () => {
  it("① 装置不可达一次、重跑就好 → 通过，且留下 retried 痕迹", async () => {
    let calls = 0;
    const report = await runSuite([caseOf("env-once")], {
      makeEngine: async () => {
        calls += 1;
        return engineThatEmits(calls === 1 ? [ENV_ERROR] : OK_EVENTS);
      },
      sessionPrefix: "envtest",
    });
    expect(calls, "第一次红了才该重跑（重跑一次 = makeEngine 被调两次）").toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.environment).toBe(0);
    expect(report.results[0]!.retried, "重跑过就留痕，报告里要看得见").toBe(1);
    expect(report.results[0]!.ok).toBe(true);
  });

  it("② 装置始终不可达 → 算 environment（不赖产品），但仍会被门禁拒绝", async () => {
    const report = await runSuite([caseOf("env-always")], {
      makeEngine: async () => engineThatEmits([ENV_ERROR]),
      sessionPrefix: "envtest",
    });
    expect(report.failed, "装置不可达不算产品失败").toBe(0);
    expect(report.environment, "但要单独计数、报告里点名").toBe(1);
    expect(report.results[0]!.environment).toContain("装置不可达");
    expect(report.passed, "它不是通过").toBe(0);
    expect(report.rate, "分母里不该留着它").toBe(0);
  });

  it("③ 产品真错了（文案里没有回环签名）→ 判红，不重跑，绝不放行", async () => {
    let calls = 0;
    const report = await runSuite([caseOf("product-bad")], {
      makeEngine: async () => {
        calls += 1;
        return engineThatEmits([PRODUCT_ERROR]);
      },
      sessionPrefix: "envtest",
    });
    expect(calls, "产品失败不许触发重跑（那就是'重试即算通过'）").toBe(1);
    expect(report.failed).toBe(1);
    expect(report.environment).toBe(0);
    expect(report.results[0]!.retried).toBeUndefined();
  });

  it("④ 真 provider 那条路（fakeProvider:false）出现同样的文案 → 不重跑、不放行", async () => {
    let calls = 0;
    const report = await runSuite([caseOf("real-provider")], {
      fakeProvider: false,
      makeEngine: async () => {
        calls += 1;
        return engineThatEmits([ENV_ERROR]);
      },
      sessionPrefix: "envtest",
    });
    expect(calls, "真出网那条路不做装置重跑 —— 那可能是真的网络问题").toBe(1);
    expect(report.failed, "真 provider 的连不上就是失败，必须红").toBe(1);
    expect(report.environment).toBe(0);
  });
});
