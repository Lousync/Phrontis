import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen } from 'lucide-react'
import {
  KB_CBZ_THUMBS, KB_CBZ_THUMB_REQ,
  KB_EPUB_GOTO_CFI, KB_EPUB_STATE, KB_EPUB_STATE_REQ, type EpubTocItem,
} from '../pdf/pdfEvents'
// 格式判据走真相源（与 EpubReaderView 同一条 import 路径）；本文件仍**不引入 foliate 引擎**。
import { bookKindOf } from '../../../../electron/lib/kbStore/bookFormats'

/** 缩略图格宽度（高由图片自身比例决定，见 TILE_H 的说明） */
const TILE_W = 96
/** 格子固定高度：页面比例千奇百怪，格子统一高才能让占位符与图片互换时不抖、网格行高稳定。 */
const TILE_H = 138
/** 每批请求在「可见范围」外再扩这么多项（≈ 一屏）。滚动时留够缓冲，避免每移一格都要一次往返。 */
const PREFETCH_MARGIN = 12

/**
 * 左栏 bookshelf 模块态「EPUB 目录」（B 段 · 方案 §四）。
 *
 * ★ 与 PdfRailPanel 的关键差异：**本文件不引入 foliate 引擎**。目录树由阅读器经
 * `KB_EPUB_STATE` 广播过来（阅读器本来就已经解析过整本书，左栏再解一遍是纯浪费 ——
 * PDF 那边没得选：pdfjs 的大纲无法序列化成可传值，而 EPUB 的 `book.toc` 本身就是普通对象）。
 * 面板挂载晚于阅读器时用 `KB_EPUB_STATE_REQ` 主动要一次（阅读器只对该书应答）。
 *
 * ★ 本面板**只有目录树，没有切换头**（2026-09-21 拍板，2026-09-22 落码）：
 * **某格式不支持的功能，侧栏不出对应入口，不做「中性空态占位」**。理由是 Tab 头本身就在宣称
 * 「这里有东西」，点开却是空态，读起来像「坏了 / 点了没反应」；「此格式还有什么」交给文档说更合适。
 * 据此原先的缩略图 / 书签两个空态 Tab 一并撤掉 —— EPUB 无「页」概念，缩略图格式层面就不存在
 * （**明确不做**）；书签的定位能力 foliate 有（CFI），但存储口径未定（`TxtBookmark.paraIndex` 是数字），
 * **未拍板前不出入口**。将来这件真正做出来时，按同一条规则办：**能用了才出 Tab**。
 *
 * `data-wb` / `data-wb-state` 锚点与 PdfRailPanel 同惯例（探针脚本按锚点找元素）。
 */
