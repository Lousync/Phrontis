/**
 * 批量移动纯逻辑（v3.16.1 方案 A）—— 零依赖，供工具预检 / ChangePlan / 契约脚本共用。
 *
 * 为什么单独拆文件：预检规则（路径归一、重复、扩展名、目录解析、大小写、AI 教学保护）
 * 一旦和 fs / electron 混在一起，契约就只能靠「源码字符串」断言；这里把规则收敛成
 * `preflightMoves(raw, probe)`，fs 事实由调用方注入（probe），脚本用假 probe 就能跑全部边界。
 *
 * 失败语义：**整批拒绝**，一次返回全部冲突（不是第一条），让模型在同一轮逐条修正后重试。
 */

export const MAX_BATCH_MOVES = 100
/** 单条消息内累计移动条目硬上限（防模型用 99 次批量调用绕过单次 100 条） */
export const MAX_BATCH_MOVE_ITEMS_PER_MESSAGE = 300

export interface MovePair {
  from: string
  to: string
}

export interface MoveConflict {
  /** 1-based，直接对应模型提交的数组下标 + 1 */
  index: number
  from: string
  to: string
  reason: string
}

/** fs 事实注入：纯逻辑不碰 fs，调用方按仓库根解析 */
export interface MoveProbe {
  isFile: (rel: string) => boolean
  isDir: (rel: string) => boolean
  exists: (rel: string) => boolean
}

export interface PreflightOptions {
  /** 受保护根目录（首段命中即拒绝）；默认 AI 教学根 */
  protectedRoots?: string[]
  /**
   * 是否把「已存在目录」的 `to` 解析为「目录/原文件名」。
   * 工具入参 = true（默认）；ChangePlan 应用时 `to` 已是最终文件路径 = false，
   * 否则暂存后有人在该路径建了同名目录，会被二次解析成 `to/from.md` 搬错位置。
   */
  resolveDirTargets?: boolean
}

export type PreflightResult =
  | { ok: true; moves: MovePair[]; conflicts: [] }
  | { ok: false; moves: MovePair[]; conflicts: MoveConflict[] }

const MOVE_EXTS = new Set(['md', 'txt'])

export function baseOfRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

