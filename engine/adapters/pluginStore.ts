import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { checkManifest, type PluginManifest, type PluginPermission, type PluginPublisher } from "../runtime/plugins";
import { verifyPluginSignature } from "../runtime/pluginSignature";
import { rememberPublisher } from "./pluginTrust";

/**
 * 插件的**安装台账**（Phase 8.2）。
 *
 * ## 台上记什么
 *
 * 装过哪些、从哪来、**用户批了哪几项权限**、现在开不开。这是一份**台账**，
 * 不是"插件目录的索引"：目录里有什么文件由插件自己决定，而"装过没有、
 * 批过什么"必须是**我们记的** —— 否则用户拒绝过的权限在下次启动时
 * 会"重新出现"（那等于用户的选择没生效）。
 *
 * ## 为什么落在数据目录而不是插件目录里
 *
 * 插件目录（`plugins/<name>/`）是插件的**内容**，可能被它自己写；
 * 台账是我们的**账**。两者放一起就会出现"插件把自己从台账里删掉"这种事。
 */

/** 一个已安装插件。 */
export type InstalledPlugin = {
  name: string;
  version: string;
  description: string;
  /** 它的目录（绝对路径）。 */
  dir: string;
  /** 装的时候从哪来（`dir:<路径>` / `npm:<包名>`），给排错用。 */
  source: string;
  /** 装的时间（epoch ms）。 */
  installedAt: number;
  /**
   * **用户批准时的那份清单快照**（Phase 8.2）。
   *
   * ⚠️ 这一条是"权限"这件事能不能立住的关键：如果装载时只读**磁盘上的**清单，
   * 那么插件装完之后改一改自己的清单（多加一个工具、多要一项权限），
   * 下次启动就会被当成"本来就批过的"。有了快照，装载时一比就知道"它被改过"。
   */
  manifest: PluginManifest;
  /** 清单里申请的权限（**如实存**，不因为用户拒了就抹掉）。 */
  permissions: readonly PluginPermission[];
  /** 用户**批准**的那一组（可以是 permissions 的子集）。 */
  granted: readonly PluginPermission[];
  /** 开着还是关着。装完默认开着（用户刚点过确认）。 */
  enabled: boolean;
  /**
   * **签名与发布者**（V5-4 4.4）。三态口径见 `pluginTrust.ts` 的表：
   * `unsigned`（v1 插件，没签）/ `unverified`（签名真、身份第一次见）/ `trusted`（同一把钥匙，见过）。
   *
   * ⚠️ 这一格是**装的时候算出来的事实**，不是界面文案 —— 它进台账，
   * 于是"这个插件是谁签的"在装完之后仍然答得上来。
   */
  signature: { trust: "unsigned" } | { publisher: PluginPublisher; trust: "unverified" | "trusted" };
};

/** 台账文件的形状。 */
export type PluginLedger = { installed: InstalledPlugin[] };

/** 数据目录里的插件树。 */
export type PluginPaths = {
  /** 插件内容目录。 */
  root: string;
  /** 台账文件。 */
  ledger: string;
};

/** 由数据目录算出路径（宿主给 `~/.ding` 或应用 userData）。 */
export function pluginPaths(dataDir: string): PluginPaths {
  const root = path.join(dataDir, "plugins");
  return { root, ledger: path.join(root, "plugins.json") };
}

