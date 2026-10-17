import { describe, expect, it } from "vitest";

import { BUILTIN_RECIPES, mergeRecipes, recipeToJson, resolveRecipeMode, validateRecipe } from "./recipes";

/**
 * Recipe 模板（Phase 18）。
 *
 * ## 判据的重点在**导入的口子**（那是外部文件）
 *
 * 内置那几份是我们自己写的，出不了大错；真会出问题的是**导入别人的 JSON**：
 * 工具名写错、档位写错、prompt 空着。所以这一组主要在验"坏输入被挡住且说清哪里坏"。
 */

describe("Recipe 模板（Phase 18）", () => {
  it("① 内置模板自己都是合法的（别让自家数据过不了自家校验）", () => {
    for (const r of BUILTIN_RECIPES) {
      const got = validateRecipe(r);
      expect(got.ok, `${r.id} 不合法：${got.ok ? "" : got.reason}`).toBe(true);
    }
  });

  it("② 内置模板里没有「空壳」（每条都要有 prompt 与 description）", () => {
    for (const r of BUILTIN_RECIPES) {
      expect(r.prompt.trim().length, `${r.id} 没有 prompt`).toBeGreaterThan(10);
      expect(r.description.trim().length, `${r.id} 没有说明`).toBeGreaterThan(4);
    }
  });

  it("③ 工具名对不上就报错（**不静默忽略** —— 那会让人以为按模板跑了）", () => {
    const got = validateRecipe({ id: "x", title: "t", prompt: "p", tools: ["read_file", "不存在的工具"] });
    expect(got.ok).toBe(false);
    expect(got.ok ? "" : got.reason).toContain("不认识的工具");
  });

  it("④ 档位写错就报错，且说清可选值", () => {
    const got = validateRecipe({ id: "x", title: "t", prompt: "p", mode: "随便" });
    expect(got.ok).toBe(false);
    expect(got.ok ? "" : got.reason).toContain("全部允许");
  });

  it("⑤ 缺 id / title / prompt 分别说清缺哪个", () => {
    const empty = validateRecipe({});
    expect(empty.ok).toBe(false);
    expect(validateRecipe(null)).toEqual({ ok: false, reason: "不是一个对象" });
    expect((validateRecipe({ title: "t", prompt: "p" }) as { reason: string }).reason).toContain("id");
    expect((validateRecipe({ id: "a", prompt: "p" }) as { reason: string }).reason).toContain("title");
    expect((validateRecipe({ id: "a", title: "t" }) as { reason: string }).reason).toContain("prompt");
  });

  it("⑥ 档位只会更严、不会更松（模板不能替你放开权限）", () => {
    const r = { id: "x", title: "t", description: "", prompt: "p", mode: "全部允许" as const };
    // 当前是"每步确认"时，模板里的"全部允许"**不生效**
    expect(resolveRecipeMode("每步确认", r)).toBe("每步确认");
    // 当前是"全部允许"时，模板里的"按需确认"生效（更严）
    expect(resolveRecipeMode("全部允许", { ...r, mode: "按需确认" })).toBe("按需确认");
    // 模板没写档位 → 用当前的
    expect(resolveRecipeMode("按需确认", { ...r, mode: undefined })).toBe("按需确认");
  });

  it("⑦ 合并：导入的同名覆盖内置（用户自己改过的那份说了算）", () => {
    const mine = { id: "daily-digest", title: "我的每日汇总", description: "", prompt: "我的版本" };
    const all = mergeRecipes([mine]);
    expect(all.find((r) => r.id === "daily-digest")?.title).toBe("我的每日汇总");
    // 内置的其它还在
    expect(all.some((r) => r.id === "repo-triage")).toBe(true);
  });

  it("⑧ 导出是可读的 JSON（分享用），且能被自己校验回来", () => {
    const json = recipeToJson(BUILTIN_RECIPES[0]!);
    expect(json).toContain("\"prompt\"");
    const back = validateRecipe(JSON.parse(json));
    expect(back.ok).toBe(true);
    expect(back.ok && back.recipe.id).toBe(BUILTIN_RECIPES[0]!.id);
  });
});
