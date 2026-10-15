import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronsDownUp, ChevronsUpDown, FileDown, Frame, Plus, Redo2, Undo2, X } from 'lucide-react'
import { workspaceGetCurrent, workspaceReadFile, workspaceWriteFile, createKnowledgePage, getKnowledgeCategories } from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { MonacoPane } from './MonacoPane'
import {
  layoutTree, parseMindmap, countNodes, treeToMarkdown, serializeMindmap,
  assignIds, findNode, isDescendant, addChildNode, removeNode, moveNode,
  type MindMapDoc, type MindMapNode,
} from '../../lib/mindmap'
import type { KnowledgeCategory } from '../../types/index'

/**
 * 思维导图渲染 + 编辑（共享组件）—— AI 教学工件栏 + 笔记区 PageEditor 两处复用。
 * 数据源 = 会话产物 `{会话夹}/mindmaps/<slug>.json`（判别字段 `kind:"mindmap"`）。
 * **不走 kbview**（协议只放行 .html），用 workspaceReadFile 读 JSON、React 直接渲染交互树。
 *
 * 交互：
 *  - 只读：折叠 / 缩放 / 拖拽平移 / 点 ref 跳笔记 / 导出为笔记 / 查看编辑 JSON 源码
 *  - 编辑（Phase 2）：双击改文字 · 悬停 +/− 增删 · 拖拽重挂/排序（防环）· 撤销重做 · 防抖落盘
 */

const NODE_W = 176
const NODE_H = 40
const GAP_X = 64
const GAP_Y = 22
const PAD = 48

interface Props {
  relPath: string
  /** 工具条显示「导出为笔记」（AI 教学工件栏用；笔记区不显示） */
  showExport?: boolean
  /** 自带工具条「查看/编辑 JSON 源码」切换按钮（未受控时用） */
  showSource?: boolean
  /** 受控源码视图：提供时由宿主控制，组件不再自带切换按钮 */
  view?: 'map' | 'source'
  onViewChange?: (v: 'map' | 'source') => void
  /** ref 节点点击回调；缺省派发 kb-open-note（笔记区同模块打开） */
  onRef?: (rel: string) => void
}

