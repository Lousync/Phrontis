import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense, type ReactNode } from 'react'
import { Trash2, Eye, Star, FileText, ExternalLink, X, ChevronRight, ChevronLeft, Plus, ImagePlus, StickyNote, Link2, BookOpen, ListChecks, Sparkles, Info, FolderSearch, Copy, Maximize, Square, RotateCcw, RotateCw, Search, Replace, Pencil, FolderInput, Files, Crosshair, PanelRight, PanelTop, Tag, Download, AlertTriangle } from 'lucide-react'
import { MarkdownPreview } from '../../../components/shared/MarkdownPreview'
import { MindMapView } from '../../../components/shared/MindMapView'
import { looksLikeMindMap } from '../../../lib/mindmap'
import { QuizMode } from '../../../components/shared/QuizMode'
import { extractQuizzes } from '../../../components/shared/QuizParser'
import type { KnowledgePage, KnowledgeCategory, KnowledgeTag, KnowledgeBacklinkItem } from '../../../types'
import { getKnowledgePageById, updateKnowledgePage, getKnowledgeBacklinkContext, getKnowledgeManualLinks, addKnowledgeManualLink, removeKnowledgeManualLink, createKnowledgePage, updateKnowledgeLinks, toggleKnowledgeStar, getSetting, setSetting, resolveAttachmentRel, openExternal, getKnowledgeTags, createKnowledgeTag, getAttachmentPath, workspaceReadFile, workspaceWriteFile, workspaceGetCurrent, workspaceOpenInSystem } from '../../../lib/ipc'
import { splitFrontmatter, joinFrontmatter, ensureFrontmatterId, bumpFrontmatterUpdated } from '../../../lib/frontmatter'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { uploadImageFile, isImageFile, imageMarkdown, IMAGE_OWNER } from '../../../lib/editorImage'
import { FILE_LANG_OPTIONS, getFileTypeInfo } from '../../../lib/fileTypes'
import { isEditingInput } from '../../../lib/shortcuts'
import { resolveVaultRel } from '../../../lib/vaultLink'
import { getGlobalActiveTab } from '../../../lib/activeTab'
import { visibleKnowledgeTags } from '../../../lib/knowledgeTags'
import { ConfirmDialog } from '../../../components/shared'
import { ResizablePanel } from '../../../components/shared/ResizablePanel'
import { WelcomeHtmlView } from './WelcomeHtmlView'
import { FileMetaCard } from './FileMetaCard'
// 文件信息行（批 3 起住在 shared：图片异常态卡也要用，shared 反向依赖 module 是层次倒挂）
import { FileInfoRows } from '../../../components/shared/FileInfoRows'
// 目录选择弹层（「将文件移动到…」）：与文件树右键同一个组件，本组件只负责给它一个定位槽
import { DirPicker } from '../../../components/shared/DirPicker'
import { NoteTopBar } from './NoteTopBar'
import { ArchiveTextView } from './ArchiveTextView'
import { isTextViewableExt } from '../../../lib/aiTextExts'
// 图片查看（批 3，2026-10-13）：画布与控件簇都是**受控纯视图**，视图态的真源在本组件 ——
// 控件位拍板 D7 = 顶栏内联，而顶栏在图片视图上方，组件没法往祖先的槽里塞东西（除非 portal，
// 批 2 已否决）。几何算式一律走 lib/imageView.ts（纯函数 + 契约脚本）。
import { ImageViewer } from '../../../components/shared/image/ImageViewer'
import { ImageToolbar } from '../../../components/shared/image/ImageToolbar'
import { ImageStateCard } from '../../../components/shared/image/ImageStateCard'
import { useVaultImage } from '../../../components/shared/image/useVaultImage'
import { useImageView } from '../../../components/shared/image/useImageView'
import { useImageViewKeys } from '../../../components/shared/image/useImageViewKeys'
import { imageMayHaveAlpha, isRenderableImageExt } from '../../../lib/imageFormats'
import type { ViewBox } from '../../../lib/imageView'
import Editor, { type OnMount } from '@monaco-editor/react'
// 共享 Monaco 宿主（P1b）：就地编辑换用与编辑器模块同一份装配——[[ 补全 / B4 内联建议 /
// 淡化装饰 / 粘贴与拖图拦截全部随之带入；legacy <Editor> 分支仅服务非 vault 旧数据兜底
// 共享写作面宿主（双写作面方案 2026-10-09）：源码档 Monaco / 即时渲染档 CM6 由设置二选一，
// 右键菜单与「[[ 补全 / 图片 / 脚注」在两档同源；本组件只经 NoteSurfaceHandle 契约操作。
import { NoteSurface, type NoteSurfaceHandle } from '../../../components/shared/NoteSurface'
import { cancelInlineSuggestInFlight } from '../../../components/shared/MonacoPane'
import { runNoteAction } from '../../../lib/noteActions'
import { invalidateWikiCache } from '../../../lib/wikiLinkSuggest'
import type { NoteEngineId } from '../../../lib/noteEngine'
import { MonacoErrorBoundary } from '../../../components/shared/MonacoErrorBoundary'
import type * as Monaco from 'monaco-editor'
import { bindEditorTheme } from '../../../lib/editorTheme'
// Monaco 运行时装配下沉到宿主组件：不随应用入口进首屏 chunk（性能 2026-09-10）
import '../../../lib/monaco-setup'
// PDF 阅读器（Phase 2 批次 2）：共享层组件内嵌知识库——编辑器退役后阅读承载移到本模块
const PdfReaderView = lazy(() => import('../../../components/shared/pdf/PdfReaderView').then((m) => ({ default: m.PdfReaderView })))

/* ===== ⋮ 菜单的条目原语（2026-10-13「能力补齐」时抽出）=====
   为什么抽：⋮ 里每一项原本都是 5 行样板（图标 + 文案 + 可选键位 + 悬停态 + 危险色），
   本轮要往两个分支各补好几条，照原样复制就是几十行重复代码；抽出来后新增一条只写一行，
   **样式与键帽也只剩一处**（改一次两处一起变）。

   ★ 键位提示走 `.kb-kbd` 键帽（2026-10-13 F-2 统一的那套令牌）：此前 ⋮ 里是裸
     `text-[10px] text-[var(--text-secondary)]`，与命令面板的键帽是两种视觉、两种对比度。

   ★ 二级菜单（复制路径 ▸）**往左开**：⋮ 本身贴在窗口右缘，往右必出屏 —— 与同文件已有的
     「文件格式 ▸」（`right-[calc(100%+4px)]`）同一口径。

   ★ **分组标题已整条去掉**（2026-10-13，开发者反馈「不用这个小标题，菜单就能短一截」）：
     6 个标题（页面 / 写作 / 编辑 / 布局 / 文件 / 系统）合计占掉约一成高度，而它们提供的信息
     分隔线已经给了（分组边界 = 那条横线）。⇒ 现在只剩 `MoreSep`，不再有 `MoreGroup`。
     注意：原来「系统」那组**没有**自己的分隔线（靠标题分隔），去标题时必须补一条，
     否则「导出为 PDF…」与「在系统中打开」会黏成一块。 */
