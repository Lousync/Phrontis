import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowLeft, Bookmark, BookmarkPlus, ChevronDown, ChevronUp, Contrast, FileText, Loader2, Search, Type, X } from 'lucide-react'
import { excerptCreate, excerptList, readerStateGet, readerStatePatch, workspaceReadRange } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { KB_BOOKMARK_DELETE, KB_READER_STATE_CHANGED, KB_TXT_GOTO_PARA } from '../pdf/pdfEvents'
import { decodeWith, detectEncoding, type TextEncoding } from '../../../lib/textDecode'
import { showToast } from '../../../lib/toast'
// 书签条数上限：**唯一真源在 schema**（写盘侧会按它整单拒绝），渲染层只读来提前拦并给出提示
import { MAX_BOOKMARKS } from '../../../../electron/lib/kbStore/readerStateSchema'
import { ExcerptCaptureBar } from './ExcerptCaptureBar'
import type { SelectionRect } from '../pdf/TextSelectionBar'
import type { BookBookmark, ExcerptColor, ExcerptItem, ExcerptType, ReaderPaper } from '../../../types'

/**
 * TXT 阅读器（书架升级全格式阅读器一期 / 二期拉平，方案 §S5 / v3.5.0 第 3 项）。
 * 与 PdfReaderView 同构：工具栏（最左「← 返回书架」）+ 内部滚动容器；进度落
 * `.knowbase/modules/readerState.json`（readerStatePatch，expectedUpdatedAt 冲突检测）。
 *
 * 读取模型（A1 按需分块续读，2026-09-21 改造）：
 *   - 首块 128KB → 取 size → 立即解码渲染首屏；
 *   - 滚动逼近已加载末尾时增量拉取 256KB 追加；等效无实际上限（停在 EOF）。
 *   - 四个坑：① 块尾回退到最后一个 \n（最多 4KB）避免切断行/多字节；② 编码只探测一次
 *     （detectEncoding/decodeWith，首块探测、后续沿用）；③ 段落按块 append + 末段合并，不整段重算；
 *     ④ pct 口径 = **滚动位置反算 × 已加载占比**（全载时退化为纯滚动位置）。⚠️ 不可改成
 *        「已加载字节 / 总字节」—— 小文件首块即全载，pct 会恒为定值，恢复语义直接失效。
 * 书签（A2）/ 字号 + 纸色（A4）：落 readerState.json（bookmarks / fontScale / paper，书级记忆）。
 * 全文搜索（A3）：复用 PDF UI 语言，命中用 paraIndex + 段内偏移，新类 .kb-search-hl。
 *
 * Hook 纪律：所有 hook 声明在任何早退 return 之前（React #310 已三犯）。
 */

const FIRST_CHUNK = 128 * 1024
const APPEND_CHUNK = 256 * 1024
const BOUNDARY_LOOKBACK = 4 * 1024
const PARA_SPLIT = 4000

// ===== 段落分段器（增量 append，O(n) 总量，不整段重算）=====
interface Seg { paras: string[]; curRun: string[]; partialLine: string }
const newSeg = (): Seg => ({ paras: [], curRun: [], partialLine: '' })

function flushRun(seg: Seg): void {
  if (seg.curRun.length === 0) return
  let para = seg.curRun.join('\n')
  seg.curRun = []
  if (para.length <= PARA_SPLIT) { seg.paras.push(para); return }
  // 单段超 4000 字：优先在换行处切，无换行硬切
  let rest = para
  while (rest.length > PARA_SPLIT) {
    let cut = rest.lastIndexOf('\n', PARA_SPLIT)
    if (cut < PARA_SPLIT / 2) cut = PARA_SPLIT
    seg.paras.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) seg.paras.push(rest)
}

/** 把一段解码文本并入分段器；endedWithNewline 表示该文本以 \n 结尾（末行已闭合） */
function ingestChunk(seg: Seg, text: string, endedWithNewline: boolean): void {
  const combined = seg.partialLine + text
  const lines = combined.split(/\r?\n/)
  let arr = lines
  let partial = ''
  // 末行不是以换行结尾 → 最后一段是未完行，留作下一轮的 partialLine
  if (!endedWithNewline && arr.length > 0) partial = arr.pop() as string
  for (const line of arr) {
    if (line.trim() === '') flushRun(seg)
    else seg.curRun.push(line)
  }
  seg.partialLine = partial
}

