/**
 * 本机库状态：装过哪些插件/技能、有哪些项目、置顶了谁（阶段 11.7 / 11.8）。
 *
 * ## 为什么三件事放一个模块
 * 上位这三样都存**服务端**（插件是技能实体、项目在 `/alice/conversation/pin` 与
 * `conversation/create_section`、置顶有 `OPERATE_TYPE_TOP:1`）。我们是单机版，
 * 它们都是"本机的一小撮偏好状态"，存在同一个 JSON 里最省事、也最好整体读写。
 *
 * ## 两个必须守住的不变量
 * 1. **装过的 id 要跟目录求交集** —— 目录条目会被改名/下架，历史里留着的旧 id
 *    如果照单全收，界面就会出现"装过但找不到"的幽灵条目。
 * 2. **项目成员要跟任务求交集** —— 任务会被删，项目里留着的悬空 id 会让计数对不上。
 */

/** 一个项目（上位 `groupChats_navBar_entry_groupByProject`）。 */
export type Project = {
  id: string;
  name: string;
  createdAt: number;
  /** 归属这个项目的任务 id。 */
  memberIds: string[];
};

/** 本机库。 */
export type Library = {
  /** 已安装的目录条目 id。 */
  installed: string[];
  /** 任务执行时要启用的技能/插件 id（上位走 `extraExt.input_skill`）。 */
  enabled: string[];
  /** 项目列表。 */
  projects: Project[];
  /** 置顶的任务 id。 */
  pinned: string[];
  /** 收藏的文件名（云盘用）。 */
  starredFiles: string[];
  /**
   * 用户自己加的能力（对标插件页的「添加」）。
   *
   * 本机版没有插件市场后端，所以「安装」的诚实对应物是**自己加一条**：
   * 用户写下名字与说明，它就跟装好的条目一样可以启用、并进任务的系统提示词。
   * 这让能力清单**可扩展**，而不是只能从内置目录里挑。
   */
  custom: CustomItem[];
};

/** 空库。 */
/** 用户自己加的一条能力（对标插件页的「添加」）。 */
export type CustomItem = {
  id: string;
  name: string;
  /** 一句话说明它干什么 —— 这句会进任务的系统提示词，所以要写清楚。 */
  hint: string;
  type: "plugin" | "skill";
};

export const EMPTY_LIBRARY: Library = {
  installed: [],
  enabled: [],
  projects: [],
  pinned: [],
  starredFiles: [],
  custom: [],
};

/**
 * 加一条自定义能力。
 *
 * @param lib 库
 * @param item 新条目（id 由调用方给，保证唯一）
 * @returns 新库；名字/说明为空、或重名时**原样返回**（界面已拦，这是第二道）
 */
export function addCustom(lib: Library, item: CustomItem): Library {
  const name = item.name.trim();
  const hint = item.hint.trim();
  if (!name || !hint) return lib;
  // 重名不加：名字是它的标识，两条同名会让「启用的是哪一条」说不清
  if (lib.custom.some((c) => c.name === name)) return lib;
  return { ...lib, custom: [...lib.custom, { ...item, name, hint }] };
}

/**
 * 去掉一条自定义能力。
 *
 * @param lib 库
 * @param id 条目 id
 * @returns 新库（**同时从 `installed` 与 `enabled` 里清掉**，否则会留下悬空引用）
 */
export function removeCustom(lib: Library, id: string): Library {
  return {
    ...lib,
    custom: lib.custom.filter((c) => c.id !== id),
    installed: lib.installed.filter((x) => x !== id),
    enabled: lib.enabled.filter((x) => x !== id),
  };
}

/** 置顶数量上限。 */
export const MAX_PINNED = 8;

/** 合并两个 id 集合（自定义条目的 id 要与目录 id 一起构成合法集合）。 */
function union(a: Set<string>, b: string[]): Set<string> {
  const out = new Set(a);
  for (const id of b) out.add(id);
  return out;
}

/**
 * 把盘上读到的库收窄（`taskIds` 传 null 表示任务集合未知，不剔任务）。
 * 见 `normalizeLibrary` 的说明。
 */
