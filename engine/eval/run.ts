import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Engine } from "../index";
import type { TurnEvent } from "../runtime/loop";
import { startFakeProvider, type EvalReply } from "./fakeProvider";
import type { EvalCase, EvalCategory } from "./types";

/**
 * 跑一条评测用例（Phase 10 的执行器）。
 *
 * ## 判据怎么算出来的
 *
 * 一条用例跑完之后，手上有四样东西，分别对着三样判据：
 *
 * | 判据 | 取自 |
 * |---|---|
 * | 事件序列 | `engine.run` 的 `onEvent` 收集到的 `TurnEvent[]`（**真代码路径吐出的事件**） |
 * | 关键文案 | 事件里的文本 + 工具结果 + 落盘记录，拼成一份大文本再找关键字 |
 * | 产物存在性 | 工作目录里真的去看（不算"模型说它写了"） |
 *
 * 另外两条（闸门待决、步数、账本）取自 `resume()` 的投影 ——
 * 也就是**状态 = fold(events)** 那条不变量本身：如果事件流不足以还原出"有审批待决"，
 * 那么界面上也还原不出来。
 *
 * ## ⚠️ 每个用例一个独立的临时工作目录 + 一个独立的假 provider
 *
 * 两者都是为了**隔离**：共用目录会让"上一个用例写下的文件"变成下一个用例的既有状态；
 * 共用假 provider 会让迟到请求串台（`loop.test.ts` 用两次红换来的教训）。
 */

/** 一条用例的失败项（空 = 通过）。 */
export type EvalFailure = { caseId: string; what: string; detail: string };

export type EvalCaseResult = {
  id: string;
  category: EvalCategory;
  title: string;
  ok: boolean;
  failures: EvalFailure[];
  /** 这一步实际吐出的事件类型序列（报告里能看到"差在哪"）。 */
  eventTypes: string[];
  steps: number;
  ms: number;
  /** 这一条的用量（把各步 `done` 事件的 usage 加起来）。矩阵拿它算花费。 */
  usage: { input: number; output: number };
  /**
   * 这一轮里 `error` 事件说了什么（截断，最多 3 条）。
   *
   * ⚠️ 以前报告里只有"有 error"（事件序列对不上时会写"实际：error"），
   * **为什么错一个字都看不到** —— 于是"假通道连不上"和"产品真的出错"长得一模一样。
   */
  errors?: string[];
  /**
   * 上游报错的**原文**（同一次运行里的英文/系统原文，最多 3 条）。
   *
   * ⚠️ 与 `errors` 分开是故意的：`errors` 是给用户看的人话，`rawErrors` 才有可判定的信息
   * （`connect ETIMEDOUT 127.0.0.1:58855`）。**装置判据用后者**，界面上永远不出现它。
   */
  rawErrors?: string[];
  /** 这一条被重跑过几次（见 `runSuite` 里的"装置不可达"处理）。 */
  retried?: number;
  /**
   * 判红的原因是**装置**（本机回环那一会儿不通，连不上我们自己的假 provider），
   * 不是产品。这类**不计进 `failed`**，单独计数并在报告里点名（见 `EvalReport.environment`）。
   */
  environment?: string;
};

/** 宿主提供给评测器的东西（装配方式由宿主决定：CLI 给真装配，测试给同一份）。 */
export type EvalDeps = {
  /**
   * 为**这个工作目录**建一个引擎。
   *
   * 为什么要宿主给：引擎的端口（数据放哪、工具能碰哪些目录）全是宿主决定的 ——
   * 评测器自己拼一套端口就等于**绕开了产品那条装配路**，
   * 那样测出来的"通过率"不能代表产品（SessionStore 记错地方、工具少了白名单都会漏掉）。
   */
  makeEngine: (workDir: string) => Promise<{ engine: Engine; close: () => void }>;
  /** 会话 id 前缀（方便在临时目录里认出来）。 */
  sessionPrefix?: string;
  /**
   * 用哪个 provider。默认 `strata`（那个本来指本机服务的），也就是**假 provider 那条路**。
   *
   * ⚠️ 跨 provider 质量-成本矩阵（10.7）会把它换成真 provider ——
   * 那时 `fakeProvider: false`，用例脚本里的"模型回复"就没人读了，
   * 评测变成"拿真模型跑同一批题、看通过率与花费"。**那会花钱**，所以默认不开。
   */
  provider?: string;
  /** 用哪个模型（默认 `deepseek-flash`）。矩阵那条按 provider 换。 */
  model?: string;
  /** 要不要起假 provider（默认要）。`false` = 打真端点。 */
  fakeProvider?: boolean;
};

