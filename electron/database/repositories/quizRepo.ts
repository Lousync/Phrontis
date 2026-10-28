import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { getKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'
import * as V from '../../lib/kbStore/quizVaultRepo'
import { quizDataStats, exportQuizData, clearMasteredQuizData, clearAllQuizData } from '../../lib/quizDataAdmin'
import { broadcastDataChanged } from '../../main/windowBus'
import {
  applyDraftPatch,
  mergeRowsOnPageIdMigration,
  parseDraftJson,
  serializeDraft,
  type QuizDraftPatch,
} from '../../lib/quizRecordPure'

/**
 * R6 去库化：真相源 = .knowbase/modules/quiz/*.json（sql.js 路径已移除，D9）
 *
 * 刷题记录（收藏 + 错题）数据层。
 * 通用能力：408 / 数学 / 英语 / 政治知识包共用一套，靠 source_space 快照区分来源。
 * - 收藏与错题同表（一题一行，按 (page_id, quiz_no) 幂等去重）
 * - 重刷全对自动移出：连续答对次数达到阈值即视为已掌握
 * - 两级分类：source_space 自动维度 + quiz_collections 自定义分组
 * - 五文件对应原五张表，行结构 snake_case 原样
 *
 * 分层（2026-09-12 重构）：
 *   业务函数（export，受控写层，维护关联行/快照等不变量）
 *     └─ 消费方一：registerQuizHandlers 的 IPC handler（渲染层）
 *     └─ 消费方二：builtinTools.ts 的 builtin.quiz.* 内置工具（AI）
 *   handler 一律退化为一层转发 —— 原因：主进程内的 AI 工具没有 ipcRenderer，
 *   无法"再调一次 IPC"复用逻辑，而绕过本文件直接改 JSON 会漏掉关联行同步，
 *   所以业务逻辑必须落在两边都能 import 的普通函数里。
 *
 * 「数据」面板的统计 / 导出备份 / 清理由 quizDataAdmin.ts 管辖（quizData:* 四件套）。
 */

export interface QuizOptionDto { key: string; text: string }

export interface QuizSnapshotDto {
  no: number
  question: string
  options: QuizOptionDto[]
  answer: string
  explanation: string
  type?: 'choice' | 'short'
  referenceAnswer?: string
}

export interface QuizDraftDto {
  picked: string | null
  text: string
  revealed: boolean
  assessedText: string | null
  updatedAt: string | null
}

export interface QuizRecordDto {
  id: string
  pageId: string
  quizNo: number
  pageTitle: string
  isFavorite: boolean
  wrongCount: number
  correctCount: number
  lastResult: number | null
  /** 连续答对次数：>= 2 视为已掌握（从错题本列表移出） */
  streakCorrect: number
  /** 个人备注 */
  note: string
  snapshot: QuizSnapshotDto | null
  sourceSpace: string
  sourceNotebook: string
  /** 题目所在页面的章节路径（笔记本以下的 folder 层级，如"树 › 遍历"） */
  sourceChapter: string
  collectionIds: string[]
  tagIds: string[]
  draft: QuizDraftDto | null
  createdAt: string
  updatedAt: string
}

export interface QuizTagDto {
  id: string
  name: string
  /** topic 考点 / type 题型 / difficulty 难度 / custom 关键词 */
  kind: string
  color: string
  sortOrder: number
  createdAt: string
  count: number
}

export interface QuizCollectionDto {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  count: number
}

/** 错题列表筛选条件（IPC 与 AI 工具共用） */
export interface QuizRecordListOpts {
  kind?: 'favorite' | 'wrong' | 'all'
  sourceSpace?: string
  collectionId?: string
  tagIds?: string[]
}

/** 错题概览统计（错题本头部与 AI 读工具共用） */
export interface QuizRecordStatsDto {
  wrong: number
  mastered: number
  todayWrong: number
  correctRate: number
}

function parseSnapshot(json: string): QuizSnapshotDto | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as QuizSnapshotDto
    if (!v || typeof v !== 'object') return null
    if (v.type === 'short') {
      return { ...v, options: Array.isArray(v.options) ? v.options : [] }
    }
    if (!Array.isArray(v.options)) return null
    return v
  } catch {
    return null
  }
}

// ===== vault 数据层：真相源 = .knowbase/modules/quiz/*.json =====