export function EpubRailPanel({ readerDoc }: {
  /** 当前在读的书（App 上收的阅读态；本面板只用 relPath） */
  readerDoc: { relPath: string } | null
}) {
  const [toc, setToc] = useState<EpubTocItem[]>([])
  const [chapterHref, setChapterHref] = useState('')
  const [chapterLabel, setChapterLabel] = useState('')

  const relPath = readerDoc?.relPath ?? null

  /** 固定版式（cbz，漫画/画集）：目录 = 页表，面板换成缩略图网格（plan 阶段 2b）。
   *  判据取真相源推导的 kind，与 EpubReaderView 的 `isFixedLayoutBook` 同一口径。 */
  const isComic = !!relPath && bookKindOf(relPath) === 'cbz'
  /** 页号 → data URL（`null` = 生成失败，留占位不重试）。用对象而非 Map：React 靠引用变化重渲。 */
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({})
  /** 已经向阅读器要过的页号（**面板侧**去重）。阅读器侧虽有缓存判断，但重复请求会白填队列。 */
  const requestedRef = useRef<Set<number>>(new Set())
  const gridRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onState = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; toc?: EpubTocItem[]; cfi?: string; chapterLabel?: string; chapterHref?: string } | undefined
      if (!d || d.relPath !== relPath) return
      if (Array.isArray(d.toc)) setToc(d.toc)
      if (typeof d.chapterHref === 'string') setChapterHref(d.chapterHref)
      if (typeof d.chapterLabel === 'string') setChapterLabel(d.chapterLabel)
    }
    window.addEventListener(KB_EPUB_STATE, onState)
    return () => window.removeEventListener(KB_EPUB_STATE, onState)
  }, [relPath])

  // 挂载 / 换书：要一次状态（阅读器可能先于本面板就绪，首帧广播已经发过了）
  useEffect(() => {
    setToc([])
    setChapterHref('')
    setChapterLabel('')
    // 换书即作废缩略图：data URL 不需要 revoke，丢引用即可；已请求集合必须一并清空，
    // 否则下一本书的同号页会被当成「已要过」而永远拿不到图。
    setThumbs({})
    requestedRef.current = new Set()
    if (!relPath) return
    try { window.dispatchEvent(new CustomEvent(KB_EPUB_STATE_REQ, { detail: { relPath } })) } catch { /* 忽略 */ }
  }, [relPath])

  const jump = useCallback((item: EpubTocItem) => {
    if (!relPath || !item.href) return
    // href 与 CFI 都是 foliate goTo 的合法目标，阅读器侧统一走 view.goTo()
    window.dispatchEvent(new CustomEvent(KB_EPUB_GOTO_CFI, { detail: { relPath, cfi: item.href } }))
  }, [relPath])

  // ===== 缩略图网格（仅 cbz）：要图 / 收图 / 按可见范围预取 =====
  /** 向阅读器要一段页的缩略图（闭区间）。只对还没要过的页发起，避免滚动时反复填队列。 */
  const requestThumbs = useCallback((from: number, to: number) => {
    if (!relPath || !toc.length) return
    const f = Math.max(0, Math.min(from, toc.length - 1))
    const t = Math.max(0, Math.min(to, toc.length - 1))
    if (t < f) return
    let lo = -1
    let hi = -1
    for (let i = f; i <= t; i++) {
      if (requestedRef.current.has(i)) continue
      requestedRef.current.add(i)
      if (lo < 0) lo = i
      hi = i
    }
    if (lo < 0) return
    window.dispatchEvent(new CustomEvent(KB_CBZ_THUMB_REQ, { detail: { relPath, from: lo, to: hi } }))
  }, [relPath, toc.length])

  useEffect(() => {
    if (!isComic || !relPath) return
    const onThumbs = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; from?: number; items?: (string | null | undefined)[] } | undefined
      if (!d || d.relPath !== relPath || !Array.isArray(d.items)) return
      const from = Math.max(0, Math.floor(Number(d.from) || 0))
      setThumbs((prev) => {
        const next = { ...prev }
        let changed = false
        for (let i = 0; i < d.items!.length; i++) {
          const v = d.items![i]
          if (v === undefined) continue      // 还在阅读器队列里，稍后会补一条同 index 的消息
          const idx = from + i
          if (next[idx] !== v) { next[idx] = v; changed = true }
        }
        return changed ? next : prev
      })
    }
    window.addEventListener(KB_CBZ_THUMBS, onThumbs)
    return () => window.removeEventListener(KB_CBZ_THUMBS, onThumbs)
  }, [isComic, relPath])

  /** 按**可见范围**要图（不是一次性全要）：生成缩略图要解压 + 解码，都在主线程，
   *  整本预取会把阅读器卡住；一屏 + 一屏缓冲足够跟手。
   *  ★ 用 IntersectionObserver 而不是自己按 scrollTop 算行号：列数由 `auto-fill` 决定，
   *  自己算就等于把布局规则抄第二遍（改一处忘一处就错行）。 */
  useEffect(() => {
    if (!isComic || !relPath) return
    const root = gridRef.current
    if (!root) return
    const tiles = Array.from(root.querySelectorAll<HTMLElement>('[data-cbz-page]'))
    if (!tiles.length) return
    const visible = new Set<number>()
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const i = Number((en.target as HTMLElement).dataset.cbzPage)
        if (!Number.isFinite(i)) continue
        if (en.isIntersecting) visible.add(i)
        else visible.delete(i)
      }
      if (!visible.size) return
      let lo = Infinity
      let hi = -Infinity
      for (const i of visible) { if (i < lo) lo = i; if (i > hi) hi = i }
      requestThumbs(lo - PREFETCH_MARGIN, hi + PREFETCH_MARGIN)
    }, { root })
    for (const t of tiles) io.observe(t)
    return () => io.disconnect()
  }, [isComic, relPath, toc, requestThumbs])

  /** 当前章节：href 精确命中优先；没有 href 的书用 label 兜底 */
  const activeHref = useMemo(() => {
    if (!chapterHref) return ''
    const hit = (items: EpubTocItem[]): string => {
      for (const it of items) {
        if (it.href === chapterHref) return chapterHref
        if (it.subitems?.length) { const r = hit(it.subitems); if (r) return r }
      }
      return ''
    }
    return hit(toc)
  }, [toc, chapterHref])

  // ===== cbz：缩略图网格 =====
  // cbz 的 `book.toc` 就是页表（每项 label/href 都是 zip 内的文件名），所以这里不画目录树，
  // 直接复用同一份 toc 当「第 N 页」列表；点击仍走 KB_EPUB_GOTO_CFI 的既有路径
  // （foliate 的 `resolveHref` 认文件名），高亮仍比对 chapterHref —— 阅读器侧为此
  // **特意没把 href 换成页码**（见 EpubReaderView 的 onRelocate 注释）。
  if (isComic) {
    return (
      <div data-wb="epubRailPanel" data-wb-state="comic" className="flex h-full min-h-0 flex-col">
        {/* 滚动容器要 flex-1 + min-h-0（**不是**给模块根节点写 flex-1 —— 槽位是块级 div，那是死属性） */}
        <div ref={gridRef} data-wb="cbzGrid" className="min-h-0 flex-1 overflow-auto p-2">
          {toc.length === 0 ? (
            <div className="px-1 py-1 text-[12px] text-[var(--text-muted)]">正在读取页表…</div>
          ) : (
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_W}px, 1fr))` }}>
              {toc.map((it, i) => {
                const url = thumbs[i]
                const active = !!activeHref && it.href === activeHref
                return (
                  <button
                    key={`${i}-${it.href ?? ''}`}
                    data-cbz-page={i}
                    onClick={() => jump(it)}
                    disabled={!it.href}
                    title={it.label || `第 ${i + 1} 页`}
                    className="kb-cv-tile kb-item-in flex flex-col items-center rounded p-0.5 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  >
                    <span
                      className={`flex w-full items-center justify-center overflow-hidden rounded border bg-[var(--bg-secondary)] ${active ? 'border-[var(--accent)]' : 'border-[var(--border-color)]'}`}
                      style={{ height: TILE_H }}
                    >
                      {/* 未就绪（还在队列 / 生成失败）→ 只显示页码占位，格子高度不变，图到了原地替换 */}
                      {url
                        ? <img src={url} alt="" draggable={false} className="h-full w-full object-contain" />
                        : <span className="text-[10px] text-[var(--text-muted)]">{i + 1}</span>}
                    </span>
                    <span className={`kb-l1 mt-0.5 text-[10px] leading-[16px] ${active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'}`}>{i + 1}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!relPath) {
    return (
      <div data-wb="epubRailPanel" data-wb-state="empty" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-muted)]">
        <BookOpen size={26} strokeWidth={1.4} />
        {/* 文案保持格式中立（本面板同时服务 epub / fb2 / fbz，写死「EPUB」会在后两种格式上撒谎） */}
        <div className="text-[12px] leading-relaxed">从书架选一本书开始阅读<br />这里会显示它的目录</div>
      </div>
    )
  }

  const renderNodes = (items: EpubTocItem[], depth: number) => items.map((it, i) => {
    const active = !!activeHref ? it.href === activeHref : (!!chapterLabel && it.label === chapterLabel && !it.subitems?.length)
    return (
      <div key={`${depth}-${i}-${it.href ?? it.label ?? ''}`}>
        <button
          onClick={() => jump(it)}
          disabled={!it.href}
          title={it.href || it.label || ''}
          className={`kb-item-in flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11.5px] leading-snug ${active ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'} disabled:opacity-50`}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <span className="min-w-0 flex-1 truncate">{it.label || '(未命名)'}</span>
        </button>
        {it.subitems?.length ? renderNodes(it.subitems, depth + 1) : null}
      </div>
    )
  })

  return (
    <div data-wb="epubRailPanel" data-wb-state="ready" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {toc.length === 0
          ? <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">这本书没有目录</div>
          : renderNodes(toc, 0)}
      </div>
    </div>
  )
}
