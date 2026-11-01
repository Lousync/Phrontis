import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import {
  readQuizRecords, writeQuizRecords,
  readQuizRecordCollections, writeQuizRecordCollections,
  readQuizCollections, writeQuizCollections,
  readQuizTags, writeQuizTags,
  readQuizRecordTags, writeQuizRecordTags,
  vaultLocalToday,
} from 'phrontis-core/kbStore/quizVaultRepo'
import type { VaultQuizRecordRow } from 'phrontis-core/kbStore/quizVaultRepo'

/**
 * 错题本数据管理（「数据」面板后端）。
 *
 * 真相源 = 当前仓库 .knowbase/modules/quiz/*.json（五份裸数组文件），
 * 本模块只做「统计 / 导出备份 / 清理」三件事，不提供任何写入记录的业务通道
 * （记录写入由 quizRepo 的 quizRecord:* 负责）。
 *
 * 历史：本文件原名 quizMigration.ts，承载「主表 ⇄ 插件命名空间表」迁移通道。
 * 错题本由 C 级插件改为内置模块后（R6），插件命名空间桶（plugin_knowbase_quizbook_*）
 * 已成死数据——两个 profile 下 plugin-data.json 均不存在，面板此前恒显示 0 行。
 * 插件通道随之整段删除，本模块改为直接面向 vault 数据，故更名 quizDataAdmin。
 *
 * 口径：所有函数都接受 sourceSpace（'' = 不限空间，= 某学习空间名则只统计/清理该空间），
 * 与错题本界面「按空间分区」保持一致。
 */

/** 错次档位（与 QuizCollection 的 WRONG_BANDS 同口径） */
const BANDS: Array<{ key: string; label: string; min: number; max?: number }> = [
  { key: 'stubborn', label: '顽固错（4 次以上）', min: 4 },
  { key: 'mid', label: '中错（2–3 次）', min: 2, max: 3 },
  { key: 'light', label: '轻错（1 次）', min: 1, max: 1 },
]

/** 已掌握阈值：连续答对 ≥ 2 次即移出错题本（与 quizRepo 一致） */
const MASTER_STREAK = 2

function bandOf(wrongCount: number): string {
  for (const b of BANDS) {
    if (wrongCount >= b.min && (b.max === undefined || wrongCount <= b.max)) return b.key
  }
  return 'light'
}

function scopeFilter(sourceSpace: string) {
  return (r: VaultQuizRecordRow) => !sourceSpace || r.source_space === sourceSpace
}

export interface QuizBookStat {
  /** 书 = 来源笔记本（空间内按知识点分书） */
  name: string
  total: number
  wrong: number
  mastered: number
  favorite: number
}

export interface QuizDataStats {
  /** 统计范围：'' = 全部知识空间；否则为空间名 */
  scope: string
  /** 当前仓库根路径（面板用来告诉用户"存在哪"） */
  vaultRoot: string
  total: number
  wrong: number
  mastered: number
  favorite: number
  notes: number
  todayWrong: number
  correctRate: number
  tags: number
  collections: number
  byBook: QuizBookStat[]
  byBand: Array<{ key: string; label: string; count: number }>
}

/** 错题本数据概览（用户语言口径：题目 / 待复习 / 已掌握 / 收藏 …） */
export function quizDataStats(sourceSpace = ''): QuizDataStats {
  const inScope = scopeFilter(sourceSpace)
  const rows = readQuizRecords().filter(inScope)
  const today = vaultLocalToday()

  let wrong = 0
  let mastered = 0
  let favorite = 0
  let notes = 0
  let todayWrong = 0
  let sumCorrect = 0
  let sumWrong = 0
  const bandCount = new Map(BANDS.map((b) => [b.key, 0]))
  const bookMap = new Map<string, QuizBookStat>()

  for (const r of rows) {
    const hasWrong = (r.wrong_count ?? 0) > 0
    const isMastered = hasWrong && (r.streak_correct ?? 0) >= MASTER_STREAK
    if (hasWrong && !isMastered) {
      wrong += 1
      const k = bandOf(r.wrong_count ?? 0)
      bandCount.set(k, (bandCount.get(k) ?? 0) + 1)
    }
    if (isMastered) mastered += 1
    if (r.is_favorite) favorite += 1
    if ((r.note ?? '').trim()) notes += 1
    if (r.last_result === 0 && (r.updated_at ?? '').slice(0, 10) === today) todayWrong += 1
    sumCorrect += r.correct_count ?? 0
    sumWrong += r.wrong_count ?? 0

    const bookName = r.source_notebook || '未归册'
    if (!bookMap.has(bookName)) bookMap.set(bookName, { name: bookName, total: 0, wrong: 0, mastered: 0, favorite: 0 })
    const b = bookMap.get(bookName)!
    b.total += 1
    if (hasWrong && !isMastered) b.wrong += 1
    if (isMastered) b.mastered += 1
    if (r.is_favorite) b.favorite += 1
  }

  const totalAttempts = sumCorrect + sumWrong
  return {
    scope: sourceSpace,
    vaultRoot: getCurrentVault()?.rootPath ?? '',
    total: rows.length,
    wrong,
    mastered,
    favorite,
    notes,
    todayWrong,
    correctRate: totalAttempts > 0 ? Math.round((sumCorrect / totalAttempts) * 100) : 0,
    tags: readQuizTags().length,
    collections: readQuizCollections().length,
    byBook: Array.from(bookMap.values()).sort((a, b) => b.total - a.total),
    byBand: BANDS.map((b) => ({ key: b.key, label: b.label, count: bandCount.get(b.key) ?? 0 })),
  }
}

