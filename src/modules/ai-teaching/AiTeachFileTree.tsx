import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Plus, FilePlus, FolderPlus, ClipboardPaste, Pencil, CopyPlus, Link2, Trash2, Star, FileText, BookOpen, Eye, Image as ImageIcon } from 'lucide-react'
import { FileContextMenu, type FileMenuEntry } from '../../components/shared/FileContextMenu'
import { duplicateWorkspaceFile } from '../../lib/fileDuplicate'
import { isRenderableImagePath } from '../../lib/imageFormats'
import {
  workspaceGetCurrent, workspaceListDir, workspaceCreateFile,
  workspaceMkdir, workspaceRename, workspaceTrash, getSettingRaw, onAiTeachTreeRefresh,
  workspaceCopyPathsToClipboard,
} from '../../lib/ipc'
import { describePasteResult, isElementVisible, isExternalPasteGesture, pasteClipboardFiles } from '../../lib/externalFilePaste'
import { notifyDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { recordFileOp } from '../../lib/fileOpHistory'
import { VaultTree } from '../../components/shared/VaultTree'
import type { DirCache, TreeNode, CreateIntent, RenameIntent } from '../../components/shared/VaultTree'

/**
 * AI教学 P4 · 左栏「资源管理器」分区（总纲 §3.7，VS Code 多分区形态）
 *
 * - 树根 = 当前仓库产物根目录（`aiTeachRootDir` 设置，默认「AI教学」；P5 工作区两层后改挂工作区目录）；
 * - 复用编辑区 VaultTree 纯展示组件 + ws:* IPC 全套操作（新建/重命名/复制(副本)/删除进回收站/路径复制）；
 * - md 点击 → 中栏阅读视图（§3.9-2 方案 B）；非 md → 跳编辑器打开；
 * - 树数据里 relPath 一律为**产物根相对路径**，调 IPC 时拼 `${base}/${rel}`。
 * - B-14：新建 / 重命名与知识库**共用同一套内联输入行**（VaultTree 的 creating / renaming 受控 props）——
 *   本模块原持一套居中弹窗（z-90），同一动作两处两种长相；现已整体删除。
 */

interface Props {
  /** 当前阅读/高亮的文件（产物根相对路径） */
  activeRel: string | null
  /** P5：产物根下的子层（工作区文件夹段；空=根层，未归一/无工作区视图） */
  subRel?: string
  onOpenMd: (rel: string) => void
  /** 工件栏方案 A（2026-09-09）：.html 点击/右键=工件栏沙箱渲染页签；不传则回落编辑器 */
  onOpenHtml?: (rel: string) => void
  /** 图片（v3.6.0 阶段二）：png/jpg/… 点击/右键=工件栏图片页签（批 3 的 ImmersiveImageView）；
   *  不传则回落 onOpenExternal（外部程序打开） */
  onOpenImage?: (rel: string) => void
  onOpenExternal: (rel: string) => void
  /** v3.2.0 条目 ④：父组件持有的刷新计数（原始类型 prop，不破坏 memo）——自增即重扫已加载目录。
   *  两个来源共用它：外部文件系统变更广播、左栏头部的「刷新资源管理器」按钮 */
  refreshSeq?: number
  /** 收藏（v3.6.0）：isPinned / onTogglePin 收**仓库相对路径**；文件右键菜单「钉到收藏 / 取消收藏」用 */
  isPinned?: (rel: string) => boolean
  onTogglePin?: (rel: string, name: string) => void
}

interface CtxState { x: number; y: number; node: TreeNode | null }

/** 图片扩展名判定 —— 判据走批 3 的 `isRenderableImagePath`（应用内能渲染的那份名单是唯一真相源，
 *  这里不再手抄一份扩展名清单：多一份就会与查看器漂移） */
const isImageName = isRenderableImagePath

/** 父目录（树内相对路径）：'' = 根。与知识库/工作台树同一口径，避免三处各写一份。 */
const parentDirOf = (rel: string): string => {
  const i = rel.lastIndexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}

function AiTeachFileTreeImpl({ activeRel, subRel = '', onOpenMd, onOpenHtml, onOpenImage, onOpenExternal, refreshSeq, isPinned, onTogglePin }: Props) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [rootDir, setRootDir] = useState('AI教学')
  const [dirCache, setDirCache] = useState<DirCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [ctx, setCtx] = useState<CtxState | null>(null)
  // B-14：新建 / 重命名改为树内联输入（与知识库同一机制），两个意图均受控由本组件持有
  const [creating, setCreating] = useState<CreateIntent | null>(null)
  const [renaming, setRenaming] = useState<RenameIntent | null>(null)
  /** 树根 DOM：Ctrl+V 的可见性 / 焦点守卫（与工作台文件树同款） */
  const rootRef = useRef<HTMLDivElement>(null)
  /** 最近一次右键/点选的落点目录（树内相对路径；Ctrl+V 与右键「粘贴」共用） */
  const pasteTargetRef = useRef<string>('')

  // 仓库切换 / 挂载：取 rootId 与产物根设置并首扫
  useEffect(() => {
    let alive = true
    const boot = async () => {
      const [cur, rd] = await Promise.all([
        workspaceGetCurrent().catch(() => null),
        getSettingRaw('aiTeachRootDir').catch(() => 'AI教学'),
      ])
      if (!alive) return
      setRootId((cur as { rootId?: string } | null)?.rootId ?? null)
      setRootDir(typeof rd === 'string' && rd.trim() ? rd.trim() : 'AI教学')
      setDirCache({})
      setExpanded(new Set(['']))
    }
    void boot()
    return () => { alive = false }
  }, [])

  const loadedDirsRef = useRef<Set<string>>(new Set(['']))
  // 树根 = 产物根（+ P5 工作区子层）；树内 relPath 都相对该根，调 IPC 时拼 base 前缀
  const base = subRel ? rootDir + '/' + subRel : rootDir
  const loadDir = useCallback(async (rel: string) => {
    if (!rootId) return
    loadedDirsRef.current.add(rel)
    const r = await workspaceListDir(rootId, rel ? `${base}/${rel}` : base).catch(() => null)
    const entries = (r?.entries ?? [])
      .map(e => ({ ...e, relPath: rel ? `${rel}/${e.name}` : e.name }))
      // 章文件夹是本模块的结构主体：按数字自然序（第1章 → 第2章 → 第10章），
      // 不沿用主进程的纯字典序（第10章会跑到第1章前面）。目录恒在文件前。
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
      })
    setDirCache(prev => ({ ...prev, [rel]: entries }))
  }, [rootId, base])

  // 工作区/树根切换：重置缓存与展开集（P5）
  useEffect(() => {
    loadedDirsRef.current = new Set([''])
    setDirCache({})
    setExpanded(new Set(['']))
    pasteTargetRef.current = ''
  }, [base])

  useEffect(() => { void loadDir('') }, [loadDir])
  // AI 产物落盘/整理联动即时可见（§3.7-1）：广播 → 重扫已展开目录
  useEffect(() => {
    return onAiTeachTreeRefresh(() => {
      loadedDirsRef.current.forEach(k => { void loadDir(k) })
    })
  }, [loadDir])

  // v3.2.0 条目 ④：refreshSeq 自增（外部文件系统变更 / 手动刷新按钮）→ 重扫已加载目录。
  // 用 ref 记上次值，保证只在**变化**时重扫（首次挂载不重复读一次目录）。
  const refreshSeqRef = useRef(refreshSeq)
  useEffect(() => {
    if (refreshSeq === undefined || refreshSeqRef.current === refreshSeq) return
    refreshSeqRef.current = refreshSeq
    loadedDirsRef.current.forEach(k => { void loadDir(k) })
  }, [refreshSeq, loadDir])

  const toggleDir = useCallback((rel: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else { next.add(rel); void loadDir(rel) }
      return next
    })
  }, [loadDir])

  const openFile = useCallback((n: TreeNode) => {
    const nm = n.name.toLowerCase()
    // md / 导图 JSON / pptx → 右栏工件栏开页签（不跳模块，左聊右看）；html 走渲染预览；
    // 图片（v3.6.0 阶段二）→ 工件栏图片页签（批 3 查看器）；其余走外部
    if (nm.endsWith('.md') || nm.endsWith('.json') || nm.endsWith('.pptx')) onOpenMd(n.relPath)
    else if (/\.html?$/i.test(n.name) && onOpenHtml) onOpenHtml(n.relPath) // visual 示意图等 html → 工件栏渲染页签
    else if (isImageName(n.name) && onOpenImage) onOpenImage(n.relPath) // outputs/*.png 等生图产物 → 工件栏图片页签
    else onOpenExternal(n.relPath)
  }, [onOpenMd, onOpenHtml, onOpenImage, onOpenExternal])

  // ---- 操作 ----
  /** 新建入口（B-14）：只落「内联输入意图」，真正写入在 commitCreate。
   *  先确保落点目录展开——内联行渲染在目录子级里，目录收着的话输入框根本不可见（表现为「点了没反应」）。 */
  const doCreate = (dirRel: string, type: 'file' | 'dir') => {
    if (dirRel) setExpanded(prev => (prev.has(dirRel) ? prev : new Set(prev).add(dirRel)))
    setCreating({ dirRel, type })
  }
  /** 内联行提交（Enter）：空名 = 放弃（与笔记区一致，不写盘）；Esc / 失焦走 onCancelCreate */
  const commitCreate = async (dirRel: string, type: 'file' | 'dir', rawName: string) => {
    setCreating(null)
    const name = rawName.trim()
    if (!name) { showToast({ type: 'warning', message: '名称不能为空' }); return }
    if (!rootId) { showToast({ type: 'error', message: '尚未打开仓库，无法创建' }); return }
    const rel = dirRel ? `${dirRel}/${name}` : name
    const full = `${base}/${rel}`
    const r = type === 'file'
      ? await workspaceCreateFile(rootId, full).catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
      : await workspaceMkdir(rootId, full).catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
    if (!r || r.ok === false) { showToast({ type: 'error', message: `创建失败：${(r as { error?: string })?.error ?? 'IPC 无响应'}` }); return }
    // 记入跨模块撤销栈（v3.16.1 F-5）：主进程重名会自动加后缀，路径以返回值为准
    const createdFull = (r as { relPath?: string }).relPath ?? full
    const createdName = createdFull.slice(createdFull.lastIndexOf('/') + 1)
    recordFileOp({ kind: 'create', rootId, relPath: createdFull, isDir: type === 'dir', name: createdName })
    void loadDir(dirRel)
    showToast({ type: 'info', message: `已创建 ${name} · Ctrl+Z 可撤回` })
  }
  /** 重命名入口（B-14）：同样只落内联意图；目标目录本就在展开态（条目可见才能右键到它） */
  const startRename = (n: TreeNode) => setRenaming({ relPath: n.relPath })
  const commitRename = async (relPath: string, rawName: string) => {
    setRenaming(null)
    const name = rawName.trim()
    const curName = relPath.slice(relPath.lastIndexOf('/') + 1)
    if (!name || name === curName || !rootId) return
    const parent = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
    const to = `${base}/${parent ? `${parent}/` : ''}${name}`
    const r = await workspaceRename(rootId, `${base}/${relPath}`, to).catch(() => null)
    if (!r || r.ok === false) { showToast({ type: 'error', message: `改名失败：${r?.error ?? 'IPC 无响应'}` }); return }
    recordFileOp({ kind: 'move', rootId, from: `${base}/${relPath}`, to, name })
    void loadDir(parent)
    showToast({ type: 'info', message: `已重命名为 ${name} · Ctrl+Z 可撤回` })
  }
  const doDuplicate = async (rel: string, isDir: boolean) => {
    if (!rootId) return
    if (isDir) { showToast({ type: 'warning', message: '暂不支持复制文件夹' }); return }
    const r = await duplicateWorkspaceFile(rootId, `${base}/${rel}`).catch(() => null)
    if (!r || r.ok === false) { showToast({ type: 'error', message: r?.error || '创建副本失败' }); return }
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    void loadDir(dir)
    showToast({ type: 'info', message: `已生成副本 ${r.relPath?.split('/').pop() ?? ''}` })
  }
  /**
   * B-51（2026-11-09）：复制到系统剪贴板 + 应用内文件剪贴板。
   * 绝对路径由主进程用 `{ rootId, relPath }` 解析，渲染层不接触（铁律 3）。
   * 这样工作台/笔记区的粘贴链路（读剪贴板 → ws:pasteExternal）无需改动即可识别。
   */
  const doCopy = async (n: TreeNode) => {
    if (!rootId) return
    const r = await workspaceCopyPathsToClipboard(rootId, [`${base}/${n.relPath}`])
      .catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
    if (!r.ok) { showToast({ type: 'error', message: `复制失败：${r.error || '写入剪贴板失败'}` }); return }
    showToast({ type: 'info', message: `已复制「${n.name}」，到目标目录右键粘贴或 Ctrl+V` })
  }
  /** 粘贴到树内目录（dirRel = 树内相对路径；'' = 产物根）。读应用内/系统剪贴板，落盘走 ws:pasteExternal。 */
  const pasteInto = useCallback(async (dirRel: string) => {
    if (!rootId) { showToast({ type: 'error', message: '尚未打开仓库' }); return }
    const fullDir = dirRel ? `${base}/${dirRel}` : base
    const r = await pasteClipboardFiles(rootId, fullDir)
    if (!r) { showToast({ type: 'warning', message: '剪贴板里没有可粘贴的文件' }); return }
    if (r.pasted.some((n) => n.toLowerCase().endsWith('.md'))) {
      notifyDataChanged('knowledge') // 与知识库粘贴同口径：md 会影响列表/图谱/搜索
    }
    showToast(describePasteResult(r))
    if (r.pasted.length > 0) void loadDir(dirRel)
  }, [rootId, base, loadDir])

  // Ctrl+V：与工作台文件树同款「window keydown + 主进程剪贴板」。
  // 不用元素级 onPaste —— 非可编辑焦点下 Chromium 不派发 paste 事件（Linux 实测）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isExternalPasteGesture(e)) return
      const el = rootRef.current
      if (!isElementVisible(el)) return
      const active = document.activeElement
      const focusedInTree = !!active && (active === el || el.contains(active))
      const neutralFocus = !active || active === document.body || active === document.documentElement
      if (!focusedInTree && !neutralFocus) return
      e.preventDefault()
      void pasteInto(pasteTargetRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pasteInto])
  const doDelete = async (n: TreeNode) => {
    if (!rootId) return
    if (n.relPath.split('/').some(seg => seg.startsWith('.'))) { showToast({ type: 'warning', message: '锚点/隐藏文件不可在此删除' }); return }
    const okGo = await showGlobalConfirm({ title: `删除「${n.name}」`, message: `将把 ${rootDir}/${n.relPath} 移入系统回收站（可在回收站找回）。`, confirmLabel: '删除', variant: 'danger' })
    if (!okGo) return
    const r = await workspaceTrash(rootId, `${base}/${n.relPath}`).catch(() => null)
    if (r && r.ok === false) { showToast({ type: 'error', message: `删除失败：${r.error ?? ''}` }); return }
    const parent = n.relPath.includes('/') ? n.relPath.slice(0, n.relPath.lastIndexOf('/')) : ''
    void loadDir(parent)
  }

  const menuItems = (node: TreeNode | null): FileMenuEntry[] => {
    if (!node || node.relPath === '') {
      // 根（产物目录本身，含 VaultTree 空白区右键合成的 '' 节点）：只能新建/粘贴，不可改名删除
      return [
        { key: 'newFile', label: '新建文件', icon: <FilePlus size={15} />, onSelect: () => doCreate('', 'file') },
        { key: 'newDir', label: '新建文件夹', icon: <FolderPlus size={15} />, onSelect: () => doCreate('', 'dir') },
        { key: 'paste', label: '粘贴系统剪贴板', icon: <ClipboardPaste size={15} />, onSelect: () => { pasteTargetRef.current = ''; void pasteInto('') } },
      ]
    }
    const items: FileMenuEntry[] = []
    if (node.type === 'dir') {
      items.push(
        { key: 'newFile', label: '新建文件', icon: <FilePlus size={15} />, onSelect: () => doCreate(node.relPath, 'file') },
        { key: 'newDir', label: '新建文件夹', icon: <FolderPlus size={15} />, onSelect: () => doCreate(node.relPath, 'dir') },
        { key: 'paste', label: '粘贴系统剪贴板', icon: <ClipboardPaste size={15} />, onSelect: () => { pasteTargetRef.current = node.relPath; void pasteInto(node.relPath) } },
        { separator: true },
      )
    }
    if (node.type === 'file' && (node.name.toLowerCase().endsWith('.md') || node.name.toLowerCase().endsWith('.json') || node.name.toLowerCase().endsWith('.pptx'))) {
      items.push({ key: 'read', label: '打开阅读', icon: <BookOpen size={15} />, onSelect: () => onOpenMd(node.relPath) })
    }
    if (node.type === 'file' && /\.html?$/i.test(node.name) && onOpenHtml) {
      items.push({ key: 'preview', label: '打开渲染预览', icon: <Eye size={15} />, onSelect: () => onOpenHtml(node.relPath) })
    }
    // 图片（v3.6.0 阶段二）：生图产物（outputs/*.png）在这里右键即可进工件栏看图
    if (node.type === 'file' && isImageName(node.name) && onOpenImage) {
      items.push({ key: 'viewImage', label: '查看图片', icon: <ImageIcon size={15} />, onSelect: () => onOpenImage(node.relPath) })
    }
    items.push({ key: 'rename', label: '重命名', icon: <Pencil size={15} />, onSelect: () => startRename(node) })
    items.push({ key: 'copy', label: '复制（到剪贴板）', icon: <ClipboardPaste size={15} />, onSelect: () => void doCopy(node) })
    items.push({ key: 'dup', label: '创建副本', icon: <CopyPlus size={15} />, onSelect: () => void doDuplicate(node.relPath, node.type === 'dir') })
    items.push({ key: 'copyPath', label: '复制路径', icon: <Link2 size={15} />, onSelect: () => { void navigator.clipboard.writeText(`${base}/${node.relPath}`).catch(() => null) } })
    // 收藏（v3.6.0）：文件可钉到左栏顶部「收藏」（rel 用仓库相对路径）
    if (node.type === 'file' && onTogglePin) {
      const repoRel = `${base}/${node.relPath}`
      items.push({ key: 'pin', label: isPinned?.(repoRel) ? '取消收藏' : '★ 钉到收藏', icon: <Star size={15} />, onSelect: () => onTogglePin(repoRel, node.name) })
    }
    items.push({ separator: true })
    items.push({ key: 'delete', label: '删除（回收站）', icon: <Trash2 size={15} />, danger: true, onSelect: () => void doDelete(node) })
    return items
  }

  if (!rootId) return <div className="px-2 py-3 text-[11.5px] text-[var(--text-muted)]">尚未打开仓库</div>

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex flex-col h-full min-h-0 outline-none"
      onContextMenu={(e) => { e.preventDefault(); pasteTargetRef.current = ''; setCtx({ x: e.clientX, y: e.clientY, node: null }) }}
    >
      <div className="flex-1 overflow-y-auto min-h-0 pr-0.5">
        {/* 空态：产物根还没内容时的引导文案。creating 非空时必须让位给树——内联输入行长在树里，
            空态把树替换掉的话「新建文件夹」点了会看不见输入框（B-14 之前这里是居中弹窗，不存在该问题）。 */}
        {(dirCache[''] ?? []).length === 0 && !creating ? (
          <div className="px-2.5 py-3 text-[11.5px] text-[var(--text-muted)] leading-relaxed">
            产物根「{rootDir}/」还没有内容。新建对话或点「整理成文档」后，会话文件夹会出现在这里。
            <button onClick={() => doCreate('', 'dir')} className="mt-1.5 flex items-center gap-1 text-[var(--accent)] hover:underline"><Plus size={11} /> 新建文件夹</button>
          </div>
        ) : (
          <VaultTree dirCache={dirCache} expanded={expanded} activePath={activeRel} onToggleDir={(rel) => { pasteTargetRef.current = rel; toggleDir(rel) }} onOpenFile={(n) => { pasteTargetRef.current = parentDirOf(n.relPath); openFile(n) }} onContextMenu={(e, n) => { e.preventDefault(); e.stopPropagation(); pasteTargetRef.current = n.type === 'dir' ? n.relPath : parentDirOf(n.relPath); setCtx({ x: e.clientX, y: e.clientY, node: n }) }} onMove={(src, dstDir) => {
            void (async () => {
              if (!rootId) return
              const name = src.split('/').pop() ?? src
              const to = dstDir ? `${base}/${dstDir}/${name}` : `${base}/${name}`
              const r = await workspaceRename(rootId, `${base}/${src}`, to).catch(() => null)
              if (!r || r.ok === false) {
                showToast({ type: 'error', message: `移动失败：${r?.error ?? 'IPC 无响应'}` })
                return
              }
              // 记入跨模块撤销栈（v3.16.1 F-5）：fileOpHistory 用仓库相对路径，树内是产物根相对路径
              recordFileOp({ kind: 'move', rootId, from: `${base}/${src}`, to, name })
              showToast({ type: 'info', message: `已移动 ${name} · Ctrl+Z 可撤回` })
              const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
              void loadDir(srcParent); void loadDir(dstDir)
            })()
          }}
          /* B-14：新建 / 重命名复用共享树的内联输入行（与知识库同一实现、同一 Esc/失焦语义） */
          creating={creating}
          onCommitCreate={(dirRel, type, rawName) => { void commitCreate(dirRel, type as 'file' | 'dir', rawName) }}
          onCancelCreate={() => setCreating(null)}
          renaming={renaming}
          onCommitRename={(relPath, rawName) => { void commitRename(relPath, rawName) }}
          onCancelRename={() => setRenaming(null)}
          />
        )}
      </div>

      {ctx && (
        <FileContextMenu x={ctx.x} y={ctx.y} items={menuItems(ctx.node)} onClose={() => setCtx(null)} />
      )}
    </div>
  )
}

/**
 * 性能（v3.1.2）：`React.memo` 边界 —— 输入框击键 / 会话列表等父级重渲染时，
 * 若 props 浅比较未变（调用方已用 `useCallback` 稳定回调 + 传值型 props）则整棵文件树跳过重渲染。
 */
export const AiTeachFileTree = memo(AiTeachFileTreeImpl)