/**
 * 把盘上读到的库**收窄成合法形状**。
 *
 * 磁盘上的东西要当不可信输入处理：可能是旧版本写的、可能被手改过。
 * 这里逐字段收窄，**坏字段退成空值**而不是整份丢掉 ——
 * 丢掉一份会让用户「什么都没了」，退成空值只丢那一项。
 *
 * ⚠️ `taskIds` 传 **null 表示"任务集合未知，别剔"**。
 * 这个参数不是可有可无的：任务目前**只在内存里**，刚启动时一个都没有，
 * 如果照常拿空集合去剔，用户的项目成员与置顶会被**每次重启清空一遍**。
 * 所以只有在任务列表确实权威（已经恢复好）时才传集合。
 *
 * @param raw 读到的原始值
 * @param catalogIds 当前目录里的合法 id（用来剔除幽灵条目）
 * @param taskIds 活着的任务 id；**null = 未知，不剔除**
 * @returns 合法的库
 */
export function normalizeLibrary(
  raw: unknown,
  catalogIds: Set<string>,
  taskIds: Set<string> | null,
): Library {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const idList = (value: unknown, allow: Set<string> | null): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") continue;
      if (allow && !allow.has(item)) continue;
      if (out.includes(item)) continue;
      out.push(item);
    }
    return out;
  };

  const projects: Project[] = [];
  if (Array.isArray(source.projects)) {
    for (const entry of source.projects) {
      if (!entry || typeof entry !== "object") continue;
      const p = entry as Record<string, unknown>;
      /*
       * **id 必须严格，name 可以补默认**。
       * 没有 id 的项目无法被引用（成员挂不上去、也删不掉），只能丢；
       * 但只是缺个名字就整条丢掉会白白损失用户数据，补个默认名更合适。
       */
      if (typeof p.id !== "string" || !p.id.trim()) continue;
      projects.push({
        id: p.id,
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "未命名项目",
        createdAt: typeof p.createdAt === "number" ? p.createdAt : 0,
        memberIds: idList(p.memberIds, taskIds),
      });
    }
  }

  const starred = new Set<string>();
  if (Array.isArray(source.starredFiles)) {
    for (const name of source.starredFiles) {
      if (typeof name === "string" && name.trim()) starred.add(name);
    }
  }

  /*
   * 自定义能力：**不按目录 id 剔**（它们本来就不在目录里），
   * 但要收窄形状 —— 缺 id/名字/说明的整条丢掉（缺了就无法引用或无法展示）。
   */
  const custom: CustomItem[] = [];
  if (Array.isArray(source.custom)) {
    for (const entry of source.custom) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as Record<string, unknown>;
      if (typeof c.id !== "string" || !c.id) continue;
      if (typeof c.name !== "string" || !c.name.trim()) continue;
      if (typeof c.hint !== "string" || !c.hint.trim()) continue;
      if (custom.some((x) => x.name === c.name)) continue;
      custom.push({
        id: c.id,
        name: c.name.trim(),
        hint: c.hint.trim(),
        type: c.type === "skill" ? "skill" : "plugin",
      });
    }
  }

  return {
    /*
     * ⚠️ `installed`/`enabled` 的合法 id = **目录 id ∪ 自定义条目 id**。
     *
     * 只用目录收窄的话，自定义条目会在**下一次载入时被当幽灵条目剔掉** ——
     * 表现为"加完能用，重启就没了"。`custom` 本身不被剔还不够，
     * 它的 id 也必须算合法，否则装/启用状态留不下来。
     */
    installed: idList(source.installed, union(catalogIds, custom.map((c) => c.id))),
    enabled: idList(source.enabled, union(catalogIds, custom.map((c) => c.id))),
    projects,
    pinned: idList(source.pinned, taskIds).slice(0, MAX_PINNED),
    starredFiles: [...starred],
    custom,
  };
}

/**
 * 切换安装状态。
 *
 * 卸载时**同时从 enabled 里移除** —— 否则会出现"没装但被启用"的矛盾状态，
 * 任务执行时会去引用一个不存在的条目。
 *
 * @param library 当前库
 * @param id 目录条目 id
 * @returns 新库
 */
