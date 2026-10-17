/**
 * 产物的类型（本地口径的枚举）。
 *
 * ⚠️ 定义**放在这一层**（2026-10-16）：它原来长在 `src/workbench/artifact.ts`，
 * 而这一层用 `import type` 去借 —— 渲染层的东西于是被拉进了**协议层**。
 * 后果不只是"看着别扭"：`tsconfig.cli.json` 编 CLI 时，凡是进编译图的文件都会被 emit，
 * 于是 npm 包里凭空多出 `dist-cli/src/workbench/artifact.js`（渲染层代码，`files` 全量发布）。
 * 协议层不该依赖渲染层，方向反过来才对。
 */
export type ArtifactKind =
  | "markdown"
  | "docx"
  | "pptx"
  | "xlsx"
  | "html"
  | "code"
  | "image"
  | "canvas";

/**
 * 产物类型与状态的**协议层**定义（阶段 11.29）。
 *
 * ## 为什么要对这套东西
 * 上位那边产物的类型不是前端自己编的字符串，而是协议里的枚举
 * （`ArtifactResourceType` 0–17）。我们本地只用得到其中几种，
 * **但编号对不上就是另一套东西了** —— 将来要跟这套协议对接时，
 * 「本地叫 docx、协议里 Docx 是 10」这种散落在各处的对应关系迟早出错。
 *
 * 把编号集中在这里，好处有两个：
 *   1. 本地类型与协议类型是**一处映射**，不是散的；
 *   2. 协议里那些本地用不到的档位也**如实列出来** ——
 *      它们的存在本身是信息（比如 Miaoda 13 / Wiki 14 / Base 15
 *      是"服务端生成的其它产物形态"，本机版不做，但要知道有这些坑）。
 *
 * ## 两套状态，别混
 * 协议里有**两层**状态，早期容易当成一层：
 *   · 产物级 `ArtifactStatus` —— 这个产物整体什么情况（初始/生成中/已生成/已删/终止/不支持）
 *   · 操作级 `ArtifactOpStatus` —— **某一次写操作**的进展（开始/完成/更新/回滚）
 * 一次产物生成里可以有多次写操作（Start → Updated → Updated → Finish），
 * 所以两层不能合并成一个字段。
 */

/** 协议里的产物类型编号（`ArtifactResourceType`）。 */
export const ARTIFACT_RESOURCE_TYPE = {
  Undefined: 0,
  WriteDoc: 1,
  Pages: 2,
  CanvasPage: 3,
  StepWritingPage: 4,
  Code: 5,
  StepWritingOtterPage: 6,
  CodeBlock: 7,
  CodeDevelopMode: 8,
  Slides: 9,
  Docx: 10,
  StepDocx: 11,
  Excel: 12,
  Miaoda: 13,
  Wiki: 14,
  Base: 15,
  CanvasWorkspace: 16,
  Markdown: 17,
} as const;

/** 本地产物类型 → 协议编号。**只列本地真的会产出、且能明确对应的那些**。 */
const KIND_TO_TYPE: Record<ArtifactKind, number> = {
  markdown: ARTIFACT_RESOURCE_TYPE.Markdown,
  docx: ARTIFACT_RESOURCE_TYPE.Docx,
  pptx: ARTIFACT_RESOURCE_TYPE.Slides,
  xlsx: ARTIFACT_RESOURCE_TYPE.Excel,
  code: ARTIFACT_RESOURCE_TYPE.CodeBlock,
  html: ARTIFACT_RESOURCE_TYPE.Pages,
  // 下面两个在协议里没有一一对应的档位：图片与画布都归到工作区范畴
  image: ARTIFACT_RESOURCE_TYPE.CanvasWorkspace,
  canvas: ARTIFACT_RESOURCE_TYPE.CanvasPage,
};

/**
 * 取某个本地类型对应的协议编号。
 *
 * @param kind 本地类型
 * @returns 协议编号；本地类型不在映射里时给 `Undefined`
 */
export function resourceTypeOf(kind: ArtifactKind): number {
  return KIND_TO_TYPE[kind] ?? ARTIFACT_RESOURCE_TYPE.Undefined;
}

/**
 * 反查：协议编号 → 本地类型。
 *
 * 同一个编号可能对应多个本地类型（比如若干"服务端文档形态"都落到 markdown），
 * 所以这里给**第一个**匹配，够用了 —— 本机版没有从协议反推产物的场景。
 *
 * @param type 协议编号
 * @returns 本地类型；对不上时给 null（**不瞎猜**）
 */
export function kindOfResourceType(type: number): ArtifactKind | null {
  for (const [kind, value] of Object.entries(KIND_TO_TYPE) as Array<[ArtifactKind, number]>) {
    if (value === type) return kind;
  }
  return null;
}

/** 协议里的**产物级**状态（`ArtifactStatus`）。 */
export const ARTIFACT_STATUS = {
  Init: 0,
  Generating: 1,
  Generated: 2,
  Deleted: 3,
  Terminal: 4,
  UnSupport: 5,
} as const;

/** 协议里的**操作级**状态（`ArtifactOpStatus`）—— 某一次写操作的进展。 */
export const ARTIFACT_OP_STATUS = {
  Start: 1,
  Finish: 2,
  Updated: 3,
  Rollbacked: 4,
} as const;

/**
 * 本地产物状态 → 协议编号。
 *
 * ⚠️ 入参词表**必须与真实的本地状态对齐**（审计 P60）：界面上那份是
 * `src/workbench/artifact.ts` 的 `generating | generated | failed`
 * （外加仓储用来表示"删掉了"的 `removed`）。这里原来写的是
 * `generating | ready | removed` —— 与真实词表**不相交**，于是 `generated` 与
 * `failed` 全落进默认分支，**失败的产物被报成「已生成」**。
 *
 * `ready` 是 Phase 11.29 的旧名，保留只为不弄红按它钉着的用例
 * （`src/workbench/artifactProto.test.ts`，那份不在本轮范围）；新代码用 `generated`。
 *
 * 协议里没有"失败"这一档（只有 Init/Generating/Generated/Deleted/Terminal/UnSupport），
 * 最接近的是 `Terminal`（终止）—— 不假装它是"已生成"。
 *
 * @param status 本地产物状态
 * @returns 协议编号
 */
export function artifactStatusOf(
  status: "generating" | "generated" | "failed" | "removed" | "ready" | undefined,
): number {
  switch (status) {
    case "generating":
      return ARTIFACT_STATUS.Generating;
    case "generated":
      return ARTIFACT_STATUS.Generated;
    case "ready":
      /* 旧名（Phase 11.29 写的那个），语义就是"已生成" */
      return ARTIFACT_STATUS.Generated;
    case "failed":
      return ARTIFACT_STATUS.Terminal;
    case "removed":
      return ARTIFACT_STATUS.Deleted;
    default:
      // 没标状态 = 已经拿到手的东西，按"已生成"算（协议里 Init 是"还没开始"）
      return ARTIFACT_STATUS.Generated;
  }
}
