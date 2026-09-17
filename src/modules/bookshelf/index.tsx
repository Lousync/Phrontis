import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Import, Loader2, Play } from 'lucide-react'
import {
  pdfReaderCoverList, pdfReaderListBooks, wsImportPdf, workspaceGetCurrent,
} from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
import type { PdfBookListItem } from '../../types'
import { PdfCover } from './PdfCover'

/**
 * 书架（v3.4.0 PDF 阅读体验整包批次 2，方案 §2/§8）：
 * - 自动库 = 扫 vault 全部 .pdf（pdfReader:listBooks），清单不落盘；
 * - 封面网格（PdfCover 懒渲染 + covers 缓存）；续读条（hasProgress 按最近读排序）；
 * - 「＋导入」= ws:importPdf（外部 PDF 拷入仓库根）；
 * - 点书 = kb-open-in-editor { relPath, from:'bookshelf' }（state+props 范式，编辑器组文档标签每书一个）。
 * 模块根节点 h-full（槽位容器是块级 div，flex-1 无效）。
 */

type SortFn = (a: PdfBookListItem, b: PdfBookListItem) => number

/** 排序 = 最近读优先（updatedAt desc），未读按名称（方案 §8） */
const byRecent: SortFn = (a, b) => {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
  if (ta !== tb) return tb - ta
  return a.name.localeCompare(b.name, 'zh-Hans')
}

export function BookshelfModule({ isActive = true }: { isActive?: boolean }) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [books, setBooks] = useState<PdfBookListItem[] | null>(null)
  /** 封面缓存命中集（coverList 索引 + mtime 对账通过）——PdfCover 据此走 coverGet 直取 */
  const [coverHits, setCoverHits] = useState<Set<string>>(new Set())
  const [loadErr, setLoadErr] = useState('')
  const [importing, setImporting] = useState(false)
  /** 封面内存缓存 relPath → dataUrl（滚动往返免重复取/渲染） */
  const coverMem = useRef(new Map<string, string>())
  const [, forceTick] = useState(0)

  const load = useCallback(async () => {
    try {
      const cur = await workspaceGetCurrent()
      if (!cur?.rootId) {
        setRootId(null)
        setBooks([])
        setCoverHits(new Set())
        return
      }
      setRootId(cur.rootId)
      const [r, cv] = await Promise.all([pdfReaderListBooks(), pdfReaderCoverList()])
      if (!r.ok) throw new Error(r.error ?? 'listBooks failed')
      const nextBooks = r.books ?? []
      setBooks(nextBooks)
      setLoadErr('')
      // 索引命中 = 键存在 + mtime 与当前扫描一致（方案 §3：不符即失效重渲染）
      const hits = new Set<string>()
      for (const b of nextBooks) {
        const entry = cv.ok ? cv.covers?.[`${cur.rootId}/${b.relPath}`] : undefined
        if (entry && entry.mtimeMs === b.mtime) hits.add(b.relPath)
      }
      setCoverHits(hits)
    } catch (e) {
      setLoadErr(String((e as Error)?.message || e))
      setBooks([])
    }
  }, [])

  useEffect(() => { void load() }, [load])
  // 铁律 1：主进程写盘（patch/coverSave/import）后经 windowBus 广播 → 书架自动重拉
  useDataChanged('pdfReader', () => { void load() })

  const onCoverReady = useCallback((relPath: string, url: string) => {
    coverMem.current.set(relPath, url)
    forceTick((t) => t + 1)
  }, [])

  const doImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    try {
      const r = await wsImportPdf()
      if (r.ok) showToast({ type: 'success', message: `已导入 ${r.imported?.length ?? 0} 本 PDF 到仓库根` })
      else if (!r.canceled) showToast({ type: 'warning', message: r.error ?? '导入失败' })
    } finally {
      setImporting(false)
    }
  }, [importing])

  // 未打开仓库
  if (rootId === null && books !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--bg-primary)] text-[var(--text-muted)]">
        <BookOpen size={40} strokeWidth={1.5} />
        <div className="text-[13.5px]">书架</div>
        <div className="max-w-[280px] text-center text-[11.5px] leading-relaxed">先在编辑区打开一个仓库，书架会自动收拢其中的 PDF</div>
      </div>
    )
  }

  const list = books ?? []
  const continueList = list.filter((b) => b.hasProgress).slice(0, 6)
  const gridList = [...list].sort(byRecent)

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {/* 顶栏：标题 + 导入 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2">
        <BookOpen size={15} className="text-[var(--text-secondary)]" />
        <span className="text-[13px] font-medium text-[var(--text-primary)]">书架</span>
        <span className="text-[11.5px] text-[var(--text-tertiary)]">{list.length} 本</span>
        <button
          onClick={() => void doImport()}
          disabled={importing || rootId === null}
          className="kb-micro-pop ml-auto flex items-center gap-1.5 rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          {importing ? <Loader2 size={13} className="animate-spin" /> : <Import size={13} />}导入 PDF
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loadErr && (
          <div className="mb-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] text-[var(--text-warning)]">
            书架加载失败：{loadErr}
          </div>
        )}

        {books !== null && list.length === 0 && !loadErr && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
            <BookOpen size={34} strokeWidth={1.4} />
            <div className="text-[12.5px]">仓库里还没有 PDF</div>
            <div className="text-[11.5px]">把 .pdf 放进仓库任意目录，或点右上角「导入 PDF」</div>
          </div>
        )}

        {/* 续读条 */}
        {continueList.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 text-[11.5px] font-medium text-[var(--text-tertiary)]">续读</div>
            <div className="flex gap-2.5 overflow-x-auto pb-1">
              {continueList.map((b) => (
                <button
                  key={`c-${b.relPath}`}
                  onClick={() => window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: b.relPath, from: 'bookshelf' } }))}
                  className="kb-item-in group flex w-[210px] shrink-0 items-center gap-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 text-left hover:border-[var(--accent)]"
                  title={`第 ${b.lastPage} 页 · 打开继续阅读`}
                >
                  <div className="w-[44px] shrink-0" style={{ aspectRatio: '3 / 4' }}>
                    <PdfCover rootId={rootId ?? ''} relPath={b.relPath} name={b.name} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{b.name.replace(/\.pdf$/i, '')}</div>
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--accent)]">
                      <Play size={10} />第 {b.lastPage} 页
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 封面网格 */}
        {gridList.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-3">
            {gridList.map((b) => (
              <button
                key={b.relPath}
                onClick={() => window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: b.relPath, from: 'bookshelf' } }))}
                className="kb-item-in group text-left"
                title={b.relPath}
              >
                <div className="relative transition-shadow group-hover:shadow-[0_8px_22px_rgba(0,0,0,0.14)] rounded-[10px]">
                  <PdfCover rootId={rootId ?? ''} relPath={b.relPath} name={b.name} mtime={b.mtime} cacheHit={coverHits.has(b.relPath) || coverMem.current.has(b.relPath)} onReady={(u) => onCoverReady(b.relPath, u)} />
                  {b.hasProgress && (
                    <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white">P{b.lastPage}</span>
                  )}
                </div>
                <div className="mt-1.5 truncate px-0.5 text-[11.5px] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{b.name.replace(/\.pdf$/i, '')}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
