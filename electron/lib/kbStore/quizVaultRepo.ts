import { exists, readJson, writeJson } from './jsonStore'

/**
 * 错题本 vault 数据仓库（去库化 P2，storageData=vault）
 *
 * 存储：.knowbase/modules/quiz/
 *   records.json           ← quiz_records
 *   collections.json       ← quiz_collections
 *   record-collections.json← quiz_record_collections
 *   tags.json              ← quiz_tags
 *   record-tags.json       ← quiz_record_tags
 * 均为裸数组，一元素=一行；行结构与 sql.js 表完全一致（snake_case 原样保留，
 * 播种时整表 SELECT * 直接落盘，与迁移器/导出产物兼容，避免双格式）。
 * DTO 转换（camelCase）与 SQL 语义复刻（筛选/排序/统计）留在
 * electron/database/repositories/quizRepo.ts，两种模式共用同一 rowToDto 形状。
 */

/** quiz_records 行（streak_correct/note/source_chapter 为 052/053 补列，老数据可能缺失） */
export interface VaultQuizRecordRow {
  id: string
  page_id: string
  quiz_no: number
  page_title: string
  is_favorite: number
  wrong_count: number
  correct_count: number
  last_result: number | null
  streak_correct?: number
  note?: string
  source_chapter?: string
  snapshot_json: string
  source_space: string
  source_notebook: string
  created_at: string
  updated_at: string
}

/** quiz_collections 行 */
export interface VaultQuizCollectionRow {
  id: string
  name: string
  sort_order: number
  created_at: string
}

/** quiz_record_collections 行（联合主键 record_id+collection_id） */
export interface VaultQuizRecordCollectionRow {
  record_id: string
  collection_id: string
}

/** quiz_tags 行 */
export interface VaultQuizTagRow {
  id: string
  name: string
  kind: string
  color: string
  sort_order: number
  created_at: string
}

/** quiz_record_tags 行（联合主键 record_id+tag_id） */
export interface VaultQuizRecordTagRow {
  record_id: string
  tag_id: string
}

/** 播种一次性入参：五表全量行 */
export interface VaultQuizSeedData {
  records: VaultQuizRecordRow[]
  collections: VaultQuizCollectionRow[]
  recordCollections: VaultQuizRecordCollectionRow[]
  tags: VaultQuizTagRow[]
  recordTags: VaultQuizRecordTagRow[]
}

const MOD = 'modules/quiz'
const F_RECORDS = 'records.json'
const F_COLLECTIONS = 'collections.json'
const F_RECORD_COLLECTIONS = 'record-collections.json'
const F_TAGS = 'tags.json'
const F_RECORD_TAGS = 'record-tags.json'

/** sqlite `datetime('now','localtime')` 等价：本地 'YYYY-MM-DD HH:MM:SS' */
export function vaultLocalNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** sqlite `date('now','localtime')` 等价：本地 'YYYY-MM-DD' */
export function vaultLocalToday(): string {
  return vaultLocalNow().slice(0, 10)
}


// ===== 低层读写（保序：读回即文件数组序 = 插入序，与 sqlite 无 ORDER BY 查询一致） =====

export function readQuizRecords(): VaultQuizRecordRow[] {
  return readJson<VaultQuizRecordRow[]>(MOD, F_RECORDS, [])
}
export function writeQuizRecords(rows: VaultQuizRecordRow[]): void {
  writeJson(MOD, F_RECORDS, rows)
}

export function readQuizCollections(): VaultQuizCollectionRow[] {
  return readJson<VaultQuizCollectionRow[]>(MOD, F_COLLECTIONS, [])
}
export function writeQuizCollections(rows: VaultQuizCollectionRow[]): void {
  writeJson(MOD, F_COLLECTIONS, rows)
}

export function readQuizRecordCollections(): VaultQuizRecordCollectionRow[] {
  return readJson<VaultQuizRecordCollectionRow[]>(MOD, F_RECORD_COLLECTIONS, [])
}
export function writeQuizRecordCollections(rows: VaultQuizRecordCollectionRow[]): void {
  writeJson(MOD, F_RECORD_COLLECTIONS, rows)
}

export function readQuizTags(): VaultQuizTagRow[] {
  return readJson<VaultQuizTagRow[]>(MOD, F_TAGS, [])
}
export function writeQuizTags(rows: VaultQuizTagRow[]): void {
  writeJson(MOD, F_TAGS, rows)
}

export function readQuizRecordTags(): VaultQuizRecordTagRow[] {
  return readJson<VaultQuizRecordTagRow[]>(MOD, F_RECORD_TAGS, [])
}
export function writeQuizRecordTags(rows: VaultQuizRecordTagRow[]): void {
  writeJson(MOD, F_RECORD_TAGS, rows)
}