/** 字符串比较：对齐 sqlite BINARY collation 的码序比较（时间串/UUID 场景与字典序一致） */
function strCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** quiz_record_collections 关联 → 某记录的 collection_id 列表（文件序=插入序，对齐无 ORDER BY 查询） */
function vaultCollectionIdsOf(recordId: string): string[] {
  return V.readQuizRecordCollections().filter((l) => l.record_id === recordId).map((l) => l.collection_id)
}

/** quiz_record_tags 关联 → 某记录的 tag_id 列表 */
function vaultTagIdsOf(recordId: string): string[] {
  return V.readQuizRecordTags().filter((l) => l.record_id === recordId).map((l) => l.tag_id)
}

function vaultRowToDto(row: V.VaultQuizRecordRow): QuizRecordDto {
  return {
    id: row.id,
    pageId: row.page_id,
    quizNo: row.quiz_no,
    pageTitle: row.page_title,
    isFavorite: !!row.is_favorite,
    wrongCount: row.wrong_count ?? 0,
    correctCount: row.correct_count ?? 0,
    lastResult: row.last_result ?? null,
    streakCorrect: row.streak_correct ?? 0,
    note: row.note ?? '',
    snapshot: parseSnapshot(row.snapshot_json),
    sourceSpace: row.source_space,
    sourceNotebook: row.source_notebook,
    sourceChapter: row.source_chapter ?? '',
    collectionIds: vaultCollectionIdsOf(row.id),
    tagIds: vaultTagIdsOf(row.id),
    draft: parseDraftJson(row.draft_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 知识页/分类以知识索引为准：空间 / 笔记本 / 章节路径解析 */
function vaultResolveSource(pageId: string): { space: string; notebook: string; chapter: string } {
  let space = ''
  let notebook = ''
  const idx = getKnowledgeIndex()
  const page = idx.byId[pageId]
  if (!page) return { space, notebook, chapter: '' }
  const catById = new Map(idx.categories.map((c) => [c.id, c]))
  const folders: string[] = []
  let curId: string | null | undefined = page.categoryId
  let guard = 0
  // 逐级上溯直到 space（或根）：note 遇到 notebook 不能 break，
  // 否则「笔记本下」的页面永远解析不到 space，错题本按空间分区会全空。
  while (curId && guard++ < 12) {
    const cat = catById.get(curId)
    if (!cat) break
    if (cat.categoryType === 'space') { space = cat.name; break }
    if (cat.categoryType === 'notebook') {
      if (!notebook) notebook = cat.name
    } else if (cat.categoryType === 'folder' && cat.name) {
      folders.unshift(cat.name)
    }
    curId = cat.parentId
  }
  return { space, notebook, chapter: folders.join(' › ') }
}

/** ensureRecord：按 (page_id, quiz_no) 幂等 find-or-create；新行字段对齐原 INSERT 列 + 建表 DEFAULT */
function vaultEnsureRecord(pageId: string, quizNo: number, meta: {
  pageTitle: string
  snapshot: QuizSnapshotDto | null
}): V.VaultQuizRecordRow {
  const rows = V.readQuizRecords()
  const existing = rows.find((r) => r.page_id === pageId && r.quiz_no === quizNo)
  if (existing) return existing
  const { space, notebook, chapter } = vaultResolveSource(pageId)
  const now = V.vaultLocalNow() // 对齐 datetime('now','localtime') 列默认值
  const row: V.VaultQuizRecordRow = {
    id: randomUUID(),
    page_id: pageId,
    quiz_no: quizNo,
    page_title: meta.pageTitle,
    is_favorite: 0,
    wrong_count: 0,
    correct_count: 0,
    last_result: null,
    streak_correct: 0,
    note: '',
    snapshot_json: meta.snapshot ? JSON.stringify(meta.snapshot) : '',
    source_space: space,
    source_notebook: notebook,
    source_chapter: chapter,
    created_at: now,
    updated_at: now,
  }
  V.writeQuizRecords([...rows, row])
  return row
}

/** 同步 QuizTagDto 的 kind 取值：考点 / 题型 / 难度 / 关键词 */
const TAG_KINDS = ['topic', 'type', 'difficulty', 'custom']
function validKind(k: unknown): string {
  return typeof k === 'string' && TAG_KINDS.includes(k) ? k : 'custom'
}

const TAG_COLORS: Record<string, string> = {
  topic: '#7f77dd', type: '#378add', difficulty: '#ba7517', custom: '#1d9e75',
}

// =====================================================================
// 业务函数（受控写层）：IPC handler 与 AI 内置工具共用同一套实现
// =====================================================================

// ---- 记录 ----

export function quizRecordGetByPage(pageId: string): QuizRecordDto[] {
  if (typeof pageId !== 'string' || !pageId) return []
  // SELECT * WHERE page_id = ? ORDER BY quiz_no ASC
  return V.readQuizRecords()
    .filter((r) => r.page_id === pageId)
    .sort((a, b) => a.quiz_no - b.quiz_no)
    .map(vaultRowToDto)
}

/**
 * 保存作答痕迹：只合并 draft_json（+ 必要时的快照/标题），
 * **不碰** last_result / wrong_count / correct_count / streak_correct / updated_at。
 * 高频写，不广播；界面由 store 乐观更新。
 */
export function quizRecordSaveDraft(
  pageId: string,
  quizNo: number,
  patch: QuizDraftPatch,
  meta: { pageTitle?: string; snapshot?: QuizSnapshotDto },
): QuizRecordDto {
  if (typeof pageId !== 'string' || !pageId) throw new Error('pageId 缺失')
  const no = Number(quizNo)
  if (!Number.isInteger(no)) throw new Error('quizNo 非法')
  const row = vaultEnsureRecord(pageId, no, {
    pageTitle: typeof meta?.pageTitle === 'string' ? meta.pageTitle : '',
    snapshot: meta?.snapshot ?? null,
  })
  const rows = V.readQuizRecords()
  const i = rows.findIndex((r) => r.id === row.id)
  if (i < 0) return vaultRowToDto(row)
  const now = V.vaultLocalNow()
  const draft = applyDraftPatch(parseDraftJson(rows[i].draft_json), patch ?? {}, now)
  rows[i] = {
    ...rows[i],
    draft_json: serializeDraft(draft),
    snapshot_json: meta?.snapshot ? JSON.stringify(meta.snapshot) : rows[i].snapshot_json,
    page_title: meta?.pageTitle || rows[i].page_title,
  }
  V.writeQuizRecords(rows)
  return vaultRowToDto(rows[i])
}

/** 上报一次作答结果（答对累计 streak、答错清零并回流错题本）；幂等 find-or-create */
export function quizRecordReport(pageId: string, quizNo: number, correct: boolean, meta: {
  pageTitle?: string
  snapshot?: QuizSnapshotDto
  /** 选择题本次选的 key；与判题结果同一次写盘，供恢复高亮 */
  picked?: string
}): QuizRecordDto {
  if (typeof pageId !== 'string' || !pageId) throw new Error('pageId 缺失')
  const no = Number(quizNo)
  if (!Number.isInteger(no)) throw new Error('quizNo 非法')
  const row = vaultEnsureRecord(pageId, no, {
    pageTitle: typeof meta?.pageTitle === 'string' ? meta.pageTitle : '',
    snapshot: meta?.snapshot ?? null,
  })
  const rows = V.readQuizRecords()
  const i = rows.findIndex((r) => r.id === row.id)
  if (i < 0) return vaultRowToDto(row)
  const now = V.vaultLocalNow() // 对齐 datetime('now', 'localtime')
  const base = {
    ...rows[i],
    snapshot_json: meta?.snapshot ? JSON.stringify(meta.snapshot) : rows[i].snapshot_json,
    page_title: meta?.pageTitle || rows[i].page_title,
    updated_at: now,
  }
  if (correct) {
    // correct_count+1、streak_correct+1（wrong_count 保留供档位分层）
    rows[i] = {
      ...base,
      correct_count: (rows[i].correct_count ?? 0) + 1,
      streak_correct: (rows[i].streak_correct ?? 0) + 1,
      last_result: 1,
    }
  } else {
    // 答错：wrong_count+1、连续答对清零（回流错题本）
    rows[i] = {
      ...base,
      wrong_count: (rows[i].wrong_count ?? 0) + 1,
      streak_correct: 0,
      last_result: 0,
    }
  }
  // 选择题：picked 与判题结果同一次写盘，刷新后可恢复选项高亮
  if (typeof meta?.picked === 'string' && meta.picked) {
    rows[i].draft_json = serializeDraft(applyDraftPatch(
      parseDraftJson(rows[i].draft_json),
      { picked: meta.picked },
      now,
    ))
  }
  V.writeQuizRecords(rows)
  return vaultRowToDto(rows[i])
}

/**
 * auto:<rel> / draft:<rel> 转正时迁移答题记录。
 * 合并规则见 quizRecordPure；关联表（标签/分组）按 idMap 一起迁移，避免孤儿。
 */
export function quizRecordMigratePageId(oldPageId: string, newPageId: string): { moved: number; merged: number } {
  if (typeof oldPageId !== 'string' || typeof newPageId !== 'string' || !oldPageId || !newPageId || oldPageId === newPageId) {
    return { moved: 0, merged: 0 }
  }
  const rows = V.readQuizRecords()
  const result = mergeRowsOnPageIdMigration(rows, oldPageId, newPageId)
  if (result.moved || result.merged) {
    V.writeQuizRecords(result.rows)
    const oldIds = Object.keys(result.idMap).filter((oldId) => result.idMap[oldId] !== oldId)
    if (oldIds.length > 0) {
      const tagLinks = V.readQuizRecordTags()
      let tagChanged = false
      const tagSeen = new Set<string>()
      const nextTagLinks = tagLinks.map((l) => {
        const nextId = result.idMap[l.record_id]
        if (!nextId || nextId === l.record_id) return l
        tagChanged = true
        return { ...l, record_id: nextId }
      }).filter((l) => {
        if (!oldIds.includes(l.record_id)) {
          const key = `${l.record_id}\u0000${l.tag_id}`
          if (tagSeen.has(key)) return false
          tagSeen.add(key)
        }
        return true
      })
      if (tagChanged) V.writeQuizRecordTags(nextTagLinks)

      const colLinks = V.readQuizRecordCollections()
      let colChanged = false
      const colSeen = new Set<string>()
      const nextColLinks = colLinks.map((l) => {
        const nextId = result.idMap[l.record_id]
        if (!nextId || nextId === l.record_id) return l
        colChanged = true
        return { ...l, record_id: nextId }
      }).filter((l) => {
        if (!oldIds.includes(l.record_id)) {
          const key = `${l.record_id}\u0000${l.collection_id}`
          if (colSeen.has(key)) return false
          colSeen.add(key)
        }
        return true
      })
      if (colChanged) V.writeQuizRecordCollections(nextColLinks)
    }
  }
  return { moved: result.moved, merged: result.merged }
}

export function quizRecordToggleFavorite(pageId: string, quizNo: number, meta: {
  pageTitle?: string
  snapshot?: QuizSnapshotDto
}): QuizRecordDto {
  if (typeof pageId !== 'string' || !pageId) throw new Error('pageId 缺失')
  const no = Number(quizNo)
  if (!Number.isInteger(no)) throw new Error('quizNo 非法')
  const row = vaultEnsureRecord(pageId, no, {
    pageTitle: typeof meta?.pageTitle === 'string' ? meta.pageTitle : '',
    snapshot: meta?.snapshot ?? null,
  })
  const rows = V.readQuizRecords()
  const i = rows.findIndex((r) => r.id === row.id)
  if (i < 0) return vaultRowToDto(row)
  rows[i] = { ...rows[i], is_favorite: rows[i].is_favorite ? 0 : 1, updated_at: V.vaultLocalNow() }
  V.writeQuizRecords(rows)
  return vaultRowToDto(rows[i])
}

/** 置定收藏位（AI 工具用：AI 说得出"收藏"和"取消收藏"，不必依赖 toggle 的隐式状态） */
export function quizRecordSetFavorite(recordId: string, favorite: boolean): QuizRecordDto | null {
  if (typeof recordId !== 'string' || !recordId) throw new Error('recordId 缺失')
  const rows = V.readQuizRecords()
  const i = rows.findIndex((r) => r.id === recordId)
  if (i < 0) return null
  rows[i] = { ...rows[i], is_favorite: favorite ? 1 : 0, updated_at: V.vaultLocalNow() }
  V.writeQuizRecords(rows)
  return vaultRowToDto(rows[i])
}

export function quizRecordList(opts?: QuizRecordListOpts): QuizRecordDto[] {
  const kind = opts?.kind ?? 'all'
  const sourceSpace = typeof opts?.sourceSpace === 'string' && opts.sourceSpace ? opts.sourceSpace : ''
  const collectionId = typeof opts?.collectionId === 'string' && opts.collectionId ? opts.collectionId : ''
  // 标签筛选：命中任一选中标签即算匹配
  const tagIds = Array.isArray(opts?.tagIds) ? opts!.tagIds!.filter(t => typeof t === 'string' && t) : []
  // EXISTS 子查询 → 关联表 join：先归约成命中记录 id 集合
  const colHit = collectionId
    ? new Set(V.readQuizRecordCollections().filter((l) => l.collection_id === collectionId).map((l) => l.record_id))
    : null
  const tagHit = tagIds.length > 0
    ? new Set(V.readQuizRecordTags().filter((l) => tagIds.includes(l.tag_id)).map((l) => l.record_id))
    : null
  const matchKind = (r: V.VaultQuizRecordRow): boolean => {
    const hasWrong = (r.wrong_count ?? 0) > 0 && (r.streak_correct ?? 0) < 2
    if (kind === 'favorite') return !!r.is_favorite
    if (kind === 'wrong') return hasWrong
    return !!r.is_favorite || hasWrong
  }
  return V.readQuizRecords()
    .filter((r) => matchKind(r)
      && (!sourceSpace || r.source_space === sourceSpace)
      && (!colHit || colHit.has(r.id))
      && (!tagHit || tagHit.has(r.id)))
    .sort((a, b) => strCmp(b.updated_at ?? '', a.updated_at ?? '') || strCmp(a.page_id, b.page_id) || a.quiz_no - b.quiz_no)
    .map(vaultRowToDto)
}

/** 按 (pageId, quizNo) 移除；关联行同步清理 */
export function quizRecordRemove(pageId: string, quizNo: number): void {
  const no = Number(quizNo)
  const row = V.readQuizRecords().find((r) => r.page_id === pageId && r.quiz_no === no)
  if (!row) return
  removeRelationsOf(row.id)
  V.writeQuizRecords(V.readQuizRecords().filter((r) => r.id !== row.id))
}

/** 按记录 id 移除（AI 工具用：列表给的是 id，不必回推 pageId+quizNo） */
export function quizRecordRemoveById(recordId: string): boolean {
  if (typeof recordId !== 'string' || !recordId) return false
  const row = V.readQuizRecords().find((r) => r.id === recordId)
  if (!row) return false
  removeRelationsOf(row.id)
  V.writeQuizRecords(V.readQuizRecords().filter((r) => r.id !== row.id))
  return true
}

/**
 * 清除某记录的两张关联表行。
 * 修正 v1 遗留：原 quizRecord:remove 只清了 collections，漏掉 tags —— 孤立标签关联
 * 会让 quizTag:list 的 count 虚高（标签看着有 N 道题，点进去是空的）。
 */
function removeRelationsOf(recordId: string): void {
  V.writeQuizRecordCollections(V.readQuizRecordCollections().filter((l) => l.record_id !== recordId))
  V.writeQuizRecordTags(V.readQuizRecordTags().filter((l) => l.record_id !== recordId))
}

export function quizRecordSetCollections(recordId: string, collectionIds: string[]): void {
  if (typeof recordId !== 'string' || !recordId) throw new Error('recordId 缺失')
  // DELETE + 逐条 INSERT OR IGNORE（联合主键去重）：整体重写该记录的关联行
  const kept = V.readQuizRecordCollections().filter((l) => l.record_id !== recordId)
  const seen = new Set<string>()
  for (const cid of Array.isArray(collectionIds) ? collectionIds : []) {
    if (typeof cid !== 'string' || !cid || seen.has(cid)) continue
    seen.add(cid)
    kept.push({ record_id: recordId, collection_id: cid })
  }
  V.writeQuizRecordCollections(kept)
}

/** 单条记录的分组 id 列表（AI 追加分组需要"现有 + 新增"） */
export function quizRecordCollectionIds(recordId: string): string[] {
  if (typeof recordId !== 'string' || !recordId) return []
  return vaultCollectionIdsOf(recordId)
}

/** 单题设置标签（整体覆盖） */
export function quizRecordSetTags(recordId: string, tagIds: string[]): void {
  if (typeof recordId !== 'string' || !recordId) throw new Error('recordId 缺失')
  // DELETE + 逐条 INSERT OR IGNORE（联合主键去重）：整体重写该记录的标签关联
  const kept = V.readQuizRecordTags().filter((l) => l.record_id !== recordId)
  const seen = new Set<string>()
  for (const tid of Array.isArray(tagIds) ? tagIds : []) {
    if (typeof tid !== 'string' || !tid || seen.has(tid)) continue
    seen.add(tid)
    kept.push({ record_id: recordId, tag_id: tid })
  }
  V.writeQuizRecordTags(kept)
}

/** 批量打标：给多条记录追加标签（去重） */
export function quizRecordAddTags(recordIds: string[], tagIds: string[]): void {
  const rids = Array.isArray(recordIds) ? recordIds.filter(x => typeof x === 'string' && x) : []
  const tids = Array.isArray(tagIds) ? tagIds.filter(x => typeof x === 'string' && x) : []
  if (rids.length === 0 || tids.length === 0) return
  // 全矩阵 INSERT OR IGNORE：已存在的 (record_id, tag_id) 跳过
  const links = V.readQuizRecordTags()
  const have = new Set(links.map((l) => `${l.record_id}\u0000${l.tag_id}`))
  for (const rid of rids) {
    for (const tid of tids) {
      const key = `${rid}\u0000${tid}`
      if (have.has(key)) continue
      have.add(key)
      links.push({ record_id: rid, tag_id: tid })
    }
  }
  V.writeQuizRecordTags(links)
}

/** 写个人备注（仅更新 note，不触碰 updated_at，避免把旧错题顶到列表最前） */
export function quizRecordSetNote(recordId: string, note: string): void {
  if (typeof recordId !== 'string' || !recordId) throw new Error('recordId 缺失')
  const text = typeof note === 'string' ? note.slice(0, 500) : ''
  const rows = V.readQuizRecords()
  const i = rows.findIndex((r) => r.id === recordId)
  if (i >= 0) {
    rows[i] = { ...rows[i], note: text }
    V.writeQuizRecords(rows)
  }
}

export function quizRecordStats(opts?: { sourceSpace?: string }): QuizRecordStatsDto {
  const space = typeof opts?.sourceSpace === 'string' && opts.sourceSpace ? opts.sourceSpace : ''
  const rows = V.readQuizRecords().filter((r) => !space || r.source_space === space)
  const today = V.vaultLocalToday() // date('now','localtime')
  let wrong = 0
  let mastered = 0
  let todayWrong = 0
  let sumCorrect = 0
  let sumWrong = 0
  for (const r of rows) {
    const hasWrong = (r.wrong_count ?? 0) > 0
    const sc = r.streak_correct ?? 0
    if (hasWrong && sc < 2) wrong += 1
    if (hasWrong && sc >= 2) mastered += 1
    // date(r.updated_at) = date('now','localtime')：'YYYY-MM-DD HH:MM:SS' 取前 10 位即日期
    if (r.last_result === 0 && (r.updated_at ?? '').slice(0, 10) === today) todayWrong += 1
    sumCorrect += r.correct_count ?? 0
    sumWrong += r.wrong_count ?? 0
  }
  const total = sumCorrect + sumWrong
  return {
    wrong,
    mastered,
    todayWrong,
    correctRate: total > 0 ? Math.round((sumCorrect / total) * 100) : 0,
  }
}

// ---- 标签 ----

export function quizTagList(): QuizTagDto[] {
  // ORDER BY sort_order ASC, created_at ASC；count 由关联表计数
  const rows = V.readQuizTags().sort((a, b) => a.sort_order - b.sort_order || strCmp(a.created_at ?? '', b.created_at ?? ''))
  const links = V.readQuizRecordTags()
  return rows.map(t => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    color: t.color || TAG_COLORS[t.kind] || '#888780',
    sortOrder: t.sort_order,
    createdAt: t.created_at,
    count: links.filter((l) => l.tag_id === t.id).length,
  })) as QuizTagDto[]
}

export function quizTagCreate(name: string, kind?: string): QuizTagDto {
  const nm = typeof name === 'string' ? name.trim().slice(0, 24) : ''
  if (!nm) throw new Error('标签名缺失')
  const k = validKind(kind)
  // 唯一索引 (name, kind) 等义：按 name+kind 查找，命中即原样返回（含 count: 0 的现语义）
  const exist = V.readQuizTags().find((t) => t.name === nm && t.kind === k)
  if (exist) {
    return { id: exist.id, name: exist.name, kind: exist.kind, color: exist.color, sortOrder: exist.sort_order, createdAt: exist.created_at, count: 0 } as QuizTagDto
  }
  const id = randomUUID()
  // COALESCE(MAX(sort_order), -1) + 1
  const tags = V.readQuizTags()
  const maxOrder = tags.reduce((m, t) => Math.max(m, t.sort_order), -1) + 1
  V.writeQuizTags([...tags, { id, name: nm, kind: k, color: TAG_COLORS[k] ?? '', sort_order: maxOrder, created_at: V.vaultLocalNow() }])
  // 保持原语义：该分支不回填 createdAt，保持 ''
  return { id, name: nm, kind: k, color: TAG_COLORS[k] ?? '', sortOrder: maxOrder, createdAt: '', count: 0 } as QuizTagDto
}

/**
 * 按「名字」解析标签 id，不存在则按 kind 新建。
 * AI 是按标签名思考的（"给这些题打上'二叉树遍历'"），需要这个名字→id 的桥；
 * 查找刻意只按 name（不按 name+kind），否则 AI 换个 kind 就会建出同名重复标签。
 */
export function quizTagResolveOrCreate(name: string, kind = 'custom'): QuizTagDto {
  const nm = typeof name === 'string' ? name.trim().slice(0, 24) : ''
  if (!nm) throw new Error('标签名缺失')
  const exist = V.readQuizTags().find((t) => t.name === nm)
  if (exist) {
    return {
      id: exist.id, name: exist.name, kind: exist.kind,
      color: exist.color || TAG_COLORS[exist.kind] || '#888780',
      sortOrder: exist.sort_order, createdAt: exist.created_at,
      count: V.readQuizRecordTags().filter((l) => l.tag_id === exist.id).length,
    } as QuizTagDto
  }
  return quizTagCreate(nm, kind)
}

export function quizTagDelete(tagId: string): void {
  if (typeof tagId !== 'string' || !tagId) return
  V.writeQuizRecordTags(V.readQuizRecordTags().filter((l) => l.tag_id !== tagId))
  V.writeQuizTags(V.readQuizTags().filter((t) => t.id !== tagId))
}

// ---- 自定义分组 ----

export function quizCollectionList(): QuizCollectionDto[] {
  // ORDER BY sort_order ASC, created_at ASC；count 由关联表计数
  const cols = V.readQuizCollections().sort((a, b) => a.sort_order - b.sort_order || strCmp(a.created_at ?? '', b.created_at ?? ''))
  const links = V.readQuizRecordCollections()
  return cols.map(c => ({
    id: c.id,
    name: c.name,
    sortOrder: c.sort_order,
    createdAt: c.created_at,
    count: links.filter((l) => l.collection_id === c.id).length,
  })) as QuizCollectionDto[]
}

export function quizCollectionCreate(name: string): QuizCollectionDto {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new Error('分组名不能为空')
  if (n.length > 50) throw new Error('分组名过长')
  const cols = V.readQuizCollections()
  const id = randomUUID()
  // COALESCE(MAX(sort_order), -1) + 1
  const maxOrder = cols.reduce((m, c) => Math.max(m, c.sort_order), -1) + 1
  const created: V.VaultQuizCollectionRow = { id, name: n, sort_order: maxOrder, created_at: V.vaultLocalNow() }
  V.writeQuizCollections([...cols, created])
  // 回读整行 + count: 0
  return { id: created.id, name: created.name, sortOrder: created.sort_order, createdAt: created.created_at, count: 0 } as QuizCollectionDto
}

/** 按名字解析分组 id，不存在则新建（AI 工具的名字→id 桥，同 quizTagResolveOrCreate） */
export function quizCollectionResolveOrCreate(name: string): QuizCollectionDto {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new Error('分组名不能为空')
  const exist = V.readQuizCollections().find((c) => c.name === n)
  if (exist) {
    return {
      id: exist.id, name: exist.name, sortOrder: exist.sort_order, createdAt: exist.created_at,
      count: V.readQuizRecordCollections().filter((l) => l.collection_id === exist.id).length,
    } as QuizCollectionDto
  }
  return quizCollectionCreate(n)
}

export function quizCollectionRename(id: string, name: string): QuizCollectionDto {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new Error('分组名不能为空')
  if (n.length > 50) throw new Error('分组名过长')
  const cols = V.readQuizCollections()
  const i = cols.findIndex((c) => c.id === id)
  if (i < 0) throw new Error('分组不存在')
  cols[i] = { ...cols[i], name: n }
  V.writeQuizCollections(cols)
  return {
    id: cols[i].id,
    name: cols[i].name,
    sortOrder: cols[i].sort_order,
    createdAt: cols[i].created_at,
    count: V.readQuizRecordCollections().filter((l) => l.collection_id === id).length,
  } as QuizCollectionDto
}

export function quizCollectionDelete(id: string): void {
  V.writeQuizRecordCollections(V.readQuizRecordCollections().filter((l) => l.collection_id !== id))
  V.writeQuizCollections(V.readQuizCollections().filter((c) => c.id !== id))
}

// =====================================================================
// IPC 注册：handler 只做转发，逻辑全在上面
// =====================================================================

export function registerQuizHandlers(deps?: { getSettingValue?: (key: string) => unknown }): void {
  // ===== 记录 =====
  ipcMain.handle('quizRecord:getByPage', (_e, pageId: string) => quizRecordGetByPage(pageId))
  ipcMain.handle('quizRecord:report', (_e, pageId: string, quizNo: number, correct: boolean, meta: {
    pageTitle?: string
    snapshot?: QuizSnapshotDto
    picked?: string
  }) => {
    const row = quizRecordReport(pageId, quizNo, correct, meta)
    // 低频（判题/自评）——错题本、收藏、统计的 useDataChanged('quiz') 消费者需要刷新
    broadcastDataChanged('quiz')
    return row
  })
  ipcMain.handle('quizRecord:saveDraft', (_e, pageId: string, quizNo: number, patch: QuizDraftPatch, meta: {
    pageTitle?: string
    snapshot?: QuizSnapshotDto
  }) => quizRecordSaveDraft(pageId, quizNo, patch, meta))
  ipcMain.handle('quizRecord:migratePageId', (_e, oldPageId: string, newPageId: string) => quizRecordMigratePageId(oldPageId, newPageId))
  ipcMain.handle('quizRecord:toggleFavorite', (_e, pageId: string, quizNo: number, meta: {
    pageTitle?: string
    snapshot?: QuizSnapshotDto
  }) => quizRecordToggleFavorite(pageId, quizNo, meta))
  ipcMain.handle('quizRecord:list', (_e, opts?: QuizRecordListOpts) => quizRecordList(opts))
  ipcMain.handle('quizRecord:remove', (_e, pageId: string, quizNo: number) => { quizRecordRemove(pageId, quizNo) })
  ipcMain.handle('quizRecord:setCollections', (_e, recordId: string, collectionIds: string[]) => { quizRecordSetCollections(recordId, collectionIds) })
  ipcMain.handle('quizRecord:setTags', (_e, recordId: string, tagIds: string[]) => { quizRecordSetTags(recordId, tagIds) })
  ipcMain.handle('quizRecord:addTags', (_e, recordIds: string[], tagIds: string[]) => { quizRecordAddTags(recordIds, tagIds) })
  ipcMain.handle('quizRecord:setNote', (_e, recordId: string, note: string) => { quizRecordSetNote(recordId, note) })
  ipcMain.handle('quizRecord:stats', (_e, opts?: { sourceSpace?: string }) => quizRecordStats(opts))

  // ===== 标签 =====
  ipcMain.handle('quizTag:list', () => quizTagList())
  ipcMain.handle('quizTag:create', (_e, name: string, kind?: string) => quizTagCreate(name, kind))
  ipcMain.handle('quizTag:delete', (_e, tagId: string) => { quizTagDelete(tagId) })

  // ===== 自定义分组 =====
  ipcMain.handle('quizCollection:list', () => quizCollectionList())
  ipcMain.handle('quizCollection:create', (_e, name: string) => quizCollectionCreate(name))
  ipcMain.handle('quizCollection:rename', (_e, id: string, name: string) => quizCollectionRename(id, name))
  ipcMain.handle('quizCollection:delete', (_e, id: string) => { quizCollectionDelete(id) })

  // ===== 错题本「数据」面板通道（quizDataAdmin.ts 管辖） =====
  // 面向当前仓库 vault 的真实错题数据：概览统计 / 导出备份 / 清空已掌握 / 清空全部。
  // 原「插件命名空间表」回收三件套（quizMigrate:*）已随错题本内置化删除。

  ipcMain.handle('quizData:stats', (_e, opts?: { sourceSpace?: string }) =>
    quizDataStats(typeof opts?.sourceSpace === 'string' ? opts.sourceSpace : ''))
  ipcMain.handle('quizData:export', (_e, opts?: { sourceSpace?: string }) =>
    exportQuizData(typeof opts?.sourceSpace === 'string' ? opts.sourceSpace : ''))
  ipcMain.handle('quizData:clearMastered', (_e, opts?: { sourceSpace?: string }) =>
    clearMasteredQuizData(typeof opts?.sourceSpace === 'string' ? opts.sourceSpace : ''))
  ipcMain.handle('quizData:clearAll', (_e, opts?: { sourceSpace?: string }) =>
    clearAllQuizData(typeof opts?.sourceSpace === 'string' ? opts.sourceSpace : ''))
}
