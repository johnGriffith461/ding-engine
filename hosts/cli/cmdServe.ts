import { createApprovalsIndex } from "../../engine/adapters/sqliteApprovals";
import path from "node:path";
import { createInterface } from "node:readline";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { firstAvailableProvider } from "../../engine/runtime/providers";
import { AcpAgent } from "../acp/agent";
import { authorizeCwd, CwdNotAllowedError } from "../cwd";
import { startAgentServer } from "../server/agentServer";
import { createSyncRelay } from "../../engine/sync/relay";
import { createSpaceStore } from "../../engine/adapters/spaceStore";
import { listRecipes } from "./cmdRecipe";
import { normalizeConfirmMode, type ConfirmMode } from "../../shared/ipc";
import { flag, flagAll, parseIntFlagValue, type Parsed } from "./args";
import { buildEngine } from "./assembly";
import { effectiveConfig } from "./config";

/**
 * `ding serve` / `ding acp` —— 随处可用（Phase 17）。
 *
 * ## 两条口径都写在命令自己身上（而不是藏在文档里）
 *
 * · `serve`：**默认只绑回环，且一律需要口令**。口令来源优先级：
 *   `--token` > `DH_SERVE_TOKEN` > **现场随机生成**（启动时打印出来）。
 *   要对外的绑定还要求**显式**给口令（`.env` 里那种不算）—— 起服务之前硬拒。
 * · `acp`：走标准输入输出，**agent 作为外部客户端的子进程**。
 *   于是**日志绝不能写 stdout** —— 那是协议通道（写进去会污染 JSON-RPC 流）。
 *
 * ## 2026-10-16（审计第 1 单）改了什么
 *
 * · 工作目录授权从"未规范化的字符串前缀"换成 `authorizeCwd`（`..` 逃不出去、
 *   兄弟前缀目录不再被误认成已授权），**被拒绝的 cwd 明确报错**而不是静默落回默认目录；
 * · `--mode` 原来因为传了个空 `Parsed` 被结构性忽略，现在真的生效；
 * · `--port` 传坏值不再变成 `NaN` 喂给服务（NaN 会让 `listen` 抛一个看不懂的错）；
 * · 会话库打开时带**保护线**（服务期间新建的会话之外，用户历史一条不动）；
 * · 关闭路径：中止在跑回合、销毁在途连接，第二次 Ctrl+C 立即退出。
 */

/** `--port` 的取值判定（审计 P111 的同形入口：坏值不许静默变 NaN）。 */
export type PortDecision = { ok: true; port: number } | { ok: false; message: string };

export function resolveServePort(raw: string | undefined): PortDecision {
  const got = parseIntFlagValue(raw, "port", { min: 0, max: 65535, fallback: 8787 });
  return got.ok ? { ok: true, port: got.value } : { ok: false, message: got.message };
}

/**
 * 服务态用哪一家 provider（审计 P208 / NEW-N7-14）。
 *
 * **与 `ding run` / REPL / `resume` / `recipe` 同一口径**：命令行显式 > config.json >
 * `firstAvailableProvider()`（第一个有密钥的）。原来这里是 `config.provider ?? ""`，
 * 于是同一台机器上（只有环境变量 key、config.json 没写 provider —— doctor 与向导
 * 都允许这种状态）`ding run` 能跑，而 `ding serve` / `ding acp` 直接"先配一个 provider"
 * 退出 3。同一件事在四个入口给出三种结果，是宿主一致性最容易被漏的一类。
 *
 * @param configProvider config.json 里的 provider（没配就是 `undefined`）
 * @returns provider id；一家都不可用时是空串（调用方据此报错退出）
 */
export function serveProvider(configProvider: string | undefined): string {
  return configProvider ?? firstAvailableProvider()?.id ?? "";
}

/** 这一段宿主侧共用的装配（两个命令一样）。 */
function hostDeps(dataDir: string, p: Parsed, protectBefore: number) {
  const { config } = effectiveConfig(dataDir);
  const dirFlags = flagAll(p, "dir");
  const dirs = (dirFlags.length ? dirFlags : (config.dirs ?? [process.cwd()])).map((d) => path.resolve(d));
  return {
    provider: serveProvider(config.provider),
    ...(config.model ? { model: config.model } : {}),
    /* ⚠️ `flag(p, …)`：这里原来传的是 `new Map()` 拼的空 Parsed → `--mode` 恒 undefined（审计 P209） */
    mode: normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认") as ConfirmMode,
    dirs,
    makeEngine: async (cwd: string) => {
      /*
       * 工作目录用**客户端给的那个**，但它必须先过授权（`authorizeCwd`）——
       * 外部宿主不该因为能连上就获得新的可写范围。
       * ⚠️ 不通过就**抛**（由服务层翻成 400 / ACP 翻成参数错）：
       * 静默落回默认目录会让调用方以为自己指定的目录生效了（审计 P181）。
       */
      const decision = authorizeCwd(cwd, dirs);
      if (!decision.ok) throw new CwdNotAllowedError(decision.reason);
      return buildEngine([decision.cwd], dataDir, { protectBefore });
    },
  };
}

