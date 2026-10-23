import { exists, readJson, writeJsonOrThrow } from './jsonStore'
import { randomUUID } from 'crypto'
import { planScheduleRecurringSettle, endOfWeek, addDaysTo, type ScheduleRecurring } from '../../../src/lib/scheduleRecurringPure'
import { vaultDeleteWorkflowsByTask } from './scheduleWorkflowVaultRepo'

/**
 * 日程 vault 数据仓库（去库化 P2）：storageData=vault 时日程的真相源。
 *
 * 存储：`.knowbase/modules/schedule/{todos.json, tags.json}`
 * 行结构 = sql.js 表行原样（snake_case，字段名与 schedule_todos / schedule_tags 一致），
 * 与迁移器 `planTable('schedule_todos', modules/schedule/todos.json)` 产物同格式，
 * 因此「整表播种」「库→仓迁移器」「回收站快照」三者可互用，无第二套格式。
 *
 * 查询语义逐条复刻 scheduleRepo 里的 SQL（见各函数上方注释）：
 * - 过滤：NULL 判定与 sqlite 一致（`parent_id IS NULL` 只认 null，不认 ''；
 *   `task_type != 'plan'` 在 task_type 为 NULL 时结果为 NULL，即排除该行）
 * - 排序：sqlite 默认 BINARY 排序 → 文本按码位比较（binaryCompare），数值按大小比较
 * - `date LIKE 'YYYY-MM%'`：模式不含通配符（`_`/`%`），等价于前缀匹配
 * - `updated_at < datetime('now','-7 days')`：两侧都是文本比较，updated_at 现网为
 *   `new Date().toISOString()`（含 'T'），与 'YYYY-MM-DD HH:MM:SS' 截断点不同（'T' > ' '），
 *   这里用同一套文本比较原样复刻，不做"聪明"归一化
 */

// ---- 行结构（与表列同名） ----
export interface TodoRow {
  id: string; title: string; description: string | null; date: string
  time: string | null; quadrant: number; task_type: string
  tag_id: string | null; status: string; sort_order: number
  end_criteria: string | null; parent_id: string | null
  /**
   * 日程表排期时段（当天分钟数，540 = 09:00）。
   * 与 `time` 语义严格分离：`time` 是「截止时刻」（YYYY-MM-DDTHH:mm，仅 deadline 类），
   * 这里是「从几点排到几点」的时段。两者都为 null 时任务只出现在「待安排」栏。
   * 旧数据无此字段 → 读时兜 null，不需要迁移。
   */
  scheduled_start: number | null
  scheduled_end: number | null
  /** 提醒「稍后」目标时间（'YYYY-MM-DD HH:mm'）；缺省为空。本轮日程改造新增的唯一字段 */
  snooze_until?: string | null
  /** 固定日程（重复任务）生成的待办：来源规则 id + 本次日期（去重键 = recurringId@recurringDue） */
  recurringId?: string | null
  recurringDue?: string | null
  estimate_min?: number | null
  created_at: string; updated_at: string
}

export interface TagRow { id: string; name: string; color: string }

const MOD = 'modules/schedule'
const TODOS_FILE = 'todos.json'
const TAGS_FILE = 'tags.json'

// ===== 低层存取（供本 repo 与其他消费方共用） =====


/** 全部待办行（文件原序，即 sqlite rowid 序；查询层各自排序，不在此预排） */
export function vaultTodosAll(): TodoRow[] {
  const rows = readJson<unknown>(MOD, TODOS_FILE, [])
  return Array.isArray(rows) ? (rows as TodoRow[]) : []
}

export function vaultTodosAllTopLevel(): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => isNull(r.parent_id))
    .sort((a, b) => binaryCompare(str(a.date), str(b.date)) || bySortThenCreated(a, b))
}

export function vaultTodosSave(rows: TodoRow[]): void {
  // 必须落盘：写失败抛错，避免调用方（尤其 AI 写工具）把失败当成功上报
  writeJsonOrThrow(MOD, TODOS_FILE, rows)
}

/** 全部标签行（文件原序） */
export function vaultTagsAll(): TagRow[] {
  const rows = readJson<unknown>(MOD, TAGS_FILE, [])
  return Array.isArray(rows) ? (rows as TagRow[]) : []
}

export function vaultTagsSave(rows: TagRow[]): void {
  writeJsonOrThrow(MOD, TAGS_FILE, rows)
}

