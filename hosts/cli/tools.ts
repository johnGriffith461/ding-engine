import type { ToolSet } from "ai";

import { SPAWN_AGENT_TOOL, SPAWN_AGENTS_TOOL, subagentPrompt } from "../../shared/agentTools";
import type { ConfirmMode } from "../../shared/ipc";
import { unknownToolNotice } from "../../engine/core/notices";
import type { ExecutorContext, ToolExecutor, ToolResult } from "../../engine/ports/executor";
import type { HealthStore } from "../../engine/ports/health";
import { runSubagent } from "../../engine/runtime/subagent";
import { runTeam } from "../../engine/runtime/team";
import { isPluginTool } from "../../engine/runtime/plugins";
import { runPluginTool } from "../../engine/runtime/pluginHost";
import {
  describeListDirResult,
  describeSearchResult,
  listDirForModel,
  nothingFoundNote,
  searchFilesForModel,
} from "../../engine/runtime/tools/searchTool";
import { describeReadResult, readFileForModel } from "../../engine/runtime/tools/readTool";
import { describeWriteResult, writeFileForModel } from "../../engine/runtime/tools/writeTool";
import { describeEditResult, editFileForModel } from "../../engine/runtime/tools/editTool";
import { describeRunResult, runCommandForModel } from "../../engine/runtime/tools/execTool";

/**
 * CLI 宿主的**执行体**：把内核给的工具名落到真实文件系统上。
 *
 * ## 它与桌面那套的关系
 *
 * 桌面那份在 `electron/ipc/tools.ts`：它多出来的部分是"落到哪个 store"
 * （记忆库、画布、定时任务）—— 那些是**桌面宿主的**东西。文件类工具两边**完全一样**，
 * 因为它们本来就只吃一个"目录白名单"参数（`engine/runtime/tools/`）。
 *
 * ⚠️ 这里的返回形状与桌面那份**逐字段对齐**（`ok` / `line` / 外加各工具自己的字段）。
 * 不是抄一遍就完事：留痕那一行由 `describeToolResult` 生成，它读的就是这些字段 ——
 * 两边形状不一致时，屏幕上与终端里会看到**同一件事的两种说法**。
 *
 * ## 一条边界（如实）
 *
 * CLI 的目录白名单来自命令行 `--dir`（默认当前目录），**没有对话框授权这一步**。
 * 也就是说：`ding run --dir /` 是真的能把整台机器交出去。这是命令行工具的正常代价
 * （与 `rm -rf` 同级），但它与桌面那套"用户点过授权"的语义**不是一回事**，
 * 所以在这里明写出来，而不是让它看起来像有闸门。
 */

/** 子智能体要用的工具集（由宿主注入：它需要注册表，而注册表需要执行体）。 */
export type MakeTools = (
  mode: ConfirmMode,
  depth: number,
  provider: string,
  signal: AbortSignal | undefined,
  /** 只要这些工具（agent 白名单，Phase 7.1）。省略 = 不限制。 */
  only?: readonly string[],
) => ToolSet;

/**
 * 建一个 CLI 执行体。
 *
 * @param opts.dirs 授权目录（白名单）
 * @param opts.makeTools 造子智能体的工具集（`spawn_agent` 用）
 * @param opts.health 健康账本（沿父级传给子智能体）
 * @returns 执行体
 */
