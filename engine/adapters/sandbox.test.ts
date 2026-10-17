import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  SANDBOX_MEMORY_MB,
  SANDBOX_PROCESSES,
  findSandboxBinary,
  planFor,
  planSandboxed,
  probeSandbox,
  resetSandboxProbeCache,
  type SandboxInfo,
} from "./sandbox";

/**
 * 沙箱的**宿主侧**（Phase 14.1）。
 *
 * ## 这一层测什么、不测什么
 *
 * · 测**接线**：计划怎么拼、缺二进制时怎么退化、能力怎么问；
 * · 测**真行为**（二进制存在时）：内存上限真的会杀、子进程随沙箱一起收掉；
 * · **不测"能不能挡住恶意"** —— 它不是安全边界（见 `sandbox.ts` 头注与 SAFETY.md），
 *   拿它当边界才是错的。
 *
 * ⚠️ 二进制不在时（没跑过 `pnpm sandbox:build`）那几条**跳过并说清**，
 * 而不是假装通过 —— 不然"验过"就成了空话。
 *
 * ⚠️⚠️ **接线那几条用 `planFor` 把能力直接喂进去，不走 `probeSandbox()`**：
 * 只看真探测的话，本机（编过沙箱）永远只测到沙箱那条，**直通那条要等 CI
 * 或用户机器上才第一次执行** —— 2026-10-16 CI 第一次真跑单测，直通路的引号缺陷
 * 就是这么露头的（含引号的命令静默变成空操作）。两条路都要有常驻断言。
 */

const binary = findSandboxBinary();
const hasBinary = binary !== "" && existsSync(binary);

/** 「找到了沙箱」的能力（假的：这几条只问计划怎么拼，不 spawn）。 */
const foundInfo: SandboxInfo = {
  found: true,
  bounded: true,
  binary: "ding-sandbox",
  platform: process.platform,
  memoryMb: SANDBOX_MEMORY_MB,
  processes: SANDBOX_PROCESSES,
  note: "命令在作业对象里跑：有内存与子进程数上限，且随沙箱一起结束（不留孤儿）",
};
/** 「没找到沙箱」的能力 —— 没编过 `pnpm sandbox:build` 的机器、CI、装出来的版本都是它。 */
const missingInfo: SandboxInfo = {
  found: false,
  bounded: false,
  binary: "",
  platform: process.platform,
  memoryMb: SANDBOX_MEMORY_MB,
  processes: SANDBOX_PROCESSES,
  note: "没有 ding-sandbox（编它：pnpm sandbox:build）；命令将不受限地跑",
};

/**
 * 一条命令"真的被上限拦住 / 没跑成"的判据（审计 P41 顺手钉住的假判据，2026-10-16）。
 *
 * ⚠️ **不能写成 `status !== 0` 一句**：进程被异常终止时 Node 给的 `status` 是 `null`，
 * 而 `null !== 0` 也成立 —— 于是"二进制没找到 / 进程压根没起来"也算"通过"。
 * 本机实测（`--memory-mb 128` 跑 1GB 的分配）：`status: 1`、`signal: null`、
 * stderr 里是 Node 自己的 `RangeError: Array buffer allocation failed`；
 * 作业对象直接把进程杀掉那一档给的是 `signal` 非空（或至少是个具体的退出码）。
 *
 * 两种都算"没跑成"，**但必须是它们之一**：`status === null && signal === null`
 * （外加 spawn 失败那种连 `error` 都带着的）一律**不算**。
 *
 * @param got `spawnSync` 的结果
 * @returns 被上限拦住 / 没跑成吗
 */
function stoppedByLimit(got: { status: number | null; signal: string | null; error?: Error }): boolean {
  if (got.error) return false; // 连进程都没起来（ENOENT 之类）—— 那不是"上限生效"
  if (got.signal !== null) return true; // 被信号带走
  return typeof got.status === "number" && got.status !== 0;
}

