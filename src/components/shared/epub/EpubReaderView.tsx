import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Contrast, Loader2, Trash2, Type, X } from 'lucide-react'
import { View } from '../../../vendor/foliate/view.js'
import { Overlayer } from '../../../vendor/foliate/overlayer.js'
import type { FoliateRelocateDetail } from '../../../vendor/foliate/view.js'
import { excerptCreate, excerptDelete, excerptList, readerStateGet, readerStatePatch, workspaceReadRange } from '../../../lib/ipc'
import { useDataChanged } from '../../../lib/dataChanged'
import { showToast } from '../../../lib/toast'
import { KB_EPUB_GOTO_CFI, KB_EPUB_STATE, KB_EPUB_STATE_REQ, KB_READER_STATE_CHANGED, type EpubTocItem } from '../pdf/pdfEvents'
import { ExcerptCaptureBar } from '../txt/ExcerptCaptureBar'
import type { SelectionRect } from '../pdf/TextSelectionBar'
import type { ExcerptColor, ExcerptItem, ExcerptType, ReaderPaper } from '../../../types'

/**
 * EPUB 阅读器（B 段 · 二期六格式引擎第一步，方案 §三/§四）。
 *
 * 引擎 = **vendored foliate-js**（`src/vendor/foliate/`，3 处 KB PATCH，见其 README）。
 * 与 PdfReaderView / TxtReaderView 同构：工具栏（最左「← 返回书架」）+ 内部渲染容器；
 * 进度落 `.knowbase/modules/readerState.json`（readerStatePatch，expectedUpdatedAt 冲突检测）。
 *
 * ★★ 安全面两条硬约束（改动本文件前必读，契约有负向断言锁）：
 *   ① 内容帧 sandbox **不含 `allow-scripts`**（foliate 补丁③已去掉，勿改回）；
 *   ② 应用 CSP `script-src` **不含 `'unsafe-inline'`**。
 *   foliate 上游**不做内容净化**，书里的内联 `<script>` / `onerror` 属性原样存活在 DOM 里 ——
 *   这两条是仅有的防线。本文件只需要「读 `contentDocument`」（同源 blob:），
 *   **不需要**任何降低隔离的改动（铁律 10 的电子书例外只放开同源，不放开脚本）。
 *
 * 定位模型（双轨，方案 §1.3）：`locator` = foliate CFI（读回主力，精确）+ `pct` = 全书进度
 * （角标/进度条显示；CFI 失效时的退路）。两者都在 readerState 白名单里；`kind` **不在**白名单
 * （kind 是 relPath 的纯函数，主进程按路径推导后覆盖写入）。
 *
 * Hook 纪律：所有 hook 声明在任何早退 return 之前。
 */

/** 分块读取步长：raw 字节 ×4/3 = base64 串长度，8MB 一步在 IPC 上是舒适区 */
const READ_CHUNK = 8 * 1024 * 1024
/** 整本载入上限：foliate 的 zip 解包要全量字节（无范围读通道），超大文件先挡住并给明确提示 */
const MAX_BOOK_BYTES = 128 * 1024 * 1024

/** 摘录色 → foliate 高亮填充（与 styles/index.css 的 .kb-exc-* 同源；透明度走 CSS 变量） */
const HL_FILL: Record<ExcerptColor, string> = {
  y: '#efb84c', g: '#7fb844', b: '#5d9bdc', p: '#e0709a', v: '#9188e8',
}

/** foliate 的 `Overlayer.highlight` 用 `--overlayer-highlight-opacity`（默认 .3）控透明度 */
const HL_OPACITY = '0.42'

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 宿主主题变量取值（内容帧是独立文档，CSS 变量不继承 —— 必须读出来再写进书页样式） */
function hostVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch { return fallback }
}

