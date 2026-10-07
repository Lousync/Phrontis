import { useState, useCallback, useRef, useEffect } from 'react'
import { FileText } from 'lucide-react'
import { getPathForFile } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'

interface ImportFile {
  title: string
  content: string
  fileType: string
}

interface ImportPdfFile {
  title: string
  base64: string
  fileName: string
}

interface Props {
  onImport: (files: ImportFile[]) => Promise<void>
  onImportPdf?: (files: ImportPdfFile[]) => Promise<void>
  /** 文件夹拖入：收到的路径来自 webUtils.getPathForFile，由调用方走应用内「导入文件夹」通道 */
  onImportFolders?: (paths: string[]) => Promise<void>
  children: React.ReactNode
  className?: string
}

const ALLOWED_EXT = ['.md', '.txt', '.json', '.cpp', '.c', '.h', '.hpp', '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.java', '.rs', '.go', '.sh', '.bat', '.xml', '.yaml', '.yml', '.sql', '.pdf', '.xmind']

function extToFileType(ext: string): string {
  return ext.replace('.', '').toLowerCase()
}

function fileNameTitle(name: string): string {
  for (const ext of ALLOWED_EXT) {
    if (name.toLowerCase().endsWith(ext)) {
      return name.slice(0, -ext.length)
    }
  }
  return name
}

function extractTitle(fileName: string, _content: string): string {
  const base = fileNameTitle(fileName.replace(/^.*[\\/]/, ''))
  return base || '导入页面'
}

function hasFiles(dt: DataTransfer | null) {
  return !!dt && dt.types.includes('Files')
}