export function MindMapView({ relPath, showExport, showSource, view, onViewChange, onRef }: Props) {
  const [doc, setDoc] = useState<MindMapDoc | null>(null)
  const [srcDraft, setSrcDraft] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [foldVersion, setFoldVersion] = useState(0)
  const [internalView, setInternalView] = useState<'map' | 'source'>('map')
  const [exportOpen, setExportOpen] = useState(false)
  const [expTitle, setExpTitle] = useState('')
  const [expCat, setExpCat] = useState('')
  const [cats, setCats] = useState<KnowledgeCategory[]>([])
  const [preview, setPreview] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [dropTarget, setDropTarget] = useState<{ id: string; mode: 'child' | 'before' | 'after' } | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty'>('saved')
  const [, setHistVersion] = useState(0)

  const activeView = view ?? internalView
  const rootIdRef = useRef<string | null>(null)
  const mtimeRef = useRef<number | undefined>(undefined)
  const docRef = useRef<MindMapDoc | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef({ x: 0, y: 0, s: 1 })
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const nodeElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  const dragRef = useRef<{ id: string; sx: number; sy: number; dragging: boolean } | null>(null)
  const undoRef = useRef<string[]>([])
  const redoRef = useRef<string[]>([])
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 用户是否手动调过视图（缩放/平移）——手动后不再自动 fit（ResizeObserver 用） */
  const userAdjRef = useRef(false)

  useEffect(() => { docRef.current = doc }, [doc])

  // ---------------- 载入 ----------------
  const load = useCallback(async () => {
    setLoadErr('')
    const cur = await workspaceGetCurrent().catch(() => null)
    const rid = (cur as { rootId?: string } | null)?.rootId ?? null
    rootIdRef.current = rid
    if (!rid) { setLoadErr('尚未打开仓库'); return }
    const r = await workspaceReadFile(rid, relPath).catch(() => null)
    if (!r || typeof r.content !== 'string') { setLoadErr('读取失败'); return }
    const d = parseMindmap(r.content)
    if (!d) { setLoadErr('不是思维导图（缺少 kind:"mindmap" 或 root）'); setDoc(null); return }
    assignIds(d.root)
    mtimeRef.current = (r as { mtimeMs?: number }).mtimeMs
    setSrcDraft(r.content)
    setDoc(d)
    setExpTitle(d.title || d.root.text)
    undoRef.current = []; redoRef.current = []
    setSaveState('saved')
  }, [relPath])

  useEffect(() => { void load() }, [load])

  const layout = useMemo(
    () => (doc ? layoutTree(doc.root, { nodeW: NODE_W, nodeH: NODE_H, gapX: GAP_X, gapY: GAP_Y, pad: PAD }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, foldVersion],
  )

  // ---------------- 保存（防抖） ----------------
  const doSave = useCallback(async () => {
    const rid = rootIdRef.current
    const d = docRef.current
    if (!rid || !d) return
    setSaveState('saving')
    const res = await workspaceWriteFile(rid, relPath, serializeMindmap(d), mtimeRef.current).catch(() => null)
    if (!res || res.ok === false) { setSaveState('dirty'); showToast({ type: 'error', message: '思维导图保存失败' }); return }
    if (typeof (res as { mtimeMs?: number }).mtimeMs === 'number') mtimeRef.current = (res as { mtimeMs?: number }).mtimeMs
    setSaveState('saved')
  }, [relPath])

  const scheduleSave = useCallback(() => {
    setSaveState('dirty')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { void doSave() }, 600)
  }, [doSave])

  useEffect(() => () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }, [])

  /** 编辑提交：入撤销栈 → 原地改 → 触发重排 + 防抖保存。 */
  const mutate = useCallback((fn: (root: MindMapNode) => boolean | void) => {
    const d = docRef.current
    if (!d) return
    const before = serializeMindmap(d)   // ★ 必须先快照（fn 是原地改）
    const ok = fn(d.root)
    if (ok === false) return
    undoRef.current.push(before)
    if (undoRef.current.length > 100) undoRef.current.shift()
    redoRef.current = []
    setHistVersion(v => v + 1)
    setFoldVersion(v => v + 1)
    scheduleSave()
  }, [scheduleSave])

  const applySnapshot = useCallback((json: string) => {
    const d = parseMindmap(json)
    if (!d) return
    assignIds(d.root)
    setDoc(d)
    setFoldVersion(v => v + 1)
    scheduleSave()
  }, [scheduleSave])

  const undo = useCallback(() => {
    const d = docRef.current
    if (!d || !undoRef.current.length) return
    redoRef.current.push(serializeMindmap(d))
    applySnapshot(undoRef.current.pop() as string)
    setHistVersion(v => v + 1)
  }, [applySnapshot])

  const redo = useCallback(() => {
    const d = docRef.current
    if (!d || !redoRef.current.length) return
    undoRef.current.push(serializeMindmap(d))
    applySnapshot(redoRef.current.pop() as string)
    setHistVersion(v => v + 1)
  }, [applySnapshot])

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z（仅导图视图可见时）
  useEffect(() => {
    if (activeView !== 'map') return
    const onKey = (e: KeyboardEvent): void => {
      const c = canvasRef.current
      if (!c || c.offsetParent === null) return
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeView, undo, redo])

  // ---------------- 缩放 / 平移 ----------------
  const applyView = useCallback(() => {
    const s = stageRef.current
    if (!s) return
    const v = viewRef.current
    s.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.s})`
  }, [])

  const fit = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !layout) return
    const { nodes, nodeW, nodeH } = layout
    if (!nodes.length) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + nodeW); maxY = Math.max(maxY, n.y + nodeH)
    }
    const cw = canvas.clientWidth, ch = canvas.clientHeight
    if (cw < 2 || ch < 2) return // 容器尚无尺寸（隐藏/过渡中）→ 跳过；ResizeObserver 会在有尺寸时再触发
    const w = (maxX - minX) + 64, h = (maxY - minY) + 64
    const s = Math.min(cw / w, ch / h, 1.15)
    viewRef.current = { s, x: (cw - w * s) / 2 - (minX - 32) * s, y: (ch - h * s) / 2 - (minY - 32) * s }
    applyView()
  }, [layout, applyView])

  // 自动 fit 的触发时机：① 载入/切换文档（doc 换引用）② map ⇄ source 切换（画布 DOM 重建，
  // 见内容区分支 key）③ 首挂。★ 绝不能依赖 fit —— fit 的引用随 layout（含 foldVersion）变化，
  // 会让折叠 / 增删 / 改字（均为原地改同一 doc 对象、只靠 foldVersion 触发重渲染）也重跑 fit，
  // 把视角拉成「适应画布」。原地改不换 doc 引用，正是我们要的「结构变、视角静默」。
  useEffect(() => {
    const id = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, activeView])

  // 容器尺寸变化（首挂时可能 0 宽/切换 Tab/窗口缩放）→ 未手动调整过就自动 fit
  useEffect(() => {
    const c = canvasRef.current
    if (!c || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (c.clientWidth > 2 && c.clientHeight > 2 && !userAdjRef.current) fit()
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [fit, activeView])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left, my = e.clientY - r.top
      const v = viewRef.current
      const ns = Math.min(2.4, Math.max(0.35, v.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      userAdjRef.current = true
      viewRef.current = { s: ns, x: mx - (mx - v.x) * (ns / v.s), y: my - (my - v.y) * (ns / v.s) }
      applyView()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [applyView, activeView])

  const zoomBy = useCallback((f: number) => {
    const c = canvasRef.current
    if (!c) return
    const v = viewRef.current
    const ns = Math.min(2.4, Math.max(0.35, v.s * f))
    userAdjRef.current = true
    viewRef.current = { s: ns, x: c.clientWidth / 2 - (c.clientWidth / 2 - v.x) * (ns / v.s), y: c.clientHeight / 2 - (c.clientHeight / 2 - v.y) * (ns / v.s) }
    applyView()
  }, [applyView])

  const onCanvasPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.closest('.mm-node') || t.closest('.mm-zoombar')) return
    userAdjRef.current = true
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y }
    canvasRef.current?.classList.add('cursor-grabbing')
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])
  const onCanvasPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = panRef.current
    if (!d) return
    viewRef.current = { ...viewRef.current, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }
    applyView()
  }, [applyView])
  const onCanvasPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return
    panRef.current = null
    canvasRef.current?.classList.remove('cursor-grabbing')
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }, [])

  // ---------------- 折叠 / 展开 ----------------
  const toggleFold = useCallback((n: MindMapNode) => { n.collapsed = !n.collapsed; setFoldVersion(v => v + 1) }, [])
  const setAll = useCallback((node: MindMapNode, collapsed: boolean) => {
    if (node.children?.length) { node.collapsed = collapsed; node.children.forEach(c => setAll(c, collapsed)) }
  }, [])
  const onNodeClick = useCallback((n: MindMapNode) => {
    if (n.children?.length) { toggleFold(n); return }
    if (n.ref) {
      if (onRef) onRef(n.ref)
      else window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: n.ref, from: 'knowledge' } }))
    }
  }, [toggleFold, onRef])

  // ---------------- 编辑：改字 / 增删 ----------------
  const beginEdit = useCallback((n: MindMapNode) => { setEditingId(n._id ?? null); setEditingText(n.text) }, [])
  const commitEdit = useCallback(() => {
    const id = editingId
    const t = editingText.trim()
    setEditingId(null)
    if (!id || !t) return
    mutate(root => { const n = findNode(root, id); if (n) n.text = t })
  }, [editingId, editingText, mutate])
  const addChild = useCallback((n: MindMapNode) => {
    let newId = ''
    mutate(root => { const node = findNode(root, n._id as string); if (!node) return false; const created = addChildNode(node); newId = created._id as string })
    if (newId) { setEditingId(newId); setEditingText('新节点') }
  }, [mutate])
  const delNode = useCallback((n: MindMapNode) => { mutate(root => removeNode(root, n._id as string)) }, [mutate])

  // ---------------- 编辑：拖拽重挂 / 排序 ----------------
  const computeDrop = useCallback((clientX: number, clientY: number, dragId: string): { id: string; mode: 'child' | 'before' | 'after' } | null => {
    const d = docRef.current
    if (!d) return null
    let best: { id: string; mode: 'child' | 'before' | 'after'; dist: number } | null = null
    nodeElsRef.current.forEach((el, id) => {
      if (id === dragId || isDescendant(d.root, dragId, id)) return
      const r = el.getBoundingClientRect()
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return
      const relY = (clientY - r.top) / r.height
      const isRoot = (id === d.root._id)
      let mode: 'child' | 'before' | 'after' = 'child'
      if (!isRoot && relY < 0.28) mode = 'before'
      else if (!isRoot && relY > 0.72) mode = 'after'
      const dist = Math.hypot(clientX - (r.left + r.width / 2), clientY - (r.top + r.height / 2))
      if (!best || dist < best.dist) best = { id, mode, dist }
    })
    return best ? { id: (best as { id: string }).id, mode: (best as { mode: 'child' | 'before' | 'after' }).mode } : null
  }, [])

  const onNodePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, n: MindMapNode) => {
    if (editingId === n._id) return
    if ((e.target as HTMLElement).closest('.mm-node-act')) return
    dragRef.current = { id: n._id as string, sx: e.clientX, sy: e.clientY, dragging: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [editingId])
  const onNodePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    if (!d.dragging && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 5) d.dragging = true
    if (d.dragging) setDropTarget(computeDrop(e.clientX, e.clientY, d.id))
  }, [computeDrop])
  const onNodePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>, n: MindMapNode) => {
    const d = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* noop */ }
    if (d?.dragging) {
      const t = dropTarget
      setDropTarget(null)
      if (t) mutate(root => moveNode(root, d.id, t.id, t.mode))
      return
    }
    setDropTarget(null)
    onNodeClick(n)
  }, [dropTarget, mutate, onNodeClick])

  // ---------------- 导出 ----------------
  const openExport = useCallback(async () => {
    setExportOpen(true); setPreview(false)
    if (!cats.length) { const c = await getKnowledgeCategories().catch(() => []); setCats(c) }
  }, [cats.length])
  const doExport = useCallback(async () => {
    if (!doc) return
    const title = expTitle.trim() || doc.title || doc.root.text
    const md = treeToMarkdown({ ...doc, title })
    const r = await createKnowledgePage({ title, contentMd: md, categoryId: expCat || null }).catch(() => null)
    if (!r) { showToast({ type: 'error', message: '导出失败' }); return }
    setExportOpen(false)
    showToast({ type: 'info', message: `已导出为知识库笔记：${title}` })
    if (r.path) window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: r.path, from: 'aiTeaching' } }))
  }, [doc, expTitle, expCat])

  const setViewSafe = useCallback((v: 'map' | 'source') => {
    if (view !== undefined) onViewChange?.(v)
    else setInternalView(v)
  }, [view, onViewChange])

  const saveSource = useCallback(async () => {
    const rid = rootIdRef.current
    if (!rid) { showToast({ type: 'error', message: '尚未打开仓库' }); return }
    if (!parseMindmap(srcDraft)) { showToast({ type: 'error', message: '不是合法思维导图 JSON（需保留 kind:"mindmap" 与 root）' }); return }
    const res = await workspaceWriteFile(rid, relPath, srcDraft, mtimeRef.current).catch(() => null)
    if (!res || res.ok === false) { showToast({ type: 'error', message: '保存失败' }); return }
    showToast({ type: 'info', message: '已保存，重新渲染' })
    await load()
    setViewSafe('map')
  }, [srcDraft, relPath, load, setViewSafe])

  const srcPreview = useMemo(() => (doc ? treeToMarkdown({ ...doc, title: expTitle.trim() || doc.title }) : ''), [doc, expTitle])
  const canUndo = undoRef.current.length > 0
  const canRedo = redoRef.current.length > 0

  return (
    <div className="h-full w-full flex flex-col min-h-0">
      {/* 工具条 */}
      <div className="shrink-0 min-h-10 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 border-b border-[var(--border-color)] text-[12px] select-none">
        <span className="min-w-0 flex-1 font-medium text-[var(--text-primary)] truncate">
          {doc?.title || '思维导图'}
          <span className="ml-1.5 text-[var(--text-muted)] font-normal">思维导图 · {doc ? countNodes(doc.root) : 0} 节点</span>
        </span>
        {activeView === 'map' && doc && saveState !== 'saved' && (
          <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">{saveState === 'saving' ? '保存中…' : '未保存'}</span>
        )}
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {activeView === 'map' && doc && (
            <>
              <button type="button" onClick={undo} disabled={!canUndo} title="撤销 (Ctrl+Z)"
                className="p-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"><Undo2 size={13} /></button>
              <button type="button" onClick={redo} disabled={!canRedo} title="重做 (Ctrl+Y)"
                className="p-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 transition-colors"><Redo2 size={13} /></button>
              <span className="w-px h-4 bg-[var(--border-color)]" />
              <button type="button" onClick={fit} title="适应画布（复位）"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <Frame size={11} /> 适应画布
              </button>
              <button type="button" onClick={() => { setAll(doc.root, false); doc.root.collapsed = false; setFoldVersion(v => v + 1) }} title="展开全部节点"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <ChevronsUpDown size={11} /> 全部展开
              </button>
              <button type="button" onClick={() => { doc.root.children?.forEach(c => setAll(c, true)); setFoldVersion(v => v + 1) }} title="折叠到一级"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                <ChevronsDownUp size={11} /> 全部折叠
              </button>
              {showExport && (
                <button type="button" onClick={() => void openExport()}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors">
                  <FileDown size={11} /> 导出为笔记
                </button>
              )}
            </>
          )}
          {showSource && view === undefined && (
            <button type="button" onClick={() => setInternalView(activeView === 'source' ? 'map' : 'source')}
              className="px-1.5 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
              {activeView === 'source' ? '← 返回导图' : '查看/编辑 JSON 源码'}
            </button>
          )}
        </div>
      </div>

      {/* 内容区 */}
      {loadErr ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-[12px] text-[var(--text-muted)]">
          <div>{loadErr}</div>
          <button type="button" onClick={() => void load()} className="text-[var(--accent)] hover:underline">重试</button>
        </div>
      ) : activeView === 'source' ? (
        <div key="mm-source" className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0">
            <MonacoPane
              doc={{ relPath, modelPath: `mindmap://${relPath}`, content: srcDraft, language: 'json', binary: false, editable: true, truncated: false, size: srcDraft.length }}
              onChange={(_rel, v) => setSrcDraft(v)}
              dimEnabled={false}
              editorOptions={{ minimap: { enabled: false }, wordWrap: 'on', lineNumbers: 'on', scrollBeyondLastLine: false }}
            />
          </div>
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-[var(--border-color)] text-[11px] text-[var(--text-muted)]">
            <span className="min-w-0 flex-1 truncate">编辑后点「保存并重新渲染」。保留 <code className="px-1 rounded bg-[var(--bg-secondary)]">kind:"mindmap"</code>，否则下次打开不再识别为导图。</span>
            <div className="shrink-0 flex items-center gap-1.5">
              <button type="button" onClick={() => setViewSafe('map')}
                className="px-2 py-0.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
              <button type="button" onClick={() => void saveSource()}
                className="px-2 py-0.5 rounded-md bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors">保存并重新渲染</button>
            </div>
          </div>
        </div>
      ) : (
        <div
          key="mm-map"
          ref={canvasRef}
          tabIndex={0}
          className="mm-canvas relative flex-1 min-h-0 overflow-hidden cursor-grab outline-none"
          style={{ background: 'radial-gradient(circle at 1px 1px, var(--border-color) 1px, transparent 0) 0 0/18px 18px' }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
        >
          <div ref={stageRef} className="absolute left-0 top-0 origin-top-left will-change-transform">
            <svg className="absolute left-0 top-0 overflow-visible pointer-events-none" width={layout?.width ?? 0} height={layout?.height ?? 0}>
              {layout?.edges.map((e, i) => {
                const x1 = e.from.x + NODE_W, y1 = e.from.y + NODE_H / 2
                const x2 = e.to.x, y2 = e.to.y + NODE_H / 2
                const dx = Math.max(24, (x2 - x1) * 0.5)
                return (
                  <path key={i} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
                    fill="none" strokeWidth={1.6}
                    stroke={e.to.node.ref ? 'var(--accent)' : 'var(--border-color)'}
                    strokeOpacity={e.to.node.ref ? 0.5 : 1} />
                )
              })}
            </svg>
            {layout?.nodes.map((ln) => {
              const n = ln.node
              const id = n._id as string
              const isRoot = ln.depth === 0
              const isDrop = dropTarget?.id === id
              const cls = isRoot
                ? 'bg-[var(--accent)]/10 border-[var(--accent)] text-[var(--accent)] font-semibold'
                : n.ref
                  ? 'bg-[var(--bg-primary)] border-dashed border-[var(--accent)] text-[var(--accent)]'
                  : 'bg-[var(--bg-primary)] border-[var(--border-color)] text-[var(--text-primary)]'
              const clickable = ln.hasChildren || !!n.ref
              const dropCls = isDrop
                ? dropTarget?.mode === 'child'
                  ? ' ring-2 ring-[var(--accent)]'
                  : dropTarget?.mode === 'before'
                    ? ' shadow-[0_-3px_0_0_var(--accent)]'
                    : ' shadow-[0_3px_0_0_var(--accent)]'
                : ''
              return (
                <div
                  key={id}
                  ref={(el) => { if (el) nodeElsRef.current.set(id, el); else nodeElsRef.current.delete(id) }}
                  data-mmid={id}
                  className={`mm-node group kb-item-in absolute flex items-center gap-[7px] px-2.5 rounded-[10px] border shadow-sm text-[12.5px] select-none transition-colors ${cls}${clickable ? ' cursor-pointer hover:border-[var(--accent)]' : ''}${dropCls}`}
                  style={{ left: ln.x, top: ln.y, width: NODE_W, height: NODE_H }}
                  onPointerDown={e => onNodePointerDown(e, n)}
                  onPointerMove={onNodePointerMove}
                  onPointerUp={e => onNodePointerUp(e, n)}
                  onDoubleClick={() => beginEdit(n)}
                >
                  {editingId === id ? (
                    <input
                      autoFocus
                      value={editingText}
                      onChange={e => setEditingText(e.target.value)}
                      onPointerDown={e => e.stopPropagation()}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitEdit() } else if (e.key === 'Escape') { e.preventDefault(); setEditingId(null) } }}
                      onBlur={commitEdit}
                      className="min-w-0 flex-1 bg-transparent outline-none text-[12.5px] text-[var(--text-primary)]"
                    />
                  ) : (
                    <>
                      <span className="flex-1 truncate">{n.text}</span>
                      {n.ref && !ln.hasChildren && <ArrowUpRight size={11} className="shrink-0 opacity-70" />}
                      {ln.hasChildren && (
                        <ChevronDown size={13} className={`kb-chevron shrink-0 ${n.collapsed ? '-rotate-90' : ''}`} />
                      )}
                    </>
                  )}
                  {/* 悬停操作：加子节点 / 删除 */}
                  {editingId !== id && (
                    <span className="mm-node-act absolute -top-2.5 right-1 hidden group-hover:flex items-center gap-0.5 z-10">
                      <button type="button" title="添加子节点"
                        onPointerDown={e => e.stopPropagation()}
                        onClick={e => { e.stopPropagation(); addChild(n) }}
                        className="w-4 h-4 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-[var(--accent-hover)]"><Plus size={10} /></button>
                      {!isRoot && (
                        <button type="button" title="删除节点"
                          onPointerDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); delNode(n) }}
                          className="w-4 h-4 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)] text-[var(--text-secondary)] flex items-center justify-center hover:bg-[var(--danger)]/15 hover:text-[var(--danger)]"><X size={10} /></button>
                      )}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* 缩放条 */}
          <div className="mm-zoombar absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-1 shadow-sm">
            <button type="button" title="缩小" onClick={() => zoomBy(1 / 1.15)}
              className="w-6 h-6 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">−</button>
            <button type="button" title="重置 100%" onClick={() => { viewRef.current = { ...viewRef.current, s: 1 }; applyView() }}
              className="w-6 h-6 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">⤾</button>
            <button type="button" title="放大" onClick={() => zoomBy(1.15)}
              className="w-6 h-6 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">+</button>
          </div>
          <div className="absolute left-3 bottom-3 text-[11px] text-[var(--text-muted)] bg-[var(--bg-primary)]/80 rounded-md px-2 py-0.5 border border-[var(--border-color)]">
            滚轮缩放 · 拖拽平移 · 单击折叠 · 双击改字 · 悬停增删 · 拖动节点重挂 · Ctrl+Z 撤销
          </div>
        </div>
      )}

      {/* 导出面板（行内，非模态） */}
      {exportOpen && (
        <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-3.5 py-3">
          <div className="text-[12.5px] font-medium mb-2.5">
            导出为知识库笔记
            <span className="ml-2 font-normal text-[11px] text-[var(--text-muted)]">将同时写入多级大纲 + Mermaid 代码块</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
              标题
              <input value={expTitle} onChange={e => setExpTitle(e.target.value)}
                className="min-w-[180px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
              分类
              <select value={expCat} onChange={e => setExpCat(e.target.value)}
                className="min-w-[180px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]">
                <option value="">（未分类）</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          <button type="button" onClick={() => setPreview(v => !v)}
            className="mt-2.5 text-[11.5px] text-[var(--accent)] hover:underline">{preview ? '预览 Markdown ▴' : '预览 Markdown ▾'}</button>
          {preview && (
            <pre className="mt-2 max-h-[180px] overflow-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">{srcPreview}</pre>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={() => setExportOpen(false)}
              className="px-2.5 py-1 rounded-md text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
            <button type="button" onClick={() => void doExport()}
              className="px-3 py-1 rounded-md bg-[var(--accent)] text-white text-[12px] hover:bg-[var(--accent-hover)] transition-colors">确认导出</button>
          </div>
        </div>
      )}
    </div>
  )
}
