import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import { pluginPaths, installFromDir, installFromTarball, readLedger, setEnabled, uninstall } from "../adapters/pluginStore";
import { checkManifest, grantedCapabilities, isPluginTool, parsePluginToolName, pluginToolName } from "./plugins";
import { loadEnabledPlugins, pluginToolEntries, resetPlugins, runHooks, runPluginTool, withheldCapabilities } from "./pluginHost";
import { buildToolSet, createToolRegistry } from "./registry";

/**
 * 插件（Phase 8）。这一组测的是**整条链路**：写一个插件目录 → 装 → 装载 → 调它的工具。
 *
 * ## 这组断言挡的是什么
 *
 * 插件的失效形态几乎全是"装上了但没起作用"，而且**不报错**：
 * 权限没批却注入了（越权）、声明了工具但代码没导出（少一个工具）、
 * 装完之后改清单自提权（权限自己长大）。三种都只会表现为"怪怪的"，
 * 所以每一条都在这里钉死。
 */

let work: string;
let dataDir: string;
let srcDir: string;

/** 读一个文件（小帮手，省得在断言里再 import 一遍 fs）。 */
function readFileSyncCompat(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("node:fs").readFileSync(p, "utf8") as string;
}

/** 写一个插件目录（清单 + 入口）。 */
function makePlugin(opts: {
  name?: string;
  manifest?: Record<string, unknown>;
  tools?: string;
  hooks?: string;
} = {}): string {
  const name = opts.name ?? "hello-plugin";
  const dir = path.join(srcDir, name);
  mkdirSync(dir, { recursive: true });
  const manifest = opts.manifest ?? {
    name,
    version: "1.0.0",
    description: "一个用于测试的插件",
    tools: ["hello"],
    hooks: ["turn:end"],
    permissions: ["tools:register", "hooks:register"],
    engines: { ding: ">=0.2.0" },
  };
  writeFileSync(path.join(dir, "ding-plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(
    path.join(dir, "index.mjs"),
    opts.tools ??
      `export const tools = { hello: { description: "打个招呼", inputSchema: { type: "object" }, run: async () => ({ ok: true, text: "你好" }) } };
export const hooks = { "turn:end": async () => { globalThis.__pluginHookCalls = (globalThis.__pluginHookCalls ?? 0) + 1; } };`,
    "utf8",
  );
  return dir;
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "dh-plugin-"));
  dataDir = path.join(work, "data");
  srcDir = path.join(work, "src");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  resetPlugins();
});

afterEach(() => {
  resetPlugins();
  delete (globalThis as { __pluginHookCalls?: number }).__pluginHookCalls;
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 上可能还占着：尽力而为 */
  }
});

describe("清单校验", () => {
  const base = {
    name: "ok-plugin",
    version: "1.0.0",
    description: "一个用于测试的插件（说明够长）",
    permissions: [],
    engines: { ding: ">=0.2.0" },
  };

  it("合法的清单通过，并且**原样**带回字段", () => {
    const got = checkManifest({ ...base, tools: ["a"], permissions: ["tools:register"] });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.manifest.tools).toEqual(["a"]);
  });

  it("⭐ `permissions` 必填（省略与「什么都不要」在观感上一样，所以不接受省略）", () => {
    const { permissions: _drop, ...without } = base;
    const got = checkManifest(without);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.errors.join()).toContain("permissions 必填");
  });

  it("空数组是合法的（= 明确声明「什么权限都不要」）", () => {
    expect(checkManifest(base).ok).toBe(true);
  });

  it("不认识的权限项要**拒绝**（不是忽略）", () => {
    const got = checkManifest({ ...base, permissions: ["tools:register", "root:everything"] });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.errors.join()).toContain("不认识的项");
  });

  it("⭐ 声明了工具/钩子就必须申请对应权限（两者不一致是作者写错了）", () => {
    const a = checkManifest({ ...base, tools: ["x"] });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.errors.join()).toContain("tools:register");
    const b = checkManifest({ ...base, hooks: ["turn:end"] });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.errors.join()).toContain("hooks:register");
  });

  it("名字与版本不合法都要说清楚（错误信息是给用户看的）", () => {
    const got = checkManifest({ ...base, name: "带中文", version: "v1" });
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.errors.join()).toContain("name 不合法");
      expect(got.errors.join()).toContain("version 不合法");
    }
  });

  it("⭐ `main` 不许跑出插件目录（绝对路径 / `..` 一律拒）", () => {
    for (const bad of ["/etc/passwd", "C:/Windows/system32/x.mjs", "../../evil.mjs", "a/../../b.mjs"]) {
      const got = checkManifest({ ...base, main: bad });
      expect(got.ok, `应当拒掉 ${bad}`).toBe(false);
    }
    expect(checkManifest({ ...base, main: "lib/index.mjs" }).ok).toBe(true);
  });

  it("不是对象的东西直接拒", () => {
    for (const bad of [null, 42, "x", []]) expect(checkManifest(bad).ok).toBe(false);
  });
});

