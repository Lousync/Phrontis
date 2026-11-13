import { useState, useEffect, useRef, useMemo } from 'react'
import { Check, Folder, FolderOpen, BookOpen, Layers, ChevronRight, ChevronDown, ChevronUp, ArrowUp, Pencil, Trash2, Star, Download, Link2, Copy, Scissors, ClipboardPaste, FileOutput } from 'lucide-react'
import type { KnowledgeCategory, KnowledgePage } from '../../../types'
import { ConfirmDialog } from '../../../components/shared'
import { DeleteWipe } from '../../../components/shared/DeleteWipe'
import { Collapsible } from '../../../components/shared/Collapsible'
import { TreeGuideLine } from '../../../components/shared/treeGuides'
import { getSetting, setSetting } from '../../../lib/ipc'
import { useSettings } from '../../../lib/SettingsContext'
import { FileIcon } from '../../../components/shared/FileIcon'
import { getFileTypeInfo } from '../../../lib/fileTypes'
import { isEditingInput } from '../../../lib/shortcuts'
import { getGlobalActiveTab } from '../../../lib/activeTab'
import { useContextMenuPosition } from '../../../lib/useContextMenuPosition'

interface Props {
  categories: KnowledgeCategory[]
  allPages: KnowledgePage[]
  loosePages: KnowledgePage[]
  starredPages: KnowledgePage[]
  /** 删除动画状态：'animating' 播放红色吞噬，'done' 不渲染（等待 IPC 完成） */
  deletingMap?: Map<string, 'animating' | 'done'>
  selectedCategoryId: string | null
  focusChapterId: string | null
  activePageId: string | null
  onSelectCategory: (id: string | null) => void
  onSelectCategoryChapter: (notebookId: string, chapterId: string) => void
  /** 传入空间ID时：进入该空间的沉浸视图（只显示空间内内容，不显示其他空间） */
  spaceId?: string | null
  /** 空间列表模式下点击空间时触发（打开空间） */
  onSelectSpace?: (id: string) => void
  onRenameNotebook: (id: string, name: string) => void
  onDeleteNotebook: (id: string) => void
  onOpenPage: (id: string) => void
  onImport: () => void
  onImportFolder?: () => void
  onDropOnNotebook: (pageId: string, notebookId: string) => void
  onDropOnCategory: (pageId: string, categoryId: string) => void
  onDropOnLooseArea: (pageId: string) => void
  onMoveCategory: (categoryId: string, newParentId: string | null) => void
  /** 空白右键菜单：创建学习空间（2026-09-07 恢复入口；vault/DB 同通道） */
  onCreateSpace?: (name: string) => Promise<void> | void
  /** 空白右键菜单（空间视图内）：创建笔记本（2026-09-07 恢复；只能创建在学习空间内部） */
  onCreateNotebook?: (name: string) => Promise<void> | void
  onSortCategory?: (id: string, direction: 'up' | 'down') => void
  onSortPage?: (id: string, direction: 'up' | 'down') => void
  locatePageId?: string | null
  locateCategoryId?: string | null
  onCopy?: (items: { type: 'category' | 'page'; id: string }[]) => void
  onCut?: (items: { type: 'category' | 'page'; id: string }[]) => void
  onPaste?: (targetCategoryId: string | null) => void
  onExportPage?: (pageId: string) => void
  onDeletePage?: (pageId: string) => void
  onRenamePage?: (pageId: string, name: string) => void
  /** 复制路径：abs=仓库内文件绝对路径；rel=仓库相对路径 */
  onCopyPath?: (type: 'category' | 'page', id: string, mode: 'abs' | 'rel') => void
  clipboard?: { action: 'copy' | 'cut'; items: { type: 'category' | 'page'; id: string }[] } | null
  cutItemIds?: Set<string>
  /** 目录聚焦：开启后只显示当前页面所在目录链 + 同级页，其余骨架化/隐藏（样式 folderFocusStyle） */
  focusOn?: boolean
  /** 点击骨架条 = 退出聚焦并定位 */
  onExitFocus?: () => void
}

/** 目录排序权重（提到模块级：供下方 useMemo 派生索引复用，避免每次渲染新建对象） */
const TYPE_ORDER: Record<string, number> = { space: 0, notebook: 1, folder: 2 }

