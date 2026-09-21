import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, BookOpen, LayoutGrid, ListTree } from 'lucide-react'
import { KB_EPUB_GOTO_CFI, KB_EPUB_STATE, KB_EPUB_STATE_REQ, type EpubTocItem } from '../pdf/pdfEvents'

/**
 * 左栏 bookshelf 模块态「EPUB 目录」（B 段 · 方案 §四）。
 *
 * ★ 与 PdfRailPanel 的关键差异：**本文件不引入 foliate 引擎**。目录树由阅读器经
 * `KB_EPUB_STATE` 广播过来（阅读器本来就已经解析过整本书，左栏再解一遍是纯浪费 ——
 * PDF 那边没得选：pdfjs 的大纲无法序列化成可传值，而 EPUB 的 `book.toc` 本身就是普通对象）。
 * 面板挂载晚于阅读器时用 `KB_EPUB_STATE_REQ` 主动要一次（阅读器只对该书应答）。
 *
 * 缩略图 / 书签：B 段没有实现（EPUB 书签键是 CFI，塞进 TxtBookmark 的 paraIndex 形状会串味），
 * 两个 Tab 用中性空状态占位 —— 保留 Tab 而不是藏起来，是为了让「此格式有什么」一眼可知。
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
  const [section, setSection] = useState<'outline' | 'thumbs' | 'bookmarks'>('outline')

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

  const tabCls = (active: boolean) =>
    `flex flex-1 items-center justify-center gap-1 rounded px-1 py-1 text-[11px] ${active ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`

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
      {/* 三区切换（文字按容器宽度退化，与 PdfRailPanel 同款 .kb-fit） */}
      <div className="kb-fit kb-fit-pdfrail mx-1.5 mb-1 flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-color)] p-0.5">
        <button onClick={() => setSection('outline')} className={tabCls(section === 'outline')} title="目录"><ListTree size={12} /><span className="kb-l1">目录</span></button>
        <button onClick={() => setSection('thumbs')} className={tabCls(section === 'thumbs')} title="缩略图"><LayoutGrid size={12} /><span className="kb-l1">缩略图</span></button>
        <button onClick={() => setSection('bookmarks')} className={tabCls(section === 'bookmarks')} title="书签"><BookMarked size={12} /><span className="kb-l1">书签</span></button>
      </div>
      {section === 'outline' && (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {toc.length === 0
            ? <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">这本 EPUB 没有目录</div>
            : renderNodes(toc, 0)}
        </div>
      )}
      {section === 'thumbs' && (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[12px] leading-relaxed text-[var(--text-muted)]">
          EPUB 暂不支持缩略图
        </div>
      )}
      {section === 'bookmarks' && (
        <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[12px] leading-relaxed text-[var(--text-muted)]">
          EPUB 暂不支持书签
        </div>
      )}
    </div>
  )
}