/** `ding serve [--port 8787] [--bind 0.0.0.0 --token xxx] [--hook name=prompt --hook-secret s]`。 */
export async function cmdServe(p: Parsed, dataDir: string): Promise<number> {
  /* 服务启动时刻：会话库的收口保护线（这一刻之前的会话都是"用户自己的"） */
  const startedAt = Date.now();
  const deps = hostDeps(dataDir, p, startedAt);

  const portDecision = resolveServePort(flag(p, "port"));
  if (!portDecision.ok) {
    process.stderr.write(`${portDecision.message}\n`);
    return 2;
  }
  const bind = flag(p, "bind");
  if (bind === "true") {
    process.stderr.write("--bind 要一个地址（例如 127.0.0.1 / 0.0.0.0）\n");
    return 2;
  }
  const token = flag(p, "token") ?? process.env.DH_SERVE_TOKEN?.trim();
  if (token === "true") {
    process.stderr.write("--token 要一个口令值（或改用环境变量 DH_SERVE_TOKEN）\n");
    return 2;
  }
  const hookSecret = flag(p, "hook-secret") ?? process.env.DH_HOOK_SECRET?.trim();
  if (hookSecret === "true") {
    process.stderr.write("--hook-secret 要一个密钥值（或改用环境变量 DH_HOOK_SECRET）\n");
    return 2;
  }
  /*
   * 成员 token（V5-2 2.2）：`--member <id>:<口令>`，可重复。
   *
   * 口令里可以带冒号（切**第一个**冒号，剩下的都当口令）—— 生成的随机口令
   * 本来就可能含各种字符，用最后一个冒号切会把 id 吃掉。
   */
  const members: Array<{ id: string; token: string }> = [];
  for (const spec of flagAll(p, "member")) {
    const at = spec.indexOf(":");
    const id = at > 0 ? spec.slice(0, at).trim() : "";
    const memberToken = at > 0 ? spec.slice(at + 1) : "";
    if (!id || !memberToken.trim()) {
      process.stderr.write(`--member 要写成 <id>:<口令>（收到 ${JSON.stringify(spec)}）\n`);
      return 2;
    }
    members.push({ id, token: memberToken });
  }
  const hooks: Record<string, string> = {};
  for (const spec of flagAll(p, "hook")) {
    const at = spec.indexOf("=");
    if (at > 0) hooks[spec.slice(0, at).trim()] = spec.slice(at + 1).trim();
  }

  if (!deps.provider) {
    process.stderr.write("先配一个 provider：ding init（或 ding config set provider <id>）\n");
    return 3;
  }

  let started;
  /* 审批索引常开（每次请求都要查）；关服务时一并关掉 */
  const approvals = createApprovalsIndex(dataDir, "sessions.db");
  try {
    started = await startAgentServer({
      port: portDecision.port,
      ...(bind ? { bind } : {}),
      ...(token ? { token } : {}),
      makeEngine: deps.makeEngine,
      mode: deps.mode,
      provider: deps.provider,
      ...(deps.model ? { model: deps.model } : {}),
      cwd: deps.dirs[0] ?? process.cwd(),
      hooks,
      ...(hookSecret ? { hooksSecret: hookSecret } : {}),
      /* 成员 token（V5-2 2.2）：认证机制不变、身份细化 —— 每个成员一把口令 */
      ...(members.length ? { members } : {}),
      /* 会话列表：把真实会话库交给服务层（不给的话那个接口只能回 501） */
      listSessions: async () => {
        const store = createSqliteSessionStore(dataDir, "sessions.db", {}, { protectBefore: startedAt });
        try {
          return await store.list();
        } finally {
          store.close();
        }
      },
      /* 模板清单（V5-3 3.7 的模板共享要读本体 —— 与 `ding recipe list` 同一条数据路） */
      listRecipes: () => listRecipes(dataDir),
      /* 逐段读（审计 V5-3 3.3 用；与上面同一个库，但它要扫很多段，所以不建引擎） */
      loadSession: async (sessionId: string) => {
        const store = createSqliteSessionStore(dataDir, "sessions.db", {}, { protectBefore: startedAt });
        try {
          return await store.load(sessionId);
        } finally {
          store.close();
        }
      },
      /*
       * 同步中继（V5-2 2.1）：serve **hosts** 它（中继=事件总线+协调器，
       * 本地 SQLite 仍是数据权威 —— 见 `engine/sync/relay.ts` 的文件头）。
       * 一个进程一份，进程结束即消失：它搬的是"另一端此刻要拿到的事件"，
       * 不是数据本身（离线续传靠客户端持久化的 offset 游标，2.6）。
       */
      relay: createSyncRelay(),
      /*
       * 审批（C3 3.7b，V5 收尾）：索引**常开**（每次请求都要查），写入复用会话库
       * 那个端口（单一出口 —— 决策与事件流必须落在同一条编号序列上）。
       */
      approvals,
      appendRecord: async (sessionId: string, record: unknown) => {
        const store = createSqliteSessionStore(dataDir, "sessions.db", {}, { protectBefore: startedAt });
        try {
          /* ⚠️ **不传 owner**：这段会话已经存在，传一个不同的 owner 会被归属校验拒掉
             （C1 的"跨 owner 写入拒绝"）—— 老路径什么都不查，正是这里要的 */
          await store.append(sessionId, [record as never]);
        } finally {
          store.close();
        }
      },
      /*
       * 团队空间（V5-3 3.1）：名册 + 配对码 + 成员口令 + 共享清单都落这一个账本。
       * 每一请求现读 —— 改角色/移除成员**立刻生效**（U8-5）。
       */
      space: createSpaceStore(dataDir),
      log: (line) => process.stderr.write(`[serve] ${line}\n`),
    });
  } catch (error) {
    // 硬拒（比如"对外绑定没给 token"）在这里变成一句人话 + 非零退出
    process.stderr.write(`${(error as Error)?.message ?? error}\n`);
    return 2;
  }

  const hookNames = Object.keys(hooks);
  process.stdout.write(
    [
      `Agent Server 已起：${started.url}`,
      `  档位：${deps.mode}　provider：${deps.provider}`,
      /*
       * ⚠️ 口令**一定**会打印：回环且没显式给时它是现场生成的随机值 ——
       * 不打印的话本机也没人知道它（fail-closed 的代价就是"必须把钥匙交到用户手上"）。
       */
      `  口令：${started.token}${token ? "" : "（本次随机生成；要固定就 --token 或 DH_SERVE_TOKEN）"}`,
      `  用法：curl -H "Authorization: Bearer ${started.token}" ${started.url}/v1/info`,
      `  成员：${members.length ? members.map((m) => m.id).join(" / ") + "（各自一把口令；只能看归自己的会话）" : "无（只有主口令）"}`,
      `  接口：GET /healthz　GET /v1/info　GET /v1/sessions　POST /v1/run（SSE）　PUT/POST/GET /v1/streams/<流>（同步中继）　/v1/space/*（团队空间：邀请/入团/成员/共享/接管）${hookNames.length ? `　POST /v1/hooks/<名字>（${hookNames.join(" / ")}，要签名）` : ""}`,
      ...(deps.mode === "按需确认"
        ? ["  ⚠️ 档位是「按需确认」：服务态没有审批通道，需要确认的工具会被拦下（不会执行），对外如实报失败"]
        : []),
      ...(hookNames.length && !hookSecret
        ? ["  ⚠️ 配了 hook 但没给 --hook-secret / DH_HOOK_SECRET：这些 webhook 一律 403（缺省 fail-closed）"]
        : []),
      `  ${bind && bind !== "127.0.0.1" ? "⚠️ 绑在非回环地址上：口令是唯一的一道门，别把它贴到聊天里" : "只绑回环（本机可用；对外请显式 --bind 并同时给 --token）"}`,
      "",
      "Ctrl+C 退出（再按一次立即退出）。",
      "",
    ].join("\n"),
  );

  /* 等到被杀：这个进程的存在本身就是服务 */
  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        /* 第二次 Ctrl+C：不再等（止损优先于优雅） */
        process.exit(1);
      }
      stopping = true;
      process.stderr.write("[serve] 正在关闭：中止在跑的回合、销毁在途连接……\n");
      void started.stop().then(() => {
        approvals.close();
        resolve(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/** `ding acp` —— 作为 ACP agent 跑在标准输入输出上。 */
export async function cmdAcp(p: Parsed, dataDir: string): Promise<number> {
  const startedAt = Date.now();
  const deps = hostDeps(dataDir, p, startedAt);
  if (!deps.provider) {
    process.stderr.write("先配一个 provider：ding init（或 ding config set provider <id>）\n");
    return 3;
  }

  const agent = new AcpAgent({
    makeEngine: deps.makeEngine,
    authorizeCwd: (raw) => authorizeCwd(raw, deps.dirs),
    mode: deps.mode,
    provider: deps.provider,
    ...(deps.model ? { model: deps.model } : {}),
    /* ⚠️ 协议通道是 **stdout**：只写 JSON-RPC 一行一条，别的都去 stderr */
    send: (message) => process.stdout.write(JSON.stringify(message) + "\n"),
    log: (line) => process.stderr.write(`[acp] ${line}\n`),
  });

  const rl = createInterface({ input: process.stdin, terminal: false });
  /*
   * ⚠️ **不能** `await agent.handleLine(line)`（审计 P175）：`session/prompt` 会一直
   * 等到 `engine.run` 结束，串行 await 会让 `session/cancel` 在这一轮跑完之前
   * **根本读不到** —— 中止在生产接线上必然失效。
   * 现在逐行派发：cancel 这类通知立刻处理；同一会话的并发 prompt 由 agent 自己拒绝。
   */
  for await (const line of rl) {
    void agent.handleLine(line).catch((error: unknown) => {
      process.stderr.write(`[acp] 处理一行失败：${String((error as Error)?.message ?? error)}\n`);
    });
  }
  return 0;
}