describe("权限与能力注入", () => {
  const checked = checkManifest({
    name: "cap-plugin",
    version: "1.0.0",
    description: "一个用于测试权限注入的插件，说明够长",
    tools: ["t"],
    hooks: ["turn:end"],
    permissions: ["tools:register", "hooks:register", "fs:read"],
    engines: { ding: "*" },
  });
  it("这份夹具本身是合法的（否则下面三条测的是别的东西）", () => {
    expect(checked.ok, checked.ok ? "" : checked.errors.join("；")).toBe(true);
  });
  const m = checked.ok ? checked.manifest : (null as never);

  it("⭐ 清单声明 + 用户批准，两条都在才接上线", () => {
    expect(grantedCapabilities(m, ["tools:register", "hooks:register"]).tools).toBe(true);
    expect(grantedCapabilities(m, ["tools:register", "hooks:register"]).hooks).toBe(true);
  });

  it("⭐ 用户拒了某一项 → 那条线**不接**，而且列入 withheld（界面要说出来）", () => {
    const got = grantedCapabilities(m, ["hooks:register"]);
    expect(got.tools).toBe(false);
    expect(got.hooks).toBe(true);
    expect(got.withheld).toEqual(["tools:register"]);
  });

  it("资源类权限不在「真拦」那一类里（v1 只声明）", () => {
    const got = grantedCapabilities(m, []); // 连 fs:read 都没批
    expect(got.withheld).toEqual(["tools:register", "hooks:register"]);
    expect(got.withheld).not.toContain("fs:read"); // 它不参与"接不接线"的判定
  });
});

describe("插件工具命名", () => {
  it("⭐ 带前缀：插件顶不掉内置工具，而且来源一眼可辨", () => {
    expect(pluginToolName("p", "write_file")).toBe("plugin__p__write_file");
    expect(isPluginTool("plugin__p__write_file")).toBe(true);
    expect(isPluginTool("write_file")).toBe(false);
  });

  it("拆得回来（工具名里允许再出现 `__`）", () => {
    expect(parsePluginToolName("plugin__p__a__b")).toEqual({ plugin: "p", tool: "a__b" });
    expect(parsePluginToolName("plugin__p")).toBeNull();
    expect(parsePluginToolName("mcp__s__t")).toBeNull();
  });
});