/** EOF：把尚在跑的段落与末段未完行收尾成最后一段 */
function finalizeSeg(seg: Seg): void {
  if (seg.partialLine) { seg.curRun.push(seg.partialLine); seg.partialLine = '' }
  flushRun(seg)
}

/** 当前可渲染段落数组（含尚未闭合的末段作为最后一项） */
function snapshotParas(seg: Seg): string[] {
  if (seg.curRun.length === 0 && seg.partialLine === '') return seg.paras
  const open = seg.curRun.join('\n') + (seg.partialLine ? (seg.curRun.length ? '\n' : '') + seg.partialLine : '')
  return [...seg.paras, open]
}

/** 块尾回退到最后一个 \n（最多 BOUNDARY_LOOKBACK；块内无换行则整块保留） */
function splitAtLastNewline(combined: string): { consume: string; carry: string } {
  const lastNl = combined.lastIndexOf('\n')
  if (lastNl >= 0 && lastNl >= combined.length - (BOUNDARY_LOOKBACK + 1)) {
    return { consume: combined.slice(0, lastNl + 1), carry: combined.slice(lastNl + 1) }
  }
  return { consume: combined, carry: '' }
}

interface Props {
  rootId: string
  relPath: string
  name: string
  /** 工具栏最左的返回入口（书架阅读态用） */
  backLabel?: string
  onBack?: () => void
}

