import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, FileText, RotateCw, Trash2, ChevronUp, ChevronDown, Download, Merge, Save, X } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url'
import { showToast } from '../../../../lib/toast'
import { pdfMerge, pdfOrganize, pdfExport } from '../../../../lib/ipc'
import type { PdfOpResult } from '../../../../types'
import type { ToolSidebarProps } from '../../../../components/workbench/toolRegistry'

/**
 * PDF 工具箱（内置工具）：
 * - 多文件合并（按列表顺序）
 * - 单文件页面重组：缩略图勾选/删除/旋转/上移下移 → 导出新 PDF
 * - 提取文本（pdf.js 渲染层提取 → 保存 txt，供英语阅读流程使用）
 * 结构化处理走主进程 pdf-lib；预览与文本提取走渲染层 pdf.js。
 */

interface PdfFile {
  name: string
  data: Uint8Array        // 原始字节（发往主进程；注意 pdf.js 会 detach，需留副本）
  pageCount: number
}

interface PageItem {
  srcIndex: number        // 原始页码（0 基）
  rotation: number        // 累计旋转（90 倍数）
  removed: boolean
  thumb?: string          // dataURL
}

// pdf.js worker:同 PdfViewer 的 ?url 方案（v3 classic worker，兼容当前 Electron）
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export function PdfToolkit({ onBack, sidebarEl, sidebarHosted }: { onBack: () => void } & ToolSidebarProps) {
  const [files, setFiles] = useState<PdfFile[]>([])
  const [activeIdx, setActiveIdx] = useState<number>(-1)
  const [pages, setPages] = useState<PageItem[]>([])
  const [thumbsLoading, setThumbsLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [selectionOnly, setSelectionOnly] = useState(false) // 仅导出勾选页
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)
  const thumbsTokenRef = useRef(0)

  const active = files[activeIdx] ?? null

  const addFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    const next: PdfFile[] = []
    try {
      for (const f of Array.from(list)) {
        if (!/\.pdf$/i.test(f.name)) { showToast({ type: 'warning', message: `跳过非 PDF：${f.name}` }); continue }
        const buf = new Uint8Array(await f.arrayBuffer())
        try {
          // pdf.js 会 transfer 走 buffer，用副本探测页数
          const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise
          next.push({ name: f.name, data: buf, pageCount: doc.numPages })
          doc.destroy()
        } catch (err) {
          showToast({ type: 'error', message: `无法解析（可能已损坏或加密）：${f.name} · ${String((err as Error)?.message ?? err).slice(0, 80)}` })
        }
      }
    } catch (err) {
      showToast({ type: 'error', message: `PDF 引擎加载失败：${String((err as Error)?.message ?? err).slice(0, 120)}` })
      return
    }
    if (next.length === 0) return
    const combined = [...files, ...next]
    setFiles(combined)
    if (activeIdx < 0) void openFile(combined, files.length)
  }

  const openFile = async (list: PdfFile[], idx: number) => {
    const f = list[idx]
    if (!f) return
    setActiveIdx(idx)
    setPages([])
    setSelected(new Set())
    setSelectionOnly(false)
    setThumbsLoading(true)
    const token = ++thumbsTokenRef.current
    try {
      // pdf.js 会 transfer 走 buffer，用副本渲染
      const doc = await pdfjsLib.getDocument({ data: f.data.slice(0) }).promise
      const items: PageItem[] = []
      for (let i = 0; i < doc.numPages; i++) {
        if (token !== thumbsTokenRef.current) { doc.destroy(); return }
        const page = await doc.getPage(i + 1)
        const viewport = page.getViewport({ scale: 0.22 })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise
        items.push({ srcIndex: i, rotation: 0, removed: false, thumb: canvas.toDataURL('image/jpeg', 0.6) })
        setPages([...items])
        if (i === 0) setThumbsLoading(false)
      }
      doc.destroy()
    } catch (err) {
      showToast({ type: 'error', message: `预览失败：${String((err as Error)?.message ?? err).slice(0, 120)}` })
    } finally {
      if (token === thumbsTokenRef.current) setThumbsLoading(false)
    }
  }

  const ordered = useMemo(() => pages.filter(p => !p.removed), [pages])
  const exported = useMemo(
    () => (selectionOnly ? ordered.filter(p => selected.has(p.srcIndex)) : ordered),
    [ordered, selectionOnly, selected],
  )

  const mutateActive = (fn: (p: PageItem) => PageItem | null) => {
    setPages(prev => prev.map(p => {
      if (p.removed) return p
      const np = fn(p)
      return np ?? { ...p, removed: true }
    }))
  }

  const rotate = (srcIndex: number) => mutateActive(p => p.srcIndex === srcIndex ? { ...p, rotation: (p.rotation + 90) % 360 } : p)
  const remove = (srcIndex: number) => mutateActive(p => p.srcIndex === srcIndex ? { ...p, removed: true } : p)
  const restoreAll = () => setPages(prev => prev.map(p => ({ ...p, removed: false, rotation: 0 })))

  const move = (srcIndex: number, dir: -1 | 1) => {
    setPages(prev => {
      const arr = [...prev]
      const i = arr.findIndex(p => p.srcIndex === srcIndex)
      const j = i + dir
      if (i < 0 || j < 0 || j >= arr.length) return prev
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
      return arr
    })
  }

  const toggleSelect = (srcIndex: number) => {
    setSelected(prev => {
      const s = new Set(prev)
      if (s.has(srcIndex)) s.delete(srcIndex)
      else s.add(srcIndex)
      return s
    })
  }

  /** 当前视图（含旋转）导出为字节 */
  const buildOrganized = async (baseName: string) => {
    if (!active) return null
    setBusy('处理中…')
    try {
      const target = exported
      if (target.length === 0) { showToast({ type: 'warning', message: '没有可导出的页面' }); return null }
      const rotations: Record<string, number> = {}
      target.forEach(p => { if (p.rotation) rotations[String(p.srcIndex)] = p.rotation })
      const r: PdfOpResult = await pdfOrganize({
        data: active.data,
        pages: target.map(p => p.srcIndex),
        rotations,
      })
      if (!r.ok) { showToast({ type: 'error', message: r.error }); return null }
      return { data: r.data, baseName }
    } finally { setBusy('') }
  }

  const exportPdf = async () => {
    const built = await buildOrganized(active?.name.replace(/\.pdf$/i, '') ?? 'document')
    if (!built) return
    setBusy('保存中…')
    try {
      const r = await pdfExport({ data: built.data, defaultName: `${built.baseName}-已整理.pdf`, kind: 'pdf' })
      if (r.ok) showToast({ type: 'info', message: `已保存：${r.path}` })
      else if (!r.cancelled) showToast({ type: 'error', message: r.error ?? '保存失败' })
    } finally { setBusy('') }
  }

  const exportText = async () => {
    if (!active) return
    setBusy('提取文本中…')
    try {
      const doc = await pdfjsLib.getDocument({ data: active.data.slice(0) }).promise
      const want = new Set(exported.map(p => p.srcIndex))
      const parts: string[] = []
      for (let i = 0; i < doc.numPages; i++) {
        if (!want.has(i)) continue
        const page = await doc.getPage(i + 1)
        const tc = await page.getTextContent()
        // 按 transform Y 坐标聚行，尽量还原阅读顺序
        type Item = { str: string; y: number; x: number }
        const items = (tc.items as Array<{ str?: string; transform?: number[] }>)
          .filter(it => typeof it.str === 'string' && it.str && it.transform)
          .map(it => ({ str: it.str!, y: Math.round(it.transform![5]), x: it.transform![4] }))
        items.sort((a, b) => b.y - a.y || a.x - b.x)
        let line = ''
        let lastY: number | null = null
        for (const it of items) {
          if (lastY !== null && Math.abs(it.y - lastY) > 3) { parts.push(line.trim()); line = '' }
          line += (line && !line.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str
          lastY = it.y
        }
        if (line.trim()) parts.push(line.trim())
        parts.push('\n──────────\n')
      }
      doc.destroy()
      const text = parts.join('\n')
      if (!text.trim()) { showToast({ type: 'warning', message: '未提取到文本（可能是扫描件，需 OCR）' }); return }
      const r = await pdfExport({ data: new TextEncoder().encode(text), defaultName: `${active.name.replace(/\.pdf$/i, '')}-文本.txt`, kind: 'txt' })
      if (r.ok) showToast({ type: 'info', message: `已保存：${r.path}` })
      else if (!r.cancelled) showToast({ type: 'error', message: r.error ?? '保存失败' })
    } catch (err) {
      showToast({ type: 'error', message: `提取失败：${String((err as Error)?.message ?? err).slice(0, 120)}` })
    } finally { setBusy('') }
  }

  const mergeAll = async () => {
    if (files.length < 2) { showToast({ type: 'warning', message: '合并至少需要两个 PDF' }); return }
    setBusy('合并中…')
    try {
      const r = await pdfMerge(files.map(f => ({ name: f.name, data: f.data })))
      if (!r.ok) { showToast({ type: 'error', message: r.error }); return }
      const er = await pdfExport({ data: r.data, defaultName: '合并.pdf', kind: 'pdf' })
      if (er.ok) showToast({ type: 'info', message: `已保存：${er.path}` })
      else if (!er.cancelled) showToast({ type: 'error', message: er.error ?? '保存失败' })
    } finally { setBusy('') }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* 顶栏 */}
      <div className="shrink-0 flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 flex-wrap">
        <button onClick={onBack} title="返回工具箱"
          className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">PDF 工具箱</span>
        <input ref={fileInputRef} type="file" accept=".pdf" multiple className="hidden"
          onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
        <button onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors">
          <FileText size={12} /> 添加 PDF
        </button>
        {files.length >= 2 && (
          <button onClick={() => void mergeAll()} disabled={!!busy}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors">
            <Merge size={12} /> 合并全部（{files.length}）
          </button>
        )}
        {busy && <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]"><Loader2 size={12} className="animate-spin" />{busy}</span>}
        {files.length > 0 && (
          <button onClick={() => { setFiles([]); setActiveIdx(-1); setPages([]) }} title="清空列表"
            className="ml-auto p-1 rounded text-[var(--text-muted)] hover:text-red-400 transition-colors"><X size={13} /></button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 文件列表。2026-09-17 右栏优化轮：标签页语境 sidebarEl 非空时 portal 进
            工作台左栏模块态 slot（挂载点迁移，状态留在本组件）；槽未就绪渲染 null 等槽。 */}
        {(() => {
          const sidebarInner = (
            <>
          {files.length === 0 && (
            <p className="text-[11px] text-[var(--text-muted)] text-center pt-6 leading-relaxed px-2">
              添加 PDF 后点选文件进行页面整理。<br />支持多选后合并。
            </p>
          )}
          {files.map((f, i) => (
            <button key={f.name + i} onClick={() => void openFile(files, i)}
              className={`w-full text-left px-2 py-1.5 rounded-md text-[11.5px] transition-colors ${i === activeIdx
                ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}>
              <span className="block truncate">{f.name}</span>
              <span className="block text-[10px] text-[var(--text-disabled)]">{f.pageCount} 页</span>
            </button>
          ))}
            </>
          )
          return sidebarEl
            ? createPortal(<div className="h-full w-full min-h-0 overflow-y-auto py-1.5 px-1.5 space-y-0.5">{sidebarInner}</div>, sidebarEl)
            : sidebarHosted
              ? null
              : <div className="w-56 shrink-0 border-r border-[var(--border-color)] overflow-y-auto py-1.5 px-1.5 space-y-0.5">{sidebarInner}</div>
        })()}

        {/* 页面工作区 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {!active ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">
              <div className="text-center">
                <FileText size={30} className="mx-auto text-[var(--text-disabled)] mb-2" />
                添加并选中一个 PDF 开始整理
              </div>
            </div>
          ) : (
            <>
              {/* 操作条 */}
              <div className="shrink-0 px-3 py-2 border-b border-[var(--border-color)] flex items-center gap-1.5 flex-wrap text-[11px]">
                <button onClick={() => setSelectionOnly(v => !v)}
                  className={`px-2 py-1 rounded-md transition-colors ${selectionOnly
                    ? 'bg-[var(--accent)] text-white'
                    : 'border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                  仅导出勾选页
                </button>
                {selectionOnly && <span className="text-[var(--text-muted)]">已勾选 {selected.size} 页</span>}
                <span className="mx-1 text-[var(--border-color)]">|</span>
                <button onClick={restoreAll} className="px-2 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">重置全部</button>
                <div className="ml-auto flex items-center gap-1.5">
                  <button onClick={() => void exportText()} disabled={!!busy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors">
                    <Download size={12} /> 提取文本
                  </button>
                  <button onClick={() => void exportPdf()} disabled={!!busy || exported.length === 0}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90 transition-opacity">
                    <Save size={12} /> 导出（{exported.length} 页）
                  </button>
                </div>
              </div>

              {/* 缩略图网格 */}
              <div className="flex-1 min-h-0 overflow-y-auto p-3">
                {thumbsLoading && pages.length === 0 ? (
                  <div className="flex items-center justify-center pt-10 text-[var(--text-muted)]"><Loader2 size={18} className="animate-spin" /></div>
                ) : (
                  <div className="flex flex-wrap gap-2.5">
                    {ordered.map(p => {
                      const isSel = selected.has(p.srcIndex)
                      const swapped = p.rotation % 180 !== 0
                      return (
                        <div key={p.srcIndex}
                          className={`relative rounded-md border-2 transition-colors ${selectionOnly && isSel
                            ? 'border-[var(--accent)]'
                            : 'border-transparent hover:border-[var(--border-color)]'}`}>
                          <div className="relative bg-white rounded shadow overflow-hidden flex items-center justify-center"
                            style={{ width: swapped ? 151 : 110, height: swapped ? 110 : 151 }}
                            onClick={() => selectionOnly && toggleSelect(p.srcIndex)}>
                            {p.thumb
                              ? <img src={p.thumb} alt={`第 ${p.srcIndex + 1} 页`}
                                className="w-full h-full object-contain"
                                style={{ transform: `rotate(${p.rotation}deg)` }} />
                              : <div className="w-full h-full flex items-center justify-center"><Loader2 size={14} className="animate-spin text-gray-400" /></div>}
                            <span className="absolute top-0.5 left-1 text-[9px] text-gray-500">{p.srcIndex + 1}</span>
                            {selectionOnly && (
                              <span className={`absolute top-1 right-1 w-4 h-4 rounded-sm border flex items-center justify-center text-[10px] ${isSel
                                ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                                : 'bg-white/80 border-gray-400 text-transparent'}`}>✓</span>
                            )}
                          </div>
                          {/* 页内操作钮 */}
                          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 py-0.5 bg-black/45 opacity-0 hover:opacity-100 transition-opacity rounded-b-md">
                            <button onClick={() => move(p.srcIndex, -1)} title="前移" className="p-0.5 text-white/80 hover:text-white"><ChevronUp size={12} /></button>
                            <button onClick={() => remove(p.srcIndex)} title="删除此页" className="p-0.5 text-white/80 hover:text-red-400"><Trash2 size={12} /></button>
                            <button onClick={() => rotate(p.srcIndex)} title="旋转 90°" className="p-0.5 text-white/80 hover:text-white"><RotateCw size={12} /></button>
                            <button onClick={() => move(p.srcIndex, 1)} title="后移" className="p-0.5 text-white/80 hover:text-white"><ChevronDown size={12} /></button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