/** 读台账（磁盘不可信：坏文件当空台账，并把原因报出来）。 */
export function readLedger(paths: PluginPaths): { ledger: PluginLedger; note?: string } {
  try {
    if (!existsSync(paths.ledger)) return { ledger: { installed: [] } };
    const raw = JSON.parse(readFileSync(paths.ledger, "utf8")) as unknown;
    const list = (raw as { installed?: unknown })?.installed;
    if (!Array.isArray(list)) return { ledger: { installed: [] }, note: "台账形状不对，已当空台账处理" };
    const installed: InstalledPlugin[] = [];
    for (const item of list) {
      const p = item as Partial<InstalledPlugin>;
      if (typeof p?.name !== "string" || typeof p?.dir !== "string") continue; // 坏条目丢掉，不拖垮整份台账
      installed.push({
        name: p.name,
        manifest: (p.manifest ?? {
          name: p.name,
          version: typeof p.version === "string" ? p.version : "0.0.0",
          description: typeof p.description === "string" ? p.description : "",
          permissions: Array.isArray(p.permissions) ? (p.permissions as PluginPermission[]) : [],
          engines: { ding: "*" },
        }) as PluginManifest,
        version: typeof p.version === "string" ? p.version : "0.0.0",
        description: typeof p.description === "string" ? p.description : "",
        dir: p.dir,
        source: typeof p.source === "string" ? p.source : "(未记录)",
        installedAt: typeof p.installedAt === "number" ? p.installedAt : 0,
        permissions: Array.isArray(p.permissions) ? (p.permissions as PluginPermission[]) : [],
        granted: Array.isArray(p.granted) ? (p.granted as PluginPermission[]) : [],
        enabled: p.enabled === true,
        /*
         * 签名状态读回来（v1 台账里没有这一格 → `unsigned`）：
         * 老条目一律当"没签名"，**不猜**它当年签过没有 —— 猜出来的"已签名"比没有更坏。
         */
        signature:
          p.signature && typeof p.signature === "object" && (p.signature as { publisher?: unknown }).publisher
            ? (p.signature as InstalledPlugin["signature"])
            : { trust: "unsigned" },
      });
    }
    return { ledger: { installed } };
  } catch (error) {
    return { ledger: { installed: [] }, note: `台账读不动（${error instanceof Error ? error.message : String(error)}），已当空台账处理` };
  }
}

