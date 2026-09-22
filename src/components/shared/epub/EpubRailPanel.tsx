import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen } from 'lucide-react'
import { KB_EPUB_GOTO_CFI, KB_EPUB_STATE, KB_EPUB_STATE_REQ, type EpubTocItem } from '../pdf/pdfEvents'

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
    if (!relPath) return
    try { window.dispatchEvent(new CustomEvent(KB_EPUB_STATE_REQ, { detail: { relPath } })) } catch { /* 忽略 */ }
  }, [relPath])

  const jump = useCallback((item: EpubTocItem) => {
    if (!relPath || !item.href) return
    // href 与 CFI 都是 foliate goTo 的合法目标，阅读器侧统一走 view.goTo()
    window.dispatchEvent(new CustomEvent(KB_EPUB_GOTO_CFI, { detail: { relPath, cfi: item.href } }))
  }, [relPath])

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

  if (!relPath) {
    return (
      <div data-wb="epubRailPanel" data-wb-state="empty" className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-muted)]">
        <BookOpen size={26} strokeWidth={1.4} />
        <div className="text-[12px] leading-relaxed">从书架选一本 EPUB 开始阅读<br />这里会显示它的目录</div>
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
          ? <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">这本 EPUB 没有目录</div>
          : renderNodes(toc, 0)}
      </div>
    </div>
  )
}