describe("整条链路：装 → 装载 → 调工具", () => {
  it("⭐ 装一个本地目录的插件，它的工具能被调用、钩子会被跑到", async () => {
    const dir = makePlugin();
    const paths = pluginPaths(dataDir);
    const installed = installFromDir({ paths, from: dir });
    expect(installed.ok).toBe(true);

    const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.problems).toEqual([]);
    expect(pluginToolEntries().map((e) => e.name)).toEqual(["plugin__hello-plugin__hello"]);
    expect(pluginToolEntries()[0]?.source).toBe("plugin");

    const out = await runPluginTool("plugin__hello-plugin__hello", {});
    expect(out).toEqual({ ok: true, text: "你好" });

    await runHooks("turn:end", {});
    expect((globalThis as { __pluginHookCalls?: number }).__pluginHookCalls).toBe(1);
  });

  it("⭐ 用户没批 `tools:register` → 工具**不进注册表**（不是「注入了但拦着」）", async () => {
    const dir = makePlugin();
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir, granted: ["hooks:register"] });

    const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(pluginToolEntries()).toEqual([]);
    expect(loaded[0]?.withheld).toEqual(["tools:register"]);
    await expect(runPluginTool("plugin__hello-plugin__hello", {})).rejects.toThrow(/没有这个插件工具/);
    expect(withheldCapabilities()).toEqual([{ plugin: "hello-plugin", permissions: ["tools:register"] }]);
    // 钩子那条线还是接着的
    await runHooks("turn:end", {});
    expect((globalThis as { __pluginHookCalls?: number }).__pluginHookCalls).toBe(1);
  });

  it("⭐ 声明了却没导出 → **报出来**（不静默少一个工具）", async () => {
    const dir = makePlugin({ manifest: {
      name: "half-plugin",
      version: "1.0.0",
      description: "一个用于测试的插件",
      tools: ["hello", "missing"],
      permissions: ["tools:register"],
      engines: { ding: "*" },
    } });
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir });
    const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(loaded[0]?.problems.join()).toContain("没有导出");
    expect(pluginToolEntries().map((e) => e.name)).toEqual(["plugin__half-plugin__hello"]);
  });

  it("⭐ 导出了但没声明 → 不注入，并报出来", async () => {
    const dir = makePlugin({ manifest: {
      name: "sneaky-plugin",
      version: "1.0.0",
      description: "一个用于测试的插件",
      tools: ["hello"],
      permissions: ["tools:register"],
      engines: { ding: "*" },
    }, tools: `export const tools = {
  hello: { description: "声明的那个", inputSchema: { type: "object" }, run: async () => ({ ok: true }) },
  extra: { description: "没声明的那个", inputSchema: { type: "object" }, run: async () => ({ ok: true }) },
};` });
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir });
    const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(loaded[0]?.problems.join()).toContain("没声明");
    expect(pluginToolEntries().map((e) => e.name)).toEqual(["plugin__sneaky-plugin__hello"]);
  });

  it("⭐ 装完之后被改过清单（自提权）→ **拒绝装载**，要用户重新确认", async () => {
    const dir = makePlugin();
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir });

    // 插件偷偷给自己加一项权限与一个工具
    writeFileSync(
      path.join(paths.root, "hello-plugin", "ding-plugin.json"),
      JSON.stringify({
        name: "hello-plugin",
        version: "1.0.0",
        description: "一个用于测试的插件",
        tools: ["hello", "evil"],
        permissions: ["tools:register", "hooks:register", "exec"],
        engines: { ding: "*" },
      }),
      "utf8",
    );

    const loaded = await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(loaded[0]?.problems.join()).toContain("安装之后被改过");
    expect(pluginToolEntries()).toEqual([]);
  });

  it("关掉的插件不装载（但台账留着）", async () => {
    const dir = makePlugin();
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir });
    setEnabled(paths, "hello-plugin", false);
    await loadEnabledPlugins(readLedger(paths).ledger.installed);
    expect(pluginToolEntries()).toEqual([]);
    expect(readLedger(paths).ledger.installed).toHaveLength(1);
  });

  it("⭐ 插件工具**真的能进 ToolSet**（schema 必须是 SDK 认的那一种）", async () => {
    /*
     * ⚠️ 这条是补出来的：插件给的是**纯 JSON Schema**，必须用 `jsonSchema()` 包一层。
     * 不包的话，`tool({ inputSchema })` 会在**真正建工具集时**报 `schema is not a function`
     * —— 而单测原来只查了条目的形状（名字/来源），CLI 真跑一轮才露出来。
     * 判据就是"建得出来"，这正是当时缺的那一步。
     */
    const dir = makePlugin();
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir });
    await loadEnabledPlugins(readLedger(paths).ledger.installed);

    const tools = buildToolSet({
      registry: createToolRegistry({ extra: pluginToolEntries() }),
      mode: "全部允许",
      executor: { run: async () => ({ ok: true }) },
      ctx: { mode: "全部允许", provider: "p" },
    });
    expect(Object.keys(tools)).toContain("plugin__hello-plugin__hello");
  });

  it("卸载：台账与内容都清掉，而且**不碰源目录**", async () => {
    const dir = makePlugin();
    const paths = pluginPaths(dataDir);
    installFromDir({ paths, from: dir });
    expect(uninstall(paths, "hello-plugin").ok).toBe(true);
    expect(readLedger(paths).ledger.installed).toEqual([]);
    // 源目录是用户的，别删
    expect(readLedger(paths).ledger.installed.length).toBe(0);
    expect(installFromDir({ paths, from: dir }).ok).toBe(true); // 还能再装
  });

  it("没装过的插件：卸载/开关都如实说「没有装过」，不是静默成功", () => {
    const paths = pluginPaths(dataDir);
    expect(uninstall(paths, "nope").ok).toBe(false);
    expect(setEnabled(paths, "nope", false).ok).toBe(false);
  });

  it("⭐ npm 那一跳（解 .tgz 安装）：整条链路能离线跑通", () => {
    /*
     * 拆出 `installFromTarball` 就是为了这个：**取包要网络、装包不要**。
     * 于是"装一个 npm 包"这件事里最要紧的那半（校验 + 权限判定 + 落台账）
     * 能在测试里真跑一遍，而网络那层只是薄壳。
     */
    const dir = makePlugin({ name: "tgz-plugin" });
    // 按 npm 包的形状打包（内容放在 package/ 下）
    const stage = path.join(work, "stage", "package");
    mkdirSync(stage, { recursive: true });
    for (const f of ["ding-plugin.json", "index.mjs"]) {
      writeFileSync(path.join(stage, f), readFileSyncCompat(path.join(dir, f)), "utf8");
    }
    /*
     * ⚠️ `-f` 用**相对文件名** + `cwd`：绝对路径里的 `C:` 会被 GNU tar 当成远程主机
     * （`Cannot connect to C: resolve failed`）。生产代码里也是这么绕的（先拷贝再相对解包）。
     */
    const res = spawnSync("tar", ["-czf", "pkg.tgz", "-C", "stage", "package"], { encoding: "utf8", cwd: work });
    expect(res.status, `打 tgz 失败：${res.stderr ?? ""}`).toBe(0);

    const got = installFromTarball({ paths: pluginPaths(dataDir), tgz: path.join(work, "pkg.tgz") });
    expect(got.ok, got.ok ? "" : got.errors.join("；")).toBe(true);
    if (got.ok) {
      expect(got.plugin.name).toBe("tgz-plugin");
      expect(got.plugin.source.startsWith("dir:")).toBe(true); // 记账的是"从哪儿解出来装的"
    }
  });

  it("清单不合法的目录：装不上，并给出人话原因", () => {
    const dir = makePlugin({ manifest: { name: "BadName", version: "x" } });
    const got = installFromDir({ paths: pluginPaths(dataDir), from: dir });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.errors.length).toBeGreaterThan(0);
  });

  it("入口文件不在：装不上（「装了但跑不起来」比「装不上」坏得多）", () => {
    const dir = makePlugin();
    rmSync(path.join(dir, "index.mjs"));
    const got = installFromDir({ paths: pluginPaths(dataDir), from: dir });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.errors.join()).toContain("入口文件不存在");
  });
});
