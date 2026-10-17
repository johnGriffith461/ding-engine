/**
 * `ding --help` 的那一屏（2026-10-16 从 `ding.ts` 拆出来）。
 *
 * 拆的理由是 `src/structureGuard.test.ts` 的巨石上限（`.ts` ≤ 900 行）：
 * `ding.ts` 在加完审计修复（P212 的不认识命令守卫、P129 的数据根提醒）之后到了 918 行。
 * 这一块是**纯文案**，与命令分发、参数解析没有任何耦合 —— 它是最该先搬走的部分。
 *
 * ⚠️ 命令表**必须与 `ding.ts` 的分发链一致**（`KNOWN_COMMANDS` 那份名单就是它的镜像）：
 * 这里多写一条不存在的命令、或漏掉一条真的命令，都是在教用户做错事。
 */

/**
 * 打印帮助，返回退出码（恒 0）。
 *
 * @param devMode 是否显示工程模式（`--dev`）
 * @param dataDir 本次实际使用的数据目录（照实打出来 —— 它会被 `DH_DATA_DIR` /
 *   `DSH_CANVAS_DATA_DIR` 改，用户要能看见自己现在落在哪）
 */
export function cmdHelp(devMode: boolean, dataDir: string): number {
  process.stdout.write(
    [
      "ding —— Ding Harness 的命令行宿主",
      "",
      '  ding run "任务" [--dir <目录>] [--provider <id>] [--model <名>] [--mode <档位>] [--steps n]',
      "  ding sessions [--kind chat|task|cli] [--json] [--export <会话 id>]",
      "  ding sessions --cost [--by session|day|model]   # 成本账本（数字只来自 provider 上报）",
      "  ding doctor [--json]                           # 一键自检（每项失败都给下一步）",
      "  ding recipe list|show|run|export|import            # 任务模板（可分享的「提示词 + 工具范围 + 档位」）",
      "  ding space [invite|join|members|roles|remove|share|unshare|takeover|rooms|room|usage|audit]   # 团队空间（配对码 / 名册 / 共享 / 接管 / 账本）",
      "  ding approvals --to <服务地址> --token <口令> [--watch]   # 审批：列一遍 / 盯着新处置（批后通知的消费端）",
      "  ding sync <会话 id> --to <服务地址> --token <口令>   # 两端同步（推自己 + 拉别人，幂等；口令也可走 DH_SYNC_TOKEN）",
      "  ding serve [--port 8787] [--bind <地址> --token <口令>] [--member <id>:<口令>]…  # Agent Server（默认只绑回环；--member 给成员身份）",
      "  ding connect <url> [任务] [--token <口令>]           # 连到远端 agent 跑一轮（Phase 17 的另一半）",
      "  ding acp                                       # 作为 ACP agent 跑在标准输入输出上（被外部宿主驱动）",
      "  ding resume [<会话 id>] [--continue]           # 崩溃恢复（列出被打断的回合；--continue 重跑那一轮）",
      "  ding backup [--out <文件>] [--keep-provenance] # 全量备份（会话 + 配置型 store + CLI 配置，单个 JSON）",
      "  ding restore <文件> [--list]                   # 从备份恢复（--list 只看不恢复；只补不覆盖：已有的键跳过）",
      "  ding init                                      # 首次配置向导（配 key / 选模型 / 选目录）",
      "  ding eval [类别] [--json] [--update-baseline]  # 离线评测集（不烧 token，可进 CI）",
      "  ding models",
      "  ding agents                                    # 内置专家（AgentSpec）",
      "  ding plugins [list|install <目录|npm:包名> --yes|enable|disable|remove|doctor]",
      "  ding config [show|set <键> <值>|unset <键>]    # 默认 provider / 模型 / 档位 / 目录",
      "  ding --json <命令>                             # 给脚本/CI 的 JSON 输出",
      ...(devMode
        ? [
            "",
            "工程模式（--dev，验收驱动器，不属于产品表面）：",
            "  ding record <会话 id> [--out <文件>]",
            "  ding replay <快照文件>",
          ]
        : ["", "（`--dev` 会多出两个工程模式命令：record / replay —— 那是验收驱动用的。）"]),
      "",
      /*
       * ⚠️ 这一行要**如实**（审计 P129）：数据目录可以被两个环境变量改，
       * 而用户最需要知道的就是"我现在落在哪"（`ding backup` 备份的是它，不是桌面那份）。
       */
      `数据目录：${dataDir}（DH_DATA_DIR 可覆盖；桌面的 DSH_CANVAS_DATA_DIR 也认）`,
      "",
    ].join("\n"),
  );
  return 0;
}
