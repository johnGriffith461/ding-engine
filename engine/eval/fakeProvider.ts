import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 评测用的**假 provider**（Phase 10.2 的"离线模式"）。
 *
 * ## 为什么是"回放"而不是"打真端点"
 *
 * 方案 10.2 要求评测**不烧 token、可进 CI**。做法与 `engine/runtime/loop.test.ts` 同一招：
 * 在回环上起一个 OpenAI 兼容的 SSE 服务，按用例脚本吐帧 —— 于是被测的仍是**真代码路径**
 * （真 SDK、真流解析、真工具往返、真闸门），只是模型那一段被换成了确定性的脚本。
 *
 * ## 用例作者写的是"回什么"，不是"吐哪几帧"
 *
 * 帧形状（`chat.completion.chunk`）是实现细节；用例里写的是**语义**：
 * 「回一句文本」或「调一个工具」。这样换 SDK 的时候用例不用重写。
 *
 * ## ⚠️ 必须无状态
 *
 * 这条是 `loop.test.ts` 用两次红换来的：用共享计数器选分支时，**跨用例会串**
 * （上一轮在步数上限处停下时，最后一次请求还在飞，会涨到下一个用例的计数器上）。
 * 所以这里的脚本**只看请求体自己**：
 *
 *   · 请求体里**没有**工具结果 → 这是这一轮的第一步 → 取 `reply[0]`
 *   · 有工具结果（`"role":"tool"`）→ 取下一个还没用过的 reply
 *
 * ## ⚠️ 子智能体的请求也在同一条服务上
 *
 * 团队 / 子智能体那几条用例里，**子智能体自己也会打这个假 provider**（它是一轮真的 agent 回合）。
 * 所以"第几个请求"不能直接拿来选脚本 —— 子级的请求会把计数带偏
 * （实测：`team-then-single` 因此少走一步）。
 *
 * 判据是**父级的请求里带着这条用例的用户原话**（子级只带它自己的任务说明，两者不同）：
 * 于是"这是父级的第几个请求"可以精确数出来，子级一律回一句收尾话。
 *
 * ## ⚠️ 而且要容忍"迟到请求"
 *
 * 一轮结束后可能还有在途请求。为了不把迟到请求的响应算进下一个用例，
 * 每个用例用**自己的服务实例**（`startFakeProvider` 每次新建），并在用例结束时关掉。
 * 关掉之后迟到的连接会失败，但那时这一轮已经结束了。
 */

/** 用例脚本里的一次"模型回复"。 */
export type EvalReply =
  /**
   * 只说一句话（收尾 = `stop`）。
   *
   * `chunks` 给"分多帧吐"的用例：真实模型是一个词一个词流出来的，
   * 而**一帧吐完**与**分十帧吐完**在客户端是两条不同的路径
   * （前者测不到增量归并）。不传 `chunks` 就是一帧。
   */
  | { say: string; chunks?: string[] }
  /** 调一个或多个工具（收尾 = `tool_calls`）。`say` 可选：先吐一句再调（也可分帧）。 */
  | { say?: string; chunks?: string[]; call: { name: string; args: Record<string, unknown> }[] }
  /**
   * **中途断开**（崩溃注入，Phase 10.6）：不回任何帧，直接把连接掐掉。
   * 用它验的是"上游半路没了"时这一轮**怎么收场** —— 该报错收尾，不该挂在那里等。
   */
  | { crash: true };

/** 一帧 chunk 的公共字段（与真 provider 同形）。 */
const CHUNK = { id: "eval-1", object: "chat.completion.chunk", created: 0, model: "eval-model" };

