import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Eye, Edit3, Star, FileText, ChevronDown, ExternalLink, X, ChevronRight, ChevronLeft, Plus, ImagePlus, StickyNote, Link2, BookOpen, MoreHorizontal, ListChecks, SquarePen, Sparkles, RefreshCw } from 'lucide-react'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
import { QuizMode } from '../../../components/shared/QuizMode'
import { extractQuizzes } from '../../../components/shared/QuizParser'
import type { KnowledgePage, KnowledgeCategory, KnowledgeTag, KnowledgeBacklinkItem, SimilarPageHit } from '../../../types'
import { getKnowledgePageById, updateKnowledgePage, getKnowledgeBacklinkContext, getKnowledgeManualLinks, addKnowledgeManualLink, removeKnowledgeManualLink, createKnowledgePage, updateKnowledgeLinks, toggleKnowledgeStar, getSetting, setSetting, getAttachmentsPath, openExternal, getKnowledgeTags, createKnowledgeTag, getAttachmentPath, getKnowledgeSimilarPages, workspaceReadFile, workspaceWriteFile, workspaceGetCurrent } from '../../../lib/ipc'
import { splitFrontmatter, joinFrontmatter } from '../../../lib/frontmatter'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { uploadImageFile, insertImageAtCursor, isImageFile, imageMarkdown, IMAGE_OWNER } from '../../../lib/editorImage'
import { FILE_LANG_OPTIONS, getFileTypeInfo } from '../../../lib/fileTypes'
import { isEditingInput } from '../../../lib/shortcuts'
import { getGlobalActiveTab } from '../../../lib/activeTab'
import { visibleKnowledgeTags } from '../../../lib/knowledgeTags'
import { ConfirmDialog } from '../../../components/shared'
import { ResizablePanel } from '../../../components/shared/ResizablePanel'
import { WelcomeHtmlView } from './WelcomeHtmlView'
import { FileMetaCard } from './FileMetaCard'
import Editor, { type OnMount } from '@monaco-editor/react'
// 共享 Monaco 宿主（P1b）：就地编辑换用与编辑器模块同一份装配——[[ 补全 / B4 内联建议 /
// 淡化装饰 / 粘贴与拖图拦截全部随之带入；legacy <Editor> 分支仅服务非 vault 旧数据兜底
import { MonacoPane, type MonacoPaneHandle } from '../../../components/shared/MonacoPane'
import { MonacoErrorBoundary } from '../../../components/shared/MonacoErrorBoundary'
import type * as Monaco from 'monaco-editor'
import { bindEditorTheme } from '../../../lib/editorTheme'
// Monaco 运行时装配下沉到宿主组件：不随应用入口进首屏 chunk（性能 2026-09-10）
import '../../../lib/monaco-setup'

interface Props {
  pageId: string
  categories: KnowledgeCategory[]
  allPages: KnowledgePage[]
  zoom?: number
  onBack: () => void
  onDeleted: () => void
  onNavigate: (id: string) => void
  onUpdate: () => void
  onTitleChange?: (title: string) => void
  onFileTypeChange?: (fileType: string) => void
  onContentChange?: (content: string) => void
  onTagsChange?: () => void
  onMarkDirty?: () => void
  onClearDirty?: () => void
  /** 请求进入沉浸阅读模式（由父级切换布局） */
  onRequestReading?: () => void
  /** 仓库读源模式：正文走就地编辑（vault 写路径，Phase 1）；「在编辑器模块中打开」保留为次入口 */
  vaultMode?: boolean
  onOpenInEditor?: () => void
}

