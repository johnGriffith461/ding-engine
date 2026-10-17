import type { LogInput, LogRecord } from "../core/events";
import type { SessionSearchHit, SessionSummary } from "../../shared/ipc";

/**
 * 会话事件存储的端口（Phase 1 D1 冻结）。
 *
 * ## 为什么先有端口、后有实现
 *
 * 现状是**一个 JSONL 文件一段会话**（`electron/ipc/sessionStore.ts`）：能追加、
 * 能读回、能列举 —— 但**没有事务、没有查询、没有并发控制**。
 * 换成 SQLite 是 Phase 1 的既定动作，可换的过程中最怕的是"顺手把接口也改了" ——
 * 那样桌面宿主、CLI、快照设施会被同时拖着改，出问题时分不清是"存储换了"还是"接口换了"。
 *
 * 所以顺序是：**先按意图把端口定下来**（这个文件），再让实现去满足它。
 * 端口只描述"会话事件要能怎么用"，不描述"存在哪、怎么存"。
 *
 * ## 三个方法就是全部
 *
 * | 方法 | 意图 |
 * |---|---|
 * | `append` | 把**新发生的**记录追加进去，返回带上 `seq`/`at` 的落盘形态 |
 * | `load` | 按 `seq` 升序读回一段会话（`fold`/`resume` 的原料） |
 * | `list` | 列出会话（`ding sessions` / 聊天侧会话列表） |
 *
 * ## 一条硬规矩：`append` 的返回值必须带 `seq`
 *
 * 调用方拿它做两件事：把"已落盘的第几条"报给用户，以及在**同一个**会话被多处写入时
 * 保证编号不撞车。所以"追加完再读一遍"是实现自己的事，但**返回的必须是落盘后的形态** ——
 * 返回入参（没有 `seq`）会让调用方只能猜编号，而猜编号这件事本项目已经踩过：
 * 两个写入器各从 1 数起，"批准"就跑到了它对应的那一轮**前面**，重启后那条留痕永远是"等确认"。
 */
/**
 * 待落盘的记录，**可以**自带原始时刻（迁移 / 恢复那条路用）。
 *
 * 新发生的事件没有 `at`（存储自己盖"现在"）；从旧日志迁进来、或从备份恢复进来的
 * 记录有 —— 那个时刻是数据的一部分，存储不许覆盖它（理由见 `append` 的说明）。
 */
export type LogInputAt = LogInput & { at?: number };