/** 起一个一次性的临时工作目录。 */
function tempWorkDir(caseId: string): string {
  const safe = caseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return fs.mkdtempSync(path.join(os.tmpdir(), `dh-eval-${safe}-`));
}

/** 把桩文件写进工作目录（父目录按需建）。 */
function writeFixtures(workDir: string, fixtures: Record<string, string> | undefined): void {
  for (const [rel, content] of Object.entries(fixtures ?? {})) {
    const full = path.join(workDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

/** 递归把一个未知值里的所有字符串拼起来（关键文案断言用）。 */



/**
 * 「关键文案」判据的那一堆字（2026-10-16，审计 P149）。
 *
 * ## 原来为什么不行
 *
 * 原来把**整份事件流 + 整份 resumed** 铺平进 haystack。那里面混着两类
 * **不该算"文案"**的东西：
 *   · `tool-call.input` —— 模型自己编的工具参数（假 provider 的脚本里就把 needle 写在参数里）；
 *   · `resumed` 的输入侧 —— **用户自己的原话**。
 *
 * 后果实测：把 `read_file` / `list_dir` / `search_files` / `run_command` 的
 * **执行体整块砸掉**，13/18 处「关键文案」仍然全绿 —— 判据测的是"脚本里写过这个词"，
 * 不是"产品把它呈现出来了"。
 *
 * ## 现在只收两类（产品真的会给用户看的）
 *
 *   · **助手正文**：流里的 `text` 事件 / 投影出的 `TurnView.text`；
 *   · **工具留痕与工具输出**：`tool-result` 的 output / 投影里的 `traces[].line`
 *     （以及错误那一句）。工具**参数**不算 —— 那是模型的草稿，不是文案。
 *
 * @param events 这一批跑出来的事件
 * @param turns 投影出来的轮（`resume` 的结果）
 * @returns 拼成一段文本（判据在这里面 `includes`）
 */
export function copyHaystack(
  events: readonly { type: string; [k: string]: unknown }[],
  turns: readonly { view: { text: string; error?: string; traces: { line: string }[] } }[],
): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "text" && typeof event.text === "string") parts.push(event.text);
    else if (event.type === "tool-result") parts.push(JSON.stringify(event.output ?? ""));
    else if (event.type === "error" && typeof event.message === "string") parts.push(event.message);
  }
  for (const turn of turns) {
    parts.push(turn.view.text);
    for (const trace of turn.view.traces) parts.push(trace.line);
    if (turn.view.error) parts.push(turn.view.error);
  }
  return parts.join("\n");
}

/**
 * 跑一条用例。
 *
 * @param c 用例
 * @param deps 宿主给的装配
 * @returns 结果（含失败原因；**不抛异常** —— 一条用例炸了不该带走整批）
 */