/** 写台账（原子：先写临时文件再改名，避免写一半崩掉留下坏账）。 */
export function writeLedger(paths: PluginPaths, ledger: PluginLedger): void {
  mkdirSync(paths.root, { recursive: true });
  const tmp = `${paths.ledger}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  // rename 在 Windows 上覆盖已存在文件是允许的
  rmSync(paths.ledger, { force: true });
  cpSync(tmp, paths.ledger);
  rmSync(tmp, { force: true });
}

/** 一个目录里有没有插件清单（`ding-plugin.json` 优先，其次 `package.json` 的扩展字段）。 */
export function readManifestFromDir(dir: string): { raw?: unknown; file?: string; note?: string } {
  const dedicated = path.join(dir, "ding-plugin.json");
  if (existsSync(dedicated)) {
    try {
      return { raw: JSON.parse(readFileSync(dedicated, "utf8")), file: "ding-plugin.json" };
    } catch (error) {
      return { note: `ding-plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const pkg = path.join(dir, "package.json");
  if (existsSync(pkg)) {
    try {
      const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { ding?: unknown; dingPlugin?: unknown };
      // npm 渠道：清单放在 package.json 的扩展字段里（`ding` 或 `dingPlugin`）
      const raw = parsed.ding ?? parsed.dingPlugin;
      if (raw) return { raw, file: "package.json#ding" };
      return { note: "package.json 里没有 `ding` 扩展字段" };
    } catch (error) {
      return { note: `package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { note: "目录里既没有 ding-plugin.json，也没有带 `ding` 字段的 package.json" };
}

/** 安装/移除的结果。 */
export type InstallResult =
  | { ok: true; plugin: InstalledPlugin }
  | { ok: false; errors: string[] };

/**
 * **从一个目录装一个插件**（Phase 8.2 的本地渠道；也是 npm 渠道的最后一跳）。
 *
 * 流程：读清单 → 校验 → 拷贝内容 → 落台账。
 *
 * @param input.paths 插件路径
 * @param input.from 源目录
 * @param input.granted 用户批准的那一组权限（**不传 = 全部批准**；传了就是用户的选择）
 * @returns 安装结果
 */
export function installFromDir(input: {
  paths: PluginPaths;
  from: string;
  granted?: readonly PluginPermission[];
  now?: number;
}): InstallResult {
  const { paths, from } = input;
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    return { ok: false, errors: [`不是一个目录：${from}`] };
  }

  const got = readManifestFromDir(from);
  if (!got.raw) return { ok: false, errors: [got.note ?? "读不到清单"] };

  const checked = checkManifest(got.raw);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const manifest: PluginManifest = checked.manifest;

  /*
   * ⚠️ 入口文件必须在。**"装了但跑不起来"**比"装不上"坏得多 ——
   * 用户会以为装好了，直到某天它该起作用时才发现什么都没有。
   */
  const main = path.join(from, manifest.main ?? "index.mjs");
  if (!existsSync(main)) {
    return { ok: false, errors: [`入口文件不存在：${path.basename(main)}（清单可写 main 指定，默认 index.mjs）`] };
  }

  /*
   * ⭐ **签名（V5-4 4.4）：有签名就必须验得过。**
   *
   * 验的是**源目录的真文件**（不是清单里那些名字）—— 摘要逐文件算。验不过一律拒，
   * 而且**拒在拷贝之前**：装了再验，插件内容已经躺在插件目录里了
   * （"拒了但东西在"这种状态最容易被下一个 bug 捡起来用）。
   * 没签名（v1 插件）**照样装** —— 那是"没有签名"，不是"签名坏了"。
   */
  if (manifest.publisher && manifest.signature) {
    const verdict = verifyPluginSignature({
      dir: from,
      /* 原始清单（不是规范化过的那份）：签名是作者对他写下的字节做的 */
      rawManifest: got.raw,
      publisher: manifest.publisher,
      signature: manifest.signature,
    });
    if (!verdict.ok) return { ok: false, errors: [verdict.message] };
  }

  const target = path.join(paths.root, manifest.name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(from, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`) });

  /*
   * 签名状态（拷贝之后才登记信任）：`id → key` 第一次见就钉住（TOFU），
   * **换钥匙一律拒**（理由在 `pluginTrust.ts`）。钉之前先落内容，是为了
   * "装失败不留痕" —— 信任表只记真的装成了的那些。
   */
  let signature: InstalledPlugin["signature"] = { trust: "unsigned" };
  if (manifest.publisher) {
    const remembered = rememberPublisher(paths, manifest.publisher, input.now);
    if (!remembered.ok) {
      rmSync(target, { recursive: true, force: true });
      return { ok: false, errors: [remembered.message] };
    }
    signature = { publisher: manifest.publisher, trust: remembered.trust };
  }

  const granted = input.granted ? [...input.granted] : [...manifest.permissions];
  const plugin: InstalledPlugin = {
    name: manifest.name,
    manifest,
    version: manifest.version,
    description: manifest.description,
    dir: target,
    source: `dir:${from}`,
    installedAt: input.now ?? Date.now(),
    permissions: manifest.permissions,
    granted,
    enabled: true,
    signature,
  };

  const before = readLedger(paths);
  // 同名视作**升级**：台账里就地替换（不出现两条同名）
  const installed = [plugin, ...before.ledger.installed.filter((p) => p.name !== plugin.name)];
  writeLedger(paths, { installed });
  return { ok: true, plugin };
}

/**
 * 从**一个 .tgz** 装（npm 渠道的最后一跳，也是唯一可离线测的那一跳）。
 *
 * ⚠️ 这一跳单独拆出来，是因为"取包"（`npm pack`）要网络而"装包"不要。
 * 拆开之后：**安装逻辑（校验 + 落台账 + 权限判定）能在测试里真跑**，
 * 而网络那一层只是一层薄壳。不拆的话，整条 npm 渠道就永远测不到 ——
 * 而那正是"装上了但没起作用"最容易藏身的地方。
 *
 * @param input.paths 插件路径
 * @param input.tgz 一个 npm 包压缩包（`.tgz`）
 * @param input.granted 用户批准的那一组权限
 * @returns 安装结果
 */