// ===== SQL 语义小工具 =====

function isNull(v: unknown): boolean {
  return v === null || v === undefined
}

/** sqlite BINARY 排序：文本按码位序（不用 localeCompare，中文顺序会与 BINARY 不同） */
function binaryCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** ORDER BY sort_order（数值列；缺列按 sqlite DEFAULT 0 处理） */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** `date LIKE 'YYYY-MM%'` 的前缀匹配（date 为 NULL 时 LIKE 结果 NULL → 排除） */
function likePrefix(v: unknown, prefix: string): boolean {
  return typeof v === 'string' && v.startsWith(prefix)
}

/** 复刻 sqlite `datetime('now', '-N days')`：UTC、'YYYY-MM-DD HH:MM:SS' */
function sqliteUtcMinusDays(days: number): string {
  const d = new Date(Date.now() - days * 86400000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** ORDER BY sort_order, created_at */
function bySortThenCreated(a: TodoRow, b: TodoRow): number {
  return num(a.sort_order) - num(b.sort_order) || binaryCompare(str(a.created_at), str(b.created_at))
}

// ===== 查询（对应 scheduleRepo 各 ipc handler 的 SELECT） =====

/**
 * SELECT * FROM schedule_todos
 *  WHERE parent_id IS NULL AND (date = ? OR (task_type = 'plan' AND status = 'pending'))
 *  ORDER BY sort_order, created_at
 * 日视图：当日顶层任务 + 未完成的计划类任务（plan 无截止，常驻直到完成）
 */
export function vaultTodosForDate(date: string): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => isNull(r.parent_id) && (r.date === date || (str(r.date) !== '' && r.task_type === 'plan' && r.status === 'pending')))
    .sort(bySortThenCreated)
}

/**
 * SELECT * FROM schedule_todos
 *  WHERE date < ? AND status = 'pending' AND parent_id IS NULL AND task_type != 'plan'
 *  ORDER BY date, sort_order, created_at
 * 逾期未完成（计划类不逾期，排除在外）
 */
export function vaultOverdueTodos(today: string): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => str(r.date) !== '' && str(r.date) < today && r.status === 'pending'
      && isNull(r.parent_id) && !isNull(r.task_type) && r.task_type !== 'plan')
    .sort((a, b) => binaryCompare(str(a.date), str(b.date)) || bySortThenCreated(a, b))
}

/**
 * SELECT DISTINCT date FROM schedule_todos WHERE date LIKE ? AND parent_id IS NULL
 * 月历打点。SQL 无 ORDER BY：实测（sql.js，同 app 引擎）DISTINCT 按扫描序输出去重后的日期，
 * 故这里按文件序（= 播种/插入序，等同 sqlite rowid 序）去重原序返回，不做额外排序。
 */
export function vaultDatesWithTodos(yearMonth: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of vaultTodosAll()) {
    if (!isNull(r.parent_id) || !likePrefix(r.date, yearMonth)) continue
    if (seen.has(r.date)) continue
    seen.add(r.date)
    out.push(r.date)
  }
  return out
}

/**
 * SELECT * FROM schedule_todos
 *  WHERE parent_id IS NULL AND (date LIKE ? OR (task_type = 'plan' AND status = 'pending'))
 *  ORDER BY date, sort_order, created_at
 * 月视图 / 象限图
 */
export function vaultMonthTodos(yearMonth: string): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => isNull(r.parent_id) && (likePrefix(r.date, yearMonth) || (str(r.date) !== '' && r.task_type === 'plan' && r.status === 'pending')))
    .sort((a, b) => binaryCompare(str(a.date), str(b.date)) || bySortThenCreated(a, b))
}

/**
 * 未排期任务：顶层、未完成、且**没有排期时段**（scheduled_start 为空）。
 *
 * 日程表视图「待安排」栏的数据源。刻意**不限日期/月份** ——
 * 三类任务（plan / daily / deadline）都可以先进这个池子，等着被拖进网格排期；
 * 计划类任务本来就没有日期归属，只按月份捞会让它们漏出视野。
 * 排序：日期升序 → 建序（与月视图同口径，保持稳定）。
 */
export function vaultUnscheduledTodos(): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => isNull(r.parent_id) && r.status === 'pending' && isNull(r.scheduled_start))
    .sort((a, b) => binaryCompare(str(a.date), str(b.date)) || bySortThenCreated(a, b))
}