export function NotebookList({
  categories, allPages, loosePages, starredPages,
  selectedCategoryId, focusChapterId, activePageId,
  onSelectCategory, onSelectCategoryChapter, onRenameNotebook, onDeleteNotebook,
  onOpenPage, onImport, onImportFolder,
  onDropOnNotebook, onDropOnCategory, onDropOnLooseArea, onMoveCategory, onCreateSpace, onCreateNotebook,
  onSortCategory, onSortPage, locatePageId, locateCategoryId,
  onCopy, onCut, onPaste, onExportPage, onDeletePage, onRenamePage, onCopyPath, clipboard, cutItemIds,
  deletingMap,
  spaceId = null, onSelectSpace,
  focusOn, onExitFocus,
}: Props) {
  const isSpaceView = !!spaceId
  /** 删除动画中（animating 渲染动画 / done 直接隐藏） */
  const deletingState = (id: string) => deletingMap?.get(id)

  // -- sort --
  const sortModes: Array<{ id: string; label: string }> = [
    { id: 'custom', label: '自定义' }, { id: 'type', label: '类型' }, { id: 'name', label: '名称' },
    { id: 'created', label: '创建时间' }, { id: 'updated', label: '更新时间' },
  ]
  const [sortMode, setSortMode] = useState<string>('custom')
  // ---- 派生索引（性能 2026-09-10）----
  // 原先 renderCategory 对**每个节点**各做一次 categories.filter + allPages.filter，
  // 整棵树为 O(目录数² + 目录数×页数)。数百目录 / 上千页时，任何一次展开、选中或拖动
  // 都会触发全树重算。这里预建「父 → 子」「分类 → 页」两张 Map，查询降为 O(1)。
  const childrenByParent = useMemo(() => {
    const m = new Map<string, KnowledgeCategory[]>()
    for (const c of categories) {
      const k = c.parentId || ''
      const arr = m.get(k)
      if (arr) arr.push(c); else m.set(k, [c])
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        if (sortMode === 'type') { const ta = TYPE_ORDER[a.categoryType] ?? 2; const tb = TYPE_ORDER[b.categoryType] ?? 2; if (ta !== tb) return ta - tb; return a.sortOrder - b.sortOrder }
        if (sortMode === 'name') return a.name.localeCompare(b.name)
        if (sortMode === 'created') return b.createdAt.localeCompare(a.createdAt)
        if (sortMode === 'updated') return b.updatedAt.localeCompare(a.updatedAt)
        return a.sortOrder - b.sortOrder
      })
    }
    return m
  }, [categories, sortMode])

  const pagesByCategory = useMemo(() => {
    const m = new Map<string, KnowledgePage[]>()
    for (const p of allPages) {
      const k = p.categoryId
      if (!k) continue
      const arr = m.get(k)
      if (arr) arr.push(p); else m.set(k, [p])
    }
    return m
  }, [allPages])

  // 空间沉浸视图下 root = 空间内的子项；空间列表视图下 root = 所有空间（done 的删除条目不渲染）
  const rootCats = isSpaceView
    ? (childrenByParent.get(spaceId || '') ?? [])
    : (childrenByParent.get('') ?? [])

  // ---- 目录聚焦（2026-09-12）：只保留「当前页面的祖先目录链 + 同级页」实名，其余骨架化/隐藏 ----
  const { s: focusSettings } = useSettings()
  const focusHide = (focusSettings.folderFocusStyle ?? 'skeleton') === 'hidden'
  const focusActive = !!focusOn && !!activePageId
  const activePageCatId = focusActive ? allPages.find(p => p.id === activePageId)?.categoryId ?? null : null
  const chainCatIds = useMemo(() => {
    const set = new Set<string>()
    if (!focusActive || !activePageCatId) return set
    const seen = new Set<string>()
    let currentId: string | null = activePageCatId
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId); set.add(currentId)
      currentId = categories.find(c => c.id === currentId)?.parentId ?? null
    }
    return set
  }, [focusActive, activePageCatId, categories])
  const skelWidth = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return 42 + (h % 48) }
  const pageKeep = (p: KnowledgePage) => !focusActive || p.categoryId === activePageCatId
  /** 骨架条：占位 + 悬停显原名；点击 = 退出聚焦并定位 */
  const skelRow = (key: string, name: string, depth: number, icon: React.ReactNode, onClick: () => void) => (
    <div key={key} onClick={onClick} data-tip={`${name}（点击退出聚焦并定位）`} aria-label={`${name}（点击退出聚焦并定位）`}
      className="group flex items-center gap-1 py-[3px] rounded-md cursor-pointer select-none hover:bg-[var(--bg-hover)]"
      style={{ paddingLeft: `${depth * 12 + 6}px`, paddingRight: '4px' }}>
      <span className="w-[12px] shrink-0" />
      <span className="opacity-25 shrink-0 inline-flex">{icon}</span>
      <span className="h-[10px] rounded-[5px] bg-[var(--bg-tertiary)] shrink-0 group-hover:hidden" style={{ width: skelWidth(key) }} />
      <span className="hidden group-hover:block truncate text-[12.5px] text-[var(--text-muted)]">{name}</span>
    </div>
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  /** 行内新建学习空间命名（空白菜单入口 → 树末尾输入行，Enter/失焦提交） */
  const [creatingSpace, setCreatingSpace] = useState(false)
  const [createSpaceName, setCreateSpaceName] = useState('')
  /** 行内新建笔记本命名（空间视图空白菜单入口） */
  const [creatingNotebook, setCreatingNotebook] = useState(false)
  const [createNotebookName, setCreateNotebookName] = useState('')
  const [editingPageId, setEditingPageId] = useState<string | null>(null)
  const [editPageName, setEditPageName] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [starredOpen, setStarredOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ type: 'category' | 'page' | 'blank'; id: string; x: number; y: number } | null>(null)
  const { menuRef: contextMenuRef, style: contextMenuStyle } = useContextMenuPosition(contextMenu)
  const [dragOverId, setDragOverId] = useState<string | null>(null)  // visual feedback during drag

  // Drag ref: store drag data so dragOver can read it without relying on getData()
  // (Chromium security may block getData() during dragover events)
  const dragRef = useRef<{ type: 'category' | 'page'; id: string } | null>(null)

  // Direct DOM refs to avoid React re-renders during drag (which can kill the operation)
  const treeRef = useRef<HTMLDivElement>(null)
  const dragOverTargetRef = useRef<string | null>(null)  // current drag-over target (id-based)
  const prevHighlightRef = useRef<Element | null>(null)  // previously highlighted element

  // Inject drag highlight CSS (DOM-based, avoids React re-render during drag)
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `
      .drag-over-highlight {
        background-color: rgba(0,122,204,0.15) !important;
        border-radius: 4px !important;
      }
      .drag-over-loose {
        background-color: rgba(0,122,204,0.10) !important;
        outline: 2px dashed var(--accent) !important;
        outline-offset: -2px !important;
        border-radius: 4px !important;
      }
      /* 空白区=根级可放置（对齐编辑区 FileTree 根容器反馈） */
      .drag-over-root {
        background-color: rgba(0,122,204,0.10) !important;
      }
    `
    document.head.appendChild(style)
    return () => { document.head.removeChild(style) }
  }, [])

  // Load skip-delete setting
  useEffect(() => {
    getSetting('skipDeleteConfirm_knowledgeCategory').then(v => {
      if (v === true) setSkipDeleteConfirm(true)
    })
  }, [])

  // Context menu dismiss (Escape only — backdrop onClick handles outside clicks)
  useEffect(() => {
    if (!contextMenu) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('keydown', onEsc) }
  }, [contextMenu])

  // Auto-expand ancestors and scroll when locatePageId changes
  useEffect(() => {
    if (!locatePageId) return
    const page = allPages.find(p => p.id === locatePageId)
    if (!page?.categoryId) return
    const ancestors: string[] = []
    let currentId: string | null = page.categoryId
    const seen = new Set<string>()
    while (currentId) {
      if (seen.has(currentId)) break; seen.add(currentId)
      ancestors.push(currentId)
      const cat = categories.find(c => c.id === currentId)
      currentId = cat?.parentId ?? null
    }
    if (ancestors.length === 0) return
    setExpanded(prev => { const next = new Set(prev); ancestors.forEach(id => next.add(id)); return next })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-page-id="${locatePageId}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    })
  }, [locatePageId])

  // Auto-expand ancestors and scroll to locateCategoryId
  useEffect(() => {
    if (!locateCategoryId) return
    const cat = categories.find(c => c.id === locateCategoryId)
    if (!cat) return
    // Collect ancestors
    const ancestors: string[] = []
    let currentId: string | null = cat.parentId
    const seen = new Set<string>()
    while (currentId) {
      if (seen.has(currentId)) break; seen.add(currentId)
      ancestors.push(currentId)
      const parent = categories.find(c => c.id === currentId)
      currentId = parent?.parentId ?? null
    }
    if (ancestors.length === 0) {
      // Root-level category — just scroll to it
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-cat-id="${locateCategoryId}"]`)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        })
      })
      return
    }
    setExpanded(prev => { const next = new Set(prev); ancestors.forEach(id => next.add(id)); return next })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-cat-id="${locateCategoryId}"]`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    })
  }, [locateCategoryId])

  // F2 — keyboard rename selected notebook / folder
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'knowledge') return
      if (isEditingInput(e)) return
      if (e.key === 'F2') {
        e.preventDefault()
        if (activePageId) {
          const pg = allPages.find(p => p.id === activePageId)
          handleStartRenamePage(activePageId, pg?.title || '')
        } else if (selectedCategoryId) {
          const cat = categories.find(c => c.id === selectedCategoryId)
          if (cat) handleStartRename(cat.id, cat.name)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedCategoryId, categories, activePageId, allPages])

  function toggleExpand(id: string) {
    setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  function handleStartRename(id: string, name: string) { setEditingId(id); setEditName(name) }
  function handleRename(id: string) {
    if (!editName.trim()) { setEditingId(null); return }
    onRenameNotebook(id, editName.trim()); setEditingId(null)
  }

  /** 提交行内新建学习空间（空名=放弃） */
  function handleCreateSpaceCommit() {
    const name = createSpaceName.trim()
    setCreatingSpace(false)
    if (!name || !onCreateSpace) return
    void onCreateSpace(name)
  }

  /** 提交行内新建笔记本（空名=放弃） */
  function handleCreateNotebookCommit() {
    const name = createNotebookName.trim()
    setCreatingNotebook(false)
    if (!name || !onCreateNotebook) return
    void onCreateNotebook(name)
  }

  function handleStartRenamePage(id: string, name: string) { setEditingPageId(id); setEditPageName(name) }
  function handleRenamePage(id: string) {
    if (!editPageName.trim()) { setEditingPageId(null); return }
    onRenamePage?.(id, editPageName.trim()); setEditingPageId(null)
  }

  // ---- cycle prevention for category moves ----
  function isDescendant(ancestorId: string, nodeId: string): boolean {
    const visited = new Set<string>()
    let currentId: string | null = nodeId
    while (currentId) {
      if (visited.has(currentId)) break
      visited.add(currentId)
      if (currentId === ancestorId) return true
      const cat = categories.find(c => c.id === currentId)
      currentId = cat?.parentId ?? null
    }
    return false
  }

  // ---- whether a category can accept dropped categories ----
  // Folders accept any category. Notebooks accept folders/chapters but not other notebooks.
  // Chapters (folders under notebooks) do NOT accept category drops — categories can only
  // drop into notebooks directly, which auto-creates or uses existing chapters.
  function canAcceptCategory(targetId: string, draggedId: string): boolean {
    const target = categories.find(c => c.id === targetId)
    const dragged = categories.find(c => c.id === draggedId)
    if (!target || !dragged) return false
    if (dragged.categoryType === 'space') return false
    if (target.categoryType === 'space') {
      return true  // dragged is guaranteed not a space here
    }
    // Reject: chapters (folders under notebooks) cannot accept category drops
    if (target.categoryType === 'folder') {
      const parent = categories.find(c => c.id === target.parentId)
      if (parent?.categoryType === 'notebook') return false  // this is a chapter
      return true  // standalone folder
    }
    if (target.categoryType === 'notebook') {
      if (dragged.categoryType !== 'folder') return false
      return !categories.some(c => c.parentId === draggedId)
    }
    return false
  }

  function canAcceptPage(targetId: string): boolean {
    const target = categories.find(c => c.id === targetId)
    // Pages can live directly under a space (散页), folder/chapter, or via
    // auto-created default chapter when dropped on a notebook.
    return !!target
  }

  // ---- parse drop data (same format as ActivityBar) ----
  function parseDrop(e: React.DragEvent): { type: 'category' | 'page'; id: string } | null {
    const raw = e.dataTransfer.getData('text/plain')
    if (!raw) return null
    try { const v = JSON.parse(raw); if ((v.type === 'category' || v.type === 'page') && typeof v.id === 'string') return v } catch {}
    return null
  }

  // ---- DOM-based drag highlight (avoids React re-render during drag) ----
  function clearDragHighlight() {
    if (prevHighlightRef.current) {
      prevHighlightRef.current.classList.remove('drag-over-highlight', 'drag-over-loose')
      prevHighlightRef.current = null
    }
    dragOverTargetRef.current = null
    treeRef.current?.classList.remove('drag-over-root')
  }

  function applyDragHighlight(el: Element) {
    if (prevHighlightRef.current === el) return  // already highlighted
    clearDragHighlight()
    el.classList.add('drag-over-highlight')
    prevHighlightRef.current = el
    dragOverTargetRef.current = (el as HTMLElement).dataset.catId || (el as HTMLElement).dataset.pageId || null
  }

  // ---- render a tree node (recursive) ----
  function renderCategory(cat: KnowledgeCategory, depth: number, notebookAncestorId: string | null = null) {
    const isExpanded = expanded.has(cat.id) || (focusActive && chainCatIds.has(cat.id))
    const isSelected = selectedCategoryId === cat.id || focusChapterId === cat.id
    const children = childrenByParent.get(cat.id) ?? []
    const hasChildren = children.length > 0
    const categoryPages = pagesByCategory.get(cat.id) ?? []
    const hasPages = categoryPages.length > 0
    const isNotebook = cat.categoryType === 'notebook'
    const isSpace = cat.categoryType === 'space'
    // Show expand arrow for folders that have sub-categories OR pages directly
    // Chapters under notebooks never expand — they toggle the sidebar instead
    // Spaces never expand inline — clicking opens the space immersive view
    const canExpand = isSpace ? false : notebookAncestorId ? false : (isNotebook ? hasChildren : (hasChildren || hasPages))
    // Pass notebook ancestor to children
    const nbId = isNotebook ? cat.id : notebookAncestorId

    // 目录聚焦：链外分类骨架化/隐藏；链上分类已在 isExpanded 强制展开
    if (focusActive && !chainCatIds.has(cat.id)) {
      if (focusHide) return null
      const icon = isSpace ? <Layers size={14} className="text-[var(--info)]" />
        : isNotebook ? <BookOpen size={14} className="text-[var(--text-muted)]" />
        : <Folder size={14} className="text-[var(--text-muted)]" />
      return skelRow(cat.id, cat.name, depth, icon, () => {
        onExitFocus?.()
        if (cat.categoryType === 'space') onSelectSpace?.(cat.id)
        else setExpanded(prev => new Set(prev).add(cat.id))
      })
    }

    // Row click: space opens immersive view; notebook opens chapter sidebar,
    // chapter under notebook opens focus view, folder toggles expand
    const handleRowClick = () => {
      if (isSpace) {
        onSelectSpace?.(cat.id)
      } else if (isNotebook) {
        onSelectCategory(cat.id)
      } else if (notebookAncestorId) {
        onSelectCategoryChapter(notebookAncestorId, cat.id)
      } else {
        // Standalone folder — toggle expand/collapse, like clicking the chevron
        if (canExpand) toggleExpand(cat.id)
      }
    }

    // Chevron click: always toggle expand (never select)
    const handleChevronClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      if (canExpand) toggleExpand(cat.id)
    }

    return (
      <div key={cat.id} data-cat-id={cat.id}>
        <div
          data-cat-id={cat.id}
          draggable={!isSpace}
          onDragStart={e => {
            if (isSpace) {
              e.preventDefault()
              return
            }
            console.log('[NB dragStart] category:', cat.name, cat.id)
            e.dataTransfer.effectAllowed = 'move'
            const payload = JSON.stringify({ type: 'category', id: cat.id })
            e.dataTransfer.setData('text/plain', payload)
            // 专用类型：空间头部（SpacePanel）等 NotebookList 外的 drop 区识别目录拖拽用
            e.dataTransfer.setData('application/x-kb-category', cat.id)
            dragRef.current = { type: 'category', id: cat.id }
            console.log('[NB dragStart] dragRef set:', dragRef.current)
            ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
          }}
          onDragEnd={e => {
            console.log('[NB dragEnd] category:', cat.name, cat.id)
            ;(e.currentTarget as HTMLElement).style.opacity = '1'
            dragRef.current = null
            clearDragHighlight()
          }}
          onContextMenu={e => {
            e.preventDefault(); e.stopPropagation()
            setContextMenu({ type: 'category', id: cat.id, x: e.clientX, y: e.clientY })
          }}
        >
          {editingId === cat.id ? (
            <input
              className="w-full bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={() => handleRename(cat.id)}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(cat.id); if (e.key === 'Escape') setEditingId(null) }}
              autoFocus
            />
          ) : (
            <div
              onClick={handleRowClick}
              className={`flex items-center gap-1 py-[3px] cursor-pointer group rounded-md transition-colors ${
                deletingState(cat.id) === 'animating' ? 'kb-deleting'
                  : deletingState(cat.id) === 'done' ? 'kb-deleting kb-done'
                : isSelected ? 'bg-[var(--bg-selected)]/40'
                : dragOverId === cat.id ? 'bg-[var(--accent)]/10 outline outline-2 outline-[var(--accent)] outline-offset-[-2px]'
                : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
              }${focusActive && cat.id === activePageCatId ? ' ring-1 ring-inset ring-[var(--accent)]/40' : ''}`}
              style={{
                paddingLeft: `${depth * 12 + 6}px`, paddingRight: '4px',
                ...(cutItemIds?.has(cat.id) ? { opacity: 0.45 } : {})
              }}
            >
              <span
                className={`shrink-0 w-[12px] flex items-center justify-center ${canExpand ? 'cursor-pointer hover:text-[var(--text-primary)]' : ''}`}
                onClick={handleChevronClick}
              >
                {canExpand ? (
                  <ChevronRight
                    size={12}
                    className={`kb-chevron text-[var(--text-muted)] ${isExpanded ? 'rotate-90' : ''}`}
                  />
                ) : (
                  <span className="w-[12px]" />
                )}
              </span>
              {isSpace ? (
                <Layers size={14} className={`shrink-0 ${isSelected ? 'text-[var(--accent)]' : 'text-[var(--info)]'}`} />
              ) : isNotebook ? (
                <BookOpen size={14} className={`shrink-0 ${isSelected ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`} />
              ) : canExpand ? (
                isExpanded ? <FolderOpen size={14} className="shrink-0 text-[var(--text-muted)]" /> : <Folder size={14} className="shrink-0 text-[var(--text-muted)]" />
              ) : (
                <Folder size={14} className="shrink-0 text-[var(--text-muted)]" />
              )}
              <span className="flex-1 truncate text-[12.5px] text-[var(--text-primary)]">{cat.name}</span>
              <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                {onSortCategory && (<><button onClick={e => { e.stopPropagation(); onSortCategory(cat.id, 'up') }} className="p-0.5 hover:text-[var(--accent)] text-[var(--text-muted)]" data-tip="上移" aria-label="上移"><ChevronUp size={13} /></button><button onClick={e => { e.stopPropagation(); onSortCategory(cat.id, 'down') }} className="p-0.5 hover:text-[var(--accent)] text-[var(--text-muted)]" data-tip="下移" aria-label="下移"><ChevronDown size={13} /></button></>)}
                <button onClick={e => { e.stopPropagation(); handleStartRename(cat.id, cat.name) }} className="p-0.5 hover:text-white text-[var(--text-secondary)]" data-tip="重命名" aria-label="重命名"><Pencil size={13} /></button>
                <button onClick={e => { e.stopPropagation(); if (skipDeleteConfirm) onDeleteNotebook(cat.id); else setDeleteTarget({ id: cat.id, name: cat.name }) }} className="p-0.5 hover:text-[var(--danger)] text-[var(--text-secondary)]" data-tip="删除" aria-label="删除"><Trash2 size={13} /></button>
              </div>
              {deletingState(cat.id) === 'animating' && <DeleteWipe />}
            </div>
          )}
        </div>
        {/* 展开/收起：<Collapsible> 用函数子节点 —— 收起状态不挂载子树（保持原有的懒渲染语义），
            展开/收起两个方向都有高度过渡；见 docs/ui-animation-plan.md C 类。
            子级块加 relative 包裹 + 贯穿竖线（TreeGuideLine）：线从本分类行下方直通末子级，
            避免每行画线段被行圆角裁出竹节起伏。 */}
        {canExpand && (
          <Collapsible open={isExpanded} innerClassName="">
            {() => (
              <div className="relative">
                <TreeGuideLine level={depth} />
                {/* Pages directly under this category */}
                {categoryPages.map(p => {
                  if (!pageKeep(p)) {
                    if (focusHide) return null
                    return skelRow(p.id, p.title || '无标题', depth + 1, <FileIcon ext={p.fileType || ''} size={14} />, () => { onExitFocus?.(); onOpenPage(p.id) })
                  }
                  return (
              <div key={p.id}
                data-page-id={p.id}
                draggable
                onDragStart={e => {
                  console.log('[NB page dragStart] page:', p.title, p.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'page', id: p.id }))
                  e.dataTransfer.setData('application/x-kb-page', p.id)
                  dragRef.current = { type: 'page', id: p.id }
                  ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
                }}
                onDragEnd={e => {
                  ;(e.currentTarget as HTMLElement).style.opacity = '1'
                  dragRef.current = null
                  clearDragHighlight()
                }}
                onClick={() => onOpenPage(p.id)}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation()
                  setContextMenu({ type: 'page', id: p.id, x: e.clientX, y: e.clientY })
                }}
                className={`flex items-center gap-1 py-[3px] cursor-pointer group rounded-md transition-colors ${
                  deletingState(p.id) === 'animating' ? 'kb-deleting'
                  : deletingState(p.id) === 'done' ? 'kb-deleting kb-done'
                  : activePageId === p.id ? 'bg-[var(--bg-selected)]/40 text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
                style={{
                  paddingLeft: `${(depth + 1) * 12 + 6}px`, paddingRight: '4px',
                  ...(cutItemIds?.has(p.id) ? { opacity: 0.45 } : {})
                }}
              >
                <span className="w-[12px] shrink-0" />
                <FileIcon ext={p.fileType || ''} size={14} />
                {editingPageId === p.id ? (
                  <input
                    className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
                    value={editPageName}
                    onChange={e => setEditPageName(e.target.value)}
                    onBlur={() => handleRenamePage(p.id)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRenamePage(p.id); if (e.key === 'Escape') setEditingPageId(null) }}
                    onClick={e => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className={`flex-1 truncate text-[12.5px] ${activePageId === p.id ? 'text-[var(--text-primary)]' : ''}`}>{p.title || '无标题'}</span>
                )}
                {onSortPage && <div className="hidden group-hover:flex items-center gap-0.5 shrink-0"><button onClick={e => { e.stopPropagation(); onSortPage(p.id, 'up') }} className="p-0.5 hover:text-[var(--accent)] text-[var(--text-muted)]" data-tip="上移" aria-label="上移"><ChevronUp size={11} /></button><button onClick={e => { e.stopPropagation(); onSortPage(p.id, 'down') }} className="p-0.5 hover:text-[var(--accent)] text-[var(--text-muted)]" data-tip="下移" aria-label="下移"><ChevronDown size={11} /></button></div>}
                {(() => { const fi = getFileTypeInfo(p.fileType || ''); return <span className="hidden group-hover:inline-block shrink-0 text-[8px] px-1 rounded font-medium ml-1" style={{ backgroundColor: fi.color + '20', color: fi.color }}>{fi.badge}</span> })()}
                {p.isStarred && <Star size={11} className="shrink-0 text-[var(--warning)]" fill="currentColor" />}
                {deletingState(p.id) === 'animating' && <DeleteWipe />}
              </div>
            )
            })}
            {/* Sub-categories */}
            {children.map(ch => renderCategory(ch, depth + 1, nbId))}
              </div>
            )}
          </Collapsible>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto select-none">
      {/* ===== Tree ===== */}
      <div
        ref={treeRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        onContextMenu={e => {
          const target = e.target as HTMLElement
          // Rows have their own context menu with stopPropagation — we only get here for blank space
          // Walk up to find the nearest ancestor category for context
          let contextCatId: string | null = null
          const treeEl = treeRef.current
          if (treeEl) {
            let el: HTMLElement | null = target
            while (el && el !== treeEl) {
              const catEl = el.closest('[data-cat-id]') as HTMLElement | null
              if (catEl) { contextCatId = catEl.dataset.catId!; break }
              el = el.parentElement
            }
          }
          e.preventDefault()
          setContextMenu({ type: 'blank', id: contextCatId || '', x: e.clientX, y: e.clientY })
        }}
        onDragOver={e => {
          const d = dragRef.current
          if (!d) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'

          const targetCat = (e.target as HTMLElement).closest('[data-cat-id]') as HTMLElement | null
          const targetPage = (e.target as HTMLElement).closest('[data-page-id]') as HTMLElement | null

          // Use direct DOM manipulation for highlight — NO React state update during drag
          if (targetCat) {
            const catId = targetCat.dataset.catId!
            if (d.type === 'category') {
              const valid = d.id !== catId && !isDescendant(d.id, catId) && canAcceptCategory(catId, d.id)
              if (valid) {
                applyDragHighlight(targetCat)
              } else {
                clearDragHighlight()
              }
            } else {
              if (canAcceptPage(catId)) {
                applyDragHighlight(targetCat)
              } else {
                clearDragHighlight()
              }
            }
          } else if (targetPage && d.type === 'page') {
            applyDragHighlight(targetPage)
          } else if (!targetCat && d.type === 'page') {
            // highlight the loose pages container
            const looseEl = treeRef.current?.querySelector('[data-loose-area]') as HTMLElement | null
            if (looseEl) { clearDragHighlight(); looseEl.classList.add('drag-over-loose'); prevHighlightRef.current = looseEl; dragOverTargetRef.current = '__loose' }
          } else {
            // 空白区 = 根级可放置（对齐编辑区 FileTree 根容器反馈）：目录/页面拖出目录时给出明确落点指示
            clearDragHighlight()
            if (d.type === 'category' || d.type === 'page') {
              treeRef.current?.classList.add('drag-over-root')
            }
          }
        }}
        onDragLeave={e => {
          // Only clear when leaving the tree container entirely
          if (!treeRef.current?.contains(e.relatedTarget as Node)) {
            clearDragHighlight()
            treeRef.current?.classList.remove('drag-over-root')
          }
        }}
        onDrop={e => {
          e.preventDefault()
          const dragged = dragRef.current
          const targetId = dragOverTargetRef.current
          dragRef.current = null
          clearDragHighlight()
          treeRef.current?.classList.remove('drag-over-root')

          const d = dragged || parseDrop(e)
          if (!d) return

          if (targetId && targetId !== '__loose') {
            // Determine if targetId is a category or page
            const targetCat = categories.find(c => c.id === targetId)
            if (targetCat) {
              if (d.type === 'category' && d.id !== targetId && !isDescendant(d.id, targetId) && canAcceptCategory(targetId, d.id)) {
                const curParent = categories.find(c => c.id === d.id)?.parentId ?? null
                if (targetId !== curParent) { // 已在该目录下：跳过重复移动（同路径 move 会报目标已存在）
                  console.log('[NB drop] → onMoveCategory:', d.id, '→', targetId)
                  setExpanded(prev => new Set(prev).add(targetId))
                  onMoveCategory(d.id, targetId)
                }
              } else if (d.type === 'page' && canAcceptPage(targetId)) {
                const c = categories.find(x => x.id === targetId)
                setExpanded(prev => new Set(prev).add(targetId))
                if (c?.categoryType === 'notebook') onDropOnNotebook(d.id, targetId)
                else onDropOnCategory(d.id, targetId)
              }
              return
            }
            // If targetId is a page, handle page-to-page reorder (within NotebookList)
            if (d.type === 'page' && targetId !== d.id) {
              // page-to-page — handled below if needed, or just ignore (reorder happens in ChapterPanel)
              return
            }
          }

          // Empty space / loose area
          if (targetId === '__loose' || !targetId) {
            const looseEl = treeRef.current?.querySelector('[data-loose-area]') as HTMLElement | null
            if (looseEl) looseEl.classList.remove('drag-over-loose')
            if (d.type === 'page') {
              // 空间沉浸视图下空白处拖入 = 放入该空间；否则为全局零散
              if (isSpaceView && spaceId) onDropOnCategory(d.id, spaceId)
              else onDropOnLooseArea(d.id)
            } else if (d.type === 'category') {
              // 2026-09-07 借鉴编辑区 FileTree 的容器兜底：目录拖到树空白/零散区 = 移到根级。
              // 此前空白 drop 只认页面，目录拖进别的目录后无法拖出（「拖出来」问题的根因）。
              const curParent = categories.find(c => c.id === d.id)?.parentId ?? null
              if (curParent !== null) onMoveCategory(d.id, null)
            }
          } else if (d.type === 'page') {
            onDropOnLooseArea(d.id)
          }
        }}
      >
        {rootCats.map(cat => renderCategory(cat, 0))}

        {/* 行内新建学习空间命名行（空白菜单「创建学习空间」触发） */}
        {creatingSpace && (
          <div className="flex items-center gap-1 py-[3px] rounded-md" style={{ paddingLeft: '6px', paddingRight: '4px' }}>
            <span className="shrink-0 w-[12px]" />
            <Layers size={14} className="shrink-0 text-[var(--info)]" />
            <input
              className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
              value={createSpaceName}
              placeholder="空间名称"
              onChange={e => setCreateSpaceName(e.target.value)}
              onBlur={handleCreateSpaceCommit}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); handleCreateSpaceCommit() }
                if (e.key === 'Escape') setCreatingSpace(false)
              }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          </div>
        )}

        {/* 行内新建笔记本命名行（空间视图空白菜单「创建笔记本」触发） */}
        {creatingNotebook && (
          <div className="flex items-center gap-1 py-[3px] rounded-md" style={{ paddingLeft: '6px', paddingRight: '4px' }}>
            <span className="shrink-0 w-[12px]" />
            <BookOpen size={14} className="shrink-0 text-[var(--text-muted)]" />
            <input
              className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
              value={createNotebookName}
              placeholder="笔记本名称"
              onChange={e => setCreateNotebookName(e.target.value)}
              onBlur={handleCreateNotebookCommit}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); handleCreateNotebookCommit() }
                if (e.key === 'Escape') setCreatingNotebook(false)
              }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          </div>
        )}

        {/* Space view: the space's direct pages (loose within the space) */}
        {isSpaceView && spaceId && (() => {
          const spacePages = pagesByCategory.get(spaceId) ?? []
          if (spacePages.length === 0) return null
          return (
            <div
              data-loose-area="true"
              className="mx-1 rounded transition-colors"
            >
              {spacePages.map(p => {
                if (!pageKeep(p)) {
                  if (focusHide) return null
                  return skelRow(p.id, p.title || '无标题', 1, <FileIcon ext={p.fileType || ''} size={14} />, () => { onExitFocus?.(); onOpenPage(p.id) })
                }
                return (
                <div key={p.id}
                  data-page-id={p.id}
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'page', id: p.id }))
                  e.dataTransfer.setData('application/x-kb-page', p.id)
                    dragRef.current = { type: 'page', id: p.id }
                    ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
                  }}
                  onDragEnd={e => { ;(e.currentTarget as HTMLElement).style.opacity = '1'; dragRef.current = null }}
                  onClick={() => onOpenPage(p.id)}
                  onContextMenu={e => {
                    e.preventDefault(); e.stopPropagation()
                    setContextMenu({ type: 'page', id: p.id, x: e.clientX, y: e.clientY })
                  }}
                  className={`flex items-center gap-1 py-[3px] cursor-pointer group rounded-md transition-colors ${
                    deletingState(p.id) === 'animating' ? 'kb-deleting'
                  : deletingState(p.id) === 'done' ? 'kb-deleting kb-done'
                    : activePageId === p.id ? 'bg-[var(--bg-selected)]/40 text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                  style={{
                    paddingLeft: '18px', paddingRight: '4px',
                    ...(cutItemIds?.has(p.id) ? { opacity: 0.45 } : {})
                  }}
                >
                  <span className="w-[12px] shrink-0" />
                  <FileIcon ext={p.fileType || ''} size={14} />
                  {editingPageId === p.id ? (
                    <input
                      className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
                      value={editPageName}
                      onChange={e => setEditPageName(e.target.value)}
                      onBlur={() => handleRenamePage(p.id)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenamePage(p.id); if (e.key === 'Escape') setEditingPageId(null) }}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className={`flex-1 truncate text-[12.5px] ${activePageId === p.id ? 'text-[var(--text-primary)]' : ''}`}>{p.title || '无标题'}</span>
                  )}
                  {(() => { const fi = getFileTypeInfo(p.fileType || ''); return <span className="hidden group-hover:inline-block shrink-0 text-[8px] px-1 rounded font-medium ml-1" style={{ backgroundColor: fi.color + '20', color: fi.color }}>{fi.badge}</span> })()}
                  {p.isStarred && <Star size={11} className="shrink-0 text-[var(--warning)]" fill="currentColor" />}
                  {deletingState(p.id) === 'animating' && <DeleteWipe />}
                </div>
              )
              })}
            </div>
          )
        })()}

        {/* Root-level loose pages */}
        {!isSpaceView && loosePages.length > 0 && (
          <div
            data-loose-area="true"
            className="mx-1 rounded transition-colors"
          >
            {loosePages.map(p => {
              if (!pageKeep(p)) {
                if (focusHide) return null
                return skelRow(p.id, p.title || '无标题', 1, <FileIcon ext={p.fileType || ''} size={14} />, () => { onExitFocus?.(); onOpenPage(p.id) })
              }
              return (
              <div key={p.id}
                data-page-id={p.id}
                draggable
                onDragStart={e => {
                  console.log('[NB page dragStart] page:', p.title, p.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'page', id: p.id }))
                  e.dataTransfer.setData('application/x-kb-page', p.id)
                  dragRef.current = { type: 'page', id: p.id }
                  ;(e.currentTarget as HTMLElement).style.opacity = '0.4'
                }}
                onDragEnd={e => { ;(e.currentTarget as HTMLElement).style.opacity = '1'; dragRef.current = null }}
                onClick={() => onOpenPage(p.id)}
                onContextMenu={e => {
                  e.preventDefault(); e.stopPropagation()
                  setContextMenu({ type: 'page', id: p.id, x: e.clientX, y: e.clientY })
                }}
                className={`flex items-center gap-1 py-[3px] cursor-pointer group rounded-md transition-colors ${
                  deletingState(p.id) === 'animating' ? 'kb-deleting'
                  : deletingState(p.id) === 'done' ? 'kb-deleting kb-done'
                  : activePageId === p.id ? 'bg-[var(--bg-selected)]/40 text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                }`}
                style={{
                  paddingLeft: '18px', paddingRight: '4px',
                  ...(cutItemIds?.has(p.id) ? { opacity: 0.45 } : {})
                }}
              >
                <span className="w-[12px] shrink-0" />
                <FileIcon ext={p.fileType || ''} size={14} />
                {editingPageId === p.id ? (
                  <input
                    className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1.5 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
                    value={editPageName}
                    onChange={e => setEditPageName(e.target.value)}
                    onBlur={() => handleRenamePage(p.id)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRenamePage(p.id); if (e.key === 'Escape') setEditingPageId(null) }}
                    onClick={e => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className={`flex-1 truncate text-[12.5px] ${activePageId === p.id ? 'text-[var(--text-primary)]' : ''}`}>{p.title || '无标题'}</span>
                )}
                {(() => { const fi = getFileTypeInfo(p.fileType || ''); return <span className="hidden group-hover:inline-block shrink-0 text-[8px] px-1 rounded font-medium ml-1" style={{ backgroundColor: fi.color + '20', color: fi.color }}>{fi.badge}</span> })()}
                {p.isStarred && <Star size={11} className="shrink-0 text-[var(--warning)]" fill="currentColor" />}
                {deletingState(p.id) === 'animating' && <DeleteWipe />}
              </div>
            )
            })}
          </div>
        )}

        {rootCats.length === 0 && (isSpaceView ? !spaceId || (pagesByCategory.get(spaceId)?.length ?? 0) === 0 : loosePages.length === 0) && (
          <div className="flex flex-col items-center py-8 px-4 text-center">
            <Folder size={28} className="text-[var(--text-disabled)] mb-2" />
            <p className="text-[11px] text-[var(--text-muted)]">暂无内容</p>
            <p className="text-[10px] text-[var(--text-disabled)] mt-0.5">新建页面与目录请在编辑器模块操作</p>
          </div>
        )}
      </div>

      {/* ===== Starred ===== */}
      {!focusActive && starredPages.length > 0 && (
        <div className="border-t border-[var(--border-color)] pt-0.5 pb-0.5 px-2">
          <button onClick={() => setStarredOpen(v => !v)}
            className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded transition-colors text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
            <span className="shrink-0 w-3.5 flex items-center justify-center">
              <ChevronRight size={13} className={`kb-chevron text-[var(--text-muted)] ${starredOpen ? 'rotate-90' : ''}`} />
            </span>
            <Star size={13} className="shrink-0 text-[var(--warning)]" fill="currentColor" />
            <span className="flex-1 text-left">收藏</span>
            <span className="text-[10px] text-[var(--text-muted)] shrink-0">{starredPages.length}</span>
          </button>
          {/* 收藏分组折叠（docs/ui-animation-plan.md C 类）：Collapsible 保持「收起不挂载子树」的懒语义 */}
          <Collapsible open={starredOpen} innerClassName="">{() => (
            <div className="ml-5 border-l border-[var(--border-color)]">
              {starredPages.map(p => (
                <div key={p.id} onClick={() => onOpenPage(p.id)}
                  onContextMenu={e => {
                    e.preventDefault(); e.stopPropagation()
                    setContextMenu({ type: 'page', id: p.id, x: e.clientX, y: e.clientY })
                  }}
                  className={`group flex items-center gap-1 px-1 ml-2 py-[3px] cursor-pointer rounded-md transition-colors ${
                    deletingState(p.id) === 'animating' ? 'kb-deleting'
                  : deletingState(p.id) === 'done' ? 'kb-deleting kb-done'
                    : activePageId === p.id ? 'bg-[var(--bg-selected)]/40 text-[var(--text-primary)] ring-1 ring-inset ring-[var(--accent)]/40' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}>
                  <Star size={11} className="shrink-0 text-[var(--warning)]" fill="currentColor" />
                  {editingPageId === p.id ? (
                    <input
                      className="flex-1 min-w-0 bg-[var(--input-bg)] border border-[var(--accent)] rounded px-1 py-[2px] text-[12.5px] outline-none text-[var(--text-primary)]"
                      value={editPageName}
                      onChange={e => setEditPageName(e.target.value)}
                      onBlur={() => handleRenamePage(p.id)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRenamePage(p.id); if (e.key === 'Escape') setEditingPageId(null) }}
                      onClick={e => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="truncate flex-1 text-[12.5px]">{p.title || '无标题'}</span>
                  )}
                  {(() => { const fi = getFileTypeInfo(p.fileType || ''); return <span className="hidden group-hover:inline-block shrink-0 text-[8px] px-1 rounded font-medium ml-1" style={{ backgroundColor: fi.color + '20', color: fi.color }}>{fi.badge}</span> })()}
                  {deletingState(p.id) === 'animating' && <DeleteWipe />}
                </div>
              ))}
            </div>
          )}</Collapsible>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div className="fixed inset-0 z-[60] kb-pop-layer" onClick={() => setContextMenu(null)}>
          <div
            className="absolute bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded shadow-xl py-0.5 min-w-[170px]"
            ref={contextMenuRef}
            style={contextMenuStyle}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            {contextMenu.type === 'category' && (
              <>
                {onCopy && (
                  <button onClick={() => { onCopy([{ type: 'category', id: contextMenu.id }]); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Copy size={14} className="text-[var(--text-muted)]" />复制
                  </button>
                )}
                {onCut && (
                  <button onClick={() => { onCut([{ type: 'category', id: contextMenu.id }]); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Scissors size={14} className="text-[var(--text-muted)]" />剪切
                  </button>
                )}
                {onPaste && (
                  <>
                    <div className="border-t border-[var(--border-color)] my-0.5" />
                    <button
                      onClick={() => { if (clipboard && clipboard.items.length > 0) { onPaste(contextMenu.id); setContextMenu(null) } }}
                      disabled={!clipboard || clipboard.items.length === 0}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors ${
                        clipboard && clipboard.items.length > 0
                          ? 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                          : 'text-[var(--text-disabled)] cursor-not-allowed'
                      }`}>
                      <ClipboardPaste size={14} className={clipboard && clipboard.items.length > 0 ? 'text-[var(--text-muted)]' : 'text-[var(--text-disabled)]'} />粘贴{clipboard && clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}
                    </button>
                  </>
                )}
                <div className="border-t border-[var(--border-color)] my-0.5" />
                <button onClick={() => {
                  const cat = categories.find(c => c.id === contextMenu.id)
                  if (cat) { handleStartRename(cat.id, cat.name); setContextMenu(null) }
                }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Pencil size={14} className="text-[var(--text-muted)]" />重命名
                </button>
                <button onClick={() => { onCopyPath?.('category', contextMenu.id, 'rel'); setContextMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Link2 size={14} className="text-[var(--text-muted)]" />复制相对路径
                </button>
                <button onClick={() => { onCopyPath?.('category', contextMenu.id, 'abs'); setContextMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Link2 size={14} className="text-[var(--text-muted)]" />复制路径
                </button>
                <div className="border-t border-[var(--border-color)] my-0.5" />
                <button onClick={() => {
                  const cat = categories.find(c => c.id === contextMenu.id)
                  if (cat) {
                    if (skipDeleteConfirm) onDeleteNotebook(cat.id)
                    else setDeleteTarget({ id: cat.id, name: cat.name })
                  }
                  setContextMenu(null)
                }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors text-left">
                  <Trash2 size={14} />删除
                </button>
              </>
            )}
            {contextMenu.type === 'page' && (
              <>
                {onCopy && (
                  <button onClick={() => { onCopy([{ type: 'page', id: contextMenu.id }]); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Copy size={14} className="text-[var(--text-muted)]" />复制
                  </button>
                )}
                {onCut && (
                  <button onClick={() => { onCut([{ type: 'page', id: contextMenu.id }]); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Scissors size={14} className="text-[var(--text-muted)]" />剪切
                  </button>
                )}
                {onExportPage && (
                  <>
                    <div className="border-t border-[var(--border-color)] my-0.5" />
                    <button onClick={() => { onExportPage(contextMenu.id); setContextMenu(null) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                      <FileOutput size={14} className="text-[var(--text-muted)]" />导出文件...
                    </button>
                  </>
                )}
                <div className="border-t border-[var(--border-color)] my-0.5" />
                <button onClick={() => { const pg = allPages.find(x => x.id === contextMenu.id); handleStartRenamePage(contextMenu.id, pg?.title || ''); setContextMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Pencil size={14} className="text-[var(--text-muted)]" />重命名
                </button>
                <button onClick={() => { onCopyPath?.('page', contextMenu.id, 'rel'); setContextMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Link2 size={14} className="text-[var(--text-muted)]" />复制相对路径
                </button>
                <button onClick={() => { onCopyPath?.('page', contextMenu.id, 'abs'); setContextMenu(null) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Link2 size={14} className="text-[var(--text-muted)]" />复制路径
                </button>
                <div className="border-t border-[var(--border-color)] my-0.5" />
                {onDeletePage && (
                  <button onClick={() => { onDeletePage(contextMenu.id); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors text-left">
                    <Trash2 size={14} />删除
                  </button>
                )}
              </>
            )}
            {contextMenu.type === 'blank' && (
              <>
                {onCreateSpace && !isSpaceView && (
                  <button onClick={() => { setContextMenu(null); setCreateSpaceName(''); setCreatingSpace(true) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Layers size={14} className="text-[var(--info)]" />创建学习空间
                  </button>
                )}
                {onCreateNotebook && isSpaceView && (
                  <button onClick={() => { setContextMenu(null); setCreateNotebookName(''); setCreatingNotebook(true) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <BookOpen size={14} className="text-[var(--text-muted)]" />创建笔记本
                  </button>
                )}
                {onPaste && (
                  <button
                    onClick={() => {
                      if (clipboard && clipboard.items.length > 0) {
                        onPaste(contextMenu.id || (isSpaceView ? spaceId ?? null : null))
                        setContextMenu(null)
                      }
                    }}
                    disabled={!clipboard || clipboard.items.length === 0}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors ${
                      clipboard && clipboard.items.length > 0
                        ? 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
                        : 'text-[var(--text-disabled)] cursor-not-allowed'
                    }`}>
                    <ClipboardPaste size={14} className={clipboard && clipboard.items.length > 0 ? 'text-[var(--text-muted)]' : 'text-[var(--text-disabled)]'} />粘贴{clipboard && clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}
                  </button>
                )}
                <div className="border-t border-[var(--border-color)] my-0.5" />
                <button onClick={() => { setContextMenu(null); onImport() }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                  <Download size={14} className="text-[var(--text-muted)]" />导入文件...
                </button>
                {onImportFolder && (
                  <button onClick={() => { setContextMenu(null); onImportFolder() }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <Folder size={14} className="text-[var(--text-muted)]" />导入文件夹...
                  </button>
                )}
                <div className="border-t border-[var(--border-color)] my-0.5" />
                <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide px-3 py-1.5">排序方式</div>
                {sortModes.map(m => (
                  <button key={m.id} onClick={() => { setSortMode(m.id); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left">
                    <span className="w-4 flex items-center justify-center shrink-0">
                      {sortMode === m.id && <Check size={12} className="text-[var(--accent)]" />}
                    </span>
                    {m.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除"
        message={`删除「${deleteTarget?.name ?? ''}」？子目录和页面一并移入回收站。`}
        confirmLabel="删除"
        onConfirm={(skipNext) => {
          if (skipNext) { setSkipDeleteConfirm(true); setSetting('skipDeleteConfirm_knowledgeCategory', true) }
          if (deleteTarget) { onDeleteNotebook(deleteTarget.id); setDeleteTarget(null) }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
