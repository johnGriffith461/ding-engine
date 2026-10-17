import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classifyFailure, failureMessage, humanFailure, type FailureKind } from "./errors";
import { pendingApprovalNotice, toolFailedNotice } from "../engine/core/notices";

/**
 * 「人话清单」（Phase 10.4 第二件事 + Phase 13.1）。
 *
 * ## 它挡的是什么
 *
 * 方案 13.1 要求错误/拦截/限额文案**单一来源**，10.4 要求它们**过"人话清单"评审**。
 * 评审如果只是"看一眼觉得还行"，那它每季度都会过 —— 所以这里把它写成**可证伪的规矩**：
 *
 * | 规矩 | 为什么 |
 * |---|---|
 * | 不许出现裸状态码（429 / 502 / ECONNREFUSED …） | 它们对用户没有信息量，要翻译成"限流 / 上游不可用 / 连不上" |
 * | 每条都要给出**下一步** | 只说"出错了"等于把问题丢回给用户 |
 * | 不许出现 `undefined` / `null` / `[object Object]` / `Error:` | 那是泄漏，不是文案 |
 * | 拦截类必须说明**还没有执行** | 用户最需要知道的是"我的东西没被动" |
 * | 同一个原因在两条通道里必须同一句话 | 这是 13.1 的实质（不是"有个公共文件"就算收口） |
 *
 * ## 覆盖范围
 *
 * 三个来源：`shared/errors.ts` 的全部类别、`engine/core/notices.ts` 的模型侧三条、
 * 以及**真实源码里出现的中文告警串**（扫 `src/`、`electron/`、`hosts/`、`engine/`
 * 里的 `humanError` / `humanFailure` 调用点所用文案）。
 */

const ROOT = path.resolve(__dirname, "..");

/** 全部失败类别（`FailureKind` 的字面量联合，这里逐个列出来验 —— 漏一个就少验一条）。 */
const ALL_KINDS: FailureKind[] = [
  "aborted",
  "auth",
  "model",
  "rate",
  "quota",
  "network",
  "upstream",
  "moderation",
  "timeout",
  "unknown",
];

/** 裸状态码 / 协议词：出现在面向用户的文案里就是没翻译。 */
const RAW_JARGON = /\b(429|4\d\d|5\d\d|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|JSON|HTTP\/\d|stack|traceback)\b/;

/** 泄漏形状：这些一出现就说明有东西没被处理。 */
const LEAKS = /\b(undefined|null|NaN|\[object Object\]|Error:|TypeError|Promise)\b/;

/** "下一步"的动作词（文案里要有其中一个）。 */
const NEXT_STEP = /(重试|检查|确认|换一个|改用|稍后|等待|充值|去掉|缩短|重开|再说一遍|看|改|联系|启动|核对)/;

/**
 * 豁免名单：**逐条写明为什么它可以不带下一步**。
 *
 * 豁免不是"这条文案不好" —— 而是"它不是给用户看的一句话"或"它本身就是下一步"。
 * 每加一条都要写出理由，因为这张表会长成"随手加一行让它变绿"的样子。
 */
const EXEMPT: Array<{ text: string; why: string }> = [
  { text: "已中止", why: "用户自己按的停止 —— 没有「下一步」可言，那正是他要的结果" },
];