/**
 * 日程表视图：某一周（含首尾）的顶层任务。
 *
 * 除区间内的任务外，还捞**区间之前、已排期但未完成**的任务 —— 它们是「未完成自动延后」
 * 的候选，视图会在今天的同一时段以虚线幽灵呈现（原日期让位）。
 * 已完成的历史任务不捞，避免幽灵越积越多。
 */
export function vaultTodosForWeek(weekStart: string, weekEnd: string): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => isNull(r.parent_id) && (
      (r.date >= weekStart && r.date <= weekEnd) ||
      (r.status === 'pending' && !isNull(r.scheduled_start) && r.date < weekStart)
    ))
    .sort((a, b) => binaryCompare(str(a.date), str(b.date)) || bySortThenCreated(a, b))
}

/** SELECT * FROM schedule_todos WHERE parent_id = ? ORDER BY sort_order, created_at */
export function vaultSubtasks(parentId: string): TodoRow[] {
  return vaultTodosAll()
    .filter((r) => !isNull(r.parent_id) && r.parent_id === parentId)
    .sort(bySortThenCreated)
}

/**
 * SELECT time FROM schedule_todos
 *  WHERE task_type = 'deadline' AND status = 'pending' AND time IS NOT NULL
 * deadline 提醒：按 time（存 'YYYY-MM-DD HH:MM'）的日期段计数由调用方完成（与 sqlite 路径同逻辑）
 */
export function vaultPendingDeadlineTimes(): string[] {
  return vaultTodosAll()
    .filter((r) => r.task_type === 'deadline' && r.status === 'pending' && !isNull(r.time))
    .map((r) => String(r.time))
}

/** SELECT * FROM schedule_todos WHERE id = ?（INSERT 后回读 / 旧状态判定用） */
export function vaultFindTodo(id: string): TodoRow | null {
  return vaultTodosAll().find((r) => r.id === id) ?? null
}

/**
 * DELETE FROM schedule_todos WHERE status = 'done' AND updated_at < datetime('now', '-7 days')
 * 注意：无 parent_id 条件 → 子任务同样清理（与 sqlite 一致）。返回删除条数。
 * updated_at 缺失/为空时 SQL 比较结果非真 → 保留该行。
 */
export function vaultPurgeStaleDoneTodos(): number {
  const cutoff = sqliteUtcMinusDays(7)
  const rows = vaultTodosAll()
  const kept = rows.filter((r) => !(r.status === 'done' && !isNull(r.updated_at) && str(r.updated_at) < cutoff))
  if (kept.length === rows.length) return 0
  vaultTodosSave(kept)
  return rows.length - kept.length
}

// ===== 写入 =====

/** INSERT INTO schedule_todos (...) VALUES (...)：整行追加（行由调用方按表列建好，字段与 sqlite 路径同口径） */
export function vaultCreateTodo(row: TodoRow): TodoRow {
  vaultTodosSave([...vaultTodosAll(), row])
  return row
}

/** schedule:updateTodo 的列白名单（与 handler 传给 buildUpdateSet 的 allowedColumns 一致） */
type TodoColumn =
  | 'title' | 'description' | 'date' | 'time' | 'quadrant' | 'task_type'
  | 'tag_id' | 'status' | 'end_criteria' | 'parent_id'
  | 'scheduled_start' | 'scheduled_end' | 'snooze_until' | 'estimate_min'

const TODO_COLUMNS: TodoColumn[] = ['title', 'description', 'date', 'time', 'quadrant', 'task_type', 'tag_id', 'status', 'end_criteria', 'parent_id', 'scheduled_start', 'scheduled_end', 'snooze_until', 'estimate_min']

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
}

function isTodoColumn(col: string): col is TodoColumn {
  return (TODO_COLUMNS as string[]).indexOf(col) >= 0
}

/**
 * 复刻 `UPDATE schedule_todos SET <白名单列> = ?, updated_at = ? WHERE id = ?`
 * （buildUpdateSet 同口径：camelCase key → snake_case 列名、白名单外丢弃、undefined 跳过、null 照写）
 * 命中返回更新后的整行；id 不存在返回 null（与 sqlite UPDATE 影响 0 行一致，不改文件）。
 */
