import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Folder, ListTree, X, BookMarked, Puzzle, Share2, Image as ImageIcon, ArrowUp, Pin, PinOff } from 'lucide-react'
import { LOCATE_QUIZ_VIEW_EVENT , QUIZ_VIEW_TOGGLED_EVENT } from '../../lib/workbenchLayout'
import type { KnowledgeCategory, KnowledgePage, KnowledgeTag, PluginViewContribution } from '../../types'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { WelcomeHtmlView } from './components/WelcomeHtmlView'
import { FileMetaCard } from './components/FileMetaCard'
import { registerAssistantContext } from '../../lib/assistantContext'
import {
  getKnowledgeCategories, createKnowledgeCategory, updateKnowledgeCategory, deleteKnowledgeCategory,
  getKnowledgePages, getKnowledgePageById, createKnowledgePage, deleteKnowledgePage,
  searchKnowledgePages, getKnowledgeStarredPages,
  moveKnowledgePage, moveKnowledgeCategory,
  updateKnowledgePage, toggleKnowledgeStar,
  showImportOpenDialog, readImportFiles, importPdf, importPdfFile, importBinaryFile, importBinary,
  showFolderDialog, importFolder,
  duplicateKnowledgePage, duplicateKnowledgeCategory,
  showExportSaveDialog, writeExportTextFile,
  getKnowledgeTags, pluginListViews, getKnowledgeGraph,
  getKnowledgeIndexWarnings,
  workspaceRename, workspaceGetCurrent,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { recordFileOp } from '../../lib/fileOpHistory'
import { useDataChanged } from '../../lib/dataChanged'
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { NotebookList } from './components/NotebookList'
import { ChapterPanel } from './components/ChapterPanel'
import { SpacePanel } from './components/SpacePanel'
// Monaco 宿主单独 lazy：PageEditor 内联了 @monaco-editor/react，而 monaco 主包 8.3MB
// 绝不能进首屏。知识库模块本身是静态引入的（切换零延迟），只有编辑器这一块按需加载。
const PageEditor = lazy(() => import('./components/PageEditor').then((m) => ({ default: m.PageEditor })))
import { PageTabStrip } from '../../components/workbench/PageTabStrip'
import { getFileTypeInfo } from '../../lib/fileTypes'
import { GraphView } from './components/graph/GraphView'
import { QuizCollection } from './components/QuizCollection'
import { QuizNavPanel } from './components/QuizNavPanel'
import { ConfirmDialog } from '../../components/shared'
import { OutlinePanel, parseHeadings } from '../../components/shared/OutlinePanel'
import { PluginFrame } from '../../components/shared/PluginFrame'
import { ImportZone } from '../shared/components/ImportZone'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { FolderFocusButton } from '../../components/shared/FolderFocusButton'
import { isEditingInput } from '../../lib/shortcuts'
import { getGlobalActiveTab } from '../../lib/activeTab'
import { useSettings } from '../../lib/SettingsContext'
import { KNOWLEDGE_SIDEBAR_ITEM_VARS } from '../../lib/settings'

// ---- 剪贴板类型 ----
interface ClipItem { type: 'category' | 'page'; id: string }
interface ClipboardData { action: 'copy' | 'cut'; items: ClipItem[] }

/** 打开页面的显示信息（标题 + 文件类型）。v3.4.0 页面条置顶后页签条统一由 PageTabStrip 渲染，
    本类型只承担本模块 openPageInfos 的数据形状（原 PageTabBar 组件已删除） */
interface PageInfo {
  title: string
  fileType: string
}

export function KnowledgeModule({ sidebarOpen = true, zoom = 1, sidebarWidths = {} as Record<string, number>, onSnapCloseSidebar, onSnapOpenSidebar, isActive = true, sidebarEl = null, sidebarHosted = false, sidebarVariant = 'knowledge', pageBarEl = null, pageBarHosted = false, onImmersiveChange }: { sidebarOpen?: boolean; zoom?: number; sidebarWidths?: Record<string, number>; onSnapCloseSidebar?: () => void; onSnapOpenSidebar?: () => void; isActive?: boolean; sidebarEl?: HTMLElement | null; sidebarHosted?: boolean; sidebarVariant?: 'knowledge' | 'quiz'; pageBarEl?: HTMLElement | null; pageBarHosted?: boolean; onImmersiveChange?: (v: boolean) => void }) {
  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [allPages, setAllPages] = useState<KnowledgePage[]>([])
  const [chapterPages, setChapterPages] = useState<KnowledgePage[]>([])
  const [starredPages, setStarredPages] = useState<KnowledgePage[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null)
  const [focusChapterId, setFocusChapterId] = useState<string | null>(null)  // when set, ChapterPanel shows only this chapter
  const [activePageId, setActivePageId] = useState<string | null>(null)
  const [openPageIds, setOpenPageIds] = useState<string[]>([])
  const [openPageInfos, setOpenPageInfos] = useState<Record<string, PageInfo>>({})
  /** R4-G1：图谱全幅视图开关（入口在左侧目录树底部；Esc/返回按钮退出） */
  const [graphMode, setGraphMode] = useState(false)
  /** 图谱目录 scope：进入时锁定「当前最深选中目录」的仓库路径；null=全库 */
  const [graphScope, setGraphScope] = useState<{ path: string; name: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)

  const [showCategoryPanel, setShowCategoryPanel] = useState(true)
  const [showChapterPanel, setShowChapterPanel] = useState(true)
  const [showOutline, setShowOutline] = useState(false)
  const [liveContent, setLiveContent] = useState('')
  const [locatePageId, setLocatePageId] = useState<string | null>(null)
  const [locateCategoryId, setLocateCategoryId] = useState<string | null>(null)
  const [allKnowledgeTags, setAllKnowledgeTags] = useState<KnowledgeTag[]>([])
  const [showQuizCollection, setShowQuizCollection] = useState(false)
  // 错题本视图开合反向通知左栏（批次5 反馈轮，QUIZ_VIEW_TOGGLED_EVENT）：
  // 非书签路径（树内入口）进出时 App 据此切左栏 quiz/knowledge 模块态，双侧栏与错位由此消除
  const toggleQuizCollection = useCallback((open: boolean) => {
    setShowQuizCollection(open)
    window.dispatchEvent(new CustomEvent(QUIZ_VIEW_TOGGLED_EVENT, { detail: { open } }))
  }, [])
  // v3.4.0 左栏「错题本」书签定位（kb-locate-quiz-view）：App 书签点击 = 切到本模块 + 延迟派发事件 → 打开错题本/收藏视图
  useEffect(() => {
    const handler = () => toggleQuizCollection(true)
    window.addEventListener(LOCATE_QUIZ_VIEW_EVENT, handler)
    return () => window.removeEventListener(LOCATE_QUIZ_VIEW_EVENT, handler)
  }, [toggleQuizCollection])
  /** C 级模块插件声明的视图（slot=knowledge.sidebar）+ 当前打开的插件视图 */
  const [pluginViews, setPluginViews] = useState<PluginViewContribution[]>([])
  const [activePluginView, setActivePluginView] = useState<PluginViewContribution | null>(null)
  // 知识库侧边栏条目大小（紧凑/标准/宽松）→ CSS 变量，树行密度随之缩放
  const { s: settings, update: updateSettings } = useSettings()
  /** 数据形态 = vault：知识库为只读导航，一切写收口到编辑器模块（后端也已白名单拒绝，这里给前端护栏+明确提示） */
  const vaultReadonly = true // R6 D9 后恒 vault：知识库只读导航，写收口编辑器（sqlite 读源已退役）
  const writeBlocked = (action: string): boolean => {
    if (!vaultReadonly) return false
    showToast({ type: 'warning', message: '仓库文件模式为只读，请到编辑器模块操作' })
    return true
  }
  const sidebarItemVars = KNOWLEDGE_SIDEBAR_ITEM_VARS[settings.knowledgeSidebarItemSize] ?? KNOWLEDGE_SIDEBAR_ITEM_VARS.m
  /** 删除动画状态：条目删除时先被红色吞噬（animating），动画后消失（done，等待 IPC 完成） */
  const [deletingMap, setDeletingMap] = useState<Map<string, 'animating' | 'done'>>(new Map())

  const deletingRef = useRef(deletingMap)
  deletingRef.current = deletingMap

  // ---- 剪贴板 ----
  const [clipboard, setClipboard] = useState<ClipboardData | null>(null)

  /** 工作区标题下「移出当前目录」drop 区激活态（拖页面到此返回上一级/零散） */
  const [ejectOn, setEjectOn] = useState(false)

  // ---- 预览/固定标签（VS Code 风格）：dirty=编辑中（关闭需确认，视同固定） ----
  const [dirtyPageIds, setDirtyPageIds] = useState<Set<string>>(new Set())
  const dirtyPageIdsRef = useRef(dirtyPageIds)
  useEffect(() => { dirtyPageIdsRef.current = dirtyPageIds }, [dirtyPageIds])

  // ---- 固定标签：浏览只占一个「预览槽」，显式固定（双击/图钉/右键）才累积，永不被浏览替换 ----
  const [pinnedPageIds, setPinnedPageIds] = useState<Set<string>>(new Set())
  const pinnedPageIdsRef = useRef(pinnedPageIds)
  useEffect(() => { pinnedPageIdsRef.current = pinnedPageIds }, [pinnedPageIds])

  // ---- 未保存关闭确认 ----
  const [unsavedClosePageId, setUnsavedClosePageId] = useState<string | null>(null)

  // ---- 页签右键菜单（固定/关闭族） ----
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; pageId: string } | null>(null)
  const handleTabContextMenu = useCallback((e: React.MouseEvent, pageId: string) => {
    // 粗夹取：菜单约 170×140，避免贴屏幕右/下缘溢出
    setTabCtx({
      x: Math.min(e.clientX, window.innerWidth - 180),
      y: Math.min(e.clientY, window.innerHeight - 150),
      pageId,
    })
  }, [])

  const openPageIdsRef = useRef(openPageIds)
  const activePageIdRef = useRef(activePageId)
  const selectedCategoryIdRef = useRef(selectedCategoryId)
  const selectedChapterIdRef = useRef(selectedChapterId)
  useEffect(() => { openPageIdsRef.current = openPageIds }, [openPageIds])
  useEffect(() => { activePageIdRef.current = activePageId }, [activePageId])
  useEffect(() => {
    setLiveContent('')  // reset live outline when switching pages
    if (!activePageId) {
      // No active page → close outline, keep sidebar state unchanged
      setShowOutline(false)
    }
  }, [activePageId])
  useEffect(() => { selectedCategoryIdRef.current = selectedCategoryId }, [selectedCategoryId])
  useEffect(() => { selectedChapterIdRef.current = selectedChapterId }, [selectedChapterId])

  // 插件视图挂载点：加载声明了 knowledge.sidebar 的 C 级模块插件
  // 订阅 plugins-changed：插件安装/卸载/启停后侧栏入口即时同步 —— 本模块 Tab 保活不重挂，
  // 只跑一次挂载加载的话，已消失的入口会一直留在侧栏（如退役的「错题本(插件版)」）
  const loadPluginViews = useCallback(async () => {
    try { setPluginViews(await pluginListViews('knowledge.sidebar')) } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    void loadPluginViews()
    window.addEventListener('plugins-changed', loadPluginViews)
    return () => window.removeEventListener('plugins-changed', loadPluginViews)
  }, [loadPluginViews])

  // AI 助手上下文（当前打开的页面 → 供全局侧栏「边看边问」）注册在下方 readingPage 声明之后：
  // 正文来源需要读到阅读页，而 effect 的依赖数组无法引用尚未声明的变量。

  useEffect(() => {
    if (sidebarOpen) {
      setShowCategoryPanel(true)
      // Only restore chapter panel for notebooks, not folders
      const cat = selectedCategoryId ? categories.find(c => c.id === selectedCategoryId) : null
      setShowChapterPanel(cat?.categoryType === 'notebook')
    }
  }, [sidebarOpen])

  // --- derived ---
  const chapters = categories.filter(c => c.parentId === selectedCategoryId)
  const selectedCategory = selectedCategoryId ? categories.find(c => c.id === selectedCategoryId) : null
  const selectedSpace = selectedSpaceId ? categories.find(c => c.id === selectedSpaceId) ?? null : null
  const allLoosePages = useMemo(() => allPages.filter(p => p.categoryId === null), [allPages])

  // --- data loading ---
  const refreshCategories = useCallback(async () => {
    try { setCategories(await getKnowledgeCategories()) } catch (e) { console.error(e) }
  }, [])

  const refreshAllPages = useCallback(async () => {
    try { setAllPages(await getKnowledgePages()) } catch (e) { console.error(e) }
  }, [])

  const refreshChapterPages = useCallback(async () => {
    if (!selectedChapterId) { setChapterPages([]); return }
    try {
      // 列表项为瘦身载荷,反链在编辑器内按需查询
      setChapterPages(await getKnowledgePages(selectedChapterId))
    } catch (e) { console.error(e) }
  }, [selectedChapterId])

  const refreshStarred = useCallback(async () => {
    try { setStarredPages(await getKnowledgeStarredPages()) } catch (e) { console.error(e) }
  }, [])

  const refreshTags = useCallback(async () => {
    try { setAllKnowledgeTags(await getKnowledgeTags()) } catch (e) { console.error(e) }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([refreshCategories(), refreshAllPages(), refreshStarred(), refreshTags()])
      .finally(() => setLoading(false))
    console.log('[Knowledge] module mounted · net-v2（手动关联/注解/沉浸阅读已启用）')
  }, [])

  // 读写分工（P0 约定）：Tab 保活，编辑器保存后索引已失效 → 每次激活重读
  const activatedOnceRef = useRef(false)
  useEffect(() => {
    if (!isActive) return
    if (!activatedOnceRef.current) { activatedOnceRef.current = true; return }
    refreshCategories(); refreshAllPages(); refreshStarred(); refreshTags()
    // A8：图谱视图挂载中时同步刷新（编辑器保存/删除/重命名后切回知识 Tab）
    window.dispatchEvent(new Event('kb-graph-refresh'))
    // 阅读详情页也是 keep-alive：编辑器改过磁盘后必须重读（2026-09-09 修复"回知识库看不到修改"）
    window.dispatchEvent(new Event('kb-reload-detail'))
  }, [isActive])

  /** Ctrl+Z 撤销 / 重做文件操作（kb-fs-op-changed）→ 重读页面与分类（不限 isActive：
   *  撤销常发生在编辑区，此时知识库虽保活但不在前台，回来时数据必须已是新的） */
  useEffect(() => {
    const handler = () => {
      refreshCategories(); refreshAllPages(); refreshStarred(); refreshTags()
      if (selectedChapterId) refreshChapterPages()
      window.dispatchEvent(new Event('kb-graph-refresh'))
      window.dispatchEvent(new Event('kb-reload-detail'))
    }
    window.addEventListener('kb-fs-op-changed', handler)
    return () => window.removeEventListener('kb-fs-op-changed', handler)
  }, [refreshCategories, refreshAllPages, refreshStarred, refreshTags, refreshChapterPages, selectedChapterId])

  /** 主进程侧写操作（AI 工具建页面/写文件等）→ 广播后重读（2026-09-10 修）。
   *  与 kb-fs-op-changed 同一套刷新动作；不限 isActive —— 保活时也要把数据更新到位，回来即是最新。 */
  useDataChanged('knowledge', () => {
    refreshCategories(); refreshAllPages(); refreshStarred(); refreshTags()
    if (selectedChapterId) refreshChapterPages()
    window.dispatchEvent(new Event('kb-graph-refresh'))
    window.dispatchEvent(new Event('kb-reload-detail'))
  })

  // .ignore 规则提示（§10.1）：只有用户可行动的 .ignore 规则问题才 Toast + 终端计数；
  // 信息性警告（frontmatter.id 缺失=草稿机制等）完全静默——fingerprint 只记 actionable，
  // 过程性警告（清理/补建计数）随 rebuild 变化若也打印，终端会被无行动价值的计数刷屏
  const lastActionableRef = useRef('')
  const checkIndexWarnings = useCallback(async () => {
    try {
      const list = (await getKnowledgeIndexWarnings()) ?? []
      const actionable = list.filter((w) => w.startsWith('规则「') || w.includes('.ignore'))
      const fp = actionable.join('\n')
      if (fp === lastActionableRef.current) return
      lastActionableRef.current = fp
      if (actionable.length === 0) return
      console.warn(`[KnowledgeIndex] ${actionable.length} .ignore rule warning(s) (details: UI toast / DevTools breakpoint)`)
      showToast({ type: 'warning', message: actionable.length === 1 ? actionable[0] : `${actionable[0]}（等 ${actionable.length} 条，详见控制台）` })
    } catch { /* 旧主进程无此通道时静默 */ }
  }, [])
  useEffect(() => {
    if (!isActive) return
    void checkIndexWarnings()
  }, [isActive, checkIndexWarnings])

  // 监听数据导入事件 — 导入完成后刷新所有数据
  useEffect(() => {
    const handler = () => { refreshCategories(); refreshAllPages(); refreshStarred(); refreshTags() }
    window.addEventListener('data-imported', handler)
    return () => window.removeEventListener('data-imported', handler)
  }, [refreshCategories, refreshAllPages, refreshStarred])

  // 监听回收站恢复事件 — 恢复页面/目录/空间后立即刷新，恢复的位置立即可见
  useEffect(() => {
    const handler = (e: Event) => {
      const module = (e as CustomEvent).detail?.module
      if (module === 'knowledge' || module === 'knowledge_category') {
        refreshCategories(); refreshAllPages(); refreshChapterPages(); refreshStarred()
      }
    }
    window.addEventListener('recycle-restored', handler)
    return () => window.removeEventListener('recycle-restored', handler)
  }, [refreshCategories, refreshAllPages, refreshChapterPages, refreshStarred])

  useEffect(() => { refreshChapterPages() }, [refreshChapterPages])

  // --- notebook CRUD（创建收口到编辑器模块：本模块仅保留重命名/删除等导航维护）---
  const handleRenameNotebook = async (id: string, name: string) => {
    await updateKnowledgeCategory(id, { name })
    refreshCategories()
  }
  const handleRenamePage = async (id: string, name: string) => {
    await updateKnowledgePage(id, { title: name })
    setAllPages(prev => prev.map(p => p.id === id ? { ...p, title: name } : p))
    setChapterPages(prev => prev.map(p => p.id === id ? { ...p, title: name } : p))
    setStarredPages(prev => prev.map(p => p.id === id ? { ...p, title: name } : p))
    setOpenPageInfos(prev => {
      const existing = prev[id]
      return existing ? { ...prev, [id]: { ...existing, title: name } } : prev
    })
    refreshAllPages(); refreshChapterPages()
  }
  /**
   * 带删除动画的执行器：动画与删除进度同步——
   * 发起删除 → 条目进入"删除中"（红色吞噬持续推进 + 龙头循环咀嚼，直到删除真正完成）；
   * 删除完成（IPC resolve）→ 收尾（快速吞完剩余 + 淡出）→ 条目消失并刷新；
   * 删除失败 → 动画回退（条目恢复显示）。
   * vault 只读挡已挪到各调用方（2026-09-07：目录删除在仓库文件模式开放，页面删除维持收口编辑器）。
   */
  const deleteWithAnimation = useCallback(async (id: string, fn: () => Promise<void>) => {
    if (deletingRef.current.has(id)) return
    setDeletingMap(m => new Map(m).set(id, 'animating'))
    try {
      await fn()          // 真实删除（耗时不定：小条目快、大空间慢）
      // 删除完成 → 收尾：快速吞完 + 淡出（约 400ms，匹配收尾动画时长）
      setDeletingMap(m => new Map(m).set(id, 'done'))
      await new Promise<void>(r => setTimeout(r, 420))
    } catch (e) {
      console.error('[Knowledge] delete failed:', e)
      showToast({ type: 'error', message: '删除失败，请重试' })
    } finally {
      setDeletingMap(m => { const n = new Map(m); n.delete(id); return n })
      refreshCategories(); refreshAllPages(); refreshChapterPages(); refreshStarred()
    }
  }, [vaultReadonly])

  /** vault 模式目录删除确认：文件夹将随全部子页面移入系统回收站（与编辑器删除同语义） */
  const confirmVaultCategoryDelete = useCallback(async (id: string): Promise<boolean> => {
    if (!vaultReadonly) return true
    const name = categories.find(c => c.id === id)?.name ?? '该目录'
    return await showGlobalConfirm({
      title: '删除目录',
      message: `目录「${name}」及其下全部子目录与页面文件将一并移入系统回收站。确定删除吗？`,
      confirmLabel: '删除',
      cancelLabel: '取消',
      variant: 'danger',
    }) === true
  }, [vaultReadonly, categories])

  const handleDeleteNotebook = async (id: string) => {
    if (!(await confirmVaultCategoryDelete(id))) return
    await deleteWithAnimation(id, async () => {
      await deleteKnowledgeCategory(id)
      if (selectedCategoryId === id) { setSelectedCategoryId(null); setSelectedChapterId(null) }
      if (selectedSpaceId === id) { setSelectedSpaceId(null); setSelectedChapterId(null); setFocusChapterId(null); setShowChapterPanel(false) }
    })
  }

  // --- chapter CRUD（创建收口到编辑器模块）---
  const handleRenameChapter = async (id: string, name: string) => {
    await updateKnowledgeCategory(id, { name })
    refreshCategories()
  }
  const handleDeleteChapter = async (id: string) => {
    if (!(await confirmVaultCategoryDelete(id))) return
    await deleteWithAnimation(id, async () => {
      await deleteKnowledgeCategory(id)
      if (selectedChapterId === id) setSelectedChapterId(null)
    })
  }

  /** 空白右键菜单：创建学习空间（2026-09-07 恢复；vault 模式=建顶层文件夹+目录条目，DB 模式=原通道；vault 已支持，不走 writeBlocked 老挡板） */
  const handleCreateSpace = useCallback(async (name: string) => {
    try {
      await createKnowledgeCategory({ name, categoryType: 'space' })
      refreshCategories()
      showToast({ type: 'info', message: `已创建学习空间「${name}」` })
    } catch (e) {
      console.error('[Knowledge] create space failed:', e)
      showToast({ type: 'error', message: e instanceof Error ? e.message : '创建学习空间失败' })
    }
  }, [])

  /** 空白右键菜单（空间视图）：创建笔记本（2026-09-07 恢复；只能创建在学习空间内部，不可嵌套；vault 已支持，不走 writeBlocked 老挡板） */
  const handleCreateNotebook = useCallback(async (name: string) => {
    if (!selectedSpaceId) { showToast({ type: 'warning', message: '笔记本只能创建在学习空间内部' }); return }
    try {
      await createKnowledgeCategory({ name, categoryType: 'notebook', parentId: selectedSpaceId })
      refreshCategories()
      showToast({ type: 'info', message: `已创建笔记本「${name}」` })
    } catch (e) {
      console.error('[Knowledge] create notebook failed:', e)
      showToast({ type: 'error', message: e instanceof Error ? e.message : '创建笔记本失败' })
    }
  }, [selectedSpaceId])

  const handleImportFolder = async () => {
    try {
      const paths = await showFolderDialog()
      if (!paths || paths.length === 0) return
      const catId = selectedChapterId || null
      for (const folderPath of paths) {
        const result = await importFolder(folderPath, catId)
        if (result && 'error' in result) {
          console.error('Folder import failed:', result.error)
          showToast({ type: 'error', message: `导入文件夹失败: ${result.error}` })
        } else if (result) {
          showToast({ type: 'info', message: `已导入「${result.name}」(${result.fileCount} 文件, ${result.folderCount} 子目录)` })
        }
      }
      refreshCategories(); refreshAllPages()
    } catch (e) { console.error(e); showToast({ type: 'error', message: '导入文件夹失败' }) }
  }

  const handleDialogImport = async () => {
    if (writeBlocked('导入')) return
    try {
      const paths: string[] = await showImportOpenDialog()
      if (!paths || paths.length === 0) return

      // Separate binary (PDF/XMind) from text files
      const binaryPaths = paths.filter(p => p.toLowerCase().endsWith('.pdf') || p.toLowerCase().endsWith('.xmind'))
      const textPaths = paths.filter(p => !binaryPaths.includes(p))

      // Import text files
      if (textPaths.length > 0) {
        const results = await readImportFiles(textPaths)
        for (const r of results) {
          if (r.error) continue
          const catId = selectedChapterId || null
          await createKnowledgePage({ title: r.baseName || '导入页面', contentMd: r.content, categoryId: catId, fileType: r.fileType || '' })
        }
      }

      // Import binary files — vault（仓库文件）模式下 PDF/XMind 导入通道未实现，明确跳过不静默失败
      let skippedBinary = 0
      for (const bp of binaryPaths) {
        if (vaultReadonly) { skippedBinary++; continue }
        const ext = bp.toLowerCase().split('.').pop() || ''
        const result = ext === 'pdf' ? await importPdfFile(bp) : await importBinaryFile(bp, ext)
        if (result.error) console.error(`${ext} import failed:`, result.error)
      }
      if (skippedBinary > 0) showToast({ type: 'warning', message: `已导入文本 ${textPaths.length} 个；${skippedBinary} 个 PDF/思维导图暂不支持仓库文件模式，已跳过` })

      if (selectedChapterId) refreshChapterPages()
      else refreshAllPages()
    } catch (e) { console.error(e) }
  }

  const handleDropImport = async (files: Array<{ title: string; content: string; fileType: string }>) => {
    try {
      const catId = selectedChapterId || null
      for (const f of files) {
        await createKnowledgePage({ title: f.title, contentMd: f.content, categoryId: catId, fileType: f.fileType || '' })
      }
      if (selectedChapterId) refreshChapterPages()
      else refreshAllPages()
    } catch (e) { console.error(e) }
  }

  const handleDropImportBinary = async (files: Array<{ title: string; base64: string; fileName: string }>) => {
    if (vaultReadonly) { showToast({ type: 'warning', message: '仓库文件模式：PDF/思维导图拖放导入暂不支持' }); return }
    try {
      for (const f of files) {
        const ext = f.fileName.toLowerCase().split('.').pop() || ''
        if (ext === 'pdf') await importPdf(f.base64, f.fileName)
        else await importBinary(f.base64, f.fileName, ext)
      }
      refreshAllPages()
    } catch (e) { console.error(e) }
  }

  // --- 沉浸阅读模式 ---
  const [readingMode, setReadingMode] = useState(false)
  const [readingPage, setReadingPage] = useState<KnowledgePage | null>(null)

  const enterReading = useCallback(async () => {
    const id = activePageIdRef.current
    if (!id) { showToast({ type: 'warning', message: '请先打开一个页面' }); return }
    try {
      const p = await getKnowledgePageById(id)
      if (!p) return
      const ft = (p.fileType || 'md').toLowerCase()
      // html（欢迎页）也可沉浸阅读：整页 iframe，阅读布局分支见下方渲染
      if (ft !== 'md' && ft !== 'txt' && ft !== 'html') {
        showToast({ type: 'warning', message: '沉浸阅读仅支持 md / txt 页面' })
        return
      }
      setReadingPage(p)
      setReadingMode(true)
    } catch (e) { console.error(e) }
  }, [])

  const exitReading = useCallback(() => {
    setReadingMode(false)
    setReadingPage(null)
  }, [])

  const openInReading = useCallback(async (pageId: string) => {
    try {
      const p = await getKnowledgePageById(pageId)
      if (p) setReadingPage(p)
    } catch (e) { console.error(e) }
  }, [])

  // AI 助手上下文：当前打开的页面（供全局侧栏「边看边问」）
  // 正文来源（性能 2026-09-10）：列表接口已改为只回骨架，正文改从「沉浸阅读页」或
  // 「编辑器实时内容」取——这两者正是用户当下真正在看/在改的文本。
  useEffect(() => {
    return registerAssistantContext(() => {
      const pid = activePageIdRef.current
      if (!pid) return null
      const p = allPages.find(x => x.id === pid)
      if (!p) return null
      const content = (readingPage && readingPage.id === pid ? readingPage.contentMd : '') || liveContent || ''
      return {
        type: 'knowledge.page',
        label: `知识库页面「${p.title || '无标题'}」`,
        data: { id: p.id, title: p.title, contentMd: content.slice(0, 8000) },
      }
    })
  }, [allPages, readingPage, liveContent])

  /** 图谱卡片「在阅读器中打开」：从图谱直接进入该页沉浸阅读（先退图谱覆盖层） */
  const openPageInReader = useCallback(async (pageId: string) => {
    try {
      const p = await getKnowledgePageById(pageId)
      if (!p) {
        // draft 页（getKnowledgePageById 按正式集过滤返回 null）——提示改到编辑器完成
        showToast({ type: 'warning', message: '该页面为草稿（修改中）— 请在编辑器中完成并归档后阅读' })
        return
      }
      const ft = (p.fileType || 'md').toLowerCase()
      if (ft !== 'md' && ft !== 'txt' && ft !== 'html') { showToast({ type: 'warning', message: '沉浸阅读仅支持 md / txt 页面' }); return }
      setGraphMode(false)
      setReadingPage(p)
      setReadingMode(true)
    } catch (e) { console.error(e) }
  }, [])

  /** P1 附件路由：PDF/文档附件 → 编辑器 PdfReaderView（App 收到 kb-open-in-editor 会切编辑器 Tab） */
  const openAttachmentInEditor = useCallback((relPath: string) => {
    if (!relPath) { showToast({ type: 'warning', message: '附件路径为空' }); return }
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath, from: 'knowledge' } })) // 条目6：带来源 → 编辑器出「← 返回 知识库」
  }, [])

  // --- tab management (VS Code preview mode) ---
  const handleOpenPage = useCallback(async (pageId: string) => {
    let info = [...allLoosePages, ...chapterPages, ...starredPages].find(p => p.id === pageId)
    if (!info || !info.fileType) {
      try { info = await getKnowledgePageById(pageId) ?? undefined } catch {}
    }
    if (info) {
      setOpenPageInfos(prev => ({ ...prev, [pageId]: { title: info!.title, fileType: info!.fileType || '' } }))
    }

    const currentIds = openPageIdsRef.current
    const activeId = activePageIdRef.current

    // If already open, just switch to it
    if (currentIds.includes(pageId)) {
      setActivePageId(pageId)
      return
    }

    // 预览/钉住双态（VS Code 模型）：只替换「当前预览槽」（非固定、非编辑中）。
    // 固定标签永不被替换；必须原位替换而非整栏重置，否则钉住的标签会被清掉
    const dirty = dirtyPageIdsRef.current
    const pinned = pinnedPageIdsRef.current
    const replaceCurrent = activeId && !dirty.has(activeId) && !pinned.has(activeId)

    if (replaceCurrent) {
      // Replace the preview tab in place (pinned/dirty neighbors stay)
      setOpenPageIds(prev => prev.map(id => (id === activeId ? pageId : id)))
      setOpenPageInfos(prev => {
        const next = { ...prev }
        delete next[activeId]
        next[pageId] = { title: info?.title ?? '', fileType: info?.fileType ?? '' }
        return next
      })
    } else {
      // Append as a new tab (pinned/dirty tabs stay, or explicitly opened)
      setOpenPageIds(prev => [...prev, pageId])
    }

    setActivePageId(pageId)
  }, [allLoosePages, chapterPages, starredPages])

  const handleCloseTab = useCallback((pageId: string) => {
    // Check unsaved changes
    const dirty = dirtyPageIdsRef.current
    if (dirty.has(pageId)) {
      setUnsavedClosePageId(pageId)
      return
    }
    forceCloseTab(pageId)
  }, [])

  const forceCloseTab = useCallback((pageId: string) => {
    const currentIds = openPageIdsRef.current
    const idx = currentIds.indexOf(pageId)
    if (idx === -1) return
    const nextIds = currentIds.filter(id => id !== pageId)
    setOpenPageIds(nextIds)
    setOpenPageInfos(prev => { const next = { ...prev }; delete next[pageId]; return next })
    setDirtyPageIds(prev => { const next = new Set(prev); next.delete(pageId); return next })
    setPinnedPageIds(prev => { const next = new Set(prev); next.delete(pageId); return next })
    if (activePageIdRef.current === pageId) {
      if (nextIds.length === 0) {
        setActivePageId(null)
        // All tabs closed — just close outline, keep sidebar state unchanged
        setShowOutline(false)
      }
      else { const newIdx = Math.min(idx, nextIds.length - 1); setActivePageId(nextIds[newIdx]) }
    }
  }, [])

  /** 固定/取消固定：双击标签、图钉按钮、右键菜单共用 */
  const handleTogglePin = useCallback((pageId: string) => {
    setPinnedPageIds(prev => {
      const next = new Set(prev)
      if (next.has(pageId)) next.delete(pageId)
      else next.add(pageId)
      return next
    })
  }, [])

  /** 关闭其他：保留目标标签；编辑中（dirty）的标签需走未保存确认，这里直接跳过 */
  const handleCloseOthers = useCallback((pageId: string) => {
    const dirty = dirtyPageIdsRef.current
    const keep = openPageIdsRef.current.filter(id => id === pageId || dirty.has(id))
    setOpenPageIds(keep)
    setOpenPageInfos(prev => {
      const next: Record<string, PageInfo> = {}
      for (const id of keep) if (prev[id]) next[id] = prev[id]
      return next
    })
    setPinnedPageIds(prev => new Set([...prev].filter(id => keep.includes(id))))
    setActivePageId(pageId)
  }, [])

  /** 全部关闭：编辑中（dirty）的标签保留（关闭它们要走未保存确认） */
  const handleCloseAll = useCallback(() => {
    const dirty = dirtyPageIdsRef.current
    const keep = openPageIdsRef.current.filter(id => dirty.has(id))
    setOpenPageIds(keep)
    setOpenPageInfos(prev => {
      const next: Record<string, PageInfo> = {}
      for (const id of keep) if (prev[id]) next[id] = prev[id]
      return next
    })
    setPinnedPageIds(prev => new Set([...prev].filter(id => keep.includes(id))))
    if (!keep.includes(activePageIdRef.current ?? '')) {
      if (keep.length === 0) { setActivePageId(null); setShowOutline(false) }
      else setActivePageId(keep[keep.length - 1])
    }
  }, [])

  const handlePageDeleted = useCallback(async (id: string) => {
    // 2026-09-09：删除页面在 vault 模式已放行（主进程 knowledge:deletePage 走系统回收站），不再走 writeBlocked 老挡板
    await deleteWithAnimation(id, async () => {
      await deleteKnowledgePage(id)
      // 页面已删除，清除脏标记后直接关闭标签页（无需确认未保存）
      setDirtyPageIds(prev => { const n = new Set(prev); n.delete(id); return n })
      forceCloseTab(id)
      // After delete, if no page is active but the chapter still has pages, auto-open first one
      const nextActiveId = activePageIdRef.current
      const chId = selectedChapterIdRef.current
      if (!nextActiveId && chId) {
        const pages = await getKnowledgePages(chId)
        if (pages.length > 0) handleOpenPage(pages[0].id)
      }
    })
  }, [forceCloseTab, vaultReadonly])

  const handleReorderTabs = useCallback((newOrder: string[]) => { setOpenPageIds(newOrder) }, [])

  const handleBackToList = useCallback(() => {
    if (activePageIdRef.current) handleCloseTab(activePageIdRef.current)
    refreshAllPages(); refreshChapterPages(); refreshStarred()
  }, [handleCloseTab])

  const handleRefresh = () => { refreshAllPages(); refreshChapterPages(); refreshStarred(); refreshTags() }
  const handleSearchRefresh = useCallback(() => { refreshAllPages(); refreshTags() }, [refreshAllPages, refreshTags])

  const handleClearDirty = useCallback((pageId?: string) => {
    const pid = pageId || activePageIdRef.current
    if (!pid) return
    setDirtyPageIds(prev => {
      if (!prev.has(pid)) return prev
      const next = new Set(prev)
      next.delete(pid)
      return next
    })
  }, [])

  const handleMarkDirty = useCallback((pageId?: string) => {
    const pid = pageId || activePageIdRef.current
    if (!pid) return
    setDirtyPageIds(prev => {
      if (prev.has(pid)) return prev
      const next = new Set(prev)
      next.add(pid)
      return next
    })
  }, [])

  const handleTitleChange = useCallback((title: string) => {
    if (!activePageIdRef.current) return
    const pageId = activePageIdRef.current
    setAllPages(prev => prev.map(p => p.id === pageId ? { ...p, title } : p))
    setChapterPages(prev => prev.map(p => p.id === pageId ? { ...p, title } : p))
    setOpenPageInfos(prev => {
      const existing = prev[pageId]
      return { ...prev, [pageId]: { title, fileType: existing?.fileType || '' } }
    })
  }, [])

  const handleFileTypeChange = useCallback((fileType: string) => {
    if (!activePageIdRef.current) return
    const pageId = activePageIdRef.current
    setAllPages(prev => prev.map(p => p.id === pageId ? { ...p, fileType } : p))
    setChapterPages(prev => prev.map(p => p.id === pageId ? { ...p, fileType } : p))
    setStarredPages(prev => prev.map(p => p.id === pageId ? { ...p, fileType } : p))
    setOpenPageInfos(prev => {
      const existing = prev[pageId]
      return { ...prev, [pageId]: { ...existing, fileType } }
    })
  }, [])

  const handleToggleStar = async (pageId: string) => {
    await toggleKnowledgeStar(pageId)
    refreshAllPages(); refreshChapterPages(); refreshStarred()
  }

  // 读写分工：仓库读源模式下跳转编辑器模块编辑同一文件（.AGENT/docs/读写分工设计.md）
  const handleOpenInEditor = async (pageId: string) => {
    try {
      const p = await getKnowledgePageById(pageId)
      if (!p?.path) {
        showToast({ type: 'warning', message: '该页面不在仓库读源中（设置 → 通用 → 知识库读源 开启 vault）' })
        return
      }
      window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: p.path, from: 'knowledge' } }))
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '跳转编辑器失败' })
    }
  }

  // ---- 剪贴板操作 ----
  // 剪切项的 ID 集合（供子组件高亮半透明）
  const cutItemIds = useMemo(() => {
    if (!clipboard || clipboard.action !== 'cut') return new Set<string>()
    return new Set(clipboard.items.map(i => i.id))
  }, [clipboard])

  const handleCopy = useCallback((items: ClipItem[]) => {
    setClipboard({ action: 'copy', items })
    const label = items.length === 1 ? (items[0].type === 'category' ? '目录' : '页面') : `${items.length} 个项目`
    showToast({ type: 'info', message: `已复制 ${label}` })
  }, [])

  const handleCut = useCallback((items: ClipItem[]) => {
    setClipboard({ action: 'cut', items })
    const label = items.length === 1 ? (items[0].type === 'category' ? '目录' : '页面') : `${items.length} 个项目`
    showToast({ type: 'info', message: `已剪切 ${label}` })
  }, [])

  const handlePaste = useCallback(async (targetCategoryId: string | null) => {
    if (writeBlocked('粘贴')) return
    if (!clipboard || clipboard.items.length === 0) return
    const { action, items } = clipboard

    try {
      const notebookChapterCache = new Map<string, string | null>()
      for (const item of items) {
        let resolvedTargetCategoryId = targetCategoryId
        const targetCategory = targetCategoryId ? categories.find(c => c.id === targetCategoryId) : null

        if (item.type === 'page' && targetCategory) {
          if (targetCategory.categoryType === 'notebook') {
            let chapterId = notebookChapterCache.has(targetCategory.id)
              ? notebookChapterCache.get(targetCategory.id)
              : categories.find(c => c.parentId === targetCategory.id)?.id ?? null
            if (!chapterId) {
              const chapter = await createKnowledgeCategory({ name: '默认章节', parentId: targetCategory.id, categoryType: 'folder' })
              await refreshCategories()
              const freshCategories = await getKnowledgeCategories()
              chapterId = freshCategories.find(c => c.name === '默认章节' && c.parentId === targetCategory.id)?.id ?? chapter.id
            }
            notebookChapterCache.set(targetCategory.id, chapterId)
            resolvedTargetCategoryId = chapterId
          }
        } else if (item.type === 'category' && targetCategoryId === null) {
          const sourceCategory = categories.find(c => c.id === item.id)
          if (sourceCategory?.categoryType !== 'space') {
            throw new Error('普通分类不能移动到根层级')
          }
        }

        if (action === 'copy') {
          if (item.type === 'page') {
            await duplicateKnowledgePage({ pageId: item.id, targetCategoryId: resolvedTargetCategoryId })
          } else {
            await duplicateKnowledgeCategory({ categoryId: item.id, targetParentId: resolvedTargetCategoryId })
          }
        } else {
          // cut = move
          if (item.type === 'page') {
            await updateKnowledgePage(item.id, { categoryId: resolvedTargetCategoryId })
          } else {
            await updateKnowledgeCategory(item.id, { parentId: resolvedTargetCategoryId })
          }
        }
      }

      const label = items.length === 1 ? (items[0].type === 'category' ? '目录' : '页面') : `${items.length} 个项目`
      showToast({ type: 'info', message: `${action === 'copy' ? '已粘贴（副本）' : '已移动到新位置'} — ${label}` })

      if (action === 'cut') setClipboard(null)  // cut: 粘贴后清空
      // copy: 不清空，可以多次粘贴

      refreshCategories(); refreshAllPages(); refreshChapterPages()
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '粘贴失败' })
    }
  }, [clipboard, categories, refreshCategories])

  const handleExportPage = useCallback(async (pageId: string) => {
    try {
      // 性能 2026-09-10：列表骨架不再携带正文，导出必须走单页接口，否则会写出空文件
      const page = await getKnowledgePageById(pageId)
      if (!page) { showToast({ type: 'error', message: '页面不存在或为草稿，无法导出' }); return }

      // Determine file extension from fileType
      const ext = page.fileType || 'md'
      const defaultName = `${page.title}.${ext === 'markdown' ? 'md' : ext}`

      const result = await showExportSaveDialog({
        defaultName,
        filters: [{ name: '所有文件', extensions: ['*'] }]
      })
      if (!result || !result.filePath) return

      await writeExportTextFile(result.filePath, page.contentMd || '', 'utf-8')
      showToast({ type: 'info', message: `已导出到 ${result.filePath}` })
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '导出失败' })
    }
  }, [])

  // --- drag & drop move ---
  /** 仓库内移动文件/目录（目录即分类：知识库拖拽 = 移动磁盘文件，编辑器是唯一写入方；ws:rename 已触发索引失效） */
  const moveVaultPath = useCallback(async (srcRel: string, dstDirRel: string, label: string): Promise<boolean> => {
    try {
      const cur = await workspaceGetCurrent()
      if (!cur?.rootId) { showToast({ type: 'error', message: '未打开仓库' }); return false }
      const base = srcRel.split('/').pop() || srcRel
      const dstRel = dstDirRel ? `${dstDirRel}/${base}` : base
      if (dstRel === srcRel) return true
      // 注意：不在此处 workspaceMkdir「确保目标目录存在」——ws:mkdir 是「新建」语义（重名自动加 (1) 后缀），
      // 对已存在目录调用会造出镜像空目录。目标父目录由 ws:rename 主进程侧在缺失时自动补建（mkdir -p）。
      const res = await workspaceRename(cur.rootId, srcRel, dstRel)
      if (!res.ok) { showToast({ type: 'error', message: res.error || '移动失败' }); return false }
      // 记入跨模块撤销栈：编辑区与知识库共用一份，Ctrl+Z 可撤回（kb-fs-op-changed 回流刷新）
      recordFileOp({ kind: 'move', rootId: cur.rootId, from: srcRel, to: dstRel, name: base })
      window.dispatchEvent(new CustomEvent('kb-file-moved', { detail: { srcRel, dstRel } })) // 通知编辑器刷新树
      showToast({ type: 'info', message: `已移动 ${label} → ${dstDirRel || '仓库根目录'}` })
      return true
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : '移动失败' })
      return false
    }
  }, [])

  /** 分类 → 仓库相对目录：null（未分类）→ 收件箱；无 path 的历史逻辑分类不可作为移动目标 */
  const targetDirOfCategory = useCallback((categoryId: string | null): string | null => {
    if (categoryId === null) return '.knowbase/_inbox'
    const cat = categories.find((c) => c.id === categoryId)
    if (!cat?.path) { showToast({ type: 'warning', message: '该目录未绑定仓库文件夹，无法作为移动目标' }); return null }
    return cat.path
  }, [categories])

  /** vault 模式：页面文件移动到目标目录；sqlite 模式回落到改归属（不可用路径时提示编辑器移动） */
  const movePageToCategory = useCallback(async (pageId: string, targetCategoryId: string | null): Promise<boolean> => {
    const p = allPages.find((x) => x.id === pageId)
    if (!p?.path) { showToast({ type: 'warning', message: '该页面暂无仓库文件路径，请在编辑器模块中移动' }); return false }
    // 欢迎页固定在仓库根（kbview:// 白名单只收根同名文件，索引也只扫根）——移走即从知识库消失
    if ((p.fileType || '').toLowerCase() === 'html' && p.path === '欢迎.html') {
      showToast({ type: 'warning', message: '「欢迎」需保留在仓库根，不能移动；要改内容请在编辑器里直接编辑它' })
      return false
    }
    if (!vaultReadonly) { // sqlite 过渡期：沿用改分类归属
      try { await updateKnowledgePage(pageId, { categoryId: targetCategoryId }); return true }
      catch { showToast({ type: 'error', message: '移动失败' }); return false }
    }
    const dir = targetDirOfCategory(targetCategoryId)
    if (dir === null) return false
    return moveVaultPath(p.path, dir, `页面「${p.title}」`)
  }, [allPages, vaultReadonly, targetDirOfCategory, moveVaultPath])

  const handleDropOnNotebook = async (pageId: string, notebookId: string) => {
    await movePageToCategory(pageId, notebookId)
    refreshAllPages(); refreshChapterPages()
  }

  const handleDropOnLooseArea = async (pageId: string) => {
    await movePageToCategory(pageId, null)
    refreshAllPages(); refreshChapterPages()
  }

  const handleDropOnCategory = async (pageId: string, categoryId: string) => {
    await movePageToCategory(pageId, categoryId)
    refreshAllPages(); refreshChapterPages()
  }

  const handleDropOnChapter = async (pageId: string, chapterId: string) => {
    await movePageToCategory(pageId, chapterId)
    refreshAllPages(); refreshChapterPages()
  }

  // --- category move (drag & drop)：vault 模式 = 移动整个目录 ---
  const handleMoveCategory = async (categoryId: string, newParentId: string | null) => {
    const src = categories.find((c) => c.id === categoryId)
    if (!src?.path) { showToast({ type: 'warning', message: '该目录未绑定仓库文件夹，请在编辑器模块中移动' }); return }
    if (src.categoryType === 'space') { showToast({ type: 'warning', message: '空间为仓库顶层目录，不能移动' }); return }
    const dir = newParentId === null ? '' : targetDirOfCategory(newParentId)
    if (dir === null) return
    const ok = await moveVaultPath(src.path, dir, `目录「${src.name}」`)
    if (ok) refreshCategories()
  }

  /** 复制条目路径（vault：页面/目录均为仓库内文件；abs=含仓库根的绝对路径） */
  const handleCopyPath = useCallback(async (type: 'category' | 'page', id: string, mode: 'abs' | 'rel') => {
    const rel = type === 'page'
      ? (allPages.find((x) => x.id === id)?.path ?? '')
      : (categories.find((x) => x.id === id)?.path ?? '')
    if (!rel) { showToast({ type: 'warning', message: '该条目暂无仓库文件路径（历史数据）' }); return }
    try {
      let text = rel
      if (mode === 'abs') {
        const cur = await workspaceGetCurrent()
        if (!cur?.path) { showToast({ type: 'error', message: '未打开仓库' }); return }
        text = `${cur.path.replace(/\\/g, '/')}/${rel}`
      }
      await navigator.clipboard.writeText(text)
      showToast({ type: 'info', message: mode === 'abs' ? '已复制完整路径' : '已复制仓库相对路径' })
    } catch { showToast({ type: 'error', message: '复制失败' }) }
  }, [allPages, categories])

  // --- sort (up/down reorder) ---
  const handleSortCategory = async (id: string, direction: 'up' | 'down') => {
    await moveKnowledgeCategory(id, direction)
    refreshCategories()
  }
  const handleSortPage = async (id: string, direction: 'up' | 'down') => {
    await moveKnowledgePage(id, direction)
    refreshAllPages()
    refreshChapterPages()
  }

  // --- notebook / chapter selection ---
  const handleSelectSpace = (id: string) => {
    if (id === selectedSpaceId) {
      setSelectedSpaceId(null)
      setSelectedCategoryId(null)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
      return
    }
    setSelectedSpaceId(id)
    setSelectedCategoryId(null)
    setSelectedChapterId(null)
    setFocusChapterId(null)
    setShowChapterPanel(false)
  }

  const handleCollapseSpace = () => {
    setSelectedSpaceId(null)
    setSelectedCategoryId(null)
    setSelectedChapterId(null)
    setFocusChapterId(null)
    setShowChapterPanel(false)
  }

  const handleSelectCategory = (id: string | null) => {
    if (id === selectedCategoryId) {
      // Toggle: collapse
      setSelectedCategoryId(null)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
    } else {
      setSelectedCategoryId(id)
      setSelectedChapterId(null)
      setFocusChapterId(null)  // show all chapters when clicking notebook label
      // Only notebooks open the chapter panel; folders just expand/collapse in the tree
      const cat = categories.find(c => c.id === id)
      setShowChapterPanel(cat?.categoryType === 'notebook')
    }
  }

  // Select a chapter directly from the tree (under a notebook); toggle if same chapter
  const handleSelectCategoryChapter = (notebookId: string, chapterId: string) => {
    if (focusChapterId === chapterId) {
      setSelectedCategoryId(null)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
    } else {
      setSelectedCategoryId(notebookId)
      setSelectedChapterId(chapterId)
      setFocusChapterId(chapterId)
      setShowChapterPanel(true)
    }
  }

  // Keyboard shortcuts — module level
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'knowledge') return
      // 沉浸阅读：Ctrl+Shift+R 进出；Esc 退出（阅读态下无输入框，无需输入守卫）
      if (readingMode) {
        if (e.key === 'Escape') { e.preventDefault(); exitReading() }
        return
      }
      if (isEditingInput(e)) return

      // Ctrl+N — 新建知识页：跳编辑器触发内联命名行（读写分工：知识库为阅读器，建页在编辑器完成）
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { from: 'knowledge' } }))
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('kb-editor-new-page')), 180)
        return
      }

      if (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault()
        void enterReading()
        return
      }

      // Ctrl+W — close current tab
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault()
        const activeId = activePageIdRef.current
        if (activeId) handleCloseTab(activeId)
        return
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const ids = openPageIdsRef.current
        if (ids.length === 0) return
        const activeId = activePageIdRef.current
        const idx = ids.indexOf(activeId ?? '')
        if (e.shiftKey) {
          const newIdx = idx <= 0 ? ids.length - 1 : idx - 1
          setActivePageId(ids[newIdx])
        } else {
          const newIdx = (idx === -1 || idx >= ids.length - 1) ? 0 : idx + 1
          setActivePageId(ids[newIdx])
        }
        return
      }

      // Ctrl+C — copy selected item to internal clipboard
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault()
        const activeId = activePageIdRef.current
        const catId = selectedCategoryIdRef.current
        if (activeId) {
          handleCopy([{ type: 'page', id: activeId }])
        } else if (catId) {
          handleCopy([{ type: 'category', id: catId }])
        }
        return
      }

      // Ctrl+X — cut selected item
      if (e.ctrlKey && e.key === 'x') {
        e.preventDefault()
        const activeId = activePageIdRef.current
        const catId = selectedCategoryIdRef.current
        if (activeId) {
          handleCut([{ type: 'page', id: activeId }])
        } else if (catId) {
          handleCut([{ type: 'category', id: catId }])
        }
        return
      }

      // Ctrl+V — paste internal clipboard
      if (e.ctrlKey && e.key === 'v') {
        e.preventDefault()
        const target = selectedChapterIdRef.current ?? selectedCategoryIdRef.current
        handlePaste(target)
        return
      }

      // Delete — context-aware (page > chapter > notebook)
      if (e.key === 'Delete') {
        const activeId = activePageIdRef.current
        const chapterId = selectedChapterIdRef.current
        const notebookId = selectedCategoryIdRef.current
        if (activeId) {
          e.preventDefault()
          handlePageDeleted(activeId)
          return
        }
        if (chapterId) {
          e.preventDefault()
          handleDeleteChapter(chapterId)
          return
        }
        if (notebookId) {
          e.preventDefault()
          handleDeleteNotebook(notebookId)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleCloseTab, handleDeleteChapter, handleDeleteNotebook, handlePageDeleted, handleCopy, handleCut, handlePaste, readingMode, enterReading, exitReading])

  // --- outline ---
  const activePageForOutline = useMemo(() => {
    if (!activePageId) return null
    return [...allLoosePages, ...chapterPages, ...starredPages].find(p => p.id === activePageId) ?? null
  }, [activePageId, allLoosePages, chapterPages, starredPages])
  const outlineHeadings = useMemo(() => {
    // 性能 2026-09-10：列表骨架不再携带正文，改为从阅读页取（编辑器态由 liveContent 兜底）
    const md = liveContent || (readingPage && readingPage.id === activePageId ? readingPage.contentMd : '') || ''
    return parseHeadings(md)
  }, [liveContent, readingPage, activePageId])

  // 搜索定位到分类/笔记本（展开树并滚动到目标）
  const handleLocateCategory = useCallback((categoryId: string) => {
    const cat = categories.find(c => c.id === categoryId)
    if (!cat) return

    // 若目标在某个空间内，先打开该空间的沉浸视图
    const findSpaceAncestor = (id: string | null): string | null => {
      let curId: string | null = id
      const seen = new Set<string>()
      while (curId) {
        if (seen.has(curId)) break; seen.add(curId)
        const cur = categories.find(c => c.id === curId)
        if (!cur) return null
        if (cur.categoryType === 'space') return cur.id
        curId = cur.parentId
      }
      return null
    }

    if (cat.categoryType === 'space') {
      // 直接定位空间本身 → 打开该空间
      setSelectedSpaceId(cat.id)
      setSelectedCategoryId(null)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
      setLocateCategoryId(null)
      requestAnimationFrame(() => setLocateCategoryId(categoryId))
      return
    }

    const spaceAncestorId = findSpaceAncestor(cat.parentId)
    if (spaceAncestorId) {
      setSelectedSpaceId(spaceAncestorId)
    }

    // 展开所有祖先
    const ancestors: string[] = []
    let currentId: string | null = cat.parentId
    const seen = new Set<string>()
    while (currentId) {
      if (seen.has(currentId)) break; seen.add(currentId)
      ancestors.push(currentId)
      const parent = categories.find(c => c.id === currentId)
      currentId = parent?.parentId ?? null
    }

    if (cat.categoryType === 'notebook') {
      setSelectedCategoryId(categoryId)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(true)
    } else if (cat.parentId) {
      // Folder/chapter under a notebook
      const parent = categories.find(c => c.id === cat.parentId)
      if (parent?.categoryType === 'notebook') {
        setSelectedCategoryId(cat.parentId)
        setSelectedChapterId(categoryId)
        setFocusChapterId(null)
        setShowChapterPanel(true)
      } else {
        setSelectedCategoryId(categoryId)
        setSelectedChapterId(null)
        setFocusChapterId(null)
        setShowChapterPanel(false)
      }
    } else {
      setSelectedCategoryId(categoryId)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
    }

    // Trigger auto-expand + scroll in NotebookList
    setLocateCategoryId(null)
    requestAnimationFrame(() => setLocateCategoryId(categoryId))
  }, [categories])

  // 全局搜索（左栏搜索态 WorkbenchSearchPanel）跨模块通道：按 id 打开页面 / 定位目录。
  // 冷启动时知识库可能尚未挂载，App 在切 Tab 后延迟派发；handleOpenPage 自带按 id 拉取兜底。
  useEffect(() => {
    const openPage = (e: Event): void => {
      const pageId = (e as CustomEvent<{ pageId?: string }>).detail?.pageId
      if (pageId) void handleOpenPage(pageId)
    }
    const locateCategory = (e: Event): void => {
      const categoryId = (e as CustomEvent<{ categoryId?: string }>).detail?.categoryId
      if (categoryId) handleLocateCategory(categoryId)
    }
    window.addEventListener('kb-open-knowledge-page', openPage)
    window.addEventListener('kb-locate-knowledge-category', locateCategory)
    return () => {
      window.removeEventListener('kb-open-knowledge-page', openPage)
      window.removeEventListener('kb-locate-knowledge-category', locateCategory)
    }
  }, [handleOpenPage, handleLocateCategory])

  const handleLocateInExplorer = useCallback((pageId: string) => {
    const page = allPages.find(p => p.id === pageId)
    if (!page) return

    // Find the category chain: page.categoryId → parent → ... → notebook
    let catId = page.categoryId
    if (!catId) {
      // Loose page — just select null category and highlight
      setSelectedSpaceId(null)
      setSelectedCategoryId(null)
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
      setLocatePageId(pageId)
      return
    }

    // Walk up to find the nearest notebook ancestor.
    let notebookId: string | null = null
    let spaceId: string | null = null
    const chain: string[] = [catId]
    let current = categories.find(c => c.id === catId)
    while (current?.parentId) {
      chain.push(current!.parentId)
      if (current?.categoryType === 'notebook') notebookId = current.id
      if (current?.categoryType === 'space') spaceId = current.id
      current = categories.find(c => c.id === current!.parentId)
    }
    if (current?.categoryType === 'notebook') notebookId = current.id
    if (current?.categoryType === 'space') spaceId = current.id

    // Open the containing space (if any) in immersive view
    if (spaceId) setSelectedSpaceId(spaceId)

    // Select the notebook when available; otherwise select the direct category.
    setSelectedCategoryId(notebookId ?? catId)
    // If under a notebook, select the chapter too
    if (notebookId) {
      setSelectedChapterId(notebookId === catId ? null : catId)
      setFocusChapterId(null)
      setShowChapterPanel(true)
    } else {
      setSelectedChapterId(null)
      setFocusChapterId(null)
      setShowChapterPanel(false)
    }

    // Trigger auto-expand + scroll in NotebookList
    setLocatePageId(null)
    requestAnimationFrame(() => setLocatePageId(pageId))
  }, [allPages, categories])

  const panelsVisible = sidebarOpen

  /** 已知页面标题集合：阅读模式区分空链接 */
  const knownWikiTitles = useMemo(() => new Set(allPages.map(p => p.title)), [allPages])

  // 草稿页 title 集（status: draft）：正文 [[引用]] 渲染为虚化样式（修改中）——数据源=图谱缓存节点 status
  const [draftWikiTitles, setDraftWikiTitles] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!isActive) return
    let alive = true
    getKnowledgeGraph()
      .then((g) => {
        if (!alive) return
        setDraftWikiTitles(new Set(g.nodes.filter((n) => n.kind === 'page' && n.status === 'draft').map((n) => n.title)))
      })
      .catch(() => { /* 无仓库/失败忽略 */ })
    return () => { alive = false }
  }, [isActive, knownWikiTitles])

  /* v3.4.0 页面条置顶：沉浸阅读 / 图谱模式是「全幅」形态，中间栏页面条整行让位 ——
     页面条在外壳层、模块内无法触及，故反向通知 App。只在值变化时回调，避免无谓 setState。 */
  const immersiveRef = useRef(false)
  useEffect(() => {
    const v = readingMode || graphMode
    if (immersiveRef.current === v) return
    immersiveRef.current = v
    onImmersiveChange?.(v)
  }, [readingMode, graphMode, onImmersiveChange])

  // onWikiLink 稳定化（性能 2026-09-10）：原先以内联箭头传入 MarkdownPreview，每次渲染都是
  // 新函数引用 → 组件的 React.memo 恒失效、正文被反复重解析（模块内任意 setState 都会命中）。
  const handleReadingWikiLink = useCallback((t: string) => {
    if (draftWikiTitles.has(t)) {
      showToast({ type: 'warning', message: `「${t}」为草稿，归档后可阅读` })
      return
    }
    const hit = allPages.find(p => p.title === t)
    if (hit) void openInReading(hit.id)
    else showToast({ type: 'warning', message: `未找到「${t}」` })
  }, [draftWikiTitles, allPages, openInReading])

  return (
    <ImportZone onImport={handleDropImport} onImportPdf={handleDropImportBinary} className="h-full">
      <div className="flex h-full flex-col bg-[var(--bg-primary)]">
        {readingMode ? (
          /* ===== 沉浸阅读：只保留正文（进场淡入；可能含 iframe/PDF，故只做透明度、不做位移） ===== */
          <div className="kb-view-fade flex-1 min-w-0 relative">
            {/* 顶部悬停退出区（平时隐形） */}
            <div
              className="absolute top-0 inset-x-0 h-9 z-40 group/rtop cursor-pointer"
              onClick={exitReading}
              title="退出沉浸阅读 (Esc)"
            >
              <div className="h-full opacity-0 group-hover/rtop:opacity-100 transition-opacity duration-200 flex items-center gap-2 px-4 bg-gradient-to-b from-black/45 to-transparent">
                <X size={15} className="text-white/90" />
                <span className="text-[12px] text-white/90">退出阅读</span>
                <span className="flex-1 text-center text-[12px] text-white/70 truncate px-10">{readingPage?.title}</span>
                <span className="w-16" />
              </div>
            </div>

            {readingPage && (readingPage.entryKind ?? 'doc') === 'file' ? (
              /* 归档非 md 文件（全类型归档 D1/D2）：html 沙箱渲染，其余元信息卡 */
              (readingPage.fileType || '').toLowerCase() === 'html' && readingPage.path ? (
                <WelcomeHtmlView path={readingPage.path} />
              ) : (
                <FileMetaCard title={readingPage.title} fileType={readingPage.fileType || ''} path={readingPage.path} updatedAt={readingPage.updatedAt} sizeBytes={readingPage.sizeBytes} />
              )
            ) : readingPage && (readingPage.fileType || '').toLowerCase() === 'html' ? (
              /* 欢迎页（唯一放行的 HTML）：整页沙箱渲染，不走 720px 阅读排版 */
              <WelcomeHtmlView path={readingPage.path || '欢迎.html'} />
            ) : (
            <div className="h-full overflow-y-auto">
              <div className="max-w-[720px] mx-auto px-10 py-14" style={{ fontSize: '15px', lineHeight: 1.9 }}>
                <h1 className="text-[26px] font-bold leading-snug mb-6">{readingPage?.title || '无标题'}</h1>
                {/* P1 附件条：PDF/无扩展名附件 → 在阅读器中打开（kb-open-in-editor → 编辑器 PdfReaderView）；图片灰显 */}
                {readingPage?.attachments && readingPage.attachments.length > 0 && (
                  <div className="mb-6 flex flex-wrap gap-1.5">
                    {readingPage.attachments.map((att) => {
                      const fn = att.split('/').pop() || att
                      const ext = fn.includes('.') ? fn.split('.').pop()!.toLowerCase() : ''
                      const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)
                      if (isImg) {
                        return (
                          <span key={att} title={att}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[12px] text-[var(--text-tertiary)]">
                            <ImageIcon size={13} />{fn}
                          </span>
                        )
                      }
                      const openable = ext === 'pdf' || ext === ''
                      return openable ? (
                        <button key={att} onClick={() => openAttachmentInEditor(att)} title={`在阅读器中打开：${att}`}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)]">
                          <FileText size={13} className="text-[var(--accent)]" />{fn}
                          <span className="text-[10px] text-[var(--text-tertiary)]">阅读</span>
                        </button>
                      ) : (
                        <span key={att} title={att}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 py-1 text-[12px] text-[var(--text-tertiary)]">
                          <FileText size={13} />{fn}
                        </span>
                      )
                    })}
                  </div>
                )}
                {readingPage && (
                  <MarkdownPreview
                    content={readingPage.contentMd}
                    pageId={readingPage.id}
                    pageTitle={readingPage.title}
                    knownWikiTitles={knownWikiTitles}
                    draftWikiTitles={draftWikiTitles}
                    onWikiLink={handleReadingWikiLink}
                  />
                )}
              </div>
            </div>
            )}
            <div className="absolute bottom-4 right-5 text-[10px] text-[var(--text-disabled)] select-none pointer-events-none">
              沉浸阅读 · Esc 退出
            </div>
          </div>
        ) : (
        <>
        {/* v3.4.0 页面条置顶（2026-09-18）：知识库页签条搬进中间栏页面条（portal 到 App 槽位）；
            图谱模式不渲染。托管但槽未就绪 → 渲染 null，绝不回落内嵌（否则同屏两条）。 */}
        {!graphMode && (() => {
          const strip = (
            <PageTabStrip
              owner="knowledge"
              itemAttr="data-tab-id"
              items={openPageIds.map((id) => {
                const info = openPageInfos[id]
                const pinned = pinnedPageIds.has(id) || dirtyPageIds.has(id)
                return {
                  id,
                  title: info?.title || '加载中…',
                  preview: !pinned,
                  pinned,
                  badge: info?.fileType ? getFileTypeInfo(info.fileType).badge : undefined,
                }
              })}
              activeId={activePageId}
              onSelect={(id) => { void handleOpenPage(id) }}
              onClose={handleCloseTab}
              onReorder={handleReorderTabs}
              onTogglePin={handleTogglePin}
              onContextMenu={(e, id) => handleTabContextMenu(e, id)}
            />
          )
          if (pageBarHosted) return pageBarEl ? createPortal(strip, pageBarEl) : null
          /* 兜底形态（未托管）：顶部就是本模块自己的页签行，没页签也留一条同高的空行 */
          return (
            <div className="flex h-9 shrink-0 items-center border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">{strip}</div>
            </div>
          )
        })()}
        <div className="kb-view-fade flex min-h-0 flex-1">
        {/* L1: File / Outline tabs — file tab drills into ChapterPanel when a notebook is selected */}
        {/* v3.4.0 批次3：左栏模块态（sidebarEl 由 App 传入）时，侧栏内容 portal 进左栏 slot —— 挂载点迁移
            而非复制渲染，全部状态留在本组件（方案 §7 风险2）。否则回落原位 ResizablePanel。
            两形态显隐一致：portal 传 null ⇔ ResizablePanel visible=false 不渲染 children；
            且 sidebarEl 形态下 ResizablePanel 整体不渲染，模块中间区不再残留收起边条。 */}
        {(() => {
          const sidebarInner = (
          <div className="flex flex-col h-full" style={sidebarItemVars as unknown as React.CSSProperties}>
            {/* 空间沉浸视图顶部：返回栏（仅空间内显示）；目录拖到本栏=移出空间（移到根级中转） */}
            {selectedSpaceId && selectedSpace && (
              <SpacePanel space={selectedSpace} onCollapse={handleCollapseSpace} onRename={handleRenameNotebook}
                extraAction={
                  <FolderFocusButton
                    on={!!settings.knowledgeFolderFocus}
                    onToggle={() => updateSettings('knowledgeFolderFocus', !settings.knowledgeFolderFocus)}
                  />
                }
                onMoveOut={(id) => { void handleMoveCategory(id, null) }} />
            )}

            {/* 文件/大纲切换 — 仅在空间内显示，位于返回栏下方 */}
            {selectedSpaceId && selectedSpace && (
              <div className="flex items-center gap-1 px-2 pt-1.5 pb-1 border-b border-[var(--border-color)] shrink-0">
                <button
                  onClick={() => setShowOutline(false)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[12px] transition-colors ${!showOutline ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
                >
                  <Folder size={13} />文件
                </button>
                <button
                  onClick={() => setShowOutline(true)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded text-[12px] transition-colors ${showOutline ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
                >
                  <ListTree size={13} />大纲
                </button>
              </div>
            )}

            {/* 空间列表层：顶部「知识库」标题 — 与日程/博客等模块侧栏标题行完全同款 */}
            {!selectedSpaceId && (
              <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
                <BookMarked size={12} />
                知识库
                <FolderFocusButton
                  className="ml-auto"
                  on={!!settings.knowledgeFolderFocus}
                  onToggle={() => updateSettings('knowledgeFolderFocus', !settings.knowledgeFolderFocus)}
                />
              </div>
            )}

            {/* 空间列表层：无大纲入口，直接显示文件树；空间内可切换大纲 */}
            {selectedSpaceId && showOutline ? (
              <div className="kb-view-in flex-1 min-h-0">
                <OutlinePanel
                  pageTitle={activePageForOutline?.title ?? ''}
                  headings={outlineHeadings}
                  onBackToFile={() => setShowOutline(false)}
                  embedded
                />
              </div>
            ) : (
              <>
                {/* File tab: tree stays mounted so its expand/collapse state survives drill-in navigation */}
                <div className={`flex flex-col flex-1 min-h-0 ${showChapterPanel && selectedCategory?.categoryType === 'notebook' ? 'hidden' : ''}`}>
                  {/* 树模式顶部「移出当前目录」drop 区（顶层/空间内常驻；拖页面进入展开，推下树不覆盖） */}
                  <div
                    data-eject-zone
                    onDragOver={e => {
                      const types = e.dataTransfer.types || []
                      if (!types.includes('application/x-kb-page')) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (!ejectOn) setEjectOn(true)
                    }}
                    onDragLeave={e => {
                      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setEjectOn(false)
                    }}
                    onDrop={e => {
                      const types = e.dataTransfer.types || []
                      if (!types.includes('application/x-kb-page')) return
                      e.preventDefault()
                      e.stopPropagation()
                      setEjectOn(false)
                      try {
                        const raw = e.dataTransfer.getData('text/plain')
                        const v = JSON.parse(raw)
                        if (v?.type === 'page' && typeof v.id === 'string') void handleDropOnLooseArea(v.id)
                      } catch {}
                    }}
                    className={`overflow-hidden transition-all duration-150 ${ejectOn ? 'h-9 opacity-100' : 'h-0 opacity-0'}`}
                  >
                    <div className="mx-2 my-1 flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--accent)] bg-[var(--bg-secondary)] px-2 py-1 text-[11px] font-medium text-[var(--accent)] animate-pulse">
                      <ArrowUp size={12} className="shrink-0" />
                      松手：将页面移出当前目录（返回上一级 / 零散）
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <NotebookList
                      categories={categories}
                      allPages={allPages}
                      loosePages={allLoosePages}
                      starredPages={starredPages}
                      selectedCategoryId={selectedCategoryId}
                      focusChapterId={focusChapterId}
                      activePageId={activePageId}
                      spaceId={selectedSpaceId}
                      onSelectSpace={handleSelectSpace}
                      onSelectCategory={handleSelectCategory}
                      onSelectCategoryChapter={handleSelectCategoryChapter}
                      onRenameNotebook={handleRenameNotebook}
                      onDeleteNotebook={handleDeleteNotebook}
                      deletingMap={deletingMap}
                      onOpenPage={handleOpenPage}
                      onImport={handleDialogImport}
                      onImportFolder={handleImportFolder}
                      onDropOnNotebook={handleDropOnNotebook}
                      onDropOnCategory={handleDropOnCategory}
                      onDropOnLooseArea={handleDropOnLooseArea}
                      onMoveCategory={handleMoveCategory}
                      onCreateSpace={handleCreateSpace}
                      onCreateNotebook={handleCreateNotebook}
                      onSortCategory={handleSortCategory}
                      onSortPage={handleSortPage}
                      locatePageId={locatePageId}
                      locateCategoryId={locateCategoryId}
                      focusOn={!!settings.knowledgeFolderFocus}
                      onExitFocus={() => updateSettings('knowledgeFolderFocus', false)}
                      // vault（仓库文件）模式：移动由拖拽承担，复制副本暂不支持 → 隐藏复制/剪切/粘贴，避免点到报错
                      onCopy={vaultReadonly ? undefined : handleCopy}
                      onCut={vaultReadonly ? undefined : handleCut}
                      onPaste={vaultReadonly ? undefined : handlePaste}
                      onExportPage={handleExportPage}
                      onDeletePage={handlePageDeleted}
                      onRenamePage={handleRenamePage}
                      onCopyPath={handleCopyPath}
                      clipboard={clipboard}
                      cutItemIds={cutItemIds}
                    />
                  </div>
                </div>
                {showChapterPanel && selectedCategory && selectedCategory.categoryType === 'notebook' && (
                  <div className="flex-1 min-h-0">
                    <ChapterPanel
                      notebookName={selectedCategory.name}
                      notebookId={selectedCategory.id}
                      chapters={chapters}
                      selectedChapterId={selectedChapterId}
                      focusChapterId={focusChapterId}
                      onSelectChapter={(id) => { setSelectedChapterId(id === selectedChapterId ? null : id); setFocusChapterId(null) }}
                      onRenameChapter={handleRenameChapter}
                      onDeleteChapter={handleDeleteChapter}
                      pages={chapterPages}
                      activePageId={activePageId}
                      onOpenPage={handleOpenPage}
                      onImport={handleDialogImport}
                      onDropOnChapter={handleDropOnChapter}
                      onCollapse={() => { setSelectedCategoryId(null); setSelectedChapterId(null); setFocusChapterId(null); setShowChapterPanel(false) }}
                      onToggleStar={handleToggleStar}
                      onSortChapter={handleSortCategory}
                      onLocateInExplorer={handleLocateInExplorer}
                      onSortPage={handleSortPage}
                      onRefreshPages={() => { refreshAllPages(); refreshChapterPages() }}
                      onMoveCategory={handleMoveCategory}
                      allCategories={categories}
                      onMovePageToLoose={handleDropOnLooseArea}
                      onMovePageToNotebook={handleDropOnNotebook}
                      onMovePageToCategory={handleDropOnCategory}
                      // vault 模式隐藏复制/剪切（移动靠拖拽）
                      onCopy={vaultReadonly ? undefined : handleCopy}
                      onCut={vaultReadonly ? undefined : handleCut}
                      onExportPage={handleExportPage}
                      onDeletePage={handlePageDeleted}
                      onRenamePage={handleRenamePage}
                      onCopyPath={handleCopyPath}
                      clipboard={clipboard}
                      cutItemIds={cutItemIds}
                      deletingMap={deletingMap}
                    />
                  </div>
                )}
              </>
            )}
            {/* 侧边栏底部：错题本 / 收藏 + 插件视图入口（仅空间内显示，顶层工作区列表不显示） */}
            {selectedSpaceId && selectedSpace && (
              <div className="shrink-0 border-t border-[var(--border-color)] px-2 py-1.5 space-y-0.5">
                {/* 内置错题本：唯一入口，恒驻 */}
                <button
                  onClick={() => toggleQuizCollection(true)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <BookMarked size={14} />
                  错题本 / 收藏
                </button>
                {/* C 级模块插件声明的视图挂载点（slot=knowledge.sidebar） */}
                {pluginViews.map(v => (
                  <button
                    key={`${v.pluginId}:${v.slot}`}
                    onClick={() => setActivePluginView(v)}
                    title={`${v.name}（插件）`}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <Puzzle size={14} />
                    <span className="truncate">{v.title}</span>
                    <span className="ml-auto text-[10px] text-[var(--text-disabled)] shrink-0">插件</span>
                  </button>
                ))}
              </div>
            )}
            {/* 图谱入口（R4-G1）：常驻底部，顶层工作区/空间内均可用；点击进入全幅图谱。
                进入时若已选中某目录(笔记本/章节/空间) → 图谱只展示该目录(含子目录) +
                跨目录关联；未选中 → 全库 */}
            {!graphMode && (
              <div className="shrink-0 border-t border-[var(--border-color)] px-2 py-1.5">
                <button
                  onClick={() => {
                    // 当前选中目录(章节/笔记本优先,否则空间)的仓库路径 → 图谱 scope
                    const sel = (selectedCategoryId ? categories.find((c) => c.id === selectedCategoryId) : null)
                      ?? (selectedSpaceId ? categories.find((c) => c.id === selectedSpaceId) : null)
                    setGraphScope(sel?.path ? { path: sel.path, name: sel.name } : null)
                    setGraphMode(true)
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <Share2 size={14} />
                  <span className="truncate">图谱</span>
                </button>
              </div>
            )}
          </div>
          )
          return sidebarEl
            ? createPortal(
                sidebarVariant === 'quiz'
                  ? // 第四轮拍板④：错题本态挂错题本专属侧栏（科目/统计/视图入口），不再是知识库目录树
                    <QuizNavPanel />
                  : !graphMode && panelsVisible && showCategoryPanel
                    ? sidebarInner
                    : null,
                sidebarEl,
              )
            : sidebarHosted
              ? null // Workbench 托管但槽未就绪（左栏收起/翻转瞬间）：渲染 null 等槽重挂后 portal，绝不回落内嵌列（同 editor 口径）
              : (
                <ResizablePanel storageKey="sidebarWidth_knowledgeCat" defaultWidth={240} minWidth={180} maxWidth={400} visible={!graphMode && panelsVisible && showCategoryPanel} initialWidth={sidebarWidths.sidebarWidth_knowledgeCat} onSnapClose={() => setShowCategoryPanel(false)} onSnapOpen={() => { setShowCategoryPanel(true); onSnapOpenSidebar?.() }}>
                  {sidebarInner}
                </ResizablePanel>
              )
        })()}

        {/* 右侧链接提示（选中章节且无L2面板时显示） */}
        {/* Editor */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {graphMode ? (
            <GraphView
              onExit={() => setGraphMode(false)}
              scopePath={graphScope?.path}
              scopeName={graphScope?.name}
              onClearScope={() => setGraphScope(null)}
              onOpenInReader={(id) => void openPageInReader(id)}
            />
          ) : activePageId ? (
            <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载编辑器…</div>}>
              <PageEditor
                pageId={activePageId}
                categories={categories}
                allPages={allPages}
                zoom={zoom}
                onBack={handleBackToList}
                onDeleted={() => handlePageDeleted(activePageId)}
                onNavigate={handleOpenPage}
                onUpdate={handleRefresh}
                onTitleChange={handleTitleChange}
                onFileTypeChange={handleFileTypeChange}
                onContentChange={setLiveContent}
                onTagsChange={handleSearchRefresh}
                onMarkDirty={handleMarkDirty}
                onClearDirty={handleClearDirty}
                onRequestReading={enterReading}
                vaultMode={true} // R6 D9 后恒 vault
                onOpenInEditor={() => handleOpenInEditor(activePageId)}
              />
            </Suspense>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)]">
              <FileText size={48} className="opacity-25" />
            </div>
          )}
        </div>
        </div>
        </>
        )}
      </div>

      {/* 页签右键菜单：固定/取消固定 + 关闭族 */}
      {tabCtx && (
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setTabCtx(null)} onContextMenu={(e) => { e.preventDefault(); setTabCtx(null) }}>
          <div
            className="absolute min-w-[160px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
            style={{ left: tabCtx.x, top: tabCtx.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => { const pid = tabCtx.pageId; setTabCtx(null); handleTogglePin(pid) }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              {pinnedPageIds.has(tabCtx.pageId) ? <PinOff size={13} className="text-[var(--text-muted)]" /> : <Pin size={13} className="text-[var(--text-muted)]" />}
              {pinnedPageIds.has(tabCtx.pageId) ? '取消固定' : '固定标签'}
            </button>
            <div className="mx-2 my-0.5 border-t border-[var(--border-color)]" />
            <button onClick={() => { const pid = tabCtx.pageId; setTabCtx(null); handleCloseTab(pid) }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <X size={13} className="text-[var(--text-muted)]" />关闭
            </button>
            <button onClick={() => { const pid = tabCtx.pageId; setTabCtx(null); handleCloseOthers(pid) }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <X size={13} className="text-[var(--text-muted)]" />关闭其他
            </button>
            <button onClick={() => { setTabCtx(null); handleCloseAll() }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <X size={13} className="text-[var(--text-muted)]" />全部关闭
            </button>
          </div>
        </div>
      )}

      {/* Unsaved changes confirm dialog */}
      <ConfirmDialog
        open={unsavedClosePageId !== null}
        title="未保存的更改"
        message="当前页面有未保存的更改，确定要关闭吗？"
        confirmLabel="关闭"
        onConfirm={() => {
          const id = unsavedClosePageId
          setUnsavedClosePageId(null)
          if (id) { setDirtyPageIds(prev => { const n = new Set(prev); n.delete(id); return n }); forceCloseTab(id) }
        }}
        onCancel={() => setUnsavedClosePageId(null)}
      />

      {/* 错题本 / 收藏（按当前学习空间分区：只显示该空间的内容；源链接可跳回原页面） */}
      {showQuizCollection && <QuizCollection onClose={() => toggleQuizCollection(false)} spaceName={selectedSpace?.name ?? undefined} onOpenPage={handleOpenPage} />}

      {/* C 级模块插件视图：全屏覆盖层（沙箱 iframe + 数据桥） */}
      {activePluginView && (
        <div className="absolute inset-0 z-50 bg-[var(--bg-primary)] flex flex-col" role="dialog" aria-label={`${activePluginView.title}（插件）`}>
          <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] select-none">
            <Puzzle size={12} className="text-[var(--text-muted)]" />
            <span className="text-[11.5px] font-medium text-[var(--text-muted)]">{activePluginView.title}</span>
            <span className="text-[10px] text-[var(--text-disabled)]">{activePluginView.name} · 插件</span>
            <div className="flex-1" />
            <button
              onClick={() => setActivePluginView(null)}
              title="关闭"
              className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <PluginFrame
              pluginId={activePluginView.pluginId}
              entry={activePluginView.entry}
              grantedCapabilities={activePluginView.granted}
              onHostAction={() => false}
            />
          </div>
        </div>
      )}
    </ImportZone>
  )
}