const textFrame = (t: string) => ({ ...CHUNK, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
const finishFrame = (reason: string) => ({ ...CHUNK, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageFrame = (p: number, c: number) => ({
  ...CHUNK,
  choices: [],
  usage: { prompt_tokens: p, completion_tokens: c, total_tokens: p + c },
});
/** 工具调用帧：第一帧带 id/name，后续只带 arguments 片段（与真 provider 同形）。 */
const toolFrame = (id: string | null, name: string | null, args: string) => ({
  ...CHUNK,
  choices: [
    {
      index: 0,
      delta: { tool_calls: [{ index: 0, ...(id ? { id, type: "function" } : {}), function: { ...(name ? { name } : {}), arguments: args } }] },
      finish_reason: null,
    },
  ],
});

/** 把一次语义回复翻成一串帧。 */
function framesOf(reply: EvalReply, index: number, requestNo: number, bodyBytes: number): object[] {
  const out: object[] = [];
  const saidChars = "say" in reply && reply.say ? reply.say.length : 0;
  if ("crash" in reply) return out;
  if ("say" in reply && reply.say) {
    // `chunks` 给了就按它分帧（否则整段一帧）—— 分帧要拼起来仍等于 `say`
    const pieces = reply.chunks?.length ? reply.chunks : [reply.say];
    for (const piece of pieces) out.push(textFrame(piece));
  }
  if ("call" in reply && reply.call?.length) {
    reply.call.forEach((c, i) => {
      /*
       * ⚠️ id 里带上**第几个请求**（`requestNo`）：脚本用完会重复最后一条，
       * 同一段脚本可能在后面的步里再来一次 —— 只用 `index_i` 会撞 id
       * （审计 P159：两个调用共用同一个 toolCallId，投影按 id 配对就会错）。
       */
      const id = `call_r${requestNo}_${index}_${i}`;
      out.push(toolFrame(id, c.name, JSON.stringify(c.args)));
    });
    out.push(finishFrame("tool_calls"));
  } else {
    out.push(finishFrame("stop"));
  }
  /*
   * 用量放在收尾之后（真 provider 也是单独一帧，choices 为空）。
   *
   * ⚠️ 2026-10-16（审计 G82）：原来是 `100 + index*10` 这套**与请求体无关**的常数 ——
   * 于是"每轮重发全部历史"这类成本问题**结构上量不出来**（假 provider 永远说
   * "这一轮输入 110 token"，无论历史有多长）。现在按请求体大小折：输入 ≈ body 字节 / 4、
   * 输出 ≈ 回复字数 / 4 —— 仍然是**估算**（所以只在"相对趋势"的意义上可信），
   * 但它让"重发全部历史 → 输入 token 涨"变成**可测的**。
   */
  out.push(usageFrame(Math.max(1, Math.round(bodyBytes / 4)), Math.max(1, Math.round(saidChars / 4))));
  return out;
}

export type FakeProvider = {
  /** 指到它用：`STRATA_BASE_URL = provider.url`。 */
  url: string;
  /** 收到过的请求体（按到达顺序）—— 断言"下发了哪些工具"用它。 */
  bodies: unknown[];
  /** 停掉（每用例一个实例，用完就关）。 */
  close: () => Promise<void>;
};

/**
 * 绑一个**真的连得上**的回环端口，返回端口号。
 *
 * ⚠️ 为什么不能只 `listen(0)`（2026-10-16 实测，审计那条"评测偶发红"的根因）：
 * 本机上短时间内反复 bind/close 回环端口时，会出现一段**"这批端口连不上"的窗口** ——
 * 端口绑得上、但从**同一个进程**里连它也一直不返回（是黑洞，不是拒绝）。
 * `DSH_EVAL_TRACE=1` 打出来的现场（跑那 63 条时）：
 *
 * ```
 * 绑上 58833，探针 不通（301ms）
 * 绑上 58851，探针 不通（301ms）
 * 绑上 58853，探针 不通（301ms）
 * 绑上 58855，探针 通（1ms）        ← 就算这样，这一条用例仍然以 error 收场：
 *                                     Cannot connect to API: connect ETIMEDOUT 127.0.0.1:58855
 * ```
 *
 * 表现是"随机某几条用例红"（`chat-single` / `tool-edit-file` / `sub-delegation-window` …，
 * 每轮换），10 轮里中 1–2 轮 —— 与产品、与用例都没关系。
 *
 * 判据因此从"**绑**得上"改成"**连**得上"，而且探针**真发一个 HTTP 请求**（与 SDK 同一条路）：
 * 只探 TCP 不够 —— 现场抓到过"TCP 握手完成了、请求却没到达处理函数"的窗口，
 * 那种情况下裸 `net.connect` 探针是**假绿**（探针绿了，SDK 照样一次都没连通）。
 */
/*
 * ⚠️ 同一个知识的**第二份**在 `engine/testing/localServer.ts`（`listenReachable`）——
 * 那一份是给"自己绑服务器的测试"用的（modelGate / team 那些）。
 * 两份都留着是刻意的：这一份在**随 CLI 发布的 engine/eval 里**（`ding eval` 要用），
 * 让发布路径去 import 一个 testing 目录不值得。谁改了判据（比如自检路径、重试次数），
 * **两边一起改** —— 这一条就是为什么两处的注释都写明了另一处在哪。
 */
async function listenReachablePort(server: Server): Promise<number> {
  /*
   * 探针用 `node:http` + `agent: false`：**一次性连接**，探完即断，不碰全局 undici 池。
   *
   * 为什么不图省事写 `fetch(...)`：`fetch`（undici）会把连接**留在 keep-alive 池里**，
   * 而引擎随后请求的是同一个 origin（`127.0.0.1:<同一个端口>`）—— 它一定会复用那条连接。
   * 于是这条"自检"就不再是旁观者，而是**被测对象的一部分**：探针改了连接复用的形状，
   * 真请求的表现也跟着改。自检工具不许改变被测对象，所以这里用一次性连接。
   */
  const probe = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/__probe", method: "GET", agent: false, timeout: 600 },
        (res) => {
          res.resume(); // 把响应读干净，连接才好断
          res.on("end", () => resolve((res.statusCode ?? 0) === 200));
          res.on("error", () => resolve(false));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    // 回环上的连接要么立刻成、要么一直不回 —— 600ms 足够区分这两种
    if (await probe(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(
    "连着试了 8 个回环端口都连不上 —— 这台机器的回环当时有一段是不通的（不是产品问题，重跑通常就好）",
  );
}

/**
 * 起一个假 provider。
 *
 * @param replies 这一轮的脚本：第一步取 `replies[0]`，之后按"已用次数"递进。
 *   用完就**重复最后一条**（而不是报错）—— 否则用例跑到步数上限时，
 *   假 provider 会先炸，把"产品行为"掩盖成"测试装置行为"。
 * @returns 见 `FakeProvider`
 */
export async function startFakeProvider(
  replies: readonly EvalReply[],
  parentTurns: readonly string[] = [],
  opts: {
    /**
     * **父级请求的标记**（推荐）：宿主在 `system` 里塞一句独一无二的话，
     * 假 provider 按它认"这是父级那一轮"。比"按用户原话认"可靠得多
     * —— 子智能体的请求里只有它自己的任务说明，不会带上这个标记。
     */
    parentMark?: string;
  } = {},
): Promise<FakeProvider> {
  const bodies: unknown[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    /*
     * 自检路由（`listenReachablePort` 打的就是它）：回一个最小的 200。
     * 不走 SSE、不记进 `bodies` —— 它不是"模型调用"，别污染用例的证据。
     */
    if (req.url === "/__probe") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let raw = "";
    req.on("data", (d: Buffer | string) => {
      raw += String(d);
    });
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 请求体不合法也照吐，这一层测的不是它 */
      }
      bodies.push(parsed);

      /*
       * 选哪一条脚本。
       *
       * ⚠️ 第一版按"有几次工具结果"算，于是**多轮用例全乱**：没有工具的两轮对话里
       * 那个计数恒为 0，第二轮拿到的是第一轮那一条（`chat-two-turns` 因此红）。
       * 第二版按"本实例第几个请求"算，又**被子智能体带偏**：子级也打这个服务
       * （`team-then-single` 因此少走一步）。
       * 第三版按"带着用户原话"认 —— 但**空串会让它恒真**（审计 P158）：
       * `turns: [""]` 的用例里，连子智能体的请求都被算成父级，
       * 文件头那条"子级一律回一句收尾话"的规矩被整条绕开。
       *
       * 现在：优先用**宿主给的标记**（`opts.parentMark`）认父级 —— 那是独一无二的；
       * 没给标记时退回"按用户原话认"，但**空串不参与**（它正是恒真的来源）。
       * 两条路都认不出来时（例如用例的用户话就是空串）当作"无法区分"：
       * 一律按父级处理，并把这条边界如实留在这里。
       */
      const usableTurns = parentTurns.filter((t) => t.trim().length > 0);
      const isParentBody = (body: unknown): boolean => {
        if (opts.parentMark) return JSON.stringify(body ?? "").includes(opts.parentMark);
        if (!usableTurns.length) return true;
        return usableTurns.some((t) => JSON.stringify(body ?? "").includes(t));
      };
      const isParent = isParentBody(parsed);
      const parentSoFar = bodies.filter((b) => isParentBody(b)).length;
      const index = Math.max(0, Math.min(parentSoFar - 1, replies.length - 1));
      const reply = isParent ? (replies[index] ?? { say: "" }) : { say: "（子智能体收尾）" };

      if ("crash" in reply && reply.crash) {
        // 崩溃注入（Phase 10.6）：连响应头都不回，直接把连接掐掉
        // —— 模拟上游进程被杀 / 网络断在半路。验的是"这一轮怎么收场"，不是"会不会崩"。
        req.socket.destroy();
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const frame of framesOf(reply, index, bodies.length, Buffer.byteLength(raw, "utf8"))) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  const port = await listenReachablePort(server);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