export function vaultUpdateTodo(id: string, patch: Record<string, unknown>, updatedAt: string): TodoRow | null {
  const rows = vaultTodosAll()
  const i = rows.findIndex((r) => r.id === id)
  if (i < 0) return null
  const next: TodoRow = { ...rows[i] }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    const col = camelToSnake(k)
    if (!isTodoColumn(col)) continue
    switch (col) {
      case 'title': next.title = v as string; break
      case 'description': next.description = v as string | null; break
      case 'date': next.date = v as string; break
      case 'time': next.time = v as string | null; break
      case 'quadrant': next.quadrant = v as number; break
      case 'task_type': next.task_type = v as string; break
      case 'tag_id': next.tag_id = v as string | null; break
      case 'status': next.status = v as string; break
      case 'end_criteria': next.end_criteria = v as string | null; break
      case 'parent_id': next.parent_id = v as string | null; break
      case 'scheduled_start': next.scheduled_start = v as number | null; break
      case 'scheduled_end': next.scheduled_end = v as number | null; break
      case 'snooze_until': next.snooze_until = v as string | null; break
      case 'estimate_min': next.estimate_min = v as number | null; break
    }
  }
  // preset：updated_at 总被刷新（sqlite handler 里恒定附加）
  next.updated_at = updatedAt
  rows[i] = next
  vaultTodosSave(rows)
  return next
}

/**
 * DELETE FROM schedule_todos WHERE parent_id = ? ; DELETE FROM schedule_todos WHERE id = ?
 * 删除待办并级联删除子任务（NULL parent_id 不会被误删）
 */
export function vaultDeleteTodoCascade(id: string): void {
  vaultTodosSave(vaultTodosAll().filter((r) => r.id !== id && r.parent_id !== id))
  vaultDeleteWorkflowsByTask(id)
}

// ===== 标签 =====

/** SELECT * FROM schedule_tags ORDER BY name */
export function vaultTagsOrdered(): TagRow[] {
  return vaultTagsAll().slice().sort((a, b) => binaryCompare(str(a.name), str(b.name)))
}


/**
 * INSERT INTO schedule_tags (id, name, color) VALUES (?, ?, ?)
 * 说明：表上的 UNIQUE(name) 约束不在 JSON 层复刻（渲染层已防重名，
 * 且 sqlite 路径的 UNIQUE 报错会直接抛出 IPC 异常，两源行为差异仅限重名这一边界）。
 */
export function vaultCreateTag(row: TagRow): TagRow {
  vaultTagsSave([...vaultTagsAll(), row])
  return row
}

/** DELETE FROM schedule_tags WHERE id = ?（与 sqlite 一致：不动引用该标签的待办） */
export function vaultDeleteTag(id: string): void {
  vaultTagsSave(vaultTagsAll().filter((r) => r.id !== id))
}

// ===== 固定日程（recurring） =====
// 存储：.knowbase/modules/schedule/recurring.json；生成的待办 = 普通 TodoRow + recurringId/recurringDue。
// 结算计划走零依赖纯函数 planScheduleRecurringSettle（src/lib/scheduleRecurringPure.ts，渲染层/契约共用）。

const RECUR_FILE = 'recurring.json'

function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function isDate(s: unknown): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) }
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}
function normWeekdays(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : []
  return [...new Set(arr.map((n) => clampInt(n, 0, 6, 0)))].sort((a, b) => a - b)
}

export function vaultScheduleRecurringAll(): ScheduleRecurring[] {
  const rows = readJson<unknown>(MOD, RECUR_FILE, [])
  return Array.isArray(rows) ? (rows as ScheduleRecurring[]) : []
}
function saveRecurring(rows: ScheduleRecurring[]): void {
  writeJsonOrThrow(MOD, RECUR_FILE, rows)
}

export interface CreateScheduleRecurringInput {
  title: string
  freq: 'weekly' | 'monthly' | 'interval'
  weekdays?: number[]
  day?: number | null
  intervalDays?: number | null
  startMin: number
  endMin?: number | null
  taskType?: 'plan' | 'deadline' | 'daily'
  quadrant?: number
  tagId?: string | null
  enabled?: boolean
  endDate?: string
  lastPostedDate?: string
}

