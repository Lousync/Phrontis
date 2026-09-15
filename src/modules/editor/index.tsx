import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderOpen, Plus, FolderPlus, Save, SaveAll, X, Folder, FileText, ArrowLeft,
  Pencil, Trash2, FilePlus2, Braces, ListTree, Eye, PanelRightClose, Archive, ArchiveRestore, FilePenLine, Link2, ImagePlus, ClipboardPaste,
} from 'lucide-react'
import type { WorkspaceRecent } from '../../types'
import {
  workspaceOpenById, workspaceListDir, workspaceReadFile, workspaceWriteFile,
  workspaceCreateFile, workspaceMkdir, workspaceRename, workspaceTrash, workspaceGetRecent,
  workspaceGetCurrent, workspaceSetArchiveStatus, workspaceGetArchiveEntries, getKnowledgePages, getKnowledgeGraph, onWsExternalChange,
  workspacePickImages, workspaceSaveImage, onAiTeachTreeRefresh,
  workspacePasteExternal, pasteFromClipboard, getPathForFile,
} from '../../lib/ipc'
import { notifyDataChanged } from '../../lib/dataChanged'
import { openVaultWithGuide } from '../../lib/vaultOpen'
import { VaultSwitcher } from '../../components/shared/VaultSwitcher'
import { showToast } from '../../lib/toast'
import { recordFileOp, type FileOpResult } from '../../lib/fileOpHistory'
import { useSettings } from '../../lib/SettingsContext'
import { countWords } from '../../lib/wordCount'
import { shouldExitZen } from '../../lib/zenMode'
import { FileTree } from './components/FileTree'
import { FolderFocusButton } from '../../components/shared/FolderFocusButton'
import { type MonacoPaneHandle } from './components/MonacoPane'
// monaco 主包 8.3MB —— 绝不能进首屏。宿主组件单独 lazy（使用处见下方 Suspense）：
// 代价只是「本次运行第一次打开编辑器」多一瞬加载，而不是每次切模块都等。
const MonacoPane = lazy(() => import('./components/MonacoPane').then((m) => ({ default: m.MonacoPane })))
// pdfjs 主包 ~800KB：与 monaco 同理不进首屏，PDF 阅读器单独 lazy（使用处见下方 Suspense）
const PdfReaderView = lazy(() => import('./components/PdfReaderView').then((m) => ({ default: m.PdfReaderView })))
import { extractOutline } from '../../lib/markdownOutline'
import type { EditorDoc, DirCache, TreeNode, CreateIntent } from './types'
import { joinRel, parentRel, baseName, languageFor, splitFrontmatter, joinFrontmatter, fullContent, savedFullContent } from './types'
import { ConfirmDialog, ResizablePanel } from '../../components/shared'
import { PluginSlotEntry } from '../../components/shared/PluginSlotEntry'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'

/**
 * Ctrl+V 粘贴外部文件时的焦点守卫：判断这次 paste 有没有「文本接收方」。
 *
 * 两条判据互为保险，均为**双向实测**（2026-09-15 探针，Electron 33.2.0 / win32；
 * 可复跑脚本 `.AGENT/scripts/editor/probes/probe-clipboard-paths.cjs`）：
 *
 *   焦点                     paste.target   activeElement
 *   文件树(tabindex=0)        BODY           tree
 *   body / 无焦点             BODY           BODY
 *   textarea（Monaco 旧形态）  textarea       textarea
 *   input（命名行/重命名框）    input          input
 *   contenteditable（Monaco 新形态） div      div
 *
 * ① 浏览器判据：**有编辑宿主时 Chromium 把 target 指向它，否则重定向到 BODY** —— 不依赖
 *    「哪些标签算编辑器」的名单，是浏览器自己的口径。
 * ② 名单判据：盖住 Monaco 的两种形态。
 * 只留 ② 会被 Monaco 换形态蒙掉；只留 ① 则把行为完全押在 Chromium 上，所以两条都留。
 *
 * **绝不能写成「`e.target` 在文件树内才接管」**：非可编辑焦点的 target 恒为 BODY，
 * 那样等于永不进分支 —— Ctrl+V 永久静默失效且不报错（`verify-paste-external.mjs` 已把这条钉住）。
 *
 * 放模块级而非组件内：纯函数无需每轮重建，effect 依赖数组也不必为它破例。
 */
function hasTextPasteTarget(e: ClipboardEvent): boolean {
  const t = e.target as Element | null
  if (t && t !== document.body && t !== document.documentElement) return true
  return isTextEditingTarget(document.activeElement)
}

/**
 * 焦点是否落在「能自己接文本」的元素里（判据 ② 的名单部分）。
 */
function isTextEditingTarget(el: Element | null): boolean {
  if (!el) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if ((el as HTMLElement).isContentEditable) return true
  return !!el.closest?.('.monaco-editor')
}

interface Props {
  isActive?: boolean
  /** Workbench 外壳（R1-W1）：全局侧栏容器节点。传入时文件树 portal 到该节点、内嵌列收起；null/缺省 = 模块内嵌布局 */
  sidebarEl?: HTMLElement | null
  /** Workbench 外壳托管侧栏（App 传 workbench）：文件树只渲染到 sidebarEl，槽未就绪（折叠中/可见性翻转瞬间）
   *  时渲染 null 等槽回来——绝不回落内嵌 ResizablePanel。否则收起态 App 槽 6px 把手 + 内嵌 4px 把手同屏（双手柄），
   *  展开瞬间还会先闪内嵌面板再切 portal（2026-09-08 验收实锤） */
  sidebarHosted?: boolean
  /** Markdown 标记淡化（设置 markdownDim 透传；默认开） */
  markdownDim?: boolean
  /** 知识库「在编辑器中打开」跳转：待打开的仓库相对路径（App state 传入，实例重建不丢，ISS-2026-09-04-07） */
  pendingOpenRel?: string | null
  /** 消费完 pendingOpenRel 后回调 App 清除（同一路径可再次跳转） */
  onPendingConsumed?: () => void
  /** 禅模式档位（App 层唯一真相源）：0=off 1=Z1 专注 2=Z2 禅 */
  zenLevel?: number
  /** 切档回调（Ctrl+K Z 循环 / 退出条 / Esc / 切 Tab 自动退出） */
  onZenLevelChange?: (n: number) => void
  /** UI 优化条目6：模块跳转入编辑器时的来源标签（如「AI教学」）；非空时标签栏右侧显示「← 返回 X」chip */
  openFrom?: string | null
  /** 点「返回来源」：App 切回来源 Tab（保活上下文不丢） */
  onBackFrom?: () => void
  /** 内嵌侧栏开合（Ctrl+B / 贴边收放联动；缺省=恒开，兼容 Workbench 等旧调用） */
  sidebarOpen?: boolean
  /** 侧栏宽度持久化集（sidebarWidth_editor） */
  sidebarWidths?: Record<string, number>
  /** 拖拽过半贴边收起（ResizablePanel 回调） */
  onSnapCloseSidebar?: () => void
  /** 折叠态拖拽/点击拉出（ResizablePanel 回调） */
  onSnapOpenSidebar?: () => void
}

interface InputBoxState {
  title: string
  placeholder: string
  initial: string
  submitLabel: string
  onSubmit: (value: string) => void
}

