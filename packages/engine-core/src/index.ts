/**
 * `ding-engine-core` 的公开面（最小嵌入面）—— **唯一**的落脚点。
 *
 * 这一份是**声明**，不是实现（实现在 `engine/`，与产品同一份代码）。它存在的理由：
 * 公开面要有唯一一处落脚点 —— API 冻结清单（`packages/api.frozen.json`）指着它，
 * 于是"外面能用的东西"不会随着内部重构漂；而边界守卫
 * （`src/engineCoreBoundary.test.ts`）走的也正是从它出发的 import 闭包。
 *
 * 加东西是加法（补进冻结清单即可）；**改签名或删名字要 ADR + major**
 * （口径见 [`RELEASE.md`](../../RELEASE.md)）。
 */

/* ── 引擎：跑一轮、从日志恢复、快照 diff ─────────────────────────── */
export {
  createEngine,
  type Engine,
  type EnginePorts,
  type EngineRunRequest,
  type EngineRunResult,
} from "../../../engine/index";

/* ── 事件模型（日志即真相那一半） ────────────────────────────────── */
export {
  applyEvent,
  chatSessionId,
  cliSessionId,
  conversationIdOf,
  conversationTitle,
  emptyTurn,
  finishTurn,
  fold,
  isChatSessionId,
  isPendingOutput,
  parseLogLine,
  projectTurn,
  logLine,
  resumeSession,
  splitTurns,
  taskSessionId,
  type LogInput,
  type LogRecord,
  type PendingApproval,
  type ResumedSession,
  type TurnChunk,
  type TurnState,
  type TurnView,
} from "../../../engine/core/events";

/* ── 身份（C5）：谁说的这句话 ────────────────────────────────────── */
export {
  actorOf,
  normalizeActor,
  LEGACY_ACTOR,
  LOCAL_USER,
  MAIN_AGENT,
  SYSTEM_ACTOR,
  type Actor,
  type ActorKind,
} from "../../../engine/core/actor";

/* ── 权限与审批的**纯函数**（C2/C3：宿主自己搭界面时要的判定口径） ── */
export {
  approversOf,
  authorizeApprover,
  canDecide,
  DEFAULT_APPROVER,
  type DecisionCheck,
} from "../../../engine/core/gates";
export { decideForMember, injectableTools, type MemberDecision, type Verdict } from "../../../engine/core/policy";
export { MEMBER_ROLES, normalizeRoles, rolesOf, type MemberRole } from "../../../engine/core/members";

/* ── 成本账本（从事件流里读，不另存一份） ─────────────────────────── */
export { ledgerOf, rollup, type LedgerEntry, type LedgerTotal, type ModelInfo } from "../../../engine/core/ledger";

/* ── 快照与 diff（"录一份 → 后来比一次"） ────────────────────────── */
export { diffSnapshot, snapshotOf, type Snapshot, type SnapshotDiff } from "../../../engine/core/snapshot";

/* ── 端口（宿主给内核的东西：形状就是契约） ──────────────────────── */
export type { SessionStore, SessionKind, LoadOptions, AppendOptions } from "../../../engine/ports/store";
export type { ToolExecutor, ExecutorContext } from "../../../engine/ports/executor";
export type { HealthStore } from "../../../engine/ports/health";
export { noopHealth } from "../../../engine/ports/health";
export { noopHooks, type HooksPort } from "../../../engine/ports/hooks";
export { envSecret, type SecretPort } from "../../../engine/ports/secret";

/* ── 档位词表（跨进程契约里那一份） ──────────────────────────────── */
export { CONFIRM_MODES, normalizeConfirmMode, type ConfirmMode } from "../../../shared/ipc";