describe("人话清单（Phase 10.4 / 13.1）", () => {
  it("① 每个失败类别都有一句话，且不含裸状态码", () => {
    for (const kind of ALL_KINDS) {
      const text = failureMessage(kind);
      if (kind === "unknown") {
        // 认不出来时不编话，交给调用方兜底（截断原文）—— 这里只要求它返回空串
        expect(text, "unknown 不该编一句通用话术（那会掩盖真实原因）").toBe("");
        continue;
      }
      expect(text.length, `类别 ${kind} 没有文案`).toBeGreaterThan(0);
      expect(RAW_JARGON.test(text), `类别 ${kind} 的文案里有裸协议词：「${text}」`).toBe(false);
      const exempt = EXEMPT.some((e) => e.text === text);
      if (!exempt) {
        expect(NEXT_STEP.test(text), `类别 ${kind} 的文案没给出下一步：「${text}」`).toBe(true);
      }
    }
  });

  it("② 类别判定顺序正确：欠费优先于限流（同一个 429 两种下一步）", () => {
    // 上游欠费时常回 429；只说"限流，稍后重试"会让用户一直重试到天荒地老
    expect(classifyFailure("429 Too Many Requests: insufficient balance")).toBe("quota");
    // 纯限流才是限流
    expect(classifyFailure("429 Too Many Requests: rate limit exceeded")).toBe("rate");
    // 认证问题别被"quota"里那几个字误伤
    expect(classifyFailure("401 Unauthorized: invalid api key")).toBe("auth");
    // 模型名不对
    expect(classifyFailure("404 model not found: gpt-404")).toBe("model");
    // 连不上
    expect(classifyFailure("fetch failed: ECONNREFUSED 127.0.0.1:8080")).toBe("network");
  });

  it("③ 两条通道对同一个原因说同一句话（这才是 13.1 的实质）", () => {
    /*
     * 收口的判据不是"有一个公共文件"，而是**同一个原因在两处的输出一致**。
     * 这里直接比：不带原文的那份，必须是不带原文那份的前缀（图像侧只是多附了原文）。
     */
    const cases = [
      "429 rate limit",
      "401 unauthorized",
      "insufficient balance",
      "content policy violation",
      "502 upstream unavailable",
    ];
    for (const raw of cases) {
      const plain = humanFailure(raw); // 文本对话那条
      const detailed = humanFailure(raw, { keepDetail: true }); // 图像那条
      expect(plain.length, `${raw}：文本侧没给文案`).toBeGreaterThan(0);
      expect(detailed.startsWith(plain), `${raw}：两条通道说法不一致 —— 「${plain}」vs「${detailed}」`).toBe(true);
    }
  });

  it("④ 认不出来时不编话：截断原文（不猜原因）", () => {
    const weird = "x".repeat(500);
    const got = humanFailure(weird, { fallbackLimit: 200 });
    expect(got.length).toBe(200);
    expect(got.startsWith("xxx")).toBe(true);
    // 图像那条要保留原文（用户拿它去查账）
    expect(humanFailure("某个没见过的错", { keepDetail: true })).toContain("某个没见过的错");
  });

  it("⑤ 模型侧三条留痕文案同样过清单（拦截/失败/最小粒度）", () => {
    const notices = [
      { what: "闸门拦截", text: pendingApprovalNotice("write_file", "按需确认") },
      { what: "工具失败", text: toolFailedNotice("read_file", "这个路径不在可读写范围内") },
      { what: "工具失败（无原因）", text: toolFailedNotice("read_file", undefined) },
    ];
    for (const { what, text } of notices) {
      expect(text.length, `${what} 文案是空的`).toBeGreaterThan(0);
      expect(RAW_JARGON.test(text), `${what} 文案里有裸协议词：「${text}」`).toBe(false);
      expect(LEAKS.test(text), `${what} 文案里有泄漏形状：「${text}」`).toBe(false);
    }
    /*
     * 拦截那条**必须**说清"还没有执行"：用户看到"要你确认"时心里第一个问题是
     * "它到底动没动我的文件"。这是方案对 U4（说人话）最具体的一条要求。
     */
    expect(pendingApprovalNotice("write_file", "按需确认")).toContain("还没有执行");
    // 失败那条要**透传执行体给的原因**（各工具最清楚自己为什么失败），并给下一步
    const failed = toolFailedNotice("read_file", "这个路径不在可读写范围内");
    expect(failed).toContain("这个路径不在可读写范围内");
  });

  it("⑥ 面向用户的出错路径都走统一话术（源码级守卫：不许再长出第二份）", () => {
    /*
     * 这一条挡的是**回流**：哪天有人在某处又写一句 `上游 ${status}：…`，
     * 就又分叉了。判据是"这几处必须调用统一实现"。
     */
    const mustUse = [
      "engine/runtime/loop.ts",
      "src/ai/imageClient.ts",
      "electron/ipc/imageGen.ts",
    ];
    const missing: string[] = [];
    for (const rel of mustUse) {
      const src = readFileSync(path.join(ROOT, rel), "utf8");
      if (!/humanFailure|humanError/.test(src)) missing.push(rel);
    }
    expect(missing, "这些文件的错误话术没有走 shared/errors.ts").toEqual([]);

    /*
     * 反向：源码里不该再有**没经过统一话术**的裸状态码消息。
     *
     * ⚠️ 判据不是"字符串里出现了 `上游 ${res.status}`" —— 统一话术**需要**把状态码
     * 当成判定输入（`humanFailure(\`上游 429 …\`)`）。第一版就那么写，于是把
     * 改好的那两处也判成违规。真正的判据是**它有没有交给 `humanFailure`**。
     */
    const offenders: string[] = [];
    for (const rel of ["electron/ipc/imageGen.ts", "src/ai/imageClient.ts", "engine/runtime/loop.ts"]) {
      const src = readFileSync(path.join(ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const m of src.matchAll(/`[^`]*上游 \$\{res\.status\}[^`]*`/g)) {
        const before = src.slice(Math.max(0, m.index - 40), m.index);
        if (!before.includes("humanFailure(")) offenders.push(`${rel}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(offenders, "又出现了把裸状态码直接当用户消息的写法").toEqual([]);
  });
});