describe("沙箱接线（Phase 14.1）", () => {
  it("①a 打包态：resources/ 下那份找得到（2026-10-16 主人逮到的那条）", () => {
    /*
     * 主人发现的问题：README 写着 ✅「作业对象」，可**安装包里根本没有 ding-sandbox**，
     * 而且 `findSandboxBinary` 只看 `process.cwd()` —— 装出来的应用 cwd 是"用户从哪儿启的"，
     * 于是就算打了包也找不到。这条钉的就是那个查找顺序。
     */
    const dir = mkdtempSync(path.join(os.tmpdir(), "dh-packaged-"));
    const name = process.platform === "win32" ? "ding-sandbox.exe" : "ding-sandbox";
    writeFileSync(path.join(dir, name), "x");
    const before = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", { value: dir, configurable: true, writable: true });
    try {
      expect(findSandboxBinary(), "resources/ 下那份应当被找到").toBe(path.join(dir, name));
    } finally {
      if (before) Object.defineProperty(process, "resourcesPath", before);
      else Reflect.deleteProperty(process, "resourcesPath");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("① 找不到二进制时：直通 + **明说没有隔离**（不静默降级）", () => {
    const info = probeSandbox();
    if (info.found) {
      // 本机有二进制：这条就不适用于"找不到"，但**形状**仍要成立
      expect(info.binary.length).toBeGreaterThan(0);
      expect(typeof info.bounded).toBe("boolean");
      expect(info.note.length).toBeGreaterThan(0);
      return;
    }
    expect(info.bounded).toBe(false);
    expect(info.note).toContain("不受限");
  });

  it("② 走沙箱那条：上限参数在，命令**不在 argv 里**（走环境变量）", () => {
    const plan = planFor("echo 你好", foundInfo);
    const joined = plan.args.join(" ");
    /*
     * ⚠️ 这条是踩出来的：命令同时出现在 argv 与环境变量里时，cmd 会收到两遍
     * （报错长成 `Cannot find module 'C:\…\work\"…" node …'`）。
     */
    expect(joined, "命令不该出现在 argv 里（它走 DING_SANDBOX_COMMAND）").not.toContain("echo 你好");
    expect(plan.args).toContain("--memory-mb");
    expect(plan.args).toContain(String(SANDBOX_MEMORY_MB));
    expect(plan.args).toContain("--processes");
    expect(plan.args).toContain(String(SANDBOX_PROCESSES));
    expect(plan.args).toContain("--from-env");
    expect(plan.env.DING_SANDBOX_COMMAND).toBe("echo 你好");
    /* 这条路的参数是给沙箱自己解析的，照常让 Node 转义 */
    expect(plan.verbatimArgv).toBe(false);
  });

  it("②b 直通那条：命令在 argv 里，且**原样**交给 cmd（关掉 Node 的 CRT 转义）", () => {
    const plan = planFor("echo 你好", missingInfo);
    expect(plan.bounded).toBe(false);
    expect(plan.env.DING_SANDBOX_COMMAND).toBeUndefined();
    const last = plan.args[plan.args.length - 1];
    if (process.platform === "win32") {
      /* 外面套的那层引号由 cmd 的 `/s` 剥掉，里层引号原样留下 */
      expect(last).toBe('"echo 你好"');
      expect(plan.verbatimArgv).toBe(true);
    } else {
      expect(last).toBe("echo 你好");
      expect(plan.verbatimArgv).toBe(false);
    }
  });

  it("②c 直通那条**真的能跑含引号的命令**（2026-10-16 CI 逮到的静默失效）", () => {
    /*
     * 判据就是当年的故障现象：含引号的命令**退出码 0 但没有输出**。
     * 这里真跑一次 —— 拼对了才拿得到那句 marker。
     * ⚠️ 别把这条改成"断言 args 长什么样"：这正是它当年躲过所有断言的原因。
     */
    const plan = planFor(`node -e "console.error('straight-through-marker')"`, missingInfo);
    const got = spawnSync(plan.file, plan.args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatimArgv,
      timeout: 60_000,
    });
    expect(got.status).toBe(0);
    expect(`${got.stdout ?? ""}${got.stderr ?? ""}`).toContain("straight-through-marker");
  });

  it("③ 上限可以压小（验收要它快，不该非等 2GB / 32 个进程）", () => {
    const plan = planFor("echo x", foundInfo, { memoryMb: 64, processes: 2 });
    expect(plan.args).toContain("64");
    expect(plan.args).toContain("2");
  });

  it("⭐ 默认上限取自**沙箱自己报的**（P122）：宿主侧那份只是老二进制的回落值", () => {
    /*
     * `--probe` 会带上 `defaultMemoryMb` / `defaultProcesses`，而宿主侧原来另外硬写了
     * 一份常量 —— 同一个默认值两处各写一遍，改一边就漂。现在以沙箱报的为准：
     * 这里喂一份「和常量不一样」的能力，计划里就该出现它报的数（而不是常量）。
     * 退回「用常量」的实现时这条会红 —— 那正是漂移发生的方式。
     */
    const plan = planFor("echo x", { ...foundInfo, memoryMb: 1234, processes: 7 });
    expect(plan.args, "计划里用的不是沙箱报的默认内存上限").toContain("1234");
    expect(plan.args, "计划里用的不是沙箱报的默认进程上限").toContain("7");
    expect(plan.args).not.toContain(String(SANDBOX_MEMORY_MB));

    /* 显式传值仍然压得住沙箱报的那份 */
    const forced = planFor("echo x", { ...foundInfo, memoryMb: 1234, processes: 7 }, { memoryMb: 64 });
    expect(forced.args).toContain("64");
  });

  it("⭐ 0 / 负数这类无效上限**绝不送出去**（P122）：回落到默认，不指望对面拦", () => {
    /*
     * Rust 侧实测：作业对象那两个字段带上限标志时，**0 让约束整个失效**
     * （内存 0 → 上限设不上；进程 0 → 命令进不了作业，两条都变成不受限地跑）。
     * 新版沙箱把 0 当用法错误拒掉（退出码 2），但**不能假设对面是新的** ——
     * 老二进制会静默放行。所以这一层自己就不送 0：宁可宽，不可「无」。
     */
    const plan = planFor("echo x", { ...foundInfo, memoryMb: 0, processes: 0 });
    expect(plan.args.join(" "), "把 0 送出去了 —— 老沙箱上那是「没有上限」").not.toMatch(/--memory-mb 0|--processes 0/);
    expect(plan.args).toContain(String(SANDBOX_MEMORY_MB));
    expect(plan.args).toContain(String(SANDBOX_PROCESSES));

    const negative = planFor("echo x", foundInfo, { memoryMb: -1, processes: Number.NaN });
    expect(negative.args).toContain(String(SANDBOX_MEMORY_MB));
    expect(negative.args).toContain(String(SANDBOX_PROCESSES));
  });

  it.runIf(hasBinary)("⭐ probe 报的两个默认值与回落常量现在一致（漂了就看一眼）", () => {
    /*
     * 常量只是「沙箱没报时」的回落值，未必永远等于 Rust 的默认 —— 但**现在**一致，
     * 一旦不一致就值得看一眼：要么忘了跟 Rust 的默认，要么那一版沙箱根本不报这两个字段。
     * 这是 P122 那条「同一个默认值两处各写一遍必漂」的在线对账。
     */
    resetSandboxProbeCache();
    const info = probeSandbox({ refresh: true });
    expect(info.memoryMb).toBeGreaterThan(0);
    expect(info.processes).toBeGreaterThan(0);
    expect(
      SANDBOX_MEMORY_MB,
      `回落常量 ${SANDBOX_MEMORY_MB} 与沙箱报的 ${info.memoryMb} 不一致 —— 是忘了跟，还是它没报？`,
    ).toBe(info.memoryMb);
    expect(SANDBOX_PROCESSES, `回落常量与沙箱报的 ${info.processes} 不一致`).toBe(info.processes);
    /* 计划里用的就是它报的那份（这一条把「读到了却没用」也盖住） */
    expect(planFor("echo x", info).args).toContain(String(info.memoryMb));
  });

  it.runIf(hasBinary)("④ 真的能跑：命令经沙箱执行，输出一字不差", () => {
    const plan = planSandboxed("echo sandbox-roundtrip");
    const got = spawnSync(plan.file, plan.args, {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...plan.env },
      timeout: 60_000,
    });
    expect(got.status).toBe(0);
    expect(got.stdout ?? "").toContain("sandbox-roundtrip");
  });

  it.runIf(hasBinary)(
    "⑤ 内存上限真的生效：要 1GB 的命令在 128MB 上限下被杀",
    () => {
      const plan = planSandboxed(
        `node -e "const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(16*1024*1024))"`,
        { memoryMb: 128, processes: 8 },
      );
      const got = spawnSync(plan.file, plan.args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...plan.env },
        timeout: 120_000,
      });
      /*
       * 判据分两步（2026-10-16 修过一版假判据）：
       *
       * ① **真的没跑完**，而且**是"被拦住"那种没跑完** —— `stoppedByLimit` 要求
       *    要么有具体退出码、要么被信号带走。原来这里写的是 `status !== 0`，
       *    而**进程异常终止时 `status` 是 `null`**，`null !== 0` 也成立：
       *    二进制没找到、进程压根没起来，这条都会"通过"。
       * ② **看得出是内存那件事**：Node 自己在分配失败时会把原因写在 stderr
       *    （`Array buffer allocation failed` / `heap out of memory`）；
       *    作业对象直接杀进程那种没有 stderr，那就看**信号**。
       *    不断言具体文案 —— 那是 Node 的措辞，不是我们的契约；这里只要求"二者之一"。
       */
      const stderr = got.stderr ?? "";
      expect(
        stoppedByLimit(got),
        `128MB 上限下没跑成，但也不是"被拦住"：status=${String(got.status)} signal=${String(got.signal)} error=${String(got.error?.message)}（status=null 不算 —— 那不是上限生效，是异常终止）`,
      ).toBe(true);
      expect(
        got.signal !== null || /allocation failed|out of memory/i.test(stderr),
        `没跑成，但看不出是内存上限造成的（stderr：${stderr.slice(0, 120) || "（空）"}）`,
      ).toBe(true);
    },
    150_000,
  );

  it("⭐ 判据自证：`status === null`（进程异常终止）**不算**被上限拦住", () => {
    /*
     * 这条不用沙箱二进制（哪台机器都能跑）：它验的是**判据本身**。
     *
     * 拿一个根本不存在的可执行文件 spawn 一次 —— Node 给的正是
     * `status: null` + `error: ENOENT`，也就是「异常终止」那一档。
     * 老判据（`status !== 0`）在这里会**通过**，而它想说的明明是「内存上限生效了」。
     */
    const bogus = spawnSync("dh-no-such-binary-9f3a", [], { encoding: "utf8", shell: false });
    expect(bogus.status, "这条自证要靠 status===null 才有意义").toBeNull();
    expect(bogus.error, "起不来时 Node 会带上 error").toBeTruthy();
    expect(bogus.status !== 0, "老判据在这里就已经通过了 —— 这就是那条假判据").toBe(true);
    expect(stoppedByLimit(bogus), "新判据必须把「起不来」与「被上限拦住」分开").toBe(false);
  });

  it.runIf(hasBinary)(
    "⑥ 子进程数上限 + 不留孤儿：命令起的那堆子进程随沙箱一起收掉",
    () => {
      const plan = planSandboxed(
        [
          "node -e \"const {spawn}=require('child_process');",
          "for(let i=0;i<40;i++){try{const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)']);c.on('error',()=>{});}catch(e){break}}",
          "setTimeout(()=>process.exit(0),1200);\"",
        ].join(""),
        { memoryMb: 512, processes: 4 },
      );
      const got = spawnSync(plan.file, plan.args, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...plan.env },
        timeout: 120_000,
      });
      expect(got.status).toBe(0);

      /*
       * 沙箱退出后不该留下刚才那堆 `node -e setTimeout(…,60000)` 孤儿 ——
       * 这是 KILL_ON_JOB_CLOSE 那条在起作用（也是这个沙箱对用户最实在的好处）。
       * 「不留孤儿」的判据只能从**外面**看：数一下还有几个 node 是刚才这几秒起的。
       */
      /*
       * ⚠️ 判据必须**只数我们起的那批**：第一版按"最近 20 秒起的 node"数，
       * 结果把 vitest 自己的 worker 也算进去了（报了 5 个"孤儿"，其实一个都不是）——
       * 空的判据比没有判据更容易骗人。这里按**命令行里的特征串**认。
       */
      const probe = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.CommandLine -like '*setTimeout(()=>{},60000)*' }).Count",
        ],
        { encoding: "utf8" },
      );
      const left = Number((probe.stdout ?? "0").trim() || "0");
      expect(left, `沙箱退出后还留着 ${left} 个我们起的孤儿 node`).toBe(0);
    },
    150_000,
  );
});
