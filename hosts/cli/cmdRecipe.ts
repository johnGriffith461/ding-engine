import { resolveSecret } from "../../engine/runtime/credentials";
import fs from "node:fs";
import path from "node:path";

import { BUILTIN_RECIPES, mergeRecipes, recipeToJson, resolveRecipeMode, validateRecipe, type Recipe } from "../../engine/core/recipes";
import { firstAvailableProvider } from "../../engine/runtime/providers";
import { normalizeConfirmMode } from "../../shared/ipc";
import { flag, flagAll, type Parsed } from "./args";
import { buildEngine } from "./assembly";
import { resolveJsonOutputPath } from "./cmdBackup";
import { effectiveConfig } from "./config";
import { renderRecords } from "./renderRecords";

/**
 * `ding recipe` —— 任务模板（Phase 18）。
 *
 * ```
 * ding recipe list                      # 内置 + 你自己导入的
 * ding recipe show <id>                 # 看它到底会说什么、用什么工具
 * ding recipe run <id>                  # 直接跑（可加 --dir）
 * ding recipe export <id> [--out 文件]  # 导出成可分享的 JSON
 * ding recipe import <文件>             # 导入（**会校验**：工具名/档位对不上就报错）
 * ```
 *
 * ## 为什么导入要校验得这么严
 *
 * Recipe **不含可执行代码**（只是"一句话 + 一点偏好"），所以它本身不危险。
 * 危险的是**静默忽略**：工具名写错了却照跑，用户会以为"按模板跑的"，
 * 而实际工具范围根本不是模板想要的那个。所以这里宁可报错。
 */

/** 自己的 templates 存哪（`~/.ding/recipes.json`）。 */
function recipesFile(dataDir: string): string {
  return path.join(dataDir, "recipes.json");
}

/**
 * 落盘的信封版本（2026-10-16，审计 P138）。
 *
 * ⚠️ 原来这里直接 `JSON.stringify(recipes)`（裸数组）：没有版本、没有原子写，
 * 而且**读坏就静默当"没有模板"**。加一个 `version` 之后，将来形状变了能认出来
 * 而不是当"空"（"空"与"读不动"是两件事，见 `readImported` 的返回）。
 */
const RECIPES_FILE_VERSION = 1;

/** 剥掉终端控制字符（2026-10-16，审计 P148）。 */
function safeText(text: string): string {
  // 模板 JSON 来自**外部**：title/description 里带 \x1b 就能改窗口标题、伪造提示行
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/[\r\n]+/g, " ");
}

/**
 * 读用户导入的那些（磁盘不可信）。
 *
 * ⚠️ 返回里**分开**三种情况（2026-10-16，审计 P216）：
 *   · `recipes` 读出来了、`skipped` 有几条没过校验；
 *   · `corrupt`：**整份读不动**（截断/非数组/不是 JSON）。
 * 原来把最后一种也返回成 `{recipes: [], skipped: 0}` —— 于是"文件坏了、模板全没了"
 * 与"你还没导入过"在界面上长得一模一样，`list` 一句都不说。
 * 文件头写着"坏的丢掉并**说清**"，说清的只有逐条那一半。
 */
function readImported(dataDir: string): { recipes: Recipe[]; skipped: number; corrupt?: string } {
  const file = recipesFile(dataDir);
  if (!fs.existsSync(file)) return { recipes: [], skipped: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    return { recipes: [], skipped: 0, corrupt: `recipes.json 不是合法 JSON（${(error as Error).message.slice(0, 80)}）` };
  }
  /*
   * 两种形状都认：新的信封 `{version, recipes}` 与老的裸数组（用户手写的、旧版留下的）。
   * ⚠️ **只认其中一种**会让升级变成"我导入的模板不见了"——所以两种都认。
   */
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { recipes?: unknown })?.recipes) ? (raw as { recipes: unknown[] }).recipes : null;
  if (list === null) {
    return { recipes: [], skipped: 0, corrupt: "recipes.json 的形状不对（既不是数组，也不是 {recipes:[…]}）" };
  }
  const recipes: Recipe[] = [];
  let skipped = 0;
  for (const item of list) {
    const got = validateRecipe(item);
    if (got.ok) recipes.push(got.recipe);
    else skipped += 1;
  }
  return { recipes, skipped };
}

