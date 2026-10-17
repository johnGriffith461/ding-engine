import { request } from "node:http";

import { flag, flagAll, type Parsed } from "./args";

/**
 * `ding connect <url> [任务]` —— **远端 agent 的客户端**（Phase 17 的另一半）。
 *
 * ## 为什么要有它
 *
 * `ding serve` 早就把 agent 挂到 HTTP 上了，但**客户端没做** —— 想用它只能 curl 或自己写脚本
 * （CHANGELOG 里如实记着这条缺口："服务端做了，客户端没做"）。这一条补上：
 * 把一台机器上的 agent 当成"远端的一双手"，本地这一侧只负责说任务、看进展。
 *
 * ## 协议（与服务端 `hosts/server/agentServer.ts` 一一对应）
 *
 * ```
 * GET  /v1/info            → 那台机器是谁、什么档位、工作目录在哪
 * GET  /v1/sessions        → 那边的会话列表
 * POST /v1/run             → 跑一轮；**SSE 流式**回事件，最后一帧是 done
 * ```
 *
 * 带 token 时统一走 `Authorization: Bearer`（**只走这个头**：放 URL 里会被日志与历史记住）。
 *
 * ## 这一层刻意做的事
 *
 * · **流式吐字**：SSE 收到一帧就打印一帧（不等整轮跑完）——远端跑长任务时这是唯一能看的东西；
 * · **工具调用如实显示**：远端跑的是**它的**命令与文件，本地不假装知道细节，只说"调了什么"；
 * · 退出码跟着远端结果走（成功 0 / 失败 1），这样它能在脚本里用。
 */

/** `ding connect` 的参数。 */
export type ConnectOptions = {
  url: string;
  /** 要跑的活；没有就只打印信息 / 会话列表。 */
  message?: string;
  token?: string;
  cwd?: string;
  /** 只看那边的会话列表，不跑活。 */
  listSessions?: boolean;
  /** `--json`：把事件原样吐成 JSON 行（给脚本用）。 */
  json: boolean;
};

/**
 * 从命令行参数里读 `connect` 的选项。
 *
 * @param parsed 已解析的参数
 * @returns 选项；`url` 为空表示用法不对
 */
export function connectOptions(parsed: Parsed): ConnectOptions {
  const url = (parsed.args[0] ?? "").trim();
  const message = parsed.args.slice(1).join(" ").trim();
  return {
    url,
    ...(message ? { message } : {}),
    ...(flag(parsed, "token") ? { token: flag(parsed, "token")! } : {}),
    ...(flag(parsed, "cwd") ? { cwd: flag(parsed, "cwd")! } : {}),
    ...(flagAll(parsed, "sessions").length || parsed.flags.has("sessions") ? { listSessions: true } : {}),
    json: Boolean(flag(parsed, "json")),
  };
}

/** 规范化服务端地址：补上 `http://`、去掉末尾斜杠。 */
export function normalizeBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** 拼一个 API 地址（`/v1/...`）。 */
export function apiUrl(base: string, path: string): string {
  return `${normalizeBaseUrl(base)}${path}`;
}

/**
 * 解析一条 SSE 事件（服务端写的是 `event: <名>\ndata: <JSON>\n\n`）。
 *
 * ⚠️ **一次 TCP 分段里可能有多帧、也可能只有半帧** —— 所以这里只解析"完整的那几条"，
 * 半条退回给调用方继续攒（`rest`）。自己按行 split 而不攒缓冲的写法在真网络上必现 bug。
 *
 * @param buffer 到目前为止收到的文本
 * @returns 解出来的事件与剩下的半截
 */
export function parseSse(buffer: string): { events: Array<{ event: string; data: unknown }>; rest: string } {
  const events: Array<{ event: string; data: unknown }> = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut < 0) break;
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    let name = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    try {
      events.push({ event: name, data: JSON.parse(dataLines.join("\n")) as unknown });
    } catch {
      /* 半截 JSON / 坏帧：丢掉比崩掉强 —— 下面还有帧要处理 */
      events.push({ event: name, data: { raw: dataLines.join("\n") } });
    }
  }
  return { events, rest };
}

