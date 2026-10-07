import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  deleteKnowledgeCategory, getKnowledgeCategories, getPathForFile,
  workspaceCreateFile, workspaceGetCurrent, workspaceListDir, workspaceMkdir,
  workspacePasteExternal, workspaceRename, workspaceTrash,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { showGlobalConfirm } from '../../lib/globalConfirm'
import { recordFileOp } from '../../lib/fileOpHistory'
import { useDataChanged } from '../../lib/dataChanged'
import { VaultTree } from '../shared/VaultTree'
import type { DirCache, TreeNode, CreateIntent, RenameIntent } from '../shared/VaultTree'

/**
 * 工作台左栏「文件树模式」的仓库根文件树（方案 .claude/plans/workbench-tree-mode-implementation.md）。
 *
 * - 树根 = 仓库根（无 base 前缀，relPath 即仓库相对路径）；
 * - 复用编辑区 VaultTree 纯展示组件 + ws:* IPC 全套操作（新建文件/文件夹/知识页 / 内联重命名 /
 *   删除进回收站 / 复制路径 / 系统剪贴板粘贴 / 拖拽移动），自持宿主形态照 AiTeachFileTree；
 * - 文件点击 → onOpenFile(rel)（宿主接 kb-open-note + startEdit，一律进编辑态）；
 * - 分类目录（categories.json 登记项）删除时走 deleteKnowledgeCategory 同步清登记，
 *   避免回收站删除在 categories.json 留下脏条目（方案 §2.1）。
 */

interface Props {
  onOpenFile: (rel: string) => void
  /** 目录聚焦开关（受控）：状态与按钮都在宿主（WorkbenchLeftPanel 的树模式头部行，
   *  与 🏠 同排 —— 开发负责人 2026-09-29 指定）。语义复用 FolderFocusButton + VaultTree 的
   *  focusOn/onFocusLocate 一套；这里是临时视图开关，不进 settings（与知识库的持久化偏好不同）。 */
  focusOn?: boolean
  /** 点骨架条（退出聚焦并定位）时通知宿主关掉开关；本组件负责展开/定位 */
  onFocusExit?: () => void
}

interface CtxState { x: number; y: number; node: TreeNode | null }

/** 删除动画两阶段（knowledge deleteWithAnimation 同节奏：animating →(DECAY)→ done →(420ms)→ 摘除） */
const DELETE_ANIM_MS = 600
const DELETE_FADE_MS = 420

