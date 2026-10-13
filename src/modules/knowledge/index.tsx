import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Folder, ListTree, FolderTree, X, BookMarked, Share2, Image as ImageIcon, ArrowUp, Pin, PinOff, FilePlus, FolderPlus, ClipboardPaste, Pencil, CopyPlus, Trash2, ArrowUpNarrowWide, ArrowDownNarrowWide, Check, ChevronsUpDown, ChevronsDownUp, Columns2, Rows2, Link2, ExternalLink, FolderSearch, FolderInput, House } from 'lucide-react'
import { PluginIcon } from '../../components/shared/ModuleIcons'
import { LOCATE_QUIZ_VIEW_EVENT , QUIZ_ENTRY_ENABLED, QUIZ_VIEW_TOGGLED_EVENT, QUIZ_VIEW_CLOSE_REQUEST_EVENT } from '../../lib/workbenchLayout'
import type { KnowledgeCategory, KnowledgePage, KnowledgeTag, PluginViewContribution } from '../../types'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { WelcomeHtmlView } from './components/WelcomeHtmlView'
import { FileMetaCard } from './components/FileMetaCard'
import { ArchiveTextView } from './components/ArchiveTextView'
import { isTextViewableExt } from '../../lib/aiTextExts'
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
  showExportSaveDialog, writeExportTextFile, writeExportPdf,
  getKnowledgeTags, pluginListViews, getKnowledgeGraph,
  getKnowledgeIndexWarnings,
  workspaceRename, workspaceGetCurrent, workspaceTrash,
  workspaceListDir, workspaceCreateFile, workspaceMkdir,
  workspacePasteExternal, pasteFromClipboard, getPathForFile,
  copyText, workspaceOpenInSystem,
} from '../../lib/ipc'
import { hasTextPasteTarget } from '../../lib/pasteTarget'
import { notifyDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
// 页签判定消费共享 tabPolicy（笔记合并 Phase 1 §1.3）：与编辑器模块同一套「该不该消失 / 关闭落点」
import { previewReplacement, landingAfterClose } from '../../lib/tabPolicy'
// 文件视图（Phase 2 批次 1，B 方案）：共享 VaultTree——与编辑区同一份实现，目录即真相
import { VaultTree, type DirCache, type TreeNode, type CreateIntent, type CreateType, type RenameIntent } from '../../components/shared/VaultTree'
import { recordFileOp } from '../../lib/fileOpHistory'
import { useDataChanged } from '../../lib/dataChanged'
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { FileContextMenu, type FileMenuEntry } from '../../components/shared/FileContextMenu'
import { DirPicker } from '../../components/shared/DirPicker'
import { TreeExpandButton } from '../../components/shared/TreeExpandButton'
import { SIDEBAR_HEADER_ICON } from '../../components/shared/sidebarHeaderIcon'
import { TREE_SORT_OPTIONS, getTreeSortMode, setTreeSortMode, type TreeSortMode } from '../../lib/treeSort'
import { loadTreeSubtree } from '../../lib/treeExpand'
import { duplicateWorkspaceFile } from '../../lib/fileDuplicate'
import { NotebookList } from './components/NotebookList'
import { ChapterPanel } from './components/ChapterPanel'
// Monaco 宿主单独 lazy：PageEditor 内联了 @monaco-editor/react，而 monaco 主包 8.3MB
// 绝不能进首屏。知识库模块本身是静态引入的（切换零延迟），只有编辑器这一块按需加载。
const PageEditor = lazy(() => import('./components/PageEditor').then((m) => ({ default: m.PageEditor })))
import { PageTabStrip } from '../../components/workbench/PageTabStrip'
import { getFileTypeInfo } from '../../lib/fileTypes'
import { GraphView } from './components/graph/GraphView'
import { emptyNav, pushNav, stepNav, canNavBack, canNavForward, type NavState } from './navHistory'
import { QuizCollection } from './components/QuizCollection'
import { QuizNavPanel } from './components/QuizNavPanel'
import { ConfirmDialog } from '../../components/shared'
import { OutlinePanel, parseHeadings } from '../../components/shared/OutlinePanel'
import { PluginFrame } from '../../components/shared/PluginFrame'
import { ImportZone } from '../shared/components/ImportZone'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { FolderFocusButton } from '../../components/shared/FolderFocusButton'
// 图片沉浸态（批 3，2026-10-13）：自带视图态与浮条控件（沉浸态没有顶栏可放控件）
import { ImmersiveImageView } from '../../components/shared/image/ImmersiveImageView'
import { isRenderableImageExt } from '../../lib/imageFormats'
import { TreeNewButton, type TreeNewMenuItem } from '../../components/shared/TreeNewButton'
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

export function KnowledgeModule({ sidebarOpen = true, zoom = 1, sidebarWidths = {} as Record<string, number>, onSnapCloseSidebar, onSnapOpenSidebar, isActive = true, sidebarEl = null, sidebarHosted = false, sidebarVariant = 'knowledge', pageBarEl = null, pageBarHosted = false, onImmersiveChange, modActionsEl = null, onStripVisibleChange, onPageTabActivate, pendingRelPath = null, onPendingRelConsumed, secondaryPageIds = [], secondaryActiveId = null, secondaryBarEl = null, secondaryContentEl = null, splitDisabled = false, onSplitPage, onSecondaryActivate, onMergeSplit, onRemoveSecondary, onMovePageToPane, onBackToWorkbench }: { sidebarOpen?: boolean; zoom?: number; sidebarWidths?: Record<string, number>; onSnapCloseSidebar?: () => void; onSnapOpenSidebar?: () => void; isActive?: boolean; sidebarEl?: HTMLElement | null; sidebarHosted?: boolean; sidebarVariant?: 'knowledge' | 'quiz'; pageBarEl?: HTMLElement | null; pageBarHosted?: boolean; onImmersiveChange?: (v: boolean) => void; modActionsEl?: HTMLElement | null; onStripVisibleChange?: (v: boolean) => void; onPageTabActivate?: () => void; pendingRelPath?: { relPath: string; seq: number; startEdit?: boolean } | null; onPendingRelConsumed?: () => void; secondaryPageIds?: string[]; secondaryActiveId?: string | null; secondaryBarEl?: HTMLElement | null; secondaryContentEl?: HTMLElement | null; splitDisabled?: boolean; onSplitPage?: (pageId: string, orientation: 'row' | 'column') => void; onSecondaryActivate?: (pageId: string) => void; onMergeSplit?: () => void; onRemoveSecondary?: (pageId: string) => void; onMovePageToPane?: (pageId: string) => void; onBackToWorkbench?: () => void }) {
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
  // 左栏「文件 | 大纲」切换（2026-09-19 反馈恢复旧版）：大纲仅 md 页面可用（非 md 激活时自动回落文件树）
  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline'>('files')
  /**
   * 沉浸阅读期的左栏覆盖（2026-09-27 需求：「纯净阅读模式读 md 时左栏应有大纲」）。
   *
   * **刻意不写 `sidebarTab`** —— 那是**用户的选择**，覆写会让「退出沉浸后回不到原来那一栏」。
   * 故另立覆盖位：非 null 时左栏按它渲染，null 时回落 `sidebarTab`。
   * 进出沉浸只改覆盖位 ⇒ 退出即天然还原（拍板②），无需记住/写回旧值。
   *
   * 拍板③「尊重用户手动切换」在本形态下**自动成立**：沉浸态左栏刻意**不渲染**
   * 「文件 | 大纲」切换行（拍板①，纯净），用户无从手动切走。
   * ⚠️ 若将来在沉浸态加回切换行，必须补一个 userOverrideRef 闸门，否则本注释描述的行为会失效。
   */
  const [immersiveTabOverride, setImmersiveTabOverride] = useState<'files' | 'outline' | null>(null)
  /** 沉浸态正文滚动区（左栏大纲点标题时按 id 定位到这里的标题元素） */
  const readingScrollRef = useRef<HTMLDivElement | null>(null)
  /** 图谱目录 scope：进入时锁定「当前最深选中目录」的仓库路径；null=全库 */
  const [graphScope, setGraphScope] = useState<{ path: string; name: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)

  const [showCategoryPanel, setShowCategoryPanel] = useState(true)
  const [showChapterPanel, setShowChapterPanel] = useState(true)
  const [showOutline, setShowOutline] = useState(false)
  // 文件视图（Phase 2 批次 1，B 方案）：左栏 = VaultTree 文件树（结构三件套已退役，下述 state 留待清理）
  const [dirCache, setDirCache] = useState<DirCache>({})
  /** 目录缓存 ref：useDataChanged 回调里重扫已加载目录用（回调声明在 refreshTreeDir 之前，走 ref 取最新值） */
  const dirCacheRef = useRef<DirCache>({})
  dirCacheRef.current = dirCache
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['']))
  /** 展开集镜像 ref：toggle 里判「已展开 / 已加载」用（避免闭包旧值） */
  const expandedDirsRef = useRef(expandedDirs)
  expandedDirsRef.current = expandedDirs
  // 文件树头部（2026-10-11）：排序（与工作台文件树共用 kb.treeSort 偏好）+ 全部展开/关闭
  const [treeSort, setTreeSort] = useState<TreeSortMode>(() => getTreeSortMode())
  const changeTreeSort = (m: TreeSortMode) => { setTreeSort(m); setTreeSortMode(m) }
  const [sortMenuPos, setSortMenuPos] = useState<{ x: number; y: number } | null>(null)
  // 头部按钮＝「展开/收起选中目录的子树」开关（未选中＝根/全部）；选中变化在 onSelectDir 里复位
  const [treeSubtreeExpanded, setTreeSubtreeExpanded] = useState(false)
  const [treeCreating, setTreeCreating] = useState<CreateIntent | null>(null)
  /** 文件树重命名态（B-2）：非空 = 该条目原地换成内联输入行 */
  const [treeRenaming, setTreeRenaming] = useState<RenameIntent | null>(null)
  /** 选中目录（B-7）：头部「＋」的落点来源。null = 无选中 → 落仓库根。
   *  这是 UI 焦点而非 vault 数据（不写盘、不进撤销栈）：点目录行 = 该目录，点文件行 = 其父目录，
   *  进空间 / 图谱态即清空。与 activePath（正在看哪个文件）是两层语义。 */
  const [selectedDirRel, setSelectedDirRel] = useState<string | null>(null)
  /** 选中目录镜像 ref：模块级快捷键 effect（Ctrl+N）内读它——把 selectedDirRel 塞进那个 effect 的
   *  依赖数组会让键盘监听器随每次点目录重建（同 activePageIdRef / selectedCategoryIdRef 的理由） */
  const selectedDirRelRef = useRef<string | null>(null)
  selectedDirRelRef.current = selectedDirRel
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null)
  // 树右键菜单定位：测量后 clamp 进视口（此前是「菜单高度按常量 160 估」的写法，
  // B-2 加了删除/重命名两项后估值必然失真 → 复用本模块既有 hook，与 NotebookList/ChapterPanel 同源）
  // treeMenu 的定位/外观/关闭由共享 FileContextMenu 负责（原 useContextMenuPosition 已并入该组件）
  /** 新建分类目录的命名走文件树内联输入（B-13）：原 `catDraft` 居中浮层整条通道已删——
   *  两条创建路径并存本身就是分叉源，命名方式现已与新建知识页/目录/文件完全一致。 */
  const vaultRootRef = useRef<string | null>(null)
  /** 文件树根容器 ref：右键「粘贴」是合成动作（拿不到真实 paste 事件的 File 列表），
   *  故先 programmatic focus 到这里，再请主进程补发 `webContents.paste()` 复用同一条链路。
   *  与 VaultTree 的 tabIndex={0} 配套（见其 ref/tabIndex 注释）。 */
  const treeRef = useRef<HTMLDivElement | null>(null)
  /** 最近点中的目录（落点兜底）：toggleDir / openFile / 右键都更新它，Ctrl+V 与菜单「粘贴」共用 */
  const lastTreeDirRef = useRef<string>('')
  const [liveContent, setLiveContent] = useState('')
  const [locatePageId, setLocatePageId] = useState<string | null>(null)
  const [locateCategoryId, setLocateCategoryId] = useState<string | null>(null)
  const [allKnowledgeTags, setAllKnowledgeTags] = useState<KnowledgeTag[]>([])
  const [showQuizCollection, setShowQuizCollection] = useState(false)
  /** 首开标记：错题本视图保活挂载的闸门（未开过不付首拉 3 组 IPC 的成本，开过即常驻） */
  const [quizEverOpened, setQuizEverOpened] = useState(false)
  /** 开合镜像 ref：handleOpenPage 内判「当前在错题本视图」用——handleOpenPage 是高频复用回调，
      依赖 showQuizCollection 本体会让 useCallback 随视图开合重建、下游 effect 连锁重跑 */
  const showQuizCollectionRef = useRef(false)
  // 错题本视图开合反向通知左栏（批次5 反馈轮，QUIZ_VIEW_TOGGLED_EVENT）：
  // 非书签路径（树内入口）进出时 App 据此切左栏 quiz/knowledge 模块态，双侧栏与错位由此消除
  const toggleQuizCollection = useCallback((open: boolean) => {
    showQuizCollectionRef.current = open
    setShowQuizCollection(open)
    if (open) setQuizEverOpened(true)
    window.dispatchEvent(new CustomEvent(QUIZ_VIEW_TOGGLED_EVENT, { detail: { open } }))
  }, [])
  // v3.4.0 左栏「错题本」书签定位（kb-locate-quiz-view）：App 书签点击 = 切到本模块 + 延迟派发事件 → 打开错题本/收藏视图
  useEffect(() => {
    const handler = () => toggleQuizCollection(true)
    window.addEventListener(LOCATE_QUIZ_VIEW_EVENT, handler)
    return () => window.removeEventListener(LOCATE_QUIZ_VIEW_EVENT, handler)
  }, [toggleQuizCollection])
  // 页面条「错题本」条目的 ✕（2026-09-19 反馈补关闭钮）→ 关闭错题本视图；
  // 随后 QUIZ_VIEW_TOGGLED {open:false} 回流，条目与左栏 quiz 态自然收起
  useEffect(() => {
    const handler = () => toggleQuizCollection(false)
    window.addEventListener(QUIZ_VIEW_CLOSE_REQUEST_EVENT, handler)
    return () => window.removeEventListener(QUIZ_VIEW_CLOSE_REQUEST_EVENT, handler)
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
    // 只记原始落点：菜单尺寸要渲染后才知道，夹取交给下面的 useLayoutEffect（菜单约 170×210，
    // 用估算值夹取在菜单变高时会贴边/出屏）。
    setTabCtx({ x: e.clientX, y: e.clientY, pageId })
  }, [])
  /** 页签右键菜单：实测面板尺寸后夹进视口（照 src/components/shared/FileContextMenu 口径，8px 边距） */
  const tabCtxPanelRef = useRef<HTMLDivElement | null>(null)
  const [tabCtxPos, setTabCtxPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!tabCtx) { setTabCtxPos(null); return }
    const el = tabCtxPanelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setTabCtxPos({
      left: Math.max(8, Math.min(tabCtx.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(tabCtx.y, window.innerHeight - r.height - 8)),
    })
  }, [tabCtx])

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
  // 页面级分屏：被挪到副栏的页面若正是主栏激活页 → 主栏让位到第一个「留在主栏」的页面
  useEffect(() => {
    if (!secondaryPageIds.length) return
    if (activePageId && secondaryPageIds.includes(activePageId)) {
      const next = openPageIds.find((id) => !secondaryPageIds.includes(id))
      if (next) setActivePageId(next)
    }
  }, [secondaryPageIds, activePageId, openPageIds])
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

  // 结构上下文派生（Phase 2 批次 1 收尾）：树选择退役后，导入目标/图谱 scope 等的「当前分类」语义
  // = 活动页所在分类（无活动页 = null → 落根/零散，与原「未选章节」语义一致）
  useEffect(() => {
    const p = activePageId ? allPages.find(x => x.id === activePageId) : undefined
    const catId = p?.categoryId ?? null
    setSelectedChapterId(catId)
    setSelectedCategoryId(catId)
  }, [activePageId, allPages])

  /** 主进程侧写操作（AI 工具建页面/写文件等）→ 广播后重读（2026-09-10 修）。
   *  与 kb-fs-op-changed 同一套刷新动作；不限 isActive —— 保活时也要把数据更新到位，回来即是最新。 */
  useDataChanged('knowledge', () => {
    refreshCategories(); refreshAllPages(); refreshStarred(); refreshTags()
    if (selectedChapterId) refreshChapterPages()
    // 外部 fs 变化（资源管理器增删改名 → fsWatcher 广播）→ 文件树已加载目录重扫
    //（2026-09-19 反馈：此前只重读知识页索引，树一直停留在旧缓存）
    Object.keys(dirCacheRef.current).forEach((rel) => void refreshTreeDir(rel))
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

  /** 文件夹批量导入主体：对话框选择与拖拽拖入共用。落点 = 当前选中分类，未选中则到根级 */
  const runFolderImport = async (paths: string[]) => {
    try {
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

  const handleImportFolder = async () => {
    const paths = await showFolderDialog()
    if (!paths || paths.length === 0) return
    await runFolderImport(paths)
  }

  /** 拖入文件夹：ImportZone 识别目录后把绝对路径交到这里，与对话框导入同一通道 */
  const handleDropImportFolders = (paths: string[]) => runFolderImport(paths)

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
  /** 顶栏 ← → 的「页面访问历史」（2026-10-11 拍板 D3：模块内共享一条 / 上限 50 / 不落盘） */
  const [nav, setNav] = useState<NavState>(emptyNav)
  const navRef = useRef(nav)
  navRef.current = nav

  const enterReading = useCallback(async () => {
    const id = activePageIdRef.current
    if (!id) { showToast({ type: 'warning', message: '请先打开一个页面' }); return }
    try {
      const p = await getKnowledgePageById(id)
      if (!p) return
      const ft = (p.fileType || 'md').toLowerCase()
      // html（欢迎页）也可沉浸阅读：整页 iframe，阅读布局分支见下方渲染
      // 图片（批 3，2026-10-13）：全屏纯净看图，落点是 ImmersiveImageView（控件退成浮条 ——
      // 沉浸态按定义没有顶栏，见该组件头注）
      if (ft !== 'md' && ft !== 'txt' && ft !== 'html' && !isRenderableImageExt(ft)) {
        showToast({ type: 'warning', message: '沉浸阅读仅支持 md / txt / html / 图片' })
        return
      }
      setReadingPage(p)
      setReadingMode(true)
      // 左栏自动切大纲（拍板①：只放大纲；仅 md 有标题大纲）。
      // 范围刻意收在 md：txt / html 走各自分支、无标题结构 ⇒ 不切（覆盖位置 null）。
      setImmersiveTabOverride(ft === 'md' ? 'outline' : null)
    } catch (e) { console.error(e) }
  }, [])

  const exitReading = useCallback(() => {
    setReadingMode(false)
    setReadingPage(null)
    // 覆盖位归 null ⇒ 左栏回落用户自己的 sidebarTab（拍板②：还原进入前的选择）
    setImmersiveTabOverride(null)
  }, [])

  /**
   * ⋮「导出为 PDF…」（2026-10-13 页面菜单能力补齐批 3）。
   * 顺序刻意是「先定落点、再排版、最后打印」：用户在对话框里取消时**什么都不发生**
   * （尤其不会先切进沉浸态再退出来，白白闪一下）。
   *
   * 为什么借沉浸面打印：`webContents.printToPDF` 打的是**当前窗口**，而沉浸态本来就是
   * 为阅读优化的单栏排版（App 层读 `readingMode` 把标题栏 / 左右栏 / 页面条全收了），
   * 比在普通阅读态里靠一整套打印样式去藏可靠得多；另有一段 `@media print` 兜底（藏左栏 /
   * 沉浸退出热区 / 各类弹层）。
   *
   * ★ 不进撤销栈、不写仓库：导出物在仓库外（用户自己选的位置），仓库不会被污染成 PDF 页面。
   */
  const [exportingPdf, setExportingPdf] = useState(false)
  const exportActivePdf = useCallback(async () => {
    if (exportingPdf) return
    const id = activePageIdRef.current
    const p = id ? allPages.find((x) => x.id === id) : null
    if (!p) { showToast({ type: 'warning', message: '请先打开一个页面' }); return }
    /* ★ 文件名清洗**刻意不用正则**：正则字面量里那个 `"` 会让契约脚本的「剥注释」状态机以为进了
       字符串字面量，从此把注释当活代码 → F1 那类「零残留」断言会假红（2026-10-13 真踩过一回）。
       这里用一份非法字符表 + 逐字符替换，语义一样（Windows 文件名非法字符）。 */
    const ILLEGAL_NAME_CHARS = '<>:"/\\|?*'
    const sanitize = (s: string) => [...s].map((ch) => (ILLEGAL_NAME_CHARS.includes(ch) ? '_' : ch)).join('')
    const suggested = sanitize(p.title || '未命名') || '未命名'
    const { filePath } = await showExportSaveDialog({
      defaultName: `${suggested}.pdf`,
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    })
    if (!filePath) return
    setExportingPdf(true)
    const wasReading = readingMode
    showToast({ type: 'info', message: '正在导出 PDF…' })
    try {
      if (!wasReading) await enterReading()
      // 等版面稳定：进沉浸是 setState + 重渲染，正文里还可能挂着图片/字体
      await new Promise((r) => setTimeout(r, 450))
      const res = await writeExportPdf(filePath)
      if (res?.ok) showToast({ type: 'success', message: '已导出 PDF', detail: filePath })
      else showToast({ type: 'error', message: res?.error || '导出失败' })
    } catch {
      showToast({ type: 'error', message: '导出失败' })
    } finally {
      // ★ 沉浸态是**我们借的**：用户没要求进，就还回去（本来就在沉浸态则保持不动）
      if (!wasReading) exitReading()
      setExportingPdf(false)
    }
  }, [exportingPdf, readingMode, enterReading, exitReading, allPages])

  const openInReading = useCallback(async (pageId: string) => {
    try {
      const p = await getKnowledgePageById(pageId)
      if (!p) return
      // 沉浸阅读内的双链跳转同样计入页面历史（拍板 D4：← → 语义 = 回到刚才看过的页面）
      setNav((s) => pushNav(s, pageId))
      setReadingPage(p)
      // 沉浸中经 [[双链]] 换页也要跟着换左栏（拍板①的延伸）：新页非 md 时收起大纲，
      // 免得留下「大纲不属于当前文档」的错配。只在已处于沉浸态时更新覆盖位。
      const ft = (p.fileType || 'md').toLowerCase()
      setImmersiveTabOverride((cur) => (cur === null ? cur : ft === 'md' ? 'outline' : null))
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
      // 图谱卡片「在阅读器中打开」也是一次页面访问 → 计入历史（否则从图谱跳进来后 ← 是灰的）
      setNav((s) => pushNav(s, pageId))
      setReadingPage(p)
      setReadingMode(true)
    } catch (e) { console.error(e) }
  }, [])

  /** P1 附件路由：PDF/文档附件 → 编辑器 PdfReaderView（App 收到 kb-open-note 会切编辑器 Tab） */
  const openAttachmentInEditor = useCallback((relPath: string) => {
    if (!relPath) { showToast({ type: 'warning', message: '附件路径为空' }); return }
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath, from: 'knowledge' } })) // 条目6：带来源 → 编辑器出「← 返回 知识库」
  }, [])

  // --- tab management (VS Code preview mode) ---
  const handleOpenPage = useCallback(async (pageId: string, infoOverride?: PageInfo, opts?: { fromHistory?: boolean }) => {
    // 错题本是知识库内容区的全幅子视图（2026-09-20 反馈）：开着时点页签只改了保活模块内部
    // activePageId，视图盖着什么都看不见 = 「点了没反应」。任何页面打开/切换先收错题本视图
    // （QUIZ_VIEW_TOGGLED {open:false} 回流 → App 收页面条错题本条目 + 左栏回笔记态）。
    if (showQuizCollectionRef.current) toggleQuizCollection(false)
    // 入栈（拍板 D3）：打开新页、以及**切到已开页签**都算一次访问；从历史回退/前进时跳过
    // （opts.fromHistory）—— 否则「后退」自己会再压一条，形成原地打转。
    if (!opts?.fromHistory) setNav((s) => pushNav(s, pageId))
    // info：页签标题/类型（草稿直入编辑时由调用方自带，Phase 2 批次 1）
    let info: PageInfo | undefined = infoOverride
    if (!infoOverride) {
      let found = [...allLoosePages, ...chapterPages, ...starredPages].find(p => p.id === pageId)
      if (!found || !found.fileType) {
        try { found = await getKnowledgePageById(pageId) ?? undefined } catch {}
      }
      if (found) info = { title: found.title, fileType: found.fileType || '' }
    }
    if (info) {
      setOpenPageInfos(prev => ({ ...prev, [pageId]: info! }))
    }

    const currentIds = openPageIdsRef.current
    const activeId = activePageIdRef.current

    // If already open, just switch to it
    if (currentIds.includes(pageId)) {
      setActivePageId(pageId)
      return
    }

    // 预览/钉住双态（VS Code 模型）：只替换「当前预览槽」（非固定、非编辑中）。
    // 固定标签永不被替换；必须原位替换而非整栏重置，否则钉住的标签会被清掉。
    // 判定消费共享 tabPolicy.previewReplacement（§1.3，与编辑器同源）：知识库无显式 previewRel ——
    // 「激活且非固定」即预览槽；激活标签脏（有未保存编辑）视同固定 → verdict='keep' → 追加，绝不丢内容。
    const dirty = dirtyPageIdsRef.current
    const pinned = pinnedPageIdsRef.current
    const previewSlot = activeId && !pinned.has(activeId) ? activeId : null
    const verdict = previewReplacement(previewSlot, pageId, [...dirty])

    if (verdict === 'drop') {
      // Replace the preview tab in place (pinned/dirty neighbors stay)
      // verdict==='drop' 蕴含 previewSlot 非空（存在干净的预览槽才谈得上替换）
      const slot = previewSlot as string
      setOpenPageIds(prev => prev.map(id => (id === slot ? pageId : id)))
      setOpenPageInfos(prev => {
        const next = { ...prev }
        delete next[slot]
        next[pageId] = info ?? { title: '', fileType: '' }
        return next
      })
    } else {
      // Append as a new tab (pinned/dirty tabs stay, or explicitly opened)
      setOpenPageIds(prev => [...prev, pageId])
    }

    setActivePageId(pageId)
  }, [allLoosePages, chapterPages, starredPages, toggleQuizCollection])

  /**
   * 顶栏 ← → 的取数（拍板 D3 / D4）：
   *   · 单条栈、模块内共享，上限 50，不落盘；
   *   · **失效条目跳过**（页面被删 / 页签被关）—— 不跳过的话表象正是「点了没反应」；
   *   · 回退/前进复用 handleOpenPage（带 fromHistory 跳过一次入栈），
   *     于是「脏页确认」「预览槽替换」等既有页签策略照旧生效，不另开一条旁路。
   */
  const navValid = useCallback((id: string) => (
    openPageIdsRef.current.includes(id) || allPages.some((p) => p.id === id)
  ), [allPages])
  const navStep = useCallback((dir: -1 | 1) => {
    const { state, id } = stepNav(navRef.current, dir, navValid)
    if (!id) return
    setNav(state)
    void handleOpenPage(id, undefined, { fromHistory: true })
  }, [navValid, handleOpenPage])

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
      // 激活落点消费共享 tabPolicy.landingAfterClose（§1.3，与编辑器同源）：右邻居优先，否则左邻居
      const landing = landingAfterClose(currentIds, pageId)
      if (landing) {
        setActivePageId(landing)
      } else {
        setActivePageId(null)
        // All tabs closed — just close outline, keep sidebar state unchanged
        setShowOutline(false)
      }
    }
  }, [])

  // 最后一个页面关闭：**不再**自动关闭「笔记」模块标签（2026-10-09 口径变更）。
  // 旧行为（2026-09-19）是清零即调 onRequestCloseTab → App.closeTab('knowledge') 清 railModule →
  // 左栏回总览。用户反馈：关掉最后一个页面后本意是继续在笔记区从文件树开别的文件，左栏却被弹回总览。
  // 现改为：清零只让中间区走 activePageId===null 的既有空态，模块标签与左栏（文件树展开/滚动）原地保留，
  // 用户想离开笔记区改点其它活动栏图标即可。删除动作与手动关签因此不再需要区分（deletionClear 机制一并移除）。

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

  /* 树内「草稿」徽标已退役（2026-09-19 反馈）：笔记区合并后草稿与正式笔记走同一模块、同一打开路径，
     徽标的原始语义（编辑区专属地盘）已消失；「未转正」状态打开文件即自明（draft: 页签 + 工具栏转正按钮）。
     转正能力不受影响：PageEditor 的「转为正式笔记」照旧。 */

  // ---- 文件视图（Phase 2 批次 1）：VaultTree 接线——与编辑区同一份树实现，目录即真相 ----
  const ensureVaultRoot = useCallback(async (): Promise<string | null> => {
    if (vaultRootRef.current) return vaultRootRef.current
    const cur = await workspaceGetCurrent()
    vaultRootRef.current = cur?.rootId ?? null
    return vaultRootRef.current
  }, [])

  const refreshTreeDir = useCallback(async (dirRel: string) => {
    const root = await ensureVaultRoot()
    if (!root) return
    try {
      const res = await workspaceListDir(root, dirRel)
      if (res?.error) return
      const nodes: TreeNode[] = (res.entries ?? []).map(e => ({ ...e, relPath: dirRel ? `${dirRel}/${e.name}` : e.name }))
      setDirCache(prev => ({ ...prev, [dirRel]: nodes }))
    } catch { /* 静默：树保留旧缓存 */ }
  }, [ensureVaultRoot])

  const handleToggleTreeDir = useCallback((rel: string) => {
    if (expandedDirsRef.current.has(rel)) {
      setExpandedDirs(prev => { const next = new Set(prev); next.delete(rel); return next })
      return
    }
    const open = () => setExpandedDirs(prev => (prev.has(rel) ? prev : new Set(prev).add(rel)))
    // 首次展开先拉数据再展开：否则高度动画在空内容上播放（与工台文件树同口径，2026-10-11）
    if (dirCacheRef.current[rel]) open()
    else void refreshTreeDir(rel).then(open)
  }, [refreshTreeDir])

  /** 目录递归展开（右键「展开此目录（含子目录）」）：只加载点中的子树，带上限 */
  const expandDirRecursive = useCallback(async (rel: string) => {
    const root = await ensureVaultRoot()
    if (!root) return
    const { cache, dirs, truncated } = await loadTreeSubtree(root, rel)
    setDirCache(prev => ({ ...prev, ...cache }))
    setExpandedDirs(prev => new Set([...prev, ...dirs]))
    if (truncated) showToast({ type: 'warning', message: '目录过多，仅展开前 2000 个' })
  }, [ensureVaultRoot])

  /** 目录递归收起：移除该目录及其所有子孙的展开态（rel='' = 全部关闭且根保留） */
  const collapseDirRecursive = useCallback((rel: string) => {
    if (rel === '') { setExpandedDirs(new Set([''])); return }
    setExpandedDirs(prev => {
      const next = new Set(prev)
      for (const p of prev) if (p === rel || p.startsWith(rel + '/')) next.delete(p)
      return next
    })
  }, [])

  // 头部按钮：展开/收起「选中目录」的子树（未选中＝根/全部）
  const toggleTreeSubtree = () => {
    const rel = selectedDirRel ?? ''
    if (treeSubtreeExpanded) { collapseDirRecursive(rel); setTreeSubtreeExpanded(false) }
    else { void expandDirRecursive(rel); setTreeSubtreeExpanded(true) }
  }

  useEffect(() => {
    // 文件视图装载根层（树常驻左栏，展开态自然延续）
    void refreshTreeDir('')
  }, [refreshTreeDir])

  /** 按 relPath 打开（统一通道，Phase 2 批次 2）：树点击与 App 的 pendingRelPath 转发共用——
   *  知识页走页签；无 id md/txt/PDF/代码 → draft 页签（PDF 内嵌阅读器、源码走 Monaco）；不再跳编辑器模块。
   *  反馈 8（2026-09-27）：冷挂载时 allPages 是空的（IPC 异步装载），真实页面会在这里被误判成
   *  「找不到 → 落 draft」。故 miss 时补拉一次全量再找，仍找不到（真·无 id 文件）才落 draft。
   *  startInEdit（2026-09-28 快速草稿）：该页首载直接进编辑态（PageEditor 默认阅读优先）。 */
  const startInEditRef = useRef<string | null>(null)
  const openByRelPath = useCallback(async (relPath: string, opts?: { startInEdit?: boolean }) => {
    let page = allPages.find(p => p.path === relPath)
    if (!page) {
      try {
        const fresh = await getKnowledgePages()
        setAllPages(fresh)
        page = fresh.find(p => p.path === relPath)
      } catch { /* 补拉失败 → 落 draft 兜底 */ }
    }
    if (opts?.startInEdit) startInEditRef.current = page ? page.id : `draft:${relPath}`
    if (page) { void handleOpenPage(page.id); return }
    const name = relPath.slice(relPath.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'md'
    void handleOpenPage(`draft:${relPath}`, { title: name, fileType: ext })
  }, [allPages, handleOpenPage])

  const handleTreeOpenFile = useCallback((node: TreeNode) => {
    if (node.type === 'dir') { handleToggleTreeDir(node.relPath); return }
    void openByRelPath(node.relPath)
  }, [openByRelPath, handleToggleTreeDir])

  // App 转发通道（反馈 8 改版）：原为监听 `kb-open-note-rel` 事件 —— 但知识库模块**冷挂载前不存在
  // 监听器**，App 在切 Tab 的同一批次里同步派发事件必然丢失（表象：看板首跳落了空页签、无页面无返回 chip）。
  // 改走 state+props（ISS-2026-09-04-07 的既定结论，pendingOpenRel 就是为此声明而未接线的）：
  // pending prop 挂到模块首挂之后依然在，effect 消费即可，无时序竞态。seq 让「同一路径连续跳」可重触发。
  const pendingRel = pendingRelPath
  useEffect(() => {
    if (!pendingRel) return
    onPendingRelConsumed?.() // 先消费再打开：打开是 async，避免重渲染后 effect 重跑造成二次打开
    void openByRelPath(pendingRel.relPath, { startInEdit: pendingRel.startEdit === true })
    // 刻意只依赖 pendingRel：openByRelPath 身份随 allPages 变化会重跑本 effect，但 pendingRel 已被
    // 消费清空，重跑会在 !pendingRel 早退，不会二次打开。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRel])

  const parentDirOf = (rel: string): string => { const i = rel.lastIndexOf('/'); return i === -1 ? '' : rel.slice(0, i) }

  const handleTreeMove = useCallback(async (srcRel: string, targetDirRel: string) => {
    // F-13：分类目录恒在仓库顶层（拍板设计），拖拽移动会同时破坏 categories.json 登记与归类推导，
    // 直接拒绝（改名仍可用——走 handleTreeRename 的分类通道）。与分类树侧「空间不能移动」同口径。
    if (categories.some((c) => c.path === srcRel)) {
      showToast({ type: 'warning', message: '分类目录固定在仓库顶层，不能移动；可重命名' })
      return
    }
    const root = await ensureVaultRoot()
    if (!root) return
    const name = srcRel.slice(srcRel.lastIndexOf('/') + 1)
    const dst = targetDirRel ? `${targetDirRel}/${name}` : name
    try {
      await workspaceRename(root, srcRel, dst)
      /* 撤销栈（2026-10-13 修，与 WorkbenchFileTree.doMove 对齐）：此前知识库侧栏这两条移动入口
         （拖拽 / 「将文件移动到…」）都不记 fileOpHistory，同一动作在工作台文件树里能 Ctrl+Z、
         在这里撤不回来 —— 铁律 5「撤销栈两个编辑区共用」要避免的正是这种不对称。 */
      recordFileOp({ kind: 'move', rootId: root, from: srcRel, to: dst, name })
      void refreshTreeDir(parentDirOf(srcRel)); void refreshTreeDir(targetDirRel)
      const page = allPages.find(p => p.path === srcRel)
      if (page) showToast({ type: 'info', message: `已移动「${name}」` })
    } catch { showToast({ type: 'error', message: '移动失败' }) }
  }, [allPages, categories, ensureVaultRoot, refreshTreeDir])

  /** 新建分类目录提交（Phase 2 批次 3 收尾）：顶层 mkdir + categories.json 登记（vault 白名单通道）。
   *  分类 = 目录（resolveCategoryIdByPath）：页面拖进该目录即归类。仅支持顶层（子目录层级 = 普通目录嵌套）。
   *  B-13：命名改走文件树内联输入后，本函数**不再自己收输入框**（原先第一行 setCatDraft(null) 已删），
   *  由 handleTreeCommitCreate 的 category 分流调用——树内联机制统一负责「收起输入行」这件事。 */
  const handleCommitCategory = useCallback(async (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    try {
      await createKnowledgeCategory({ name, parentId: null, categoryType: 'folder' })
      void refreshTreeDir('')
      refreshCategories()
      showToast({ type: 'info', message: `分类目录「${name}」已创建——把笔记拖进去即归类` })
    } catch (e) {
      console.error('[knowledge] create category failed:', e)
      showToast({ type: 'error', message: e instanceof Error ? e.message : '创建失败' })
    }
  }, [refreshTreeDir, refreshCategories])

  const handleTreeCommitCreate = useCallback(async (dirRel: string, type: CreateType, rawName: string) => {
    setTreeCreating(null)
    const name = rawName.trim()
    if (!name) return
    // 分类目录（B-13）：顶层 mkdir + categories.json 登记，走既有 handleCommitCategory。
    // ★ 必须先于 ensureVaultRoot 分流——handleCommitCategory 不走 vault 写通道，也不接受 dirRel
    //（分类恒落仓库根层，与树内联行渲染在哪个目录无关）。
    if (type === 'category') { await handleCommitCategory(name); return }
    const root = await ensureVaultRoot()
    if (!root) return
    const rel = dirRel ? `${dirRel}/${name}` : name
    try {
      if (type === 'knowledge') {
        // 新建知识页（Phase 2 批次 2）：frontmatter id 直接写入（randomUUID，与主进程同格式），
        // 索引重建后即成为正式页——文件名不带扩展名时补 .md
        const mdName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`
        const mdRel = dirRel ? `${dirRel}/${mdName}` : mdName
        const base = mdName.replace(/\.[^.]+$/, '')
        const id = crypto.randomUUID()
        await workspaceCreateFile(root, mdRel, `---\nid: ${id}\ntitle: ${base}\n---\n\n`)
        void refreshTreeDir(dirRel)
        void refreshAllPages()
        setTimeout(() => { void handleOpenPage(id, { title: base, fileType: 'md' }) }, 400)
        return
      }
      if (type === 'dir') await workspaceMkdir(root, rel)
      else await workspaceCreateFile(root, rel)
      void refreshTreeDir(dirRel)
      // 新建的 md 若未被索引收录（无 id 草稿），点开走编辑器兜底；有 id 由刷新后的索引接管
      void refreshAllPages()
    } catch (e) { console.error('[knowledge] tree create failed:', e); showToast({ type: 'error', message: '创建失败' }) }
  }, [ensureVaultRoot, refreshTreeDir, refreshAllPages, handleOpenPage, handleCommitCategory])

  /** 「＋」的落点（B-7 唯一真相源）：头部「＋」与 Ctrl+N 共用，避免两处各自推导再分叉。
   *  无选中目录 → 仓库根（等价于加此特性前 Ctrl+N 的固定行为）。
   *  读 ref 而非 state：恒等稳定的 useCallback（deps 为空）才能被模块级快捷键 effect 安全依赖。 */
  const treeLandDir = useCallback(() => selectedDirRelRef.current ?? '', [])

  /** 头部「＋」菜单项（B-7 拍板：就三项，不含「新建空文件」——那个仍在左栏右键菜单里）。
   *  「新建分类目录」恒落仓库根（分类 = 顶层容器，handleCommitCategory 是 parentId:null + 顶层 mkdir），
   *  所以选中子目录时补一个「根层」小字说明，而不是置灰（置灰会先被当成 bug）。 */
  const treeNewItems = useMemo<TreeNewMenuItem[]>(() => {
    const ic = 'shrink-0 text-[var(--text-muted)]'
    const atSubDir = !!selectedDirRel
    return [
      { key: 'knowledge', label: '新建知识页', icon: <FileText size={13} className={ic} /> },
      { key: 'dir', label: '新建目录', icon: <Folder size={13} className={ic} /> },
      { key: 'category', label: '新建分类目录', icon: <FolderTree size={13} className={ic} />, ...(atSubDir ? { note: '根层' } : {}) },
    ]
  }, [selectedDirRel])

  /** 「＋」选中类型 → 进既有内联输入，不新写创建逻辑（B-13 起分类目录也走这条路）。
   *  先确保落点目录展开：内联输入行渲染在目录子级里，目录收着的话输入框根本不可见（表现为"点＋没反应"）。 */
  const handleTreeNewPick = useCallback((key: string) => {
    // 分类目录恒落仓库根层（顶层 mkdir + categories.json 登记），落点不跟随选中目录
    if (key === 'category') { setTreeCreating({ dirRel: '', type: 'category' }); return }
    const dirRel = treeLandDir()
    if (dirRel) setExpandedDirs((prev) => (prev.has(dirRel) ? prev : new Set(prev).add(dirRel)))
    setTreeCreating({ dirRel, type: key as 'knowledge' | 'dir' })
  }, [treeLandDir])

  /**
   * 「新建知识页」的**跨模块入口**（2026-10-13）：桌面「新建」与命令面板都派发 `kb-editor-new-page`。
   * ★ 这个事件此前**没有监听端** —— 它原本由 2026-09-20 阶段四物理退役的「编辑器」模块注册，
   *   于是 desktop/index.tsx:203 那一下静默落空（桌面「新建」只完成「打开一页」、建页那步什么都不做），
   *   与 §44 记的 `Ctrl+Shift+S` 死键同一家族：**派发端还在、监听端随模块一起没了、零报错**。
   * 动作本体复用文件树「＋」的 handleTreeNewPick，不另写一份创建逻辑（读写分工铁律：
   * 建页的写入只发生在编辑器/文件树这一条通道）。
   */
  useEffect(() => {
    const onNewPage = (): void => handleTreeNewPick('knowledge')
    window.addEventListener('kb-editor-new-page', onNewPage)
    return () => window.removeEventListener('kb-editor-new-page', onNewPage)
  }, [handleTreeNewPick])

  /**
   * 两条「模块内命令」的跨模块入口（2026-10-13，L2 第三批）：命令面板派发这两个事件。
   * 动作直接复用既有回调（handleCloseTab / enterReading），不新写逻辑 —— 与前两批
   * （kb-editor-new-page / blog-new-entry / schedule-new-task）同一手法。
   * 门控在调用方：真源里这两条都要求 activeTab === 'knowledge'，故本监听端不再自查。
   */
  useEffect(() => {
    const onCloseTab = (): void => {
      const id = activePageIdRef.current
      if (id) handleCloseTab(id)
    }
    const onImmersive = (): void => { void enterReading() }
    window.addEventListener('kb-close-active-tab', onCloseTab)
    window.addEventListener('kb-toggle-immersive', onImmersive)
    return () => {
      window.removeEventListener('kb-close-active-tab', onCloseTab)
      window.removeEventListener('kb-toggle-immersive', onImmersive)
    }
  }, [handleCloseTab, enterReading])

  // 选中目录只在「知识库文件视图」语境下有意义：进空间 / 图谱态即清空（B-7）
  useEffect(() => {
    if (selectedSpaceId || graphMode) setSelectedDirRel(null)
  }, [selectedSpaceId, graphMode])

  /** 删除树条目后关闭其下已打开的页签（force：磁盘文件已不存在，无需未保存确认） */
  const closeTabsUnder = useCallback((relPath: string) => {
    const prefix = relPath + '/'
    for (const id of [...openPageIdsRef.current]) {
      const rel = id.startsWith('draft:') ? id.slice('draft:'.length) : allPages.find((p) => p.id === id)?.path
      if (rel && (rel === relPath || rel.startsWith(prefix))) forceCloseTab(id)
    }
  }, [allPages, forceCloseTab])

  /** 文件树条目删除（B-2）：目录按性质分流，删完关闭其下页签并刷新父目录。
   *  - **分类目录**（categories.json 有登记，path 命中）→ `deleteKnowledgeCategory`：同步清登记，
   *    否则走回收站会在 categories.json 留下指向不存在目录的脏条目；
   *  - **普通目录 / 任意文件** → `workspaceTrash`：直接移入系统回收站。
   *  ★ 不记入撤销栈：删除走系统回收站，程序内无 restore 通道（fileOpHistory 头注）。
   *  动画键用 `relPath`——VaultTree 的行以 relPath 为键（分类树那边才是 categoryId）。 */
  const handleTreeDelete = useCallback(async (node: TreeNode) => {
    const root = await ensureVaultRoot()
    if (!root) return
    const name = node.relPath.slice(node.relPath.lastIndexOf('/') + 1)
    const isDir = node.type === 'dir'
    const catId = isDir ? (categories.find((c) => c.path === node.relPath)?.id ?? null) : null

    if (catId) {
      if (!(await confirmVaultCategoryDelete(catId))) return
    } else {
      const ok = await showGlobalConfirm({
        title: isDir ? '删除目录' : '删除文件',
        message: isDir
          ? `目录「${name}」及其下全部内容将一并移入系统回收站。确定删除吗？`
          : `「${name}」将移入系统回收站。确定删除吗？`,
        confirmLabel: '删除',
        cancelLabel: '取消',
        variant: 'danger',
      })
      if (ok !== true) return
    }

    await deleteWithAnimation(node.relPath, async () => {
      if (catId) await deleteKnowledgeCategory(catId)
      else {
        const res = await workspaceTrash(root, node.relPath)
        if (!res.ok) throw new Error(res.error || '删除失败')
      }
      // 删除连带关闭该路径下的页签（关内容 ≠ 关标签：现在清零也不再自动关模块标签）
      closeTabsUnder(node.relPath)
    })
    // 树刷新放到动画整段走完之后（deleteWithAnimation 内部先播收尾淡出再返回，与 NotebookList
    // 同一节奏）——若放进 fn 里，目录重扫会赶在淡出播放前就把条目从树上摘掉，收尾动画看不到。
    // 丢弃被删目录自身的缓存（其子缓存随之失效，展开时按需重拉）
    setDirCache((prev) => { const n = { ...prev }; delete n[node.relPath]; return n })
    void refreshTreeDir(parentDirOf(node.relPath))
  }, [ensureVaultRoot, categories, confirmVaultCategoryDelete, deleteWithAnimation, closeTabsUnder, refreshTreeDir])

  /* ===== ⋮ 的文件级动作（2026-10-13 批 1b「页面菜单能力补齐」）=====
     PageEditor 只发请求、自己不动盘：这几个动作会改仓库相对路径或动页签，必须由模块层统一
     —— 刷树 / 刷 allPages / 记撤销栈 / 连带关页签全在既有那几个 handleTreeXxx 里。
     重命名与移动**直接复用** handleTreeRename / handleTreeMove（下一段就是），这里只补三个按
     relPath 的落点。 */

  /** ⋮「删除」落点：复用文件树那条（系统回收站 + 危险确认 + 连带关页签）。
   *  ★ 构造一个只带 relPath / type 的 TreeNode —— handleTreeDelete 只读这两个字段
   *    （取 name、判 isDir），不需要完整的工作区条目字段。 */
  const handleDeleteByRel = useCallback((rel: string) => {
    if (!rel) return
    void handleTreeDelete({ relPath: rel, type: 'file' } as TreeNode)
  }, [handleTreeDelete])

  /** ⋮「创建副本」落点：与文件树右键同一通道（duplicateWorkspaceFile），刷父目录让副本立刻出现。
   *  ★ 不自动打开副本 —— 与文件树右键行为一致。 */
  const handleDuplicateByRel = useCallback(async (rel: string) => {
    if (!rel) return
    const root = await ensureVaultRoot()
    if (!root) return
    const r = await duplicateWorkspaceFile(root, rel).catch(() => null)
    if (!r || r.ok === false) { showToast({ type: 'error', message: r?.error || '创建副本失败' }); return }
    void refreshTreeDir(parentDirOf(rel))
    showToast({ type: 'info', message: `已生成副本 ${r.relPath?.split('/').pop() ?? ''}` })
  }, [ensureVaultRoot, refreshTreeDir])

  /** ⋮「在文件列表中显示当前文件」：切到文件视图 + 展开全部祖先目录 + 滚进视野。
   *  树是纯 props 驱动（VaultTree），行上有 `data-wb-tree-path` 锚点 —— 这里只驱动宿主的
   *  expandedDirs 与滚动，**不动树组件本身**。
   *  ★ 两帧后才滚：目录展开是异步的（子目录懒加载 + setState），当帧行还没渲染出来。
   *  ★ 找不到就给一句提示 —— 不静默（可能是 .ignore 规则收起了这一条）。 */
  const handleLocateInTree = useCallback((rel: string) => {
    if (!rel) return
    setSidebarTab('files')
    const parts = rel.split('/')
    const dirs = ['']
    for (let i = 1; i < parts.length; i++) dirs.push(parts.slice(0, i).join('/'))
    setExpandedDirs(prev => new Set([...prev, ...dirs]))
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-wb-tree-path="${CSS.escape(rel)}"]`)
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      else showToast({ type: 'warning', message: '文件列表里没找到这一条（可能被 .ignore 规则收起）' })
    }))
  }, [])

  /** 文件树重命名（B-2 同批补）：workspaceRename + 记入撤销栈（重命名属「移动」语义，
   *  与 moveVaultPath 同一通道，Ctrl+Z 可撤回）。成功后刷新父目录并通知编辑器侧树同步。 */
  const handleTreeRename = useCallback(async (relPath: string, rawName: string) => {
    setTreeRenaming(null)
    const name = rawName.trim()
    if (!name) return
    const curName = relPath.slice(relPath.lastIndexOf('/') + 1)
    if (name === curName) return
    const root = await ensureVaultRoot()
    if (!root) return
    const dir = parentDirOf(relPath)
    // F-13：分类目录改名必须走分类通道（vaultRenameCategory 级联 name/path 与子孙 path、
    // 并失效重建索引让页面归类跟着变）；纯 fs 改名不碰 categories.json ⇒ 归类失效 + 脏条目。
    const catHit = categories.find((c) => c.path === relPath)
    if (catHit) {
      try {
        await updateKnowledgeCategory(catHit.id, { name })
        void refreshTreeDir(dir)
        void refreshAllPages()
        refreshCategories()
        showToast({ type: 'info', message: `已重命名为「${name}」` })
      } catch (e) {
        showToast({ type: 'error', message: e instanceof Error ? e.message : '重命名失败' })
      }
      return
    }
    const nextRel = dir ? `${dir}/${name}` : name
    try {
      const res = await workspaceRename(root, relPath, nextRel)
      if (!res.ok) { showToast({ type: 'error', message: res.error || '重命名失败' }); return }
      recordFileOp({ kind: 'move', rootId: root, from: relPath, to: nextRel, name })
      void refreshTreeDir(dir)
      void refreshAllPages()
      showToast({ type: 'info', message: `已重命名为「${name}」` })
    } catch (e) {
      showToast({ type: 'error', message: e instanceof Error ? e.message : '重命名失败' })
    }
  }, [categories, ensureVaultRoot, refreshTreeDir, refreshAllPages, refreshCategories, updateKnowledgeCategory])


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
      window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: p.path, from: 'knowledge' } }))
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

  /** 复制路径的**核心**（2026-10-12 抽出）：rel → 剪贴板；abs 时前缀仓库根。
   *  两个消费方：分类树 / 笔记本的 handleCopyPath（按 id 找 rel）、文件树右键的「复制路径 ▸」（直接有 rel）。
   *  ★ 顺手统一到主进程剪贴板通道 `copyText` —— 批 1 定的口径是「渲染层不直连 navigator.clipboard」。 */
  const copyPathText = useCallback(async (rel: string, mode: 'abs' | 'rel') => {
    if (!rel) { showToast({ type: 'warning', message: '该条目暂无仓库文件路径（历史数据）' }); return }
    try {
      let text = rel
      if (mode === 'abs') {
        const cur = await workspaceGetCurrent()
        if (!cur?.path) { showToast({ type: 'error', message: '未打开仓库' }); return }
        text = `${cur.path.replace(/\\/g, '/')}/${rel}`
      }
      const ok = await copyText(text)
      if (!ok) { showToast({ type: 'error', message: '复制失败' }); return }
      showToast({ type: 'info', message: mode === 'abs' ? '已复制完整路径' : '已复制仓库相对路径' })
    } catch { showToast({ type: 'error', message: '复制失败' }) }
  }, [])

  /** 复制条目路径（vault：页面/目录均为仓库内文件；abs=含仓库根的绝对路径） */
  const handleCopyPath = useCallback(async (type: 'category' | 'page', id: string, mode: 'abs' | 'rel') => {
    const rel = type === 'page'
      ? (allPages.find((x) => x.id === id)?.path ?? '')
      : (categories.find((x) => x.id === id)?.path ?? '')
    await copyPathText(rel, mode)
  }, [allPages, categories, copyPathText])

  /** 文件树右键「使用默认应用打开 / 在系统资源管理器中显示」（2026-10-12）：
   *  与批 2 非 md 顶栏 ⋮ 的 handleArchiveOpenInSystem 走**同一个主进程通道**（workspaceOpenInSystem），
   *  不新开能力面。 */
  const openTreeInSystem = useCallback(async (rel: string, reveal: boolean) => {
    const root = await ensureVaultRoot()
    if (!root) return
    const res = await workspaceOpenInSystem(root, rel, reveal)
    if (!res?.ok) showToast({ type: 'error', message: res?.error || '打开失败' })
  }, [ensureVaultRoot])

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
      // Alt+← / Alt+→ —— 顶栏「页面历史」的键盘入口（2026-10-11 拍板 D2）。
      // 刻意放在 isEditingInput 守卫**之前**：带 Alt 的方向键不是文本编辑操作，在编辑器里也该生效；
      // preventDefault 同时挡掉 Chromium 自带的「Alt+← 后退」（否则会变成窗口级历史跳转）。
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        navStep(e.key === 'ArrowLeft' ? -1 : 1)
        return
      }

      if (isEditingInput(e)) return

      // Ctrl+N — 新建知识页：文件树内联创建（Phase 2 批次 2：frontmatter id 直接写入，不再借道编辑器）
      // 落点自 B-7 起跟随「选中目录」（原为恒落仓库根）。动作与文件树「＋」、桌面「新建」、
      // 命令面板**共用 handleTreeNewPick 一处**（原先这里内联三行，与「＋」是同一动作的两份实现）
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        handleTreeNewPick('knowledge')
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
  }, [handleCloseTab, handleDeleteChapter, handleDeleteNotebook, handlePageDeleted, handleCopy, handleCut, handlePaste, readingMode, enterReading, exitReading, treeLandDir, navStep, handleTreeNewPick])

  // ---- 外部文件粘贴（2026-09-20 阶段四：能力自编辑器模块上移，随其退役）----
  // 资源管理器里 Ctrl+C 文件 → 本模块 Ctrl+V：剪贴板带 File 列表且没有文本接收方时接管，
  // 落到当前文件所在目录（无激活文件 = 仓库根）。文本粘贴原样放行（hasTextPasteTarget 判定）。
  const pasteExternalFiles = useCallback(async (files: File[], dirRel: string) => {
    const root = vaultRootRef.current
    if (!root || files.length === 0) return
    const srcPaths: string[] = []
    for (const f of files) {
      try { const p = getPathForFile(f); if (p) srcPaths.push(p) } catch { /* 取不到路径的条目丢弃 */ }
    }
    if (srcPaths.length === 0) return
    try {
      const res = await workspacePasteExternal(root, dirRel, srcPaths)
      if (res.pasted.length === 0) {
        // 全失败时把**具体原因**带出来：主进程只在循环走完却一项没成功时不给 reason，
        // 此时第一条 skipped 的原因（越界/符号链接/权限…）才是用户能据此行动的信息
        showToast({
          type: 'warning',
          message: res.reason === 'empty'
            ? '剪贴板里没有可粘贴的文件'
            : `粘贴失败：${res.error || res.skipped[0]?.reason || '未知原因'}`,
        })
        return
      }
      if (res.pasted.some((n) => n.toLowerCase().endsWith('.md'))) {
        notifyDataChanged('knowledge') // 让本模块与保活模块重读（md 会影响列表/图谱）
      }
      const skippedNote = res.skipped.length > 0 ? `，已跳过 ${res.skipped.length} 项` : ''
      showToast({
        type: res.skipped.length > 0 ? 'warning' : 'success',
        message: res.pasted.length === 1
          ? `已粘贴「${res.pasted[0]}」${skippedNote}`
          : `已粘贴 ${res.pasted.length} 项${skippedNote}`,
      })
    } catch (e) {
      showToast({ type: 'error', message: `粘贴失败：${(e as Error).message}` })
    }
  }, [])

  /** 粘贴落点：右键的那个目录 > 最近点中的目录 > 当前打开文件所在目录 > 仓库根 */
  const resolvePasteDir = useCallback((node?: TreeNode | null): string => {
    if (node) return node.type === 'dir' ? node.relPath : parentDirOf(node.relPath)
    if (lastTreeDirRef.current) return lastTreeDirRef.current
    // activePageId 可能是 draft:<rel> 伪页，两种都取真实 relPath
    const active = allPages.find((p) => p.id === activePageIdRef.current)
    const activeRel = active?.path ?? (activePageIdRef.current?.startsWith('draft:') ? activePageIdRef.current.slice(6) : null)
    return activeRel && activeRel.includes('/') ? activeRel.slice(0, activeRel.lastIndexOf('/')) : ''
  }, [allPages])

  /**
   * 右键「粘贴」：Ctrl+V 有真实 paste 事件（clipboardData 带 File 列表），菜单点击是合成动作
   * 拿不到，所以先聚焦文件树再请主进程补发一次 `webContents.paste()`，复用同一条链路。
   * 必须等 React 把菜单卸载完再聚焦——被卸载的菜单是当时 focused 元素，先聚焦会被它的
   * blur 打回 body，粘贴就落到别处去了（故走 rAF 等这一帧提交结束）。
   */
  const requestPasteFromMenu = useCallback((dirRel: string) => {
    lastTreeDirRef.current = dirRel
    requestAnimationFrame(() => {
      treeRef.current?.focus()
      void pasteFromClipboard()
    })
  }, [])

  useEffect(() => {
    if (!isActive) return
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return
      if (hasTextPasteTarget(e)) return
      e.preventDefault()
      void pasteExternalFiles(Array.from(files), resolvePasteDir())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [isActive, pasteExternalFiles, resolvePasteDir])

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
  // 左栏停在大纲页时，激活页面切到非 md（或无页面）→ 自动回落文件树
  useEffect(() => {
    if (sidebarTab !== 'outline') return
    const ft = activePageId ? openPageInfos[activePageId]?.fileType : undefined
    if (ft !== 'md') setSidebarTab('files')
  }, [sidebarTab, activePageId, openPageInfos])
  /** 页面条可见性上报（2026-09-19，App 全关判定用）：有停靠页面才可见；quiz 条目由 App 侧 quizViewOpen 单独判 */
  const onStripVisibleRef = useRef(onStripVisibleChange)
  onStripVisibleRef.current = onStripVisibleChange
  useEffect(() => { onStripVisibleRef.current?.(openPageIds.length > 0) }, [openPageIds.length])

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

  // 身份统一后（2026-09-20 §2）：草稿态退役 —— 「draft 引用虚化」整条链（图谱 status → 正文渲染）已删除

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
    const hit = allPages.find(p => p.title === t)
    if (hit) void openInReading(hit.id)
    else showToast({ type: 'warning', message: `未找到「${t}」` })
  }, [allPages, openInReading])

  /**
   * 沉浸态左栏大纲的标题点击（2026-09-27）。
   *
   * 非沉浸态那条链是 `outline:go-to-heading` → **PageEditor（Monaco）**消费；沉浸态正文是
   * `MarkdownPreview`，**没有 Monaco**，故无人消费该事件 ⇒ 必须自带一个消费者。
   * `MarkdownPreview` 已给每个标题渲染 `id={headingId(text)}`（与 OutlinePanel 的 `parseHeadings`
   * 同一份生成规则），所以直接按 id `scrollIntoView` 即可，**不需要新增锚点**。
   * 找不到 id（正文与大纲瞬时不同步，如刚切换页面）时静默忽略 —— 不弹错，避免噪音。
   */
  useEffect(() => {
    if (!readingMode) return
    const on = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined
      if (!id || !readingScrollRef.current) return
      const el = readingScrollRef.current.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    window.addEventListener('outline:go-to-heading', on)
    return () => window.removeEventListener('outline:go-to-heading', on)
  }, [readingMode])

  return (
    <ImportZone onImport={handleDropImport} onImportPdf={handleDropImportBinary} onImportFolders={handleDropImportFolders} className="h-full">
      <div className="kb-theme-surface flex h-full flex-col">
        {readingMode ? (
          /* ===== 沉浸阅读：只保留正文（进场淡入；可能含 iframe/PDF，故只做透明度、不做位移） =====
             ★ F-7（2026-09-27）：本容器必须是 **flex 列 + `min-h-0`**，滚动区用 `flex-1 min-h-0`。
             `min-h-0` 不是装饰 —— flex item 默认 `min-height: auto` 会被内容撑破（铁律 11），
             于是这条链拿不到「容器高」而是被内容顶成「内容高」，内层滚动区随之无处可滚：
             表象正是用户报的「沉浸式阅读下页面不能向下滑动」。
             三条子分支都靠这条链拿高度：md 正文（自带滚动区）· WelcomeHtmlView（wrapper `flex-1`）
             · FileMetaCard（根 `flex-1`）—— 容器一旦不是 flex 列，后两者的 `flex-1` 直接变成死属性。
             判据与验证：tmp/probe-f7-immersive.mjs（Chromium 逐字复刻三条分支的类名 + 修复形态对照）。 */
          <div className="kb-view-fade flex flex-1 min-h-0 min-w-0 flex-col relative">
            {/* 沉浸态左栏大纲（2026-09-27 需求 + 拍板①②）。
                为什么必须在这里单独渲染一份：整块内容区（含非沉浸态那份 `sidebarInner` 的
                portal）挂在下方 `readingMode ? … : …` 三元**之外的分支**里 —— 沉浸态压根不走那支，
                左栏 slot 于是全空（用户实机截图：只剩 🏠🔒 头部，内容区一片空白）。
                故沉浸态自带一份大纲，仍 portal 进同一个 `sidebarEl`（挂载点不变、状态留在本组件）。
                刻意**不带**「文件 | 大纲」切换行：拍板①「只放大纲」= 纯净；拍板③由此自动满足。
                `sidebarEl` 为 null（未托管 / 左栏收起）时不渲染，与非沉浸态的显隐口径一致。 */}
            {readingMode && sidebarEl && immersiveTabOverride === 'outline' && createPortal(
              <div className="kb-view-in flex min-h-0 flex-1 flex-col" data-wb="immersiveOutline">
                <OutlinePanel
                  pageTitle={readingPage?.title || '无标题'}
                  headings={outlineHeadings}
                  /* 沉浸态无「文件树」可回（切换行按拍板①不渲染）—— 传空实现保住 props 契约 */
                  onBackToFile={() => { /* 沉浸态不提供返回文件视图，退出沉浸即可 */ }}
                  embedded
                />
              </div>,
              sidebarEl,
            )}
            {/* 顶部悬停退出区（平时隐形）。★ data-wb 是给「导出 PDF」的打印样式用的：
                导出会临时进沉浸态打印，这一条热区若不打掉就会在 PDF 顶部印出一个「退出阅读」条。 */}
            <div
              data-wb="immersiveExitZone"
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
              /* 归档非 md 文件（全类型归档 D1/D2）：
                 · html → 沙箱渲染
                 · 文本类 → **只读文本视图**（批 1 修，2026-10-12）
                 · 其余（二进制 / 超大 / 未识别）→ 元信息卡
                 ★ 为什么要修：`enterReading` 明确放行 md / txt / html（见其内注释与那条
                 「沉浸阅读仅支持 md / txt 页面」的提示），而这里原先对**所有** entryKind==='file'
                 一律元信息卡 ⇒ 打开仓库里一个 `.txt` 再进沉浸阅读，屏幕上跳出的是一张
                 「该文件不是 markdown 知识页，知识库中仅展示元信息」的卡。无竞态、必现。
                 与 PageEditor 的内容分支同一处根因（归档兜底遮蔽了专门视图），故同批一起收口。 */
              (readingPage.fileType || '').toLowerCase() === 'html' && readingPage.path ? (
                <WelcomeHtmlView path={readingPage.path} />
              ) : readingPage.path && isRenderableImageExt(readingPage.fileType || '') ? (
                /* 图片（批 3，2026-10-13）：与笔记区同一个查看器，只是控件从顶栏槽退成浮条。
                   ★ 顺序在文本类之前：图片扩展名不在 TEXT_VIEWABLE_EXT_SET 里，两者本不重叠，
                   但把「专门视图优先」这条口径写死在这里，将来若有人把 svg 加进那个集合，
                   也不会出现「SVG 在沉浸态变成一坨 XML 文本」。 */
                <ImmersiveImageView
                  relPath={readingPage.path}
                  name={readingPage.title}
                  sizeBytes={readingPage.sizeBytes}
                  updatedAt={readingPage.updatedAt}
                  onOpenInSystem={() => { void openTreeInSystem(readingPage.path as string, false) }}
                  onRevealInFolder={() => { void openTreeInSystem(readingPage.path as string, true) }}
                />
              ) : readingPage.path && isTextViewableExt((readingPage.fileType || '').toLowerCase()) ? (
                <ArchiveTextView
                  path={readingPage.path}
                  fileType={(readingPage.fileType || '').toLowerCase()}
                  fontSize={Math.round(15 * zoom)}
                />
              ) : (
                <FileMetaCard title={readingPage.title} fileType={readingPage.fileType || ''} path={readingPage.path} updatedAt={readingPage.updatedAt} sizeBytes={readingPage.sizeBytes} />
              )
            ) : readingPage && (readingPage.fileType || '').toLowerCase() === 'html' ? (
              /* 欢迎页（唯一放行的 HTML）：整页沙箱渲染，不走 720px 阅读排版 */
              <WelcomeHtmlView path={readingPage.path || '欢迎.html'} />
            ) : (
            <div ref={readingScrollRef} className="flex-1 min-h-0 overflow-y-auto">
              <div className="max-w-[720px] mx-auto px-10 py-14" style={{ fontSize: '15px', lineHeight: 1.9 }}>
                <h1 className="text-[26px] font-bold leading-snug mb-6">{readingPage?.title || '无标题'}</h1>
                {/* P1 附件条：PDF/无扩展名附件 → 在阅读器中打开（kb-open-note → 编辑器 PdfReaderView）；图片灰显 */}
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
              items={openPageIds.filter((pid) => !secondaryPageIds.includes(pid)).map((id) => {
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
              /* 单激活（2026-09-20 深层修复）：错题本视图打开时本模块当前视图是错题本，
                 页签条目全部转非激活——激活态只落在页面条「错题本」条目上（App quizEntryActive）。
                 此前页签照常高亮 + 错题本条目也高亮 = 双激活，看起来像同时开了两个页面。
                 ★ 2026-09-26 F-8 二修：再并入「模块是不是前台标签」。**activePageId 是模块内部
                 概念**（当前打开的是哪一页），不表达「知识库是不是前台」——人在别的标签页时
                 页签组仍按 activePageId 高亮，零散页面看着像打开状态（用户报障）。
                 判据用模块已有的 isActive prop（App 传 `on = t === activeTab`），不新造通道。 */
              activeId={!isActive || showQuizCollection ? null : activePageId}
              onSelect={(id) => {
                void handleOpenPage(id)
                // 页签组恒挂在页面条上（其他模块激活时也可见），点击 = 要看那个页面：
                // 通知 App 把 knowledge 标签带到前台 + 左栏跟随（状态在模块、激活在 App，
                // 同 onPageTabActivate 这类「模块内事件 → App 收口」的回调范式；2026-09-20 反馈「点笔记页签不跳笔记区」）
                onPageTabActivate?.()
              }}
              onClose={handleCloseTab}
              onReorder={handleReorderTabs}
              onTogglePin={handleTogglePin}
              onContextMenu={(e, id) => handleTabContextMenu(e, id)}
              onExternalDrop={(id) => onRemoveSecondary?.(id)}
            />
          )
          // 副栏页签条（被挪到副栏的页面）：portal 进 App 副栏段槽
          const itemFor = (id: string) => {
            const info = openPageInfos[id]
            const pinned = pinnedPageIds.has(id) || dirtyPageIds.has(id)
            return { id, title: info?.title || '加载中…', preview: !pinned, pinned, badge: info?.fileType ? getFileTypeInfo(info.fileType).badge : undefined }
          }
          const secItems = secondaryPageIds.filter((id) => openPageIds.includes(id)).map(itemFor)
          const secondaryStrip = (secondaryBarEl && secItems.length > 0) ? createPortal(
            <PageTabStrip
              owner="knowledge"
              itemAttr="data-tab-id"
              items={secItems}
              activeId={secondaryActiveId}
              onSelect={(id) => { onSecondaryActivate?.(id); onPageTabActivate?.() }}
              onClose={(id) => onRemoveSecondary?.(id)}
              onExternalDrop={(id) => onMovePageToPane?.(id)}
            />, secondaryBarEl,
          ) : null
          const mainEl = pageBarHosted
            ? (pageBarEl ? createPortal(strip, pageBarEl) : null)
            : (
              <div className="flex h-9 shrink-0 items-center border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">{strip}</div>
              </div>
            )
          return <>{mainEl}{secondaryStrip}</>
        })()}
        <div className="kb-view-fade flex min-h-0 flex-1">
        {/* L1: File / Outline tabs — file tab drills into ChapterPanel when a notebook is selected */}
        {/* v3.4.0 批次3：左栏模块态（sidebarEl 由 App 传入）时，侧栏内容 portal 进左栏 slot —— 挂载点迁移
            而非复制渲染，全部状态留在本组件（方案 §7 风险2）。否则回落原位 ResizablePanel。
            两形态显隐一致：portal 传 null ⇔ ResizablePanel visible=false 不渲染 children；
            且 sidebarEl 形态下 ResizablePanel 整体不渲染，模块中间区不再残留收起边条。 */}
        {/* 头部「＋」新建（B-7）：同槽 portal，且**排在聚焦按钮之前**——portal 目标同一容器时
            DOM 顺序 = 渲染顺序，于是「＋」在聚焦按钮左侧（动作在前、开关在后）。
            显隐口径与聚焦按钮完全一致（非知识库形态 / 选中空间 / 图谱态均不渲染）。 */}
        {modActionsEl && sidebarVariant === 'knowledge' && !selectedSpaceId && !graphMode && createPortal(
          <TreeNewButton items={treeNewItems} onPick={handleTreeNewPick} title="新建知识页 / 目录 / 分类目录" />,
          modActionsEl,
        )}
        {/* 排序 + 全部展开/关闭（2026-10-11）：同槽 portal，排在「＋」之后、聚焦按钮之前；
            显隐口径与聚焦按钮完全一致（非知识库形态 / 选中空间 / 图谱态不渲染） */}
        {modActionsEl && sidebarVariant === 'knowledge' && !selectedSpaceId && !graphMode && createPortal(
          <button
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setSortMenuPos({ x: r.left, y: r.bottom + 6 }) }}
            title="排序方式"
            data-wb="kbTreeSortBtn"
            className={`rounded p-1 transition-colors ${sortMenuPos ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
          >
            {(treeSort === 'name-desc' || treeSort === 'mtime-desc')
              ? <ArrowDownNarrowWide {...SIDEBAR_HEADER_ICON} />
              : <ArrowUpNarrowWide {...SIDEBAR_HEADER_ICON} />}
          </button>,
          modActionsEl,
        )}
        {modActionsEl && sidebarVariant === 'knowledge' && !selectedSpaceId && !graphMode && createPortal(
          <TreeExpandButton
            expanded={treeSubtreeExpanded}
            onClick={toggleTreeSubtree}
            dataWb="kbTreeSubtreeBtn"
            title={treeSubtreeExpanded
              ? (selectedDirRel ? '收起此目录（含子目录）' : '全部关闭')
              : (selectedDirRel ? '展开此目录（含子目录）' : '展开全部（含子目录）')}
          />,
          modActionsEl,
        )}
        {/* 聚焦按钮上移（2026-09-19 反馈）：portal 到左栏模块态头部动作槽；2026-10-11 起排在**最后＝最右**。
            与侧栏同显隐口径：非知识库形态（quiz）/选中空间（行原本就不显示）/图谱态不渲染 */}
        {modActionsEl && createPortal(
          sidebarVariant === 'knowledge' && !selectedSpaceId && !graphMode ? (
            <FolderFocusButton
              on={!!settings.knowledgeFolderFocus}
              onToggle={() => updateSettings('knowledgeFolderFocus', !settings.knowledgeFolderFocus)}
            />
          ) : null,
          modActionsEl,
        )}
        {sortMenuPos && (
          <FileContextMenu
            x={sortMenuPos.x}
            y={sortMenuPos.y}
            onClose={() => setSortMenuPos(null)}
            items={TREE_SORT_OPTIONS.map((o) => ({
              key: o.value,
              label: o.label,
              icon: treeSort === o.value ? <Check size={15} /> : <span className="inline-block w-[15px]" />,
              onSelect: () => changeTreeSort(o.value),
            }))}
          />
        )}
        {(() => {
          const sidebarInner = (
          <div className="flex flex-col h-full" style={sidebarItemVars as unknown as React.CSSProperties}>
            {/* 「笔记」标题行已删（2026-09-19 反馈）：聚焦按钮上移到左栏模块态头部最右（modActionsEl portal），
                侧栏直接从文件树开始，少占一行 */}

            {/* 文件 | 大纲 切换行（2026-09-19 反馈恢复旧版）：md 页面才有大纲，非 md 激活时禁用并自动回落文件树 */}
            {(() => {
              const activeIsMd = !!activePageId && openPageInfos[activePageId]?.fileType === 'md'
              const tabCls = (on: boolean) =>
                `flex flex-1 items-center justify-center gap-1 rounded px-1 py-1 text-[11px] transition-colors ${
                  on ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`
              return (
                <div className="mx-1.5 mt-1.5 flex shrink-0 items-center gap-0.5 rounded-md border border-[var(--border-color)] p-0.5">
                  <button onClick={() => setSidebarTab('files')} className={tabCls(sidebarTab === 'files')} title="文件">
                    <FolderTree size={12} /><span>文件</span>
                  </button>
                  <button
                    onClick={() => { if (activeIsMd) setSidebarTab('outline') }}
                    disabled={!activeIsMd}
                    className={`${tabCls(sidebarTab === 'outline')} ${activeIsMd ? '' : 'cursor-default opacity-40 hover:bg-transparent'}`}
                    title={activeIsMd ? '大纲' : '大纲（仅 md 页面可用）'}
                  >
                    <ListTree size={12} /><span>大纲</span>
                  </button>
                </div>
              )
            })()}
            {/* 文件视图（Phase 2 批次 1，B 方案）：VaultTree = 与编辑区同一份实现；草稿/非 md 暂由编辑器模块兜底打开。
                2026-09-19：包进「文件 | 大纲」切换——大纲页 = OutlinePanel（embedded），数据走 outlineHeadings（liveContent） */}
            {sidebarTab === 'files' ? (
              <div className="kb-view-in relative flex flex-1 min-h-0 flex-col">
                <VaultTree
                  rootRef={treeRef}
                  dirCache={dirCache}
                  expanded={expandedDirs}
                  sort={treeSort}
                  activePath={allPages.find(p => p.id === activePageId)?.path ?? (activePageId?.startsWith('draft:') ? activePageId.slice(6) : null)}
                  onToggleDir={(p) => { lastTreeDirRef.current = p; handleToggleTreeDir(p) }}
                  onOpenFile={(n) => { lastTreeDirRef.current = parentDirOf(n.relPath); handleTreeOpenFile(n) }}
                  /* 目录聚焦（2026-09-19 修复失效）：VaultTree 迁移（Phase 2 批次 1）后一直没接
                     focusOn——按钮只是空开关。与编辑器同款：focusOn + onFocusLocate（点骨架条
                     = 退出聚焦并展开目录 / 打开文件）。 */
                  focusOn={!!settings.knowledgeFolderFocus}
                  onFocusLocate={(rel, isDir) => {
                    updateSettings('knowledgeFolderFocus', false)
                    if (isDir) setExpandedDirs((prev) => new Set(prev).add(rel))
                    else openByRelPath(rel)
                  }}
                  onContextMenu={(e, node) => {
                    e.preventDefault()
                    // 记下这次右键落点：Ctrl+V 与菜单「粘贴」都用它当落点（见 resolvePasteDir）
                    lastTreeDirRef.current = resolvePasteDir(node)
                    setTreeMenu({ x: e.clientX, y: e.clientY, node })
                  }}
                  onMove={(src, target) => { void handleTreeMove(src, target) }}
                  creating={treeCreating}
                  onCommitCreate={handleTreeCommitCreate}
                  onCancelCreate={() => setTreeCreating(null)}
                  /* 选中目录（B-7）：头部「＋」/ Ctrl+N 的落点来源。点目录行或点文件行（其父目录）都会上报，
                     受控——树本身不持选中态 */
                  selectedPath={selectedDirRel}
                  onSelectDir={(rel) => { setSelectedDirRel(rel); setTreeSubtreeExpanded(false) }}
                  renaming={treeRenaming}
                  onCommitRename={(rel, name) => { void handleTreeRename(rel, name) }}
                  onCancelRename={() => setTreeRenaming(null)}
                  deletingMap={deletingMap}
                />
                {/* B-13（2026-09-21 拍板）：原「新建分类目录」的居中浮层（`catDraft` 通道）**已整体删除**，
                    命名合并进文件树内联输入——与新建知识页/目录/文件同一机制，即 VS Code 式。
                    分类目录语义不变：顶层 mkdir + categories.json 登记，**恒落仓库根层**
                    （所以它的内联输入行固定在根层末尾，不跟随选中目录，头部「＋」菜单项也已标「根层」）。 */}
                {treeMenu && (
                  <FileContextMenu
                    x={treeMenu.x}
                    y={treeMenu.y}
                    onClose={() => setTreeMenu(null)}
                    items={(() => {
                      const node = treeMenu.node
                      const dirRel = node.type === 'dir' ? node.relPath : parentDirOf(node.relPath)
                      // 条目自身动作（B-2）：根容器（relPath === ''）是虚拟节点，没有删除/重命名语义
                      const self = node.relPath !== '' ? node : null
                      const items: FileMenuEntry[] = []

                      /* ---- 文件条目（2026-10-12 对齐 Obsidian，docs/file-menu-rework-design.md）----
                         只放「对这个文件做什么」：「新建 / 粘贴」已移走，只留**文件夹条目与空白处**
                         （Obsidian 同款口径）。Obsidian 那 13 项里本轮做 8 项，其余 4 项已拍板不做。 */
                      if (self && self.type === 'file') {
                        items.push({ key: 'open', label: '打开', icon: <FileText size={15} />, onSelect: () => handleTreeOpenFile(node) })
                        items.push({ separator: true })
                        items.push({
                          key: 'dup', label: '创建副本', icon: <CopyPlus size={15} />,
                          onSelect: () => {
                            void (async () => {
                              const root = await ensureVaultRoot()
                              if (!root) return
                              const r = await duplicateWorkspaceFile(root, self.relPath).catch(() => null)
                              if (!r || r.ok === false) { showToast({ type: 'error', message: r?.error || '创建副本失败' }); return }
                              void refreshTreeDir(parentDirOf(self.relPath))
                              showToast({ type: 'info', message: `已生成副本 ${r.relPath?.split('/').pop() ?? ''}` })
                            })()
                          },
                        })
                        items.push({
                          key: 'moveTo', label: '将文件移动到…', icon: <FolderInput size={15} />,
                          popover: (
                            <DirPicker
                              sourceRel={self.relPath}
                              onPick={(dst) => { setTreeMenu(null); void handleTreeMove(self.relPath, dst) }}
                              onCancel={() => setTreeMenu(null)}
                            />
                          ),
                        })
                        items.push({ separator: true })
                        items.push({
                          key: 'copyPath', label: '复制路径', icon: <Link2 size={15} />,
                          submenu: [
                            { label: '仓库相对路径', onSelect: () => void copyPathText(self.relPath, 'rel') },
                            { label: '完整路径', onSelect: () => void copyPathText(self.relPath, 'abs') },
                          ],
                        })
                        items.push({ separator: true })
                        items.push({ key: 'openSys', label: '使用默认应用打开', icon: <ExternalLink size={15} />, onSelect: () => void openTreeInSystem(self.relPath, false) })
                        items.push({ key: 'reveal', label: '在系统资源管理器中显示', icon: <FolderSearch size={15} />, onSelect: () => void openTreeInSystem(self.relPath, true) })
                        items.push({ separator: true })
                        items.push({ key: 'rename', label: '重命名', icon: <Pencil size={15} />, onSelect: () => setTreeRenaming({ relPath: self.relPath }) })
                        items.push({ separator: true })
                        items.push({ key: 'delete', label: '删除', icon: <Trash2 size={15} />, danger: true, onSelect: () => void handleTreeDelete(self) })
                        return items
                      }

                      /* ---- 文件夹条目 / 空白处（虚拟根）：**保持原样** ---- */
                      items.push(
                        { key: 'newFile', label: '新建文件', icon: <FilePlus size={15} />, onSelect: () => setTreeCreating({ dirRel, type: 'file' }) },
                        { key: 'newDir', label: '新建目录', icon: <FolderPlus size={15} />, onSelect: () => setTreeCreating({ dirRel, type: 'dir' }) },
                        // B-13：分类目录也走树内联命名（恒落根层，不吃 node 的 dirRel）
                        { key: 'newCat', label: '新建分类目录', icon: <FolderTree size={15} />, onSelect: () => setTreeCreating({ dirRel: '', type: 'category' }) },
                        { key: 'paste', label: '粘贴', icon: <ClipboardPaste size={15} />, onSelect: () => requestPasteFromMenu(dirRel) },
                      )
                      /* 导入（2026-10-13 批 1b「页面菜单能力补齐」）：两个处理函数**本来就在**
                         （handleDialogImport / handleImportFolder，拖拽那条通道一直在用），此前只有
                         那两套**没有任何渲染入口**的旧右键菜单里才有菜单项 ⇒ 用户根本摸不到。
                         放在目录 / 空白组：导入要指定落在哪个目录，语义上属「在这建东西」。 */
                      items.push({ separator: true })
                      items.push(
                        { key: 'importFiles', label: '导入文件…', icon: <FilePlus size={15} />, onSelect: () => void handleDialogImport() },
                        { key: 'importFolder', label: '导入文件夹…', icon: <FolderPlus size={15} />, onSelect: () => void handleImportFolder() },
                      )
                      if (self && self.type === 'dir') {
                        items.push({ separator: true })
                        items.push({ key: 'expandDir', label: '展开此目录（含子目录）', icon: <ChevronsUpDown size={15} />, onSelect: () => void expandDirRecursive(self.relPath) })
                        items.push({ key: 'collapseDir', label: '收起此目录', icon: <ChevronsDownUp size={15} />, onSelect: () => collapseDirRecursive(self.relPath) })
                      }
                      if (self) {
                        items.push({ separator: true })
                        items.push({ key: 'rename', label: '重命名', icon: <Pencil size={15} />, onSelect: () => setTreeRenaming({ relPath: self.relPath }) })
                        items.push({ separator: true })
                        items.push({ key: 'delete', label: '删除', icon: <Trash2 size={15} />, danger: true, onSelect: () => void handleTreeDelete(self) })
                      }
                      return items
                    })()}
                  />
                )}
              </div>
            ) : (
              /* 大纲页：OutlinePanel embedded（标题搜索 + 跳转走 outline:go-to-heading，PageEditor 消费） */
              <div className="kb-view-in flex min-h-0 flex-1 flex-col">
                <OutlinePanel
                  pageTitle={activePageForOutline?.title || '无标题'}
                  headings={outlineHeadings}
                  onBackToFile={() => setSidebarTab('files')}
                  embedded
                />
              </div>
            )}
            {/* 侧边栏底部：错题本 / 收藏 + 插件视图入口（Phase 2 批次 1 收尾：文件视图下常驻）。
                ⚠️ 必须整体受控（2026-09-21 反馈「左侧栏底部有两根短横线」）：本块是无条件渲染的，
                而它的两个子项当前都为空（QUIZ_ENTRY_ENABLED=false 收起错题本入口；无插件声明
                slot=knowledge.sidebar）→ 只剩容器自己的 border-t + py-1.5，在「图谱」上方多出一根
                11px 高的幽灵分隔线。空则整块不渲染，开关拨 true / 有插件视图时自动恢复。 */}
            {(QUIZ_ENTRY_ENABLED || pluginViews.length > 0) && (
              <div className="shrink-0 border-t border-[var(--border-color)] px-2 py-1.5 space-y-0.5">
                {/* 内置错题本：入口暂收（QUIZ_ENTRY_ENABLED 总闸，v3.5.0 随交互重做放出）——视图/事件机制保留 */}
                {QUIZ_ENTRY_ENABLED && (
                  <button
                    onClick={() => toggleQuizCollection(true)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <BookMarked size={14} />
                    错题本 / 收藏
                  </button>
                )}
                {/* C 级模块插件声明的视图挂载点（slot=knowledge.sidebar） */}
                {pluginViews.map(v => (
                  <button
                    key={`${v.pluginId}:${v.slot}`}
                    onClick={() => setActivePluginView(v)}
                    title={`${v.name}（插件）`}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <PluginIcon size={14} />
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
                    // 图谱 scope（Phase 2 批次 1 收尾）：树选择退役 → 跟随活动页所在分类（无活动页 = 全库）
                    const catId = activePageId ? allPages.find(p => p.id === activePageId)?.categoryId : null
                    const cat = catId ? categories.find(c => c.id === catId) : null
                    setGraphScope(cat?.path ? { path: cat.path, name: cat.name } : null)
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
              sidebarEl={sidebarEl}
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
                draftRelPath={activePageId.startsWith('draft:') ? activePageId.slice(6) : undefined}
                startInEdit={startInEditRef.current === activePageId}
                initialFileType={openPageInfos[activePageId]?.fileType}
                canNavBack={canNavBack(nav)}
                canNavForward={canNavForward(nav)}
                onNavBack={() => navStep(-1)}
                onNavForward={() => navStep(1)}
                /* ⋮ 的文件级动作（2026-10-13 批 1b）：实现都在这层（改名 / 移动要连带刷树与页签、
                   删除要连带关页签），PageEditor 只发请求。分屏归页签组管 —— 与页签右键同一个入口。 */
                onRenameRequest={(rel, name) => void handleTreeRename(rel, name)}
                onMoveRequest={(rel, dst) => void handleTreeMove(rel, dst)}
                onDuplicateRequest={(rel) => void handleDuplicateByRel(rel)}
                onLocateRequest={handleLocateInTree}
                onDeleteRequest={handleDeleteByRel}
                onSplitRequest={onSplitPage ? (o) => onSplitPage(activePageId, o) : undefined}
                splitDisabled={splitDisabled}
                /* 导出 PDF（批 3）：只给主栏 —— 它借的是模块层的沉浸阅读态，而 enterReading 认的是
                   **主栏活动页**；副栏挂了这项就会导出「另一篇」。 */
                onExportPdfRequest={exportActivePdf}
              />
            </Suspense>
          ) : (
            /* 无活动页面的空态（2026-09-19 反馈：只留图标，不要文字说明）。
               2026-10-13 补「回工作台」入口：本模块是 PAGE_OWNED（无页面时**页面条上不出现条目**），
               于是「关掉最后一个页面」之后页面条为空、左上角「工作台」按钮在工作台内模块态又是幂等
               no-op（ActivityBar 的 `if (!inWorkbench)`）⇒ **这个状态没有任何鼠标路径回总空态**
               （实测于 devbridge：点「工作台」画面零变化）。那三条快捷指令在总空态里，用户却到不了。
               按钮即该缺口的唯一出口；不加说明文字（口径不变，只加一个动作）。 */
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
              <FileText size={48} className="opacity-25" />
              {onBackToWorkbench && (
                <button
                  type="button"
                  onClick={onBackToWorkbench}
                  title="回到工作台（中间空态，带命令面板 / 快速打开文件 / AI 助手三条快捷指令）"
                  className="kb-item-in flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <House size={14} />
                  <span>回工作台</span>
                </button>
              )}
            </div>
          )}
        </div>
        </div>
        </>
        )}
      </div>

      {/* 副栏页面视图（页面级分屏）：portal 进 App 副栏内容槽。独立 PageEditor 实例 ——
          两栏各挂各的顶栏（与 Obsidian 同款）。批 2 起非 md 也是顶栏，且顶栏是**行内渲染**、
          不再 portal 到主栏单例槽，故两实例不会打架（原来那颗 `#editor-toolbar-slot` 已退役）。 */}
      {secondaryContentEl && secondaryPageIds.length > 0 && secondaryActiveId && createPortal(
        <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载编辑器…</div>}>
          <PageEditor
            pageId={secondaryActiveId}
            categories={categories}
            allPages={allPages}
            zoom={zoom}
            onBack={() => onRemoveSecondary?.(secondaryActiveId)}
            onDeleted={() => { handlePageDeleted(secondaryActiveId); onRemoveSecondary?.(secondaryActiveId) }}
            onNavigate={handleOpenPage}
            onUpdate={handleRefresh}
            onTitleChange={handleTitleChange}
            onFileTypeChange={handleFileTypeChange}
            onContentChange={() => {}}
            onTagsChange={handleSearchRefresh}
            onMarkDirty={handleMarkDirty}
            onClearDirty={handleClearDirty}
            onRequestReading={enterReading}
            vaultMode={true}
            draftRelPath={secondaryActiveId.startsWith('draft:') ? secondaryActiveId.slice(6) : undefined}
            startInEdit={false}
            /* 副栏的 ⋮ 同样给文件级动作（两个栏位各挂各的顶栏，能力不该只有主栏有）。
               ★ 唯独**不给分屏**：分屏的入口是主栏页签组的事，副栏再拆一次没有语义。 */
            onRenameRequest={(rel, name) => void handleTreeRename(rel, name)}
            onMoveRequest={(rel, dst) => void handleTreeMove(rel, dst)}
            onDuplicateRequest={(rel) => void handleDuplicateByRel(rel)}
            onLocateRequest={handleLocateInTree}
            onDeleteRequest={handleDeleteByRel}
          />
        </Suspense>,
        secondaryContentEl,
      )}

      {/* 页签右键菜单：固定/取消固定 + 关闭族。
          ★ 必须 portal 到 document.body（照 src/components/shared/FileContextMenu 口径）：
          本菜单写在 KnowledgeModule 的渲染树里，而模块容器是**保活**的
          （App.tsx: `display: t === activeTab ? undefined : 'none'`）。祖先一旦 display:none，
          整棵子树不生成盒子 —— 于是「人在别的模块时右键页签」会 setTabCtx 成功、菜单也生成了，
          却因为没有盒子而不可见（表象：右键没反应；切回笔记模块后菜单突然冒出来）。
          fixed 定位救不了这种情况：fixed 只脱离包含块，不脱离 display:none 的祖先。 */}
      {tabCtx && createPortal((
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setTabCtx(null)} onContextMenu={(e) => { e.preventDefault(); setTabCtx(null) }}>
          <div
            ref={tabCtxPanelRef}
            className="absolute min-w-[160px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
            style={tabCtxPos ?? { left: tabCtx.x, top: tabCtx.y, visibility: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            {onSplitPage && (
              <>
                <button disabled={splitDisabled} onClick={() => { const pid = tabCtx.pageId; setTabCtx(null); onSplitPage(pid, 'row') }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-40">
                  <Columns2 size={13} className="text-[var(--text-muted)]" />向右拆分
                </button>
                <button disabled={splitDisabled} onClick={() => { const pid = tabCtx.pageId; setTabCtx(null); onSplitPage(pid, 'column') }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-40">
                  <Rows2 size={13} className="text-[var(--text-muted)]" />向下拆分
                </button>
                <div className="mx-2 my-0.5 border-t border-[var(--border-color)]" />
              </>
            )}
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
      ), document.body)}

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

      {/* 错题本 / 收藏 —— **保活浮层**（2026-09-20 深层修复）：页签↔错题本反复切换不卸载，
          内部 20+ 筛选/备注态与首拉 3 组 IPC 全部保住（保活哲学与 App Tab 宿主同源）。
          显隐走 .kb-view-toggle 两态过渡（docs/ui-animation-plan.md §H，aria-hidden 承载状态）；
          quizEverOpened 闸门 = 未开过不挂载、不付首拉成本。隐藏期 useDataChanged('quiz') 照常收广播，
          数据不陈旧；visibility:hidden 使内容脱离 tab 序、不吃点击。 */}
      {quizEverOpened && (
        <div className="kb-view-toggle absolute inset-0 z-50" aria-hidden={!showQuizCollection}>
          <QuizCollection onClose={() => toggleQuizCollection(false)} spaceName={selectedSpace?.name ?? undefined} onOpenPage={handleOpenPage} />
        </div>
      )}

      {/* C 级模块插件视图：全屏覆盖层（沙箱 iframe + 数据桥） */}
      {activePluginView && (
        <div className="absolute inset-0 z-50 bg-[var(--bg-primary)] flex flex-col" role="dialog" aria-label={`${activePluginView.title}（插件）`}>
          <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] select-none">
            <PluginIcon size={12} className="text-[var(--text-muted)]" />
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