export function createCliExecutor(opts: {
  dirs: readonly string[];
  makeTools: MakeTools;
  health?: HealthStore;
}): ToolExecutor {
  const { dirs, makeTools } = opts;

  /** 逐个工具的实现（键就是 `AGENT_TOOLS` 里的名字）。 */
  const run = async (name: string, input: unknown, ctx: ExecutorContext): Promise<ToolResult> => {
    switch (name) {
      case "list_files": {
        // 没有云盘那种"驱动器"概念：就把每个授权目录的第一层列出来
        const parts: string[] = [];
        for (const dir of dirs) {
          const got = await listDirForModel({ path: dir, depth: 1 }, dirs);
          parts.push(got.ok ? `${dir}\n${got.entries.join("\n")}` : `${dir}\n${got.error}`);
        }
        const text = parts.join("\n\n");
        return { ok: true, output: { count: dirs.length, line: `列了 ${dirs.length} 个授权目录`, text } };
      }

      case "read_file": {
        const { path: raw } = input as { path: string };
        const result = await readFileForModel(raw, dirs);
        return {
          ok: result.ok,
          output: {
            ok: result.ok,
            line: describeReadResult(result, raw),
            ...(result.ok ? { text: result.text, chars: result.chars, truncated: result.truncated } : { error: result.error }),
          },
          ...(result.ok ? {} : { error: result.error }),
        };
      }

      case "write_file": {
        const { path: raw, content, overwrite } = input as { path: string; content: string; overwrite?: boolean };
        const result = await writeFileForModel(raw, content, dirs, overwrite === true);
        const output = {
          ok: result.ok,
          line: describeWriteResult(result, raw),
          ...(result.ok
            ? { path: result.path, chars: result.chars, bytes: result.bytes, created: result.created }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "edit_file": {
        const { path: raw, oldText, newText, replaceAll } = input as {
          path: string;
          oldText: string;
          newText: string;
          replaceAll?: boolean;
        };
        const result = await editFileForModel(raw, oldText, newText, dirs, replaceAll === true);
        const output = {
          ok: result.ok,
          line: describeEditResult(result, raw),
          ...(result.ok ? { path: result.path, replaced: result.replaced, atLine: result.line } : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "list_dir": {
        const { path: raw, depth, pattern } = input as { path?: string; depth?: number; pattern?: string };
        const result = await listDirForModel({ ...(raw === undefined ? {} : { path: raw }), depth, pattern }, dirs);
        const output = {
          ok: result.ok,
          line: describeListDirResult(result, raw ?? "(授权目录)"),
          ...(result.ok
            ? {
                entries: result.entries.length,
                truncated: result.truncated,
                text: result.entries.length ? result.entries.join("\n") : nothingFoundNote("这个目录"),
              }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "search_files": {
        const { pattern, path: raw, include, literal, limit } = input as {
          pattern: string;
          path?: string;
          include?: string;
          literal?: boolean;
          limit?: number;
        };
        const result = await searchFilesForModel(
          { pattern, ...(raw === undefined ? {} : { path: raw }), include, literal, limit },
          dirs,
          ctx.signal,
        );
        const output = {
          ok: result.ok,
          line: describeSearchResult(result, pattern),
          ...(result.ok
            ? {
                count: result.matches.length,
                truncated: result.truncated,
                text: result.matches.length ? result.matches.join("\n") : nothingFoundNote("这一搜"),
              }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      case "run_command": {
        const { command, workdir, timeout } = input as { command: string; workdir?: string; timeout?: number };
        const result = await runCommandForModel({ command, ...(workdir === undefined ? {} : { workdir }), timeout }, dirs);
        const output = {
          ok: result.ok,
          line: describeRunResult(result, command),
          ...(result.ok
            ? { exitCode: result.exitCode, cwd: result.cwd, truncated: result.truncated, timedOut: result.timedOut, text: result.output }
            : { error: result.error }),
        };
        return { ok: result.ok, output, ...(result.ok ? {} : { error: result.error }) };
      }

      /*
       * 一支小队（Phase 7.2）：并行派几个专家，汇合回一份报告。
       * 工具白名单按每个专家的 AgentSpec 生效（研究员的工具集里**没有**写工具）。
       */
      case SPAWN_AGENTS_TOOL: {
        const { tasks } = input as { tasks: { agent: string; task: string; context?: string }[] };
        return {
          ok: true,
          output: await runTeam({
            tasks: tasks ?? [],
            provider: ctx.provider,
            ...(ctx.model ? { model: ctx.model } : {}),
            callerMode: ctx.mode,
            makeTools: (mode, depth, provider, signal, only) => makeTools(mode, depth, provider, signal, only),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            depth: ctx.depth ?? 0,
            ...(opts.health ? { health: opts.health } : {}),
            ...(ctx.onDelegation ? { onDelegation: ctx.onDelegation } : {}),
          }),
        };
      }

      case SPAWN_AGENT_TOOL: {
        const { task, context } = input as { task: string; context?: string };
        const depth = (ctx.depth ?? 0) + 1;
        const { system, user } = subagentPrompt(task, context);
        const report = await runSubagent({
          provider: ctx.provider,
          ...(ctx.model ? { model: ctx.model } : {}),
          system,
          user,
          tools: makeTools(ctx.mode, depth, ctx.provider, ctx.signal),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(opts.health ? { health: opts.health } : {}),
        });
        return { ok: true, output: report };
      }

      default:
        /*
         * 插件工具（Phase 8.3）：名字带前缀，运行时按前缀分流（与 MCP 同一条思路）。
         */
        if (isPluginTool(name)) {
          try {
            return { ok: true, output: await runPluginTool(name, input) };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }
        // 未知工具：回一句"没有这个工具"，而不是抛异常（口径同 unknownToolNotice）
        return { ok: false, error: unknownToolNotice(name) };
    }
  };

  return { run };
}