function WorkbenchFileTreeImpl({ onOpenFile, focusOn = false, onFocusExit }: Props) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [dirCache, setDirCache] = useState<DirCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [ctx, setCtx] = useState<CtxState | null>(null)
  const [creating, setCreating] = useState<CreateIntent | null>(null)
  const [renaming, setRenaming] = useState<RenameIntent | null>(null)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [softNames, setSoftNames] = useState<string[]>([])
  // 删除动画状态：VaultTree 以 deletingMap 内容驱动动画，但 Map 引用不变不会触发重渲染——
  // 用 version 自增伴随每次 set（Map 原地改 + version 触发宿主重渲染）
  const deletingMap = useMemo(() => new Map<string, 'animating' | 'done'>(), [])
  const [deletingVersion, setDeletingVersion] = useState(0)
  const touch = () => setDeletingVersion((v) => v + 1)
  const rootRef = useRef<HTMLDivElement>(null)
  const rootIdRef = useRef<string | null>(null)
  rootIdRef.current = rootId

  /** 收集已加载目录集合（懒加载语义：只重扫已展开的，不做全量重扫） */
  const loadedDirsRef = useRef<Set<string>>(new Set(['']))

  const loadDir = useCallback(async (rel: string) => {
    const root = rootIdRef.current
    if (!root) return
    loadedDirsRef.current.add(rel)
    const r = await workspaceListDir(root, rel).catch(() => null)
    if (!r || r.error) return
    if (rel === '') setSoftNames(r.softNames ?? [])
    const entries = (r.entries ?? []).map((e) => ({ ...e, relPath: rel ? `${rel}/${e.name}` : e.name })) as TreeNode[]
    setDirCache((prev) => ({ ...prev, [rel]: entries }))
  }, [])

  // 挂载 / 仓库切换：取 rootId 并首扫（重置缓存与展开集，AiTeachFileTree 同款）
  useEffect(() => {
    let alive = true
    void (async () => {
      const cur = await workspaceGetCurrent().catch(() => null)
      if (!alive) return
      const rid = cur?.rootId ?? null
      setRootId(rid)
      rootIdRef.current = rid
    })()
    return () => { alive = false }
  }, [])

  // 仓库切换：清缓存、折叠全部、重扫根层
  useEffect(() => {
    if (!rootId) return
    loadedDirsRef.current = new Set([''])
    setDirCache({})
    setExpanded(new Set(['']))
    void loadDir('')
  }, [rootId, loadDir])

  // 刷新通道：结构性写盘广播（ws 五 handler 补的 broadcastDataChanged('knowledge')）→ 重扫已加载目录
  useDataChanged('knowledge', () => {
    loadedDirsRef.current.forEach((k) => { void loadDir(k) })
  })
  // 仓库切换事件（非广播路径，保险通道）
  useEffect(() => {
    const onVault = () => {
      void workspaceGetCurrent().then((cur) => {
        const rid = cur?.rootId ?? null
        if (rid !== rootIdRef.current) setRootId(rid)
      }).catch(() => {})
    }
    window.addEventListener('vault:changed', onVault)
    return () => window.removeEventListener('vault:changed', onVault)
  }, [])

  const toggleDir = useCallback((rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else { next.add(rel); void loadDir(rel) }
      return next
    })
  }, [loadDir])

  const doCreate = (dirRel: string, type: 'file' | 'dir' | 'knowledge') => {
    // 内联输入行长在目录子级里，目录收着的话不可见（「点＋没反应」= 这个坑，知识库/AI 教学同款注释）
    if (dirRel) setExpanded((prev) => (prev.has(dirRel) ? prev : new Set(prev).add(dirRel)))
    setCreating({ dirRel, type, initial: type === 'knowledge' ? '未命名知识页' : undefined })
  }

  const commitCreate = async (dirRel: string, type: 'file' | 'dir' | 'knowledge', rawName: string) => {
    setCreating(null)
    const name = rawName.trim()
    if (!name) return // 空名 = 放弃（与知识库/AI 教学同口径，不写盘）
    const root = rootIdRef.current
    if (!root) { showToast({ type: 'error', message: '尚未打开仓库，无法创建' }); return }
    try {
      if (type === 'knowledge') {
        const mdName = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`
        const mdRel = dirRel ? `${dirRel}/${mdName}` : mdName
        const base = mdName.replace(/\.[^.]+$/, '')
        const id = crypto.randomUUID()
        const r = await workspaceCreateFile(root, mdRel, `---\nid: ${id}\ntitle: ${base}\n---\n\n`)
        if (!r.ok) { showToast({ type: 'error', message: r.error || '创建失败' }); return }
        showToast({ type: 'info', message: `已创建 ${mdName}` })
        void loadDir(dirRel)
        onOpenFile(mdRel)
        return
      }
      const rel = dirRel ? `${dirRel}/${name}` : name
      const r = type === 'dir' ? await workspaceMkdir(root, rel) : await workspaceCreateFile(root, rel)
      if (!r.ok) { showToast({ type: 'error', message: r.error || '创建失败' }); return }
      showToast({ type: 'info', message: `已创建 ${r.relPath?.split('/').pop() ?? name}` })
      void loadDir(dirRel)
      // 新建的 md 也直接打开（.type === 'file'）
      if (type === 'file' && r.relPath) onOpenFile(r.relPath)
    } catch (e) {
      showToast({ type: 'error', message: `创建失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const commitRename = async (relPath: string, rawName: string) => {
    setRenaming(null)
    const name = rawName.trim()
    const curName = relPath.slice(relPath.lastIndexOf('/') + 1)
    if (!name || name === curName) return
    const root = rootIdRef.current
    if (!root) return
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
    const to = `${dir ? `${dir}/` : ''}${name}`
    const r = await workspaceRename(root, relPath, to).catch(() => null)
    if (!r || r.ok === false) { showToast({ type: 'error', message: `改名失败：${(r as { error?: string } | null)?.error ?? ''}` }); return }
    recordFileOp({ kind: 'move', rootId: root, from: relPath, to, name })
    void loadDir(dir)
    // 树局部高亮跟随改名（自身与子孙；跨模块开页签的改名同步由广播自愈）
    setActivePath((ap) => {
      if (!ap) return ap
      if (ap === relPath) return to
      if (ap.startsWith(relPath + '/')) return to + ap.slice(relPath.length)
      return ap
    })
  }

  const doMove = useCallback((src: string, dstDir: string) => {
    void (async () => {
      const root = rootIdRef.current
      if (!root) return
      const name = src.split('/').pop() ?? src
      const to = dstDir ? `${dstDir}/${name}` : name
      if (to === src) return
      const r = await workspaceRename(root, src, to).catch(() => null)
      if (!r || r.ok === false) { showToast({ type: 'error', message: `移动失败：${(r as { error?: string } | null)?.error ?? ''}` }); return }
      recordFileOp({ kind: 'move', rootId: root, from: src, to, name })
      const srcParent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
      void loadDir(srcParent); void loadDir(dstDir)
      setActivePath((ap) => {
        if (!ap) return ap
        if (ap === src) return to
        if (ap.startsWith(src + '/')) return to + ap.slice(src.length)
        return ap
      })
    })()
  }, [loadDir])

  /** 右键「粘贴」：记住目标目录、聚焦树容器并提示按 Ctrl+V
   *  （路径只能从渲染层 paste 事件取——主进程 clipboard.readBuffer 拿不全多选，见 knowledge 同款注释） */
  const pasteTargetRef = useRef<string>('')
  const armPaste = (dirRel: string) => {
    pasteTargetRef.current = dirRel
    rootRef.current?.focus()
    showToast({ type: 'info', message: `按 Ctrl+V 粘贴剪贴板中的文件${dirRel ? `到「${dirRel}」` : ''}` })
  }

  const doDelete = (node: TreeNode) => {
    void (async () => {
      const root = rootIdRef.current
      if (!root) return
      const isDir = node.type === 'dir'
      const ok = await showGlobalConfirm({
        title: isDir ? '删除目录' : '删除文件',
        message: isDir
          ? `目录「${node.name}」及其下全部内容将一并移入系统回收站。确定删除吗？`
          : `「${node.name}」将移入系统回收站。确定删除吗？`,
        confirmLabel: '删除',
        cancelLabel: '取消',
        variant: 'danger',
      })
      if (!ok) return
      // 分类目录分流：categories.json 登记目录 → deleteKnowledgeCategory 同步清登记（方案 §2.1）
      let catId: string | null = null
      if (isDir) {
        const cats = await getKnowledgeCategories().catch(() => [])
        catId = cats.find((c) => c.path === node.relPath)?.id ?? null
      }
      deletingMap.set(node.relPath, 'animating')
      touch()
      try {
        if (catId) await deleteKnowledgeCategory(catId)
        else {
          const res = await workspaceTrash(root, node.relPath)
          if (!res.ok) throw new Error(res.error || '删除失败')
        }
        showToast({ type: 'info', message: `已移入回收站：${node.name}` })
        // 两阶段时序照 knowledge deleteWithAnimation：吞噬播完 → done（收尾淡出）→ 摘除并刷新父目录
        setTimeout(() => {
          deletingMap.set(node.relPath, 'done')
          touch()
          setTimeout(() => {
            deletingMap.delete(node.relPath)
            touch()
            // 丢弃被删目录自己的缓存（其子缓存随之失效，展开时按需重拉）
            setDirCache((prev) => { const n = { ...prev }; delete n[node.relPath]; return n })
            void loadDir('')
            setActivePath((ap) => (ap && (ap === node.relPath || ap.startsWith(node.relPath + '/')) ? null : ap))
          }, DELETE_FADE_MS)
        }, DELETE_ANIM_MS - DELETE_FADE_MS)
      } catch (e) {
        deletingMap.delete(node.relPath)
        touch()
        showToast({ type: 'error', message: e instanceof Error ? e.message : '删除失败' })
      }
    })()
  }

  const menuItems = (node: TreeNode | null): Array<{ label: string; run: () => void; danger?: boolean; disabled?: boolean }> => {
    if (!node || node.relPath === '') {
      return [
        { label: '＋ 新建文件', run: () => doCreate('', 'file') },
        { label: '＋ 新建文件夹', run: () => doCreate('', 'dir') },
        { label: '＋ 新建知识页', run: () => doCreate('', 'knowledge') },
        { label: '粘贴系统剪贴板', run: () => armPaste('') },
      ]
    }
    const items: Array<{ label: string; run: () => void; danger?: boolean; disabled?: boolean }> = []
    if (node.type === 'dir') items.push(
      { label: '＋ 新建文件', run: () => doCreate(node.relPath, 'file') },
      { label: '＋ 新建文件夹', run: () => doCreate(node.relPath, 'dir') },
      { label: '＋ 新建知识页', run: () => doCreate(node.relPath, 'knowledge') },
      { label: '粘贴系统剪贴板', run: () => armPaste(node.relPath) },
    )
    items.push({ label: '重命名', run: () => setRenaming({ relPath: node.relPath }) })
    items.push({ label: '复制路径', run: () => { void navigator.clipboard.writeText(node.relPath).catch(() => null); showToast({ type: 'info', message: '已复制路径' }) } })
    items.push({ label: '删除（回收站）', run: () => doDelete(node), danger: true })
    return items
  }

  // 粘贴：只拦文件（纯文本放行，编辑区默认行为不受影响）；目标目录 = 最近一次右键点选的目录（缺省根）
  const handlePaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    void (async () => {
      const root = rootIdRef.current
      if (!root) { showToast({ type: 'error', message: '尚未打开仓库' }); return }
      const paths: string[] = []
      for (const f of files) {
        try { const p = getPathForFile(f); if (p) paths.push(p) } catch { /* 取不到路径的条目丢弃 */ }
      }
      if (!paths.length) { showToast({ type: 'warning', message: '剪贴板里没有可粘贴的文件' }); return }
      const dirRel = pasteTargetRef.current
      const r = await workspacePasteExternal(root, dirRel, paths).catch(() => null)
      if (!r) { showToast({ type: 'error', message: '粘贴失败' }); return }
      if (r.pasted.length === 0) {
        showToast({
          type: 'warning',
          message: r.reason === 'empty' ? '剪贴板里没有可粘贴的文件' : `粘贴失败：${r.error || r.skipped[0]?.reason || '未知原因'}`,
        })
        return
      }
      const skippedNote = r.skipped.length > 0 ? `，已跳过 ${r.skipped.length} 项` : ''
      showToast({ type: r.skipped.length > 0 ? 'warning' : 'success', message: `已粘贴 ${r.pasted.length} 项${skippedNote}` })
      const dir = dirRel.includes('/') ? dirRel.slice(0, dirRel.lastIndexOf('/')) : ''
      void loadDir(dirRel)
      void loadDir(dir)
    })()
  }

  if (!rootId) return <div className="px-2 py-3 text-[11.5px] text-[var(--text-muted)]">尚未打开仓库</div>

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex flex-col h-full min-h-0 outline-none"
      onPaste={handlePaste}
    >
      {/* flex 链路：本 div 与 VaultTree 根都要能铺满可视区，否则条目下方的空白
          落在容器上、树根收不到 contextmenu（「空白处右键新建文件点不动」，2026-09-29 修） */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden pr-0.5" data-wb="fileTree">
        <VaultTree
          dirCache={dirCache}
          expanded={expanded}
          activePath={activePath}
          softNames={softNames}
          hideSoft
          focusOn={focusOn}
          onFocusLocate={(rel, isDir) => {
            onFocusExit?.()
            setExpanded((prev) => (isDir ? new Set(prev).add(rel) : prev))
          }}
          onToggleDir={toggleDir}
          onOpenFile={(n) => { setActivePath(n.relPath); onOpenFile(n.relPath) }}
          onContextMenu={(e, n) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, node: n }) }}
          onMove={doMove}
          creating={creating}
          onCommitCreate={(dirRel, type, rawName) => { void commitCreate(dirRel, type as 'file' | 'dir', rawName) }}
          onCancelCreate={() => setCreating(null)}
          renaming={renaming}
          onCommitRename={(relPath, rawName) => { void commitRename(relPath, rawName) }}
          onCancelRename={() => setRenaming(null)}
          deletingMap={deletingVersion >= 0 ? deletingMap : undefined}
          rootRef={rootRef}
        />
      </div>

      {/* 右键菜单 portal 到 body：左栏面板的变换/收缩容器会改写 fixed 的包含块（书签菜单同款坑，方案 §2.1） */}
      {ctx && (
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null) }}>
          <div className="absolute min-w-[160px] w-max max-w-[280px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-xl py-1"
            style={{ left: Math.min(ctx.x, window.innerWidth - 290), top: Math.min(ctx.y, window.innerHeight - 300) }}>
            {menuItems(ctx.node).map((it, i) => (
              <button key={i} disabled={it.disabled} onClick={() => { setCtx(null); it.run() }}
                className={`w-full text-left px-3 py-1.5 text-[12px] leading-snug transition-colors disabled:opacity-40 ${it.danger ? 'text-red-400 hover:bg-[var(--bg-hover)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'}`}>
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** VaultTree 根容器空白区右键也走 onContextMenu（'' 节点），本组件无需再挂容器级 contextmenu */

export const WorkbenchFileTree = memo(WorkbenchFileTreeImpl)