export async function runCase(c: EvalCase, deps: EvalDeps): Promise<EvalCaseResult> {
  const started = Date.now();
  const failures: EvalFailure[] = [];
  const events: TurnEvent[] = [];
  const workDir = tempWorkDir(c.id);
  const fail = (what: string, detail: string) => failures.push({ caseId: c.id, what, detail });

  /*
   * 纯函数格子（`kind: "core"`）：不起 provider、不跑回合 —— 直接问核心里那把尺子。
   * 它照样走同一套结果形状（成功/失败/耗时），所以报告与基线不必分两种。
   */
  if (c.kind === "core") {
    try {
      const detail = c.coreCheck?.();
      if (detail) fail("核心判据", detail);
    } catch (error) {
      fail("异常", String((error as Error)?.message ?? error).slice(0, 200));
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    return {
      id: c.id,
      category: c.category,
      title: c.title,
      ok: failures.length === 0,
      failures,
      eventTypes: [],
      steps: 0,
      ms: Date.now() - started,
      usage: { input: 0, output: 0 },
    };
  }

  /*
   * `{{dir}}` 占位先替换掉：用例是**静态数据**，而工作目录是运行时才建的。
   * 写死绝对路径会让用例跟着临时目录漂（一次一换），所以统一在这里换一次 ——
   * 必须在**起假 provider 之前**换，否则 provider 脚本里还是占位符。
   */
  const substituted: EvalReply[][] = (c.replies ?? []).map((turnReplies) =>
    turnReplies.map((reply) => {
      if (!("call" in reply) || !reply.call) return reply;
      return {
        ...reply,
        call: reply.call.map((call) => ({
          name: call.name,
          args: JSON.parse(JSON.stringify(call.args).replaceAll("{{dir}}", JSON.stringify(workDir).slice(1, -1))) as Record<string, unknown>,
        })),
      };
    }),
  );

  /*
   * ⭐ **上游原文**（2026-10-16）：给用户看的那句是"人话"（`连不上 provider（检查网络…）`），
   * 而"到底是不是本机回环不通"只有原文里才有（`connect ETIMEDOUT 127.0.0.1:58855`）。
   * 这条口子只喂装置，不喂界面 —— 见 `EngineRunRequest.onRawError`。
   */
  const rawErrors: string[] = [];

  const useFake = deps.fakeProvider !== false;
  /*
   * ⭐ 父级标记（审计 P158）：宿主在 system 里塞一句独一无二的话，
   * 假 provider 按它认"这是父级那一轮"——比"带着用户原话"可靠（空串会恒真）。
   */
  const parentMark = `[eval-parent:${c.id}]`;
  const provider = useFake ? await startFakeProvider(substituted.flat(), c.turns ?? [], { parentMark }) : null;
  const prevBase = process.env.STRATA_BASE_URL;
  const prevKey = process.env.STRATA_API_KEY;
  if (provider) {
    process.env.STRATA_BASE_URL = provider.url;
    process.env.STRATA_API_KEY = "eval-key";
  }

  let close: (() => void) | null = null;
  /*
   * ⭐ **逐条看门狗**（2026-10-16，审计 P157）：原来 `engine.run` 没有超时，
   * 一条挂住的用例 = 整套红（vitest 的 beforeAll 超时），而且**看不出是哪一条**。
   * 现在每一条自己带着表：到点 abort（引擎会收尾成 aborted），并**如实判这条红**。
   */
  const CASE_WATCHDOG_MS = 60_000;
  const watchdog = new AbortController();
  const watchdogTimer = setTimeout(() => watchdog.abort(), CASE_WATCHDOG_MS);
  try {
    writeFixtures(workDir, c.fixtures);
    const built = await deps.makeEngine(workDir);
    close = built.close;
    const sessionId = `${deps.sessionPrefix ?? "eval"}-${c.id}`;

    const turns = c.turns ?? [];
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i] ?? "";
      await built.engine.run({
        sessionId,
        provider: deps.provider ?? "strata",
        model: deps.model ?? "deepseek-flash",
        /* 标记只用于假 provider 认父级 —— 真 provider 收到它也无害（就是一句 system 前缀） */
        system: parentMark,
        abortSignal: watchdog.signal,
        messages: [{ role: "user", content: turn }],
        mode: c.mode ?? "按需确认",
        ...(c.useTools === false ? { useTools: false } : { useTools: true }),
        maxSteps: c.maxSteps ?? 4,
        onEvent: (e) => events.push(e),
        onRawError: (raw) => rawErrors.push(raw),
      });
    }

    /* ---------- 判据一：事件序列（子序列） ---------- */
    const types: string[] = events.map((e) => e.type);
    const expect = c.expect ?? {};
    if (expect.events?.length) {
      let at = 0;
      for (const want of expect.events) {
        const found = types.indexOf(want, at);
        if (found < 0) {
          fail("事件序列", `期望按顺序出现 ${expect.events.join(" → ")}，但第 ${at + 1} 个「${want}」没出现（实际：${types.join(" → ")}）`);
          break;
        }
        at = found + 1;
      }
    }

    /* ---------- 判据二：关键文案（只找"产品呈现给用户的那两类字"，见 copyHaystack） ---------- */
    if (expect.copy?.length) {
      const resumed = await built.engine.resume(sessionId);
      const haystack = copyHaystack(events, resumed.turns);
      for (const needle of expect.copy) {
        if (!haystack.includes(needle)) {
          fail("关键文案", `呈现出来的文案里没有「${needle}」`);
        }
      }
    }

    /* ---------- 判据四：工具结果**不许无声失败**（2026-10-16） ---------- */
    /*
     * ⭐ 这是"改坏就红"的主柱子（审计 P149 的配套）：用例的 `copy` 判据再怎么写，
     * 也拦不住"执行体整块被砸掉"——因为脚本化 provider 的正文照吐。
     * 但执行体坏了，`tool-result` 一定带 `error`。于是：**没声明的工具错误一律判红**，
     * 声明的（读不存在的文件、闸门拦下那类）用 `expect.toolErrors` / `allowToolFailures` 放行。
     */
    if (!expect.allowToolFailures) {
      const declared = new Set(expect.toolErrors ?? []);
      const failedTools = events
        .filter((e) => e.type === "tool-result")
        .map((e) => ({
          toolName: String((e as { toolName?: string }).toolName ?? "?"),
          error: (e as { error?: string }).error,
        }))
        .filter((e) => Boolean(e.error) && !declared.has(e.toolName));
      if (failedTools.length) {
        fail(
          "工具结果",
          `${failedTools.length} 条工具调用失败了（用例没声明）：` +
            failedTools.map((e) => `${e.toolName}：${String(e.error).slice(0, 60)}`).join(" / "),
        );
      }
    }

    /* ---------- 判据三：产物存在性 ---------- */
    for (const rel of expect.files ?? []) {
      if (!fs.existsSync(path.join(workDir, rel))) fail("产物", `期望落盘的「${rel}」不存在`);
    }
    for (const rel of expect.filesAbsent ?? []) {
      if (fs.existsSync(path.join(workDir, rel))) fail("产物", `不该存在的「${rel}」却在`);
    }

    /* ---------- 闸门 / 步数 / 账本（都取自投影） ---------- */
    if (expect.gate) {
      const resumed = await built.engine.resume(sessionId);
      const pending = (resumed.pending ?? []).length;
      if (expect.gate === "pending" && pending === 0) fail("闸门", "期望有待决审批，实际没有");
      if (expect.gate === "none" && pending > 0) fail("闸门", `期望没有待决审批，实际有 ${pending} 条`);
    }
    if (expect.eventsAbsent?.length) {
      for (const banned of expect.eventsAbsent) {
        if (types.includes(banned)) fail("事件序列", `不该出现的「${banned}」出现了（实际：${types.join(" → ")}）`);
      }
    }
    if (expect.delegations !== undefined) {
      const n = types.filter((t) => t === "delegation").length;
      if (n < expect.delegations) fail("委派", `至少 ${expect.delegations} 次委派，实际 ${n} 次`);
    }
    if (expect.toolErrors?.length) {
      for (const name of expect.toolErrors) {
        const hit = events.some((e) => e.type === "tool-result" && e.toolName === name && Boolean(e.error));
        if (!hit) fail("工具报错", `期望「${name}」以失败收场，但没见到它失败`);
      }
    }
    /*
     * ---------- 判据六：**下发给模型的工具清单**（2026-10-16，审计 P153） ----------
     *
     * `FakeProvider.bodies` 一直记着"发出去的请求体"，但全仓零读取 ——
     * 于是"记忆 / 工具白名单 / 档位"这一类判据一条都写不出来。
     * 这里读第一个请求体里的 `tools[].function.name`：**它决定模型能做什么**，
     * 比"事后看它调了什么"更靠前一层。
     */
    if ((expect.toolsSent?.length || expect.toolsNotSent?.length) && provider) {
      const firstBody = provider.bodies[0] as { tools?: Array<{ function?: { name?: string } }> } | undefined;
      const names = (firstBody?.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean);
      for (const want of expect.toolsSent ?? []) {
        if (!names.includes(want)) fail("工具清单", `下发的工具里没有「${want}」（实际：${names.join(" / ") || "一个都没有"}）`);
      }
      for (const banned of expect.toolsNotSent ?? []) {
        if (names.includes(banned)) fail("工具清单", `不该下发的工具「${banned}」出现了（模型会以为自己能做这件事）`);
      }
    }
    if (expect.toolErrorIncludes?.length) {
      const messages = events
        .filter((e) => e.type === "tool-result")
        .map((e) => String((e as { error?: string }).error ?? ""))
        .join("\n");
      for (const needle of expect.toolErrorIncludes) {
        if (!messages.includes(needle)) fail("工具报错", `失败的文案里没有「${needle}」（实际：${messages.slice(0, 160)}）`);
      }
    }
    const steps = types.filter((t) => t === "step-finish").length;
    if (expect.minSteps !== undefined && steps < expect.minSteps) {
      fail("步数", `至少 ${expect.minSteps} 步，实际 ${steps} 步`);
    }
    if (expect.usage) {
      /*
       * ⚠️ 判据要落在**数字**上：第一版是在投影里找 `tokens|usage` 这个**字符串**，
       * 而投影里那些是字段名/数值 —— 于是它永远匹配不到，**用例红得毫无意义**
       * （假判据比没有判据更糟：它让人以为"账本验过了"）。
       */
      const withUsage = events.some(
        (e) => e.type === "done" && e.usage && (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0) > 0,
      );
      if (!withUsage) fail("账本", "这一轮没有任何带数字的用量（done 事件的 usage 是空的）");
    }
  } catch (error) {
    fail("异常", String((error as Error)?.message ?? error).split("\n")[0]?.slice(0, 200) ?? "未知异常");
  } finally {
    clearTimeout(watchdogTimer);
    if (watchdog.signal.aborted) {
      fail("看门狗", `这一条超过 ${CASE_WATCHDOG_MS / 1000} 秒没收场 —— 已中止（不然整批会被它拖死，也看不出是哪一条）`);
    }
    try {
      close?.();
    } catch {
      /* 收尾失败不影响判定 */
    }
    if (provider) await provider.close();
    if (prevBase === undefined) delete process.env.STRATA_BASE_URL;
    else process.env.STRATA_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.STRATA_API_KEY;
    else process.env.STRATA_API_KEY = prevKey;
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const eventTypes = events.map((e) => e.type);
  const errors = [...new Set(events.filter((e) => e.type === "error").map((e) => String((e as { message?: string }).message ?? "")))]
    .filter(Boolean)
    .slice(0, 3)
    .map((m) => m.split("\n")[0]!.slice(0, 200));
  const usage = events.reduce(
    (acc, e) => {
      if (e.type !== "done" || !e.usage) return acc;
      acc.input += e.usage.inputTokens ?? 0;
      acc.output += e.usage.outputTokens ?? 0;
      return acc;
    },
    { input: 0, output: 0 },
  );
  return {
    id: c.id,
    category: c.category,
    title: c.title,
    ok: failures.length === 0,
    failures,
    eventTypes,
    steps: eventTypes.filter((t) => t === "step-finish").length,
    ms: Date.now() - started,
    usage,
    ...(errors.length ? { errors } : {}),
    ...(rawErrors.length ? { rawErrors: [...new Set(rawErrors)].slice(0, 3).map((m) => m.split("\n")[0]!.slice(0, 300)) } : {}),
  };
}