/**
 * 写回（**原子写 + 信封**，2026-10-16，审计 P138）。
 *
 * 直接 `writeFileSync` 覆盖有两个后果：写到一半崩掉 → 整份模板没了；
 * 而它又**不进备份**（12.1 之后配置型数据都在 stores.db）。先写 `.tmp` 再改名，
 * 至少保证"要么旧的、要么新的"，不会出现半份。
 */
function writeImported(dataDir: string, recipes: readonly Recipe[]): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = recipesFile(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: RECIPES_FILE_VERSION, recipes }, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 算出这次运行**真正授权**的目录（2026-10-16，审计 P137）。
 *
 * 优先级与原来一致（`--dir` > 模板的 `dirs` > 配置 > 当前目录），变的是：
 * 逐条 `resolve` 成绝对路径、**校验它确实存在且是目录**（不存在的当场点名），
 * 并且调用方会把结果**打出来** —— 模板的 `dirs` 是外部 JSON 来的，
 * "它替我授权了哪些目录"必须在我按下运行之前看得见。
 *
 * @param p 解析好的命令行（要读 `--dir`）
 * @param recipe 模板（可能带着外部来的 `dirs`）
 * @param config 本机配置
 * @returns 生效的授权目录（绝对路径，去重；不存在的已被剔除并报出）
 */
