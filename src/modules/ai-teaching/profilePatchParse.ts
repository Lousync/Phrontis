/**
 * AI 教学「画像更新建议」的解析与节流闸门 —— **纯函数 / 只用 `import type` / 不 touch DOM**。
 *
 * 为什么单独一个文件：契约脚本要能 `stripTypeScriptTypes` 之后**直接 import 真实实现执行**
 * （口径同 `prepPolicy.ts`、`electron/lib/profilePatch.ts`）。
 * ⚠️ 本文件**只允许 `import type`** —— 类型导入会被 Node 的类型剥离整体擦除；
 * 一旦出现普通值导入（`import { x } from '...'`），脚本装载时会留下无法解析的裸 import。
 *
 * 三件事：
 * 1. `parseProfileFence`：```` ```profile ```` 围栏文本 → 变化条目（新形态）；
 *    解析不出条目数组则回落「整篇全文」（旧形态，历史消息仍是这个形状）。
 * 2. `layerAllows`：某条目能否写进某层（本主题层可整段替换；工作区 / 全局只接受 add）。
 * 3. `profileThrottleAllows` / `profileThrottleNote`：忽略后的节流闸门（8 轮 / 30 分钟取先到）。
 *
 * 条目形状 `{ field, op, text, from? }` 与主进程 `electron/lib/profilePatch.ts` 必须一致 ——
 * 一个在渲染层解析、一个在主进程应用，跨进程共享不了模块，故各留一份；**改形状要同时改两处**。
 */
import type { AiTeachProfileEntry, AiTeachProfileOp } from '../../types'

/** 节流窗口：轮数与时长**取先到**（v3.2.0 第 20 项拍板） */
export const PROFILE_THROTTLE_ROUNDS = 8
export const PROFILE_THROTTLE_MS = 30 * 60 * 1000

/** 单次建议最多接受的条目数（防模型输出失控把卡片撑爆） */
export const PROFILE_MAX_ENTRIES = 40

export type ProfileParseMode = 'entries' | 'fulltext' | 'invalid'

export interface ProfileSuggestion {
  mode: ProfileParseMode
  /** `mode === 'entries'` 时有值 */
  entries: AiTeachProfileEntry[]
  /** `mode === 'fulltext'` 时有值（旧形态：整篇 md 全文） */
  text: string
}

/** 按会话持久化的节流状态（存 `aiTeach.nav.<sid>` 的 `profile` 字段） */
export interface ProfileThrottleState {
  /** 触发忽略 / 应用时所在轮次（= 会话内 user 消息条数） */
  mutedRound?: number
  /** 触发忽略 / 应用的时间戳（ms） */
  mutedTs?: number
  /** `applied` = 已写入（窗口内**不留**入口）；`ignored` = 当时忽略（窗口内**留**安静入口） */
  mutedBy?: 'ignored' | 'applied'
}

export type ProfileLayer = 'global' | 'workspace' | 'session'

// ---------------------------------------------------------------- 围栏解析

function coerceEntry(x: unknown): AiTeachProfileEntry | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const op = o.op
  if (op !== 'add' && op !== 'update' && op !== 'remove') return null
  const field = String(o.field ?? '').replace(/^\s*#+\s*/, '').trim()
  const text = String(o.text ?? '').replace(/\r?\n/g, ' ').trim()
  if (!field || !text) return null
  const entry: AiTeachProfileEntry = { field, op, text }
  if (op === 'update') {
    const from = String(o.from ?? '').replace(/\r?\n/g, ' ').trim()
    if (from) entry.from = from
  }
  return entry
}

/** JSON 解析阶梯：直解 → 取首 `[` 到末 `]` 再解 → 去尾逗号再解。
 *  **刻意不做全角字符替换** —— 条目正文是中文，`，：` 本身就是合法内容字符，
 *  全局换半角会把用户画像正文改坏（这也是不复用 QuizParser 那套修复层的原因之一）。 */
