import { exists, readJson, writeJsonOrThrow } from './jsonStore'

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
    .filter((r) => isNull(r.parent_id) && (r.date === date || (r.task_type === 'plan' && r.status === 'pending')))
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
    .filter((r) => !isNull(r.date) && str(r.date) < today && r.status === 'pending'
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
    .filter((r) => isNull(r.parent_id) && (likePrefix(r.date, yearMonth) || (r.task_type === 'plan' && r.status === 'pending')))
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
  | 'scheduled_start' | 'scheduled_end' | 'snooze_until'

const TODO_COLUMNS: TodoColumn[] = ['title', 'description', 'date', 'time', 'quadrant', 'task_type', 'tag_id', 'status', 'end_criteria', 'parent_id', 'scheduled_start', 'scheduled_end', 'snooze_until']

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