export function installFromTarball(input: {
  paths: PluginPaths;
  tgz: string;
  granted?: readonly PluginPermission[];
  now?: number;
}): InstallResult {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-tgz-"));
  try {
    /*
     * 解包用系统 `tar`（Windows 10+ 自带 bsdtar）。不引 tar 依赖：
     * 我们只需要"解开一个 npm 包"，而多一个依赖就多一份供应链面。
     *
     * ⚠️ 先把包**拷进临时目录**，再用**相对文件名**解 —— 不能直接把绝对路径交给 tar：
     * GNU tar 会把 `C:\...` 里的 `C:` 当成**远程主机**，报
     * `Cannot connect to C: resolve failed`（实测）。拷一份是最省事的跨实现办法
     * （bsdtar 不在乎、GNU tar 也不在乎）。
     */
    const localTgz = path.join(tmp, "pkg.tgz");
    cpSync(input.tgz, localTgz);
    const res = spawnSync("tar", ["-xzf", "pkg.tgz", "-C", "."], { encoding: "utf8", cwd: tmp });
    if (res.error || res.status !== 0) {
      return { ok: false, errors: [`解包失败：${res.error?.message ?? res.stderr ?? `退出码 ${res.status}`}`] };
    }
    const pkgDir = path.join(tmp, "package");
    if (!existsSync(pkgDir)) return { ok: false, errors: ["压缩包里没有 package/ 目录（不是标准 npm 包？）"] };
    return installFromDir({
      paths: input.paths,
      from: pkgDir,
      ...(input.granted ? { granted: input.granted } : {}),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 取包（`npm pack`）到一个目录，返回 `.tgz` 的路径。
 *
 * 单独拆出来是为了 CLI 那套**两段式确认**：先取包、读出清单给用户看、
 * 用户点头之后才安装。合成一步的话，"权限确认"就只能发生在
 * **已经下载并解开**之后 —— 那不叫确认，那叫通知。
 *
 * @param spec 包名（可带 @版本）
 * @param dir 放 `.tgz` 的目录
 * @param timeoutMs 超时
 * @returns `.tgz` 路径或错误
 */
export function packNpm(spec: string, dir: string, timeoutMs = 120_000): { ok: true; tgz: string } | { ok: false; errors: string[] } {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npm, ["pack", spec, "--pack-destination", dir, "--silent"], {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
  });
  if (res.error) return { ok: false, errors: [`取包失败：${res.error.message}`] };
  if (res.status !== 0) {
    const why = (res.stderr || res.stdout || "").trim().slice(0, 300);
    return { ok: false, errors: [`取包失败（${spec}）：${why || `退出码 ${res.status}`}`] };
  }
  const tgz = readdirSync(dir).find((n) => n.endsWith(".tgz"));
  if (!tgz) return { ok: false, errors: ["npm pack 没有产出 .tgz"] };
  return { ok: true, tgz: path.join(dir, tgz) };
}

/**
 * 从一个 `.tgz` 里**只读清单**（不安装）。
 *
 * CLI 的两段式确认靠它：先把"它要什么权限"给用户看，再决定装不装。
 *
 * @param tgz 包路径
 * @returns 清单原文或错误
 */
export function readManifestFromTarball(tgz: string): { raw?: unknown; note?: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "dh-plugin-peek-"));
  try {
    const localTgz = path.join(tmp, "pkg.tgz");
    cpSync(tgz, localTgz);
    const res = spawnSync("tar", ["-xzf", "pkg.tgz", "-C", "."], { encoding: "utf8", cwd: tmp });
    if (res.status !== 0) return { note: `解包失败：${res.stderr ?? res.status}` };
    return readManifestFromDir(path.join(tmp, "package"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 临时目录（CLI 取包用）。 */
export function makePackDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "dh-plugin-pack-"));
}

/**
 * 从 **npm 包**装（`npm:包名` 或 `npm:包名@版本`）。
 *
 * ⚠️ 这一步**要网络**，而且是 v1 里唯一会联网的安装路径。
 * 它只做三件事：取包（`npm pack`）→ 交给 `installFromTarball` → 报结果。
 * 校验、权限判定、落台账**都不在这里**（那部分在可离线测的那一跳里）。
 *
 * @param input.paths 插件路径
 * @param input.spec 包名（可带 @版本）
 * @param input.granted 用户批准的那一组权限
 * @param input.timeoutMs 取包超时
 * @returns 安装结果
 */
export function installFromNpm(input: {
  paths: PluginPaths;
  spec: string;
  granted?: readonly PluginPermission[];
  timeoutMs?: number;
}): InstallResult {
  const tmp = makePackDir();
  try {
    const packed = packNpm(input.spec, tmp, input.timeoutMs);
    if (!packed.ok) return { ok: false, errors: packed.errors };
    return installFromTarball({
      paths: input.paths,
      tgz: packed.tgz,
      ...(input.granted ? { granted: input.granted } : {}),
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 卸载：**删台账 + 删它拷进来的那份内容**。
 *
 * ⚠️ 只删 `plugins/<name>/`（我们自己拷进去的那份），**不删**用户给的源目录 ——
 * 那是他的东西，插件可能是从那儿开发出来的。
 *
 * @param paths 插件路径
 * @param name 插件名
 * @returns 有没有删掉
 */
export function uninstall(paths: PluginPaths, name: string): { ok: boolean; note?: string } {
  const before = readLedger(paths);
  const found = before.ledger.installed.find((p) => p.name === name);
  if (!found) return { ok: false, note: `没有装过叫 ${name} 的插件` };

  /*
   * 删内容时**只删我们记下的那个目录**，而且要求它在插件根之下 ——
   * 台账是磁盘来的（可能被手改过），照着它删任意路径是危险的。
   */
  const resolved = path.resolve(found.dir);
  const root = path.resolve(paths.root);
  if (resolved.startsWith(root + path.sep) && existsSync(resolved)) {
    rmSync(resolved, { recursive: true, force: true });
  }
  writeLedger(paths, { installed: before.ledger.installed.filter((p) => p.name !== name) });
  return { ok: true };
}

/** 开/关一个插件（关 = 不装载它的工具与钩子，但**留着台账**）。 */
export function setEnabled(paths: PluginPaths, name: string, enabled: boolean): { ok: boolean; note?: string } {
  const before = readLedger(paths);
  if (!before.ledger.installed.some((p) => p.name === name)) return { ok: false, note: `没有装过叫 ${name} 的插件` };
  writeLedger(paths, {
    installed: before.ledger.installed.map((p) => (p.name === name ? { ...p, enabled } : p)),
  });
  return { ok: true };
}

/**
 * 修一次台账：把**目录已经不在了**的插件标成"坏了"（而不是删掉）。
 *
 * ⚠️ 不删：用户可能只是把盘拿掉了（U 盘、网络盘）。删台账等于**抹掉他的决定**
 * （他批过哪些权限记在那一条里）。标出来让他自己处置。
 *
 * @param paths 插件路径
 * @returns 有几个插件的目录不在了
 */
export function auditLedger(paths: PluginPaths): { missing: string[] } {
  const { ledger } = readLedger(paths);
  const missing = ledger.installed.filter((p) => !existsSync(p.dir)).map((p) => p.name);
  return { missing };
}

/**
 * 装载前比对"磁盘上的清单"与"用户批准的那份"。
 *
 * ⚠️ 这是**权限声明能不能立住**的地方。插件装完之后改自己的清单
 * （多加一个工具、多要一项权限），如果装载时只读磁盘，那次改动会被当成
 * "本来就批过的" —— 等于插件的权限可以自己长大。
 *
 * 判据只比**与授权有关的字段**（permissions / tools / hooks / name）：
 * version 与 description 变了不算越权（那种改动不该打断用户）。
 *
 * @param approved 台账里那份（用户批准时的快照）
 * @param current 磁盘上那份（已校验）
 * @returns 有没有越界；越界时给人话
 */
export function manifestDrifted(approved: PluginManifest, current: PluginManifest): string | null {
  if (approved.name !== current.name) return `插件名变了：${approved.name} → ${current.name}`;
  const same = (a?: readonly string[], b?: readonly string[]) => [...(a ?? [])].sort().join(",") === [...(b ?? [])].sort().join(",");
  if (!same(approved.permissions, current.permissions)) {
    return `权限清单变了（装的时候是 ${approved.permissions.join(" / ") || "无"}，现在是 ${current.permissions.join(" / ") || "无"}）`;
  }
  if (!same(approved.tools, current.tools)) return "它声明的工具变了";
  if (!same(approved.hooks, current.hooks)) return "它声明的钩子变了";
  return null;
}

/** 列目录下有哪些 `.mjs`（给人看的"这个插件带了哪些文件"，排错用）。 */
export function listPluginFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".mjs") || n.endsWith(".js"));
  } catch {
    return [];
  }
}
