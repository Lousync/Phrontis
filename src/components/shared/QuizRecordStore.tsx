import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { QuizDraftDto, QuizRecordDto, QuizSnapshotDto } from '../../types'
import {
  knowledgeFindByRel,
  quizRecordGetByPage,
  quizRecordMigratePageId,
  quizRecordReport,
  quizRecordSaveDraft,
  quizRecordToggleFavorite,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { useDataChanged } from '../../lib/dataChanged'

export interface QuizStoreOptions {
  /** 知识页 id；auto:/draft: 时 store 会尝试用 relPath 解析真 id */
  pageId?: string
  /** 仓库相对路径（工件栏只有 relPath） */
  relPath?: string
  pageTitle?: string
}

export interface QuizDraftPatch {
  picked?: string | null
  text?: string
  revealed?: boolean
  assessedText?: string | null
}

export interface QuizStoreSummary {
  answered: number
  wrong: number
  drafts: number
}

const EMPTY_RECORDS: QuizRecordDto[] = []
const EMPTY_SUMMARY: QuizStoreSummary = { answered: 0, wrong: 0, drafts: 0 }
const NOOP = () => {}

function nowLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function emptyDraft(): QuizDraftDto {
  return { picked: null, text: '', revealed: false, assessedText: null, updatedAt: null }
}

function isVirtualPageId(id: string): boolean {
  return id.startsWith('auto:') || id.startsWith('draft:')
}

function syntheticRecord(pageId: string, no: number, pageTitle: string, snapshot: QuizSnapshotDto | null): QuizRecordDto {
  return {
    id: `pending:${pageId}:${no}`,
    pageId,
    quizNo: no,
    pageTitle,
    isFavorite: false,
    wrongCount: 0,
    correctCount: 0,
    lastResult: null,
    streakCorrect: 0,
    note: '',
    snapshot,
    sourceSpace: '',
    sourceNotebook: '',
    sourceChapter: '',
    collectionIds: [],
    tagIds: [],
    draft: null,
    createdAt: '',
    updatedAt: '',
  }
}

function newerDraft(a: QuizDraftDto | null, b: QuizDraftDto | null): QuizDraftDto | null {
  if (!a) return b
  if (!b) return a
  return (a.updatedAt ?? '') > (b.updatedAt ?? '') ? a : b
}

/**
 * 页面级答题记录 store。
 *
 * 为什么不用 Context 里的 records 对象直接广播：
 * 40+ 题的长题单里，一次草稿保存如果让整棵题卡树重渲染会明显发卡。
 * 这里用 useSyncExternalStore + 按 quizNo 的稳定快照，只有变更的那张卡会重渲染；
 * 题单条订阅整个列表，单独重渲染。
 */
class QuizRecordStore {
  private opts: Required<QuizStoreOptions> = { pageId: '', relPath: '', pageTitle: '' }
  private effectivePageId = ''
  private records = new Map<number, QuizRecordDto>()
  private allSnapshot: QuizRecordDto[] = EMPTY_RECORDS
  private summarySnapshot: QuizStoreSummary = { answered: 0, wrong: 0, drafts: 0 }
  private wrongSnapshot: Set<number> = new Set()
  private listeners = new Set<() => void>()
  private queueByNo = new Map<number, Promise<boolean>>()
  private migrateTried = new Set<string>()
  private fetchSeq = 0
  private configSeq = 0
  private disposed = false
  private configuredKey = ''
  private toastShown = false

  get active(): boolean {
    return !!this.effectivePageId
  }

  get pageId(): string {
    return this.effectivePageId
  }

  get pageTitle(): string {
    return this.opts.pageTitle
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  getRecord = (no: number): QuizRecordDto | null => this.records.get(no) ?? null

  getRecords = (): QuizRecordDto[] => this.allSnapshot

  getSummary = (): QuizStoreSummary => this.summarySnapshot

  getWrongNos = (): Set<number> => this.wrongSnapshot

  private emit(): void {
    for (const l of this.listeners) {
      try { l() } catch { /* 单个订阅者失败不影响其他卡片 */ }
    }
  }

  private rebuild(): void {
    this.allSnapshot = Array.from(this.records.values()).sort((a, b) => a.quizNo - b.quizNo)
    let answered = 0
    let wrong = 0
    let drafts = 0
    const wrongNos = new Set<number>()
    for (const r of this.allSnapshot) {
      if (r.lastResult != null) answered++
      if (r.lastResult === 0) { wrong++; wrongNos.add(r.quizNo) }
      if (r.lastResult == null && (r.draft?.text ?? '')) drafts++
    }
    this.summarySnapshot = { answered, wrong, drafts }
    this.wrongSnapshot = wrongNos
    this.emit()
  }

  async configure(opts: QuizStoreOptions): Promise<void> {
    const next = {
      pageId: String(opts.pageId ?? ''),
      relPath: String(opts.relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, ''),
      pageTitle: String(opts.pageTitle ?? ''),
    }
    const key = `${next.pageId}\u0000${next.relPath}`
    this.opts = next
    if (key === this.configuredKey) return
    this.configuredKey = key
    const seq = ++this.configSeq
    this.fetchSeq++
    this.records.clear()
    this.queueByNo.clear()
    this.effectivePageId = ''
    this.rebuild()
    if (!next.pageId && !next.relPath) return
    await this.resolveAndFetch(seq)
  }

  /** 知识索引变化后重新解析 auto:/draft: → 真 UUID；已转正则迁移旧记录 */
  async resolvePageId(): Promise<void> {
    if (!this.opts.pageId && !this.opts.relPath) return
    // 真 id 已稳定：knowledge 广播（自己的保存也会广播）不需要重新解析/重拉，
    // 否则可能用旧记录覆盖刚保存的草稿。
    if (this.opts.pageId && !isVirtualPageId(this.opts.pageId)) return
    // relPath-only 模式：一旦解析到真 id 就稳定，不再因每次 knowledge 广播重拉
    if (this.effectivePageId && !isVirtualPageId(this.effectivePageId)) return
    const seq = ++this.configSeq
    await this.resolveAndFetch(seq)
  }

  private async resolveAndFetch(seq: number): Promise<void> {
    const { pageId, relPath } = this.opts
    let resolved = pageId
    if (relPath && (!pageId || isVirtualPageId(pageId))) {
      try {
        const hit = await knowledgeFindByRel(relPath)
        if (seq !== this.configSeq || this.disposed) return
        if (hit?.id) resolved = hit.id
      } catch { /* 索引未就绪：先用原 id */ }
    }
    if (!resolved) {
      this.effectivePageId = ''
      this.records.clear()
      this.rebuild()
      return
    }
    // auto:/draft: 转正：记录/标签/分组迁到真 id，再按真 id 拉取。
    // 首次配置时 effectivePageId 还是空，要用原始 pageId 作为 old。
    const oldId = this.effectivePageId || pageId
    if (resolved !== oldId && oldId && isVirtualPageId(oldId) && !isVirtualPageId(resolved)) {
      await this.migrate(oldId, resolved)
    }
    this.effectivePageId = resolved
    await this.fetchRecords(seq)
  }

  private async migrate(oldPageId: string, newPageId: string): Promise<void> {
    const key = `${oldPageId}\u0000${newPageId}`
    if (this.migrateTried.has(key)) return
    this.migrateTried.add(key)
    try {
      await quizRecordMigratePageId(oldPageId, newPageId)
    } catch (e) {
      // 迁移失败不阻塞作答：下次 knowledge 刷新会重试
      this.migrateTried.delete(key)
      console.warn('[quizStore] migrate page id failed:', e)
    }
  }

  private async fetchRecords(seq: number): Promise<void> {
    const pageId = this.effectivePageId
    if (!pageId) return
    const fetchId = ++this.fetchSeq
    try {
      const rows = await quizRecordGetByPage(pageId)
      if (this.disposed || seq !== this.configSeq || fetchId !== this.fetchSeq) return
      this.records = new Map(rows.map(r => [r.quizNo, r]))
      this.rebuild()
    } catch {
      if (this.disposed || seq !== this.configSeq) return
      this.records.clear()
      this.rebuild()
      if (!this.toastShown) {
        this.toastShown = true
        showToast({ type: 'warning', message: '答题记录暂时读取失败', detail: '本次作答仍可继续，稍后会自动重试' })
      }
    }
  }

  async refresh(): Promise<void> {
    if (!this.effectivePageId) return
    await this.fetchRecords(this.configSeq)
  }

  /** 串行化同一题的写操作：草稿的 text/revealed 与 report 不能乱序覆盖 */
  private enqueue(no: number, fn: () => Promise<unknown>): Promise<boolean> {
    const prev = this.queueByNo.get(no) ?? Promise.resolve(true)
    const run: Promise<boolean> = prev.catch(() => true).then(fn).then(() => true).catch((e) => {
      console.warn('[quizStore] save failed:', e)
      showToast({ type: 'warning', message: '答题记录保存失败', detail: '已保留本次输入，请稍后重试' })
      return false
    })
    this.queueByNo.set(no, run)
    void run.finally(() => {
      if (this.queueByNo.get(no) === run) this.queueByNo.delete(no)
    })
    return run
  }

  private setRecord(rec: QuizRecordDto): void {
    this.records.set(rec.quizNo, rec)
    this.rebuild()
  }

  async saveDraft(no: number, patch: QuizDraftPatch, snapshot: QuizSnapshotDto): Promise<boolean> {
    const pageId = this.effectivePageId
    if (!pageId) return false
    const cur = this.records.get(no) ?? syntheticRecord(pageId, no, this.opts.pageTitle, snapshot)
    const prevDraft = cur.draft ?? emptyDraft()
    const now = nowLocal()
    const draft: QuizDraftDto = {
      picked: patch.picked !== undefined ? (patch.picked || null) : prevDraft.picked,
      text: patch.text !== undefined ? patch.text.slice(0, 20000) : prevDraft.text,
      revealed: patch.revealed !== undefined ? !!patch.revealed : prevDraft.revealed,
      assessedText: patch.assessedText !== undefined
        ? (patch.assessedText == null ? null : patch.assessedText.slice(0, 20000))
        : prevDraft.assessedText,
      updatedAt: now,
    }
    this.setRecord({ ...cur, snapshot: snapshot ?? cur.snapshot, pageTitle: this.opts.pageTitle || cur.pageTitle, draft })
    return this.enqueue(no, async () => {
      if (this.effectivePageId !== pageId) return
      await quizRecordSaveDraft(pageId, no, patch, { pageTitle: this.opts.pageTitle, snapshot })
    })
  }

  async report(no: number, correct: boolean, snapshot: QuizSnapshotDto, picked?: string): Promise<boolean> {
    const pageId = this.effectivePageId
    if (!pageId) return false
    const cur = this.records.get(no) ?? syntheticRecord(pageId, no, this.opts.pageTitle, snapshot)
    const now = nowLocal()
    const draft = picked
      ? { ...(cur.draft ?? emptyDraft()), picked, updatedAt: now }
      : cur.draft
    const optimistic: QuizRecordDto = {
      ...cur,
      snapshot,
      pageTitle: this.opts.pageTitle || cur.pageTitle,
      lastResult: correct ? 1 : 0,
      correctCount: (cur.correctCount ?? 0) + (correct ? 1 : 0),
      wrongCount: (cur.wrongCount ?? 0) + (correct ? 0 : 1),
      streakCorrect: correct ? (cur.streakCorrect ?? 0) + 1 : 0,
      draft,
    }
    this.setRecord(optimistic)
    return this.enqueue(no, async () => {
      if (this.effectivePageId !== pageId) return
      const server = await quizRecordReport(pageId, no, correct, {
        pageTitle: this.opts.pageTitle,
        snapshot,
        picked,
      })
      if (!server || this.effectivePageId !== pageId) return
      // 报告返回时可能有更晚的本地草稿（用户继续打字）：保留较新的 draft
      const latest = this.records.get(no)
      const mergedDraft = newerDraft(server.draft, latest?.draft ?? null)
      this.setRecord({ ...server, draft: mergedDraft })
    })
    // 失败时 enqueue 已 Toast；这里不回滚，避免覆盖用户后续输入
  }

  async toggleFavorite(no: number, snapshot: QuizSnapshotDto): Promise<boolean> {
    const pageId = this.effectivePageId
    if (!pageId) return false
    const cur = this.records.get(no) ?? syntheticRecord(pageId, no, this.opts.pageTitle, snapshot)
    this.setRecord({ ...cur, snapshot, isFavorite: !cur.isFavorite })
    return this.enqueue(no, async () => {
      if (this.effectivePageId !== pageId) return
      const server = await quizRecordToggleFavorite(pageId, no, {
        pageTitle: this.opts.pageTitle,
        snapshot,
      })
      if (this.effectivePageId === pageId) this.setRecord(server)
    })
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.queueByNo.clear()
  }
}

export const QuizRecordContext = createContext<QuizRecordStore | null>(null)

export function useQuizStore(): QuizRecordStore | null {
  return useContext(QuizRecordContext)
}

export function useQuizRecordStore(opts: QuizStoreOptions): QuizRecordStore {
  const { pageId = '', relPath = '', pageTitle = '' } = opts
  const storeRef = useRef<QuizRecordStore | null>(null)
  if (!storeRef.current) storeRef.current = new QuizRecordStore()
  const store = storeRef.current

  useEffect(() => {
    void store.configure({ pageId, relPath, pageTitle })
  }, [store, pageId, relPath, pageTitle])

  useDataChanged('knowledge', () => { void store.resolvePageId() })
  useDataChanged('quiz', () => { void store.refresh() })

  useEffect(() => () => store.dispose(), [store])

  return store
}

export function useQuizStoreActive(store: QuizRecordStore | null): boolean {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : NOOP),
    [store],
  )
  const getSnapshot = useCallback(() => !!store?.active, [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useQuizRecord(store: QuizRecordStore | null, no: number): QuizRecordDto | null {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : NOOP),
    [store],
  )
  const getSnapshot = useCallback(() => (store ? store.getRecord(no) : null), [store, no])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useQuizRecords(store: QuizRecordStore | null): QuizRecordDto[] {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : NOOP),
    [store],
  )
  const getSnapshot = useCallback(() => (store ? store.getRecords() : EMPTY_RECORDS), [store])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useQuizSummary(store: QuizRecordStore | null): QuizStoreSummary {
  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : NOOP),
    [store],
  )
  const getSnapshot = useCallback(
    () => (store ? store.getSummary() : EMPTY_SUMMARY),
    [store],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export type { QuizRecordStore }
