import { randomUUID } from 'crypto'
import { exists, readJson, writeJsonOrThrow } from './jsonStore'

/**
 * 打卡模块 vault 数据仓库（去库化：storageData=vault 时 habits / habit_records 的真相源）。
 *
 * 存储：`.knowbase/modules/checkin/{habits.json, records.json}`（两文件都是表行的 JSON 数组）。
 * 行结构与 sql.js 表列同名（snake_case 原样），因此可被整表播种（ensureCheckinVaultSeeded）、
 * 导出/导入与后续清理器直接复用，不做 camelCase 转换 —— 对外 DTO 由 checkinRepo 负责映射。
 *
 * 说明：
 * - `rule_days` 在表里就是 JSON 字符串列，这里同样按字符串原样存（如 "[1,2,3,4,5]"）
 * - `archived` 沿用表的 0/1 整数语义
 * - habit_records 的 UNIQUE(habit_id, date) 用 vaultHabitRecordAddIfAbsent 复刻（INSERT OR IGNORE）
 * - 本仓库不做排序：ORDER BY 语义由消费方在内存中完成，避免多处写入时争抢顺序
 * - habit_links 不在本次范围内（仍由 sqlite 承载，见 checkinRepo 注释）
 */

export interface HabitRow {
  id: string; name: string; color: string; icon: string
  rule_type: string; rule_days: string; weekly_target: number
  sort_order: number; archived: number
  created_at: string; updated_at: string
}

export interface RecordRow { id: string; habit_id: string; date: string; source: string }

const MOD = 'modules/checkin'
const HABITS_FILE = 'habits.json'
const RECORDS_FILE = 'records.json'

function readHabits(): HabitRow[] { return readJson<HabitRow[]>(MOD, HABITS_FILE, []) }
function readRecords(): RecordRow[] { return readJson<RecordRow[]>(MOD, RECORDS_FILE, []) }

/** habits.json 已存在（区分「未播种」与「已迁 vault 但当前为空」，播种幂等的判据） */
export function vaultHabitsExists(): boolean {
  return exists(MOD, HABITS_FILE)
}

/** 全量习惯行（文件原始顺序，未排序） */
export function vaultHabitsAll(): HabitRow[] {
  return readHabits()
}

/** 整表写回习惯行 */
export function vaultHabitsSave(rows: HabitRow[]): void {
  writeJsonOrThrow(MOD, HABITS_FILE, rows)
}

/** 全量打卡记录行（文件原始顺序，未排序） */
export function vaultRecordsAll(): RecordRow[] {
  return readRecords()
}

/** 整表写回打卡记录行 */
export function vaultRecordsSave(rows: RecordRow[]): void {
  writeJsonOrThrow(MOD, RECORDS_FILE, rows)
}

/**
 * 新增一条打卡记录，若 (habit_id, date) 已存在则忽略（对标 INSERT OR IGNORE）。
 * 返回是否真的新增。
 */
export function vaultHabitRecordAddIfAbsent(habitId: string, date: string, source: string): boolean {
  const rows = readRecords()
  if (rows.some((r) => r.habit_id === habitId && r.date === date)) return false
  rows.push({ id: randomUUID(), habit_id: habitId, date, source })
  writeJsonOrThrow(MOD, RECORDS_FILE, rows)
  return true
}

/** 删除某习惯某天的打卡记录（对标 UNIQUE(habit_id, date) 上的 DELETE） */
export function vaultHabitRecordRemove(habitId: string, date: string): void {
  writeJsonOrThrow(MOD, RECORDS_FILE, readRecords().filter((r) => !(r.habit_id === habitId && r.date === date)))
}

// v3.2.0 条目 14：「习惯跨模块联动自动打卡」整条拔线 —— 原先这里三个成员
// （HabitLinkRow / vaultHabitLinksAll / vaultHabitLinksSave，读写 links.json）已一并移除。
// 磁盘上遗留的 links.json 不再读取、不做迁移（已无其他消费方，留原样不碍事）。
