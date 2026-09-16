/**
 * AI 教学「会话准备态」的判定与写入策略 —— 纯函数、零依赖。
 *
 * 抽成独立文件的唯一目的：让契约脚本**直接 import 真实实现执行**。
 * 判定写在组件内部时，脚本只能照抄一份，等于自证（同款理由见 DP v3.2.0 第 18 项的 `editor/tabPolicy.ts`）。
 *
 * 背景（DP v3.2.0 第 19 项）：`started` = 「是否已开讲」的唯一标记，此前它与草稿 / 折叠态
 * 共用同一条写入路径，且后两者把 `started` 硬编码写回 `false` —— 一旦防抖定时器跨过开讲
 * 时刻，「已开讲」就被回退，且此后再无写回 `true` 的机会，会话每次重进都落回准备态。
 *
 * 因此这里的写入被拆成互不重叠的三个函数：`started` 只由「新建（false）」与「开讲（true）」
 * 决定，`withDraft` / `withFold` **在结构上碰不到它**（不是靠调用方自觉）。
 */

/** 准备态快照（`localStorage` 的 `aiTeach.nav.<sid>.prep`）。字段含义见 `AiTeachNav`。 */
export type PrepSnap = { started?: boolean; draft?: string; srcOpen?: boolean; reqOpen?: boolean }

/** 打开会话时的落点判定。`correctStarted` = 快照失真，需要把它校正为已开讲。 */
export type PrepLanding =
  | { mode: 'prepare' }
  | { mode: 'chat'; correctStarted: boolean }

/**
 * 落点判定：进准备态，还是正常对话态？
 *
 * `msgCount` 是会话**真实数据**（已落库的消息条数），用来给快照兜底：
 * - 快照说「未开讲」（`started === false`）但会话已有消息 → 判为已开讲，并回写校正（自愈历史残留）；
 * - 消息为 0 → 真准备态（新建后未发送即切走，此时切回应当还原准备面板）；
 * - 快照缺失（`prep` 为 undefined）→ 正常态（**不是**准备态；这条是既有语义，勿改）。
 */
export function decidePrepLanding(prep: PrepSnap | undefined, msgCount: number): PrepLanding {
  if (!prep || prep.started !== false) return { mode: 'chat', correctStarted: false }
  if (msgCount > 0) return { mode: 'chat', correctStarted: true }
  return { mode: 'prepare' }
}

/** 草稿变更：只合并 `draft`，其余字段（含 `started`）保持原值。 */
export function withDraft(prep: PrepSnap | undefined, draft: string): PrepSnap {
  return { ...prep, draft }
}

/** 折叠条开合：只合并 `srcOpen` / `reqOpen`，其余字段保持原值。 */
export function withFold(prep: PrepSnap | undefined, srcOpen: boolean, reqOpen: boolean): PrepSnap {
  return { ...prep, srcOpen, reqOpen }
}

/** 开讲：置 `started = true`（草稿与折叠态的当前值原样保留）。 */
export function withStarted(prep: PrepSnap | undefined): PrepSnap {
  return { ...prep, started: true }
}
