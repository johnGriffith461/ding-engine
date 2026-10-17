import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteSessionStore } from "../../engine/adapters/sqliteStore";
import { createApprovalsIndex } from "../../engine/adapters/sqliteApprovals";
import { chatSessionId, type LogInput } from "../../engine/core/events";
import { boot, cleanupDirs, stopEverything } from "../server/testKit";
import { cmdApprovals } from "./cmdApprovals";

/**
 * **`ding approvals`：批后通知的消费端**（3.7b 的最后一段）。
 *
 * 通知端点上一轮建好了却没人消费 —— 一个没人用的通知等于没通知。这一组盯着两条：
 *   ① `--to/--token` 齐全时能列出待决/已决（真服务、真 token）；
 *   ② 缺参数时**说清用法**并返回非零（不静默什么都不做）。
 *
 * `--watch` 那条流的读法由服务端那份用例（`approvalApi.test.ts`）盯着；
 * 这里不重复造一个会挂住的测试。
 */

afterEach(async () => {
  await stopEverything();
  vi.restoreAllMocks();
});

describe("ding approvals（通知消费端）", () => {
  it("⭐ 列出待决与已决（真服务）", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-cli-approvals-"));
    cleanupDirs.push(dir);
    const approvals = createApprovalsIndex(dir);
    const sid = chatSessionId("cli-approvals");
    const store = createSqliteSessionStore(dir);
    await store.append(sid, [
      { requestId: "r1", type: "tool-result", toolCallId: "c1", toolName: "write_file", output: { pending: true, notice: "等确认", approvers: ["local"] } } as LogInput,
    ]);
    store.close();

    const { port, token } = await boot({
      relay: undefined,
      approvals,
      appendRecord: async (id: string, record: unknown) => {
        const s = createSqliteSessionStore(dir);
        try {
          await s.append(id, [record as LogInput]);
        } finally {
          s.close();
        }
      },
      listSessions: async () => {
        const s = createSqliteSessionStore(dir);
        try {
          return await s.list();
        } finally {
          s.close();
        }
      },
      loadSession: async (id: string) => {
        const s = createSqliteSessionStore(dir);
        try {
          return await s.load(id);
        } finally {
          s.close();
        }
      },
    });

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      const code = await cmdApprovals({
        command: "approvals",
        args: [],
        flags: new Map([
          ["to", [`http://127.0.0.1:${port}`]],
          ["token", [token]],
        ]),
      } as never);
      expect(code).toBe(0);
      expect(out.join("")).toContain("write_file");
      expect(out.join("")).toContain("pending");
    } finally {
      spy.mockRestore();
    }
  });

  it("缺参数：说清用法 + 非零退出（不静默什么都不做）", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    let code = 0;
    try {
      code = await cmdApprovals({ command: "approvals", args: [], flags: new Map() } as never);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(1);
    expect(errors.join("")).toContain("ding approvals --to");
  });
});
