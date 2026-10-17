import path from "node:path";

import { normalizeRoles, type MemberRole } from "../../engine/core/members";
import {
  memberView,
  newPairingCode,
  redeemPairingCode,
  removeFromSpace,
  rolesIn,
  setMemberRoles,
} from "../../engine/core/space";
import { createSpaceStore, emptySpaceFile, issueToken, type SpaceFile, type SpaceStore } from "../../engine/adapters/spaceStore";
import { auditOf, auditQuery, auditSummary } from "../../engine/core/audit";
import { ledgerOf, rollup } from "../../engine/core/ledger";
import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { newRoomSecret, roomLink } from "../../engine/sync/e2ee";
import { sumUsage } from "../../shared/cost";
import type { Parsed } from "./args";

/**
 * **`ding space ...`：团队空间的本机入口**（V5-3 的产品面，2026-10-17 补）。
 *
 * ## 它补的是哪一格
 *
 * V5-3 那一整族 `/v1/space/*` 之前**只有服务端**：发配对码、入团、共享、接管、
 * 查账本，全都得 `curl`（或者自己写个客户端）。而空间账本（`space.json`）
 * 与 `ding serve` 用的是**同一个文件** —— 于是"本机直接改账本"这条路
 * 既最短也最不容易错。
 *
 * ## 两条边界（如实说）
 *
 * 1. **`join` 在本机做的是"替你入团"**：主人拿着一张码在这台机器上兑出成员口令，
 *    再把口令交给那个人。**被邀请的人自己兑码**走 `POST /v1/space/join`
 *    （`ding serve` 那条路）—— 那是远端成员该有的入口，CLI 这里不假装能替代它。
 * 2. **`takeover` 在本机做的是"主人指定持有人"**（代班）：接管本来是成员的动作，
 *    成员自己接管走 `POST /v1/space/takeover/:id`；这里是主人代设。
 *
 * 指令一览（`ding space` 不带子命令 = 看一眼现状）：
 *
 * ```
 * ding space                                     # 名册 / 共享 / 持有人 / 未用的码
 * ding space invite [--roles viewer,admin]       # 发一张配对码（10 分钟、一码一人）
 * ding space join <码> --as <成员 id> [--name <显示名>]
 * ding space members                             # 名册（含角色）
 * ding space roles <成员 id> <角色,…>             # 改角色（owner/admin/specialist/viewer）
 * ding space remove <成员 id>                    # 移除（口令一并作废）
 * ding space share <会话 id> | unshare <会话 id>
 * ding space rooms | room <会话 id> [--server <服务地址>]   # 端到端加密房间（密钥只显示一次）
 * ding space takeover <会话 id> --as <成员 id>
 * ding space usage [--by member|day|account]     # 成本账本（数字只来自 provider 上报）
 * ding space audit [--member <id>] [--limit n]   # 成员操作留痕（请求/审批两类）
 * ```
 */

/**
 * 读账。**账本不存在 = 还没开过空间** → 用 `emptySpaceFile()`（那份**已经**把主人
 * 放进名册、并给了 `owner` 角色）—— 空名册的后果是"主人自己都发不了码"：
 * `newPairingCode` 走的是"你能管成员吗"，而"能管"读的是名册里的角色。
 * 读不动（corrupt）时给同一份空账 + 一句原因（**不覆盖磁盘上那份**）。
 */
function readSpace(store: SpaceStore): { space: SpaceFile; note?: string } {
  const got = store.read();
  if (got.status === "ok") return { space: got.space };
  return { space: emptySpaceFile(), ...(got.status === "corrupt" ? { note: got.note } : {}) };
}

/** 成员 id 的形状（与配对码那侧同一套：`space.ts` 里也是这个规矩）。 */
const MEMBER_ID_OK = /^[a-z][a-z0-9-]{1,40}$/;