export function PageEditor({ pageId, categories, allPages, zoom = 1, onBack, onDeleted, onNavigate, onUpdate, onTitleChange, onFileTypeChange, onContentChange, onTagsChange, onMarkDirty, onClearDirty, onRequestReading, vaultMode = false, onOpenInEditor }: Props) {
  const { s } = useSettings()
  const [page, setPage] = useState<KnowledgePage | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [fileType, setFileTypeState] = useState('')
  const [showLangMenu, setShowLangMenu] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  // 知识库以阅读优先:md/txt 页面打开即预览(右上角眼睛或 Ctrl+E / Ctrl+/ 切回编辑;vault 模式就地保存)
  const [preview, setPreview] = useState(true)
  const [backlinks, setBacklinks] = useState<KnowledgeBacklinkItem[]>([])
  // 相似笔记（A3-3：标题+首段语义/关键词混合召回，排除自身）
  const [similar, setSimilar] = useState<SimilarPageHit[]>([])
  const [similarLoading, setSimilarLoading] = useState(false)
  // 手动关联（双向）
  const [manualLinks, setManualLinks] = useState<KnowledgePage[]>([])
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  // 注解层（全类型通用）
  const [annotation, setAnnotation] = useState('')
  const [showAnnotation, setShowAnnotation] = useState(false)
  const savedAnnotationRef = useRef('')
  const annoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saving, setSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  // 沉浸刷题模式（页面含选择题时可用）
  const [quizMode, setQuizMode] = useState(false)
  /** 从当前内容解析出的可判题选择题列表 */
  const quizzes = useMemo(() => {
    if (fileType !== 'md' && fileType !== 'txt') return []
    return extractQuizzes(content)
  }, [content, fileType])
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(false)
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false)
  const [unsavedAction, setUnsavedAction] = useState<(() => void) | null>(null)
  // Tags
  const [allTags, setAllTags] = useState<KnowledgeTag[]>([])
  const [entryTags, setEntryTags] = useState<KnowledgeTag[]>([])
  /** 可见标签（隐藏知识包机器标签 kb-*） */
  const visibleEntryTags = visibleKnowledgeTags(entryTags)
  const [newTagName, setNewTagName] = useState('')
  const [showTagInput, setShowTagInput] = useState(false)
  // Wiki link disambiguation: when multiple pages share the same title
  const [wikiPicker, setWikiPicker] = useState<{ title: string; candidates: KnowledgePage[] } | null>(null)
  // 空链接建页确认(应用内 ConfirmDialog — Electron 原生 confirm 会破坏键盘焦点,禁止使用)
  const [wikiCreateTitle, setWikiCreateTitle] = useState<string | null>(null)
  /** 右侧「关联网络」（关联 + 反向链接）默认收起：正文优先占满宽度，需要时从右缘点击/拖出再展开。
   *  仅本地 state（不持久化）——每次打开页面都是收起态，不用去翻上次的开关。 */
  const [showBacklinks, setShowBacklinks] = useState(false)
  // Toolbar portals: render the editor toolbar into the tab bar row (merged layer 1 + 2)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setToolbarSlot(document.getElementById('editor-toolbar-slot'))
  }, [])
  const MAX_TAGS = 5
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contentRef = useRef(content)
  const titleRef = useRef(title)
  const pageRef = useRef(page)
  const fileTypeRef = useRef(fileType)
  const tagsRef = useRef<KnowledgeTag[]>([])
  const isDirtyRef = useRef(false)
  const savedContentRef = useRef('')
  const savedTitleRef = useRef('')
  const monacoRef = useRef<typeof Monaco | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const pageIdRef = useRef(pageId)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const showDeleteConfirmRef = useRef(showDeleteConfirm)
  const showLangMenuRef = useRef(showLangMenu)
  const isCodeFileRef = useRef(false)
  const isPdfFileRef = useRef(false)
  const vaultModeRef = useRef(vaultMode)
  // 共享 MonacoPane 句柄（P1b）：大纲跳转 / 插图 / 脚注经它拿编辑器实例
  const paneRef = useRef<MonacoPaneHandle | null>(null)
  // 就地编辑（笔记合并 Phase 1，docs/notes-merge-phase1-design.md §1.1）：
  // vault 写路径三件套 = 当前仓库 rootId + 装载时的 frontmatter 前缀 + mtime 冲突基线
  const vaultRootRef = useRef<string | null>(null)
  const vaultPrefixRef = useRef('')
  const vaultMtimeRef = useRef(0)

  const isCodeFile = fileType !== '' && fileType !== 'md' && fileType !== 'txt' && fileType !== 'pdf' && fileType !== 'xmind'
  const isPdfFile = fileType === 'pdf' || fileType === 'xmind'
  const isXmindFile = fileType === 'xmind'
  /** 欢迎页（唯一放行 HTML 渲染的知识页，主进程 kbview 白名单只收仓库根同名文件）：
   *  走沙箱 iframe 整页渲染，不入 Monaco / MarkdownPreview，也不参与收藏等文件重写通道 */
  const isWelcomeHtml = fileType === 'html' && (page?.path ?? '') === '欢迎.html'
  /** 全类型归档：清单归档的非 md 文件（docs/vault-archive-all-files-design.md §7）——
   *  html 走同一沙箱 iframe（kbview 白名单③收清单内归档 html）；其余类型元信息卡，不进 Monaco/预览 */
  const isArchiveFile = page?.entryKind === 'file'
  const isArchiveHtml = isArchiveFile && fileType === 'html'
  /** 就地编辑的共享宿主文档（P1b）：可编辑文本类 + 仓库内路径才走 MonacoPane；
   *  modelPath 命名空间防与编辑器模块同名文件共享 Monaco model（onChange/外部监听会打架）。 */
  const paneDoc = vaultMode && page?.path && !isWelcomeHtml && !isArchiveFile && !isPdfFile
    ? {
        relPath: page.path,
        modelPath: `kb://knowledge/${page.path}`,
        content,
        language: getFileTypeInfo(fileType).monacoLang,
        binary: false,
        editable: true,
        truncated: false,
        size: content.length,
      }
    : null
  /** 当前生效的编辑器实例：共享宿主优先，legacy 兜底分支用自有 ref */
  const activeEditor = () => paneRef.current?.getEditor() ?? editorRef.current

  useEffect(() => { contentRef.current = content }, [content])
  useEffect(() => { pageIdRef.current = pageId }, [pageId])
  useEffect(() => { titleRef.current = title }, [title])
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { fileTypeRef.current = fileType }, [fileType])
  useEffect(() => { tagsRef.current = entryTags }, [entryTags])
  useEffect(() => { showDeleteConfirmRef.current = showDeleteConfirm }, [showDeleteConfirm])
  useEffect(() => { showLangMenuRef.current = showLangMenu }, [showLangMenu])
  useEffect(() => { isCodeFileRef.current = isCodeFile }, [isCodeFile])
  useEffect(() => { isPdfFileRef.current = isPdfFile }, [isPdfFile])
  useEffect(() => { vaultModeRef.current = vaultMode }, [vaultMode])

  const [attachmentsPath, setAttachmentsPath] = useState('')
  // v3.4.0 PDF 整包批次 7：「内置阅读」（base64 整本渲染的旧内嵌查看器）退役 → 跳编辑器新阅读器；
  // 「本地打开」保留。旧版 userData 附件无仓库路径，跳转不可达时提示走本地打开。
  const openPdfInReader = useCallback(() => {
    const rel = page?.path
    if (!rel) { showToast({ type: 'warning', message: '旧版附件不在仓库内，无法在阅读器打开，请用「本地打开」' }); return }
    window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: rel, from: 'knowledge' } }))
  }, [page])

  useEffect(() => {
    getAttachmentsPath().then(setAttachmentsPath).catch(() => {})
  }, [])

  // 用本地工具打开 PDF
  const openPdfExternal = useCallback(async () => {
    let filePath: string | null = null
    if (page?.attachmentId) {
      filePath = await getAttachmentPath(page.attachmentId)
    }
    if (!filePath && page) filePath = `${attachmentsPath}\\${page.contentMd}`
    if (filePath) openExternal(filePath)
  }, [page, attachmentsPath])

  /** 就地编辑（vault 写路径）：装载时缓存 frontmatter 前缀与磁盘 mtime（冲突基线）。
   *  读失败 = 文件已被外部删除 → mtime 置 0，保存时按「重建」语义不带基线（同编辑器 missing 口径）。 */
  const loadVaultBaseline = useCallback(async (rel: string) => {
    try {
      if (!vaultRootRef.current) {
        const cur = await workspaceGetCurrent()
        vaultRootRef.current = cur?.rootId ?? null
      }
      const root = vaultRootRef.current
      if (!root) return
      const res = await workspaceReadFile(root, rel)
      const fm = splitFrontmatter(res?.content ?? '')
      vaultPrefixRef.current = fm?.prefix ?? ''
      vaultMtimeRef.current = typeof res?.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : 0
    } catch {
      vaultPrefixRef.current = ''
      vaultMtimeRef.current = 0
    }
  }, [])

  const loadPage = useCallback(() => {
    Promise.all([
      getKnowledgePageById(pageId).then(p => {
        if (p) {
          setPage(p); setTitle(p.title); setContent(p.contentMd); setFileTypeState(p.fileType || ''); setEntryTags(p.tags || [])
          savedContentRef.current = p.contentMd || ''; savedTitleRef.current = p.title; isDirtyRef.current = false
          const anno = p.annotationMd || ''
          setAnnotation(anno); savedAnnotationRef.current = anno
          window.dispatchEvent(new CustomEvent('status-filetype', { detail: getFileTypeInfo(p.fileType || '').label }))
          onTitleChange?.(p.title)
          // 种子 liveContent(大纲/导出依赖);列表已瘦身,活动页内容以编辑器装载为准
          onContentChange?.(p.contentMd || '')
          // 非 md/txt 类型(pdf/代码)强制编辑视图;md/txt 保持阅读优先
          const ft = (p.fileType || 'md').toLowerCase()
          setPreview(ft === 'md' || ft === '' || ft === 'txt')
          // 就地编辑基线（vault 写路径）：可编辑文本类缓存 frontmatter 前缀 + mtime；其余类型清零
          const vaultEditable = ft === 'md' || ft === 'txt' || (ft !== '' && ft !== 'pdf' && ft !== 'xmind' && ft !== 'html')
          if (vaultModeRef.current && p.path && vaultEditable && p.entryKind !== 'file') {
            void loadVaultBaseline(p.path)
          } else {
            vaultPrefixRef.current = ''
            vaultMtimeRef.current = 0
          }
        } else if (pageRef.current) {
          // 重读时页面消失 = 编辑器侧已删除或保存转草稿 → 退出阅读并说明（知识库列表已由激活刷新移除）
          onBack()
        }
      }),
      getKnowledgeBacklinkContext(pageId).then(setBacklinks),
      // 相似笔记：随页面装载刷新（保存后经 kb-reload-detail 重读也会再触发）；失败静默空态
      setSimilarLoading(true),
      getKnowledgeSimilarPages(pageId)
        .then(r => setSimilar(r.hits ?? []))
        .catch(() => setSimilar([]))
        .finally(() => setSimilarLoading(false)),
      // 手动关联是旧 DB-only 通道，仓库读源模式下主进程统一拒绝（抛错刷屏）→ vault 模式直接空态，不发调用
      vaultModeRef.current ? Promise.resolve(setManualLinks([])) : getKnowledgeManualLinks(pageId).then(setManualLinks),
      getKnowledgeTags().then(setAllTags)
    ])
    // 原来这里无条件 setShowBacklinks(true)（"切换页面时重置"），导致默认收起形同虚设：
    // 每次打开/切换页面都被强行打开。改为不动它——由用户当前开关状态决定，
    // 关着就一直关着、开着就保持开着（同一编辑器实例在标签间切换时状态自然延续）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId])

  useEffect(() => { loadPage() }, [loadPage])

  // keep-alive 阅读页重读：激活时（编辑器保存/删除后切回知识库）广播 kb-reload-detail
  const loadPageRef = useRef(loadPage)
  useEffect(() => { loadPageRef.current = loadPage }, [loadPage])
  useEffect(() => {
    const onReload = () => {
      if (isDirtyRef.current) return // 本地有未保存编辑 → 不打断
      loadPageRef.current()
    }
    window.addEventListener('kb-reload-detail', onReload)
    return () => window.removeEventListener('kb-reload-detail', onReload)
  }, [])

  useEffect(() => {
    getSetting('skipDeleteConfirm_knowledge').then(v => {
      if (v === true) setSkipDeleteConfirm(true)
    })
  }, [])

  const doSave = useCallback(async (t: string, c: string) => {
    if (!pageRef.current) return
    // 就地编辑 vault 写路径（笔记合并 Phase 1）：正文走 workspaceWriteFile（与编辑器模块同一条写路径），
    // frontmatter 前缀拼回 + mtime 冲突基线；不再复活 pre-R6 的 updateKnowledgePage 正文保存。
    if (vaultModeRef.current) {
      const rel = pageRef.current.path
      const root = vaultRootRef.current
      if (!rel || !root) {
        showToast({ type: 'warning', message: '该页面不在仓库内，无法就地保存' })
        return
      }
      try {
        // mtime 基线：装载时记录；<=0 = 文件已被外部删除 → 不带基线（保存即重建，同编辑器 missing 口径）
        const baseline = vaultMtimeRef.current > 0 ? vaultMtimeRef.current : undefined
        const res = await workspaceWriteFile(root, rel, joinFrontmatter({ frontmatterPrefix: vaultPrefixRef.current || undefined, content: c }), baseline)
        if (res?.ok) {
          vaultMtimeRef.current = typeof res.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : vaultMtimeRef.current
          isDirtyRef.current = false
          savedContentRef.current = c
          savedTitleRef.current = t
          setSaving(false)
          onClearDirty?.()
          // 双链/图谱不入图通道：vault 模式下 knowledge:updateLinks 被 DB-only 白名单拒绝（knowledgeRepo.ts:201），
          // 图谱由主进程随文件落盘的索引重建负责（knowledgeIndex 扫描）
        } else if (res?.conflict) {
          // 磁盘已被外部修改：不静默覆盖 —— 放弃本地缓冲并重读（kb:file-saved 已由 ipc 包装广播给编辑器）
          showToast({ type: 'warning', message: '文件已被外部修改，已放弃本地改动并重新加载' })
          isDirtyRef.current = false
          vaultMtimeRef.current = 0
          setSaving(false)
          onClearDirty?.()
          loadPageRef.current()
        } else {
          showToast({ type: 'error', message: res?.error || '保存失败，请重试' })
        }
      } catch (e) {
        console.error('[PageEditor] vault save failed:', e)
        showToast({ type: 'error', message: '保存失败，请重试' })
      }
      return
    }
    try {
      // 双链解析范围：正文 + 注解层
      const links = parseWikiLinks(c + '\n' + savedAnnotationRef.current)
      await updateKnowledgePage(pageRef.current.id, { title: t, contentMd: c, contentHtml: '', fileType: fileTypeRef.current, tags: tagsRef.current.map(tag => tag.id) })
      await updateKnowledgeLinks(pageRef.current.id, links)
      isDirtyRef.current = false
      savedContentRef.current = c
      savedTitleRef.current = t
      setSaving(false)
      onClearDirty?.()
    } catch (e) { console.error(e) }
  }, [])

  // 注解独立防抖保存（不触碰 content 的脏状态机）
  const saveAnnotation = useCallback(async (id: string, value: string) => {
    if (vaultMode) return  // 仓库文件模式：注解随页面文件统一在编辑器模块维护
    try {
      await updateKnowledgePage(id, { annotationMd: value })
      savedAnnotationRef.current = value
      // 注解里的双链也要入图
      await updateKnowledgeLinks(id, parseWikiLinks(savedContentRef.current + '\n' + value))
      void getKnowledgeBacklinkContext(id).then(setBacklinks)
    } catch (e) { console.error('[PageEditor] save annotation failed:', e) }
  }, [])

  const handleAnnotationChange = useCallback((v: string) => {
    setAnnotation(v)
    if (!pageRef.current) return
    if (annoTimerRef.current) clearTimeout(annoTimerRef.current)
    annoTimerRef.current = setTimeout(() => {
      void saveAnnotation(pageRef.current!.id, v)
    }, 500)
  }, [saveAnnotation])

  // ---- 手动关联 ----
  const handleAddManualLink = useCallback(async (targetId: string) => {
    if (!pageRef.current) return
    const res = await addKnowledgeManualLink(pageRef.current.id, targetId)
    if (res.ok) {
      setManualLinks(await getKnowledgeManualLinks(pageRef.current.id))
      showToast({ type: 'info', message: '已建立关联' })
    }
    setLinkPickerOpen(false); setLinkQuery('')
  }, [])

  const handleRemoveManualLink = useCallback(async (targetId: string) => {
    if (!pageRef.current) return
    await removeKnowledgeManualLink(pageRef.current.id, targetId)
    setManualLinks(await getKnowledgeManualLinks(pageRef.current.id))
  }, [])

  /**
   * 关联选择器候选：按相关性打分排序，并给出可解释的推荐理由。
   * 评分 = 共享标签 ×3 + 同章节 ×2 + 最近编辑(14天内) ×1；无命中时按更新时间兜底。
   */
  const linkCandidates = useMemo(() => {
    const q = linkQuery.trim().toLowerCase()
    const linkedIds = new Set(manualLinks.map(m => m.id))
    const curCat = page?.categoryId ?? null
    const curTagIds = new Set(entryTags.map(t => t.id))
    const now = Date.now()

    return allPages
      .filter(p => p.id !== pageId && !linkedIds.has(p.id))
      .map(p => {
        const reasons: string[] = []
        let score = 0
        if (curCat && p.categoryId === curCat) {
          score += 2
          reasons.push('同章节')
        }
        const shared = (p.tags || []).filter(t => curTagIds.has(t.id))
        if (shared.length > 0) {
          score += shared.length * 3
          reasons.push(`共享标签 ${shared.map(t => t.name).join('、')}`)
        }
        const upd = new Date(p.updatedAt).getTime()
        if (!isNaN(upd) && now - upd < 14 * 86400_000) {
          score += 1
          reasons.push('最近编辑')
        }
        return { page: p, score, reasons }
      })
      .filter(({ page: p }) => {
        if (!q) return true
        return p.title.toLowerCase().includes(q) ||
          (p.tags || []).some(t => t.name.toLowerCase().includes(q))
      })
      .sort((a, b) => b.score - a.score ||
        new Date(b.page.updatedAt).getTime() - new Date(a.page.updatedAt).getTime())
      .slice(0, 8)
  }, [allPages, manualLinks, pageId, linkQuery, page?.categoryId, entryTags])

  /** 已知页面标题集合（供预览区分空链接） */
  const knownWikiTitles = useMemo(() => new Set(allPages.map(p => p.title)), [allPages])

  useEffect(() => {
    if (!page) return
    // Mark dirty when content/title diverges from saved version
    if (content !== savedContentRef.current || title !== savedTitleRef.current) {
      isDirtyRef.current = true
      setSaving(true)
      onMarkDirty?.()
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => doSave(title, content), s.autoSaveDebounceMs)
    }
    return () => clearTimeout(saveTimer.current)
  }, [title, content, page, doSave])

  // Keyboard shortcuts: Ctrl+S, Ctrl+/, Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'knowledge') return
      // Ctrl+S — save immediately (always fire, even in Monaco)
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault()
        clearTimeout(saveTimer.current)
        doSave(titleRef.current, contentRef.current).then(() => { setSaving(false); onClearDirty?.() })
        return
      }

      if (isEditingInput(e)) return

      // Ctrl+/ 或 Ctrl+E — 切换阅读/编辑（就地编辑，vault 模式同样可用；md/txt 专属）
      if ((e.ctrlKey && e.key === '/') || (e.ctrlKey && (e.key === 'e' || e.key === 'E'))) {
        if (isCodeFileRef.current || isPdfFileRef.current) return
        e.preventDefault()
        setPreview(v => !v)
        return
      }
      // Escape — back to list (respect modals)
      if (e.key === 'Escape') {
        if (showDeleteConfirmRef.current) return
        if (showLangMenuRef.current) {
          setShowLangMenu(false)
          return
        }
        e.preventDefault()
        if (checkUnsaved()) { setUnsavedAction(() => onBack); return }
        onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave, onBack])

  // Outline panel navigation — scroll editor or preview DOM to target heading
  useEffect(() => {
    const handler = (e: Event) => {
      const { line, id } = (e as CustomEvent).detail as { line: number; id: string }
      if (preview) {
        // Reading mode: scroll DOM element
        const el = document.getElementById(id)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else {
        // Editing mode: use Monaco editor API
        const ed = activeEditor()
        if (ed) {
          ed.revealLineInCenter(line)
          ed.setPosition({ lineNumber: line, column: 1 })
          ed.focus()
        }
      }
    }
    window.addEventListener('outline:go-to-heading', handler)
    return () => window.removeEventListener('outline:go-to-heading', handler)
  }, [preview])

  // ===== Inline image insertion (paste / drag / toolbar) — md/txt only =====
  const insertImageFiles = useCallback(async (files: File[]) => {
    if (isCodeFileRef.current || isPdfFileRef.current) return
    const editor = activeEditor()
    if (!editor) return
    for (const f of files) {
      if (!isImageFile(f)) continue
      try {
        const meta = await uploadImageFile(f, IMAGE_OWNER.knowledge, pageIdRef.current)
        insertImageAtCursor(editor, meta)
      } catch {
        showToast({ type: 'error', message: `图片「${f.name}」插入失败` })
      }
    }
  }, [])

  /** 共享宿主的粘贴/拖图回调（P1b）：上传后返回 md 文本，由宿主在光标/松手处插入 */
  const handleImageToMarkdown = useCallback(async (f: File): Promise<string | null> => {
    try {
      const meta = await uploadImageFile(f, IMAGE_OWNER.knowledge, pageIdRef.current)
      return imageMarkdown(meta)
    } catch {
      showToast({ type: 'error', message: `图片「${f.name}」插入失败` })
      return null
    }
  }, [])

  // ===== 脚注：选中词语包裹为 `word^[标注]`，阅读/预览态点击展开 =====
  const insertFootnote = useCallback(() => {
    const editor = activeEditor()
    const model = editor?.getModel()
    const sel = editor?.getSelection()
    if (!editor || !model || !sel) return
    const selected = model.getValueInRange(sel)
    if (!selected.trim() || selected.includes('\n')) {
      showToast({ type: 'info', message: '请先在编辑器中选中要标注的单词或短语（单行）' })
      return
    }
    const base = selected.trim().replace(/\^\[[^\]]*\]$/, '')
    const text = `${base}^[注释]`
    editor.executeEdits('footnote', [{ range: sel, text }])
    // 选中占位文字「注释」，直接输入即替换
    const end = editor.getSelection()
    if (end) {
      editor.setSelection({
        startLineNumber: end.endLineNumber, startColumn: end.endColumn - 3,
        endLineNumber: end.endLineNumber, endColumn: end.endColumn - 1,
      })
    }
    editor.focus()
  }, [])

  // Monaco mount handler — register wiki-link completion provider
  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco

    monaco.languages.registerCompletionItemProvider('markdown', {
      triggerCharacters: ['['],
      provideCompletionItems(model: Monaco.editor.ITextModel, position: Monaco.Position) {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        })

        const lastOpen = textUntilPosition.lastIndexOf('[[')
        const lastClose = textUntilPosition.lastIndexOf(']]')
        if (lastOpen <= lastClose) return { suggestions: [] }

        const query = textUntilPosition.slice(lastOpen + 2).toLowerCase()
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: lastOpen + 3,
          endColumn: position.column
        }

        const matches = allPages
          .filter(p => p.title.toLowerCase().includes(query) && p.id !== pageId)
          .slice(0, 8)

        return {
          suggestions: matches.map(p => ({
            label: p.title,
            kind: monaco.languages.CompletionItemKind.Reference,
            insertText: p.title + ']]',
            range,
            detail: p.isStarred ? '⭐ 收藏' : undefined,
          }))
        }
      }
    })

    editor.focus()

    // Image paste / drag-drop (md/txt only; gated inside handlers)
    const dom = editor.getDomNode()
    if (dom) {
      const onPaste = (ev: ClipboardEvent) => {
        if (isCodeFileRef.current || isPdfFileRef.current) return
        const items = ev.clipboardData?.items
        if (!items) return
        const files: File[] = []
        for (const it of Array.from(items)) {
          if (it.kind === 'file' && it.type.startsWith('image/')) {
            const f = it.getAsFile()
            if (f) files.push(f)
          }
        }
        if (files.length === 0) return
        ev.preventDefault()
        ev.stopPropagation()
        void insertImageFiles(files)
      }
      const onDragOver = (ev: DragEvent) => {
        if (isCodeFileRef.current || isPdfFileRef.current) return
        if (ev.dataTransfer && Array.from(ev.dataTransfer.types).includes('Files')) ev.preventDefault()
      }
      const onDrop = (ev: DragEvent) => {
        if (isCodeFileRef.current || isPdfFileRef.current) return
        const files = ev.dataTransfer?.files
        if (!files || files.length === 0) return
        const imageFiles = Array.from(files).filter(f => isImageFile(f))
        if (imageFiles.length === 0) return
        ev.preventDefault()
        ev.stopPropagation()
        const target = editor.getTargetAtClientPoint(ev.clientX, ev.clientY)
        if (target?.position) editor.setPosition(target.position)
        editor.focus()
        void insertImageFiles(imageFiles)
      }
      dom.addEventListener('paste', onPaste, true)
      dom.addEventListener('dragover', onDragOver, true)
      dom.addEventListener('drop', onDrop, true)
    }
  }

  const handleDelete = async () => {
    if (!page) return
    if (vaultMode) {
      showToast({ type: 'warning', message: '仓库文件模式：删除请在编辑器模块操作（将移入回收站）' })
      return
    }
    if (skipDeleteConfirm) {
      onDeleted()
    } else {
      setShowDeleteConfirm(true)
    }
  }

  const handleToggleStar = async () => {
    if (!page) return
    try {
      const updated = await toggleKnowledgeStar(page.id)
      setPage({ ...page, isStarred: updated.isStarred })
      onUpdate()
    } catch (e) { console.error(e) }
  }

  const handleAddTag = async () => {
    if (vaultMode) { showToast({ type: 'warning', message: '仓库文件模式：标签请在编辑器模块的 frontmatter 中维护' }); setShowTagInput(false); return }
    const name = newTagName.trim()
    if (!name) { setShowTagInput(false); return }
    if (entryTags.length >= MAX_TAGS) { setShowTagInput(false); setNewTagName(''); return }
    let tag = allTags.find(t => t.name === name)
    if (!tag) {
      try {
        tag = await createKnowledgeTag(name)
        setAllTags(prev => [...prev, tag!])
      } catch (e) { console.error(e); return }
    }
    if (!entryTags.find(t => t.id === tag!.id)) {
      setEntryTags(prev => [...prev, tag!])
    }
    setNewTagName(''); setShowTagInput(false)
    onTagsChange?.()
  }

  const handleRemoveTag = (tagId: string) => {
    if (vaultMode) { showToast({ type: 'warning', message: '仓库文件模式：标签请在编辑器模块的 frontmatter 中维护' }); return }
    setEntryTags(prev => prev.filter(t => t.id !== tagId))
    onTagsChange?.()
  }

  // Check for unsaved changes — returns true if blocked
  const checkUnsaved = useCallback(() => {
    if (isDirtyRef.current) {
      setShowUnsavedConfirm(true)
      return true
    }
    return false
  }, [])

  if (!page) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="border-2 border-[var(--border-color)] border-t-[var(--accent)] rounded-full w-5 h-5 animate-spin" />
    </div>
  )

  // Build a breadcrumb path for a page from its category chain
  const getCategoryChain = (p: KnowledgePage): string | null => {
    if (!p.categoryId) return null
    const chain: string[] = []
    let currentId: string | null = p.categoryId
    const visited = new Set<string>()
    while (currentId) {
      if (visited.has(currentId)) break; visited.add(currentId)
      const cat = categories.find(c => c.id === currentId)
      if (cat) { chain.unshift(cat.name); currentId = cat.parentId }
      else break
    }
    return chain.length > 0 ? chain.join(' / ') : null
  }

  // Resolve a title to knowledge base pages. If >1 match, show picker.
  // If 0 → offer to create the page (P1 空链接建页闭环).
  const resolveInternalLink = (title: string): boolean => {
    const matches = allPages.filter(p => p.title === title)
    if (matches.length === 1) {
      onNavigate(matches[0].id)
      return true
    }
    if (matches.length > 1) {
      setWikiPicker({ title, candidates: matches })
      return true
    }
    // 0 匹配 → 弹应用内确认对话框,确认后建页(不能用 window.confirm,会破坏键盘焦点)
    // vault 模式：阅读器无建页写通道，引导去编辑器「新建知识页」
    if (vaultMode) {
      showToast({ type: 'warning', message: `未找到「${title}」— 请到编辑器模块「新建知识页」创建` })
      return true
    }
    setWikiCreateTitle(title)
    return true
  }

  const createPageFromWikiLink = (title: string) => {
    setWikiCreateTitle(null)
    if (vaultMode) {
      showToast({ type: 'warning', message: `仓库文件模式：新建「${title}」请到编辑器模块「新建知识页」` })
      return
    }
    void (async () => {
      try {
        const created = await createKnowledgePage({
          title,
          categoryId: page?.categoryId ?? null,
          fileType: 'md',
          contentMd: `# ${title}\n\n`,
        })
        showToast({ type: 'info', message: `页面「${title}」已创建` })
        onUpdate()
        onNavigate(created.id)
      } catch (e) {
        console.error('[PageEditor] create page from wiki link failed:', e)
        showToast({ type: 'error', message: '创建失败，请重试' })
      }
    })()
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Toolbar — portaled into the tab bar row (merged layer 1 + 2) */}
      {toolbarSlot && createPortal(
        <>
          {!isPdfFile && !vaultMode && (
            <div className="relative">
              <button onClick={() => setShowLangMenu(v => !v)}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-[var(--border-color)] transition-colors"
                title="切换文件格式">
                {getFileTypeInfo(fileType).label}
                <ChevronDown size={11} />
              </button>
              {showLangMenu && (
                <div className="absolute top-full right-0 mt-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded shadow-xl z-50 w-36 max-h-60 overflow-y-auto"
                  onMouseLeave={() => setShowLangMenu(false)}>
                  {FILE_LANG_OPTIONS.map(opt => (
                    <button key={opt.ext}
                      onClick={() => {
                        setFileTypeState(opt.ext)
                        setShowLangMenu(false)
                        if (opt.ext !== '' && opt.ext !== 'md' && opt.ext !== 'txt') setPreview(false)
                        onFileTypeChange?.(opt.ext)
                        window.dispatchEvent(new CustomEvent('status-filetype', { detail: opt.label }))
                      }}
                      className={`w-full text-left px-3 py-1.5 text-[11px] ${fileType === opt.ext ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'}`}
                    >{opt.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${saving ? 'bg-[var(--warning)] animate-pulse' : 'bg-green-500'}`}
            title={saving ? '保存中…' : '已保存'}
          />
          {!isCodeFile && !isPdfFile && !preview && (
            <button onClick={insertFootnote} className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title="脚注：选中词语后点击，加自己的标注（阅读时点击展开）">
              <StickyNote size={15} />
            </button>
          )}
          {!isCodeFile && !isPdfFile && !preview && (
            <button onClick={() => imageInputRef.current?.click()} className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title="插入图片">
              <ImagePlus size={15} />
            </button>
          )}
          {!isCodeFile && !isPdfFile && !isWelcomeHtml && !isArchiveFile && (
            <button onClick={() => setPreview(v => !v)} className={`p-1.5 rounded text-xs ${preview ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`} title={preview ? '切换到编辑 (Ctrl+E / Ctrl+/)' : '切换到预览 (Ctrl+E / Ctrl+/)'}>
              {preview ? <Edit3 size={15} /> : <Eye size={15} />}
            </button>
          )}
          {vaultMode && onOpenInEditor && (
            <button onClick={onOpenInEditor} className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors" title="在编辑器模块中打开（读写分工：编辑统一在编辑器进行）">
              <SquarePen size={15} />
            </button>
          )}
          {/* 更多操作:收藏 / 关联 / 沉浸阅读 / 删除 */}
          <div className="relative">
            <button onClick={() => setShowMoreMenu(v => !v)}
              className={`p-1.5 rounded transition-colors ${showMoreMenu ? 'text-[var(--text-primary)] bg-[var(--bg-hover)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}
              title="更多操作">
              <MoreHorizontal size={15} />
            </button>
            {showMoreMenu && (
              <div className="absolute top-full right-0 mt-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded shadow-xl z-50 w-44 py-1"
                onMouseLeave={() => setShowMoreMenu(false)}>
                {/* 欢迎页/归档非 md 文件不走 frontmatter 收藏（会毁掉文件，主进程同样拒绝） */}
                {!isWelcomeHtml && !isArchiveFile && (
                  <button onClick={() => { handleToggleStar(); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <Star key={page.isStarred ? 'on' : 'off'} size={13} className={`kb-micro-pop ${page.isStarred ? 'text-[var(--warning)]' : ''}`} fill={page.isStarred ? 'currentColor' : 'none'} />
                    {page.isStarred ? '取消收藏' : '收藏页面'}
                  </button>
                )}
                {!vaultMode && (
                  <button onClick={() => { setShowBacklinks(true); setLinkPickerOpen(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <Link2 size={13} />添加关联
                  </button>
                )}
                {(fileType === 'md' || fileType === 'txt') && onRequestReading && (
                  <button onClick={() => { onRequestReading(); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <BookOpen size={13} />沉浸阅读
                    <span className="ml-auto text-[10px] text-[var(--text-disabled)]">Ctrl+Shift+R</span>
                  </button>
                )}
                {quizzes.length > 0 && (
                  <button onClick={() => { setQuizMode(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <ListChecks size={13} />刷题模式
                    <span className="ml-auto text-[10px] text-[var(--text-disabled)]">{quizzes.length} 题</span>
                  </button>
                )}
                <div className="my-1 border-t border-[var(--border-color)]" />
                {!vaultMode && (
                  <button onClick={() => { setShowMoreMenu(false); handleDelete() }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] transition-colors">
                    <Trash2 size={13} />删除页面
                  </button>
                )}
              </div>
            )}
          </div>
        </>,
        toolbarSlot
      )}

      {/* Main editing area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 注解层：非 md/txt 页面的通用备注条（支持 [[双链]]，自动入图）；归档非 md 文件无 frontmatter 承载，不显示 */}
        {fileType !== 'md' && fileType !== 'txt' && !isWelcomeHtml && !isArchiveFile && (
          <div className="shrink-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <button onClick={() => setShowAnnotation(o => !o)}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              title="展开/收起注解">
              <StickyNote size={12} className={annotation ? 'text-[var(--warning)]' : ''} />
              <span>注解{annotation ? ' · 已填写' : ''}</span>
              <span className="flex-1" />
              {showAnnotation ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {showAnnotation && (
              <textarea
                value={annotation}
                onChange={e => handleAnnotationChange(e.target.value)}
                readOnly={vaultMode}
                rows={3}
                placeholder="给这份文件写点备注，可用 [[双链]] 关联其他页面…"
                className="w-full px-4 pb-2 bg-transparent text-[12px] text-[var(--text-primary)] outline-none resize-none placeholder-[var(--text-disabled)] disabled:cursor-not-allowed"
              />
            )}
          </div>
        )}

        {/* Content */}
        {isArchiveFile ? (
          /* 归档非 md 文件：html 沙箱渲染（kbview 白名单③），其余元信息卡（D1） */
          isArchiveHtml && page?.path ? (
            <WelcomeHtmlView path={page.path} />
          ) : (
            <FileMetaCard title={title} fileType={fileType} path={page?.path} updatedAt={page?.updatedAt} sizeBytes={page?.sizeBytes} />
          )
        ) : isXmindFile ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-[var(--text-secondary)]">
              <FileText size={64} className="opacity-20" />
              <p className="text-sm">XMind 思维导图 — 使用 XMind 软件打开编辑</p>
              <button
                onClick={async () => {
                  let filePath: string | null = null
                  if (page.attachmentId) {
                    filePath = await getAttachmentPath(page.attachmentId)
                  }
                  if (!filePath) filePath = `${attachmentsPath}\\${page.contentMd}`
                  if (filePath) openExternal(filePath)
                }}
                className="flex items-center gap-2 px-4 py-2 text-[13px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors"
              >
                <ExternalLink size={15} />
                使用 XMind 打开
              </button>
            </div>
          </div>
        ) : isPdfFile ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border-color)] shrink-0">
              <span className="flex-1 truncate text-[12px] font-medium text-[var(--text-primary)] min-w-0">{title || 'PDF 文档'}</span>
              {/* v3.4.0 批次 7：内置 base64 阅读器退役 —— 在阅读器打开 = 跳编辑器 PdfReaderView v2；本地打开保留 */}
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  onClick={openPdfInReader}
                  className="px-2 py-1 text-[11px] rounded transition-colors text-[var(--secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  title="在编辑器阅读器中打开（续读/三模式/划词 AI）"
                >
                  在阅读器打开
                </button>
                <button
                  onClick={openPdfExternal}
                  className="px-2 py-1 text-[11px] rounded transition-colors text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  title="使用本地工具打开"
                >
                  本地打开
                </button>
              </div>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-[var(--text-secondary)]">
              <FileText size={64} className="opacity-20" />
              <p className="text-sm">点击「在阅读器打开」继续阅读，或使用本地工具打开</p>
              <button onClick={openPdfExternal}
                  className="flex items-center gap-2 px-4 py-2 text-[13px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors">
                <ExternalLink size={15} />
                使用本地工具打开
              </button>
            </div>
          </div>
        ) : isWelcomeHtml && page?.path ? (
          <WelcomeHtmlView path={page.path} />
        ) : preview ? (
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <h1 className="text-xl font-bold text-[var(--text-primary)] mb-3">{title}</h1>
            <MarkdownPreview
              content={content}
              pageId={pageId}
              pageTitle={title}
              knownWikiTitles={knownWikiTitles}
              onWikiLink={title => {
                resolveInternalLink(title)
              }}
              onLinkClick={href => {
                // If it's a web URL, open in browser directly
                if (/^https?:\/\//i.test(href)) { openExternal(href); return }
                // Try to resolve as a knowledge base page by extracting the title from the path
                const basename = href.replace(/^.*[/\\]/, '')
                const titleFromPath = basename.replace(/\.[^.]+$/, '')
                // Collect all matches, prioritized by href exact match first
                let matches = allPages.filter(p => p.title === href)
                if (matches.length === 0) matches = allPages.filter(p => p.title === basename)
                if (matches.length === 0) matches = allPages.filter(p => p.title === titleFromPath)
                if (matches.length === 1) {
                  onNavigate(matches[0].id)
                } else if (matches.length > 1) {
                  setWikiPicker({ title: titleFromPath || basename, candidates: matches })
                } else {
                  openExternal(href)
                }
              }}
            />
          </div>
        ) : paneDoc ? (
          <MonacoPane
            ref={paneRef}
            doc={paneDoc}
            onChange={(_rel, v) => { setContent(v); onContentChange?.(v) }}
            fontSize={Math.round(s.editorFontSize * zoom)}
            editorOptions={{
              fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderWhitespace: 'selection',
              padding: { top: 8, bottom: 16 },
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              guides: { indentation: true },
              insertSpaces: true,
              bracketPairColorization: { enabled: true },
              matchBrackets: 'always',
              unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false, invisibleCharacters: false },
              selectionHighlight: true,
              quickSuggestions: true,
              suggest: { showWords: false },
            }}
            onPasteImage={handleImageToMarkdown}
            onDropImage={handleImageToMarkdown}
            inlineSuggestEnabled={s.aiAssistantInlineSuggest !== false}
            inlineSuggestAuto={s.aiAssistantInlineSuggestAuto !== false}
          />
        ) : (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 min-h-0">
              <MonacoErrorBoundary>
              <Editor
                language={getFileTypeInfo(fileType).monacoLang}
                value={content}
                onChange={v => { const c = v || ''; setContent(c); onContentChange?.(c) }}
                beforeMount={monaco => bindEditorTheme(monaco)}
                theme="knowbase-auto"
                onMount={handleEditorMount}
                loading={<div className="flex items-center justify-center h-full text-[var(--text-muted)]">加载编辑器...</div>}
                options={{
                  // 就地编辑（Phase 1）：vault 模式解除只读——欢迎页/归档非 md 文件不进 Monaco，无需再闸
                  readOnly: false,
                  fontSize: Math.round(s.editorFontSize * zoom),
                  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
                  lineNumbers: 'on',
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  smoothScrolling: true,
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  renderWhitespace: 'selection',
                  renderLineHighlight: 'line',
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  padding: { top: 8, bottom: 16 },
                  overviewRulerLanes: 0,
                  hideCursorInOverviewRuler: true,
                  overviewRulerBorder: false,
                  guides: { indentation: true },
                  tabSize: 2,
                  insertSpaces: true,
                  bracketPairColorization: { enabled: true },
                  matchBrackets: 'always',
                  unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false, invisibleCharacters: false },
                  selectionHighlight: true,
                  quickSuggestions: true,
                  suggest: { showWords: false },
                  placeholder: getFileTypeInfo(fileType).placeholder,
                }}
              />
              </MonacoErrorBoundary>
            </div>
          </div>
        )}

        {/* Tag bar — bottom metadata strip（知识包机器标签 kb-* 自动隐藏） */}
        <div
          className="flex items-center gap-1.5 px-2 py-1 border-t border-[var(--border-color)] bg-[var(--bg-primary)] shrink-0 overflow-x-auto"
        >
            {visibleKnowledgeTags(entryTags).map(t => (
              <span key={t.id}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] shrink-0"
                style={{ backgroundColor: t.color + '20', color: t.color, border: `1px solid ${t.color}40` }}
              >
                {t.name}
                {!vaultMode && (
                  <button onClick={() => handleRemoveTag(t.id)}
                    className="hover:text-[var(--danger)] transition-colors"
                  >
                    <X size={10} />
                  </button>
                )}
              </span>
            ))}
            {!vaultMode && visibleEntryTags.length < MAX_TAGS && (
              showTagInput ? (
                <input
                  autoFocus
                  value={newTagName}
                  onChange={e => setNewTagName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') { setShowTagInput(false); setNewTagName('') } }}
                  onBlur={handleAddTag}
                  placeholder="标签名..."
                  className="w-20 px-1.5 py-0.5 bg-[var(--input-bg)] border border-[var(--accent)] rounded text-[11px] text-[var(--text-primary)] outline-none"
                />
              ) : (
                <button onClick={() => setShowTagInput(true)}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded border border-dashed border-[var(--border-color)] transition-colors"
                >
                  <Plus size={10} />标签
                </button>
              )
            )}
            {visibleEntryTags.length > 0 && (
              <span className="text-[10px] text-[var(--text-disabled)] ml-1">{visibleEntryTags.length}/{MAX_TAGS}</span>
            )}
        </div>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,image/heic,image/heif"
        multiple
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files || [])
          if (files.length > 0) void insertImageFiles(files)
          e.target.value = ''
        }}
      />

      {/* Wiki disambiguation picker */}
      {wikiPicker && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 kb-overlay" onClick={() => setWikiPicker(null)}>
          <div
            className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-2xl flex flex-col"
            style={{ width: '420px', maxHeight: '400px' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-color)]">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                多处匹配 &mdash; 选择跳转到
              </span>
              <button onClick={() => setWikiPicker(null)} className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
              <p className="px-4 py-1.5 text-[11px] text-[var(--text-muted)]">
                标题 "<span className="text-[var(--text-primary)] font-medium">{wikiPicker.title}</span>" 匹配到 {wikiPicker.candidates.length} 个页面：
              </p>
              {wikiPicker.candidates.map(p => {
                // Show breadcrumb: derive category chain from allPages
                const catChain = getCategoryChain(p)
                // Format createdAt e.g. "2026-06-15 14:30"
                const ts = p.createdAt ? new Date(p.createdAt) : null
                const dateStr = ts && !isNaN(ts.getTime())
                  ? ts.getFullYear() + '-' +
                    String(ts.getMonth() + 1).padStart(2, '0') + '-' +
                    String(ts.getDate()).padStart(2, '0') + ' ' +
                    String(ts.getHours()).padStart(2, '0') + ':' +
                    String(ts.getMinutes()).padStart(2, '0')
                  : null
                return (
                  <button
                    key={p.id}
                    onClick={() => { onNavigate(p.id); setWikiPicker(null) }}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors group"
                  >
                    <FileText size={15} className="shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)]" />
                    <div className="min-w-0 flex-1">
                      <span className="text-[13px] text-[var(--text-primary)] truncate block">{p.title}</span>
                      {catChain && (
                        <span className="text-[10px] text-[var(--text-muted)] truncate block">{catChain}</span>
                      )}
                      {dateStr && (
                        <span className="text-[9px] text-[var(--text-muted)] block mt-0.5">创建于 {dateStr}</span>
                      )}
                    </div>
                    <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-hover)] text-[var(--text-muted)] group-hover:bg-[var(--accent)]/10">{p.fileType || 'md'}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Unsaved changes confirm dialog */}
      <ConfirmDialog
        open={showUnsavedConfirm}
        title="未保存的更改"
        message="当前页面有未保存的更改，确定要离开吗？"
        confirmLabel="离开"
        onConfirm={() => {
          setShowUnsavedConfirm(false)
          if (unsavedAction) { const a = unsavedAction; setUnsavedAction(null); a() }
        }}
        onCancel={() => { setShowUnsavedConfirm(false); setUnsavedAction(null) }}
      />

      {/* Wiki 空链接建页确认 */}
      <ConfirmDialog
        open={wikiCreateTitle !== null}
        title="页面不存在"
        message={`知识库中还没有「${wikiCreateTitle ?? ''}」这个页面，是否现在创建？`}
        confirmLabel="创建"
        showCheckbox={false}
        onConfirm={() => { if (wikiCreateTitle) createPageFromWikiLink(wikiCreateTitle) }}
        onCancel={() => setWikiCreateTitle(null)}
      />

      {/* Delete confirm dialog */}
      {page && (
        <ConfirmDialog
          open={showDeleteConfirm}
          title="确认删除"
          message={`确定要删除知识页面「${page.title || '无标题'}」吗？删除后可在回收站恢复，30天后将自动清空。`}
          onConfirm={(skipNext) => {
            if (skipNext) {
              setSetting('skipDeleteConfirm_knowledge', true)
              setSkipDeleteConfirm(true)
            }
            setShowDeleteConfirm(false)
            onDeleted()
          }}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {/* Right: 关联 + 反向链接 — 与左侧栏同款 ResizablePanel（拖拽调宽 / 拖过半程吸边收起 / 从边缘拖出展开） */}
      <ResizablePanel
        storageKey="knowledgeRailWidth"
        defaultWidth={224}
        minWidth={160}
        maxWidth={400}
        visible={showBacklinks}
        side="right"
        collapsedWidth={12}
        onSnapClose={() => setShowBacklinks(false)}
        onSnapOpen={() => setShowBacklinks(true)}
      >
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-color)] shrink-0">
            <span className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase">关联网络</span>
            <button
              onClick={() => setShowBacklinks(false)}
              className="p-0.5 rounded hover:bg-[var(--input-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title="收起（从右缘拖出可再展开）"
            >
              <ChevronRight size={13} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
                {/* 手动关联（DB-only 通道，仓库读源模式无持久化路径 → vault 模式整节隐藏） */}
                {!vaultMode && (
                  <>
                <div className="flex items-center gap-1 px-3 pt-2 pb-1">
                  <Link2 size={11} className="text-[var(--text-muted)]" />
                  <span className="flex-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">手动关联 · {manualLinks.length}</span>
                  <button onClick={() => setLinkPickerOpen(true)}
                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                    title="添加关联">
                    <Plus size={12} />
                  </button>
                </div>
                {manualLinks.map(ml => (
                  <div key={ml.id} onClick={() => onNavigate(ml.id)}
                    className="group relative px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)] border-dashed">
                    <span className="text-[12px] text-[var(--text-primary)] truncate block pr-4">{ml.title || '无标题'}</span>
                    <button
                      onClick={e => { e.stopPropagation(); void handleRemoveManualLink(ml.id) }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 hidden group-hover:block p-0.5 rounded text-[var(--text-muted)] hover:text-red-400 transition-colors"
                      title="解除关联"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
                {manualLinks.length === 0 && (
                  <p className="px-3 py-1 text-[10px] text-[var(--text-muted)] leading-relaxed">暂无。点 + 把相关页面连进来。</p>
                )}
                  </>
                )}

                {/* 反向链接（带上下文摘录） */}
                <div className="flex items-center gap-1 px-3 pt-3 pb-1">
                  <StickyNote size={11} className="text-[var(--text-muted)]" />
                  <span className="flex-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">被引用 · {backlinks.length}</span>
                </div>
                {backlinks.map(bl => (
                  <div key={bl.id} onClick={() => onNavigate(bl.id)} className="px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                    <span className="text-[12px] text-[var(--text-primary)] truncate block">{bl.title || '无标题'}</span>
                    {bl.excerpt && (
                      <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)] line-clamp-3">{bl.excerpt}</p>
                    )}
                  </div>
                ))}

                {/* 相关笔记（A3-3：标题+首段混合召回；via=关键词/语义/混合） */}
                <div className="flex items-center gap-1 px-3 pt-3 pb-1">
                  <Sparkles size={11} className="text-[var(--text-muted)]" />
                  <span className="flex-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">相关笔记 · {similar.length}</span>
                  <button
                    onClick={() => { if (pageId) { setSimilarLoading(true); void getKnowledgeSimilarPages(pageId).then(r => setSimilar(r.hits ?? [])).catch(() => setSimilar([])).finally(() => setSimilarLoading(false)) } }}
                    className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                    title="重新查找相关笔记"
                  >
                    <RefreshCw size={11} className={similarLoading ? 'animate-spin' : ''} />
                  </button>
                </div>
                {similar.map(s => (
                  <div key={s.pageId} onClick={() => onNavigate(s.pageId)} className="px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                    <span className="text-[12px] text-[var(--text-primary)] truncate block">{s.title || '无标题'}</span>
                    {s.excerpt && (
                      <p className="mt-0.5 text-[10px] leading-snug text-[var(--text-muted)] line-clamp-2">{s.excerpt}</p>
                    )}
                    <span className="mt-0.5 inline-block text-[9px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                      {s.via === 'semantic' ? '语义' : s.via === 'hybrid' ? '混合' : '关键词'}
                    </span>
                  </div>
                ))}
                {!similarLoading && similar.length === 0 && (
                  <p className="px-3 py-1 text-[10px] text-[var(--text-muted)] leading-relaxed">暂无相关笔记。</p>
                )}
              </div>
        </div>
      </ResizablePanel>

      {/* 手动关联选择器 */}
      {linkPickerOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-24 kb-overlay" onClick={() => setLinkPickerOpen(false)}>
          <div className="w-[380px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-2xl overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-[var(--border-color)] flex items-center gap-2">
              <Link2 size={14} className="text-[var(--accent)] shrink-0" />
              <input autoFocus value={linkQuery}
                onChange={e => setLinkQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && linkCandidates[0]) void handleAddManualLink(linkCandidates[0].page.id)
                  if (e.key === 'Escape') { setLinkPickerOpen(false); setLinkQuery('') }
                }}
                placeholder="搜索要关联的页面…"
                className="flex-1 bg-transparent text-[13px] text-[var(--text-primary)] placeholder-[var(--text-disabled)] outline-none"
              />
              <button onClick={() => { setLinkPickerOpen(false); setLinkQuery('') }}
                className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={14} /></button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {linkCandidates.length === 0 && (
                <p className="px-4 py-6 text-[12px] text-[var(--text-muted)] text-center">没有匹配的页面</p>
              )}
              {linkCandidates.map(({ page: c, reasons }) => (
                <button key={c.id} onClick={() => void handleAddManualLink(c.id)}
                  className="w-full flex items-center gap-2.5 px-4 py-2 text-left hover:bg-[var(--bg-hover)] transition-colors">
                  <FileText size={13} className="text-[var(--text-muted)] shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-[var(--text-primary)]">{c.title || '无标题'}</span>
                    {reasons.length > 0 && (
                      <span className="block truncate text-[10px] mt-0.5" style={{ color: 'var(--accent)' }}>
                        {reasons.join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)] shrink-0">{c.fileType || 'md'}</span>
                </button>
              ))}
            </div>
            <div className="px-4 py-1.5 border-t border-[var(--border-color)] text-[10px] text-[var(--text-muted)] flex justify-between">
              <span>按 同章节 / 共享标签 / 最近编辑 推荐</span><span>Enter 添加第一个</span>
            </div>
          </div>
        </div>
      )}

      {/* 沉浸刷题模式覆盖层（模块内全屏，独立于阅读模式；不遮挡窗口标题栏） */}
      {quizMode && quizzes.length > 0 && (
        <QuizMode quizzes={quizzes} pageTitle={title} pageId={pageId} onClose={() => setQuizMode(false)} />
      )}
    </div>
  )
}

function parseWikiLinks(md: string): string[] {
  const re = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let m
  while ((m = re.exec(md)) !== null) {
    const title = m[1].split('|')[0].trim()
    if (!links.includes(title)) links.push(title)
  }
  return links
}