/** 一批用例的总账（`ding eval` 与基线都吃这个形状）。 */
export type EvalReport = {
  total: number;
  passed: number;
  failed: number;
  /**
   * 装置不可达（不是产品失败）的条数 —— 见 `EvalCaseResult.environment`。
   *
   * `passed + failed + environment === total`。它只管"这条不该赖产品"，
   * **不代表这一批是健康的**：通过率照旧按全批算（16/63 就是 16/63），
   * 门禁 `eval.test.ts` ③ 还额外要求这个数**必须是 0**。
   */
  environment: number;
  /** 通过率（0–100，保留一位小数）。 */
  rate: number;
  byCategory: Record<string, { total: number; passed: number }>;
  results: EvalCaseResult[];
  /**
   * 这一批的用量数字**是什么口径**（审计 P165）。
   *
   * ⚠️ 假 provider 报的 usage 是按请求体估算出来的 —— 它**不是账单**。
   * 原来 `ding eval --json` 把 `usage` 原样吐出去、没有任何标注，
   * 离得远的人会把"55952 tokens"当成真实消耗。
   */
  usageNote: string;
};

/**
 * 跑一批用例。
 *
 * @param cases 用例
 * @param deps 装配
 * @param onProgress 每条跑完回调一次（命令行里打进度）
 * @returns 总账
 */
