import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import {
  workspaceGetCurrent, workspaceListDir, workspaceReadFile, workspaceCreateFile,
  workspaceMkdir, workspaceRename, workspaceTrash, getSettingRaw, onAiTeachTreeRefresh,
} from '../../lib/ipc'
import { showToast } from '../../lib/toast'
import { showGlobalConfirm } from '../../lib/globalConfirm'
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
  onOpenExternal: (rel: string) => void
  /** v3.2.0 条目 ④：父组件持有的刷新计数（原始类型 prop，不破坏 memo）——自增即重扫已加载目录。
   *  两个来源共用它：外部文件系统变更广播、左栏头部的「刷新资源管理器」按钮 */
  refreshSeq?: number
}

interface CtxState { x: number; y: number; node: TreeNode | null }

function AiTeachFileTreeImpl({ activeRel, subRel = '', onOpenMd, onOpenHtml, onOpenExternal, refreshSeq }: Props) {
  const [rootId, setRootId] = useState<string | null>(null)
  const [rootDir, setRootDir] = useState('AI教学')
  const [dirCache, setDirCache] = useState<DirCache>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [ctx, setCtx] = useState<CtxState | null>(null)
  // B-14：新建 / 重命名改为树内联输入（与知识库同一机制），两个意图均受控由本组件持有
  const [creating, setCreating] = useState<CreateIntent | null>(null)
  const [renaming, setRenaming] = useState<RenameIntent | null>(null)
  const [clip, setClip] = useState<{ rel: string; name: string; isDir: boolean } | null>(null)

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
    const entries = (r?.entries ?? []).map(e => ({ ...e, relPath: rel ? `${rel}/${e.name}` : e.name }))
    setDirCache(prev => ({ ...prev, [rel]: entries }))
  }, [rootId, base])

  // 工作区/树根切换：重置缓存与展开集（P5）
  useEffect(() => {
    loadedDirsRef.current = new Set([''])
    setDirCache({})
    setExpanded(new Set(['']))
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
    if (n.name.toLowerCase().endsWith('.md')) onOpenMd(n.relPath)
    else if (/\.html?$/i.test(n.name) && onOpenHtml) onOpenHtml(n.relPath) // visual 示意图等 html → 工件栏渲染页签
    else onOpenExternal(n.relPath)
  }, [onOpenMd, onOpenHtml, onOpenExternal])

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
    void loadDir(dirRel)
    showToast({ type: 'info', message: `已创建 ${name}` })
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
    if (r && r.ok === false) { showToast({ type: 'error', message: `改名失败：${r.error ?? ''}` }); return }
    void loadDir(parent)
  }
  const doDuplicate = async (rel: string, isDir: boolean) => {
    if (!rootId) return
    if (isDir) { showToast({ type: 'warning', message: '暂不支持复制文件夹（P4 范围）' }); return }
    const src = `${base}/${rel}`
    const read = await workspaceReadFile(rootId, src).catch(() => null)
    if (!read || typeof read.content !== 'string') { showToast({ type: 'error', message: '读取源文件失败' }); return }
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const dot = rel.lastIndexOf('.')
    const stem = dot > 0 ? rel.slice(0, dot) : rel
    const ext = dot > 0 ? rel.slice(dot) : ''
    let cand = `${dir ? `${dir}/` : ''}${stem} 副本${ext}`
    for (let i = 2; (dirCache[dir] ?? []).some(e => e.name === cand.split('/').pop()); i++) cand = `${dir ? `${dir}/` : ''}${stem} 副本 ${i}${ext}`
    const r = await workspaceCreateFile(rootId, `${base}/${cand}`, read.content).catch(() => null)
    if (r && r.ok === false) { showToast({ type: 'error', message: `副本创建失败：${r.error ?? ''}` }); return }
    void loadDir(dir)
    showToast({ type: 'info', message: `已生成副本 ${cand.split('/').pop()}` })
  }
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

  const menuItems = (node: TreeNode | null): Array<{ label: string; run: () => void; danger?: boolean; disabled?: boolean }> => {
    const dirRel = node ? (node.type === 'dir' ? node.relPath : node.relPath.includes('/') ? node.relPath.slice(0, node.relPath.lastIndexOf('/')) : '') : ''
    if (!node || node.relPath === '') {
      // 根（产物目录本身，含 VaultTree 空白区右键合成的 '' 节点）：只能新建/粘贴，不可改名删除
      return [
        { label: '＋ 新建文件', run: () => doCreate('', 'file') },
        { label: '＋ 新建文件夹', run: () => doCreate('', 'dir') },
        clip ? { label: `粘贴「${clip.name}」`, run: () => void doDuplicate(clip.rel, clip.isDir), disabled: clip.isDir } : { label: '（剪贴板为空）', run: () => {}, disabled: true },
      ]
    }
    const items: ReturnType<typeof menuItems> = []
    if (node.type === 'dir') items.push({ label: '＋ 新建文件', run: () => doCreate(node.relPath, 'file') }, { label: '＋ 新建文件夹', run: () => doCreate(node.relPath, 'dir') })
    if (node.type === 'file' && node.name.toLowerCase().endsWith('.md')) items.push({ label: '打开阅读', run: () => onOpenMd(node.relPath) })
    if (node.type === 'file' && /\.html?$/i.test(node.name) && onOpenHtml) items.push({ label: '打开渲染预览', run: () => onOpenHtml(node.relPath) })
    items.push({ label: '重命名', run: () => startRename(node) })
    items.push({ label: '复制（到剪贴板）', run: () => { setClip({ rel: node.relPath, name: node.name, isDir: node.type === 'dir' }); showToast({ type: 'info', message: `已复制「${node.name}」，到目标目录右键粘贴（仅文件）` }) } })
    items.push({ label: '创建副本', run: () => void doDuplicate(node.relPath, node.type === 'dir') })
    items.push({ label: '复制路径', run: () => { void navigator.clipboard.writeText(`${base}/${node.relPath}`).catch(() => null) } })
    void dirRel
    items.push({ label: '删除（回收站）', run: () => void doDelete(node), danger: true })
    return items
  }

  if (!rootId) return <div className="px-2 py-3 text-[11.5px] text-[var(--text-muted)]">尚未打开仓库</div>

  return (
    <div className="flex flex-col h-full min-h-0" onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, node: null }) }}>
      <div className="flex-1 overflow-y-auto min-h-0 pr-0.5">
        {/* 空态：产物根还没内容时的引导文案。creating 非空时必须让位给树——内联输入行长在树里，
            空态把树替换掉的话「新建文件夹」点了会看不见输入框（B-14 之前这里是居中弹窗，不存在该问题）。 */}
        {(dirCache[''] ?? []).length === 0 && !creating ? (
          <div className="px-2.5 py-3 text-[11.5px] text-[var(--text-muted)] leading-relaxed">
            产物根「{rootDir}/」还没有内容。新建对话或点「整理成文档」后，会话文件夹会出现在这里。
            <button onClick={() => doCreate('', 'dir')} className="mt-1.5 flex items-center gap-1 text-[var(--accent)] hover:underline"><Plus size={11} /> 新建文件夹</button>
          </div>
        ) : (
          <VaultTree dirCache={dirCache} expanded={expanded} activePath={activeRel} onToggleDir={toggleDir} onOpenFile={openFile} onContextMenu={(e, n) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, node: n }) }} onMove={(src, dstDir) => {
            void (async () => {
              if (!rootId) return
              const name = src.split('/').pop() ?? src
              const to = dstDir ? `${base}/${dstDir}/${name}` : `${base}/${name}`
              const r = await workspaceRename(rootId, `${base}/${src}`, to).catch(() => null)
              if (r && r.ok === false) showToast({ type: 'error', message: `移动失败：${r.error ?? ''}` })
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
        <div className="fixed inset-0 z-[70] kb-pop-layer" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null) }}>
          {/* UI 优化条目7：w-max 显式内容宽（修 shrink-to-fit+ w-full 子项测量歧义导致的拉宽），长文案换行兜底，钳制按实际宽 */}
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

/**
 * 性能（v3.1.2）：`React.memo` 边界 —— 输入框击键 / 会话列表等父级重渲染时，
 * 若 props 浅比较未变（调用方已用 `useCallback` 稳定回调 + 传值型 props）则整棵文件树跳过重渲染。
 */
export const AiTeachFileTree = memo(AiTeachFileTreeImpl)