/** 纸色 → 书页配色（default = 跟随宿主主题） */
function themeOf(paper: ReaderPaper): { bg: string; fg: string; link: string } {
  if (paper === 'sepia') return { bg: '#f4ecd8', fg: '#4b3f2f', link: '#8a6d3b' }
  if (paper === 'green') return { bg: '#c9e7c4', fg: '#213021', link: '#2f5d2a' }
  if (paper === 'dark') return { bg: '#1c1c1e', fg: '#d8d8d8', link: '#7cb3ff' }
  return {
    bg: hostVar('--bg-primary', '#ffffff'),
    fg: hostVar('--text-primary', '#1f1f1f'),
    link: hostVar('--accent', '#3b82f6'),
  }
}

/**
 * 书页样式：`[before, after]` 两槽 —— before 会被书自身 CSS 覆盖，after 覆盖书自身 CSS。
 * 用户偏好（字号 / 纸色）必须走 after 槽，否则书的 `body { background: white }` 会赢。
 */
function buildStyles(fontScale: number, paper: ReaderPaper): [string, string] {
  const t = themeOf(paper)
  const px = Math.round(19 * fontScale)
  const before = `html { color-scheme: ${paper === 'dark' ? 'dark' : 'light'}; }`
  const after = [
    `html { font-size: ${px}px !important; background: ${t.bg} !important; }`,
    `body { font-size: ${px}px !important; line-height: 1.95 !important; background: ${t.bg} !important; color: ${t.fg} !important; }`,
    'p, li, dd, dt, blockquote, td { line-height: inherit; }',
    `a, a:visited { color: ${t.link} !important; }`,
    'img, svg, video { max-width: 100% !important; height: auto !important; }',
    `:root { --overlayer-highlight-opacity: ${HL_OPACITY}; }`,
    `::selection { background: ${t.link}44; }`,
  ].join('\n')
  return [before, after]
}

/** 整本读入（foliate 需要完整字节；分块拼装避免单次超大 IPC）。
 *  返回 ArrayBuffer 而非 Uint8Array：`new File([u8])` 在 TS 5.7 的 `Uint8Array<ArrayBufferLike>`
 *  泛型下不满足 `BlobPart`（SharedArrayBuffer 分支），转一次 ArrayBuffer 最干净。 */
async function readWholeBook(rootId: string, relPath: string): Promise<ArrayBuffer> {
  const first = await workspaceReadRange(rootId, relPath, 0, READ_CHUNK)
  if (!first || first.error) throw new Error(first?.error ?? '读取失败')
  const total = first.size
  if (total > MAX_BOOK_BYTES) {
    throw new Error(`文件过大（${Math.round(total / 1048576)} MB），暂支持 ${MAX_BOOK_BYTES / 1048576} MB 以内的电子书`)
  }
  let out = b64ToU8(first.data)
  while (out.length < total) {
    const r = await workspaceReadRange(rootId, relPath, out.length, READ_CHUNK)
    if (!r || r.error) throw new Error(r?.error ?? '读取失败')
    const chunk = b64ToU8(r.data)
    if (chunk.length === 0) break
    const merged = new Uint8Array(out.length + chunk.length)
    merged.set(out)
    merged.set(chunk, out.length)
    out = merged
  }
  const buf = new ArrayBuffer(out.length)
  new Uint8Array(buf).set(out)
  return buf
}

interface Props {
  rootId: string
  relPath: string
  name: string
  /** 工具栏最左的返回入口（书架阅读态用） */
  backLabel?: string
  onBack?: () => void
}