/**
 * 这条失败是不是**装置**造成的（而不是产品）。
 *
 * 判据刻意收得很窄，而且**看的是上游原文**（`rawErrors`，不是给人看的那句人话）：同时出现
 * ① 一个**回环地址**（`127.0.0.1:<port>`）② TCP 层的连不上（ETIMEDOUT / ECONNREFUSED）。
 *
 * ⚠️ 为什么必须看原文：给用户看的那句被 `humanError` 统一翻成了
 * 「连不上 provider（检查网络，或本地服务是否已启动）」—— 它把
 * "本机回环不通"与"密钥错/域名解析不了/上游 5xx"抹成同一句，
 * 拿它做判据会把真失败也放行（本仓最恨的那种"假放行"）。
 *
 * 为什么这个组合**只可能**是装置：这套评测里所有回环连接都是指向**本进程里现起的假 provider**
 * （`deps.fakeProvider !== false` 时由 `runCase` 起、`startFakeProvider` 在 listen 之后
 * 还做过一次 HTTP 自检）。产品代码在这条路上做的事就是"按宿主给的 baseURL 发一个 HTTP 请求" ——
 * 它连不上只有一个来源：**这台机器那一会儿的回环不通**（实测现场：
 * 连续几个端口都黑洞、几百毫秒后自己恢复；本地 10 轮里中 1–2 轮）。
 *
 * 反过来说：真出网（`deps.fakeProvider === false`）时**绝不套用**这条 —— 那可能是真的网络问题，
 * 得让人看见。
 */