function resolveRecipeDirs(p: Parsed, recipe: Recipe, config: { dirs?: readonly string[] }): string[] {
  const raw = flagAll(p, "dir").length ? flagAll(p, "dir") : recipe.dirs?.length ? recipe.dirs : (config.dirs ?? [process.cwd()]);
  const out: string[] = [];
  for (const item of raw) {
    const resolved = path.resolve(String(item));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      process.stderr.write(`⚠️ 忽略一个不存在的授权目录：${resolved}（来自${flagAll(p, "dir").length ? "命令行" : "模板/配置"}）\n`);
      continue;
    }
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * 这台机器上的模板清单（内置 + 导入的合并）——**给服务端注入**（V5-3 3.7 的模板共享）。
 *
 * ⚠️ 与 `cmdRecipe list` 是同一条数据路：**只是没有终端输出那一半** ——
 * 另写一份读法就会出现"服务端共享的模板与 `ding recipe list` 看到的不是一批"。
 *
 * @param dataDir 数据目录
 * @returns 模板清单（坏的条目按 `readImported` 的口径跳过）
 */
export async function listRecipes(dataDir: string): Promise<Recipe[]> {
  return mergeRecipes(readImported(dataDir).recipes);
}

export async function cmdRecipe(p: Parsed, dataDir: string): Promise<number> {
  const sub = p.args[0] ?? "list";
  const id = p.args[1];
  const imported = readImported(dataDir);
  const all = mergeRecipes(imported.recipes);

  if (sub === "list") {
    if (p.flags.has("json")) {
      /* `--json` 也要带上磁盘那份的问题：否则脚本看到的与终端看到的不是一件事 */
      process.stdout.write(
        JSON.stringify(
          { recipes: all, ...(imported.skipped ? { skipped: imported.skipped } : {}), ...(imported.corrupt ? { corrupt: imported.corrupt } : {}) },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    process.stdout.write(`任务模板（${all.length} 份；内置 ${BUILTIN_RECIPES.length} 份）：\n\n`);
    for (const r of all) {
      const mine = imported.recipes.some((x) => x.id === r.id) ? "（你自己的）" : "";
      process.stdout.write(`  ${r.id}${mine}\n    ${safeText(r.title)} —— ${safeText(r.description)}\n`);
    }
    if (imported.skipped) process.stdout.write(`\n（有 ${imported.skipped} 份存在磁盘上但校验没过，已忽略）\n`);
    /* ⭐ 整份坏掉**必须说**（审计 P216）：不说的话用户看到的就是"我的模板全没了" */
    if (imported.corrupt) {
      process.stderr.write(`\n⚠️ ${imported.corrupt}\n（你导入过的模板读不出来。修好 ${recipesFile(dataDir)} 再试；里面那一份换个名字留着，别让下一次写盘盖掉它）\n`);
    }
    process.stdout.write(`\n看一份：ding recipe show <id>　　直接跑：ding recipe run <id>\n`);
    return 0;
  }

  if (sub === "show" || sub === "run" || sub === "export") {
    if (!id) {
      process.stderr.write(`用法：ding recipe ${sub} <id>\n`);
      return 2;
    }
    const recipe = all.find((r) => r.id === id);
    if (!recipe) {
      process.stderr.write(`没有这份模板：${id}（ding recipe list 看全部）\n`);
      return 2;
    }

    if (sub === "show") {
      process.stdout.write(
        [
          `${safeText(recipe.title)}  [${recipe.id}]`,
          safeText(recipe.description),
          "",
          "会发出去的提示词：",
          safeText(recipe.prompt),
          "",
          `工具范围：${recipe.tools?.length ? recipe.tools.join(" / ") : "（默认全套）"}`,
          `授权目录：${recipe.dirs?.length ? recipe.dirs.map((d) => path.resolve(d)).join(" / ") : "（用你当前配置/ --dir）"}`,
          `建议档位：${recipe.mode ?? "（用你当前的）"}`,
          "",
        ].join("\n"),
      );
      return 0;
    }

    if (sub === "export") {
      /*
       * ⚠️ 输出路径要与 `ding backup --out` 守**同一条规矩**（审计 P124 / P214）：
       * 这里原来也是"`flag(p,"out")` 之后原样 `writeFileSync`"——`recipe export --out
       * ~/.ding/config.json` 会用模板 JSON 盖掉用户配置。共用 `resolveJsonOutputPath`。
       */
      const target = resolveJsonOutputPath(flag(p, "out"), dataDir, {
        defaultName: `${recipe.id}.recipe.json`,
        force: p.flags.has("force"),
      });
      if (!target.ok) {
        process.stderr.write(`${target.message}\n`);
        return 2;
      }
      fs.writeFileSync(target.file, recipeToJson(recipe), "utf8");
      process.stdout.write(`已导出：${target.file}\n（它是个 JSON，可以贴进聊天或 gist 分享）\n`);
      return 0;
    }

    /* run：真的跑一轮 */
    const { config } = effectiveConfig(dataDir);
    const mode = resolveRecipeMode(normalizeConfirmMode(flag(p, "mode") ?? config.mode ?? "按需确认"), recipe);
    /*
     * ⚠️ 档位只会**更严**（`resolveRecipeMode`）：模板不能把"每步确认"降成"全部允许" ——
     * 那等于模板能替你放开权限。
     */
    if (recipe.mode && mode !== recipe.mode) {
      process.stdout.write(`（模板建议「${recipe.mode}」，但你当前是「${config.mode ?? "按需确认"}」—— 按更严的那个走）\n`);
    }
    /*
     * ⭐ 模板的 `dirs` 来自**外部 JSON**（审计 P137）。
     *
     * 原来它**原样**成为工具授权根：不 `resolve`、不校验、运行时不显示 ——
     * 也就是说"贴一份模板进来"就能替你授权一批目录，而你在运行前看不到。
     * 现在：逐条 `resolve` 成绝对路径、**校验它确实是个目录**（不存在的当场说），
     * 并把最终生效的那批**打出来**（"授权了什么"这件事必须可见）。
     */
    const dirs = resolveRecipeDirs(p, recipe, config);
    if (!dirs.length) {
      process.stderr.write("没有可用的授权目录（模板里的 dirs 一个都不存在，也没给 --dir）\n");
      return 2;
    }
    process.stdout.write(`授权目录：${dirs.join(" / ")}\n`);
    const built = await buildEngine(dirs, dataDir);
    try {
      process.stdout.write(`跑「${safeText(recipe.title)}」…\n\n`);
      const outcome = await built.engine.run({
        sessionId: `recipe-${Date.now().toString(36)}`,
        /* provider 回落与 `ding run` / REPL 同一口径（审计 P208）：只有环境变量 key 时也能跑 */
        provider: flag(p, "provider") ?? config.provider ?? firstAvailableProvider(resolveSecret)?.id ?? "",
        ...((flag(p, "model") ?? config.model) ? { model: flag(p, "model") ?? config.model } : {}),
        messages: [{ role: "user", content: recipe.prompt }],
        mode,
        useTools: true,
        /*
         * ⭐ 模板声明的 `tools` **真的接上**（审计 P126）。
         *
         * 在此之前它只出现在 `recipe show` 的文案里，`engine.run` 的入参里没有它 ——
         * `show` 说"工具范围：read_file / write_file"，实际下发的却是全套。
         * 这就是"第二层防护"沦为自述的那条。省略 = 不限制（模板没声明时行为不变）。
         */
        ...(recipe.tools?.length ? { only: recipe.tools } : {}),
        maxSteps: 8,
      });
      if (!outcome.ok) {
        process.stderr.write(`没跑成：${outcome.error ?? "（没有错误信息）"}\n`);
        return 1;
      }
      /* 结果走宿主自己的渲染（与 `ding run` 同一份投影口径） */
      process.stdout.write(renderRecords(outcome.records));
      return 0;
    } finally {
      built.close();
    }
  }

  if (sub === "import") {
    if (!id) {
      process.stderr.write("用法：ding recipe import <文件>\n");
      return 2;
    }
    const file = path.resolve(id);
    if (!fs.existsSync(file)) {
      process.stderr.write(`找不到文件：${file}\n`);
      return 2;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      process.stderr.write(`不是合法 JSON（${(error as Error).message.slice(0, 80)}）\n`);
      return 2;
    }
    const got = validateRecipe(raw);
    if (!got.ok) {
      process.stderr.write(`这份模板不能用：${got.reason}\n`);
      return 2;
    }
    /*
     * ⭐ 同名不是"静默替换"（2026-10-16，审计 P215）。
     *
     * 原来 `next = [...imported.filter(r => r.id !== id), got.recipe]` 无条件替换 ——
     * 而 `mergeRecipes` 是"内置先入表、导入的覆盖上去"，于是**导入一份
     * 与内置同 id 的 JSON 就能把内置那份盖掉**，只打一行"已导入"。
     * 文件头写的口径是"宁可报错"。
     *
     * 现在两段式（与 `ding plugins install` 同一个约定，复用已有的 `--yes`：
     * 新旗标会让 `args.ts` 的未知旗标守卫在入口就把这条命令拒掉）：
     *   · 盖**内置**的（id 命中 BUILTIN_RECIPES）→ 一律拒（内置是产品的一部分，不给你盖）；
     *   · 盖**你自己导入过的**→ 没 `--yes` 就拒，并说清要盖掉哪一份。
     */
    const hitBuiltin = BUILTIN_RECIPES.some((r) => r.id === got.recipe.id);
    if (hitBuiltin) {
      process.stderr.write(
        `不能导入：id「${got.recipe.id}」是**内置模板**，不允许覆盖（它会盖掉产品自带的那份）。\n` +
          `换个 id 再导入（编辑 JSON 里的 id 字段）。\n`,
      );
      return 2;
    }
    const replacing = imported.recipes.find((r) => r.id === got.recipe.id);
    if (replacing && !p.flags.has("yes")) {
      process.stderr.write(
        `已经有一份同 id 的模板：${safeText(replacing.title)}（${replacing.id}）。\n` +
          `要盖掉它就在命令末尾加 \`--yes\`（这一步就是确认：不替你点同意）。\n`,
      );
      return 3;
    }
    const next = [...imported.recipes.filter((r) => r.id !== got.recipe.id), got.recipe];
    writeImported(dataDir, next);
    if (replacing) {
      process.stdout.write(`（盖掉了原来那份：${safeText(replacing.title)}）\n`);
    }
    process.stdout.write(`已导入：${safeText(got.recipe.title)}（${got.recipe.id}）—— 看它：ding recipe show ${got.recipe.id}\n`);
    return 0;
  }

  process.stderr.write(`不认识：ding recipe ${sub}（可选：list / show / run / export / import）\n`);
  return 2;
}