export function EditorModule({ isActive = true, sidebarEl = null, sidebarHosted = false, markdownDim = true, pendingOpenRel = null, onPendingConsumed, zenLevel = 0, onZenLevelChange, openFrom = null, onBackFrom, sidebarOpen, sidebarWidths, onSnapCloseSidebar, onSnapOpenSidebar }: Props) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [recent, setRecent] = useState<WorkspaceRecent[]>([])
  const [dirCache, setDirCache] = useState<DirCache>({})
  /** dirCache 的同步引用：vault:tree-refresh 广播时需遍历已加载目录重拉（事件回调闭包不进依赖） */
  const dirCacheRef = useRef<DirCache>({})
  useEffect(() => { dirCacheRef.current = dirCache }, [dirCache])
  /** 软件生成项名单（根层 .ignore / AI教学 产物根等，ws:listDir 附带）：文件树底部「软件文件」折叠节 */
  const [softNames, setSoftNames] = useState<string[]>([])
  /** R5：分栏预览开关（左侧 Monaco 编辑 / 右侧 MarkdownPreview 实时渲染），localStorage 记忆 */
  const [previewOpen, setPreviewOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('kb.editor.previewOpen') === '1' } catch { return false }
  })
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openFiles, setOpenFiles] = useState<Record<string, EditorDoc>>({})
  const [activePath, setActivePath] = useState<string | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)
  /** 外部文件粘贴（v3.2.0 条目 ③）：文件树容器 ref —— 右键「粘贴」前要把焦点交给它 */
  const treeRef = useRef<HTMLDivElement | null>(null)
  /** 最近一次在树里点中/右键的目录：Ctrl+V 落点优先取它，再退到当前打开文件的所在目录 */
  const lastTreeDirRef = useRef<string>('')
  const [pasting, setPasting] = useState(false)
  const tabCtxRef = useRef<HTMLDivElement | null>(null)
  /** 资源管理器标题「+」新建下拉：锚定按钮下方展开（文件 / 文件夹 / 知识页） */
  const [createMenu, setCreateMenu] = useState<{ x: number; y: number } | null>(null)
  const [trashTarget, setTrashTarget] = useState<TreeNode | null>(null)
  const [inputBox, setInputBox] = useState<InputBoxState | null>(null)
  const [inputValue, setInputValue] = useState('')
  /** VS Code 式内联创建意图（非空=文件树目标目录尾部显示命名行） */
  const [creating, setCreating] = useState<CreateIntent | null>(null)
  /** 双态模型：已归档（published）知识页 path 集合——编辑器树隐藏它们（树只留目录+草稿/非知识文件） */
  const [archivedPaths, setArchivedPaths] = useState<Set<string>>(new Set())
  /** 全类型归档：清单中的目录条目 path 集合（目录右键菜单态 + 文件是否被目录覆盖判定） */
  const [archivedDirPaths, setArchivedDirPaths] = useState<string[]>([])
  /** archivedPaths 的同步引用：saveDoc（闭包稳定）判定「保存的是已归档页 → 编辑即转草稿」 */
  const archivedRef = useRef<Set<string>>(new Set())
  useEffect(() => { archivedRef.current = archivedPaths }, [archivedPaths])
  /** 草稿页 path 集合：树内 .md 文件显示「草稿」徽标（辨识写作中） */
  const [draftRelPaths, setDraftRelPaths] = useState<Set<string>>(new Set())
  /** tab 右键（状态动作/关闭） */
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; rel: string } | null>(null)

  // 右键菜单防窗口边缘截断：渲染后实测菜单尺寸，右/下溢出则向内翻转夹取（useLayoutEffect 在绘制前完成，无闪烁）
  useLayoutEffect(() => {
    const fix = (el: HTMLDivElement | null, x: number, y: number) => {
      if (!el) return
      const r = el.getBoundingClientRect()
      let left = x, top = y
      if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - r.width)
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - r.height)
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }
    fix(ctxMenuRef.current, ctxMenu?.x ?? 0, ctxMenu?.y ?? 0)
    fix(tabCtxRef.current, tabCtx?.x ?? 0, tabCtx?.y ?? 0)
  }, [ctxMenu, tabCtx])
  const [closeTarget, setCloseTarget] = useState<string | null>(null)
  /** 保存冲突（磁盘被外部修改）：弹三选对话框 */
  const [conflictState, setConflictState] = useState<{ relPath: string; diskMtimeMs?: number; missing: boolean } | null>(null)

  // ---- 禅模式（docs/zen-mode-design.md）----
  const { s: zenSettings, update: zenUpdate } = useSettings()
  const zenLevelRef = useRef(zenLevel)
  zenLevelRef.current = zenLevel
  /** 保存反馈：禅模式下不弹 toast，悬浮条闪现「已保存 HH:MM」两秒后回落（§4） */
  const [zenSavedAt, setZenSavedAt] = useState<string | null>(null)
  /** 悬浮信息条 30s 无操作淡出（§4；transition-opacity + 定时器，不依赖 transitionend，§7-5） */
  const [zenInfoVisible, setZenInfoVisible] = useState(true)
  /** 切档统一入口：更新 App 真相源 + 持久化档位（§5：写入 settings，仅记录不自动禅） */
  const changeZen = useCallback((n: number) => {
    zenUpdate('zenLevel', n)
    onZenLevelChange?.(n)
  }, [onZenLevelChange, zenUpdate])
  /** frontmatter 查看/编辑弹窗（frontmatter 前缀文本，含 --- 包裹） */
  const [fmDraft, setFmDraft] = useState<{ relPath: string; text: string } | null>(null)
  const [fmText, setFmText] = useState('')
  /** 大纲面板开关 */
  const [outlineOpen, setOutlineOpen] = useState(false)
  const monacoRef = useRef<MonacoPaneHandle | null>(null)
  const rootIdRef = useRef<string | null>(null)
  const openFilesRef = useRef(openFiles)
  const activePathRef = useRef(activePath)

  useEffect(() => { rootIdRef.current = rootId }, [rootId])
  useEffect(() => { openFilesRef.current = openFiles }, [openFiles])
  useEffect(() => { activePathRef.current = activePath }, [activePath])
  useEffect(() => { if (inputBox) setInputValue(inputBox.initial) }, [inputBox])

  // 回收策略：仅「脏(未保存)文档」长期驻留 openFiles + 标签栏；
  // 干净文档只作为当前预览存在——切走即从 openFiles 移除（无修改，丢弃安全，重开再读盘）。
  const isDirtyDoc = (d: EditorDoc): boolean => fullContent(d) !== savedFullContent(d)
  const pruneCleanNonActive = useCallback((activeRel: string | null) => {
    setOpenFiles((prev) => {
      const entries = Object.entries(prev)
      if (entries.every(([rel, d]) => rel === activeRel || isDirtyDoc(d))) return prev
      const next: Record<string, EditorDoc> = {}
      for (const [rel, d] of entries) {
        if (rel === activeRel || isDirtyDoc(d)) next[rel] = d
      }
      return next
    })
  }, [])

  // activePath 切换后回收：切走的干净文档不留驻（脏文档保留）
  useEffect(() => {
    pruneCleanNonActive(activePath)
  }, [activePath, pruneCleanNonActive])

  useEffect(() => {
    workspaceGetRecent().then(setRecent).catch(() => {})
  }, [])

  const dirtyCount = Object.values(openFiles).filter((d) => isDirtyDoc(d)).length

  const refreshDir = useCallback(async (dirRel: string) => {
    const root = rootIdRef.current
    if (!root) return
    const res = await workspaceListDir(root, dirRel)
    if (res.error) { showToast({ type: 'error', message: res.error }); return }
    const nodes: TreeNode[] = (res.entries ?? []).map((e) => ({ ...e, relPath: joinRel(dirRel, e.name) }))
    setDirCache((prev) => ({ ...prev, [dirRel]: nodes }))
    // 软件生成项名单（仅根层返回）：FileTree 据此把 .ignore/AI教学 等归入底部「软件文件」折叠节
    if (dirRel === '') setSoftNames(res.softNames ?? [])
  }, [])

  const enterWorkspace = useCallback(async (rid: string, _name?: string) => {
    // ISS-2026-09-04-07 修复：同仓库重入保护。知识库跳转链路中，挂载自动进入（:142 effect）
    // 与 openRelFromJump（:248）会先后触发两次 enterWorkspace；后到的一次若仓库未变，
    // 其 setOpenFiles({}) 会把 openFile 刚落地的新文档清掉（表现为「跳过去但不打开文件」）。
    // 同 rid 直接跳过清场；真换仓库（rid 不同）仍走完整重置。
    if (rootIdRef.current === rid) return
    rootIdRef.current = rid
    setRootId(rid)
    setDirCache({})
    setSoftNames([])
    setExpanded(new Set())
    setOpenFiles({})
    setActivePath(null)
    await refreshDir('')
    setExpanded((prev) => new Set(prev).add(''))
    // Workbench 状态栏仓库上下文联动
    window.dispatchEvent(new CustomEvent('wb-repo-changed'))
  }, [refreshDir])

  // 读写分工：编辑器 = 当前仓库的唯一写入方 → 挂载即自动挂载当前仓库（首次引导已选过，免二次选择）
  useEffect(() => {
    // ISS-2026-09-04-07：有跳转 pending 时让路——openRelFromJump 的消费路径会自行
    // enterWorkspace + openFile；此处若并发进入，其 setOpenFiles({}) 会晚于 openFile
    // 落地并把刚打开的文档清掉（表现为「跳过去但不打开文件」）
    if (pendingOpenRel) return
    workspaceGetCurrent()
      .then((cur) => { if (cur?.rootId) void enterWorkspace(cur.rootId, cur.name ?? '') })
      .catch(() => {})
  }, [pendingOpenRel, enterWorkspace])

  // 首启引导的仓库选择/创建（VaultPicker）发生在编辑器挂载之后 → 广播 vault:changed 时补挂载
  useEffect(() => {
    const onChange = (): void => {
      workspaceGetCurrent()
        .then((cur) => { if (cur?.rootId) void enterWorkspace(cur.rootId, cur.name ?? '') })
        .catch(() => {})
    }
    window.addEventListener('vault:changed', onChange)
    return () => window.removeEventListener('vault:changed', onChange)
  }, [enterWorkspace])

  // 知识库落盘写（建空间/笔记本/页）后广播：编辑器树目录缓存重拉，新条目即时可见（2026-09-09 修复）
  useEffect(() => {
    const onTreeRefresh = (): void => {
      for (const dirRel of Object.keys(dirCacheRef.current)) void refreshDir(dirRel)
    }
    window.addEventListener('vault:tree-refresh', onTreeRefresh)
    return () => window.removeEventListener('vault:tree-refresh', onTreeRefresh)
  }, [refreshDir])

  const handleOpenDir = useCallback(async () => {
    // D7：非仓库目录 → 弹「初始化为仓库？」确认，取消则不建
    const res = await openVaultWithGuide()
    if (!res) return
    await enterWorkspace(res.rootId, res.name)
    workspaceGetRecent().then(setRecent).catch(() => {})
  }, [enterWorkspace])

  const handleOpenRecent = useCallback(async (r: WorkspaceRecent) => {
    const res = await workspaceOpenById(r.rootId)
    if (res.error) { showToast({ type: 'error', message: res.error || '无法打开该仓库' }); return }
    await enterWorkspace(res.rootId, res.name)
  }, [enterWorkspace])

  // ===== P3 插图（D1）：选图/粘贴 → 主进程复制入 .attachments/年-月/ → 光标处插相对链接 =====
  const handleInsertImage = useCallback(async () => {
    const root = rootIdRef.current
    if (!root) { showToast({ type: 'warning', message: '尚未打开任何仓库' }); return }
    const res = await workspacePickImages(root)
    if (!res.ok || !res.images) {
      if (res.error) showToast({ type: 'error', message: res.error })
      return
    }
    monacoRef.current?.insertAtCursor(res.images.map((im) => `![${im.name}](${encodeURI(im.relPath)})`).join('\n') + '\n')
  }, [])

  /** 剪贴板图片文件 → base64 过 IPC 落附件区，返回要插入的 md 片段（null = 放弃） */
  const handlePasteImageFile = useCallback(async (file: File): Promise<string | null> => {
    const root = rootIdRef.current
    if (!root) { showToast({ type: 'warning', message: '尚未打开任何仓库' }); return null }
    try {
      const buf = await file.arrayBuffer()
      if (buf.byteLength === 0) return null
      const bytes = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const ext = /png/i.test(file.type) ? 'png' : /gif/i.test(file.type) ? 'gif' : /webp/i.test(file.type) ? 'webp' : /bmp/i.test(file.type) ? 'bmp' : /svg/i.test(file.type) ? 'svg' : 'jpg'
      const fileName = file.name && /\.[a-z]+$/i.test(file.name) ? file.name : `image-${Date.now()}.${ext}`
      const res = await workspaceSaveImage(root, { fileName, dataBase64: btoa(binary) })
      if (!res.ok || !res.relPath || !res.name) {
        showToast({ type: 'error', message: res.error || '粘贴图片保存失败' })
        return null
      }
      return `![${res.name}](${encodeURI(res.relPath)})`
    } catch {
      showToast({ type: 'error', message: '粘贴图片保存失败' })
      return null
    }
  }, [])

  const toggleDir = useCallback(async (relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(relPath)) { next.delete(relPath); return next }
      next.add(relPath)
      return next
    })
    await refreshDir(relPath)
  }, [refreshDir])

  const openFile = useCallback(async (node: TreeNode) => {
    if (node.type === 'dir') { void toggleDir(node.relPath); return }
    const root = rootIdRef.current
    if (!root) return
    setActivePath(node.relPath)
    if (openFilesRef.current[node.relPath]) return
    const res = await workspaceReadFile(root, node.relPath)
    if (res.error) { showToast({ type: 'error', message: res.error }); return }
    const language = languageFor(node.name)
    // PDF 文档类型（P1）：不按文本读——内容置空、binary 标记、路由 PdfReaderView 懒加载渲染。
    // 判定用主进程 %PDF- 头探测（res.pdf）而非仅扩展名：知识库旧附件是无扩展名的 PDF
    const isPdf = res.pdf === true || /\.pdf$/i.test(node.name)
    // frontmatter 隐藏：markdown 文档拆分前缀，Monaco 只见正文（保存时拼回，roundtrip 无损）
    const fm = !isPdf && res.editable && language === 'markdown' && !res.binary ? splitFrontmatter(res.content) : null
    setOpenFiles((prev) => ({
      ...prev,
      [node.relPath]: {
        relPath: node.relPath,
        content: isPdf ? '' : (fm ? fm.body : res.content),
        savedContent: isPdf ? '' : (fm ? fm.body : res.content),
        binary: isPdf || res.binary,
        editable: res.editable,
        truncated: res.truncated,
        size: res.size,
        language: isPdf ? 'pdf' : language,
        lastSavedAt: Date.now(),
        mtimeMs: res.mtimeMs,
        frontmatterPrefix: fm ? fm.prefix : undefined,
        savedPrefix: fm ? fm.prefix : undefined,
      },
    }))
  }, [toggleDir])

  // AI教学 P1：会话文件夹落盘/改名/删除 → 刷新文件树（根级 + 产物根目录）
  useEffect(() => {
    return onAiTeachTreeRefresh(({ dirRel }) => {
      void refreshDir('')
      if (dirRel) void refreshDir(dirRel)
    })
  }, [refreshDir])

  // ---- AI 写入（vault 写工具）落盘后的外部变更通知：目标文件正被打开 → 复用保存冲突三选 ----
  useEffect(() => {
    return onWsExternalChange(({ relPath, mtimeMs }) => {
      if (!relPath || !(relPath in openFilesRef.current)) return
      setConflictState((cur) => (cur ? cur : { relPath, diskMtimeMs: mtimeMs, missing: false }))
    })
  }, [])

  // ---- R5 分栏预览 ----
  /** 切换预览并记忆到 localStorage（下次打开编辑器保持上次状态） */
  const togglePreview = useCallback(() => {
    setPreviewOpen((v) => {
      const next = !v
      try { localStorage.setItem('kb.editor.previewOpen', next ? '1' : '0') } catch { /* 隐私模式忽略 */ }
      return next
    })
  }, [])

  /** 已缓存目录里出现过的 .md 文件名（去扩展名）——预览里 [[双链]] 是否渲染为「空链接」的依据 */
  const knownWikiTitles = useMemo(() => {
    const s = new Set<string>()
    for (const entries of Object.values(dirCache)) {
      for (const e of entries) {
        if (e.type === 'file' && /\.md$/i.test(e.name)) s.add(e.name.replace(/\.md$/i, ''))
      }
    }
    return s
  }, [dirCache])

  /** 预览里点 [[双链]]：在已加载目录缓存内按文件名命中并打开；未命中提示（目录懒加载，未展开的目录查不到） */
  const handleWikiLink = useCallback((title: string) => {
    const target = `${title.toLowerCase()}.md`
    for (const entries of Object.values(dirCache)) {
      const hit = entries.find((e) => e.type === 'file' && e.name.toLowerCase() === target)
      if (hit) { void openFile(hit); return }
    }
    showToast({ type: 'info', message: `未在当前仓库找到「${title}」（该目录可能未展开）` })
  }, [dirCache, openFile])

  // 跨模块跳转：知识库「在编辑器中打开」→ 打开同一文件（读写分工协议，见 .AGENT/docs/读写分工设计.md）
  const openRelFromJump = useCallback(async (relPath: string) => {
    if (!rootIdRef.current) {
      const cur = await workspaceGetCurrent()
      if (cur?.rootId) await enterWorkspace(cur.rootId, cur.name ?? '')
    }
    if (!rootIdRef.current) { showToast({ type: 'warning', message: '尚未打开任何仓库' }); return }
    const name = relPath.split('/').pop() || relPath
    await openFile({ relPath, name, type: 'file' } as TreeNode)
  }, [openFile, enterWorkspace])

  // 跳转消费：pendingOpenRel 由 App state 传入（实例卸载重建也不丢，ISS-2026-09-04-07）。
  // 旧实现 = window 事件 listener + 一次性 window pending：保活层切 Tab 重建实例时，
  // 旧实例消费掉事件后连同文档一起被丢弃，新实例拿不到 pending → 永远空态。
  useEffect(() => {
    if (!pendingOpenRel) return
    void openRelFromJump(pendingOpenRel)
    onPendingConsumed?.()
  }, [pendingOpenRel, openRelFromJump, onPendingConsumed])

  const handleChange = useCallback((relPath: string, value: string) => {
    setOpenFiles((prev) => (prev[relPath] ? { ...prev, [relPath]: { ...prev[relPath], content: value } } : prev))
  }, [])

  /**
   * 保存文档；forceMtimeMs 用于"覆盖磁盘"（以磁盘最新 mtime 为基线强制写）。
   * @returns true=已写入磁盘（或无需保存）；false=未写入（冲突弹窗 / 失败）。
   * 冲突弹窗在编辑器模块内，若切走 Tab 会被 display:none 隐藏——调用方（如回跳知识库）
   * 必须依据返回值决定是否继续，避免冲突未决就切走。
   */
  const saveDoc = useCallback(async (relPath: string, forceMtimeMs?: number): Promise<boolean> => {
    const root = rootIdRef.current
    const doc = openFilesRef.current[relPath]
    if (!root || !doc || fullContent(doc) === savedFullContent(doc)) return true
    // 编辑即转草稿（2026-09-09 拍板）：已归档（published）知识页被编辑器保存 = 进入「修改中」——
    // frontmatter status 随本次保存一起翻成 draft（改缓冲区而非另写盘，避免后续保存把 published 翻回来）
    const prefix = doc.frontmatterPrefix ?? ''
    const autoDraft = /\.md$/i.test(relPath) && archivedRef.current.has(relPath) && prefix.length > 0
    const writePrefix = !autoDraft ? prefix
      : /^status:/im.test(prefix)
        ? prefix.replace(/^(status:\s*).*$/im, '$1draft')
        : prefix.replace(/(\r?\n---\s*$)/, `\nstatus: draft$1`) // 无 status 行 → 补一行（缺省语义=published）
    // frontmatter 前缀拼回（如曾被编辑），保证磁盘文件完整
    const res = await workspaceWriteFile(root, relPath, joinFrontmatter({ frontmatterPrefix: writePrefix || undefined, content: doc.content }), forceMtimeMs ?? doc.mtimeMs)
    if (res.ok) {
      setOpenFiles((prev) => (prev[relPath]
        ? {
          ...prev,
          [relPath]: {
            ...prev[relPath],
            frontmatterPrefix: writePrefix || undefined,
            savedContent: doc.content,
            savedPrefix: writePrefix || undefined,
            mtimeMs: res.mtimeMs ?? prev[relPath].mtimeMs,
            size: res.size ?? prev[relPath].size,
            lastSavedAt: Date.now(),
          },
        }
        : prev))
      if (autoDraft) {
        // 本地即时生效：树解除隐藏并显「草稿」徽标（知识库侧由其激活重读拿到 draft）
        setArchivedPaths((prev) => { const n = new Set(prev); n.delete(relPath); return n })
        setDraftRelPaths((prev) => new Set(prev).add(relPath))
      }
      if (zenLevelRef.current > 0) {
        // 禅模式：不用 toast 打断沉浸，悬浮条闪现「已保存 HH:MM」（§4）
        setZenSavedAt(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
      } else {
        showToast({ type: 'info', message: autoDraft ? '已保存 · 转为草稿（知识库隐藏，完成后可右键归档）' : '已保存' })
      }
      // 保存后该文档不再脏：若非当前激活，回收其驻留（干净文件不长期占 openFiles/标签）
      pruneCleanNonActive(activePathRef.current)
      return true
    }
    if (res.conflict) {
      // 磁盘已被外部修改（或删除）→ 弹三选冲突对话框
      setConflictState({ relPath, diskMtimeMs: res.diskMtimeMs, missing: res.missing === true })
      return false
    }
    showToast({ type: 'error', message: res.error || '保存失败' })
    return false
  }, [])

  /** 冲突解决：放弃本地修改，重新加载磁盘内容 */
  const reloadFromDisk = useCallback(async (relPath: string) => {
    const root = rootIdRef.current
    if (!root) return
    setConflictState(null)
    const res = await workspaceReadFile(root, relPath)
    if (res.error) { showToast({ type: 'error', message: res.error }); return }
    const isPdf = /\.pdf$/i.test(relPath)
    const language = isPdf ? 'pdf' : languageFor(baseName(relPath))
    const fm = !isPdf && res.editable && language === 'markdown' && !res.binary ? splitFrontmatter(res.content) : null
    setOpenFiles((prev) => (prev[relPath]
      ? {
        ...prev,
        [relPath]: {
          ...prev[relPath],
          content: fm ? fm.body : res.content,
          savedContent: fm ? fm.body : res.content,
          savedPrefix: fm ? fm.prefix : undefined,
          frontmatterPrefix: fm ? fm.prefix : undefined,
          mtimeMs: res.mtimeMs,
          size: res.size,
          binary: res.binary,
          editable: res.editable,
          truncated: res.truncated,
          lastSavedAt: Date.now(),
        },
      }
      : prev))
    showToast({ type: 'info', message: '已重新加载磁盘内容' })
  }, [])

  /** 冲突解决：保留本地修改，覆盖磁盘（用磁盘最新 mtime 作基线强制写） */
  const overwriteDisk = useCallback(async (relPath: string, diskMtimeMs?: number) => {
    setConflictState(null)
    if (typeof diskMtimeMs !== 'number') {
      showToast({ type: 'error', message: '无法获取磁盘状态，请重试' })
      return
    }
    await saveDoc(relPath, diskMtimeMs)
  }, [saveDoc])

  const saveAll = useCallback(async () => {
    const keys = Object.keys(openFilesRef.current).filter((p) => {
      const d = openFilesRef.current[p]
      return fullContent(d) !== savedFullContent(d)
    })
    for (const p of keys) await saveDoc(p)
  }, [saveDoc])

  // Ctrl+S / Ctrl+Shift+S（模块级快捷键：仅激活模块生效）
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || (e.key !== 's' && e.key !== 'S')) return
      e.preventDefault()
      if (e.shiftKey) void saveAll()
      else if (activePathRef.current) void saveDoc(activePathRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive, saveAll, saveDoc])

  const closeTab = useCallback((relPath: string) => {
    setOpenFiles((prev) => {
      const next = { ...prev }
      delete next[relPath]
      return next
    })
    setActivePath((p) => {
      if (p !== relPath) return p
      const keys = Object.keys(openFilesRef.current).filter((k) => k !== relPath)
      return keys.length ? keys[keys.length - 1] : null
    })
  }, [])

  /** 关闭标签：有未保存修改时走确认弹窗 */
  const requestCloseTab = useCallback((relPath: string) => {
    const doc = openFilesRef.current[relPath]
    if (doc && fullContent(doc) !== savedFullContent(doc)) {
      setCloseTarget(relPath)
      return
    }
    closeTab(relPath)
  }, [closeTab])

  /** VS Code 式内联创建：在目标目录的树内条目末尾显示命名行（不再居中弹输入框） */
  const askCreateNode = useCallback((dirRel: string, type: 'file' | 'dir') => {
    setCreating({ dirRel, type })
    setExpanded((prev) => new Set(prev).add(dirRel))
  }, [])

  /** 新建知识页：同样走内联行（frontmatter id 模板由 commitCreate 生成） */
  const askCreateKnowledgePage = useCallback((dirRel: string) => {
    setCreating({ dirRel, type: 'knowledge' })
    setExpanded((prev) => new Set(prev).add(dirRel))
  }, [])

  // Ctrl+N — 新建文件（根目录内联命名行）。与 Ctrl+S 同款不设 isEditingInput 守卫：
  // Monaco 聚焦时也要可用（keydown 冒泡到 window，Monaco 不吞）
  useEffect(() => {
    if (!isActive) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || (e.key !== 'n' && e.key !== 'N')) return
      e.preventDefault()
      askCreateNode('', 'file')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isActive, askCreateNode])

  // 知识库 Ctrl+N 跳转：App 切到编辑器 Tab 后触发「新建知识页」命名行
  // （读写分工铁律：知识库=阅读器，建页写入只发生在编辑器）
  useEffect(() => {
    const h = () => askCreateKnowledgePage('')
    window.addEventListener('kb-editor-new-page', h)
    return () => window.removeEventListener('kb-editor-new-page', h)
  }, [askCreateKnowledgePage])

  /** 内联提交：按类型清洗并执行创建（文件/目录直接建；知识页带 frontmatter 模板） */
  const commitCreate = useCallback(async (dirRel: string, type: 'file' | 'dir' | 'knowledge', rawName: string) => {
    setCreating(null)
    const root = rootIdRef.current
    if (!root) return
    const name = rawName.trim()
    if (!name) return
    if (type === 'knowledge') {
      await doCreateKnowledgePage(dirRel, name)
      return
    }
    // 文件名净化（Windows 非法字符 → _），中文保留
    const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || (type === 'dir' ? '新目录' : '新建文件.md')
    // 双态模型：新建 .md = 草稿（id + status: draft）——知识库不可见，编辑器树可见，可右键归档
    if (type === 'file' && cleaned.toLowerCase().endsWith('.md')) {
      await doCreateKnowledgePage(dirRel, cleaned.slice(0, -3))
      return
    }
    const rel = joinRel(dirRel, cleaned)
    const res = type === 'file' ? await workspaceCreateFile(root, rel) : await workspaceMkdir(root, rel)
    if (!res.ok) { showToast({ type: 'error', message: res.error || '创建失败' }); return }
    const actualRel = res.relPath ?? rel
    if (res.renamed) showToast({ type: 'info', message: `「${baseName(rel)}」已存在，已创建为「${baseName(actualRel)}」` })
    recordFileOp({ kind: 'create', rootId: root, relPath: actualRel, isDir: type === 'dir', name: baseName(actualRel) })
    setExpanded((prev) => new Set(prev).add(dirRel))
    await refreshDir(dirRel)
    if (type === 'file') {
      await openFile({ name: baseName(actualRel), type: 'file', size: 0, mtime: Date.now(), relPath: actualRel })
    }
  }, [refreshDir, openFile])

  /**
   * 新建 .md（草稿态，双态模型 2026-09-03）：带 id + status: draft。
   * 草稿 → 编辑器树可见、知识库正式列表/图谱正式节点不可见（publishedOnly 过滤）；
   * 编辑器右键「归档」去掉 status: draft 后进知识库/图谱（含虚化引用锚——草稿保留 id）。
   */
  const doCreateKnowledgePage = useCallback(async (dirRel: string, rawTitle: string) => {
    const title = rawTitle.trim()
    if (!title) return
    const root = rootIdRef.current
    if (!root) return
    // 文件名净化（Windows 非法字符 → _），中文保留
    const stem = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'untitled'
    const rel = joinRel(dirRel, `${stem}.md`)
    const now = new Date().toISOString()
    const content = `---\nid: ${crypto.randomUUID()}\ntitle: ${title}\ntags: []\nstarred: false\nstatus: draft\ncreated: ${now}\nupdated: ${now}\n---\n\n`
    const res = await workspaceCreateFile(root, rel, content)
    const actualRel = res.relPath ?? rel
    if (!res.ok) { showToast({ type: 'error', message: res.error || '创建失败' }); return }
    if (res.renamed) showToast({ type: 'info', message: `已存在同名，已创建为「${baseName(actualRel)}」` })
    // 记录 content：重做时按原内容重建（撤销 = 移除）
    recordFileOp({ kind: 'create', rootId: root, relPath: actualRel, isDir: false, content, name: baseName(actualRel) })
    setExpanded((prev) => new Set(prev).add(dirRel))
    await refreshDir(dirRel)
    await openFile({ name: baseName(actualRel), type: 'file', size: 0, mtime: Date.now(), relPath: actualRel })
  }, [refreshDir, openFile])

  /** 弹输入框：重命名 */
  const askRename = useCallback((node: TreeNode) => {
    setInputBox({
      title: '重命名',
      placeholder: '新名称',
      initial: baseName(node.relPath),
      submitLabel: '确定',
      onSubmit: (newName) => {
        setInputBox(null)
        void doRename(node, newName)
      },
    })
  }, [])

  const doRename = useCallback(async (node: TreeNode, rawName: string) => {
    const newName = rawName.trim()
    if (!newName || newName === baseName(node.relPath)) return
    const newRel = joinRel(parentRel(node.relPath), newName)
    const root = rootIdRef.current
    if (!root) return
    const res = await workspaceRename(root, node.relPath, newRel)
    if (!res.ok) { showToast({ type: 'error', message: res.error || '重命名失败' }); return }
    recordFileOp({ kind: 'move', rootId: root, from: node.relPath, to: newRel, name: baseName(newRel) })
    setOpenFiles((prev) => {
      const next = { ...prev }
      const d = next[node.relPath]
      if (d) {
        delete next[node.relPath]
        next[newRel] = { ...d, relPath: newRel, language: languageFor(newName) }
      }
      return next
    })
    setActivePath((p) => (p === node.relPath ? newRel : p))
    await refreshDir(parentRel(node.relPath))
    showToast({ type: 'info', message: '已重命名' })
  }, [refreshDir])

  /** 双态模型：归档（published）path 集合刷新 —— 知识库正式页在编辑器树中隐藏 */
  const refreshArchived = useCallback(async () => {
    try {
      const pages = await getKnowledgePages()
      setArchivedPaths(new Set(pages.filter((p) => p.path).map((p) => p.path as string)))
    } catch { /* 无仓库/失败：保持现状 */ }
    // 全类型归档清单：目录条目（右键菜单态 + 覆盖判定）
    try {
      const r = await workspaceGetArchiveEntries(rootIdRef.current ?? '')
      setArchivedDirPaths((r.entries ?? []).filter((e) => e.type === 'dir').map((e) => e.path))
    } catch { setArchivedDirPaths([]) }
    // 草稿标记集：graph 节点（draft 保留 id 故在图谱缓存）→ 树内草稿文件显「草稿」徽标
    try {
      const g = await getKnowledgeGraph()
      setDraftRelPaths(new Set(g.nodes.filter((n) => n.kind === 'page' && n.status === 'draft' && n.path).map((n) => n.path)))
    } catch { /* 保持现状 */ }
  }, [])

  /** 文件是否被某个已归档目录覆盖（B1：目录状态优先，单独「取消归档」对其无意义） */
  const isCoveredByArchivedDir = useCallback((rel: string): boolean =>
    archivedDirPaths.some((d) => rel === d || rel.startsWith(`${d}/`))
  , [archivedDirPaths])

  useEffect(() => {
    if (!isActive) return
    void refreshArchived()
  }, [isActive, refreshArchived])

  /**
   * 归档/取消归档（全类型统一走 ws:setArchiveStatus）：
   * md → 主进程分流 frontmatter 双态（draft 取反）；非 md → 归档清单增删。
   * draft=true 表示「转为草稿/取消归档」，false 表示归档。
   */
  const togglePageStatus = useCallback(async (relPath: string, draft: boolean) => {
    const root = rootIdRef.current
    if (!root) return
    const doc = openFilesRef.current[relPath]
    if (doc && fullContent(doc) !== savedFullContent(doc)) {
      showToast({ type: 'warning', message: '该文件有未保存修改，请先 Ctrl+S 保存' })
      return
    }
    const res = await workspaceSetArchiveStatus(root, relPath, !draft)
    if (!res.ok) { showToast({ type: 'error', message: res.error || '操作失败' }); return }
    showToast({ type: 'info', message: draft ? '已取消归档：知识库暂不可见' : '已归档为知识页：可在知识库中阅读' })
    if (openFilesRef.current[relPath]) closeTab(relPath)
    await refreshDir(parentRel(relPath))
    await refreshArchived()
  }, [refreshDir, refreshArchived, closeTab])

  /** 目录整体归档/取消（动态前缀：目录下文件随目录进出知识库，B1 目录状态优先） */
  const toggleDirArchive = useCallback(async (relPath: string, archive: boolean) => {
    const root = rootIdRef.current
    if (!root) return
    const res = await workspaceSetArchiveStatus(root, relPath, archive)
    if (!res.ok) { showToast({ type: 'error', message: res.error || '操作失败' }); return }
    showToast({ type: 'info', message: archive ? `已归档目录：${res.count ?? 0} 个文件可在知识库查看` : '已取消目录归档' })
    await refreshDir(parentRel(relPath))
    await refreshArchived()
  }, [refreshDir, refreshArchived])

  /** 拖拽移动：把 srcRel 移动到 targetDirRel 下（复用 ws:rename 跨目录移动） */
  const moveNode = useCallback(async (srcRel: string, targetDirRel: string) => {
    const root = rootIdRef.current
    if (!root) return
    const newRel = joinRel(targetDirRel, baseName(srcRel))
    if (newRel === srcRel) return
    const res = await workspaceRename(root, srcRel, newRel)
    if (!res.ok) { showToast({ type: 'error', message: res.error || '移动失败' }); return }
    recordFileOp({ kind: 'move', rootId: root, from: srcRel, to: newRel, name: baseName(newRel) })
    // 移动的是打开中的文件 → 更新文档 key（目录不会被打开，无需处理其下子文件）
    setOpenFiles((prev) => {
      const next = { ...prev }
      if (next[srcRel]) {
        const d = next[srcRel]
        delete next[srcRel]
        next[newRel] = { ...d, relPath: newRel }
      }
      return next
    })
    setActivePath((p) => (p === srcRel ? newRel : p))
    await refreshDir(parentRel(srcRel))
    if (targetDirRel !== parentRel(srcRel)) await refreshDir(targetDirRel)
  }, [refreshDir])

  const doTrash = useCallback(async (node: TreeNode) => {
    const root = rootIdRef.current
    if (!root) return
    const res = await workspaceTrash(root, node.relPath)
    if (!res.ok) { showToast({ type: 'error', message: res.error || '删除失败' }); return }
    setOpenFiles((prev) => {
      const next = { ...prev }
      delete next[node.relPath]
      return next
    })
    setActivePath((p) => (p === node.relPath ? null : p))
    await refreshDir(parentRel(node.relPath))
    showToast({ type: 'info', message: `已移入回收站：${baseName(node.relPath)}` })
  }, [refreshDir])

  // 右键菜单：Esc / 外部点击关闭
  useEffect(() => {
    if (!ctxMenu) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [ctxMenu])

  /**
   * 外部文件/目录粘贴（v3.2.0 条目 ③）：把系统剪贴板里 Explorer 复制的东西落到仓库目录。
   *
   * **路径只能从渲染层 paste 事件的 File 对象取**（`getPathForFile`）：主进程
   * `clipboard.readBuffer('FileNameW')` 实测只能拿到第一条，多选会静默丢文件（证据见
   * electron/lib/workspaceManager.ts 的 ws:pasteExternal）。落盘、重名递增、越界守卫都在主进程。
   */
  const pasteExternalFiles = useCallback(async (files: File[], dirRel: string) => {
    const root = rootIdRef.current
    if (!root || files.length === 0) return
    const srcPaths: string[] = []
    for (const f of files) {
      try { const p = getPathForFile(f); if (p) srcPaths.push(p) } catch { /* 取不到路径的条目丢弃 */ }
    }
    if (srcPaths.length === 0) return
    setPasting(true)
    try {
      const res = await workspacePasteExternal(root, dirRel, srcPaths)
      if (res.pasted.length === 0) {
        // 全失败时要把**具体原因**带出来：主进程只在循环走完却一项没成功时不给 reason，
        // 此时第一条 skipped 的原因（越界/符号链接/权限…）才是用户能据此行动的信息
        showToast({
          type: 'warning',
          message: res.reason === 'empty'
            ? '剪贴板里没有可粘贴的文件'
            : `粘贴失败：${res.error || res.skipped[0]?.reason || '未知原因'}`,
        })
        return
      }
      setExpanded((prev) => new Set(prev).add(dirRel))
      await refreshDir(dirRel)
      // 粘进来的 .md 可能是草稿或已归档页：重读归档清单 + 图谱拿草稿徽标，并让知识库重读
      if (res.pasted.some((n) => n.toLowerCase().endsWith('.md'))) {
        await refreshArchived()
        notifyDataChanged('knowledge')
      }
      const skippedNote = res.skipped.length > 0 ? `，已跳过 ${res.skipped.length} 项` : ''
      showToast({
        type: res.skipped.length > 0 ? 'warning' : 'success',
        message: res.pasted.length === 1
          ? `已粘贴「${res.pasted[0]}」${skippedNote}`
          : `已粘贴 ${res.pasted.length} 项${skippedNote}`,
      })
    } finally {
      setPasting(false)
    }
  }, [refreshDir, refreshArchived])

  /** 粘贴落点：右键的那个目录 > 最近点中的目录 > 当前打开文件所在目录 > 仓库根 */
  const resolvePasteDir = useCallback((node?: TreeNode | null): string => {
    if (node) return node.type === 'dir' ? node.relPath : parentRel(node.relPath)
    if (lastTreeDirRef.current) return lastTreeDirRef.current
    const active = activePathRef.current
    return active ? parentRel(active) : ''
  }, [])

  /**
   * 右键「粘贴」：Ctrl+V 有真实 paste 事件（clipboardData 带 File 列表），菜单点击是合成动作
   * 拿不到，所以先聚焦文件树再请主进程补发一次 `webContents.paste()`，复用同一条链路。
   * 必须等 React 把菜单卸载完再聚焦——被卸载的菜单是当时 focused 元素，先聚焦会被它的
   * blur 打回 body，粘贴就落到 Monaco 里变成插文本了（故走 rAF 等这一帧提交结束）。
   */
  const requestPasteFromMenu = useCallback((dirRel: string) => {
    lastTreeDirRef.current = dirRel
    requestAnimationFrame(() => {
      treeRef.current?.focus()
      void pasteFromClipboard()
    })
  }, [])

  // Ctrl+V：剪贴板里确实是文件、且没有文本接收方时才接管；文本粘贴原样放行
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

  // 「+」新建下拉：Esc 关闭（外部点击由遮罩层处理）
  useEffect(() => {
    if (!createMenu) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCreateMenu(null) }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [createMenu])

  // ---- 禅模式状态机（§5/§6-2）----
  // 入口已全局化 = 标题栏 Feather 按钮（App 层一键进禅，档位直达 2）；Esc 退出（弹窗优先：
  // 有弹窗时不拦截，交给各弹窗自己的 Esc 逻辑。仅编辑器 Tab 激活时生效，其他 Tab 由 App 兜底）
  const zenModalOpen = !!(inputBox || closeTarget || fmDraft || ctxMenu || createMenu || conflictState || tabCtx)
  useEffect(() => {
    if (zenLevel === 0 || !isActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && shouldExitZen(zenModalOpen)) {
        e.preventDefault()
        e.stopPropagation()
        changeZen(0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zenLevel, zenModalOpen, isActive, changeZen])

  // ② 离开编辑器 Tab 自动退出（保活架构组件不卸载，必须监听 isActive，§7-3）。
  // 只在「编辑器激活 → 非激活」的跳变时退出：禅入口已全局化（标题栏），从其他 Tab 进入禅
  // 时 isActive 本就为 false，不能误杀。禅中 Tab 无法切换（活动栏隐藏），实际仅防御性兜底
  const prevEditorActiveRef = useRef(isActive)
  useEffect(() => {
    if (prevEditorActiveRef.current && !isActive && zenLevel > 0) changeZen(0)
    prevEditorActiveRef.current = isActive
  }, [isActive, zenLevel, changeZen])

  // ④ 保存闪现 2s 回落
  useEffect(() => {
    if (!zenSavedAt) return
    const t = window.setTimeout(() => setZenSavedAt(null), 2000)
    return () => window.clearTimeout(t)
  }, [zenSavedAt])

  // ⑤ 悬浮信息条 30s 无操作淡出；鼠标移动/键入唤醒（§4）
  useEffect(() => {
    if (zenLevel === 0) { setZenInfoVisible(true); return }
    let timer = window.setTimeout(() => setZenInfoVisible(false), 30_000)
    const wake = () => {
      setZenInfoVisible(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setZenInfoVisible(false), 30_000)
    }
    window.addEventListener('mousemove', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [zenLevel])

  /** 知识库拖拽移动（kb-file-moved 广播）→ 三处联动：刷新源/目标目录 + 迁移已打开文档的 key */
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ srcRel?: string; dstRel?: string }>).detail
      const srcRel = detail?.srcRel
      const dstRel = detail?.dstRel
      if (!srcRel || !dstRel) return
      if (srcRel !== dstRel) {
        setOpenFiles((prev) => {
          const next = { ...prev }
          if (next[srcRel]) {
            const d = next[srcRel]
            delete next[srcRel]
            next[dstRel] = { ...d, relPath: dstRel }
          }
          return next
        })
        setActivePath((p) => (p === srcRel ? dstRel : p))
      }
      void refreshDir(parentRel(srcRel))
      if (parentRel(dstRel) !== parentRel(srcRel)) void refreshDir(parentRel(dstRel))
      void refreshArchived()
    }
    window.addEventListener('kb-file-moved', handler)
    return () => window.removeEventListener('kb-file-moved', handler)
  }, [refreshDir, refreshArchived])

  /** Ctrl+Z 撤销 / 重做文件操作（kb-fs-op-changed）→ 刷新目录 + 迁移打开文档 key + 关闭被移除文档的标签 */
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<FileOpResult>).detail
      if (!d?.ok) return
      if (d.remap && d.remap.from !== d.remap.to) {
        const { from: rmFrom, to: rmTo } = d.remap
        setOpenFiles((prev) => {
          const next = { ...prev }
          const doc = next[rmFrom]
          if (doc) {
            delete next[rmFrom]
            next[rmTo] = { ...doc, relPath: rmTo }
          }
          return next
        })
        setActivePath((p) => (p === rmFrom ? rmTo : p))
      }
      if (d.removed) closeTab(d.removed) // 撤销「新建」：文件被移除后关掉可能开着的标签
      d.dirs.forEach((dir) => { void refreshDir(dir) })
      void refreshArchived()
    }
    window.addEventListener('kb-fs-op-changed', handler)
    return () => window.removeEventListener('kb-fs-op-changed', handler)
  }, [refreshDir, refreshArchived, closeTab])

  const activeDoc = activePath ? openFiles[activePath] ?? null : null

  /** 复制文件/目录路径：rel=仓库相对；abs=含仓库根的完整路径 */
  const copyNodePath = useCallback(async (rel: string, mode: 'abs' | 'rel') => {
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
  }, [])
  /** 预览内容延迟值：React 19 并发渲染，预览重解析不阻塞输入（大文档打字不卡） */
  const previewContent = useDeferredValue(activeDoc?.content ?? '')
  // 标签栏只驻留「未保存修改」的文件；干净文件仅作当前预览，不占标签（切走即回收）
  const openList = Object.keys(openFiles).filter((rel) => isDirtyDoc(openFiles[rel]))

  // ===== 空状态：未打开仓库 =====
  if (!rootId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 p-8">
        <button
          onClick={() => void handleOpenDir()}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
        >
          <FolderOpen size={14} />
          打开文件夹作为仓库
        </button>
        {recent.length > 0 && (
          <div className="w-full max-w-sm">
            <div className="mb-2 text-[12px] font-medium text-[var(--text-muted)]">最近打开</div>
            <div className="flex flex-col gap-1">
              {recent.map((r) => (
                <button
                  key={r.rootId}
                  onClick={() => void handleOpenRecent(r)}
                  className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                >
                  <Folder size={14} className="shrink-0 text-[var(--accent)]" />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  <span className="truncate text-[11px] text-[var(--text-tertiary)]">{r.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶部贯行（统一紧凑样式）：标题居左，动作按钮靠右 */}
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 shrink-0 select-none">
        <FileText size={12} className="text-[var(--text-muted)]" />
        <span className="text-[11.5px] font-medium text-[var(--text-muted)]">编辑区</span>
        <div className="ml-auto flex items-center gap-0.5">
          {activeDoc?.language === 'markdown' && (
            <>
              <button
                onClick={() => void handleInsertImage()}
                title="插图：复制图片到仓库附件区 .attachments/ 并在光标处插入相对链接（也支持直接粘贴截图）"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ImagePlus size={12} />
                插图
              </button>
              <button
                onClick={() => { setOutlineOpen((v) => !v); }}
                title="大纲（跳转标题）"
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors ${
                  outlineOpen
                    ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                <ListTree size={12} />
                大纲
              </button>
              <button
                onClick={togglePreview}
                title="分栏预览（左编辑 / 右实时渲染）"
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] transition-colors ${
                  previewOpen
                    ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                {previewOpen ? <PanelRightClose size={12} /> : <Eye size={12} />}
                预览
              </button>
            </>
          )}
          {dirtyCount > 0 && (
            <button
              onClick={() => void saveAll()}
              title="保存全部 (Ctrl+Shift+S)"
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <SaveAll size={12} />
              保存全部 ({dirtyCount})
            </button>
          )}
        </div>
      </div>

      {/* 主体：文件树 + 编辑区。Workbench 外壳模式下文件树 portal 到全局侧栏槽（侧栏槽渲染在编辑器组左侧）。
          禅模式 Z1+：文件树列整体隐藏（workbench 侧栏槽由 App 层收起，§6-1/§7-6） */}
      <div className="flex min-h-0 flex-1">
        {zenLevel < 1 && (() => {
          const treeColumn = (
            <>
              <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
                <FileText size={12} />
                {pasting ? (
                  // swap-bar（docs/help-disclosure-pattern.md）：同一位置换文案，不新增元素
                  <span key="pasting" className="kb-view-in text-[var(--accent)]">粘贴中…</span>
                ) : '资源管理器'}
                <FolderFocusButton
                  className="ml-auto"
                  on={!!zenSettings.editorFolderFocus}
                  onToggle={() => zenUpdate('editorFolderFocus', !zenSettings.editorFolderFocus)}
                />
                <button
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setCreateMenu((v) => (v ? null : { x: r.left, y: r.bottom + 4 }))
                  }}
                  title="新建（文件 / 文件夹 / 知识页）"
                  aria-expanded={createMenu !== null}
                  className={`p-1 rounded-md transition-colors ${
                    createMenu
                      ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <Plus size={13} />
                </button>
              </div>
              <FileTree
                rootRef={treeRef}
                dirCache={dirCache}
                softNames={softNames}
                expanded={expanded}
                activePath={activePath}
                focusOn={!!zenSettings.editorFolderFocus}
                onFocusLocate={(rel, isDir) => {
                  zenUpdate('editorFolderFocus', false)
                  if (isDir) setExpanded((prev) => new Set(prev).add(rel))
                  else void openFile({ name: rel.split('/').pop() || rel, type: 'file', size: 0, mtime: 0, relPath: rel })
                }}
                onToggleDir={(p) => { lastTreeDirRef.current = p; void toggleDir(p) }}
                onOpenFile={(n) => { lastTreeDirRef.current = parentRel(n.relPath); void openFile(n) }}
                onMove={(src, dst) => void moveNode(src, dst)}
                creating={creating}
                onCommitCreate={(dirRel, type, raw) => void commitCreate(dirRel, type, raw)}
                onCancelCreate={() => setCreating(null)}
                hiddenRelPaths={archivedPaths}
                draftRelPaths={draftRelPaths}
                onContextMenu={(e, n) => {
                  e.preventDefault()
                  e.stopPropagation()
                  // 记下这次右键落点：Ctrl+V 与菜单「粘贴」都用它当落点（见 resolvePasteDir）
                  lastTreeDirRef.current = resolvePasteDir(n)
                  setCtxMenu({ x: e.clientX, y: e.clientY, node: n })
                }}
              />
              {/* UI 打磨点1：仓库切换器停靠侧栏底部（portal 与自绘列两种模式共用本列）；面板向上弹出 */}
              <div className="mt-auto border-t border-[var(--border-color)] p-1.5 shrink-0">
                <VaultSwitcher />
              </div>
            </>
          )
          if (sidebarEl) {
            // Workbench 外壳：文件树 portal 到全局侧栏槽（App 侧栏槽自带标题区），此处不再内嵌树列
            return createPortal(<div className="flex h-full w-full flex-col overflow-hidden">{treeColumn}</div>, sidebarEl)
          }
          if (sidebarHosted) {
            // Workbench 托管但槽未就绪（visible=false 时 ResizablePanel 不渲染 children → ref 置 null）：
            // 渲染 null 等槽重新挂载后 portal，绝不回落内嵌列——内嵌列与 App 槽折叠把手同屏 = 双手柄
            return null
          }
          // 内嵌侧栏：ResizablePanel 拖拽调宽 + Ctrl+B 开合 + 贴边收放（与 blog/schedule/knowledge 同款；
          // sidebarOpen 未传时恒开，兼容 Workbench 等旧调用方）
          return (
            <ResizablePanel
              storageKey="sidebarWidth_editor"
              defaultWidth={220}
              minWidth={180}
              maxWidth={420}
              visible={sidebarOpen ?? true}
              initialWidth={sidebarWidths?.sidebarWidth_editor}
              onSnapClose={onSnapCloseSidebar}
              onSnapOpen={onSnapOpenSidebar}
            >
              <div className="flex h-full w-full flex-col">{treeColumn}<PluginSlotEntry slot="editor.sidebar" /></div>
            </ResizablePanel>
          )
        })()}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 条目6 + 第三轮：返回来源 chip——独立常驻行（不依赖标签栏：未脏文件无标签行，chip 也要可见） */}
          {openFrom && onBackFrom && (
            <div className="shrink-0 flex items-center px-2 py-1 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <button onClick={onBackFrom}
                className="flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-0.5 text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
                title={`返回「${openFrom}」（保留其离开时的界面状态）`}>
                <ArrowLeft size={12} /> 返回 {openFrom}
              </button>
            </div>
          )}
          {/* 标签栏（禅模式隐藏：当前文件名见悬浮信息条/退出条） */}
          {zenLevel < 1 && openList.length > 0 && (
            <div className="flex items-center gap-0.5 overflow-x-auto border-b border-[var(--border-color)] px-1.5 pt-1">
              {openList.map((rel) => {
                const d = openFiles[rel]
                const isDirty = fullContent(d) !== savedFullContent(d)
                const isActiveTab = rel === activePath
                return (
                  <div
                    key={rel}
                    onClick={() => setActivePath(rel)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setTabCtx({ x: e.clientX, y: e.clientY, rel })
                    }}
                    className={`group flex max-w-[200px] cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 py-1.5 text-[12.5px] transition-colors ${
                      isActiveTab
                        ? 'border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-primary)]'
                        : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                    title={rel}
                  >
                    <span className="truncate">{baseName(rel)}</span>
                    {isDirty ? (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]" />
                    ) : (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-transparent" />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); requestCloseTab(rel) }}
                      className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
              {/* 返回 chip 已上移为独立常驻行（未脏文件无标签行时也可见） */}
            </div>
          )}
          {/* 编辑器 */}
          <div className="min-h-0 flex-1 relative" onClick={() => setOutlineOpen(false)}>
            {/* 主体：pdf 文档类型 → PdfReaderView（懒加载 canvas）；其余 → R5 分栏（Monaco | 预览） */}
            {activeDoc?.language === 'pdf' && rootId ? (
              <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载 PDF…</div>}>
                <PdfReaderView key={activeDoc.relPath} rootId={rootId} relPath={activeDoc.relPath} name={baseName(activeDoc.relPath)} />
              </Suspense>
            ) : (
            <div className="flex h-full min-h-0">
              {/* 禅模式 Z1+：正文限宽居中（宽度设置 zenWidth），背景延伸全屏（§4）；
                  纸感氛围：纸色铺满整个编辑区（外层），限宽容器过渡 padding */}
              <div
                className={`h-full min-w-0 flex-1 zen-transition ${zenLevel >= 1 ? 'flex justify-center' : ''} ${zenLevel >= 1 && zenSettings.zenPaper ? 'zen-paper-bg' : ''}`}
              >
                <div
                  className={`h-full zen-transition ${zenLevel >= 1 ? 'w-full' : 'min-w-0 flex-1'}`}
                  style={zenLevel >= 1 ? { maxWidth: zenSettings.zenWidth, padding: '0 20px' } : undefined}
                >
                  <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载编辑器…</div>}>
                    <MonacoPane
                      ref={monacoRef}
                      doc={activeDoc}
                      onChange={handleChange}
                      dimEnabled={markdownDim || zenLevel >= 1}
                      zen={zenLevel >= 1}
                      typewriter={zenLevel >= 1 && !!zenSettings.zenTypewriter}
                      zenPaper={!!zenSettings.zenPaper}
                      layoutKey={zenLevel}
                      onPasteImage={activeDoc?.language === 'markdown' ? handlePasteImageFile : undefined}
                    />
                  </Suspense>
                </div>
              </div>
              {previewOpen && activeDoc?.language === 'markdown' && (
                <>
                  <div className="w-px shrink-0 bg-[var(--border-color)]" />
                  <div className="kb-view-fade flex min-w-0 flex-1 flex-col">
                    <div className="flex items-center gap-1.5 border-b border-[var(--border-color)] px-3 py-1 text-[11.5px] text-[var(--text-muted)]">
                      <Eye size={12} />
                      预览
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                      <MarkdownPreview
                        content={previewContent}
                        onWikiLink={handleWikiLink}
                        knownWikiTitles={knownWikiTitles}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            )}
            {/* 大纲浮层：markdown 标题树 → 点击跳转 */}
            {outlineOpen && activeDoc?.language === 'markdown' && (
              <div
                className="kb-pop absolute top-2 right-2 z-20 w-72 max-h-[65%] overflow-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/98 shadow-xl py-1.5 flex flex-col"
                onClick={(e) => e.stopPropagation()}
              >
                {(() => {
                  const items = extractOutline(activeDoc.content)
                  if (items.length === 0) {
                    return <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">无标题（用 # 标记章节后即可跳转）</div>
                  }
                  return items.map((it) => (
                    <button
                      key={`${it.line}-${it.text}`}
                      onClick={() => { monacoRef.current?.revealLine(it.line); setOutlineOpen(false) }}
                      title={`跳转到第 ${it.line} 行`}
                      className="flex items-center gap-1.5 px-3 py-1 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                      style={{ paddingLeft: 12 + (it.level - 1) * 14 }}
                    >
                      <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{it.line}</span>
                      <span className="min-w-0 truncate">{it.text}</span>
                    </button>
                  ))
                })()}
              </div>
            )}
          </div>
          {/* 状态栏（禅模式隐藏，文件/保存状态见悬浮信息条） */}
          {zenLevel < 1 && (
          <div className="flex items-center gap-3 border-t border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
            {activeDoc && (
              <>
                <span>{baseName(activeDoc.relPath)}</span>
                <span>{activeDoc.language}</span>
                {activeDoc.editable ? (
                  <span className="text-[var(--text-tertiary)]">UTF-8</span>
                ) : (
                  <span className="text-[var(--text-warning)]">只读</span>
                )}
                {activeDoc.frontmatterPrefix !== undefined && (
                  <button
                    onClick={() => { setFmDraft({ relPath: activeDoc.relPath, text: activeDoc.frontmatterPrefix ?? '' }); setFmText(activeDoc.frontmatterPrefix ?? '') }}
                    title="查看/编辑文件头元数据（frontmatter，保存后写回磁盘）"
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <Braces size={11} />
                    属性
                  </button>
                )}
                <span className="ml-auto">{activeDoc.size.toLocaleString()} B</span>
                {fullContent(activeDoc) !== savedFullContent(activeDoc) && <span className="kb-item-in text-[var(--accent)]">未保存</span>}
              </>
            )}
          </div>
          )}

          {/* 禅模式悬浮信息条（§4）：右下角极轻文字，30s 无操作淡出；保存闪现「已保存 HH:MM」 */}
          {zenLevel >= 1 && activeDoc && (
            <div
              className={`pointer-events-none fixed bottom-3 right-5 z-[60] text-[11px] text-[var(--text-muted)] transition-opacity duration-700 select-none ${zenInfoVisible ? 'opacity-70' : 'opacity-0'}`}
            >
              {zenSettings.zenShowCount && <span>{countWords(previewContent).words} 字 · </span>}
              <span>{zenSavedAt ? `已保存 ${zenSavedAt}` : fullContent(activeDoc) !== savedFullContent(activeDoc) ? '未保存' : '无更改'}</span>
            </div>
          )}
        </div>
      </div>

      {/* frontmatter 查看/编辑弹窗 */}
      {fmDraft && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 kb-overlay" onClick={() => setFmDraft(null)}>
          <div
            className="flex w-[480px] max-w-[90vw] flex-col gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">文件属性（frontmatter）</span>
              <button onClick={() => setFmDraft(null)} className="rounded p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                <X size={14} />
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              这是文件头部的元数据（含 <code className="text-[var(--text-primary)]">---</code> 包裹），正文编辑时不显示。清空全部内容可移除元数据。
            </p>
            <textarea
              value={fmText}
              onChange={(e) => setFmText(e.target.value)}
              spellCheck={false}
              autoFocus
              className="h-48 w-full resize-none rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-2.5 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setFmDraft(null)}
                className="rounded-lg border border-[var(--border-color)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                取消
              </button>
              <button
                onClick={() => {
                  const rel = fmDraft.relPath
                  const doc = openFilesRef.current[rel]
                  if (doc) {
                    setOpenFiles((prev) => (prev[rel] ? { ...prev, [rel]: { ...prev[rel], frontmatterPrefix: fmText } } : prev))
                    void saveDoc(rel)
                  }
                  setFmDraft(null)
                }}
                className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] text-white transition-opacity hover:opacity-90"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 资源管理器「+」新建下拉：文件 / 文件夹 / 知识页 */}
      {createMenu && (
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setCreateMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCreateMenu(null) }}>
          <div
            className="absolute min-w-[150px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
            style={{ left: Math.min(createMenu.x, window.innerWidth - 170), top: Math.min(createMenu.y, window.innerHeight - 140) }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => { setCreateMenu(null); askCreateNode('', 'file') }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <Plus size={13} className="text-[var(--text-muted)]" />新建文件
            </button>
            <button onClick={() => { setCreateMenu(null); askCreateNode('', 'dir') }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <FolderPlus size={13} className="text-[var(--text-muted)]" />新建文件夹
            </button>
            <button onClick={() => { setCreateMenu(null); askCreateKnowledgePage('') }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <FilePlus2 size={13} className="text-[var(--text-muted)]" />新建知识页
            </button>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {ctxMenu && (
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}>
          <div
            ref={ctxMenuRef}
            className="absolute min-w-[150px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {ctxMenu.node.type === 'dir' && (
              <>
                <button onClick={() => { const d = ctxMenu.node.relPath; setCtxMenu(null); askCreateNode(d, 'file') }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <Plus size={13} className="text-[var(--text-muted)]" />新建文件
                </button>
                <button onClick={() => { const d = ctxMenu.node.relPath; setCtxMenu(null); askCreateNode(d, 'dir') }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <FolderPlus size={13} className="text-[var(--text-muted)]" />新建文件夹
                </button>
                <button onClick={() => { const d = ctxMenu.node.relPath; setCtxMenu(null); askCreateKnowledgePage(d) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <FilePlus2 size={13} className="text-[var(--text-muted)]" />新建知识页
                </button>
                {/* 粘贴系统剪贴板里的文件/目录（Ctrl+V 同名功能的菜单入口；焦点随后交给文件树） */}
                <button onClick={() => { const d = ctxMenu.node.relPath; setCtxMenu(null); requestPasteFromMenu(d) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <ClipboardPaste size={13} className="text-[var(--text-muted)]" />粘贴
                </button>
                {/* 全类型归档（docs/vault-archive-all-files-design.md）：目录整体进出知识库（动态前缀） */}
                {ctxMenu.node.relPath !== '' && (
                  archivedDirPaths.includes(ctxMenu.node.relPath) ? (
                    <button onClick={() => { const d = ctxMenu.node.relPath; setCtxMenu(null); void toggleDirArchive(d, false) }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <ArchiveRestore size={13} className="text-[var(--text-muted)]" />取消目录归档
                    </button>
                  ) : (
                    <button onClick={() => { const d = ctxMenu.node.relPath; setCtxMenu(null); void toggleDirArchive(d, true) }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <Archive size={13} className="text-[var(--text-muted)]" />归档整个目录
                    </button>
                  )
                )}
                <div className="mx-2 my-0.5 border-t border-[var(--border-color)]" />
              </>
            )}
            {ctxMenu.node.type === 'file' && (
              <button onClick={() => { const n = ctxMenu.node; setCtxMenu(null); void openFile(n) }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                <FileText size={13} className="text-[var(--text-muted)]" />打开
              </button>
            )}
            {/* 全类型归档：非 md 文件同 md 一进出；被目录覆盖的文件不提供单独取消（语义随目录） */}
            {ctxMenu.node.type === 'file' && !archivedPaths.has(ctxMenu.node.relPath) && (
              <button onClick={() => { const rel = ctxMenu.node.relPath; setCtxMenu(null); void togglePageStatus(rel, false) }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                <Archive size={13} className="text-[var(--text-muted)]" />归档为知识页
              </button>
            )}
            {ctxMenu.node.type === 'file' && archivedPaths.has(ctxMenu.node.relPath) && !isCoveredByArchivedDir(ctxMenu.node.relPath) && (
              <button onClick={() => { const rel = ctxMenu.node.relPath; setCtxMenu(null); void togglePageStatus(rel, true) }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                <ArchiveRestore size={13} className="text-[var(--text-muted)]" />取消归档
              </button>
            )}
            {ctxMenu.node.relPath !== '' && (
              <>
                <button onClick={() => { const r = ctxMenu.node.relPath; setCtxMenu(null); void copyNodePath(r, 'rel') }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <Link2 size={13} className="text-[var(--text-muted)]" />复制相对路径
                </button>
                <button onClick={() => { const r = ctxMenu.node.relPath; setCtxMenu(null); void copyNodePath(r, 'abs') }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <Link2 size={13} className="text-[var(--text-muted)]" />复制路径
                </button>
                <button onClick={() => { const n = ctxMenu.node; setCtxMenu(null); askRename(n) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                  <Pencil size={13} className="text-[var(--text-muted)]" />重命名
                </button>
                <button onClick={() => { const n = ctxMenu.node; setCtxMenu(null); setTrashTarget(n) }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-danger)] hover:bg-[var(--bg-hover)]">
                  <Trash2 size={13} />删除（回收站）
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* tab 右键：状态动作（归档为知识页 / 转为草稿）+ 关闭 */}
      {tabCtx && (
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setTabCtx(null)} onContextMenu={(e) => { e.preventDefault(); setTabCtx(null) }}>
          <div
            ref={tabCtxRef}
            className="absolute min-w-[160px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
            style={{ left: tabCtx.x, top: tabCtx.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {tabCtx.rel.toLowerCase().endsWith('.md') ? (
              <>
                {archivedPaths.has(tabCtx.rel) ? (
                  <button onClick={() => { const rel = tabCtx.rel; setTabCtx(null); void togglePageStatus(rel, true) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <FilePenLine size={13} className="text-[var(--text-muted)]" />转为草稿（修改中）
                  </button>
                ) : (
                  <button onClick={() => { const rel = tabCtx.rel; setTabCtx(null); void togglePageStatus(rel, false) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <Archive size={13} className="text-[var(--text-muted)]" />归档为知识页
                  </button>
                )}
                <div className="mx-2 my-0.5 border-t border-[var(--border-color)]" />
              </>
            ) : (
              <>
                {archivedPaths.has(tabCtx.rel) ? (
                  !isCoveredByArchivedDir(tabCtx.rel) && (
                    <button onClick={() => { const rel = tabCtx.rel; setTabCtx(null); void togglePageStatus(rel, true) }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                      <ArchiveRestore size={13} className="text-[var(--text-muted)]" />取消归档
                    </button>
                  )
                ) : (
                  <button onClick={() => { const rel = tabCtx.rel; setTabCtx(null); void togglePageStatus(rel, false) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <Archive size={13} className="text-[var(--text-muted)]" />归档为知识页
                  </button>
                )}
                <div className="mx-2 my-0.5 border-t border-[var(--border-color)]" />
              </>
            )}
            <button onClick={() => { const rel = tabCtx.rel; setTabCtx(null); requestCloseTab(rel) }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
              <X size={13} className="text-[var(--text-muted)]" />关闭
            </button>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={trashTarget !== null}
        title="移入回收站"
        message={`「${trashTarget ? baseName(trashTarget.relPath) : ''}」移入回收站，可恢复。`}
        confirmLabel="删除"
        showCheckbox={false}
        onConfirm={() => { if (trashTarget) void doTrash(trashTarget); setTrashTarget(null) }}
        onCancel={() => setTrashTarget(null)}
      />

      {/* 关闭未保存标签确认 */}
      <ConfirmDialog
        open={closeTarget !== null}
        title="未保存的修改"
        message={`「${closeTarget ? baseName(closeTarget) : ''}」有未保存的修改，确定关闭？`}
        confirmLabel="关闭"
        showCheckbox={false}
        onConfirm={() => { if (closeTarget) closeTab(closeTarget); setCloseTarget(null) }}
        onCancel={() => setCloseTarget(null)}
      />

      {/* 新建 / 重命名输入弹窗（Electron 渲染进程不支持 window.prompt） */}
      {inputBox && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 kb-overlay" onClick={() => setInputBox(null)}>
          <div
            className="w-80 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-[13px] font-medium text-[var(--text-primary)]">{inputBox.title}</div>
            <input
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={inputBox.placeholder}
              className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') inputBox.onSubmit(inputValue)
                if (e.key === 'Escape') setInputBox(null)
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setInputBox(null)}
                className="rounded-md px-3 py-1 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                取消
              </button>
              <button
                onClick={() => inputBox.onSubmit(inputValue)}
                className="rounded-md bg-[var(--accent)] px-3 py-1 text-[12.5px] text-white transition-opacity hover:opacity-90"
              >
                {inputBox.submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 保存冲突对话框：磁盘被外部修改（对标 VS Code 的 saveConflictResolution） */}
      {conflictState && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 kb-overlay" onClick={() => setConflictState(null)}>
          <div
            className="w-[380px] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 text-[13px] font-medium text-[var(--text-warning)]">
              {conflictState.missing ? '文件已在磁盘上被删除' : '文件已被外部修改'}
            </div>
            <div className="mb-3 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              「{baseName(conflictState.relPath)}」在编辑期间被其他程序改动
              {conflictState.missing ? '或移走' : ''}。要如何处理？
            </div>
            <div className="flex flex-col gap-1.5">
              <button
                onClick={() => void reloadFromDisk(conflictState.relPath)}
                className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <span className="font-medium">重新加载</span>
                <span className="ml-2 text-[var(--text-tertiary)]">放弃本地修改，取磁盘最新内容</span>
              </button>
              <button
                onClick={() => void overwriteDisk(conflictState.relPath, conflictState.diskMtimeMs)}
                className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-3 py-2 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <span className="font-medium">覆盖磁盘</span>
                <span className="ml-2 text-[var(--text-tertiary)]">保留我的修改，写回磁盘</span>
              </button>
              <button
                onClick={() => setConflictState(null)}
                className="rounded-lg px-3 py-2 text-left text-[12.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                暂不处理（继续编辑）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