function MoreSep() {
  return <div className="my-1 border-t border-[var(--border-color)]" />
}
function MoreItem({ anchor, icon, label, kbd, danger, disabled, onClick }: {
  anchor?: string; icon: ReactNode; label: string; kbd?: string; danger?: boolean; disabled?: boolean; onClick: () => void
}) {
  return (
    <button data-wb={anchor} disabled={disabled} onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] transition-colors ${disabled
        ? 'cursor-default text-[var(--text-disabled)]'
        : danger
          /* 危险条（删除）**常亮红**（2026-10-13 开发者反馈「最后的删除按钮标成红色」）：
             文案与图标的两个字面量与共享的 `FileContextMenu` 危险项**逐字符相同** ——
             同一个语义在 ⋮ 与文件/编辑器右键两处必须同款，否则同一件事两种长相。
             ★ 已量：`--danger` 当文字在菜单底上，默认深色 3.31:1、14 套主题最低 2.89:1（12px 小字 AA 线 4.5）。
               阈值不达标的取舍与抬亮候选留在 `docs/v3.5.0-feedback.md` F-3，改一处即可切换。 */
          ? 'text-[var(--danger)] hover:bg-[var(--bg-hover)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
      {icon}
      {label}
      {kbd && <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">{kbd}</span>}
    </button>
  )
}
/** 二级子菜单（复制路径 ▸ / 文件格式 ▸ 共用一段）。
 *
 *  ★ **往左开**（`right-[calc(100%+4px)]`）：⋮ 贴在窗口右缘，往右必出屏。
 *  ★ **放不下就朝上开**（2026-10-13 起必需）：⋮ 现在被封顶 + 内部滚动（见 NoteTopBar 的 `menuMaxH`），
 *    贴底的子菜单会被这个滚动容器切掉半截 —— 打开前比一次「本行下方还剩多少」，
 *    不够就把子菜单改成**底对齐**（`bottom:-5`），它便朝上长出容器。
 *    `need` 是按行高估的（12px 字 + py-1.5 ≈ 27px/行，另加容器 py-1 的 8px），再乘 1 行余量 ——
 *    只用来决定「朝上还是朝下」，估偏一行无副作用。
 *  ★ `note` = 行尾说明（文件格式右侧那个「Markdown」），与键帽同槽位，二选一。
 *  ★ `active` = 子菜单里的当前项（文件格式用），给 `bg-selected` 底。 */
function MoreSub({ anchor, icon, label, note, items }: {
  anchor?: string; icon: ReactNode; label: string; note?: string
  items: Array<{ label: string; onSelect: () => void; active?: boolean }>
}) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const openAt = (): void => {
    const el = btnRef.current
    const box = el?.closest('[data-wb="noteTopMoreMenu"]') as HTMLElement | null
    if (el && box) {
      const r = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const need = items.length * 27 + 8 + 27
      setFlip(r.bottom + need > b.bottom && r.top - need > b.top)
    }
    setOpen(true)
  }
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <button ref={btnRef} data-wb={anchor} onMouseEnter={openAt} onClick={() => (open ? setOpen(false) : openAt())}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
        {icon}{label}
        {note && <span className="ml-auto shrink-0 text-[10px] text-[var(--text-secondary)]">{note}</span>}
        <ChevronRight size={12} className={`${note ? '' : 'ml-auto '}shrink-0 opacity-60`} />
      </button>
      {open && (
        <div style={flip ? { bottom: -5 } : { top: -5 }}
          className="kb-pop origin-top-right absolute right-[calc(100%+4px)] z-50 max-h-72 w-40 overflow-y-auto overscroll-contain rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl">
          {items.map(it => (
            <button key={it.label} onClick={it.onSelect}
              className={`w-full px-3 py-1.5 text-left text-[12px] transition-colors ${it.active
                ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 布局组（左右 / 上下分屏，2026-10-13 批 1b）：md 与非 md 两个分支共用同一段 ——
 *  分屏此前只藏在页签右键里，同一个动作两个入口只给了一个。`disabled` 与页签右键同源。 */
function MoreSplitGroup({ disabled, onPick }: { disabled: boolean; onPick: (o: 'row' | 'column') => void }) {
  return (
    <>
      <MoreSep />
      <MoreItem anchor="peSplitRow" icon={<PanelRight size={13} />} label="左右分屏" disabled={disabled}
        onClick={() => onPick('row')} />
      <MoreItem anchor="peSplitCol" icon={<PanelTop size={13} />} label="上下分屏" disabled={disabled}
        onClick={() => onPick('column')} />
    </>
  )
}

/* 「笔记属性」的 frontmatter 读改住在 `src/lib/fmProps.ts`（零依赖纯函数）——
   放 lib 才能被契约脚本直接 import 做真值断言（这里是「会不会静默毁数据」的地方，
   必须真跑而不是拿源码文本猜）。头注里写着核心纪律：**绝不重建整块前缀**。 */
import { parseFmPropRows, applyFmPropRows, type FmPropRow } from '../../../lib/fmProps'

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
  /** 草稿直入编辑（Phase 2 批次 1）：无 frontmatter id 文件的相对路径——页签 id 为 `draft:<relPath>`，
   *  走同一套脏状态机与 vault 写路径；无 frontmatter id 的文件在**首次保存时自动补 id**
   *  （ensureFrontmatterId，2026-09-20 身份统一：门槛消失、用户零操作） */
  draftRelPath?: string
  /** 该页本次打开直接进编辑态（2026-09-28 快速草稿：+ 号建 草稿.md 后打开即写）；
   *  只影响首载那次（loadPage 的 !isReload 分支），不影响该页后续的阅读/编辑切换 */
  startInEdit?: boolean
  /** 首载即知的文件类型（模块页签元信息 openPageInfos）：顶栏与格式标签依赖它，
   *  不预置则 loadPage 完成前会先按 '' 渲染一帧（表象：顶栏 / 格式标签闪一下）。 */
  initialFileType?: string
  /** 顶栏左端「页面历史」四件（2026-10-11 对齐 Obsidian）：栈在模块层，这里只消费结果 */
  canNavBack?: boolean
  canNavForward?: boolean
  onNavBack?: () => void
  onNavForward?: () => void
  /* ===== ⋮ 的文件级动作（2026-10-13 批 1b「能力补齐」）=====
     这六件事的**实现留在模块层**：改名 / 移动会改仓库相对路径，必须连带刷新文件树与页签
     （页签的 id 与 relPath 绑着），删要走系统回收站 + 危险确认 + 连带关页签，分屏归页签组管。
     本组件只发请求，自己一律不动盘。全部可选：没传就**不出现**（不做点了没反应的假按钮）。 */
  /** 重命名：`newName` 是含扩展名的文件名，模块层走 handleTreeRename（含分类通道与撤销栈） */
  onRenameRequest?: (relPath: string, newName: string) => void
  /** 将文件移动到…：`targetDirRel` 为空串表示仓库根 */
  onMoveRequest?: (relPath: string, targetDirRel: string) => void
  /** 创建副本（模块层 duplicateWorkspaceFile + 刷新父目录） */
  onDuplicateRequest?: (relPath: string) => void
  /** 在文件列表中显示当前文件：切到文件视图 + 展开祖先目录 + 滚进视野 */
  onLocateRequest?: (relPath: string) => void
  /** 删除：模块层 handleTreeDelete（系统回收站 + 危险确认 + 连带关页签）。
   *  ★ 没接这个 prop 时回落本组件原来的 `handleDelete`；接了就走真删除 ——
   *  原路在仓库模式下是**假按钮**（`handleDelete` 第一句 `if (vaultMode)` 就弹提示返回，
   *  而知识库模块**恒传** `vaultMode={true}`）。 */
  onDeleteRequest?: (relPath: string) => void
  /** 左右 / 上下分屏（页签右键同款动作） */
  onSplitRequest?: (orientation: 'row' | 'column') => void
  /** 分屏已满（页签右键那条会置灰，这里同步） */
  splitDisabled?: boolean
  /** 导出为 PDF（2026-10-13 批 3）：模块层负责「保存对话框 → 临时进沉浸阅读态 → 打印 → 还回去」，
   *  本组件只发请求 —— 沉浸态归模块层（`readingMode`），PageEditor 管不到它。 */
  onExportPdfRequest?: () => void
}

export function PageEditor({ pageId, categories, allPages, zoom = 1, onBack, onDeleted, onNavigate, onUpdate, onTitleChange, onFileTypeChange, onContentChange, onTagsChange, onMarkDirty, onClearDirty, onRequestReading, vaultMode = false, draftRelPath, startInEdit = false, initialFileType = '', canNavBack = false, canNavForward = false, onNavBack, onNavForward, onRenameRequest, onMoveRequest, onDuplicateRequest, onLocateRequest, onDeleteRequest, onSplitRequest, splitDisabled = false, onExportPdfRequest }: Props) {
  const { s, update } = useSettings()
  const [page, setPage] = useState<KnowledgePage | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [fileType, setFileTypeState] = useState(initialFileType)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  /** ⋮ 里「文件信息」小卡（批 1）：文本类不再落元信息卡后，路径 / 尺寸 / 修改时间的落点 */
  const [showFileInfo, setShowFileInfo] = useState(false)
  /** html 的「源码 ⇄ 沙箱渲染」（批 1 拍板：默认仍是沙箱渲染，只加出口）。
   *  换页重置——不同 html 之间不该继承上一个的源码态。 */
  const [htmlSource, setHtmlSource] = useState(false)
  /**
   * md 的「查看源码 / 看渲染」（2026-10-13）：**本页临时**的档位覆盖，`null` = 跟随设置
   * `editorWritingMode`。刻意不落设置 —— 全局档位仍归设置页管，这里只是「这一页我想看一眼原文」。
   * 换页重置（同 htmlSource 口径）：不同笔记之间不该继承上一个的源码态。
   */
  const [srcOverride, setSrcOverride] = useState<boolean | null>(null)
  /* 换页重置（批 1 的 html 源码态 + 批 2 的 PDF 上报值 + md 的临时档位）：不同文件之间不该继承上一个的态。
     pdfPages / pdfImmersive 必须在这里复位 —— PdfReaderView 按 page.path 重挂，它的内部
     `immersive` 归零，外层不复位就会「换到别的文件顶栏仍然不显示」。 */
  useEffect(() => {
    setHtmlSource(false); setSvgSource(false); setPdfPages(0); setPdfImmersive(false); setSrcOverride(null); setInlineBacklinks(false)
    // 图片视图态由 useImageView 的 resetKey 复位（传 page.path），此处不再手动 set
  }, [pageId])
  /** 「文件信息」小卡的关闭：外点 / Esc（照 NoteTopBar 的 moreMenu 口径，捕获阶段不依赖冒泡顺序） */
  useEffect(() => {
    if (!showFileInfo) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('[data-wb="peFileInfoCard"],[data-wb="peFileInfo"]')) return
      setShowFileInfo(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setShowFileInfo(false) }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [showFileInfo])
  /* ===== ⋮ 的两个弹层（2026-10-13 批 1b）=====
     都与「文件信息」小卡共用 ⋮ 正下方那个槽位（`absolute right-2 top-full kb-pop`），
     所以**同一时刻只开一个**（打开任一个前先把另两个关掉）。 */
  /** 重命名：输入框放这儿，**不复用树内联改名** —— 树可能收起 / 侧栏关着 / 停在大纲页，
   *  那时内联输入行根本不渲染，表象就是「点了没反应」。 */
  const [showRename, setShowRename] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  /** 将文件移动到…：内容直接用共享 DirPicker（它只管内容与键盘，定位交给宿主） */
  const [showMove, setShowMove] = useState(false)
  /** 笔记属性（2026-10-13 批 4）：编辑 frontmatter 的单行属性；只读项见 parseFmPropRows 的头注 */
  const [showProps, setShowProps] = useState(false)
  const [propRows, setPropRows] = useState<FmPropRow[]>([])
  useEffect(() => {
    if (!showRename && !showMove && !showProps) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('[data-wb="peRenameCard"],[data-wb="peRename"],[data-wb="peMoveCard"],[data-wb="peMove"],[data-wb="pePropsCard"],[data-wb="peProps"]')) return
      setShowRename(false); setShowMove(false); setShowProps(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setShowRename(false); setShowMove(false); setShowProps(false) } }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [showRename, showMove, showProps])
  // 换页复位：弹层不该跨页留着（与上面那批档位复位同口径）
  // 换页复位（F-7 追加 loadMiss）：上一个 pageId 的"取不到"提示不该跟着新页继续挂着
  useEffect(() => { setShowRename(false); setShowMove(false); setShowProps(false); setLoadMiss(null) }, [pageId])
  // 知识库以阅读优先:md/txt 页面打开即预览(右上角眼睛或 Ctrl+E / Ctrl+/ 切回编辑;vault 模式就地保存)
  const [preview, setPreview] = useState(true)
  // startInEdit 的 ref 镜像：loadPage（useCallback 依赖不含该 prop）在 effect 里读最新值
  const startInEditRef = useRef(startInEdit)
  startInEditRef.current = startInEdit
  // 编辑器保活（2026-09-20 反馈「切换要迅速」）：首入编辑态才挂 MonacoPane，此后阅读态 display:none
  // 藏起不卸载——Monaco 编辑器创建是切换延迟的大头（~200ms），保活后二次切换零重挂、即时出。
  // reveal 时 bump layoutKey（display:none 期间容器尺寸为 0，需要显式 layout()）。
  const [editorEverMounted, setEditorEverMounted] = useState(false)
  const [editRevealTick, setEditRevealTick] = useState(0)
  useEffect(() => {
    if (preview) return
    setEditorEverMounted(true)
    setEditRevealTick(t => t + 1)
  }, [preview])
  const [backlinks, setBacklinks] = useState<KnowledgeBacklinkItem[]>([])
  /** 内联反链开关（2026-10-13 批 2「在标签页中显示反向链接」）：**本页临时**、换页复位、不写设置 ——
   *  右栏「关联网络」已经是常驻入口，这是「这一篇我想在正文末尾顺手看一眼谁引用了我」。
   *  只在**阅读态**生效（编辑态下写作面占满整块，下面没有位置放它，见 ⋮ 那枚开关的门控）。 */
  const [inlineBacklinks, setInlineBacklinks] = useState(false)
  /** 跨页定位：点「被引用」条目 → 记下 {源页里引用本页的链接文本, 源页 rel}，待源页正文就绪后定位高亮 */
  const [pendingLocate, setPendingLocate] = useState<{ title: string; relPath: string } | null>(null)
  /** 高亮态：关联网络定位到的 wiki 标题（传给 MarkdownPreview 的 highlightWiki；1.7s 后清） */
  const [flashWiki, setFlashWiki] = useState<string | null>(null)
  // 手动关联（双向）
  const [manualLinks, setManualLinks] = useState<KnowledgePage[]>([])
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkQuery, setLinkQuery] = useState('')
  // 注解层已整条移除（2026-09-21 反馈「这个注解现在又用不了」）：vaultMode 恒 true（R6 D9 后），
  // 该栏 textarea 永远 readOnly、saveAnnotation 永远 early-return —— 死 UI + 死代码。
  // `savedAnnotationRef` 保留：它仍参与既有页面的双链解析（见 save 里的 parseWikiLinks）。
  const savedAnnotationRef = useRef('')
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
  /** PDF 页数 / 沉浸态（批 2）：由内嵌 PdfReaderView 上报 —— 顶栏中段的「N 页」与
   *  「沉浸时顶栏一并隐藏」都靠它。★ 阅读器按 page.path 重挂，它的内部 state 归零而外层不会，
   *  故 pageId 变化时必须复位（见下方 setHtmlSource(false) 那个 effect）。 */
  const [pdfPages, setPdfPages] = useState(0)
  const [pdfImmersive, setPdfImmersive] = useState(false)
  /** SVG 源码态（批 3）：与 `htmlSource` 平行的一个开关。
   *  ★ 刻意**不**把 svg 加进 `TEXT_VIEWABLE_EXT_SET` —— 那个集合是「文本类落点候选」，
   *  加进去会让**每次打开 SVG** 都触发一次自读 + `setPreview(false)`（白读一遍 XML），
   *  只为了一个默认关闭的源码态。见下方 `svgSourceEditable`。 */
  const [svgSource, setSvgSource] = useState(false)
  const MAX_TAGS = 5
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const contentRef = useRef(content)
  const titleRef = useRef(title)
  const pageRef = useRef(page)
  const fileTypeRef = useRef(fileType)
  const tagsRef = useRef<KnowledgeTag[]>([])
  /** 阅读态正文滚动容器（引用/被引用条目定位高亮用） */
  const previewRef = useRef<HTMLDivElement>(null)
  const isDirtyRef = useRef(false)
  const savedContentRef = useRef('')
  /**
   * 自写广播守卫（2026-09-20 修「中文输入后光标跳文末」）：
   * 每次自动保存成功 → 主进程广播 → 模块派发 kb-reload-detail → 本组件重读页面并回灌 content。
   * 这条回灌对我们自己刚写的内容毫无价值，却会：① 撞上输入法停顿（那个停顿正是 debounce 触发点），
   * ② 若写盘后又敲了几个字，磁盘版比模型旧 → 回灌会把新字吞掉。
   * 故记下「刚刚自己写盘」的时刻，窗口期内忽略重读；真外部改动走 onWsExternalChange 通道。
   */
  const selfSavedAtRef = useRef(0)
  const savedTitleRef = useRef('')
  const monacoRef = useRef<typeof Monaco | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const pageIdRef = useRef(pageId)
  /** 已重试过的 pageId（索引重建延迟：新建/转正后立即打开时 getKnowledgePageById 可能 404 一次） */
  const retryRef = useRef<string | null>(null)
  /* ===== 装载态（2026-10-13，F-7）=====
     反馈：「从一个空文件切换到其他文件时，切过去的那个文件不显示内容」。
     已核的代码事实：`loadPage` 取不到页面时**不设置任何状态、也不清空内容** ⇒ 界面**静默停在上一页的正文**上。
     从**空**文件切走时"停在空白"看起来就是「新文件没内容」；从有内容的文件切走时上一页正文还在，
     看起来"正常显示" —— 两条症状其实是同一个缺陷的两种表象（**"有内容那半"是假正常**）。
     处置：① 取不到 → 给一句能看见的话 + 重试钮（`loadMiss`），不再静默、也不再默默 `onBack()`；
           ② 三条异步装载链补"迟到即丢弃"的守卫（见 `loadPage` / `loadVaultBaseline` / `loadDraftPage`）；
           ③ 归档类（非 md）正文由自读 effect 补，而它原来不会在 isReload 重读后重跑 ⇒ 补 `selfReadTick`。 */
  const [loadMiss, setLoadMiss] = useState<string | null>(null)
  const [selfReadTick, setSelfReadTick] = useState(0)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const showDeleteConfirmRef = useRef(showDeleteConfirm)
  /** PDF 沉浸态的 ref 镜像（批 2）：Esc 守卫要用它，而那个 keydown effect 的依赖刻意只有
   *  `[doSave, onBack]`（把 state 塞进去会让每次沉浸切换都重挂监听）。 */
  const pdfImmersiveRef = useRef(false)
  const isCodeFileRef = useRef(false)
  const isPdfFileRef = useRef(false)
  const vaultModeRef = useRef(vaultMode)
  // 共享写作面句柄（P1b / 双写作面 2026-10-09）：大纲跳转 / 插图 / 脚注经契约下达，
  // 不直接依赖某个引擎（源码档 Monaco 与即时渲染档 CM6 同签名）
  const paneRef = useRef<NoteSurfaceHandle | null>(null)
  // B4 内联建议请求态/暂停态（知识库编辑态的可观测信号；Phase 2 批次 2 随编辑器退役补齐入口）
  const [inlineBusy, setInlineBusy] = useState(false)
  const [inlinePaused, setInlinePaused] = useState(false)
  /** B-5 方案 D：每次「进入暂停」只提示一次（唤醒后复位，下一轮再暂停仍会提示） */
  const inlinePauseNotifiedRef = useRef(false)
  /**
   * 自动通道进入 / 离开暂停。**除角标外要给一次可见提示**（B-5 方案 D）：
   * 原先暂停的唯一信号是 ✨ 钮右上角 1.5px 灰点，而它当时挂在**右上悬浮胶囊**里 ——
   * 那颗胶囊静息态还会 `opacity: .62 + scale(.97)` → 灰点基本看不见，用户只会觉得
   * 「AI 建议莫名其妙没了」。（批 2 起 ✨ 已随顶栏行内渲染，胶囊整条退役；这条提示仍然保留 ——
   * 灰点本身依旧是弱信号，不能只靠它。）
   * 回调来自 MonacoPane 的模块级广播（宿主侧 setState），只可能发生在事件回调里，不会撞 render 期。
   */
  const handleInlinePaused = useCallback((paused: boolean) => {
    setInlinePaused(paused)
    if (!paused) { inlinePauseNotifiedRef.current = false; return }
    if (inlinePauseNotifiedRef.current) return
    inlinePauseNotifiedRef.current = true
    showToast({ type: 'info', message: 'AI 续写建议已暂停', detail: '连续几条没被采纳，自动通道先歇一会。按 Alt+A 可随时要一条' })
  }, [])
  // 就地编辑（笔记合并 Phase 1，docs/notes-merge-phase1-design.md §1.1）：
  // vault 写路径三件套 = 当前仓库 rootId + 装载时的 frontmatter 前缀 + mtime 冲突基线
  const vaultRootRef = useRef<string | null>(null)
  /** 渲染用 rootId —— **state，不是 ref**（批 1，2026-10-12 修竞态）。
   *
   *  病根：PDF 阅读器的渲染条件依赖 rootId，而 `vaultRootRef` 是 ref ⇒ 改它不触发重渲染。
   *  而 rootId 与页面数据是 `loadPage` 里**两条并发 IPC 链**（`workspaceGetCurrent` vs
   *  `getKnowledgePageById`），谁先落地不确定：页面数据先到就渲染一次，那时 rootId 还是 null
   *  ⇒ 仓库内 PDF 落到「旧版附件不在仓库内，请使用本地工具打开」的降级分支，
   *  之后 rootId 填上也**再没有一次重渲染**把它救回来。
   *
   *  `vaultRootRef` 保留：`doSave` / `handleArchiveOpenInSystem` 需要**同步**读它
   *  （保存路径里不能再 await 一次当前仓库）。两者一律经 `adoptVaultRoot` 同步写入，不各写各的。 */
  const [vaultRootId, setVaultRootId] = useState<string | null>(null)
  const adoptVaultRoot = useCallback((id: string | null) => {
    vaultRootRef.current = id
    setVaultRootId(prev => (prev === id ? prev : id))
  }, [])
  const vaultPrefixRef = useRef('')
  const vaultMtimeRef = useRef(0)

  /** 归档文件「在系统中打开」/「在文件夹中显示」（B-3 方案 B）：经主进程 ws:openInSystem
   *  （rootId + relPath → requireInside 解析后 shell.openPath / showItemInFolder）。
   *  ★ 不走通用的 openExternal：它只放行 userData 目录内的路径，仓库文件会被安全拦截挡掉。 */
  const handleArchiveOpenInSystem = useCallback(async (reveal: boolean) => {
    const rel = pageRef.current?.path
    if (!rel) { showToast({ type: 'warning', message: '该条目没有关联的仓库文件' }); return }
    if (!vaultRootRef.current) {
      const cur = await workspaceGetCurrent()
      adoptVaultRoot(cur?.rootId ?? null)
    }
    const root = vaultRootRef.current
    if (!root) { showToast({ type: 'warning', message: '当前没有打开的仓库' }); return }
    const res = await workspaceOpenInSystem(root, rel, reveal)
    if (!res?.ok) showToast({ type: 'error', message: res?.error || '打开失败' })
  }, [])

  /** 复制路径（2026-10-13 能力补齐）：一档扩成**二级两档** —— 「仓库相对路径」直接复制，
   *  「完整路径」取当前仓库根拼前缀。与模块层 `copyPathText`（knowledge/index.tsx）同一口径、
   *  同一个主进程剪贴板通道（渲染层不直连 `navigator.clipboard`）。 */
  const handleCopyPath = useCallback(async (mode: 'rel' | 'abs') => {
    const rel = pageRef.current?.path
    if (!rel) { showToast({ type: 'warning', message: '该条目没有关联的仓库文件' }); return }
    try {
      let text = rel
      if (mode === 'abs') {
        const cur = await workspaceGetCurrent()
        if (!cur?.path) { showToast({ type: 'error', message: '未打开仓库' }); return }
        text = `${cur.path.replace(/\\/g, '/')}/${rel}`
      }
      const { copyText } = await import('../../../lib/ipc')
      const ok = await copyText(text)
      if (ok) showToast({ type: 'success', message: mode === 'abs' ? '已复制完整路径' : '已复制相对路径', detail: text })
      else showToast({ type: 'error', message: '复制失败' })
    } catch { showToast({ type: 'error', message: '复制失败' }) }
  }, [])

  /** 查找 / 替换（2026-10-13 能力补齐）：直接跑 Monaco 的两个内置 action，不另写一套查找 UI。
   *  ★ 即时渲染档（CM6）没有 Monaco（`getEditor()` 返回 null）⇒ 菜单里**不出现**这两项
   *    （见 md 分支的 `canFindReplace` 门控），与 `ed-find` 只在源码档生效的现状一致。 */
  const runEditorAction = useCallback((action: 'actions.find' | 'editor.action.startFindReplaceAction') => {
    const ed = paneRef.current?.getEditor()
    if (!ed) { showToast({ type: 'warning', message: '查找 / 替换只对源码档可用' }); return }
    ed.focus()
    void ed.getAction(action)?.run()
  }, [])

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
  /** 归档文本类：扩展名命中 TEXT_VIEWABLE_EXT_SET —— 批 1 起这是**可编辑落点的候选集合**。
   *  含 json / 配置类，比「AI 可读」名单宽（只需"能解码成文本"，不涉写入）。
   *  ★ 编辑入口就锁在这个集合内（批 1 拍板 2026-10-12）：主进程 `ws:writeFile` 没有扩展名白名单，
   *  所以「能编辑哪些文件」这件事只由渲染层这一处决定 —— 改它就是改能力面，不是改样式。 */
  const isArchiveTextView = isArchiveFile && !isArchiveHtml && isTextViewableExt(fileType)

  /** 图片页（批 3）：仓库内可渲染的图片文件 → 独立查看器落点。
   *  ★ 取名 `isImagePage` 而不是 `isImageFile`：本文件已从 `editorImage` 导入了同名的
   *  `isImageFile(file: File)`（判**上传的 File 对象**，插图路径用），重名会把它遮蔽掉。 */
  const isImagePage = isArchiveFile && isRenderableImageExt(fileType)
  const isSvgImage = isImagePage && fileType === 'svg'
  /** SVG 源码态：与 `htmlSourceEditable` 平行。为真时图片分支返回 null，把这一格让给
   *  下方 `paneDoc` 的 Monaco（XML 高亮）—— 形态与 html 那格完全一致。 */
  const svgSourceEditable = isSvgImage && svgSource && !!page?.path

  /** 文本类归档文件的**自读结果**（批 1）。索引对 entryKind:'file' 不读内容
   *  （knowledgeIndex.ts 注释「不读内容（二进制可能很大）」），所以落点只能由自读结果决定：
   *    · `binary` / `oversize-open`（>50MB） ⇒ 退回元信息卡（无法按文本打开）
   *    · `oversize-edit`（>10MB，主进程 `editable:false`） ⇒ ArchiveTextView 只读打开
   *    · 其余 ⇒ 可编辑 MonacoPane（正文灌进 content，走既有脏状态机 + 自动保存）
   *  `null` = 尚未读回 / 不适用。 */
  const [textFile, setTextFile] = useState<{ editable: boolean; reason: 'binary' | 'oversize-open' | 'oversize-edit' | null } | null>(null)
  /** html 的源码态：走文本落点（可编辑 MonacoPane）。默认 false = 沙箱渲染（拍板：默认不变，只加出口）。
   *  欢迎页与归档 html 都适用（两者共用 WelcomeHtmlView 渲染分支）。 */
  const htmlSourceEditable = (isWelcomeHtml || isArchiveHtml) && htmlSource && !!page?.path
  /** 文本类是否走文本落点（可编辑 or 超限只读）—— 二进制 / 超大打开不进这里，落元信息卡 */
  const archiveTextOpenable = isArchiveTextView && textFile !== null
    && textFile.reason !== 'binary' && textFile.reason !== 'oversize-open'
  /** 需要按需自读正文的目标：归档文本类 + html 源码态 + svg 源码态（三者的索引正文都是空的） */
  const textSelfReadTarget = isArchiveTextView || htmlSourceEditable || svgSourceEditable

  /** 就地编辑的共享宿主文档（P1b）：可编辑文本类 + 仓库内路径才走 MonacoPane；
   *  modelPath 命名空间防与编辑器模块同名文件共享 Monaco model（onChange/外部监听会打架）。
   *  批 1：归档文本类与 html 源码态也走这里，归档用 `kb://archive-edit/…`（与知识页正文隔离）。 */
  const paneDoc = vaultMode && page?.path && !isPdfFile
    // 图片：只有「SVG 且切到源码态」才落可编辑 Monaco；渲染态图片没有可编辑的正文
    && (!isImagePage || svgSourceEditable)
    && (!isWelcomeHtml || htmlSourceEditable)
    && (!isArchiveFile || archiveTextOpenable || htmlSourceEditable || svgSourceEditable)
    ? {
        relPath: page.path,
        modelPath: isArchiveFile ? `kb://archive-edit/${page.path}` : `kb://knowledge/${page.path}`,
        content,
        language: getFileTypeInfo(fileType).monacoLang,
        binary: false,
        editable: true,
        truncated: false,
        size: content.length,
      }
    : null
  /** 思维导图 JSON：按内容识别（判别字段 kind:"mindmap"）→ 渲染共享 MindMapView。
   *  笔记区 / 文件树 / kb-open-note 打开均命中此处（导图 JSON 非 .md 知识页，不出现在知识库目录树）。
   *  ★ 归档 `.json` 页的 `content` 从不加载（走元信息卡），故必须**主动读一次**文件做判别。 */
  const [isMindMapFile, setIsMindMapFile] = useState(false)
  useEffect(() => {
    if (fileType !== 'json' || !page?.path) { setIsMindMapFile(false); return }
    let alive = true
    void (async () => {
      try {
        const cur = await workspaceGetCurrent()
        const rid = (cur as { rootId?: string } | null)?.rootId
        if (!rid) return
        const r = await workspaceReadFile(rid, page.path as string)
        if (alive && r && typeof r.content === 'string') setIsMindMapFile(looksLikeMindMap(r.content))
      } catch { /* 读取失败即非导图 */ }
    })()
    return () => { alive = false }
  }, [fileType, page?.path])

  /** 文本类归档文件：按需自读 → 决定落点（批 1）。
   *
   *  为什么必须自读：索引对 `entryKind:'file'` 的正文恒为空，`loadPage` 灌进 content 的是 `''`，
   *  不读就只会渲染出一个空编辑器。`ArchiveTextView` 用同一手法（「给 path 自读」约定）。
   *
   *  ★ 三条硬纪律：
   *   ① **超限不灌 content**：>10MB 走 `ArchiveTextView` 自读，不把 10MB 字符串塞进本组件的
   *      `content` state —— 那会让自动保存的脏态比较和一批派生计算（题号 / 双链）白跑一遍。
   *   ② **绝不 `splitFrontmatter`**：非 md 没有 frontmatter 语义，而一个以 `---` 开头的 `.py`
   *      会被切掉开头（`loadVaultBaseline` 只服务 md/txt，归档条目本就走 else 分支）。
   *   ③ **同步 `savedContentRef`**：否则灌进 content 的那一刻，自动保存的 effect
   *      （`content !== savedContentRef.current`）会立刻把刚读到的内容当成用户改动回写一次。 */
  useEffect(() => {
    if (!textSelfReadTarget || !page?.path) { setTextFile(null); return }
    let alive = true
    void (async () => {
      try {
        const cur = await workspaceGetCurrent()
        const root = cur?.rootId ?? null
        if (!root) return
        adoptVaultRoot(root)
        const r = await workspaceReadFile(root, page.path as string)
        if (!alive) return
        if (!r || r.error) { setTextFile({ editable: false, reason: 'binary' }); return }
        if (r.truncated) { setTextFile({ editable: false, reason: 'oversize-open' }); return }
        if (r.binary) { setTextFile({ editable: false, reason: 'binary' }); return }
        if (r.editable === false) {
          // >10MB：只读打开，正文交给 ArchiveTextView 自己读（纪律①）
          setTextFile({ editable: false, reason: 'oversize-edit' })
          return
        }
        const body = typeof r.content === 'string' ? r.content : ''
        vaultPrefixRef.current = ''                       // 纪律②：非 md 无 frontmatter 前缀
        vaultMtimeRef.current = typeof r.mtimeMs === 'number' && r.mtimeMs > 0 ? r.mtimeMs : 0
        setContent(body)
        savedContentRef.current = body                    // 纪律③
        isDirtyRef.current = false
        onContentChange?.(body)
        /* 纪律④「文本类落地 = 直接编辑」（批 1 拍板）：`loadPage` 的 setPreview 规则是
           `ft === 'txt'` ⇒ 阅读态，那是给 **txt 知识页**定的；归档 .txt 也要直接进编辑态，
           否则用户点开一个仓库里的 .txt 先看到的是 Markdown 渲染（而 .txt 并无 Markdown 语义）。 */
        setPreview(false)
        setTextFile({ editable: true, reason: null })
      } catch {
        if (alive) setTextFile({ editable: false, reason: 'binary' })
      }
    })()
    return () => { alive = false }
  }, [textSelfReadTarget, page?.path, pageId, selfReadTick])

  /* ==================== 图片查看（批 3） ==================== */

  /** 只在真落图片视图时启用取回 —— 其余类型传 null 让 hook 停在 idle，一个 IPC 都不发。
   *  SVG 源码态同样不取：那时要看的是 XML 文本，不是像素。 */
  const imgWanted = isImagePage && !svgSourceEditable && !!page?.path
  const img = useVaultImage(imgWanted ? vaultRootId : null, imgWanted ? (page?.path ?? null) : null)

  /** 权威尺寸：解码后由 `<img>` 的 naturalWidth/Height 回填；解码前是文件头解析值（可能为 null）。
   *  用 useMemo 稳住引用 —— 视图控制器以它为依赖。 */
  const natW = img.dims?.w ?? 0
  const natH = img.dims?.h ?? 0
  const imgNat = useMemo<ViewBox | null>(() => (natW > 0 && natH > 0 ? { w: natW, h: natH } : null), [natW, natH])
  /** 图片真的可交互（有像素）—— 控件、⋮ 的「查看」组、快捷键都以此为准 */
  const imgReady = img.status === 'ready' && !!imgNat

  /** 视图态控制器（几何算式在 lib/imageView.ts，两个宿主共用同一个 hook）。
   *  `resetKey` 传路径：缩放/旋转/平移是「这一张图」的状态，换图必须复位。 */
  const iv = useImageView(imgNat, page?.path ?? null)
  useImageViewKeys(imgReady, iv.fit, iv.rotate)

  /* ======================================================== */

  /** legacy 兜底分支（非 vault 旧数据）的 Monaco 实例；写作面操作一律走 paneRef 契约 */
  const activeEditor = () => editorRef.current
  /** 写作模式：设置值 → **本页临时覆盖**（⋮ 的「查看源码 / 看渲染」）→ 文档类型门槛
   *  （即时渲染只对 Markdown 生效，其余一律源码档）。
   *  `srcOverride` 只在内存里存活（换页复位），不写设置 —— 覆盖期间设置页显示的仍是全局档位，
   *  两者不冲突：设置决定默认，⋮ 只决定「这一页这次」。 */
  const settingIsLive = ((s.editorWritingMode as string) ?? 'source') === 'live'
  const effectiveSource = srcOverride ?? !settingIsLive
  const writingMode: NoteEngineId = (!effectiveSource && fileType === 'md') ? 'live' : 'source'
  /** ⋮ 那条菜单项显示哪个动作：按**点了会看到什么**给，不按当前档位。
   *  阅读态（渲染页）与即时渲染档都算「正在看渲染」⇒ 给「查看源码」；只有源码档（编辑态）给「看渲染」。 */
  const mdSourceItemShowsSource = preview || !effectiveSource
  /** 查找 / 替换的可达性（2026-10-13 能力补齐）：Monaco 只在「源码档 + 编辑态」看得见 ——
   *  阅读态下写作面是 `display:none` 保活（`paneRef` 拿得到实例但看不见），即时渲染档（CM6）
   *  压根没有 Monaco。两种情况跑 action 都是空动作 ⇒ 菜单里直接不出现（不做假按钮）。 */
  const canFindReplace = !preview && writingMode === 'source'

  useEffect(() => { contentRef.current = content }, [content])
  useEffect(() => { pageIdRef.current = pageId }, [pageId])
  useEffect(() => { titleRef.current = title }, [title])
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { fileTypeRef.current = fileType }, [fileType])
  useEffect(() => { tagsRef.current = entryTags }, [entryTags])
  useEffect(() => { showDeleteConfirmRef.current = showDeleteConfirm }, [showDeleteConfirm])
  useEffect(() => { pdfImmersiveRef.current = pdfImmersive }, [pdfImmersive])
  useEffect(() => { isCodeFileRef.current = isCodeFile }, [isCodeFile])
  useEffect(() => { isPdfFileRef.current = isPdfFile }, [isPdfFile])
  useEffect(() => { vaultModeRef.current = vaultMode }, [vaultMode])

  // Phase 2 批次 2：PDF 阅读器内嵌本模块（openPdfInReader 跳转通道随编辑器退役而移除）

  // 用本地工具打开 PDF
  const openPdfExternal = useCallback(async () => {
    let filePath: string | null = null
    if (page?.attachmentId) {
      filePath = await getAttachmentPath(page.attachmentId)
    }
    if (!filePath && page?.contentMd) filePath = await resolveAttachmentRel(page.contentMd)
    if (filePath) openExternal(filePath)
  }, [page])

  /** 就地编辑（vault 写路径）：装载时缓存 frontmatter 前缀与磁盘 mtime（冲突基线）。
   *  读失败 = 文件已被外部删除 → mtime 置 0，保存时按「重建」语义不带基线（同编辑器 missing 口径）。 */
  const loadVaultBaseline = useCallback(async (rel: string, expectPageId?: string) => {
    try {
      if (!vaultRootRef.current) {
        const cur = await workspaceGetCurrent()
        adoptVaultRoot(cur?.rootId ?? null)
      }
      const root = vaultRootRef.current
      if (!root) return
      const res = await workspaceReadFile(root, rel)
      /* 迟到即丢弃（F-7）：用户已经切到别的页时，这一份读的是**上一页**的文件 ——
         写进 ref 就等于把上一页的 frontmatter 前缀 / mtime 当成新页的保存基线
         （轻则保存时把 id/updated 写串，重则冲突检测用错基线）。 */
      if (expectPageId && pageIdRef.current !== expectPageId) return
      const fm = splitFrontmatter(res?.content ?? '')
      vaultPrefixRef.current = fm?.prefix ?? ''
      vaultMtimeRef.current = typeof res?.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : 0
    } catch {
      vaultPrefixRef.current = ''
      vaultMtimeRef.current = 0
    }
  }, [])

  /** 草稿装载（Phase 2 批次 1）：读原始文件 → body 进同一套脏状态机；frontmatter 前缀/mtime 进 vault 基线。
   *  pageRef 构造最小伪页（path 指向草稿文件），doSave 的 vault 分支零改动直接复用。
   *  isReload = keep-alive/广播重读：保持当前阅读/编辑态（否则自动保存写盘 → 广播 → 重读会把用户踢回阅读态）。 */
  const loadDraftPage = useCallback(async (rel: string, isReload = false) => {
    try {
      if (!vaultRootRef.current) {
        const cur = await workspaceGetCurrent()
        adoptVaultRoot(cur?.rootId ?? null)
      }
      const root = vaultRootRef.current
      if (!root) return
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'md'
      const title = dot > 0 ? name.slice(0, dot) : name
      // PDF：二进制不走文本读取——伪页只带 path，正文交给内嵌 PdfReaderView（按 relPath 自读）
      let body = ''
      if (ext !== 'pdf' && ext !== 'xmind') {
        const res = await workspaceReadFile(root, rel)
        const fm = splitFrontmatter(res?.content ?? '')
        vaultPrefixRef.current = fm?.prefix ?? ''
        vaultMtimeRef.current = typeof res?.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : 0
        body = fm ? fm.body : (res?.content ?? '')
      } else {
        vaultPrefixRef.current = ''
        vaultMtimeRef.current = 0
      }
      const pseudo = { id: `draft:${rel}`, path: rel, title, contentMd: body, fileType: ext, tags: [] } as unknown as KnowledgePage
      // 迟到即丢弃（F-7）：await 期间用户可能已经切到别的页 —— 不拦就会把这一页的正文/标题盖到新页上
      if (pageIdRef.current !== `draft:${rel}`) return
      setLoadMiss(null)
      pageRef.current = pseudo
      setPage(pseudo); setTitle(title); setContent(body); setFileTypeState(ext); setEntryTags([])
      savedContentRef.current = body; savedTitleRef.current = title; isDirtyRef.current = false
      savedAnnotationRef.current = ''
      onTitleChange?.(title); onContentChange?.(body)
      // startInEdit（快速草稿）：本次打开直接落编辑态
      if (!isReload) setPreview(startInEditRef.current ? false : (ext === 'md' || ext === 'txt'))
    } catch (e) {
      console.error('[PageEditor] draft load failed:', e)
      showToast({ type: 'error', message: '草稿读取失败' })
    }
  }, [])

  const loadPage = useCallback((isReload = false) => {
    // 草稿直入编辑：无 frontmatter id 的文件，页签 id = draft:<relPath>
    if (draftRelPath) { void loadDraftPage(draftRelPath, isReload); return }
    // vaultRoot 预热（PDF 内嵌阅读器需要 rootId；一次性，全局复用）
    if (vaultModeRef.current && !vaultRootRef.current) {
      void workspaceGetCurrent().then(cur => adoptVaultRoot(cur?.rootId ?? null)).catch(() => {})
    }
    const requested = pageId
    Promise.all([
      getKnowledgePageById(pageId).then(p => {
        // ★ 迟到即丢弃（F-7）：连点两个页签时，先发的那次可能后到 —— 不拦就会用旧页的
        //   page / content / savedContentRef 覆盖新页（这正是"切过去显示的是上一页"的来源之一）。
        if (pageIdRef.current !== requested) return
        if (p) {
          retryRef.current = null   // 成功即复位：下一次"索引还没重建"仍然值得重试一次
          setLoadMiss(null)
          setPage(p); setTitle(p.title); setContent(p.contentMd); setFileTypeState(p.fileType || ''); setEntryTags(p.tags || [])
          savedContentRef.current = p.contentMd || ''; savedTitleRef.current = p.title; isDirtyRef.current = false
          savedAnnotationRef.current = p.annotationMd || ''
          window.dispatchEvent(new CustomEvent('status-filetype', { detail: getFileTypeInfo(p.fileType || '').label }))
          onTitleChange?.(p.title)
          // 种子 liveContent(大纲/导出依赖);列表已瘦身,活动页内容以编辑器装载为准
          onContentChange?.(p.contentMd || '')
          // 非 md/txt 类型(pdf/代码)强制编辑视图;md/txt 保持阅读优先（重读时保持当前态）。
          // startInEdit（快速草稿）：本次打开直接落编辑态（该标记只对「建完即开」那一次为 true）
          const ft = (p.fileType || 'md').toLowerCase()
          if (!isReload) setPreview(startInEditRef.current ? false : (ft === 'md' || ft === '' || ft === 'txt'))
          // 就地编辑基线（vault 写路径）：可编辑文本类缓存 frontmatter 前缀 + mtime；其余类型清零
          const vaultEditable = ft === 'md' || ft === 'txt' || (ft !== '' && ft !== 'pdf' && ft !== 'xmind' && ft !== 'html')
          if (vaultModeRef.current && p.path && vaultEditable && p.entryKind !== 'file') {
            void loadVaultBaseline(p.path, requested)
          } else {
            vaultPrefixRef.current = ''
            vaultMtimeRef.current = 0
          }
          /* 归档类（非 md）的正文**不由这里给**：索引对 entryKind:'file' 的 contentMd 恒为空，
             正文靠下方那个自读 effect 补。而 isReload 重读时 `page?.path` 没变 ⇒ 那个 effect 不会重跑
             ⇒ 内容被置空后**永不自愈**（F-7 第 2 条：对 .txt / .json / .cpp 这类目标是确定性空白）。
             这里补一次"代次"，让它在重读后重新自读。只在 isReload 时补，首次装载由 path 变化自然触发
             （否则大文件会被读两遍）。 */
          if (isReload && p.entryKind === 'file') setSelfReadTick(t => t + 1)
        } else {
          /* ★ 取不到这一页（F-7）：原来这里**什么都不做**（界面静默停在上一页正文），
             重试一次之后也只是 `onBack()` 默默退回去。两者都会让人误判成"这一页是空的"。
             现在：先按 pageId 重试一次（索引重建有延迟），仍取不到就给一句能看见的话 + 重试钮。 */
          if (retryRef.current !== pageId) {
            retryRef.current = pageId
            setTimeout(() => { loadPageRef.current() }, 500)
            return
          }
          setLoadMiss(requested)
        }
      }),
      getKnowledgeBacklinkContext(pageId).then(setBacklinks),
      // 手动关联是旧 DB-only 通道，仓库读源模式下主进程统一拒绝（抛错刷屏）→ vault 模式直接空态，不发调用
      vaultModeRef.current ? Promise.resolve(setManualLinks([])) : getKnowledgeManualLinks(pageId).then(setManualLinks),
      getKnowledgeTags().then(setAllTags)
    ])
    // 原来这里无条件 setShowBacklinks(true)（"切换页面时重置"），导致默认收起形同虚设：
    // 每次打开/切换页面都被强行打开。改为不动它——由用户当前开关状态决定，
    // 关着就一直关着、开着就保持开着（同一编辑器实例在标签间切换时状态自然延续）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, draftRelPath])

  useEffect(() => { loadPage() }, [loadPage])

  // 关联网络（引用列表）右轨打开 → 通知 App 收起工作台右栏（两个右栏同开太挤；2026-10-09 反馈）。
  // 单向：关联网络关掉不自动恢复右栏（用户拍板）。
  useEffect(() => {
    if (!showBacklinks) return
    window.dispatchEvent(new CustomEvent('kb-collapse-right-panel'))
  }, [showBacklinks])

  // keep-alive 阅读页重读：激活时（编辑器保存/删除后切回知识库）广播 kb-reload-detail
  const loadPageRef = useRef(loadPage)
  useEffect(() => { loadPageRef.current = loadPage }, [loadPage])
  useEffect(() => {
    const onReload = () => {
      if (isDirtyRef.current) return // 本地有未保存编辑 → 不打断
      // 自己刚写盘触发的广播：不回灌（回灌无收益，且可能用旧盘内容吞掉写盘后新敲的字）
      if (Date.now() - selfSavedAtRef.current < 2000) return
      loadPageRef.current(true) // isReload：保持当前阅读/编辑态
    }
    window.addEventListener('kb-reload-detail', onReload)
    return () => window.removeEventListener('kb-reload-detail', onReload)
  }, [])

  // Alt+A — B4 内联建议手动触发（知识库编辑态；Phase 2 批次 2 随编辑器退役补齐入口）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'knowledge') return
      if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        if (paneRef.current?.triggerInlineSuggest()) return
        // ★ B-5：总闸关着时这个入口会被 provider 静默吞掉（fireInlineTrigger 的第一道闸就是
        // inlineOnRef）——用户按了键却零反馈，正是「不能用、不知为何」的另一半来源。
        // 只有「确实因为关闭」才提示（其余 false 分支：没挂编辑器 / 非 markdown / 空文档）。
        void getSetting('aiAssistantInlineSuggest').then((v) => {
          if (v === false) showToast({ type: 'info', message: 'AI 续写建议已关闭', detail: '点击 ✨ 开启后再按 Alt+A' })
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 外部变更监听（Phase 2 批次 2）：编辑器退役后由本模块承接——文件在磁盘上被外部修改时，
  // 本地干净 → 静默重读（keep-alive 语义）；本地有脏编辑 → 打断守卫在 onReload 内（:213）
  useEffect(() => {
    if (!vaultMode) return
    const off = window.api.onWsExternalChange(({ relPath }) => {
      if (pageRef.current?.path !== relPath) return
      window.dispatchEvent(new CustomEvent('kb-reload-detail'))
    })
    return off
  }, [vaultMode])

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
        // B-35（2026-10-25）：draft 伪页 + 从没读到过盘上文件（mtime=0）= 这个 relPath 在打开时就不存在
        //（kb-open-note 落到 draft 兜底、或文件已被移走）。此时写盘 = 在旧路径凭空新建一个
        // 同名空壳（真实内容在别处）—— 拒绝写盘并说明，绝不静默新建。
        // 真草稿（+ 号先建文件再打开）装载时 mtime>0，不进这条；外部删除后的「重建」口径不受影响
        //（那只发生在装载成功过的页面上）。
        if (pageRef.current.id.startsWith('draft:') && vaultMtimeRef.current === 0) {
          showToast({ type: 'warning', message: '原文件已不在仓库中，无法保存', detail: '它可能已被移动、改名或删除；请关掉这个页签，从文件列表重新打开' })
          setSaving(false)
          return
        }
        // 首次保存自动补 id（2026-09-20 拍板）：无 frontmatter id 的 .md 在首次编辑保存时静默转正，
        // 用户零操作；注入后必须回写 vaultPrefixRef（否则下一次保存又把它写掉）。
        // 仅 .md 参与（非 md 是文件卡片，注入 frontmatter 会破坏内容）。
        if (/\.md$/i.test(rel)) {
          const ensured = ensureFrontmatterId(vaultPrefixRef.current, rel, crypto.randomUUID())
          if (ensured.injected) vaultPrefixRef.current = ensured.prefix
          // 保存即刷新 frontmatter.updated（2026-09-20 反馈：最近编辑列表停在旧值——
          // 索引 updatedAt 取自 frontmatter.updated 而非 mtime，必须随保存刷新并回写内存前缀）
          const bumped = bumpFrontmatterUpdated(vaultPrefixRef.current || '')
          if (bumped.changed) vaultPrefixRef.current = bumped.prefix
        }
        // mtime 基线：装载时记录；<=0 = 文件已被外部删除 → 不带基线（保存即重建，同编辑器 missing 口径）
        const baseline = vaultMtimeRef.current > 0 ? vaultMtimeRef.current : undefined
        const res = await workspaceWriteFile(root, rel, joinFrontmatter({ frontmatterPrefix: vaultPrefixRef.current || undefined, content: c }), baseline)
        if (res?.ok) {
          vaultMtimeRef.current = typeof res.mtimeMs === 'number' && res.mtimeMs > 0 ? res.mtimeMs : vaultMtimeRef.current
          isDirtyRef.current = false
          savedContentRef.current = c
          savedTitleRef.current = t
          selfSavedAtRef.current = Date.now() // 标记自写时刻（守卫：随后的广播不回灌）
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
      selfSavedAtRef.current = Date.now() // 同上：自写时刻守卫
      setSaving(false)
      onClearDirty?.()
    } catch (e) { console.error(e) }
  }, [])

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

  /** 引用（出链）：从当前页正文解析 `[[…]]`（去重保序），按 allPages 标题 resolve → 可跳 / 未解析 */
  const outgoing = useMemo(() => {
    const out: Array<{ title: string; exists: boolean }> = []
    const seen = new Set<string>()
    const re = /\[\[([^\]]+)\]\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      const t = m[1].split('|')[0].trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push({ title: t, exists: allPages.some(p => p.title === t) })
    }
    return out
  }, [content, allPages])

  /** 在阅读态正文里定位到 `[[title]]` 处并高亮（「引用」条目点击 / 「被引用」跨页定位共用）。
   *  返回是否命中——跨页定位据此「命中才清待定位态、未命中随正文就绪重试」。
   *  高亮走 React 态（`flashWiki` → MarkdownPreview 的 `highlightWiki`）——**禁 imperative 加类**：
   *  重渲染会把 React 管理的 className 覆盖回去，命令式加的类留不住。 */
  const locateWiki = useCallback((title: string): boolean => {
    const root = previewRef.current
    let el: HTMLElement | null = null
    try { el = (root ?? document).querySelector(`[data-wiki="${CSS.escape(title)}"]`) as HTMLElement | null } catch { el = null }
    if (!el) return false
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlashWiki(null)                                   // 先移除，保证同名连续定位也能重放动画
    window.setTimeout(() => setFlashWiki(title), 0)
    window.setTimeout(() => setFlashWiki(cur => (cur === title ? null : cur)), 1700)
    return true
  }, [])

  // 跨页定位（被引用）：命中才清待定位态；未命中随正文就绪（content 变化）重试；5s 总兜底清。
  useEffect(() => {
    if (!pendingLocate) return
    const hard = window.setTimeout(() => setPendingLocate(null), 5000)
    if (page?.path !== pendingLocate.relPath) return () => window.clearTimeout(hard)
    const id = window.setTimeout(() => { if (locateWiki(pendingLocate.title)) setPendingLocate(null) }, 120)
    return () => { window.clearTimeout(hard); window.clearTimeout(id) }
  }, [content, page?.path, pendingLocate, locateWiki])

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
        /* ★ 批 2 修（2026-10-12）：PDF 沉浸态下 Esc 的第一语义是「退出沉浸」。
           PdfReaderView 自己的 window keydown 会处理它，但它**既不 preventDefault 也不
           stopPropagation**（见 PdfReaderView 的「Esc 逐级退出」分支），而下面这段是
           「关掉当前页签」⇒ 同一个 Esc 会**先退出沉浸、再把页面关掉**（用户视角：按 Esc 笔记没了）。
           两个监听都在 window 上，`stopPropagation` 也拦不住同元素的兄弟监听，故只能在这边让路。
           ★ 为什么以前写不出这道守卫：`immersive` 是阅读器的**内部 state**，外层无从得知；
           批 2 加了 onImmersiveChange 上报，才第一次有条件判「我现在在 PDF 沉浸里」。
           判据用 ref 镜像：那个 keydown effect 的依赖刻意只有 [doSave, onBack]。 */
        if (pdfImmersiveRef.current) return
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
        // Editing mode: 经写作面契约滚动定位（两档同签名）
        const pane = paneRef.current
        if (pane) {
          pane.revealLine(line)
        } else {
          const ed = activeEditor()
          if (ed) {
            ed.revealLineInCenter(line)
            ed.setPosition({ lineNumber: line, column: 1 })
            ed.focus()
          }
        }
      }
    }
    window.addEventListener('outline:go-to-heading', handler)
    return () => window.removeEventListener('outline:go-to-heading', handler)
  }, [preview])

  // ===== Inline image insertion (paste / drag / toolbar) — md/txt only =====
  // 走写作面契约：源码档与即时渲染档同一段实现（即时渲染档另有自己的粘贴/拖拽拦截）
  const insertImageFiles = useCallback(async (files: File[]) => {
    if (isCodeFileRef.current || isPdfFileRef.current) return
    const pane = paneRef.current
    if (!pane) return
    for (const f of files) {
      if (!isImageFile(f)) continue
      try {
        const meta = await uploadImageFile(f, IMAGE_OWNER.knowledge, pageIdRef.current)
        pane.insertAtCursor(imageMarkdown(meta))
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
  // 实现走共享动作表（右键菜单「插入 → 脚注」同一段代码），两档同行为
  const insertFootnote = useCallback(() => {
    const pane = paneRef.current
    if (!pane) return
    const out = runNoteAction('ins-footnote', pane)
    if (out instanceof Promise) {
      void out.then((r) => { if (!r.ok) showToast({ type: 'info', message: r.message }) })
    } else if (!out.ok) {
      showToast({ type: 'info', message: out.message })
    }
  }, [])

  /**
   * 文件格式落点（**唯一实现，两处共用**）：顶栏 ⋮ 的二级子菜单 / 编辑器右键菜单。
   * 副作用与既有 chip 逐条一致：改渲染态类型、非文本类强制退出阅读态、回报父级 + 状态栏。
   * 为什么抽出来：拍板 C2 要求「⋮ 里有、右键菜单里也有」，两处各写一份必然漂移。
   * ★ 批 2：非 md 刻意**不给**这个入口（扩展名来自文件名、`onFileTypeChange` 只改内存不落盘
   * ⇒ 对非 md 是假按钮），故原来那处「旧胶囊的格式 chip」已随胶囊退役。
   */
  const applyFileType = useCallback((ext: string, label?: string) => {
    setFileTypeState(ext)
    if (ext !== '' && ext !== 'md' && ext !== 'txt') setPreview(false)
    onFileTypeChange?.(ext)
    window.dispatchEvent(new CustomEvent('status-filetype', { detail: label ?? getFileTypeInfo(ext).label }))
  }, [onFileTypeChange])

  /** 是否 md 笔记（批 2：不再是「顶栏 vs 胶囊」的开关 —— 顶栏对所有非导图类型都挂；
   *  它现在只决定顶栏里**给哪些钮**：阅读切换 / ✨续写 / md 专属的 ⋮ 菜单）。 */
  const isMdNote = fileType === 'md'

  /** AI 续写总开关（顶栏常驻钮）：开着点 = 关闭 —— 掐在途请求 + 收起 ghost + 关设置总闸 */
  const handleToggleInline = useCallback(() => {
    if (s.aiAssistantInlineSuggest !== false) {
      cancelInlineSuggestInFlight()
      paneRef.current?.hideInlineSuggest()
      update('aiAssistantInlineSuggest', false)
    } else {
      update('aiAssistantInlineSuggest', true)
    }
  }, [s.aiAssistantInlineSuggest, update])

  /**
   * Ctrl+Shift+I 插图 / Ctrl+Alt+F 脚注 —— 顶栏把它们收进 ⋮ 之后的**键盘补偿**（拍板 E2）。
   *
   * 为什么单独一个 effect、且**不吃 isEditingInput 闸门**（与上面的 Alt+A 同款）：
   * 这两个动作都发生在编辑器里，而 isEditingInput 对 `.monaco-editor` 内恒返回 true ——
   * 放进那个闸门后面 = 主用法下按了没反应。
   *
   * 为什么脚注不是 Ctrl+Shift+F：那个组合已被全局左栏搜索占用（App.tsx 的全局键处理）。
   *
   * ⚠️ 本 effect 必须**声明在 insertFootnote 之后** —— 依赖数组里直接引用它，
   *    写在前面会撞 TDZ（TS2448/TS2454，铁律 11 里那条「effect 依赖数组注意 TDZ」）。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'knowledge') return
      if (preview) return // 阅读态没有写作面，动作落不下去（顶栏 ⋮ 里那两项同样只在编辑态出现）
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault()
        imageInputRef.current?.click()
        return
      }
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        insertFootnote()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [insertFootnote, preview])

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

  /* ===== ⋮ 的文件级动作（2026-10-13 批 1b）=====
     一律传 `page.path`（仓库相对路径）—— 模块层那四个入口吃的就是 relPath。
     全部可选 prop：没接就**不渲染**那一项（见下面两个分支的门控），不做点了没反应的假按钮。 */
  const pageRel = () => pageRef.current?.path ?? ''
  const openRename = () => {
    setRenameDraft(pageRel().split('/').pop() ?? '')
    setShowFileInfo(false); setShowMove(false); setShowProps(false); setShowRename(true)
    setShowMoreMenu(false)
  }
  /** 笔记属性（批 4）：打开时从前缀现读一份副本做 draft（改坏了关掉即可，不碰磁盘） */
  const openProps = () => {
    setPropRows(parseFmPropRows(vaultPrefixRef.current))
    setShowFileInfo(false); setShowRename(false); setShowMove(false); setShowProps(true)
    setShowMoreMenu(false)
  }
  /** 保存属性：外科手术写回前缀 → 立刻落盘（与 Ctrl+S 同一条 doSave；不动正文、不经过缓冲区） */
  const saveProps = () => {
    const next = applyFmPropRows(vaultPrefixRef.current, propRows)
    vaultPrefixRef.current = next
    setShowProps(false)
    void doSave(titleRef.current, contentRef.current).then(() => { setSaving(false); onClearDirty?.() })
  }
  const setPropAt = (i: number, patch: Partial<FmPropRow>) =>
    setPropRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const submitRename = () => {
    const rel = pageRel()
    const next = renameDraft.trim()
    setShowRename(false)
    if (!rel || !next || !onRenameRequest) return
    onRenameRequest(rel, next)
  }
  const requestMove = (targetDirRel: string) => {
    const rel = pageRel()
    setShowMove(false)
    if (!rel || !onMoveRequest) return
    onMoveRequest(rel, targetDirRel)
  }
  /** 删除：接了模块层就走系统回收站（与文件树同一个 handleTreeDelete：危险确认 + 连带关页签）；
   *  没接（旧调用点）才回落原来的 handleDelete。★ 原来这条路在仓库模式下是**假按钮** ——
   *  `handleDelete` 第一句 `if (vaultMode)` 就弹提示返回，而模块**恒传** `vaultMode={true}`。 */
  const requestDelete = () => {
    const rel = pageRel()
    if (onDeleteRequest && rel) { onDeleteRequest(rel); return }
    void handleDelete()
  }

  const handleToggleStar = async () => {
    if (!page) return
    try {
      const updated = await toggleKnowledgeStar(page.id)
      // B-32（2026-10-25）：vaultToggleStar 契约里 null = 「该 id 不在索引里」（draft 伪页 id、
      // 索引重建延迟、同 id 冲突都可能走到）—— 直接解引用是静默崩溃（TypeError 进控制台，
      // 界面零反馈）。给一句能行动的话，别让用户以为按钮坏了。
      if (!updated) {
        showToast({ type: 'warning', message: '页面状态未同步，收藏失败', detail: '请关掉这个页签后重新打开再试；若反复出现，重启应用让知识库索引重建' })
        return
      }
      setPage({ ...page, isStarred: updated.isStarred })
      onUpdate()
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '收藏失败，请重试' })
    }
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
        // 新建页要让 `[[` 候选立刻能选到它（候选缓存 30s，否则刚建的页要等半分钟才出现）
        invalidateWikiCache()
        onUpdate()
        onNavigate(created.id)
      } catch (e) {
        console.error('[PageEditor] create page from wiki link failed:', e)
        showToast({ type: 'error', message: '创建失败，请重试' })
      }
    })()
  }

  /** ⋮ 里的项数（批 2 拍板②「空则隐藏 ⋮」的判据）：
   *  md 恒有「沉浸阅读」（`onRequestReading` 由模块恒传）⇒ ≥1；
   *  非 md 恒有「文件信息 / 在系统中打开 / 在文件夹中显示 / 复制路径 ▸」四项，html 多一项「看源码」、
   *  txt / html 多一项「沉浸阅读」。（2026-10-13 能力补齐：第四项由「复制相对路径」升级为二级两档，
   *  仍是**一项**，故下面的 4 不变。）
   *  ★ 现状下两边都恒 > 0 ⇒ 这条守卫是**潜伏**的（见 docs/nonmd-topbar-design.md §三·②）：
   *  拍板保留它，是为了将来收窄 ⋮ 项时自动生效，而不是等那时才发现按钮点了没反应。 */
  const moreMenuItemCount = isMdNote
    ? 1
    : 4 + ((isWelcomeHtml || isArchiveHtml) ? 1 : 0)
      // SVG 源码态（批 3）
      + (isSvgImage ? 1 : 0)
      // 「查看」组（批 3）：只在图片真渲染出来时出现 —— 过大 / 解码失败时没有可缩放的东西
      + (imgReady ? 4 : 0)
      // 沉浸阅读：门槛与模块层 enterReading 对齐（md / txt / html + 批 3 放行的图片）
      + ((fileType === 'txt' || fileType === 'html' || isImagePage) && onRequestReading ? 1 : 0)

  return (
    <div className="flex-1 flex overflow-hidden">

      {/* Main editing area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 笔记区顶栏（2026-10-11 对齐 Obsidian）：**行内渲染、不 portal** ——
            fileType / saving / preview / AI 四态的真源都在本组件里，走 portal 等于再造一个真源（方案 §1①）。
            位置 = 主栏最顶端（页面条正下方）；右侧「关联网络」面板打开时它只跨笔记列、不压面板，
            与 Obsidian「笔记头跨笔记面板、右栏是独立面」同款口径。

            按钮集（拍板 C1/C2/C3）：左 ← → 页面历史 / 中 文件名 + 保存点 / 右 ✨AI 续写 + 阅读切换 + ⋮；
            原来胶囊上的插图、脚注、文件格式、收藏、关联、沉浸阅读、刷题、删除全部收进 ⋮。

            ★ 批 2（2026-10-12，docs/nonmd-topbar-design.md）：门槛从 `isMdNote` 放开到**非导图**，
            非 md 的右上悬浮胶囊（`[data-wb='floatBar']`）整条退役 —— 它的动作全部搬到这里。
            两处例外：① 导图自带工具条（与胶囊同一门槛口径，2026-10-09 反馈）；
            ② PDF 沉浸态由阅读器上报（`pdfImmersive`，见 PdfReaderView 的 onImmersiveChange）。 */}
        {!isMindMapFile && !pdfImmersive && (
          <div className="relative shrink-0">
          <NoteTopBar
            title={title}
            titleHint={page.path || title}
            /* 中段次要文本：图片给像素尺寸（= PDF 的「N 页」那个位置），PDF 给页数。
               ★ 刻意**不带**文件大小 —— 那是「文件信息」里的事，塞进顶栏会与尺寸抢注意力。
               图片的尺寸取自 `<img>` 解码后的权威值（naturalWidth/Height），故 SVG 也能给。 */
            subtitle={
              isImagePage && natW > 0 ? `${natW} × ${natH}`
                : isPdfFile && pdfPages > 0 ? `${pdfPages} 页`
                  : undefined
            }
            saving={saving}
            /* 保存点（批 2 拍板①）：只有「有真实保存动作」的类型才显示。★ `paneDoc` 非空**不等于**可编辑 ——
               >10MB 的文本类也会让 `paneDoc` 非空（`archiveTextOpenable` 只排除 binary / oversize-open），
               而它的渲染分支在下方被 `ArchiveTextView`（只读）接走 ⇒ 这里必须再排掉 `oversize-edit`，
               否则「超限只读文本恒亮已保存」正是这条拍板要消灭的假信号（2026-10-13 修）。
               其余：md / 可编辑文本类 / html 源码态 / SVG 源码态有防抖自动保存，绿点是真信号；
               PDF / 图片 / 二进制 / 导图没有保存动作。 */
            showSaveDot={!!paneDoc && textFile?.reason !== 'oversize-edit'}
            canBack={canNavBack}
            canForward={canNavForward}
            onBack={() => onNavBack?.()}
            onForward={() => onNavForward?.()}
            preview={preview}
            onToggleView={() => setPreview(v => !v)}
            showViewToggle={isMdNote}
            showInline={isMdNote && !preview && writingMode === 'source'}
            inlineOn={s.aiAssistantInlineSuggest !== false}
            inlineBusy={inlineBusy}
            inlinePaused={inlinePaused}
            onToggleInline={handleToggleInline}
            /* 图片控件位（批 3 拍板 D7 = 顶栏内联）：图片态下顶栏的 showViewToggle / showInline /
               showSaveDot 三者全为假，右侧本来只剩 ⋮ ⇒ 这一簇是**零新增行高**，这是选 A 的全部理由。
               只在真渲染出像素时才给 —— 过大 / 解码失败时没有可缩放的东西，
               给了就是一批点了没反应的按钮。 */
            rightSlot={imgReady ? (
              <ImageToolbar
                variant="inline"
                scale={iv.view.scale}
                fit={iv.view.fit}
                rot={iv.view.rot}
                onZoom={iv.zoom}
                onFit={iv.fit}
                onRotate={iv.rotate}
              />
            ) : undefined}
            showMore={moreMenuItemCount > 0}
            moreOpen={showMoreMenu}
            onToggleMore={() => setShowMoreMenu(v => !v)}
            onCloseMore={() => setShowMoreMenu(false)}
            moreMenu={isMdNote ? (
              <>
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
                {onRequestReading && (
                  <button onClick={() => { onRequestReading(); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <BookOpen size={13} />沉浸阅读
                    <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">Ctrl+Shift+R</span>
                  </button>
                )}
                {quizzes.length > 0 && (
                  <button onClick={() => { setQuizMode(true); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <ListChecks size={13} />刷题模式
                    <span className="ml-auto text-[10px] text-[var(--text-secondary)]">{quizzes.length} 题</span>
                  </button>
                )}
                {/* 查看源码 / 看渲染（2026-10-13）：**本页临时**切档，不改全局设置 `editorWritingMode`。
                    ★ 阅读态下也出现（md 默认就是阅读态打开）：点它顺带退出阅读态，否则在默认状态下
                      「查看源码」点了看不见任何变化 —— 那正是「点了没反应」的假按钮。
                    ★ 反向那一档必须一起给：单向覆盖没有回来的路，用户只能去设置页改全局档位。
                    ★ 文案口径：**按点了会看到什么给**（`mdSourceItemShowsSource`），不按当前档位 ——
                      否则默认源码档 + 阅读态下会显示「看渲染」，而用户眼前明明就是渲染好的内容。
                    与 HTML / SVG 的「看源码」同词（那两处在「文件」组），三处一起看不会觉得是两套说法。 */}
                <button data-wb="peMdSource"
                  onClick={() => {
                    if (mdSourceItemShowsSource) { setPreview(false); setSrcOverride(true) }
                    else setSrcOverride(false)
                    setShowMoreMenu(false)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                  {mdSourceItemShowsSource ? <FileText size={13} /> : <Eye size={13} />}
                  {mdSourceItemShowsSource ? '查看源码' : '看渲染'}
                </button>

                {/* 在标签页中显示反向链接（2026-10-13 批 2）：把「被引用」从右栏搬进正文末尾 ——
                    这条能力的重点是「不开侧栏也能看到谁引用了我」。
                    ★ 只在**阅读态**出现：编辑态下写作面占满整块、下面没有位置放它（要放得改写作面
                      布局，属另一件事），阅读态才是「看这一页」的地方 —— 只在真能用的时候给，
                      不做点了没反应的假按钮（本仓一直在防这个）。
                    ★ 本页临时开关（换页复位、不写设置），与上面「查看源码 / 看渲染」同一个手法。 */}
                {preview && (
                  <MoreItem anchor="peInlineBacklinks"
                    icon={inlineBacklinks ? <Eye size={13} /> : <Link2 size={13} />}
                    label={inlineBacklinks
                      ? '隐藏反向链接'
                      : `在标签页中显示反向链接${backlinks.length ? `（${backlinks.length}）` : ''}`}
                    onClick={() => { setInlineBacklinks(v => !v); setShowMoreMenu(false) }} />
                )}

                <MoreSep />
                {!preview && (
                  <button onClick={() => { insertFootnote(); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <StickyNote size={13} />插入脚注
                    <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">Ctrl+Alt+F</span>
                  </button>
                )}
                {!preview && (
                  <button onClick={() => { imageInputRef.current?.click(); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <ImagePlus size={13} />插入图片
                    <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">Ctrl+Shift+I</span>
                  </button>
                )}
                {/* 文件格式：二级子菜单，往**左**展开 —— 菜单本身贴右缘，往右会出屏（同原型）。
                    2026-10-13 起改用 `MoreSub`（原来是自己写的一段 `relative` + `showFmtMenu`）：
                    ⋮ 加了「封顶 + 内部滚动」之后，凡贴底的子菜单都会被滚动容器切掉，
                    而「放不下就朝上开」的判定只该有一份 ⇒ 两个子菜单合并到同一个原语。 */} 
                <MoreSub icon={<FileText size={13} />} label="文件格式" note={getFileTypeInfo(fileType).label}
                  items={FILE_LANG_OPTIONS.map(opt => ({
                    label: opt.label,
                    active: fileType === opt.ext,
                    onSelect: () => { applyFileType(opt.ext, opt.label); setShowMoreMenu(false) },
                  }))} />

                {/* 编辑组（2026-10-13 能力补齐）：查找 / 替换原先只有快捷键（Ctrl+F / Ctrl+H），
                    菜单里没有入口 —— 键盘用户之外的路径等于不存在。★ 只在「源码档 + 编辑态」出现：
                    阅读态下写作面是 display:none 保活、即时渲染档没有 Monaco，给了就是假按钮。 */}
                {canFindReplace && (
                  <>
                    <MoreSep />
                    <MoreItem anchor="peFind" icon={<Search size={13} />} label="查找…" kbd="Ctrl+F"
                      onClick={() => { runEditorAction('actions.find'); setShowMoreMenu(false) }} />
                    <MoreItem anchor="peReplace" icon={<Replace size={13} />} label="替换…" kbd="Ctrl+H"
                      onClick={() => { runEditorAction('editor.action.startFindReplaceAction'); setShowMoreMenu(false) }} />
                  </>
                )}

                {/* 布局组（2026-10-13 批 1b）：分屏此前只藏在页签右键里 —— 同一个动作两个入口只给一个。
                    调用方负责关菜单（`onPick` 里 close），组件本身只画。 */}
                {onSplitRequest && (
                  <MoreSplitGroup disabled={splitDisabled}
                    onPick={(o) => { onSplitRequest(o); setShowMoreMenu(false) }} />
                )}

                {/* 文件组（2026-10-13 能力补齐 + 批 1b）：md 页此前**没有**任何文件级入口，
                    与文件树右键（重命名 / 将文件移动到… / 创建副本 / 复制路径 ▸ / 删除）不对齐。
                    每条都靠可选 prop 门控：模块层没接就**不出现**（不做点了没反应的假按钮）。 */}
                <MoreSep />
                {onRenameRequest && (
                  <MoreItem anchor="peRename" icon={<Pencil size={13} />} label="重命名" onClick={openRename} />
                )}
                {onDuplicateRequest && (
                  <MoreItem anchor="peDuplicate" icon={<Files size={13} />} label="创建副本"
                    onClick={() => { const rel = pageRel(); setShowMoreMenu(false); if (rel) onDuplicateRequest(rel) }} />
                )}
                {onMoveRequest && (
                  <MoreItem anchor="peMove" icon={<FolderInput size={13} />} label="将文件移动到…"
                    onClick={() => { setShowFileInfo(false); setShowRename(false); setShowProps(false); setShowMove(true); setShowMoreMenu(false) }} />
                )}
                {onLocateRequest && (
                  <MoreItem anchor="peLocate" icon={<Crosshair size={13} />} label="在文件列表中显示"
                    onClick={() => { const rel = pageRel(); setShowMoreMenu(false); if (rel) onLocateRequest(rel) }} />
                )}
                <MoreSub anchor="peCopyPath" icon={<Copy size={13} />} label="复制路径" items={[
                  { label: '仓库相对路径', onSelect: () => { void handleCopyPath('rel'); setShowMoreMenu(false) } },
                  { label: '完整路径', onSelect: () => { void handleCopyPath('abs'); setShowMoreMenu(false) } },
                ]} />
                {/* 笔记属性（2026-10-13 批 4）：frontmatter 的可视化编辑。此前只能切源码档改，
                    而源码档里 frontmatter 与正文混在一起，改一个 tag 得先认得出哪几行是元数据。
                    ★ 只认**单行** `key: value`（值跨行的只读），见 parseFmPropRows 头注：绝不为好看
                      去重建整块前缀 —— 那会把 YAML 列表压平 = 静默毁数据。 */}
                <MoreItem anchor="peProps" icon={<Tag size={13} />} label="笔记属性…" onClick={openProps} />
                {/* 导出为 PDF（批 3，2026-10-13）：模块层负责「保存对话框 → 临时进沉浸阅读态 → 打印 →
                    还回去」；本组件只发请求。落点由用户在系统对话框里选（导出物不落进仓库，
                    免得知识库多出一个 PDF 附件条目）。 */}
                {onExportPdfRequest && (
                  <MoreItem anchor="peExportPdf" icon={<Download size={13} />} label="导出为 PDF…"
                    onClick={() => { setShowMoreMenu(false); onExportPdfRequest() }} />
                )}
                {/* 「系统」组原来靠标题与上一条分隔 —— 标题去掉后必须补一条分隔线，
                    否则「导出为 PDF…」与「在系统中打开」会黏成一块（去掉标题的连带项）。 */}
                <MoreSep />
                <MoreItem anchor="peSystemOpen" icon={<ExternalLink size={13} />} label="在系统中打开"
                  onClick={() => { void handleArchiveOpenInSystem(false); setShowMoreMenu(false) }} />
                <MoreItem anchor="peReveal" icon={<FolderSearch size={13} />} label="在文件夹中显示"
                  onClick={() => { void handleArchiveOpenInSystem(true); setShowMoreMenu(false) }} />

                <MoreSep />
                {/* 删除（批 1b 换成真删除）：接了模块层走系统回收站 + 危险确认 + 连带关页签；
                    没接才回落本组件原来的 handleDelete。★ 原来那条在仓库模式下只弹一句提示
                    （模块恒传 vaultMode=true）—— 补这一批时顺手修掉的假按钮。 */}
                <MoreItem anchor="peDelete" danger icon={<Trash2 size={13} />} label="删除页面"
                  onClick={() => { setShowMoreMenu(false); requestDelete() }} />
              </>
            ) : (
              /* 非 md 的 ⋮（批 2）：批 1 那个「文件」组**原样搬进来** —— 五个 data-wb 锚点一字不改
                 （peHtmlSource / peFileInfo / peOpenInSystem / peRevealInFolder / peCopyRelPath），
                 批 1 的探针 probe-content-routing.mjs §3.5/§3.6 可直接复用。
                 另加「沉浸阅读」，门槛对齐模块层 enterReading（knowledge/index.tsx：md / txt / html）。
                 ★ 刻意**不给**「文件格式」钮：`handleFileTypeChange` 只在内存里改 fileType、不落盘，
                 而非 md 的扩展名来自文件名 ⇒ 加了就是一个重启即失效的假按钮
                 （原型 index.html:750-753 的取舍记录）。 */
              <>
                {(isWelcomeHtml || isArchiveHtml) && (
                  <button data-wb="peHtmlSource" onClick={() => { setHtmlSource(v => !v); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    {htmlSource ? <Eye size={13} /> : <FileText size={13} />}
                    {htmlSource ? '看渲染' : '看源码'}
                  </button>
                )}
                {/* SVG 源码态（批 3）：与上面 html 那条同款，锚点分开是为了让探针能分辨两种文件 */}
                {isSvgImage && (
                  <button data-wb="peSvgSource" onClick={() => { setSvgSource(v => !v); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    {svgSource ? <Eye size={13} /> : <FileText size={13} />}
                    {svgSource ? '看图片' : '看源码'}
                  </button>
                )}
                <button data-wb="peFileInfo" onClick={() => { setShowRename(false); setShowMove(false); setShowProps(false); setShowFileInfo(true); setShowMoreMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                  <Info size={13} />文件信息
                </button>
                <button data-wb="peOpenInSystem" onClick={() => { void handleArchiveOpenInSystem(false); setShowMoreMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                  <ExternalLink size={13} />在系统中打开
                </button>
                <button data-wb="peRevealInFolder" onClick={() => { void handleArchiveOpenInSystem(true); setShowMoreMenu(false) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                  <FolderSearch size={13} />在文件夹中显示
                </button>
                {/* 复制路径（2026-10-13 能力补齐）：原先只有「相对」一档，而文件树右键早就是
                    「相对 / 完整」二级两档 —— 同一件事两个入口两种能力，这里统一成二级两档。
                    ★ 锚点 `peCopyRelPath` 保留不改名（内容路由契约 D1 与两条探针都按它找），
                      标签从「复制相对路径」改成「复制路径」。 */}
                <MoreSub anchor="peCopyRelPath" icon={<Copy size={13} />} label="复制路径" items={[
                  { label: '仓库相对路径', onSelect: () => { void handleCopyPath('rel'); setShowMoreMenu(false) } },
                  { label: '完整路径', onSelect: () => { void handleCopyPath('abs'); setShowMoreMenu(false) } },
                ]} />
                {/* 文件级动作（2026-10-13 批 1b）：非 md 此前也没有重命名 / 移动 / 副本 / 定位 ——
                    与文件树右键和 md 兄弟都不对齐。每条靠可选 prop 门控，模块层没接就不出现。 */}
                {onRenameRequest && (
                  <MoreItem anchor="peRename" icon={<Pencil size={13} />} label="重命名" onClick={openRename} />
                )}
                {onDuplicateRequest && (
                  <MoreItem anchor="peDuplicate" icon={<Files size={13} />} label="创建副本"
                    onClick={() => { const rel = pageRel(); setShowMoreMenu(false); if (rel) onDuplicateRequest(rel) }} />
                )}
                {onMoveRequest && (
                  <MoreItem anchor="peMove" icon={<FolderInput size={13} />} label="将文件移动到…"
                    onClick={() => { setShowFileInfo(false); setShowRename(false); setShowProps(false); setShowMove(true); setShowMoreMenu(false) }} />
                )}
                {onLocateRequest && (
                  <MoreItem anchor="peLocate" icon={<Crosshair size={13} />} label="在文件列表中显示"
                    onClick={() => { const rel = pageRel(); setShowMoreMenu(false); if (rel) onLocateRequest(rel) }} />
                )}
                {onSplitRequest && (
                  <MoreSplitGroup disabled={splitDisabled}
                    onPick={(o) => { onSplitRequest(o); setShowMoreMenu(false) }} />
                )}
                {/* 「查看」组（批 3 拍板 D10）：⋮ 是「非 md 全部动作」的落点，与批 2 的口径一致；
                    也给纯键盘用户一个入口。★ 只在图片真渲染出来时出现（见 moreMenuItemCount）。 */}
                {imgReady && (
                  <>
                    <MoreSep />
                    <button data-wb="imgMenuFit" onClick={() => { iv.fit('fit'); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                      <Maximize size={13} />适应窗口
                      <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">0</span>
                    </button>
                    <button data-wb="imgMenuActual" onClick={() => { iv.fit('actual'); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                      <Square size={12} />实际大小
                      <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">1</span>
                    </button>
                    <button data-wb="imgMenuRotateL" onClick={() => { iv.rotate(-90); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                      <RotateCcw size={13} />向左旋转
                      <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">[</span>
                    </button>
                    <button data-wb="imgMenuRotateR" onClick={() => { iv.rotate(90); setShowMoreMenu(false) }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                      <RotateCw size={13} />向右旋转
                      <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">]</span>
                    </button>
                  </>
                )}
                {(fileType === 'txt' || fileType === 'html' || isImagePage) && onRequestReading && (
                  <button onClick={() => { onRequestReading(); setShowMoreMenu(false) }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <BookOpen size={13} />沉浸阅读
                    <span className="kb-kbd ml-auto shrink-0 rounded px-1 py-0.5 text-[10px]">Ctrl+Shift+R</span>
                  </button>
                )}
                {/* 删除（2026-10-13 批 1b）：非 md 的 ⋮ 此前**没有**删除入口（只有 md 有），
                    而 md 那条在仓库模式下又是假按钮 —— 现在两边同一个落点：模块层
                    handleTreeDelete（系统回收站 + 危险确认 + 连带关页签）。 */}
                {onDeleteRequest && (
                  <>
                    <MoreSep />
                    <MoreItem anchor="peDelete" danger icon={<Trash2 size={13} />} label="删除文件"
                      onClick={() => { setShowMoreMenu(false); requestDelete() }} />
                  </>
                )}
              </>
            )}
          />
          {/* 「重命名」弹层（2026-10-13 批 1b）：输入框跟着 ⋮ 走，**不复用树内联改名** ——
              树可能收起 / 侧栏停在「大纲」页 / 整个左栏关着，那时内联输入行根本不渲染，
              表象就是「点了没反应，只能再去左栏找」。Enter 提交、Esc 取消（外点由上面的 effect 收）。 */}
          {showRename && (
            <div data-wb="peRenameCard" className="kb-pop origin-top-right absolute right-2 top-full z-50 mt-1 w-72 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-xl">
              <div className="mb-2 text-[11px] text-[var(--text-secondary)]">重命名（含扩展名）</div>
              <input
                data-wb="peRenameInput"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); submitRename() }
                  else if (e.key === 'Escape') { e.preventDefault(); setShowRename(false) }
                }}
                className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <div className="mt-2.5 flex justify-end gap-2">
                <button onClick={() => setShowRename(false)}
                  className="rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
                  取消
                </button>
                <button onClick={submitRename}
                  className="rounded-md border border-[var(--accent)] px-2.5 py-1 text-[11.5px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10">
                  确定
                </button>
              </div>
            </div>
          )}
          {/* 「将文件移动到…」弹层：内容直接用共享 DirPicker（它只管内容与键盘，定位交给这里）。
              rootId 传本组件同步持有的那个 —— 它可能还没解析出来，DirPicker 会自己兜底查当前仓库。 */}
          {showMove && page?.path && (
            <div data-wb="peMoveCard" className="kb-pop origin-top-right absolute right-2 top-full z-50 mt-1 w-80 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 shadow-xl">
              <DirPicker
                rootId={vaultRootId ?? undefined}
                sourceRel={page.path}
                onPick={(dst) => requestMove(dst)}
                onCancel={() => setShowMove(false)}
              />
            </div>
          )}
          {/* 「笔记属性」弹层（批 4）：与上面两个弹层同一个槽位。可编辑的只有**单行** `key: value`；
              值跨行的（YAML 列表 / 嵌套）与 `id` 一律只读 —— 见 parseFmPropRows 头注。
              「保存属性」= 外科手术写回前缀 + 立刻 doSave（与 Ctrl+S 同一条路），不动正文。 */}
          {showProps && (
            <div data-wb="pePropsCard" className="kb-pop origin-top-right absolute right-2 top-full z-50 mt-1 w-80 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-xl">
              <div className="mb-2 flex items-center gap-1.5">
                <Tag size={12} className="text-[var(--text-muted)]" />
                <span className="text-[11px] text-[var(--text-secondary)]">笔记属性（frontmatter）</span>
              </div>
              {propRows.length === 0 && (
                <p className="mb-2 text-[11.5px] text-[var(--text-muted)]">这一页还没有属性，在下面加一条即可。</p>
              )}
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {propRows.map((r, i) => (
                  <div key={`${r.key}-${i}`} className="flex items-center gap-1.5">
                    <input data-wb="pePropKey" value={r.key} disabled={r.readonly} placeholder="键"
                      onChange={e => setPropAt(i, { key: e.target.value })}
                      className={`w-24 shrink-0 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] ${r.readonly ? 'opacity-55' : ''}`} />
                    <input data-wb="pePropValue" value={r.value} disabled={r.readonly} placeholder="值"
                      onChange={e => setPropAt(i, { value: e.target.value })}
                      className={`min-w-0 flex-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] ${r.readonly ? 'opacity-55' : ''}`} />
                    <button disabled={r.readonly}
                      title={r.readonly ? '这一条只读（id 是身份，或值跨行）' : '删除这一条'}
                      onClick={() => setPropRows(rows => rows.filter((_, idx) => idx !== i))}
                      className={`shrink-0 rounded p-0.5 transition-colors ${r.readonly ? 'cursor-default text-[var(--text-disabled)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]'}`}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button onClick={() => setPropRows(rows => [...rows, { key: '', value: '', line: -1 }])}
                className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border-color)] py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
                <Plus size={12} />新增属性
              </button>
              {propRows.some(r => r.readonly) && (
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">灰掉的项不改：<code>id</code> 是这一页的身份；值跨行的（列表 / 嵌套）请到源码档改。</p>
              )}
              <div className="mt-2.5 flex justify-end gap-2">
                <button onClick={() => setShowProps(false)}
                  className="rounded-md border border-[var(--border-color)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
                  取消
                </button>
                <button data-wb="pePropsSave" onClick={saveProps}
                  className="rounded-md border border-[var(--accent)] px-2.5 py-1 text-[11.5px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10">
                  保存属性
                </button>
              </div>
            </div>
          )}
          {/* 「文件信息」小卡（批 1）：批 2 从胶囊搬到这里 —— 挂顶栏自己的 relative 容器，
              与 ⋮ 同锚点（⋮ 在顶栏右端，卡片贴右缘即落在它正下方）。
              批 1b：它与上面两个新弹层共用这个槽位 ⇒ 打开任一个前先把另两个关掉（见 openRename / peMove 分支）。 */}
          {showFileInfo && (
            <div data-wb="peFileInfoCard" className="kb-pop origin-top-right absolute right-2 top-full z-50 mt-1 w-64 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-xl">
              <FileInfoRows path={page?.path} sizeBytes={page?.sizeBytes} updatedAt={page?.updatedAt} />
              <button onClick={() => setShowFileInfo(false)}
                className="mt-2.5 w-full rounded-md border border-[var(--border-color)] py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
                关闭
              </button>
            </div>
          )}
          </div>
        )}
        {/* 取不到页面时的可见提示（F-7，2026-10-13）：原来这里什么都没有 —— 界面就停在上一页的正文上，
            "从空文件切走 ⇒ 一片空白"正是这么来的。给一句能看见的话 + 重试钮，页面真没了用户自己关页签。 */}
        {loadMiss && (
          <div data-wb="peLoadMiss" className="kb-view-in flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
            <AlertTriangle size={13} className="shrink-0 text-[var(--warning)]" />
            <span className="min-w-0 flex-1 truncate">这一页暂时读不到（可能索引还在重建）。下面显示的可能还是上一页的内容。</span>
            <button onClick={() => { setLoadMiss(null); retryRef.current = null; loadPageRef.current() }}
              className="shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[11.5px] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
              重试
            </button>
          </div>
        )}
        {/* Content */}
        {isMindMapFile && page?.path ? (
          /* 思维导图 JSON：按内容识别（kind:"mindmap"）→ 渲染共享 MindMapView。
             必须排在 isArchiveFile 之前——.json 归档条目默认落元信息卡，会遮蔽导图分支 */
          <div className="flex-1 min-h-0 flex">
            <MindMapView relPath={page.path} showSource />
          </div>
        ) : (isWelcomeHtml || isArchiveHtml) && page?.path ? (
          /* html 两处落点在此**合流**（批 1）：欢迎页（唯一放行的仓库根 html）与归档 html 都走沙箱 iframe。
             原先欢迎页分支排在 pdf 之后、归档 html 埋在 isArchiveFile 里 —— 合流后专门视图一律优先。
             `htmlSource` 为真时返回 null，把这一格让给下方的 paneDoc 块（可编辑 MonacoPane 显示源码）。 */
          htmlSource ? null : <WelcomeHtmlView path={page.path} />
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
                  if (!filePath && page.contentMd) filePath = await resolveAttachmentRel(page.contentMd)
                  if (filePath) openExternal(filePath)
                }}
                className="flex items-center gap-2 px-4 py-2 text-[13px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors"
              >
                <ExternalLink size={15} />
                使用 XMind 打开
              </button>
            </div>
          </div>
        ) : isPdfFile && page?.path && vaultRootId ? (
          /* ★ 批 1 落点修正（2026-10-12）：这一段原本排在 `isArchiveFile` **之后**，
             而仓库内的非 md 文件全是 entryKind:'file' ⇒ 本分支对仓库内 PDF **完全不可达**，
             用户打开仓库里的 PDF 看到的是一张元信息卡。同一坑已踩过一次并留了记录（见上方导图分支注释
             「会遮蔽导图分支」），导图那次补了、PDF 这次没补。
             现在的顺序是：导图 → html → xmind → PDF → 文本类 → 元信息卡（兜底）。
             ★ 条件用 `vaultRootId`（state）而不是 `vaultRootRef.current`：ref 变更不触发重渲染，
             与页面数据的并发装载会造成「落到下方 legacy 分支就再也回不来」的竞态。 */
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载阅读器…</div>}>
            <PdfReaderView
              key={page.path}
              rootId={vaultRootId}
              relPath={page.path}
              name={title || 'PDF 文档'}
              /* 批 2「合并公共部分」：知识库内本阅读器上方另有统一顶栏，它已承担「文件名 + N 页」，
                 故这条栏退成只留阅读控件（书架阅读态走默认 'full'，一行不动）。 */
              chrome="reader-only"
              onDocInfo={(i) => setPdfPages(i.pages)}
              /* 沉浸态上报：`immersive` 是阅读器的内部 state，它沉浸时只藏自己的栏 ——
                 不补这个回调就会「正文进沉浸、顶栏还挂着」。 */
              onImmersiveChange={setPdfImmersive}
            />
          </Suspense>
        ) : isImagePage && page?.path && vaultRootId ? (
          /* 图片（批 3，2026-10-13）：独立查看器，与 PDF 并列排在归档兜底之前。
             ★ `svgSourceEditable` 为真时返回 null，把这一格让给下方兄弟块 `{paneDoc && …}` 的
             Monaco（XML 高亮）—— 与上一格 html 源码态**完全同一个形态**：条件不含 `!svgSource`，
             靠内层返回 null 让位。这样契约 A3/A5 解析条件链先后时不必新增「互斥」语义。
             ★ 条件用 `vaultRootId`（state）而不是 ref：ref 变更不触发重渲染，
             与页面数据的并发装载会造成「落到下面兜底卡就再也回不来」的竞态（批 1 踩过）。 */
          svgSourceEditable ? null
            : img.status === 'ready' && img.url ? (
              <ImageViewer
                url={img.url}
                nat={imgNat}
                view={iv.view}
                /* 底色按格式自动（拍板 D9）：jpg / bmp 从格式定义上就不带 alpha，铺棋盘格是白铺 */
                checker={imageMayHaveAlpha(fileType)}
                onViewport={iv.onViewport}
                onPan={iv.pan}
                onZoom={iv.zoom}
                onDoubleClick={iv.doubleClick}
                onDecoded={img.onDecoded}
                onDecodeError={img.onDecodeError}
              />
            ) : (
              <ImageStateCard
                kind={img.status === 'loading' || img.status === 'idle' ? 'loading' : img.status === 'toobig' ? 'toobig' : 'broken'}
                name={title || page.path}
                path={page.path}
                sizeBytes={img.sizeBytes || page.sizeBytes}
                updatedAt={page.updatedAt}
                dims={img.dims}
                limit={img.limit}
                error={img.error}
                onOpenInSystem={() => { void handleArchiveOpenInSystem(false) }}
                onRevealInFolder={() => { void handleArchiveOpenInSystem(true) }}
                onRetry={img.reload}
              />
            )
        ) : archiveTextOpenable && page?.path && textFile?.reason === 'oversize-edit' ? (
          /* 文本类但超过编辑上限（>10MB，主进程 editable:false）：只读打开。
             正文交给 ArchiveTextView 自读，**不灌进本组件的 content state**（见自读 effect 纪律①）。 */
          <ArchiveTextView
            path={page.path}
            fileType={fileType}
            fontSize={Math.round(s.editorFontSize * zoom)}
            banner={`文件 ${Math.round((page.sizeBytes ?? 0) / 1024 / 1024)} MB，超过 10 MB 编辑上限，以只读方式打开`}
          />
        ) : isArchiveFile && !archiveTextOpenable ? (
          /* 归档兜底（批 1 收口）：只有**无法按文本打开**的类型才落到这里 ——
             二进制（detectBinary / %PDF- 头命中）、超过 50 MB 打开上限、以及未识别类型。
             文本类已在上方各自的分支里被接走（可编辑落点直接落到下方的 paneDoc 块），
             故本卡不再提供「查看内容」—— 那条两跳的路已被可编辑落点取代。 */
          <FileMetaCard
            title={title}
            fileType={fileType}
            path={page?.path}
            updatedAt={page?.updatedAt}
            sizeBytes={page?.sizeBytes}
            onOpenInSystem={() => { void handleArchiveOpenInSystem(false) }}
            onRevealInFolder={() => { void handleArchiveOpenInSystem(true) }}
          />
        ) : isPdfFile ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border-color)] shrink-0">
              <span className="flex-1 truncate text-[12px] font-medium text-[var(--text-primary)] min-w-0">{title || 'PDF 文档'}</span>
              {/* 旧版附件（不在仓库内）：无法内嵌阅读器，本地打开保留 */}
              <div className="flex items-center gap-0.5 shrink-0">
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
              <p className="text-sm">旧版附件不在仓库内，请使用本地工具打开</p>
              <button onClick={openPdfExternal}
                  className="flex items-center gap-2 px-4 py-2 text-[13px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors">
                <ExternalLink size={15} />
                使用本地工具打开
              </button>
            </div>
          </div>
        ) : preview ? (
          /* 阅读态（仅 md / txt 知识页会走到这里；归档文本类已在自读 effect 里强制 preview=false，
             即「文本类落地 = 直接编辑」）。欢迎页的 iframe 已上移到专门视图区，不再在此兜底。 */
          <div ref={previewRef} className="flex-1 overflow-y-auto px-6 pb-6 pt-14">
            <h1 className="text-xl font-bold text-[var(--text-primary)] mb-3">{title}</h1>
            <MarkdownPreview
              content={content}
              pageId={pageId}
              pageTitle={title}
              knownWikiTitles={knownWikiTitles}
              highlightWiki={flashWiki ?? undefined}
              onWikiLink={title => {
                resolveInternalLink(title)
              }}
              onLinkClick={href => {
                // 外链 → 系统浏览器
                if (/^https?:\/\//i.test(href)) { openExternal(href); return }
                // 纯锚点 → 同页滚动，不导航
                if (href.trim().startsWith('#')) return
                // ① 相对路径 → 相对**当前页所在目录**归一，按 path 精确命中（2026-10-19 修）
                const rel = resolveVaultRel(page?.path ?? '', href)
                if (rel) {
                  const byPath = allPages.find(p => (p.path ?? '').replace(/\\/g, '/') === rel)
                  if (byPath) { onNavigate(byPath.id); return }
                }
                // ② 退回按标题匹配（跨笔记「标题链接」的既有语义，保持不变）
                const basename = href.replace(/^.*[/\\]/, '')
                const titleFromPath = basename.replace(/\.[^.]+$/, '')
                let matches = allPages.filter(p => p.title === href)
                if (matches.length === 0) matches = allPages.filter(p => p.title === basename)
                if (matches.length === 0) matches = allPages.filter(p => p.title === titleFromPath)
                if (matches.length === 1) {
                  onNavigate(matches[0].id)
                } else if (matches.length > 1) {
                  setWikiPicker({ title: titleFromPath || basename, candidates: matches })
                } else {
                  // ③ 都没命中：**不再交给 openExternal** —— 相对路径会被当外部文件并被安全拦截，
                  //    用户只看到「点了没反应」。这里明确告诉他找不到。
                  showToast({ type: 'info', message: '找不到这个链接指向的页面', detail: href })
                }
              }}
            />
            {/* 内联反链（2026-10-13 批 2）：⋮ 那枚开关打开时，在正文末尾列出来源页 + 引用上下文摘录。
                条目点击与右栏「关联网络 · 被引用」**同一个动作**（跳源页 + 定位到源页引用本页处并高亮），
                走同一套 setPendingLocate + onNavigate，不另写跳转。 */}
            {inlineBacklinks && (
              <section data-wb="kbInlineBacklinks" className="mt-10 border-t border-[var(--border-color)] pt-4">
                <div className="mb-2.5 flex items-center gap-1.5">
                  <Link2 size={12} className="text-[var(--text-muted)]" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">反向链接 · {backlinks.length}</span>
                </div>
                {backlinks.length === 0 ? (
                  <p className="text-[12px] text-[var(--text-muted)]">还没有别的笔记用双链引用这一页。</p>
                ) : (
                  <ul className="space-y-2">
                    {backlinks.map(bl => (
                      <li key={bl.id}>
                        <button data-wb="kbBacklinkItem"
                          onClick={() => { setPendingLocate(bl.path ? { title: bl.linkText || bl.title, relPath: bl.path } : null); onNavigate(bl.id) }}
                          className="w-full rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-left transition-colors hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]">
                          <span className="block truncate text-[12.5px] text-[var(--text-primary)]">{bl.title || '无标题'}</span>
                          {bl.excerpt && (
                            <span className="mt-1 block text-[11.5px] leading-relaxed text-[var(--text-secondary)] line-clamp-2">{bl.excerpt}</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        ) : !paneDoc ? (
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
        ) : null}
        {/* 写作面保活（2026-09-20 反馈「切换要迅速」）：首入编辑态挂载，此后阅读态 display:none
            藏起不卸载——引擎创建是切换延迟大头（Monaco ~200ms / CM6 同量级），保活后二次切换零重挂。
            reveal 时 bump layoutKey（隐藏期间容器尺寸为 0，需显式 layout()）；外部内容变更经
            doc 最小 diff 同步，隐藏期间模型保持新鲜。写作模式由设置 `editorWritingMode` 决定
            （即时渲染档只对 .md 生效，其余文档强制源码档）。 */}
        {paneDoc && editorEverMounted && (
          <div className={preview ? 'hidden' : 'min-h-0 flex-1'}>
            <NoteSurface
              ref={paneRef}
              doc={paneDoc}
              mode={writingMode}
              onChange={(_rel, v) => { setContent(v); onContentChange?.(v) }}
              fontSize={Math.round(s.editorFontSize * zoom)}
              editorOptions={{
                fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace",
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                renderWhitespace: 'selection',
                /* 56px「正文避让」已撤（2026-09-20 反馈：顶部空一大块）——当年悬浮胶囊收窄后
                   不再需要整块避让，与内容轻微重叠由半透明毛玻璃自持；
                   批 2 胶囊整条退役、工具栏改走顶栏，避让这件事更无从谈起 */
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
                // 右键交给应用自己的写作菜单（NoteSurface 统一接管，两档同一份）
                contextmenu: false,
              }}
              onPasteImage={handleImageToMarkdown}
              onDropImage={handleImageToMarkdown}
              inlineSuggestEnabled={s.aiAssistantInlineSuggest !== false}
              inlineSuggestAuto={s.aiAssistantInlineSuggestAuto !== false}
              onFileType={(ext) => applyFileType(ext)}
              onInlineSuggestBusy={setInlineBusy}
              onInlineSuggestPaused={handleInlinePaused}
              layoutKey={editRevealTick}
            />
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
              <span className="text-[10px] text-[var(--text-secondary)] ml-1">{visibleEntryTags.length}/{MAX_TAGS}</span>
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

                {/* 引用（出链）：本页正文里的 [[…]]；点条目 → 在正文定位到该链接并高亮 */}
                <div className="flex items-center gap-1 px-3 pt-3 pb-1">
                  <Link2 size={11} className="text-[var(--text-muted)]" />
                  <span className="flex-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">引用 · {outgoing.length}</span>
                </div>
                {outgoing.map(o => (
                  <div key={o.title} onClick={() => locateWiki(o.title)}
                    className="px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                    <span className="text-[12px] truncate block" style={{ color: o.exists ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {o.exists ? o.title : `${o.title}（未解析）`}
                    </span>
                  </div>
                ))}
                {outgoing.length === 0 && (
                  <p className="px-3 py-1 text-[10px] text-[var(--text-muted)] leading-relaxed">本页暂无 [[链接]]。</p>
                )}

                {/* 被引用（反链，带上下文摘录）：点条目 → 跳源页 + 定位到源页引用本页处并高亮 */}
                <div className="flex items-center gap-1 px-3 pt-3 pb-1">
                  <StickyNote size={11} className="text-[var(--text-muted)]" />
                  <span className="flex-1 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">被引用 · {backlinks.length}</span>
                </div>
                {backlinks.map(bl => (
                  <div key={bl.id}
                    onClick={() => { setPendingLocate(bl.path ? { title: bl.linkText || bl.title, relPath: bl.path } : null); onNavigate(bl.id) }}
                    className="px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-hover)] border-b border-[var(--border-color)]">
                    <span className="text-[12px] text-[var(--text-primary)] truncate block">{bl.title || '无标题'}</span>
                  </div>
                ))}
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