export function EpubReaderView({ rootId, relPath, name, backLabel, onBack }: Props) {
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [pct, setPct] = useState(0)
  const [chapter, setChapter] = useState('')
  const [fontScale, setFontScale] = useState(1)
  const [paper, setPaper] = useState<ReaderPaper>('default')
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  const [capture, setCapture] = useState<{ rect: SelectionRect; cfi: string; text: string } | null>(null)
  const [notePop, setNotePop] = useState<{ rect: SelectionRect; excerpt: ExcerptItem } | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<View | null>(null)
  const expectedUpdatedAtRef = useRef<string | undefined>(undefined)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 恢复位置期间禁止落盘（否则 init 的 relocate 会把旧位置写花） */
  const restoringRef = useRef(true)
  const readyRef = useRef(false)
  const fontScaleRef = useRef(1)
  const paperRef = useRef<ReaderPaper>('default')
  const chapterRef = useRef('')
  const cfiRef = useRef('')
  const pctRef = useRef(0)
  /** 摘录快照（foliate 回调注册在 effect 里，闭包拿不到最新 state） */
  const excerptsRef = useRef<ExcerptItem[]>([])
  /** cfi → 色（高亮重绘查表） */
  const annColorRef = useRef(new Map<string, ExcerptColor>())
  /** 已挂过监听的内容文档（同 section 重渲染会复用 doc，避免重复挂） */
  const boundDocsRef = useRef(new WeakSet<Document>())

  // ===== 写回 readerState（冲突以服务端为基底、本地意图覆盖后重试一次）=====
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

  /** 进度落盘（防抖 400ms；locator 与 pct 同一次写入，避免两次 patch 互相打架） */
  const persist = useCallback((p: number, locator: string) => {
    if (restoringRef.current) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      void patchReader(locator ? { pct: p, locator } : { pct: p })
    }, 400)
  }, [patchReader])

  // 卸载时把最后一次防抖落盘立即冲掉（避免关书丢尾部进度）
  useEffect(() => () => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null }
  }, [])

  /** 应用书页样式（字号/纸色）。每个 section 加载后都要重挂一次 —— style 槽随文档走 */
  const applyStyles = useCallback(() => {
    const view = viewRef.current
    if (!view?.renderer) return
    try { view.renderer.setStyles(buildStyles(fontScaleRef.current, paperRef.current)) } catch { /* 样式失败不影响阅读 */ }
  }, [])

  /** 状态广播（toc 整棵树只在首次/被请求时带 —— 每翻页重发是纯浪费） */
  const sendState = useCallback((withToc: boolean) => {
    const view = viewRef.current
    if (!view) return
    try {
      window.dispatchEvent(new CustomEvent(KB_EPUB_STATE, {
        detail: {
          relPath,
          cfi: cfiRef.current,
          chapterLabel: chapterRef.current,
          chapterHref: '',
          ...(withToc ? { toc: (view.book?.toc ?? []) as EpubTocItem[] } : {}),
        },
      }))
    } catch { /* 广播失败不影响阅读 */ }
  }, [relPath])

  // ===== 打开书：读字节 → foliate 打开 → 恢复位置 → 发首帧状态 =====
  useEffect(() => {
    let alive = true
    const host = hostRef.current
    if (!host) return

    setLoading(true)
    setLoadErr('')
    setPct(0)
    setChapter('')
    chapterRef.current = ''
    cfiRef.current = ''
    pctRef.current = 0
    restoringRef.current = true
    readyRef.current = false
    setCapture(null)
    setNotePop(null)

    const view = new View()
    viewRef.current = view
    view.style.display = 'block'
    view.style.width = '100%'
    view.style.height = '100%'

    /** 重新应用全部 EPUB 摘录高亮（section 重建 / 摘录增删后都要重画） */
    const applyAnnotations = async () => {
      const v = viewRef.current
      if (!v) return
      for (const cfi of annColorRef.current.keys()) {
        try { await v.addAnnotation({ value: cfi }) } catch { /* CFI 失效（换书/换版本）忽略 */ }
      }
    }

    /** 键盘翻页（内容帧与宿主各挂一次：帧内事件不冒泡到宿主 document） */
    const handleKey = (e: KeyboardEvent): boolean => {
      const v = viewRef.current
      if (!v || e.ctrlKey || e.metaKey || e.altKey) return false
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { void v.prev(); return true }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { void v.next(); return true }
      return false
    }

    /**
     * 内容帧里挂监听。doc 是同源 blob:，`getSelection` / keydown 都能直接挂 ——
     * 这正是「电子书内容帧只能同源」的由来（引擎分页必须读 contentDocument，铁律 10 唯一例外）。
     */
    const bindDoc = (doc: Document, index: number) => {
      if (boundDocsRef.current.has(doc)) return
      boundDocsRef.current.add(doc)
      const onUp = () => {
        setTimeout(() => {
          const sel = doc.getSelection()
          if (!sel || sel.isCollapsed || sel.rangeCount !== 1) { setCapture(null); return }
          const range = sel.getRangeAt(0)
          const text = sel.toString()
          if (!text.trim()) { setCapture(null); return }
          const v = viewRef.current
          if (!v) return
          let cfi = ''
          try { cfi = v.getCFI(index, range) } catch { cfi = '' }
          if (!cfi) { setCapture(null); return }
          // 选区矩形在**帧内坐标系**：帧元素偏移由 frameElement 补上（同源才拿得到）
          const fr = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
          const r = range.getBoundingClientRect()
          setNotePop(null)
          setCapture({
            rect: { left: r.left + (fr?.left ?? 0), top: r.top + (fr?.top ?? 0), width: r.width, height: r.height },
            cfi, text,
          })
        }, 0)
      }
      const onKeyDown = (e: KeyboardEvent) => { if (handleKey(e)) e.preventDefault() }
      doc.addEventListener('mouseup', onUp)
      doc.addEventListener('keydown', onKeyDown)
    }

    const onRelocate = (e: Event) => {
      const d = (e as CustomEvent).detail as FoliateRelocateDetail
      if (!d) return
      const nextPct = Number.isFinite(d.fraction) ? Math.min(100, Math.max(0, Math.round(d.fraction * 100))) : 0
      const label = typeof d.tocItem?.label === 'string' ? d.tocItem.label : ''
      const href = typeof d.tocItem?.href === 'string' ? d.tocItem.href : ''
      cfiRef.current = typeof d.cfi === 'string' ? d.cfi : ''
      pctRef.current = nextPct
      chapterRef.current = label
      setPct(nextPct)
      setChapter(label)
      try {
        window.dispatchEvent(new CustomEvent(KB_READER_STATE_CHANGED, { detail: { relPath, kind: 'epub', pct: nextPct } }))
      } catch { /* 广播失败不影响阅读 */ }
      persist(nextPct, cfiRef.current)
      // 左栏目录面板靠这个高亮当前章节；label 兜底（有些书目录项没有 href）
      try {
        window.dispatchEvent(new CustomEvent(KB_EPUB_STATE, {
          detail: { relPath, cfi: cfiRef.current, chapterLabel: label, chapterHref: href },
        }))
      } catch { /* 同上 */ }
    }

    const onLoad = (e: Event) => {
      const d = (e as CustomEvent).detail as { doc?: Document; index?: number } | undefined
      if (!d?.doc || typeof d.index !== 'number') return
      applyStyles()
      bindDoc(d.doc, d.index)
    }

    const onDraw = (e: Event) => {
      const d = (e as CustomEvent).detail as { draw?: (f: unknown, o?: Record<string, unknown>) => void; annotation?: { value?: string } }
      const color = d?.annotation?.value ? annColorRef.current.get(d.annotation.value) : undefined
      if (!d?.draw || !color) return
      d.draw(Overlayer.highlight, { color: HL_FILL[color] })
    }

    const onCreateOverlay = () => { void applyAnnotations() }

    const onShowAnnotation = (e: Event) => {
      const d = (e as CustomEvent).detail as { value?: string; index?: number; range?: Range } | undefined
      if (!d?.value || !d.range) return
      const ex = excerptsRef.current.find((x) => x.kind === 'epub' && x.cfi === d.value)
      if (!ex) return
      const doc = view.getContents().find((x) => x.index === d.index)?.doc
      const fr = (doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
      const r = d.range.getBoundingClientRect()
      setCapture(null)
      setNotePop({
        rect: { left: r.left + (fr?.left ?? 0), top: r.top + (fr?.top ?? 0), width: r.width, height: r.height },
        excerpt: ex,
      })
    }

    const onHostKeyDown = (e: KeyboardEvent) => {
      const hostEl = hostRef.current
      const t = e.target as Node | null
      if (!hostEl || !t || !hostEl.contains(t)) return  // 焦点不在阅读器内 → 让给全局快捷键
      if (handleKey(e)) e.preventDefault()
    }

    const onStateReq = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string } | undefined
      if (d?.relPath === relPath) sendState(true)
    }

    view.addEventListener('relocate', onRelocate)
    view.addEventListener('load', onLoad)
    view.addEventListener('draw-annotation', onDraw)
    view.addEventListener('create-overlay', onCreateOverlay)
    view.addEventListener('show-annotation', onShowAnnotation)
    host.appendChild(view)
    window.addEventListener('keydown', onHostKeyDown)
    window.addEventListener(KB_EPUB_STATE_REQ, onStateReq)

    void (async () => {
      try {
        // 1) 书级记忆（进度 + 位置 + 字号 + 纸色）
        const st = await readerStateGet(rootId, relPath)
        if (!alive) return
        let savedLocator = ''
        let savedPct = 0
        if (st.ok && st.state) {
          expectedUpdatedAtRef.current = st.state.updatedAt
          savedPct = typeof st.state.pct === 'number' ? st.state.pct : 0
          savedLocator = typeof st.state.locator === 'string' ? st.state.locator : ''
          const fs = typeof st.state.fontScale === 'number' && st.state.fontScale >= 0.5 && st.state.fontScale <= 3 ? st.state.fontScale : 1
          fontScaleRef.current = fs
          setFontScale(fs)
          const pp: ReaderPaper = st.state.paper === 'sepia' || st.state.paper === 'green' || st.state.paper === 'dark' ? st.state.paper : 'default'
          paperRef.current = pp
          setPaper(pp)
        } else {
          expectedUpdatedAtRef.current = undefined
        }

        // 2) 整本字节 → File（foliate 用 ZIP 魔数分流，name 给 .epub 只为可读性与 isCBZ 判断不出错）
        const bytes = await readWholeBook(rootId, relPath)
        if (!alive) return
        const file = new File([bytes], `${name || 'book'}.epub`, { type: 'application/epub+zip' })

        await view.open(file)
        if (!alive) return
        await view.init({ showTextStart: true })
        if (!alive) return
        readyRef.current = true
        setLoading(false)

        // 3) 恢复位置：locator（CFI）优先，失败退化到 pct。★ foliate 的 goTo 内部吞异常
        //    （resolveNavigation / renderer.goTo 各自 try-catch 后返回 undefined），
        //    所以**判据是返回值**，不是 try/catch。
        let restored = false
        if (savedLocator) restored = !!(await view.goTo(savedLocator))
        if (!alive) return
        if (!restored && savedPct > 0) {
          try { await view.goToFraction(savedPct / 100); restored = true } catch { /* 停在首屏 */ }
        }
        if (!alive) return
        if (!restored && pctRef.current === 0 && savedPct > 0) { pctRef.current = savedPct; setPct(savedPct) }
        applyStyles()
        // 首帧状态带目录（左栏面板可能比阅读器挂得晚，它也会用 KB_EPUB_STATE_REQ 主动要一次）
        sendState(true)
        // 恢复完成后才解锁落盘（否则恢复过程中的 relocate 会把位置写花）
        requestAnimationFrame(() => { restoringRef.current = false })
      } catch (e) {
        if (!alive) return
        setLoadErr(String((e as Error)?.message || e))
        setLoading(false)
      }
    })()

    return () => {
      alive = false
      window.removeEventListener('keydown', onHostKeyDown)
      window.removeEventListener(KB_EPUB_STATE_REQ, onStateReq)
      view.removeEventListener('relocate', onRelocate)
      view.removeEventListener('load', onLoad)
      view.removeEventListener('draw-annotation', onDraw)
      view.removeEventListener('create-overlay', onCreateOverlay)
      view.removeEventListener('show-annotation', onShowAnnotation)
      try { view.close() } catch { /* 已销毁 */ }
      try { view.remove() } catch { /* 已摘除 */ }
      viewRef.current = null
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, relPath])

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

  /** EPUB 摘录（有 cfi 的）→ 高亮同步：写 cfi→色 表（供 foliate 回调查表）+ 重画 */
  const epubExcerpts = useMemo(() => excerpts.filter((e) => e.kind === 'epub' && !!e.cfi), [excerpts])
  useEffect(() => {
    const m = new Map<string, ExcerptColor>()
    for (const e of epubExcerpts) m.set(e.cfi as string, e.color)
    annColorRef.current = m
    excerptsRef.current = excerpts
    const view = viewRef.current
    if (!view || !readyRef.current) return
    // 先删再添：foliate 内部同 key 会自行替换，这里只需把表里已有的 cfi 都画一遍
    for (const cfi of m.keys()) {
      void view.addAnnotation({ value: cfi }).catch(() => { /* CFI 失效忽略 */ })
    }
  }, [epubExcerpts, excerpts])

  // ===== 右栏摘录 / 左栏目录 → 跳 CFI =====
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; cfi?: string } | undefined
      const view = viewRef.current
      if (!d?.cfi || d.relPath !== relPath || !view) return
      void (async () => {
        // 同 3) 的判据：goTo 失败返回 falsy（内部已吞异常）
        const ok = await view.goTo(d.cfi as string)
        if (!ok) showToast({ type: 'info', message: '这条摘录的位置在当前书里已失效' })
      })()
    }
    window.addEventListener(KB_EPUB_GOTO_CFI, onGoto)
    return () => window.removeEventListener(KB_EPUB_GOTO_CFI, onGoto)
  }, [relPath])

  // ===== 字号 / 纸色（书级记忆）=====
  const changeFont = useCallback((delta: number) => {
    const next = Math.min(3, Math.max(0.5, Math.round((fontScaleRef.current + delta) * 10) / 10))
    if (next === fontScaleRef.current) return
    fontScaleRef.current = next
    setFontScale(next)
    applyStyles()
    void patchReader({ fontScale: next })
  }, [applyStyles, patchReader])

  const cyclePaper = useCallback(() => {
    const order: ReaderPaper[] = ['default', 'sepia', 'green', 'dark']
    const next = order[(order.indexOf(paperRef.current) + 1) % order.length]
    paperRef.current = next
    setPaper(next)
    applyStyles()
    void patchReader({ paper: next })
  }, [applyStyles, patchReader])

  const turn = useCallback((dir: -1 | 1) => {
    const view = viewRef.current
    if (!view) return
    void (dir < 0 ? view.prev() : view.next())
  }, [])

  // ===== 划选 → 建摘录 =====
  const handleCreateExcerpt = useCallback((text: string, color: ExcerptColor, type: ExcerptType, note?: string) => {
    if (!capture || !rootId) return
    const cfi = capture.cfi
    const chapter = chapterRef.current
    // 乐观上色：先画上，写盘失败再撤（摘录广播回来时会被同值覆盖，不会闪）
    annColorRef.current.set(cfi, color)
    void excerptCreate(rootId, relPath, {
      kind: 'epub',
      text,
      cfi,
      ...(chapter ? { chapter: chapter.slice(0, 200) } : {}),
      color,
      type,
      note,
    }).then((r) => {
      if (!r.ok) {
        annColorRef.current.delete(cfi)
        showToast({ type: 'error', message: r.error || '摘录创建失败' })
      }
    }).catch((e) => {
      annColorRef.current.delete(cfi)
      showToast({ type: 'error', message: String((e as Error)?.message || e) })
    })
    setCapture(null)
  }, [capture, rootId, relPath])

  const handleAsk = useCallback((t: string) => {
    window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', { detail: { action: 'ask', text: t } }))
    setCapture(null)
  }, [])

  const handleTranslate = useCallback((t: string, r: SelectionRect) => {
    window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', {
      detail: { action: 'translate', text: t, rect: { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height } },
    }))
    setCapture(null)
  }, [])

  const deleteExcerpt = useCallback((e: ExcerptItem) => {
    setNotePop(null)
    void excerptDelete(rootId, relPath, e.id).catch(() => { /* 忽略 */ })
  }, [rootId, relPath])

  const paperStyle: CSSProperties = paper === 'sepia'
    ? { filter: 'sepia(0.32) brightness(0.97) saturate(0.92)' }
    : paper === 'dark'
      ? { backgroundColor: '#1c1c1e' }
      : paper === 'green'
        ? { backgroundColor: '#c9e7c4' }
        : {}

  const paperLabel = paper === 'sepia' ? '护眼' : paper === 'green' ? '绿纸' : paper === 'dark' ? '暗色' : '默认'

  const toolbar = (
    <div className="kb-fit kb-fit-pdfread flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-secondary)]">
      {onBack && (
        <>
          <button onClick={onBack} title={backLabel ?? '返回书架'} data-wb="epubBack"
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ArrowLeft size={13} /><span className="kb-l1">{backLabel ?? '返回书架'}</span>
          </button>
          <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        </>
      )}
      <span className="max-w-[220px] truncate text-[var(--text-primary)]">{name}</span>
      <span className="kb-l3 text-[var(--text-tertiary)]">EPUB</span>
      {/* data-wb 锚点：探针断言「目录跳转真的换了章」（无锚点时只能读整条 toolbar 文本） */}
      {chapter && <span data-wb="epubChapter" className="kb-l1 min-w-0 truncate text-[var(--text-tertiary)]">· {chapter}</span>}
      <div className="min-w-0 flex-1" />
      <button onClick={() => turn(-1)} title="上一页（←）" data-wb="epubPrev"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ChevronLeft size={15} /></button>
      <button onClick={() => turn(1)} title="下一页（→ / 空格）" data-wb="epubNext"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ChevronRight size={15} /></button>
      <button onClick={() => changeFont(-0.1)} title="缩小字号" data-wb="epubFontDec"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Type size={13} /><span className="text-[10px]">−</span></button>
      <button onClick={() => changeFont(0.1)} title="放大字号" data-wb="epubFontInc"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Type size={13} /><span className="text-[10px]">＋</span></button>
      <button onClick={cyclePaper} title={`纸色：${paperLabel}`} data-wb="epubPaper"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Contrast size={14} /></button>
      <span className="shrink-0 text-[var(--text-tertiary)]" data-wb="epubPct">{pct}%</span>
    </div>
  )

  return (
    <div data-wb="epubReader" data-wb-state={loadErr ? 'error' : loading ? 'loading' : 'ready'}
      className="relative flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {toolbar}
      {loadErr ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-[var(--text-muted)]">{loadErr}</div>
      ) : (
        /* 渲染宿主常驻 DOM：foliate 要读宿主尺寸才能分页，加载态只做**覆盖层**而不是替换内容 */
        <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" style={paperStyle} />
      )}
      {loading && !loadErr && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[34px] flex items-center justify-center">
          <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
        </div>
      )}

      {capture && (
        <ExcerptCaptureBar
          rect={capture.rect}
          text={capture.text}
          onCreate={handleCreateExcerpt}
          onAsk={handleAsk}
          onTranslate={handleTranslate}
          onClose={() => setCapture(null)}
        />
      )}

      {/* 点已有高亮 → 极简回看卡（正文 → 摘录的回路；完整编辑仍在右栏阅读侧栏） */}
      {notePop && (
        <div className="kb-pop fixed z-[60] w-[260px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 p-2 shadow-lg backdrop-blur"
          style={{ left: Math.min(Math.max(8, notePop.rect.left), Math.max(8, window.innerWidth - 268)), top: notePop.rect.top + notePop.rect.height + 8 }}>
          <div className="mb-1 flex items-center gap-1.5">
            <span className={`kb-exc-dot kb-exc-${notePop.excerpt.color}`} />
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-tertiary)]">{notePop.excerpt.chapter || '正文'}</span>
            <button onClick={() => deleteExcerpt(notePop.excerpt)} title="删除这条摘录"
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-warning)]"><Trash2 size={11} /></button>
            <button onClick={() => setNotePop(null)} title="关闭"
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={11} /></button>
          </div>
          <div className="line-clamp-3 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{notePop.excerpt.text}</div>
          {notePop.excerpt.note && (
            <div className="mt-1 rounded bg-[var(--bg-hover)]/60 px-1.5 py-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">{notePop.excerpt.note}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default EpubReaderView