export async function cmdSpace(parsed: Parsed, dataDir: string): Promise<number> {
  const sub = parsed.args[0] ?? "";
  const store = createSpaceStore(dataDir);
  const json = parsed.flags.has("json");
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const emit = (payload: unknown, human: string[]): number => {
    if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else for (const line of human) say(line);
    return 0;
  };

  const { space, note } = readSpace(store);
  if (note) process.stderr.write(`⚠️ ${note}（下面看到的是空账；没有覆盖磁盘上那份）\n`);

  /* ── 现状 ─────────────────────────────────────────────── */
  if (!sub || sub === "show") {
    const members = memberView(space.roster);
    const unused = space.roster.codes.filter((c) => !c.usedBy);
    return emit(
      { owner: space.roster.owner, members, shared: space.shared, holders: space.holders, pendingCodes: unused.length, file: store.file() },
      [
        `空间主人：${space.roster.owner}`,
        `成员（${members.length}）：`,
        ...members.map((m) => `  ${m.id}　角色 ${m.roles.join("/") || "（无）"}`),
        `共享出去的会话（${space.shared.length}）：${space.shared.join(" / ") || "（还没有）"}`,
        ...Object.entries(space.holders).map(([id, who]) => `  ${id} 当前持有人：${who}`),
        `未用的配对码：${unused.length} 张`,
        `账本：${store.file()}`,
        "",
        "（要发码/入团/共享，见 `ding space invite` 等子命令；`ding space --help` 或 `ding --help`）",
      ],
    );
  }

  /* ── 发码 ─────────────────────────────────────────────── */
  if (sub === "invite") {
    /* flags 是 `Map<string, string[]>`（一个旗标可以重复）—— 取第一项 */
    const raw = parsed.flags.get("roles")?.[0];
    const roles: MemberRole[] | undefined = raw ? normalizeRoles(raw.split(",")) : undefined;
    const made = newPairingCode(space.roster, { createdBy: space.roster.owner, ...(roles ? { roles } : {}) });
    if (!made.ok) {
      process.stderr.write(`发码被拒：${made.message}\n`);
      return 1;
    }
    store.write({ ...space, roster: { ...space.roster, codes: [...space.roster.codes, made.code] } });
    /* ⚠️ 不打印 member 口令（还没有那个人）；这条只发"入场券" */
    return emit(
      { code: made.code.code, roles: made.code.roles, expiresAt: made.code.expiresAt },
      [
        `配对码：${made.code.code}`,
        `  角色：${made.code.roles.join(" / ") || "（无）"}　有效期：10 分钟，一码一人`,
        `  入团（远端）：POST /v1/space/join  {"code": "${made.code.code}", "memberId": "<他的 id>"}`,
        `  入团（本机代为兑码）：ding space join ${made.code.code} --as <他的 id>`,
        "  口令只在入团那一次给出来 —— 收好（丢了就重新邀请）。",
      ],
    );
  }

  /* ── 入团（本机代兑）──────────────────────────────────── */
  if (sub === "join") {
    const code = parsed.args[1] ?? "";
    const memberId = parsed.flags.get("as")?.[0] ?? "";
    if (!code || !memberId) {
      process.stderr.write("用法：ding space join <配对码> --as <成员 id> [--name <显示名>]\n");
      return 1;
    }
    const got = redeemPairingCode(space.roster, {
      code,
      memberId,
      ...(parsed.flags.get("name")?.[0] ? { displayName: parsed.flags.get("name")![0]! } : {}),
    });
    if (!got.ok) {
      process.stderr.write(`兑码失败（${got.reason}）：${got.message}\n`);
      return 1;
    }
    const token = issueToken(space.tokens);
    store.write({ ...space, roster: got.roster, tokens: { ...space.tokens, [got.member.id]: token } });
    return emit(
      { token, member: got.member },
      [
        `${got.member.id} 已入团（角色 ${got.member.roles.join("/") || "viewer"}）`,
        `  口令：${token}`,
        "  ⚠️ 这把口令只显示这一次：请**当面/私下**交给那个人（丢了就移除他、重新邀请）。",
        "  ⚠️ 本机这条是「替你入团」；被邀请的人自己兑码走 POST /v1/space/join（`ding serve` 那条路）。",
      ],
    );
  }

  /* ── 名册 ─────────────────────────────────────────────── */
  if (sub === "members") {
    const members = memberView(space.roster);
    return emit({ members }, members.length ? members.map((m) => `${m.id}　${m.roles.join("/") || "（无）"}`) : ["（还没有成员）"]);
  }

  /* ── 改角色 / 移除 ────────────────────────────────────── */
  if (sub === "roles") {
    const memberId = parsed.args[1] ?? "";
    const roles = normalizeRoles((parsed.args[2] ?? "").split(","));
    const got = setMemberRoles(space.roster, { by: space.roster.owner, memberId, roles });
    if (!got.ok) {
      process.stderr.write(`改角色被拒（${got.reason}）：${got.message}\n`);
      return 1;
    }
    store.write({ ...space, roster: got.roster });
    return emit({ ok: true, memberId, roles }, [`${memberId} 的角色改成：${roles.join("/") || "（无）"}`]);
  }

  if (sub === "remove") {
    const memberId = parsed.args[1] ?? "";
    const got = removeFromSpace(space.roster, { by: space.roster.owner, memberId });
    if (!got.ok) {
      process.stderr.write(`移除被拒（${got.reason}）：${got.message}\n`);
      return 1;
    }
    /* 撤权即时生效：口令从账上删掉（服务端每请求现读账本 —— U8-5） */
    const { [memberId]: _gone, ...tokens } = space.tokens;
    store.write({ ...space, roster: got.roster, tokens });
    return emit({ ok: true, memberId }, [`${memberId} 已移除（口令同时作废 —— 他下一个请求就 401）`]);
  }

  /* ── 端到端加密房间（V5-2 2.4 的产品入口）────────────── */
  if (sub === "rooms" || sub === "room") {
    if (sub === "rooms") {
      const rows = Object.entries(space.rooms).map(([sessionId, room]) => ({ sessionId, roomId: room.roomId }));
      return emit(
        { rooms: rows },
        rows.length
          ? rows.map((r) => `${r.roomId}　会话 ${r.sessionId}　（端到端加密：密钥在链接的 # 后面）`)
          : ["还没有房间。建一个：ding space room <会话 id> --server <服务地址>"],
      );
    }
    const sessionId = parsed.args[1] ?? "";
    if (!sessionId) {
      process.stderr.write(`用法：ding space room <会话 id> --server <服务地址>（${"`"}--server${"`"} 用来拼出完整链接）
`);
      return 1;
    }
    if (!space.shared.includes(sessionId)) {
      process.stderr.write(`这段会话还没共享出去：${sessionId}（先 ding space share ${sessionId}）
`);
      return 1;
    }
    const secret = newRoomSecret(`r-${Math.random().toString(36).slice(2, 10)}`);
    store.write({ ...space, rooms: { ...space.rooms, [sessionId]: { roomId: secret.roomId } } });
    /* ⚠️ 密钥**只在这里给一次**，账本里只存房间号（零知识：服务端收不到密钥） */
    const server = parsed.flags.get("server")?.[0] ?? "";
    const link = server ? roomLink(server, secret) : "";
    return emit(
      { roomId: secret.roomId, key: secret.key, link: link || undefined },
      [
        `房间号：${secret.roomId}　会话：${sessionId}`,
        `密钥：${secret.key}`,
        ...(link
          ? [`链接：${link}`, "（密钥在 # 之后 —— 服务端收不到它；把整条链接发给另一端）"]
          : ["把它拼成链接给另一端：<服务地址>/r/<房间号>#<密钥>（--server <地址> 可以直接拼出来）"]),
        "⚠️ 密钥只显示这一次：账本里只存房间号，丢了就重建一个房间。",
      ],
    );
  }

  /* ── 共享 / 取消 ──────────────────────────────────────── */
  if (sub === "share" || sub === "unshare") {
    const sessionId = parsed.args[1] ?? "";
    if (!sessionId) {
      process.stderr.write(`用法：ding space ${sub} <会话 id>\n`);
      return 1;
    }
    const shared = sub === "share" ? (space.shared.includes(sessionId) ? space.shared : [...space.shared, sessionId]) : space.shared.filter((x) => x !== sessionId);
    store.write({ ...space, shared });
    return emit({ ok: true, shared }, [sub === "share" ? `已共享：${sessionId}` : `已取消共享：${sessionId}`, `共享清单：${shared.join(" / ") || "（空）"}`]);
  }

  /* ── 指定持有人（主人代班）────────────────────────────── */
  if (sub === "takeover") {
    const sessionId = parsed.args[1] ?? "";
    const who = parsed.flags.get("as")?.[0] ?? "";
    if (!sessionId || !who) {
      process.stderr.write("用法：ding space takeover <会话 id> --as <成员 id>（本机这条是主人代设；成员自己接管走 HTTP）\n");
      return 1;
    }
    if (!space.shared.includes(sessionId)) {
      process.stderr.write(`这段会话还没共享出去：${sessionId}（先 ding space share ${sessionId}）\n`);
      return 1;
    }
    store.write({ ...space, holders: { ...space.holders, [sessionId]: who } });
    return emit({ ok: true, sessionId, holder: who }, [`${sessionId} 的持有人：${who}`]);
  }

  /* ── 账本 / 审计（真数据：本机会话库）─────────────────── */
  if (sub === "usage" || sub === "audit") {
    const store2 = createSqliteSessionStore(dataDir);
    try {
      const sessions = await store2.list();
      if (sub === "usage") {
        const entries = [];
        for (const s of sessions) entries.push(...ledgerOf((await store2.load(s.sessionId)).records, s.sessionId, { accountId: s.owner ?? "local" }));
        const by = (parsed.flags.get("by")?.[0] ?? "member") as "member" | "day" | "account" | "session";
        const rows = rollup(entries, by);
        const total = { turns: entries.length, usage: sumUsage(entries.map((e) => e.usage)) ?? null };
        return emit(
          { total, rows },
          [
            `账本合计：${total.turns} 轮　${total.usage ? `输入 ${total.usage.inputTokens ?? 0} / 输出 ${total.usage.outputTokens ?? 0} token` : "（provider 没报用量）"}`,
            ...rows.map((r) => `  ${r.label}：${r.turns} 轮　${r.totalTokens ?? "?"} token`),
            "",
            "（数字只来自 provider 上报的 usage —— 拿不到就留空，不按字数估）",
          ],
        );
      }
      const entries = [];
      for (const s of sessions) entries.push(...auditOf(s.sessionId, (await store2.load(s.sessionId)).records as never[]));
      const wanted = parsed.flags.get("member")?.[0];
      const limit = parsed.flags.get("limit")?.[0];
      const hits = auditQuery(entries, {
        ...(wanted ? { member: wanted } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      const summary = auditSummary(entries);
      return emit(
        { summary, entries: hits },
        [
          `审计：留痕 ${entries.length} 条，命中 ${hits.length} 条`,
          ...summary.map((row) => `  ${row.actor.id}　${row.count} 条`),
          "",
          ...hits.slice(0, 20).map((h) => `  ${h.sessionId}　${h.actor.id}　${h.action}${h.detail ? `　${h.detail}` : ""}`),
        ],
      );
    } finally {
      store2.close();
    }
  }

  process.stderr.write(
    `不认识的子命令：${sub}\n` +
      "可用：show（默认）| invite | join | members | roles | remove | share | unshare | takeover | usage | audit\n",
  );
  return 1;
}

/** 成员 id 的形状校验（给上面的提示用；导出让守卫能钉住它）。 */
export function memberIdOk(raw: string): boolean {
  return MEMBER_ID_OK.test(raw);
}

/** 名册里这个人什么角色（诊断用）。 */
export function rolesOfMember(space: SpaceFile, memberId: string): MemberRole[] | null {
  return rolesIn(space.roster, memberId);
}

/** 数据目录里的空间账本路径（`ding space` 与 `ding serve` 用的是同一个文件）。 */
export function spaceFileOf(dataDir: string): string {
  return path.join(dataDir, "space.json");
}
