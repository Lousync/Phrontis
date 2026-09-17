import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

interface Props {
  pdf: PDFDocumentProxy | null
  numPages: number
  /** 当前页（duo 模式下 p 与 p+1 双亮，原型 v9 修复口径） */
  current: number
  duo?: boolean
  onJump: (n: number) => void
}

/**
 * 缩略图栅格（方案 §5.5）：可视区才渲染（IntersectionObserver，同封面管线），
 * 渲染结果保内存（小尺寸 dataUrl，超量清退防泄漏）；当前页高亮，duo 双亮。
 * 注意键名口径：缩略图元素用 data-p（区别于阅读器页槽的 data-pg）。
 */
const THUMB_W = 104
const MAX_CACHED = 160

export function PdfThumbGrid({ pdf, numPages, current, duo = false, onJump }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  /** dataUrl 缓存（页码 → dataUrl），超量整体清退（重新滚动再渲染） */
  const cacheRef = useRef(new Map<number, string>())
  const [, force] = useState(0)

  const renderThumb = useCallback(async (n: number) => {
    if (!pdf || cacheRef.current.has(n)) return
    try {
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const scale = THUMB_W / base.width
      const viewport = page.getViewport({ scale })
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise
      if (cacheRef.current.size >= MAX_CACHED) cacheRef.current.clear()
      cacheRef.current.set(n, canvas.toDataURL('image/png'))
      force((t) => t + 1)
    } catch { /* 单页失败跳过 */ }
  }, [pdf, force])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !pdf) return
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const n = Number((en.target as HTMLElement).dataset.p)
        if (n) void renderThumb(n)
      }
    }, { root: host, rootMargin: '240px' })
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-p]'))) io.observe(el)
    return () => { io.disconnect() }
  }, [pdf, numPages, renderThumb])

  const activeSet = duo ? new Set([current, current + 1]) : new Set([current])

  return (
    <div ref={hostRef} className="kb-view-in min-h-0 flex-1 overflow-y-auto p-2">
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: numPages }, (_, i) => {
          const n = i + 1
          const url = cacheRef.current.get(n)
          const active = activeSet.has(n)
          return (
            <button key={n} data-p={n} onClick={() => onJump(n)}
              title={`第 ${n} 页`}
              className={`group relative rounded-md border p-0.5 transition-colors ${active ? 'border-[var(--accent)]' : 'border-transparent hover:border-[var(--border-color)]'}`}>
              <div className="relative w-full overflow-hidden rounded bg-[var(--bg-primary)]" style={{ aspectRatio: '3 / 4' }}>
                {url
                  ? <img src={url} alt={`第 ${n} 页`} draggable={false} className="absolute inset-0 h-full w-full object-cover" />
                  : <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--text-tertiary)]">{n}</div>}
                <span className={`absolute bottom-0.5 right-0.5 rounded px-1 text-[9.5px] ${active ? 'bg-[var(--accent)] text-white' : 'bg-black/45 text-white/90'}`}>{n}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