export function vaultScheduleCreateRecurring(input: CreateScheduleRecurringInput): ScheduleRecurring {
  const title = String(input.title || '').trim()
  if (!title) throw new Error('标题不能为空')
  const freq: ScheduleRecurring['freq'] = input.freq === 'monthly' || input.freq === 'interval' ? input.freq : 'weekly'
  const startMin = clampInt(input.startMin, 0, 1439, 540)
  const now = new Date().toISOString()
  const row: ScheduleRecurring = {
    id: randomUUID(), title, freq,
    weekdays: freq === 'weekly' ? normWeekdays(input.weekdays) : [],
    day: freq === 'monthly' ? clampInt(input.day, 1, 31, 1) : null,
    intervalDays: freq === 'interval' ? clampInt(input.intervalDays, 1, 3660, 7) : null,
    startMin,
    endMin: clampInt(input.endMin, 1, 1440, startMin + 60),
    taskType: (['plan', 'deadline', 'daily'] as const).includes(input.taskType as 'plan') ? (input.taskType as ScheduleRecurring['taskType']) : 'plan',
    quadrant: clampInt(input.quadrant, 0, 3, 1),
    tagId: input.tagId ? String(input.tagId) : null,
    enabled: input.enabled !== false,
    endDate: isDate(input.endDate) ? String(input.endDate) : '',
    lastPostedDate: isDate(input.lastPostedDate) ? String(input.lastPostedDate) : todayLocal(),
    createdAt: now, updatedAt: now,
  }
  if (row.endMin <= row.startMin) row.endMin = Math.min(1440, row.startMin + 60)
  saveRecurring([...vaultScheduleRecurringAll(), row])
  settleAfterWrite(row)
  return row
}

/** 写侧结算（2026-10-13，F-5）：建 / 改规则之后**立刻**把该生成的待办补齐。
 *
 *  为什么必须写在写侧：结算原来**全仓只有一处调用** —— 日程模块挂载时跑一次（带 `recSettledRef` 守卫，
 *  `src/modules/schedule/index.tsx`）。而模块 Tab 是 `display:none` **保活**的（切 Tab 不卸载）
 *  ⇒ 用户建规则时模块**早就挂过了**，随后的数据变更广播只刷列表、**不会重新结算**
 *  ⇒ 表象 = 规则进了「固定日程」列表、日程表里什么都没有。
 *  （2026-10-13 实机复现：`recurring.json` 4 条规则 / `todos.json` 是空的 `[]`。）
 *
 *  上界：默认仍是「本周日」；但若这条规则的**下一次**落在本周日之后（例如周日建「每周一」），
 *  就取那一次 —— 否则"刚建的这条"要等到下周才看得见。首次应生成日直接复用结算计划纯函数取第一条，
 *  不另写一套迭代（口径永远一致）。
 *  ★ 幂等：结算内部按 `(recurringId, recurringDue)` 去重，重复调用不会重复生成。 */
function settleAfterWrite(rule: ScheduleRecurring, today = todayLocal()): number {
  const first = planScheduleRecurringSettle([rule], vaultTodosAll(), today, addDaysTo(today, 400))[0]?.due
  const horizon = first && first > endOfWeek(today) ? first : endOfWeek(today)
  return vaultScheduleSettleRecurring(today, horizon).added
}

export function vaultScheduleUpdateRecurring(id: string, patch: Partial<ScheduleRecurring>): ScheduleRecurring | null {
  const rows = vaultScheduleRecurringAll()
  const idx = rows.findIndex((r) => r.id === id)
  if (idx < 0) return null
  const next: ScheduleRecurring = { ...rows[idx] }
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim()
  if (patch.freq === 'weekly' || patch.freq === 'monthly' || patch.freq === 'interval') next.freq = patch.freq
  if (patch.weekdays !== undefined) next.weekdays = normWeekdays(patch.weekdays)
  if (patch.day !== undefined) next.day = clampInt(patch.day, 1, 31, 1)
  if (patch.intervalDays !== undefined) next.intervalDays = clampInt(patch.intervalDays, 1, 3660, 7)
  if (next.freq === 'monthly') next.intervalDays = null
  else if (next.freq === 'interval') next.day = null
  if (patch.startMin !== undefined) next.startMin = clampInt(patch.startMin, 0, 1439, 540)
  if (patch.endMin !== undefined) next.endMin = clampInt(patch.endMin, 1, 1440, next.startMin + 60)
  if (next.endMin <= next.startMin) next.endMin = Math.min(1440, next.startMin + 60)
  if (patch.taskType && (['plan', 'deadline', 'daily'] as const).includes(patch.taskType)) next.taskType = patch.taskType
  if (patch.quadrant !== undefined) next.quadrant = clampInt(patch.quadrant, 0, 3, 1)
  if (patch.tagId !== undefined) next.tagId = patch.tagId ? String(patch.tagId) : null
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (typeof patch.endDate === 'string') next.endDate = isDate(patch.endDate) ? patch.endDate : ''
  if (isDate(patch.lastPostedDate)) next.lastPostedDate = String(patch.lastPostedDate)
  next.updatedAt = new Date().toISOString()
  rows[idx] = next
  saveRecurring(rows)
  // 改完也补一次（改了星期几 / 时段 / 重新启用之后，本周该出现的待办要立刻跟上；幂等）
  settleAfterWrite(next)
  return next
}