function jsonCandidates(body: string): string[] {
  const out: string[] = [body]
  const i = body.indexOf('[')
  const j = body.lastIndexOf(']')
  const sliced = i >= 0 && j > i ? body.slice(i, j + 1) : null
  if (sliced) out.push(sliced)
  const noTrail = (s: string) => s.replace(/,(\s*[\]}])/g, '$1')
  out.push(noTrail(body))
  if (sliced) out.push(noTrail(sliced))
  return out
}

function tryParseEntryArray(body: string): AiTeachProfileEntry[] | null {
  for (const cand of jsonCandidates(body)) {
    let parsed: unknown
    try { parsed = JSON.parse(cand) } catch { continue }
    if (!Array.isArray(parsed)) continue
    const entries = parsed
      .map(coerceEntry)
      .filter((x): x is AiTeachProfileEntry => x !== null)
    if (entries.length > 0) return entries.slice(0, PROFILE_MAX_ENTRIES)
  }
  return null
}

/** 围栏正文 → 建议。空正文 = `invalid`（调用方据此不渲染卡片）。 */
export function parseProfileFence(raw: unknown): ProfileSuggestion {
  const body = String(raw ?? '').trim()
  if (!body) return { mode: 'invalid', entries: [], text: '' }
  const entries = tryParseEntryArray(body)
  if (entries) return { mode: 'entries', entries, text: '' }
  // 看着像条目数组（以 `[` 开头）却一条都解不出来 → 判无效。
  // 绝不能回落到「整篇全文」—— 那会把这串 JSON 原文当作画像正文写进 PROFILE.md。
  if (body.startsWith('[')) return { mode: 'invalid', entries: [], text: '' }
  return { mode: 'fulltext', entries: [], text: body }
}

// ---------------------------------------------------------------- 层级权限

/** 本主题层：add / update / remove 都行（**允许整段替换该字段**）。
 *  上层（工作区 / 全局）：只接受 add —— 只合并追加，不改写已有内容。 */
export function layerAllows(layer: ProfileLayer, op: AiTeachProfileOp): boolean {
  return layer === 'session' || op === 'add'
}

// ---------------------------------------------------------------- 节流闸门

/** 窗口已过（可以再弹）→ true；仍在窗口内 → false。轮数与时长**取先到**。 */
export function profileThrottleAllows(
  state: ProfileThrottleState | undefined,
  round: number,
  now: number,
): boolean {
  if (!state) return true
  const r = Number(state.mutedRound)
  const t = Number(state.mutedTs)
  const hasR = Number.isFinite(r)
  const hasT = Number.isFinite(t)
  if (!hasR && !hasT) return true
  const roundsPassed = hasR ? round - r : Number.POSITIVE_INFINITY
  const msPassed = hasT ? now - t : Number.POSITIVE_INFINITY
  return roundsPassed >= PROFILE_THROTTLE_ROUNDS || msPassed >= PROFILE_THROTTLE_MS
}

/** 窗口内的人类可读剩余量（用于忽略后的 toast 与安静入口的 title）。窗口已过 → 空串。 */
export function profileThrottleNote(
  state: ProfileThrottleState | undefined,
  round: number,
  now: number,
): string {
  if (!state) return ''
  const r = Number(state.mutedRound)
  const t = Number(state.mutedTs)
  const roundsLeft = Number.isFinite(r) ? Math.max(0, PROFILE_THROTTLE_ROUNDS - (round - r)) : 0
  const minsLeft = Number.isFinite(t) ? Math.max(0, Math.ceil((PROFILE_THROTTLE_MS - (now - t)) / 60000)) : 0
  if (roundsLeft <= 0 || minsLeft <= 0) return ''
  return `再对话 ${roundsLeft} 轮、或等 ${minsLeft} 分钟后恢复提示`
}

/** 会话轮数口径 = messages 里 user 条数（与「每过一两轮就提议」这个体感同一个计数） */
export function userRoundCount(messages: ReadonlyArray<{ role?: string }> | undefined): number {
  let n = 0
  for (const m of messages ?? []) if (m && m.role === 'user') n++
  return n
}