/** 导出备份（JSON）：范围 = 当前空间（或全部），落到 userData/backups/ */
export function exportQuizData(sourceSpace = ''): {
  ok: boolean
  path?: string
  count?: number
  error?: string
} {
  try {
    const inScope = scopeFilter(sourceSpace)
    const records = readQuizRecords().filter(inScope)
    const ids = new Set(records.map((r) => r.id))
    const payload = {
      exportedAt: new Date().toISOString(),
      scope: sourceSpace || '全部知识空间',
      vaultRoot: getCurrentVault()?.rootPath ?? '',
      counts: { records: records.length },
      records,
      // 关联行只保留范围内记录；标签/分组定义全量保留（否则导出件还原不出标签名与颜色）
      recordCollections: readQuizRecordCollections().filter((l) => ids.has(l.record_id)),
      recordTags: readQuizRecordTags().filter((l) => ids.has(l.record_id)),
      collections: readQuizCollections(),
      tags: readQuizTags(),
    }
    const dir = join(app.getPath('userData'), 'backups')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, `quiz-backup-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')
    return { ok: true, path: file, count: records.length }
  } catch (e: unknown) {
    return { ok: false, error: String((e as Error)?.message || e) }
  }
}

/** 删除若干记录并同步清掉其分组/标签关联行（避免悬挂关联） */
function dropRecords(pred: (r: VaultQuizRecordRow) => boolean): number {
  const rows = readQuizRecords()
  const gone = new Set(rows.filter(pred).map((r) => r.id))
  if (gone.size === 0) return 0
  writeQuizRecords(rows.filter((r) => !gone.has(r.id)))
  writeQuizRecordCollections(readQuizRecordCollections().filter((l) => !gone.has(l.record_id)))
  writeQuizRecordTags(readQuizRecordTags().filter((l) => !gone.has(l.record_id)))
  return gone.size
}

/** 清空已掌握（连续答对 ≥ 2 次的条目）：已掌握的不再留在错题本里，可安全清理 */
export function clearMasteredQuizData(sourceSpace = ''): { ok: boolean; removed: number; error?: string } {
  try {
    const inScope = scopeFilter(sourceSpace)
    const removed = dropRecords(
      (r) => inScope(r) && (r.wrong_count ?? 0) > 0 && (r.streak_correct ?? 0) >= MASTER_STREAK,
    )
    return { ok: true, removed }
  } catch (e: unknown) {
    return { ok: false, removed: 0, error: String((e as Error)?.message || e) }
  }
}

/**
 * 清空全部错题记录。
 * - 指定空间：只清该空间的记录与关联；标签/分组是全局概念，予以保留
 * - 不限空间（全局重置）：连同标签、分组一起清空，回到全新状态
 * 一律写空数组而非删文件——vault 用「records.json 是否存在」判定已播种，
 * 删文件会被当成"未迁移"，且删除操作在沙箱下不可靠。
 */
export function clearAllQuizData(sourceSpace = ''): { ok: boolean; removed: number; error?: string } {
  try {
    const removed = dropRecords(scopeFilter(sourceSpace))
    if (!sourceSpace) {
      writeQuizCollections([])
      writeQuizTags([])
      writeQuizRecordCollections([])
      writeQuizRecordTags([])
    }
    return { ok: true, removed }
  } catch (e: unknown) {
    return { ok: false, removed: 0, error: String((e as Error)?.message || e) }
  }
}
