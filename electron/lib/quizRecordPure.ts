import type { VaultQuizRecordRow } from './kbStore/quizVaultRepo'

/**
 * 答题痕迹纯函数（零 Electron 依赖，可被 Node 契约脚本直接 import）。
 *
 * `draft_json` 只存答题过程（选项 / 简答草稿 / 是否看过答案 / 自评快照），
 * 不参与错题计数；报告结果才改 last_result / wrong_count / streak_correct。
 */

export interface QuizDraftData {
  picked: string | null
  text: string
  revealed: boolean
  assessedText: string | null
  updatedAt: string | null
}

export type QuizDraftPatch = Partial<Omit<QuizDraftData, 'updatedAt'>>

export const QUIZ_DRAFT_TEXT_MAX = 20000

export function emptyDraft(): QuizDraftData {
  return { picked: null, text: '', revealed: false, assessedText: null, updatedAt: null }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function clampText(v: unknown): string {
  return str(v).slice(0, QUIZ_DRAFT_TEXT_MAX)
}

function normalizeDraft(raw: unknown): QuizDraftData | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const picked = typeof r.picked === 'string' && r.picked ? r.picked : null
  const text = clampText(r.text)
  const revealed = r.revealed === true
  const assessedText = typeof r.assessedText === 'string' ? clampText(r.assessedText) : null
  const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : null
  if (!picked && !text && !revealed && assessedText === null && !updatedAt) return null
  return { picked, text, revealed, assessedText, updatedAt }
}

export function parseDraftJson(raw?: string | null): QuizDraftData | null {
  if (!raw) return null
  try {
    return normalizeDraft(JSON.parse(raw))
  } catch {
    return null
  }
}

export function serializeDraft(draft: QuizDraftData): string {
  return JSON.stringify(draft)
}

export function applyDraftPatch(base: QuizDraftData | null, patch: QuizDraftPatch, now: string): QuizDraftData {
  const cur = base ?? emptyDraft()
  return {
    picked: patch.picked !== undefined ? (patch.picked || null) : cur.picked,
    text: patch.text !== undefined ? clampText(patch.text) : cur.text,
    revealed: patch.revealed !== undefined ? !!patch.revealed : cur.revealed,
    assessedText: patch.assessedText !== undefined
      ? (patch.assessedText == null ? null : clampText(patch.assessedText))
      : cur.assessedText,
    updatedAt: now,
  }
}

export function draftIsEmpty(draft: QuizDraftData | null): boolean {
  if (!draft) return true
  return !draft.picked && !draft.text && !draft.revealed && !draft.assessedText
}

/** 只看最近一次作答结果：错题重做入口的口径（和错题本的 wrong_count 口径不同） */
export function wrongNosOf(records: Array<{ quizNo: number; lastResult: number | null }>): number[] {
  return records.filter(r => r.lastResult === 0).map(r => r.quizNo)
}

type Row = VaultQuizRecordRow

function draftTime(row: Row): string {
  return parseDraftJson(row.draft_json)?.updatedAt ?? row.updated_at ?? ''
}

function minStr(a: string, b: string): string {
  return a && b ? (a < b ? a : b) : (a || b)
}
function maxStr(a: string, b: string): string {
  return a && b ? (a > b ? a : b) : (a || b)
}

function mergeRow(target: Row, old: Row): Row {
  const newerResult = (old.updated_at ?? '') > (target.updated_at ?? '') ? old : target
  const newerDraft = draftTime(old) > draftTime(target) ? old : target
  return {
    ...target,
    page_title: target.page_title || old.page_title,
    is_favorite: target.is_favorite || old.is_favorite ? 1 : 0,
    wrong_count: (target.wrong_count ?? 0) + (old.wrong_count ?? 0),
    correct_count: (target.correct_count ?? 0) + (old.correct_count ?? 0),
    last_result: newerResult.last_result,
    streak_correct: Math.max(target.streak_correct ?? 0, old.streak_correct ?? 0),
    note: target.note || old.note || '',
    source_chapter: target.source_chapter || old.source_chapter || '',
    snapshot_json: newerResult.snapshot_json || target.snapshot_json || old.snapshot_json || '',
    draft_json: newerDraft.draft_json ?? target.draft_json ?? old.draft_json,
    source_space: target.source_space || old.source_space,
    source_notebook: target.source_notebook || old.source_notebook,
    created_at: minStr(target.created_at, old.created_at),
    updated_at: maxStr(target.updated_at, old.updated_at),
  }
}

/**
 * `auto:<rel>` 转正时把记录迁到真 pageId。
 * - 同 quizNo 已有新行 → 合并计数 / 取较新的结果与草稿 / 收藏取 OR / 备注取非空；
 * - 否则直接改 page_id；
 * - 返回 idMap（旧 record id → 保留 record id），供 repo 迁移标签/分组关联。
 */
export function mergeRowsOnPageIdMigration(
  rows: Row[],
  oldPageId: string,
  newPageId: string,
): { rows: Row[]; moved: number; merged: number; idMap: Record<string, string> } {
  if (!oldPageId || !newPageId || oldPageId === newPageId) {
    return { rows, moved: 0, merged: 0, idMap: {} }
  }
  const out: Row[] = rows.filter(r => r.page_id !== oldPageId)
  const byQuizNo = new Map<number, number>()
  out.forEach((r, i) => {
    if (r.page_id === newPageId) byQuizNo.set(r.quiz_no, i)
  })

  let moved = 0
  let merged = 0
  const idMap: Record<string, string> = {}
  for (const old of rows) {
    if (old.page_id !== oldPageId) continue
    const hit = byQuizNo.get(old.quiz_no)
    if (hit === undefined) {
      const row = { ...old, page_id: newPageId }
      byQuizNo.set(old.quiz_no, out.length)
      out.push(row)
      idMap[old.id] = old.id
      moved++
    } else {
      const target = out[hit]
      out[hit] = mergeRow(target, old)
      idMap[old.id] = target.id
      merged++
    }
  }
  return { rows: out, moved, merged, idMap }
}