export type SessionStore = {
  /**
   * 追加记录。
   *
   * ⚠️ **一次调用的这一批要么都进、要么都不进**（实现负责）：日志的价值在顺序，
   * 半批写入会让"请求记录在、它的工具事件不在"这种形状成为可能。
   *
   * ## `at`：新记录没有，**迁移/恢复进来的记录有**（2026-10-16，审计 P14 / P31）
   *
   * `LogInput` 是"还没分配 `seq`/`at`"的记录，所以新发生的事件由实现盖"现在"。
   * 但从旧 `.jsonl` 迁进来、或从备份恢复进来的记录**本来就带着时刻** ——
   * 那是数据的一部分，不是存储编的编号：
   *
   * · 盖成"现在"会让整段历史挤进今天，**成本账本按天的口径当场就散了**
   *   （`engine/core/ledger.ts` 的 `localDay(entry.at)` 读的就是记录里的 `at`）；
   * · 会话里"什么时候说的这句话"是用户记得住的事实（"三个月前聊过这个"），
   *   它不该因为换了个存储就变成"刚才"。
   *
   * 所以：**记录自带 `at` 时用它**（见 `LogInputAt`），没有才盖现在。
   *
   * @param sessionId 会话 id（宿主负责收窄；实现仍应自证一次）
   * @param records 还没分配 `seq` 的记录；**可以**自带原始 `at`（`LogInputAt`）
   * @param opts 见 `AppendOptions`
   * @returns 落盘形态（带 `seq`/`at`），顺序与入参一致
   */
  append(sessionId: string, records: readonly LogInputAt[], opts?: AppendOptions): Promise<LogRecord[]>;

  /**
   * 读回一段会话。
   *
   * ⚠️ 坏数据**只跳过它自己**，并把跳过数报出来（"写入被打断"不该让整段历史消失，
   * 也不该被静默吞掉）。这是现有 `parseLog` 的口径，端口把它固定下来。
   *
   * ## C1（V5-1 3.5）：归属校验是这一层的事
   *
   * 给了 `opts.owner` 而这段会话的 owner 是**别人**时，回**空内容**并置 `denied` ——
   * 不是抛错（调用方按"没有内容"处理即可，也不必知道"它存在但不是你的"）。
   * 不给 `opts.owner` = 老行为（本机单用户，调用方隐含就是 owner）。
   *
   * @param sessionId 会话 id
   * @param opts 见 `LoadOptions`
   * @returns 记录（按 `seq` 升序）与跳过数；会话不存在时给空数组（不是错误）
   */
  load(sessionId: string, opts?: LoadOptions): Promise<{ records: LogRecord[]; skipped: number; denied?: "owner" }>;

  /**
   * 按内容检索（Phase 12.4 的本地检索）。
   *
   * ## 为什么它不是 `list` 的一个过滤参数
   *
   * `list` 走的是**会话**表（id / 标题 / 时间），而"三个月前聊过什么"要在**事件正文**里找 ——
   * 两者命中不同的行、天然是两种查询。塞进 `list` 会让它一半走索引、一半走全文扫描。
   *
   * ## 实现之间语义不同（如实写在端口上，不让调用方猜）
   *
   * · SQLite 那版走 **FTS5 全文索引**（分词、按相关度排序之后仍按时间倒序给）；
   * · JSONL 那版（历史遗留）没有索引，只能逐条 `includes` —— 慢，但结果一致。
   *
   * 所以调用方**不要**依赖排序细节，只依赖"命中的会话在这些结果里"。
   *
   * @param query 关键词（空串 = 空结果，不是全部）
   * @param opts.limit 最多给多少条会话（默认 20）
   * @returns 命中的会话摘要 + 每条命中的一小段上下文
   */
  search(query: string, opts?: { limit?: number }): Promise<SearchHit[]>;

  /**
   * 列出会话，按最后写入时间**倒序**（最近的在前面）。
   *
   * @param opts 过滤（默认全部）
   * @returns 会话摘要
   */
  list(opts?: { kind?: SessionKind }): Promise<SessionSummary[]>;

  /**
   * 按保留策略收口一次（年龄 / 条数 / 容量）。
   *
   * ⚠️ 实现之间**语义不同**，端口只承诺"这一类的清理会发生"：
   * SQLite 那版是**整会话淘汰**（从最旧的删），JSONL 那版是"按年龄/条数删文件 +
   * 单文件超限轮转"。所以宿主调它时**不要**依赖"具体删了谁"。
   *
   * 异步是刻意的：JSONL 那版要 `stat` 每个文件，同步做会把主进程卡住；
   * SQLite 那版内部是同步的，包一层 Promise 即可。**端口不该由实现的快慢决定形状**。
   *
   * @returns 删掉的会话 id 与剩下的条数
   */
  prune(): Promise<{ deleted: string[]; kept: number }>;

  /**
   * 放开句柄。
   *
   * ⚠️ 端口里必须有它，不是"实现细节"：SQLite 的库文件在句柄没放之前**删不掉**
   * （Windows 上是硬失败），而"一个 store 用完要能干净收场"是调用方的能力
   * （测试要清临时目录、CLI 跑完要退出）。原来的 JSONL 实现"没有句柄"这件事
   * 是**运气**，不是契约 —— 换存储时正是这类假设会翻车。
   */
  close(): void;
};

/**
 * 检索命中的一条：会话摘要 + 在哪一句命中的。
 *
 * ⚠️ 2026-10-17 起**定义搬到 `shared/ipc.ts`**（`SessionSearchHit`）：
 * 这条记录要经 IPC 走到渲染层（左栏搜索框），契约只有一份，
 * 两处各写一遍迟早漂移。这里保留 `SearchHit` 这个名字给端口用。
 */
export type SearchHit = SessionSearchHit;

/** 会话种类。前缀语义取自 `engine/core/events.ts` 的 `SESSION_PREFIX`。 */
export type SessionKind = "chat" | "task" | "cli";

/**
 * `append` 的选项（C1，V5-1 3.5）。
 *
 * `owner` 只对**新建**会话生效（第一次写入的那一刻定归属，之后不再改 ——
 * "这段会话归谁"是创建时的事实，不是每次写入刷一遍的字段）。
 * 对**已有**会话：owner 不同 → **拒绝**（抛错，消息里说清是归属冲突）；
 * 不传 owner = 老行为（本机单用户；实现用默认 `local` 建库）。
 */
export type AppendOptions = {
  owner?: string;
  /**
   * 这段会话是从哪段**分叉**出来的（V5-2 2.5；只在新建那一刻生效）。
   *
   * 副本与源此后的变化互不影响；这一格只记"从哪来"（审计与界面上那句警示用）。
   */
  forkedFrom?: string;
};

/** `load` 的选项（C1）：给了 `owner` 就做归属校验（陌生 owner 不返回内容）。 */
export type LoadOptions = { owner?: string };

/**
 * 一步到位建一个 store（宿主按自己的数据位置调它）。
 *
 * ⚠️ 这是**工厂**而不是单例：测试要能建两个互不干扰的 store，
 * CLI 与桌面也要能各自指向自己的目录（同一个进程里跑两套数据是验收的常态）。
 */
export type SessionStoreFactory = (dir: string) => SessionStore;