export function parentOfRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function extOf(rel: string): string {
  const base = baseOfRel(rel)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** 仓库相对路径归一：反斜杠转 `/`、去空段与 `.`、拒绝绝对路径 / `..` / 空路径 / 隐藏首段 */
export function normalizeVaultRel(raw: unknown): string | null {
  const value = String(raw ?? '').trim().replace(/\\/g, '/')
  if (!value) return null
  // 绝对路径 / 盘符 / UNC 一律拒绝（AI 只认仓库相对路径）
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null
  const segs: string[] = []
  for (const seg of value.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') return null
    segs.push(seg)
  }
  if (segs.length === 0) return null
  // 与 isAiWritableFile 同口径：首段点开头 = 隐藏目录（.knowbase / .attachments 等）禁动
  if (segs[0].startsWith('.')) return null
  return segs.join('/')
}

function isProtected(rel: string, protectedRoots: string[]): boolean {
  const first = rel.split('/')[0]
  return protectedRoots.some((root) => root && first === root)
}

/**
 * 全量预检。`raw` 直接收工具入参（未知类型也安全）；
 * 任何一条失败 → `ok:false` 且 `conflicts` 覆盖全部失败条目。
 */
export function preflightMoves(
  raw: unknown,
  probe: MoveProbe,
  options: PreflightOptions = {},
): PreflightResult {
  const protectedRoots = options.protectedRoots?.filter(Boolean) ?? ['AI教学']
  const resolveDirTargets = options.resolveDirTargets !== false
  const list = Array.isArray(raw) ? raw : []
  const conflicts: MoveConflict[] = []
  const moves: MovePair[] = []

  if (list.length === 0) {
    conflicts.push({ index: 0, from: '', to: '', reason: `moves 至少 1 条（最多 ${MAX_BATCH_MOVES} 条）` })
    return { ok: false, moves, conflicts }
  }
  if (list.length > MAX_BATCH_MOVES) {
    conflicts.push({ index: 0, from: '', to: '', reason: `一次最多移动 ${MAX_BATCH_MOVES} 条，收到 ${list.length} 条` })
    return { ok: false, moves, conflicts }
  }

  const seenFrom = new Set<string>()
  const seenTo = new Set<string>()

  for (let i = 0; i < list.length; i++) {
    const index = i + 1
    const row = list[i]
    const rawFrom = row && typeof row === 'object' ? (row as Record<string, unknown>).from : ''
    const rawTo = row && typeof row === 'object' ? (row as Record<string, unknown>).to : ''
    const from = normalizeVaultRel(rawFrom)
    const to = normalizeVaultRel(rawTo)
    const push = (reason: string) => conflicts.push({ index, from: from ?? String(rawFrom ?? ''), to: to ?? String(rawTo ?? ''), reason })

    if (!from) { push('from 缺失或路径非法（不能是绝对路径 / 含 .. / 隐藏首段）'); continue }
    if (!to) { push('to 缺失或路径非法（不能是绝对路径 / 含 .. / 隐藏首段）'); continue }
    if (!MOVE_EXTS.has(extOf(from))) { push('from 必须是 .md / .txt 文件'); continue }
    if (isProtected(from, protectedRoots)) { push(`源位于受保护目录 ${protectedRoots.join(' / ')}，请走专用通道`); continue }
    if (isProtected(to, protectedRoots)) { push(`目标位于受保护目录 ${protectedRoots.join(' / ')}，请走专用通道`); continue }
    if (seenFrom.has(from)) { push('from 重复'); continue }
    if (!probe.isFile(from)) { push('源不存在或不是文件'); continue }

    // to 是已存在目录 → 保留原文件名；否则按新文件名（必须 .md/.txt）
    let target: string
    if (resolveDirTargets && probe.isDir(to)) target = to ? `${to}/${baseOfRel(from)}` : baseOfRel(from)
    else if (MOVE_EXTS.has(extOf(to))) target = to
    else { push('to 既不是已存在目录，也不以 .md / .txt 结尾'); continue }

    if (target === from) { push('源与目标相同'); continue }
    if (target.toLowerCase() === from.toLowerCase()) { push('v1 不支持仅大小写不同的重命名'); continue }
    if (!MOVE_EXTS.has(extOf(target))) { push('目标必须是 .md / .txt 文件'); continue }
    const parent = parentOfRel(target)
    if (parent && probe.exists(parent) && !probe.isDir(parent)) { push('目标父路径被文件占用'); continue }
    if (seenTo.has(target.toLowerCase())) { push('解析后的目标路径重复'); continue }
    if (probe.exists(target)) { push('目标已存在（v1 不覆盖）'); continue }

    seenFrom.add(from)
    seenTo.add(target.toLowerCase())
    moves.push({ from, to: target })
  }

  return conflicts.length === 0
    ? { ok: true, moves, conflicts: [] }
    : { ok: false, moves, conflicts }
}

/** 回滚方向：整批反向且逆序（后移动的先撤回，避免父目录前提被破坏） */
export function reverseMoves(moves: MovePair[]): MovePair[] {
  return moves.slice().reverse().map((m) => ({ from: m.to, to: m.from }))
}

/** 方案卡摘要：按主要目标目录聚合，不拼 100 条路径 */
export function summarizeMoves(moves: MovePair[]): string {
  if (moves.length === 0) return '批量移动 0 个文件'
  const bucket = new Map<string, number>()
  for (const m of moves) {
    const dir = parentOfRel(m.to)
    bucket.set(dir, (bucket.get(dir) ?? 0) + 1)
  }
  const [topDir] = [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  const names = moves.slice(0, 3).map((m) => baseOfRel(m.to)).join('、')
  return `移动 ${moves.length} 个文件 → ${topDir || '仓库根目录'}（示例：${names}${moves.length > 3 ? '…' : ''}）`
}

/** 冲突 → 一条可回喂模型的错误文案（按条编号，最多列 20 条） */
export function formatMoveConflicts(conflicts: MoveConflict[]): string {
  const shown = conflicts.slice(0, 20).map((c) =>
    `第 ${c.index || '?'} 条（${c.from || '?'} → ${c.to || '?'}）：${c.reason}`,
  )
  const rest = conflicts.length > shown.length ? `；另有 ${conflicts.length - shown.length} 条冲突未列出` : ''
  return shown.join('；') + rest
}