function environmentFailure(r: EvalCaseResult): string | null {
  const text = [...(r.rawErrors ?? []), ...(r.errors ?? [])].join("\n");
  if (!/127\.0\.0\.1:\d+/.test(text)) return null;
  if (!/(ETIMEDOUT|ECONNREFUSED)/.test(text)) return null;
  return (r.rawErrors ?? r.errors ?? [])[0] ?? "本机回环连不上（假 provider 不可达）";
}

/**
 * 跑一批用例。
 *
 * ⚠️ **装置不可达时重跑一次**（2026-10-16）：本机实测有"随机某几条用例红"的假红
 * （根因与现场见 `fakeProvider.ts` 的 `listenReachablePort`）。这里的分寸：
 *  · 只对**上面那条窄判据**重跑，且眼里只有"产品失败"的用例（`ok:false`）；
 *  · 重跑（拿到新 provider、新端口）**只做一次** —— 不是"重试即算通过"那种刷绿：
 *    重跑的结果就是最终结果；
 *  · 重跑仍红且仍是装置签名 → 标成 `environment`，**不计进 `failed`**，单独计数（`EvalReport.environment`），
 *    报告里点名。门禁（`eval.test.ts`）要求这个数**必须是 0** —— 所以它既不会吞掉产品失败，
 *    也不会让"机器抽风"伪装成产品红。
 */
export async function runSuite(
  cases: readonly EvalCase[],
  deps: EvalDeps,
  onProgress?: (r: EvalCaseResult, index: number, total: number) => void,
): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    let r = await runCase(cases[i]!, deps);
    if (!r.ok && deps.fakeProvider !== false) {
      const why = environmentFailure(r);
      if (why) {
        const again = await runCase(cases[i]!, deps);
        /*
         * `retried` 与 `environment` 各管一件事，别混：
         *  · `retried` = 这一条被重跑过（重跑后通过也算通过，但痕迹留着，报告里看得见）；
         *  · `environment` = **最终判定是"装置不可达"**（只有重跑后仍不可达才写它）。
         * 于是"重跑把它救回来了"与"这台机器不行"在报告里长得不一样。
         */
        r = { ...again, retried: (r.retried ?? 0) + 1 };
        if (!r.ok) {
          const stillEnv = environmentFailure(r);
          if (stillEnv) r = { ...r, environment: `装置不可达（重跑后仍不可达；本机回环问题，不是产品失败）：${stillEnv}` };
        }
      }
    }
    results.push(r);
    onProgress?.(r, i + 1, cases.length);
  }

  const byCategory: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    const slot = (byCategory[r.category] ??= { total: 0, passed: 0 });
    slot.total += 1;
    /*
     * 装置不可达的**不计进** byCategory.passed —— 它不是"产品通过了"。
     * （它只以 `environment` 计数出现在总账里，所以不会把哪一类悄悄刷高。）
     */
    if (r.ok && !r.environment) slot.passed += 1;
  }
  const envCount = results.filter((r) => r.environment && !r.ok).length;
  const passed = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    passed,
    failed: results.filter((r) => !r.ok && !r.environment).length,
    environment: envCount,
    /*
     * 通过率按**全批**算（不把 environment 从分母里摘出去）。
     *
     * ⚠️ 一开始我把它摘出去了（`passed / (total - environment)`），代价实测到了：
     * 47 条装置不可达的那一跑，报告头一行写"通过率 100%" —— 而那一批只有 16 条真的跑通。
     * 「装置不可达不算产品失败」是**判定口径**，不是"这一批很健康"的意思。
     * 数字要如实：分母就是全批，剩下的由 `environment` 计数解释。
     */
    rate: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0,
    byCategory,
    results,
    usageNote:
      deps.fakeProvider === false
        ? "用量来自真实 provider 的上报"
        : "用量来自**假 provider**（按请求体字节估算的合成数字），不是真实账单、不可用于成本核算", 
  };
}