/** headless 抓取用的一组头（含 token）。 */
function headers(opts: ConnectOptions): Record<string, string> {
  /*
   * ⚠️ `connection: close` 对所有请求都加：这条命令跑完就退出进程，
   * 而 undici 会把 keep-alive 连接留在池子里 —— 收尾时撞上 libuv 的
   * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（实测退出码 127 / 0xC0000409）。
   * 之前的写法只在 /v1/run 上加，第一条 /v1/info 的连接照样留在池里，照样崩。
   */
  const h: Record<string, string> = { "content-type": "application/json", connection: "close" };
  if (opts.token) h.authorization = `Bearer ${opts.token}`;
  return h;
}

/** 两种失败分开说：**连不上**与**被拒**（401）是两件事，给下一步也不一样。 */
function explain(status: number, body: string, url: string): string {
  if (status === 401) {
    return `${url} 拒绝了这次请求（401）：远端要 token —— 用 --token <那台机器起的 token> 再来一次`;
  }
  if (status === 0) return `连不上 ${url}：确认那台机器在跑 \`ding serve\`，地址与端口对不对`;
  return `${url} 回了 ${status}：${body.slice(0, 200) || "（没有说明）"}`;
}

/**
 * 跑一条 `ding connect`。
 *
 * @param parsed 已解析的参数
 * @returns 进程退出码（远端那轮失败就是 1 —— 这样它能直接写进脚本）
 */