export function ImportZone({ onImport, onImportPdf, onImportFolders, children, className }: Props) {
  const [dragging, setDragging] = useState(false)
  const [counter, setCounter] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const resetDrag = useCallback(() => { setDragging(false); setCounter(0) }, [])

  // 回调经 ref 透传给 window 级原生监听，避免每次渲染重挂监听器
  const cbRef = useRef({ onImport, onImportPdf, onImportFolders })
  cbRef.current = { onImport, onImportPdf, onImportFolders }

  /** drop 数据统一处理：文件夹 → onImportFolders（应用内「导入文件夹」通道）；文本/二进制 → 既有流程 */
  const processDrop = useCallback((dt: DataTransfer) => {
    const fileList = dt.files
    if (!fileList || fileList.length === 0) return

    const allFiles = Array.from(fileList)
    // 文件夹在 dataTransfer.files 里读不到内容（不是合法扩展名也不是二进制，此前被静默丢弃）：
    // 用 webkitGetAsEntry 识别目录，getPathForFile 取绝对路径交给 onImportFolders；
    // items 与 files 的对齐按「第 i 个 file 类条目 ↔ files[i]」计，先跳过 kind!=='file' 的条目
    const items = dt.items
    const entries: Array<FileSystemEntry | null> = []
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue
        try { entries.push(items[i].webkitGetAsEntry()) } catch { entries.push(null) }
      }
    }
    const isFolder = allFiles.map((_, i) => entries[i]?.isDirectory === true)
    const folderPaths = allFiles
      .filter((_, i) => isFolder[i])
      .map(f => { try { return getPathForFile(f) } catch { return '' } })
      .filter(p => p.length > 0)
    const plainFiles = allFiles.filter((_, i) => !isFolder[i])
    const isBinary = (name: string) => name.endsWith('.pdf') || name.endsWith('.xmind')
    const textOnly = plainFiles.filter(f => {
      const name = f.name.toLowerCase()
      return !isBinary(name) && ALLOWED_EXT.some(ext => name.endsWith(ext))
    })
    const binaryOnly = plainFiles.filter(f => isBinary(f.name.toLowerCase()))

    if (folderPaths.length > 0) {
      const onFolders = cbRef.current.onImportFolders
      if (onFolders) void onFolders(folderPaths).catch(console.error)
      else showToast({ type: 'warning', message: '这里不支持文件夹导入，请拖入文件夹里的文件' })
    }
    if (textOnly.length === 0 && binaryOnly.length === 0) return

    const promises: Promise<void>[] = []

    // Text files: read as text
    if (textOnly.length > 0) {
      const readers = textOnly.map(f => {
        return new Promise<ImportFile>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const content = reader.result as string
            const dotIdx = f.name.lastIndexOf('.')
            const ext = dotIdx >= 0 ? f.name.slice(dotIdx).toLowerCase() : ''
            resolve({
              title: extractTitle(f.name, content),
              content,
              fileType: extToFileType(ext)
            })
          }
          reader.onerror = () => reject(reader.error)
          reader.readAsText(f)
        })
      })
      promises.push(
        Promise.all(readers).then(files => cbRef.current.onImport(files))
      )
    }

    // Binary files (PDF/XMind): read as base64
    if (binaryOnly.length > 0 && cbRef.current.onImportPdf) {
      const binaryReaders = binaryOnly.map(f => {
        return new Promise<ImportPdfFile>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const bytes = new Uint8Array(reader.result as ArrayBuffer)
            // Convert to base64 in chunks to avoid call stack overflow
            let binary = ''
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            const base64 = btoa(binary)
            const dotIdx = f.name.lastIndexOf('.')
            const title = dotIdx >= 0 ? f.name.slice(0, dotIdx) : f.name
            resolve({ title, base64, fileName: f.name })
          }
          reader.onerror = () => reject(reader.error)
          reader.readAsArrayBuffer(f)
        })
      })
      promises.push(
        Promise.all(binaryReaders).then(files => cbRef.current.onImportPdf?.(files))
      )
    }

    Promise.all(promises).catch(console.error)
  }, [])

  // React 侧：zone 自身 DOM（中央区）的遮罩计数与拖放
  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Always preventDefault so browser allows drops (both internal and external)
    e.preventDefault()
    if (!hasFiles(e.dataTransfer)) return
    e.stopPropagation()
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setCounter(c => {
      const next = c + 1
      if (next === 1) setDragging(true)
      return next
    })
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    setCounter(c => {
      const next = c - 1
      if (next <= 0) setDragging(false)
      return Math.max(0, next)
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only handle file imports — internal drags are handled by child components
    if (!hasFiles(e.dataTransfer)) return
    resetDrag()
    processDrop(e.dataTransfer)
  }, [processDrop, resetDrag])

  // ===== 自愈 + portal 兜底层（window 捕获阶段） =====
  // 左栏内容 portal 到模块外宿主（knowledge index 的 sidebarInner → sidebarEl），落点在侧栏时
  // drop 不经过本组件的 DOM 与 React 树；Monaco 等子级也可能在冒泡阶段吞事件。捕获阶段在
  // window 上先于一切子级处理：① drop 一律复位遮罩（自愈，不再卡死）；② zone 之外的 drop
  // 由这里接手导入（zone 内仍走上方 React 通道，避免双跑；Monaco 图片拖放不受影响）。
  // 仅本模块可见时生效（隐藏 Tab 是 display:none，clientWidth 为 0），不劫持其他模块。
  useEffect(() => {
    const visible = () => { const el = rootRef.current; return !!el && el.clientWidth > 0 }
    const inZone = (t: EventTarget | null) => {
      const el = rootRef.current
      return !!el && t instanceof Node && el.contains(t)
    }
    const onWinDrop = (e: DragEvent) => {
      if (!visible()) return
      const files = hasFiles(e.dataTransfer)
      if (files) resetDrag()
      if (!files || inZone(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) processDrop(e.dataTransfer)
    }
    const onWinDragOver = (e: DragEvent) => {
      if (!visible() || !hasFiles(e.dataTransfer) || inZone(e.target)) return
      e.preventDefault() // 允许在 portal 侧栏等 zone 外区域释放
    }
    const onWinDragLeave = (e: DragEvent) => {
      // relatedTarget 为空 = 拖拽离开整个窗口，强制复位遮罩防卡死
      if (visible() && !e.relatedTarget) resetDrag()
    }
    const onWinDragEnd = () => { if (visible()) resetDrag() }
    window.addEventListener('drop', onWinDrop, { capture: true })
    window.addEventListener('dragover', onWinDragOver, { capture: true })
    window.addEventListener('dragleave', onWinDragLeave, { capture: true })
    window.addEventListener('dragend', onWinDragEnd, { capture: true })
    return () => {
      window.removeEventListener('drop', onWinDrop, { capture: true })
      window.removeEventListener('dragover', onWinDragOver, { capture: true })
      window.removeEventListener('dragleave', onWinDragLeave, { capture: true })
      window.removeEventListener('dragend', onWinDragEnd, { capture: true })
    }
  }, [processDrop, resetDrag])

  return (
    <div
      ref={rootRef}
      className={`relative ${className || ''}`}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}

      {/* 拖拽遮罩 */}
      {dragging && (
        <div className="absolute inset-0 z-40 bg-[#007acc20] border-2 border-dashed border-[var(--accent)] rounded flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-[var(--accent)]">
            <FileText size={48} strokeWidth={1.5} />
            <span className="text-[15px] font-medium">释放文件以导入</span>
            <span className="text-[12px] opacity-70">支持 .md .cpp .py .html .pdf 等文件，可整文件夹拖入</span>
          </div>
        </div>
      )}
    </div>
  )
}