export function vaultScheduleDeleteRecurring(id: string): boolean {
  const rows = vaultScheduleRecurringAll()
  const next = rows.filter((r) => r.id !== id)
  if (next.length === rows.length) return false
  saveRecurring(next)
  return true
}

export interface ScheduleRecurringSettleResult {
  added: number
  items: Array<{ id: string; ruleId: string; title: string; due: string }>
  /** 撤销用：各规则结算前的 lastPostedDate */
  restore: Array<{ ruleId: string; lastPostedDate: string }>
}

/** 结算（幂等，写盘）：把「应生成但还没生成」的日期补成普通待办，并推进各规则 lastPostedDate。
 *  上界默认 = 本周日（让当周固定日程在「周日程」里可见）；只补 ≤ 上界的日期。 */
export function vaultScheduleSettleRecurring(today = todayLocal(), horizon?: string): ScheduleRecurringSettleResult {
  const rules = vaultScheduleRecurringAll()
  const todos = vaultTodosAll()
  const h = isDate(horizon) ? String(horizon) : endOfWeek(today)
  const plan = planScheduleRecurringSettle(rules, todos, today, h)
  if (plan.length === 0) return { added: 0, items: [], restore: [] }
  const now = new Date().toISOString()
  const ruleMap = new Map(rules.map((r) => [r.id, r]))
  const added: TodoRow[] = []
  const items: ScheduleRecurringSettleResult['items'] = []
  for (const p of plan) {
    const r = ruleMap.get(p.ruleId)
    if (!r) continue
    const todo: TodoRow = {
      id: randomUUID(), title: r.title, description: '', date: p.due, time: null,
      quadrant: r.quadrant, task_type: r.taskType, tag_id: r.tagId, status: 'pending', sort_order: 0,
      end_criteria: '', parent_id: null,
      scheduled_start: r.startMin, scheduled_end: r.endMin, snooze_until: null,
      recurringId: r.id, recurringDue: p.due, estimate_min: null,
      created_at: now, updated_at: now,
    }
    added.push(todo)
    items.push({ id: todo.id, ruleId: r.id, title: r.title, due: p.due })
  }
  if (added.length === 0) return { added: 0, items: [], restore: [] }
  vaultTodosSave([...todos, ...added])
  const restore: ScheduleRecurringSettleResult['restore'] = []
  const nextRules = rules.map((r) => {
    const dues = plan.filter((p) => p.ruleId === r.id).map((p) => p.due).sort()
    if (dues.length === 0) return r
    restore.push({ ruleId: r.id, lastPostedDate: r.lastPostedDate })
    return { ...r, lastPostedDate: dues[dues.length - 1], updatedAt: now }
  })
  saveRecurring(nextRules)
  return { added: added.length, items, restore }
}

/** 撤销一次结算：删掉刚生成的待办 + 把规则 lastPostedDate 还原 */
export function vaultScheduleUndoSettleRecurring(
  todoIds: string[],
  restore: Array<{ ruleId: string; lastPostedDate: string }>,
): number {
  const ids = new Set(todoIds)
  const todos = vaultTodosAll()
  const kept = todos.filter((t) => !ids.has(t.id))
  const removed = todos.length - kept.length
  if (removed > 0) vaultTodosSave(kept)
  if (restore.length > 0) {
    const map = new Map(restore.map((x) => [x.ruleId, x.lastPostedDate]))
    const now = new Date().toISOString()
    saveRecurring(vaultScheduleRecurringAll().map((r) => (map.has(r.id) ? { ...r, lastPostedDate: map.get(r.id)!, updatedAt: now } : r)))
  }
  return removed
}