export async function cmdConnect(parsed: Parsed): Promise<number> {
  const opts = connectOptions(parsed);
  if (!opts.url) {
    console.error("用法：ding connect <url> [任务] [--token <t>] [--cwd <目录>] [--sessions] [--json]");
    return 2;
  }
  const base = normalizeBaseUrl(opts.url);

  /* ① 先说清"对面是谁"：远端 agent 的档位与工作目录是用户该先看见的东西 */
  try {
    const infoRes = await fetch(apiUrl(base, "/v1/info"), { headers: headers(opts) });
    const text = await infoRes.text();
    if (!infoRes.ok) {
      console.error(`✗ ${explain(infoRes.status, text, base)}`);
      return 1;
    }
    const info = JSON.parse(text) as {
      provider?: string;
      model?: string;
      mode?: string;
      cwd?: string;
      hooks?: string[];
    };
    if (!opts.json) {
      console.log(`远端：${base}`);
      console.log(`  通道：${info.provider ?? "?"}${info.model ? ` / ${info.model}` : ""}（档位：${info.mode ?? "?"}）`);
      console.log(`  工作目录：${info.cwd ?? "?"}`);
      if (info.hooks?.length) console.log(`  webhook：${info.hooks.join(" / ")}`);
    }
  } catch (e) {
    console.error(`✗ ${explain(0, String((e as Error)?.message ?? e), base)}`);
    return 1;
  }

  /* ② 只看会话列表 */
  if (opts.listSessions) {
    const res = await fetch(apiUrl(base, "/v1/sessions"), { headers: headers(opts) });
    const text = await res.text();
    if (!res.ok) {
      console.error(`✗ ${explain(res.status, text, base)}`);
      return 1;
    }
    const got = JSON.parse(text) as { sessions?: Array<{ id: string; updatedAt?: number; turns?: number }> };
    const list = got.sessions ?? [];
    if (opts.json) {
      console.log(JSON.stringify(got));
      return 0;
    }
    if (!list.length) {
      console.log("那边还没有会话。");
      return 0;
    }
    console.log(`会话（${list.length}）：`);
    for (const s of list.slice(0, 20)) {
      const when = s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "";
      console.log(`  ${s.id}  ${when}${typeof s.turns === "number" ? `  ${s.turns} 轮` : ""}`);
    }
    return 0;
  }

  /* ③ 没给任务就只到这儿（"连一下看看对面是谁"也是有用的用法） */
  if (!opts.message) return 0;

  /* ④ 真跑一轮：SSE 边收边打 */
  /*
   * ⚠️ 这一条**不走 fetch 的响应体**（2026-10-16 实测后改的）：undici 的连接池会在进程收尾时
   * 撞上 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
   * （退出码 0xC0000409 / 127；失败路径不崩、成功路径崩，加 `connection: close` 也压不住 ——
   * 取决于收尾时序）。改用 `http.request`：连接是我们自己拿着的，读完显式 `destroy()`，
   * 没有池、没有后台句柄。命令的输出与退出码**与之前一字不差**（外面看不出来）。
   */
  const body = JSON.stringify({ message: opts.message, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  /** 远端那轮的结局（`done` 帧给）。默认失败 —— 连不上就没跑成。 */
  let ok = false;
  let failure = "";
  let buffer = "";

  /** 收一段 SSE 文本，按帧处理（与 fetch 那版共用同一套 `parseSse`）。 */
  const handleChunk = (text: string): void => {
    const { events, rest } = parseSse(buffer + text);
    buffer = rest;
    for (const ev of events) {
      const data = ev.data as Record<string, unknown>;
      /*
       * ⚠️ **先解析结局，再决定怎么打印**（2026-10-16 真跑时逮到的）：
       * 原来 `--json` 那条分支写在最前面并 `continue`，于是它一进去就跳过了 `done` 的解析 ——
       * 远端明明 ok=true，`--json` 用法的退出码却是 1（两条路各走各的，早晚漂移）。
       */
      if (ev.event === "done") {
        ok = data.ok === true;
        if (typeof data.error === "string") failure = data.error;
      }
      if (opts.json) {
        console.log(JSON.stringify({ event: ev.event, ...data }));
        continue;
      }
      /*
       * V5-2 2.3：`started` 帧带"这一轮谁发起的"（成员身份，2.2 认出来的）。
       * ⚠️ **本机主人（id=local）不啰嗦** —— 单机单人用的输出与从前逐字相同；
       * 只有别人（成员）发起时才多这一行，那正是协作场景里需要看见的。
       */
      if (ev.event === "started") {
        const who = (data.actor as { id?: unknown } | undefined)?.id;
        if (typeof who === "string" && who && who !== "local") console.log(`  ▸ 这一轮由 ${who} 发起`);
        continue;
      }
      if (ev.event === "done") continue;
      /* 事件形状与内核一致（`TurnEvent`）：只显示"用户看得见的那些" */
      const type = typeof data.type === "string" ? data.type : "";
      if (type === "text" && typeof data.text === "string") process.stdout.write(data.text);
      else if (type === "tool-call") console.log(`\n  ▸ 远端在跑工具：${String(data.toolName ?? "?")}`);
      else if (type === "tool-result" && data.error) console.log(`  ▸ 工具失败：${String(data.error).slice(0, 120)}`);
      else if (type === "delegation") console.log(`  ▸ 委派：${String(data.agent ?? "?")}（${String(data.status ?? "")}）`);
      else if (type === "error") console.log(`\n  ✗ 远端报错：${String(data.message ?? "").slice(0, 200)}`);
      else if (type === "done" || type === "step-finish") {
        /* 用量在这两种事件里；CLI 那一栏由 --json 的人去读，这里不啰嗦 */
      }
    }
  };

  /* 真发出去：读完显式 destroy（见上面那段说明） */
  try {
    const url = new URL(apiUrl(base, "/v1/run"));
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: url.hostname,
          port: url.port || "80",
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: { ...headers(opts), "content-length": String(Buffer.byteLength(body)) },
        },
        (incoming) => {
          const code = incoming.statusCode ?? 0;
          if (code !== 200) {
            let detail = "";
            incoming.on("data", (d: Buffer) => (detail += d.toString("utf8")));
            incoming.on("end", () => {
              console.error(`✗ ${explain(code, detail, base)}`);
              req.destroy();
              resolve(code);
            });
            return;
          }
          incoming.on("data", (chunk: Buffer) => handleChunk(chunk.toString("utf8")));
          incoming.on("end", () => {
            /* ⚠️ 读完了要**显式收掉这条连接**：留着它就又会回到上面那个收尾断言上 */
            req.destroy();
            resolve(code);
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    if (status !== 200) return 1;
  } catch (e) {
    console.error(`✗ ${explain(0, String((e as Error)?.message ?? e), base)}`);
    return 1;
  }

  if (!opts.json) process.stdout.write("\n");
  if (!ok) {
    console.error(`✗ 远端这一轮没成功${failure ? `：${failure}` : ""}`);
    return 1;
  }
  if (!opts.json) console.log("✓ 远端跑完了");
  return 0;
}
