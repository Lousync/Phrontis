import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { pdfReaderCoverGet, pdfReaderCoverSave, workspaceReadRange } from '../../lib/ipc'

// 同源 worker（与 PdfReaderView 同口径：v3 classic，兼容 Electron 33 / Chromium 130）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const CHUNK = 128 * 1024

function b64ToU8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 封面渲染专用 transport：与阅读器同构（ws:readRange），渲染完即 destroy（方案 §11.3 防泄漏） */
class CoverRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  constructor(length: number, initialData: Uint8Array | null, private read: (begin: number, end: number) => Promise<Uint8Array>) {
    super(length, initialData)
  }
  requestDataRange(begin: number, end: number): void {
    void this.read(begin, end).then(
      (chunk) => this.onDataRange(begin, chunk),
      () => this.onDataRange(begin, null),
    )
  }
}

interface Props {
  rootId: string
  relPath: string
  name: string
  /** PDF 文件 mtimeMs（缓存失效判据） */
  mtime: number
  /** 缓存索引命中（coverList + mtime 对账通过）——命中则先走 coverGet 取字节 */
  cacheHit: boolean
  /** 渲染成功后回调（书架内存缓存，避免滚动重复取） */
  onReady?: (dataUrl: string) => void
}

/**
 * 书架封面（方案 §4 coverList/coverSave/coverGet + §8 封面懒渲染管线）：
 * - 缓存命中 → coverGet 取 png 直显；
 * - 未命中 → 可视时（IntersectionObserver）才开 range transport 渲染第 1 页 →
 *   coverSave 落缓存（带 mtime 校验）→ 渲染完立即 destroy transport；
 * - 失败/无 PDF 头 → 合成封面兜底（首字 + 渐变），不阻塞网格。
 */
export function PdfCover({ rootId, relPath, name, mtime, cacheHit, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const startedRef = useRef(false)

  const render = useCallback(async () => {
    if (startedRef.current) return
    startedRef.current = true
    try {
      // 1) 缓存命中：直接取字节
      if (cacheHit) {
        const hit = await pdfReaderCoverGet(rootId, relPath)
        if (hit.ok && hit.dataUrl) {
          setDataUrl(hit.dataUrl)
          onReady?.(hit.dataUrl)
          return
        }
      }
      // 2) 未命中：懒渲染第 1 页（宽度钉在封面显示尺寸 × dpr，省内存）
      const probe = await workspaceReadRange(rootId, relPath, 0, 4096)
      if ('error' in probe && probe.error) throw new Error(probe.error)
      const head = b64ToU8(probe.data)
      const transport = new CoverRangeTransport(probe.size, head.length > 0 ? head : null, async (begin, end) => {
        const r = await workspaceReadRange(rootId, relPath, begin, Math.max(1, end - begin))
        if ('error' in r && r.error) throw new Error(r.error)
        return b64ToU8(r.data)
      })
      const task = pdfjsLib.getDocument({ range: transport, disableAutoFetch: true, rangeChunkSize: CHUNK })
      const pdf = await task.promise
      const page = await pdf.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const targetW = 240
      const scale = targetW / base.width
      const viewport = page.getViewport({ scale })
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      await page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise
      const url = canvas.toDataURL('image/png')
      void pdf.destroy()
      setDataUrl(url)
      onReady?.(url)
      // 落缓存（mtime 对账不符主进程会拒收；失败静默，下次再渲染）
      void pdfReaderCoverSave(rootId, relPath, url, mtime)
    } catch {
      setFailed(true)
    }
  }, [cacheHit, mtime, onReady, relPath, rootId])

  useEffect(() => {
    const host = hostRef.current
    if (!host || dataUrl || failed) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect()
        void render()
      }
    }, { rootMargin: '160px' })
    io.observe(host)
    return () => io.disconnect()
  }, [dataUrl, failed, render])

  const initials = name.replace(/\.pdf$/i, '').slice(0, 2)

  return (
    <div ref={hostRef} className="relative w-full overflow-hidden rounded-[10px] bg-[var(--bg-secondary)]" style={{ aspectRatio: '3 / 4.2' }}>
      {dataUrl ? (
        <img src={dataUrl} alt={name} draggable={false} className="kb-view-fade absolute inset-0 h-full w-full object-cover" />
      ) : failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-gradient-to-br from-[var(--bg-secondary)] to-[var(--bg-tertiary)]">
          <span className="text-[22px] font-semibold text-[var(--text-tertiary)]">{initials}</span>
          <span className="px-2 text-center text-[10.5px] leading-tight text-[var(--text-muted)]">{name}</span>
        </div>
      ) : null}
    </div>
  )
}