export function TxtReaderView({ rootId, relPath, name, backLabel, onBack }: Props) {
  const [paragraphs, setParagraphs] = useState<string[]>([])
  const [fileSize, setFileSize] = useState(0)
  const [loadedBytes, setLoadedBytes] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [pct, setPct] = useState(0)
  // A2 书签 / A4 字号纸色
  const [bookmarks, setBookmarks] = useState<BookBookmark[]>([])
  const [fontScale, setFontScale] = useState(1)
  const [paper, setPaper] = useState<ReaderPaper>('default')
  // A3 搜索
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<Array<{ paraIndex: number; start: number; end: number }>>([])
  const [searchActive, setSearchActive] = useState(0)
  const [searchPartial, setSearchPartial] = useState(false)
  // 摘录（摘录先行批次）：列表 + 划选捕获浮条
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  const [capture, setCapture] = useState<{ rect: SelectionRect; paraIndex: number; start: number; end: number; text: string } | null>(null)
  const [flashPara, setFlashPara] = useState<number | null>(null)
  const [topPara, setTopPara] = useState(-1)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const segRef = useRef<Seg>(newSeg())
  const encodingRef = useRef<TextEncoding | null>(null)
  const readPosRef = useRef(0)
  const carryRef = useRef('')
  const fileSizeRef = useRef<number>(Number.POSITIVE_INFINITY)
  const loadedRef = useRef(0)
  const expectedUpdatedAtRef = useRef<string | undefined>(undefined)
  const restorePctRef = useRef(0)
  const restoredRef = useRef(false)
  const bodyReadyRef = useRef(false)
  const throttleRef = useRef(0)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadingMoreRef = useRef(false)
  const fontScaleRef = useRef(1)
  const paperRef = useRef<ReaderPaper>('default')
  const bkmRef = useRef<BookBookmark[]>([])
  const topParaRef = useRef(-1)
  const searchHitsRef = useRef<Array<{ paraIndex: number; start: number; end: number }>>([])
  const searchActiveRef = useRef(0)

  // ===== 加载：首块 128KB 立即渲染 + 续读循环到目标位置 =====
  useEffect(() => {
    let alive = true
    segRef.current = newSeg()
    encodingRef.current = null
    readPosRef.current = 0
    carryRef.current = ''
    fileSizeRef.current = Number.POSITIVE_INFINITY
    loadedRef.current = 0
    restoredRef.current = false
    bodyReadyRef.current = false
    loadingMoreRef.current = false
    setLoading(true)
    setParagraphs([])
    setLoadErr('')
    setPct(0)
    setFileSize(0)
    setLoadedBytes(0)
    ;(async () => {
      try {
        const st = await readerStateGet(rootId, relPath)
        if (!alive) return
        if (st.ok && st.state) {
          expectedUpdatedAtRef.current = st.state.updatedAt
          restorePctRef.current = st.state.pct
          setPct(st.state.pct)
          const bk = Array.isArray(st.state.bookmarks) ? st.state.bookmarks.filter((b) => b && typeof b.paraIndex === 'number') : []
          setBookmarks(bk); bkmRef.current = bk
          const fs = typeof st.state.fontScale === 'number' && st.state.fontScale >= 0.5 && st.state.fontScale <= 3 ? st.state.fontScale : 1
          setFontScale(fs); fontScaleRef.current = fs
          const pp: ReaderPaper = st.state.paper === 'sepia' || st.state.paper === 'green' || st.state.paper === 'dark' ? st.state.paper : 'default'
          setPaper(pp); paperRef.current = pp
        } else {
          expectedUpdatedAtRef.current = undefined
          restorePctRef.current = 0
        }

        // 首块 128KB
        const r = await workspaceReadRange(rootId, relPath, 0, FIRST_CHUNK)
        if (!alive) return
        if (!r || r.error) throw new Error(r?.error ?? '读取失败')
        if (Number.isFinite(fileSizeRef.current)) fileSizeRef.current = r.size
        const bin = atob(r.data)
        const u8 = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
        const detected = detectEncoding(u8)
        encodingRef.current = detected === 'utf8-bom' ? 'utf8' : detected
        const decoded = detected === 'utf8-bom' ? decodeWith(u8, 'utf8-bom') : decodeWith(u8, detected)
        const { consume, carry } = splitAtLastNewline(decoded)
        ingestChunk(segRef.current, consume, consume.endsWith('\n'))
        carryRef.current = carry
        readPosRef.current = u8.length
        loadedRef.current = u8.length
        setParagraphs(snapshotParas(segRef.current))
        setFileSize(Number.isFinite(fileSizeRef.current) ? fileSizeRef.current : 0)
        setLoadedBytes(loadedRef.current)

        // 恢复滚动：先把内容加载到目标字节位置再恢复（A1 坑④）
        if (restorePctRef.current > 0 && Number.isFinite(fileSizeRef.current) && fileSizeRef.current > 0) {
          const target = (restorePctRef.current / 100) * fileSizeRef.current
          let guard = 0
          while (alive && loadedRef.current < target && readPosRef.current < fileSizeRef.current && guard < 100000) {
            await readAppendedChunk()
            if (!alive) return
            setParagraphs(snapshotParas(segRef.current))
            setLoadedBytes(loadedRef.current)
            guard++
          }
        }
        finalizeSeg(segRef.current)
        setParagraphs(snapshotParas(segRef.current))
        bodyReadyRef.current = true
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setLoadErr(String((e as Error)?.message || e))
        setLoading(false)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, relPath])

  /** 追加一块（256KB）到分段器；返回是否还有后续 */
  const readAppendedChunk = useCallback(async (): Promise<boolean> => {
    const r = await workspaceReadRange(rootId, relPath, readPosRef.current, APPEND_CHUNK)
    if (!r || r.error) throw new Error(r?.error ?? '读取失败')
    if (!Number.isFinite(fileSizeRef.current)) fileSizeRef.current = r.size
    const bin = atob(r.data)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    const chunkBytes = u8.length
    if (chunkBytes === 0) return false
    const decoded = decodeWith(u8, encodingRef.current as TextEncoding)
    const combined = carryRef.current + decoded
    const { consume, carry } = splitAtLastNewline(combined)
    ingestChunk(segRef.current, consume, consume.endsWith('\n'))
    carryRef.current = carry
    readPosRef.current += chunkBytes
    loadedRef.current += chunkBytes
    return readPosRef.current < fileSizeRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, relPath])

  /** 续读（滚动逼近末尾时触发，幂等） */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return
    if (!Number.isFinite(fileSizeRef.current) || loadedRef.current >= fileSizeRef.current) return
    loadingMoreRef.current = true
    try {
      await readAppendedChunk()
      setParagraphs(snapshotParas(segRef.current))
      setLoadedBytes(loadedRef.current)
      setFileSize(Number.isFinite(fileSizeRef.current) ? fileSizeRef.current : 0)
    } catch { /* 续读失败不打扰阅读 */ } finally {
      loadingMoreRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAppendedChunk])

  // ===== 恢复滚动：正文首次布局后按 pct 反算 scrollTop（只做一次） =====
  useEffect(() => {
    if (!bodyReadyRef.current || restoredRef.current) return
    if (paragraphs.length === 0) return
    restoredRef.current = true
    const target = restorePctRef.current
    if (target <= 0) return
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight
      if (max <= 0) return
      el.scrollTop = Math.round((max * target) / 100)
    })
  }, [paragraphs])

  /** 写回 readerState（冲突以服务端为基底、本地意图覆盖后重试一次） */
  const patchReader = useCallback(async (patch: Parameters<typeof readerStatePatch>[2]) => {
    try {
      const r = await readerStatePatch(rootId, relPath, patch, expectedUpdatedAtRef.current)
      if (r.ok && r.state) {
        expectedUpdatedAtRef.current = r.state.updatedAt
      } else if (r.conflict && r.state) {
        expectedUpdatedAtRef.current = r.state.updatedAt
        const r2 = await readerStatePatch(rootId, relPath, patch, r.state.updatedAt)
        if (r2.ok && r2.state) expectedUpdatedAtRef.current = r2.state.updatedAt
      }
    } catch { /* 写回失败静默：进度属可再生数据 */ }
  }, [rootId, relPath])

  // ===== 进度落盘 + 广播（滚动节流 200ms 计算，防抖 400ms 落盘） =====
  const persistPct = useCallback((p: number) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      void patchReader({ pct: p })
    }, 400)
  }, [patchReader])

  /** 当前视口顶部所在段落序号 */
  const currentParaIndex = useCallback((): number => {
    const el = scrollRef.current
    if (!el) return -1
    const pEls = Array.from(el.querySelectorAll('p[data-p]')) as HTMLElement[]
    if (pEls.length === 0) return -1
    const cTop = el.getBoundingClientRect().top
    for (const p of pEls) {
      if (p.getBoundingClientRect().bottom >= cTop) return Number(p.getAttribute('data-p'))
    }
    return Number(pEls[pEls.length - 1].getAttribute('data-p'))
  }, [])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const now = Date.now()
    if (now - throttleRef.current < 200) return
    throttleRef.current = now
    const max = el.scrollHeight - el.clientHeight
    // pct = 滚动位置反算 × 已加载占比 —— **恢复语义不可动**：全载时退化为纯滚动位置口径
    // （与恢复滚动处的 `max * target / 100` 互逆）。已加载占比只用来在分块续读未完成时
    // 把「已读部分」折算成「全书的百分之几」，绝不能单独拿它当 pct —— 小文件首块即全载，
    // 那样 pct 会恒为定值，「读一半关掉再开」就恢复不回来（2026-09-21 实测 pct=0 的根因）。
    const loadedFrac = Number.isFinite(fileSizeRef.current) && fileSizeRef.current > 0
      ? Math.min(1, loadedRef.current / fileSizeRef.current)
      : 1
    const p = max > 0
      ? Math.min(100, Math.max(0, Math.round((el.scrollTop / max) * loadedFrac * 100)))
      : 0
    setPct(p)
    setCapture(null)
    const idx = currentParaIndex()
    if (idx >= 0) { topParaRef.current = idx; setTopPara(idx) }
    try {
      window.dispatchEvent(new CustomEvent(KB_READER_STATE_CHANGED, { detail: { relPath, kind: 'txt', pct: p } }))
    } catch { /* 广播失败不影响阅读 */ }
    persistPct(p)
    // 逼近已加载末尾 → 增量续读
    if (max > 0 && el.scrollTop + el.clientHeight > max - el.clientHeight * 1.5) {
      void loadMore()
    }
  }, [relPath, persistPct, loadMore, currentParaIndex])

  // 卸载时把最后一次防抖落盘立即冲掉（避免关书丢尾部进度）
  useEffect(() => () => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null }
  }, [])

  // ===== 摘录列表：挂载/换书拉一次 + excerpt 广播刷新 =====
  useEffect(() => {
    let alive = true
    setExcerpts([])
    setCapture(null)
    if (!rootId) return
    void excerptList(rootId, relPath).then((r) => {
      if (alive && r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 摘录读取失败不阻塞阅读 */ })
    return () => { alive = false }
  }, [rootId, relPath])
  useDataChanged('excerpt', () => {
    if (!rootId) return
    void excerptList(rootId, relPath).then((r) => {
      if (r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 忽略 */ })
  })

  /** 段落 → 高亮区间表（txt 摘录且有偏移才参与；重叠区间后来者截断） */
  const highlightMap = useMemo(() => {
    const map = new Map<number, Array<{ start: number; end: number; id: string; note: string; color: ExcerptColor }>>()
    for (const e of excerpts) {
      if (e.kind !== 'txt' || typeof e.paraIndex !== 'number' || typeof e.start !== 'number' || typeof e.end !== 'number') continue
      const arr = map.get(e.paraIndex) ?? []
      arr.push({ start: e.start, end: e.end, id: e.id, note: e.note, color: e.color })
      map.set(e.paraIndex, arr)
    }
    return map
  }, [excerpts])

  // ===== 搜索（A3）：命中按 paraIndex + 段内偏移；范围 = 已加载内容 =====
  const searchHitsByPara = useMemo(() => {
    const m = new Map<number, Array<{ start: number; end: number }>>()
    for (const h of searchHits) {
      const arr = m.get(h.paraIndex) ?? []
      arr.push({ start: h.start, end: h.end })
      m.set(h.paraIndex, arr)
    }
    return m
  }, [searchHits])

  const runSearch = useCallback((q: string) => {
    const needle = q.trim().toLowerCase()
    if (!needle) { setSearchHits([]); searchHitsRef.current = []; setSearchPartial(false); return }
    const hits: Array<{ paraIndex: number; start: number; end: number }> = []
    const paras = paragraphs
    for (let i = 0; i < paras.length; i++) {
      const text = paras[i]
      let idx = text.toLowerCase().indexOf(needle)
      while (idx >= 0) {
        hits.push({ paraIndex: i, start: idx, end: idx + needle.length })
        idx = text.toLowerCase().indexOf(needle, idx + needle.length)
      }
    }
    searchHitsRef.current = hits
    setSearchHits(hits)
    setSearchPartial(!Number.isFinite(fileSizeRef.current) || loadedRef.current < fileSizeRef.current)
    setSearchActive(0)
    searchActiveRef.current = 0
    if (hits.length) {
      scrollRef.current?.querySelector(`p[data-p="${hits[0].paraIndex}"]`)?.scrollIntoView({ block: 'center' })
    }
  }, [paragraphs])

  const gotoHit = useCallback((dir: number) => {
    const hits = searchHitsRef.current
    if (hits.length === 0) return
    const next = ((searchActiveRef.current + dir) % hits.length + hits.length) % hits.length
    searchActiveRef.current = next
    setSearchActive(next)
    const h = hits[next]
    scrollRef.current?.querySelector(`p[data-p="${h.paraIndex}"]`)?.scrollIntoView({ block: 'center' })
  }, [])

  // ===== 右栏书签跳段：滚到段落并闪烁提示（A2 复用 KB_TXT_GOTO_PARA）=====
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; paraIndex?: number }
      if (d?.relPath !== relPath || typeof d.paraIndex !== 'number') return
      const el = scrollRef.current?.querySelector(`p[data-p="${d.paraIndex}"]`)
      el?.scrollIntoView({ block: 'center' })
      setFlashPara(d.paraIndex)
      setTimeout(() => setFlashPara((cur) => (cur === d.paraIndex ? null : cur)), 1200)
    }
    window.addEventListener(KB_TXT_GOTO_PARA, onGoto)
    return () => window.removeEventListener(KB_TXT_GOTO_PARA, onGoto)
  }, [relPath])

  // ===== 书签切换（A2）：在当前视口顶部段落加/去书签 =====
  const toggleBookmark = useCallback(() => {
    const idx = topParaRef.current
    if (idx < 0) return
    const exists = bkmRef.current.find((b) => b.paraIndex === idx)
    let next: BookBookmark[]
    if (exists) {
      next = bkmRef.current.filter((b) => b.id !== exists.id)
    } else {
      // 上限与 schema 侧同一个常量：超了直接说，别让写回静默失败（书签会"加上又消失"）
      if (bkmRef.current.length >= MAX_BOOKMARKS) {
        showToast({ type: 'warning', message: `书签已达上限（${MAX_BOOKMARKS} 条），请先删掉一些` })
        return
      }
      const label = (paragraphs[idx] ?? '').slice(0, 16).replace(/\s+/g, ' ').trim() || `段落 ${idx + 1}`
      next = [...bkmRef.current, { id: crypto.randomUUID(), paraIndex: idx, label, at: new Date().toISOString() }]
        // 本书是 txt ⇒ 条条都有 paraIndex；`?? 0` 只为满足「定位字段可选」的类型（BookBookmark 共用）
        .sort((a, b) => (a.paraIndex ?? 0) - (b.paraIndex ?? 0))
    }
    bkmRef.current = next
    setBookmarks(next)
    void patchReader({ bookmarks: next })
  }, [paragraphs, patchReader])

  /**
   * 右栏阅读侧栏 → 阅读器：删除一条书签（见 pdfEvents 的 KB_BOOKMARK_DELETE）。
   * 理由同 EpubReaderView：`bkmRef` 是内存权威数组，加书签整数组覆盖写 —— 右栏直接写盘会被复活。
   */
  useEffect(() => {
    const onDel = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; id?: string } | undefined
      if (!d?.id || d.relPath !== relPath) return
      const next = bkmRef.current.filter((b) => b.id !== d.id)
      if (next.length === bkmRef.current.length) return
      bkmRef.current = next
      setBookmarks(next)
      void patchReader({ bookmarks: next })
    }
    window.addEventListener(KB_BOOKMARK_DELETE, onDel)
    return () => window.removeEventListener(KB_BOOKMARK_DELETE, onDel)
  }, [relPath, patchReader])

  // ===== A4 字号 / 纸色（书级记忆）=====
  const changeFont = useCallback((delta: number) => {
    const next = Math.min(3, Math.max(0.5, Math.round((fontScaleRef.current + delta) * 10) / 10))
    if (next === fontScaleRef.current) return
    fontScaleRef.current = next
    setFontScale(next)
    void patchReader({ fontScale: next })
  }, [patchReader])

  const cyclePaper = useCallback(() => {
    const order: ReaderPaper[] = ['default', 'sepia', 'green', 'dark']
    const next = order[(order.indexOf(paperRef.current) + 1) % order.length]
    paperRef.current = next
    setPaper(next)
    void patchReader({ paper: next })
  }, [patchReader])

  // ===== 划选捕获（原生 document mouseup——原生监听不受 React 合成事件限制） =====
  useEffect(() => {
    const onUp = () => {
      setTimeout(() => {
        const root = scrollRef.current
        const sel = window.getSelection()
        if (!root || !sel || sel.isCollapsed || sel.rangeCount !== 1) { setCapture(null); return }
        const range = sel.getRangeAt(0)
        const anc = range.commonAncestorContainer
        const pEl = (anc.nodeType === 3 ? anc.parentElement : anc as HTMLElement)?.closest?.('p[data-p]')
        if (!pEl || !root.contains(pEl)) { setCapture(null); return }
        const paraIndex = Number(pEl.getAttribute('data-p'))
        const walker = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT)
        let pos = 0
        let start = -1
        let end = -1
        let node: Node | null
        while ((node = walker.nextNode())) {
          const len = (node as Text).data.length
          if (node === range.startContainer) start = pos + range.startOffset
          if (node === range.endContainer) end = pos + range.endOffset
          pos += len
        }
        if (start < 0 || end < 0) { setCapture(null); return }
        if (start > end) { const t = start; start = end; end = t }
        if (end - start < 1) { setCapture(null); return }
        const text = (pEl.textContent ?? '').slice(start, end)
        if (!text.trim()) { setCapture(null); return }
        const r = range.getBoundingClientRect()
        setCapture({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, paraIndex, start, end, text })
      }, 0)
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [])

  const handleCreateExcerpt = useCallback((text: string, color: ExcerptColor, type: ExcerptType, note?: string) => {
    if (!capture || !rootId) return
    void excerptCreate(rootId, relPath, {
      kind: 'txt',
      text,
      paraIndex: capture.paraIndex,
      start: capture.start,
      end: capture.end,
      color,
      type,
      note,
    }).catch(() => { /* 创建失败不打扰阅读 */ })
    setCapture(null)
    window.getSelection()?.removeAllRanges()
  }, [capture, rootId, relPath])

  const virtualize = paragraphs.length > 300

  // ===== 段落渲染：摘录高亮 + 搜索高亮合并（A3 新类 .kb-search-hl）=====
  const renderParagraph = (i: number, text: string): ReactNode => {
    const excMarks = (highlightMap.get(i) ?? []).filter((m) => m.start < text.length)
    const srchMarks = (searchHitsByPara.get(i) ?? []).filter((m) => m.start < text.length)
    if (excMarks.length === 0 && srchMarks.length === 0) return text
    const active = searchHits[searchActive]
    const pts = new Set<number>([0, text.length])
    for (const m of excMarks) { pts.add(Math.max(0, Math.min(text.length, m.start))); pts.add(Math.max(0, Math.min(text.length, m.end))) }
    for (const m of srchMarks) { pts.add(Math.max(0, Math.min(text.length, m.start))); pts.add(Math.max(0, Math.min(text.length, m.end))) }
    const bounds = [...pts].sort((a, b) => a - b)
    const nodes: ReactNode[] = []
    for (let k = 0; k < bounds.length - 1; k++) {
      const s = bounds[k]
      const e = bounds[k + 1]
      if (s >= e) continue
      const segText = text.slice(s, e)
      const exc = excMarks.find((m) => m.start <= s && m.end >= e)
      const srch = srchMarks.find((m) => m.start <= s && m.end >= e)
      const isActive = !!srch && !!active && active.paraIndex === i && s >= active.start && e <= active.end
      if (exc) {
        nodes.push(
          <mark key={`${i}-${k}`} data-eid={exc.id} data-ehc={exc.color} title={exc.note || undefined}
            className={`kb-exc-${exc.color} rounded-sm px-0.5 text-[var(--text-primary)] ${srch ? 'kb-search-hl' : ''} ${isActive ? 'kb-search-active' : ''}`}>
            {segText}
          </mark>,
        )
      } else if (srch) {
        nodes.push(
          <mark key={`${i}-${k}`} className={`kb-search-hl rounded-sm px-0.5 ${isActive ? 'kb-search-active' : ''}`}>{segText}</mark>,
        )
      } else {
        nodes.push(<span key={`${i}-${k}`}>{segText}</span>)
      }
    }
    return nodes
  }

  const paperStyle: CSSProperties = paper === 'sepia'
    ? { filter: 'sepia(0.32) brightness(0.97) saturate(0.92)' }
    : paper === 'green'
      ? { backgroundColor: '#c9e7c4', color: '#213021' }
      : paper === 'dark'
        ? { backgroundColor: '#1c1c1e', color: '#d8d8d8' }
        : {}

  const toolbar = (
    <div className="kb-fit kb-fit-pdfread flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-secondary)]">
      {onBack && (
        <>
          <button onClick={onBack} title={backLabel ?? '返回书架'}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ArrowLeft size={13} /><span className="kb-l1">{backLabel ?? '返回书架'}</span>
          </button>
          <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        </>
      )}
      <FileText size={13} className="text-[var(--text-tertiary)]" />
      <span className="max-w-[220px] truncate text-[var(--text-primary)]">{name}</span>
      <span className="kb-l3 text-[var(--text-tertiary)]">TXT</span>
      <div className="min-w-0 flex-1" />
      <button onClick={() => setSearchOpen((v) => !v)} title="搜索（已加载内容）" data-wb="txtSearch"
        className={`flex items-center gap-1 rounded p-0.5 ${searchOpen ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        <Search size={14} /><span className="kb-l1">搜索</span>
      </button>
      <button onClick={toggleBookmark} title={bookmarks.some((b) => b.paraIndex === topPara) ? '移除本段书签' : '收藏本段书签'} data-wb="txtBookmark"
        className={`flex items-center gap-1 rounded p-0.5 ${bookmarks.some((b) => b.paraIndex === topPara) ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
        {bookmarks.some((b) => b.paraIndex === topPara) ? <Bookmark size={14} /> : <BookmarkPlus size={14} />}<span className="kb-l1">书签</span>
      </button>
      <button onClick={() => changeFont(-0.1)} title="缩小字号" data-wb="txtFontDec"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Type size={13} /><span className="text-[10px]">−</span></button>
      <button onClick={() => changeFont(0.1)} title="放大字号" data-wb="txtFontInc"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Type size={13} /><span className="text-[10px]">＋</span></button>
      <button onClick={cyclePaper} title={`纸色：${paper === 'sepia' ? '护眼' : paper === 'green' ? '绿纸' : paper === 'dark' ? '暗色' : '默认'}`} data-wb="txtPaper"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Contrast size={14} /></button>
      <span className="shrink-0 text-[var(--text-tertiary)]" data-wb="txtPct">{pct}%</span>
    </div>
  )

  return (
    <div data-wb="txtReader" data-sel-float-ignore className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {toolbar}
      {searchOpen && (
        <div key="search" className="kb-view-in flex items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px]">
          <Search size={13} className="text-[var(--text-tertiary)]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(searchQuery) }}
            placeholder="搜索已加载内容…"
            className="min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button onClick={() => runSearch(searchQuery)} disabled={!searchQuery.trim()}
            className="rounded border border-[var(--border-color)] px-2 py-1 text-[11px] hover:bg-[var(--bg-hover)] disabled:opacity-40">搜索</button>
          <button onClick={() => gotoHit(-1)} disabled={searchHits.length === 0} title="上一条"
            className="rounded p-1 hover:bg-[var(--bg-hover)] disabled:opacity-40"><ChevronUp size={13} /></button>
          <button onClick={() => gotoHit(1)} disabled={searchHits.length === 0} title="下一条"
            className="rounded p-1 hover:bg-[var(--bg-hover)] disabled:opacity-40"><ChevronDown size={13} /></button>
          <span className="shrink-0 text-[var(--text-tertiary)]">{searchHits.length > 0 ? `${searchActive + 1}/${searchHits.length}` : '0'}</span>
          {searchPartial && <span className="shrink-0 text-[var(--text-tertiary)]">（已搜索已加载部分）</span>}
          <button onClick={() => { setSearchOpen(false); setSearchHits([]); searchHitsRef.current = []; setSearchQuery('') }} title="关闭"
            className="rounded p-1 hover:bg-[var(--bg-hover)]"><X size={13} /></button>
        </div>
      )}
      {loadErr ? (
        <div className="flex flex-1 items-center justify-center text-[12.5px] text-[var(--text-muted)]">{loadErr}</div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
        </div>
      ) : (
        <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto text-[var(--text-primary)]" style={paperStyle}>
          <div className="mx-auto max-w-[700px] px-6 py-8" style={{ fontFamily: "'Georgia', 'Noto Serif SC', 'Source Han Serif SC', serif", fontSize: 19 * fontScale, lineHeight: 2.05, textAlign: 'justify' }}>
            {paragraphs.map((p, i) => (
              <p
                key={i}
                data-p={i}
                style={virtualize ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 96px', whiteSpace: 'pre-wrap' } : { whiteSpace: 'pre-wrap' }}
                className={`${flashPara === i ? 'rounded bg-[var(--accent)]/10' : ''}`}
              >
                {renderParagraph(i, p)}
              </p>
            ))}
          </div>
        </div>
      )}
      {capture && (
        <ExcerptCaptureBar
          rect={capture.rect}
          text={capture.text}
          onCreate={handleCreateExcerpt}
          onAsk={(t) => { window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', { detail: { action: 'ask', text: t } })); setCapture(null); window.getSelection()?.removeAllRanges() }}
          onTranslate={(t, r) => {
            window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', { detail: { action: 'translate', text: t, rect: { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height } } }))
            setCapture(null)
            window.getSelection()?.removeAllRanges()
          }}
          onClose={() => setCapture(null)}
        />
      )}
    </div>
  )
}

export default TxtReaderView