export function toggleInstalled(library: Library, id: string): Library {
  const installed = library.installed.includes(id)
    ? library.installed.filter((x) => x !== id)
    : [...library.installed, id];
  return {
    ...library,
    installed,
    enabled: installed.includes(id) ? library.enabled : library.enabled.filter((x) => x !== id),
  };
}

/**
 * 切换"任务执行时启用"。
 *
 * @param library 当前库
 * @param id 目录条目 id
 * @returns 新库；**没安装的不能启用**（原样返回）
 */
export function toggleEnabled(library: Library, id: string): Library {
  if (!library.installed.includes(id)) return library;
  const enabled = library.enabled.includes(id)
    ? library.enabled.filter((x) => x !== id)
    : [...library.enabled, id];
  return { ...library, enabled };
}

/**
 * 新建项目。
 *
 * @param library 当前库
 * @param id 项目 id
 * @param name 项目名
 * @param now 创建时刻
 * @returns 新库；名字为空时原样返回（界面上已拦，这里是第二道）
 */
export function createProject(library: Library, id: string, name: string, now: number): Library {
  const clean = name.trim();
  if (!clean) return library;
  // 同名直接返回现有那个，避免项目列表里出现两个同名项
  if (library.projects.some((p) => p.name === clean)) return library;
  return { ...library, projects: [...library.projects, { id, name: clean, createdAt: now, memberIds: [] }] };
}

/** 重命名项目；名字为空则不动。 */
export function renameProject(library: Library, id: string, name: string): Library {
  const clean = name.trim();
  if (!clean) return library;
  return {
    ...library,
    projects: library.projects.map((p) => (p.id === id ? { ...p, name: clean } : p)),
  };
}

/**
 * 删项目。
 *
 * **不动任务本身** —— 项目只是分组，删项目不该把里面的任务也删掉。
 * 这与上位"移除项目"的语义一致（任务是独立实体）。
 */
export function removeProject(library: Library, id: string): Library {
  return { ...library, projects: library.projects.filter((p) => p.id !== id) };
}

/**
 * 把任务放进项目 / 从项目移出。
 *
 * 一个任务**同时只能属于一个项目**：上位项目分组是互斥的（"按项目分组"这个语义
 * 本身要求互斥），所以这里先进后出 —— 加入 A 会自动从 B 移出。
 *
 * @param library 当前库
 * @param projectId 目标项目 id；传 null 表示移出所有项目
 * @param taskId 任务 id
 * @returns 新库
 */
export function setProjectMember(library: Library, projectId: string | null, taskId: string): Library {
  return {
    ...library,
    projects: library.projects.map((p) => {
      const has = p.memberIds.includes(taskId);
      if (p.id === projectId) return has ? p : { ...p, memberIds: [...p.memberIds, taskId] };
      return has ? { ...p, memberIds: p.memberIds.filter((x) => x !== taskId) } : p;
    }),
  };
}

/**
 * 切换置顶。
 *
 * @param library 当前库
 * @param taskId 任务 id
 * @returns 新库；超过上限时原样返回
 */
export function togglePinned(library: Library, taskId: string): Library {
  if (library.pinned.includes(taskId)) {
    return { ...library, pinned: library.pinned.filter((x) => x !== taskId) };
  }
  if (library.pinned.length >= MAX_PINNED) return library;
  return { ...library, pinned: [...library.pinned, taskId] };
}

/**
 * 组装要交给任务的启用清单。
 *
 * 上位把启用项走 `extraExt.input_skill` 交给服务端，由服务端注入 schema。
 * 单机版没有那一层，所以把启用项**变成一句明确的上下文**放进系统提示词 ——
 * 这样模型至少知道"这次可以用这些能力"，而不是完全不知道。
 *
 * @param library 当前库
 * @param lookup 按 id 取条目名（避免这个纯模块依赖目录数据）
 * @returns 系统提示词片段；没有启用项时返回空串
 */
export function enabledPromptBlock(
  library: Library,
  lookup: (id: string) => { name: string; hint: string } | undefined,
): string {
  const items = library.enabled.map(lookup).filter((x): x is { name: string; hint: string } => Boolean(x));
  if (items.length === 0) return "";
  return [
    "本次任务启用了以下能力，请优先用它们完成任务：",
    ...items.map((item) => `- ${item.name}：${item.hint}`),
  ].join("\n");
}
