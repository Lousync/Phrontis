import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, ChevronDown, ExternalLink, FolderOpen, FolderPlus, MinusCircle, MoreHorizontal, Pencil, Layers, Trash2 } from 'lucide-react'
import {
  workspaceCreateVault, workspaceDeleteVault, workspaceForget, workspaceGetCurrent,
  workspaceGetRecent, workspaceOpenById, workspaceRenameVault, workspaceRevealVault,
} from '../../lib/ipc'
import { openVaultWithGuide } from '../../lib/vaultOpen'
import { showToast } from '../../lib/toast'
import type { WorkspaceRecent } from '../../types'

/**
 * 仓库切换器（P8 / D8 → UI 打磨点1 迁至编辑器侧栏底部）：条形按钮 → 向上弹出面板
 * （最近仓库 / 打开其他 / 文件管理器打开 / 重命名 / 新建）。
 * 形态从简：切换与新建后整窗重载（数据激活重读约定）；重命名只改展示名（不动文件夹）。
 * 弹层走 portal + fixed 定位：侧栏面板根是 overflow-hidden，窄侧栏（minWidth 180 < 菜单 260）
 * 时 absolute 菜单会被裁剪（2026-09-08 用户验收实锤），portal 后不受任何祖先裁剪。
 *
 * 仓库列表管理（2026-10-20）：每行右侧「⋯」→ 从列表移除（保留文件夹）/ 删除仓库文件夹
 * （整仓移入系统回收站）。两步都在菜单内行内确认，不弹中央模态。
 */
export function VaultSwitcher() {
  const [cur, setCur] = useState<{ rootId: string; name: string; path: string } | null>(null)
  const [recent, setRecent] = useState<WorkspaceRecent[]>([])
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'list' | 'create' | 'rename'>('list')
  const [manage, setManage] = useState<{ v: WorkspaceRecent; confirm: 'none' | 'forget' | 'trash' } | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => { void workspaceGetCurrent().then(setCur).catch(() => {}) }, [])

  const toggleMenu = (): void => {
    if (!open) {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) {
        // 菜单 260 宽 + 8px 屏幕边距，右缘防溢出夹取；bottom 锚定按钮顶缘 → 向上弹出且高度自适应
        const left = Math.max(8, Math.min(r.left, window.innerWidth - 268))
        setMenuPos({ left, bottom: window.innerHeight - r.top + 6 })
      }
    }
    setOpen((o) => !o)
  }

  const refreshRecent = async (): Promise<void> => {
    try { setRecent(await workspaceGetRecent()) } catch { /* 读取失败保持旧列表 */ }
  }

  useEffect(() => {
    if (!open) return
    void refreshRecent()
    setMode('list')
    setManage(null)
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if ((ref.current && ref.current.contains(t)) || (menuRef.current && menuRef.current.contains(t))) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // 切换/新建 = 整套数据切换：广播 + 整窗重载（激活重读约定，模块各自重新取数）
  const reloadInto = (name: string) => {
    showToast({ type: 'info', message: `已切换到仓库「${name}」` })
    window.dispatchEvent(new Event('vault:changed'))
    setTimeout(() => location.reload(), 350)
  }

  const switchTo = async (v: WorkspaceRecent) => {
    if (busy || v.rootId === cur?.rootId) { setOpen(false); return }
    setBusy(true)
    try {
      const res = await workspaceOpenById(v.rootId)
      if (res && (res as { error?: string }).error) { showToast({ type: 'error', message: res.error as string }); return }
      reloadInto(v.name)
    } finally { setBusy(false) }
  }

  const openOther = async () => {
    setBusy(true)
    try {
      const opened = await openVaultWithGuide()
      if (opened) reloadInto(opened.name)
    } finally { setOpen(false); setBusy(false) }
  }

  // 在系统文件管理器中打开当前仓库文件夹（成功不打扰，失败才提示）
  const revealVault = async () => {
    setOpen(false)
    try {
      const res = await workspaceRevealVault()
      if (!res.ok) showToast({ type: 'error', message: res.error || '打开文件管理器失败' })
    } catch { /* 桥接异常静默：无仓库时菜单项本就隐藏 */ }
  }

  const submitName = async () => {
    const trimmed = input.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      if (mode === 'create') {
        const res = await workspaceCreateVault(trimmed, '__default__')
        if (!res) return
        if ((res as { error?: string }).error) { showToast({ type: 'error', message: (res as { error: string }).error }); return }
        setOpen(false)
        reloadInto(res.name)
      } else if (mode === 'rename') {
        const res = await workspaceRenameVault(trimmed)
        if (res && res.ok) {
          setCur((c) => (c ? { ...c, name: trimmed } : c))
          window.dispatchEvent(new Event('vault:changed'))
          setOpen(false)
        } else {
          showToast({ type: 'error', message: (res && res.error) || '重命名失败' })
        }
      }
    } finally { setBusy(false) }
  }

  /** 只移除列表记录：磁盘文件夹保留，之后可再「打开本地仓库」加回来 */
  const forgetVault = async (): Promise<void> => {
    const target = manage?.v
    if (!target || busy) return
    setBusy(true)
    try {
      const res = await workspaceForget(target.rootId)
      if (res && res.error) { showToast({ type: 'error', message: res.error }); return }
      showToast({ type: 'info', message: `已从列表移除「${target.name}」（文件夹保留）` })
      setManage(null)
      await refreshRecent()
    } finally { setBusy(false) }
  }

  /** 删除仓库：整个文件夹进系统回收站（可还原） */
  const deleteVault = async (): Promise<void> => {
    const target = manage?.v
    if (!target || busy) return
    setBusy(true)
    try {
      const res = await workspaceDeleteVault(target.rootId)
      if (!res || !res.ok) { showToast({ type: 'error', message: (res && res.error) || '删除失败' }); return }
      if (res.deletedCurrent) {
        setOpen(false)
        showToast({ type: 'info', message: '仓库已移入系统回收站（可还原）。即将返回仓库选择页...' })
        setTimeout(() => location.reload(), 1000)
        return
      }
      showToast({ type: 'info', message: `仓库「${target.name}」已移入系统回收站（可还原）` })
      setManage(null)
      await refreshRecent()
    } finally { setBusy(false) }
  }

  return (
    <div className="relative w-full" ref={ref}>
      <button
        ref={btnRef}
        onClick={toggleMenu}
        title={cur ? `当前仓库：${cur.name}\n${cur.path}` : '打开仓库'}
        className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[12px] transition-colors ${open ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'} text-[var(--text-primary)]`}
      >
        <Layers size={13} className="shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 truncate font-medium text-left">{cur ? cur.name : '未打开仓库'}</span>
        <ChevronDown size={11} className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed w-[260px] max-h-[min(460px,70vh)] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl py-1 z-[130] text-[var(--text-primary)]"
          style={{ left: menuPos.left, bottom: menuPos.bottom }}
        >
          {mode === 'list' && manage && (
            <div className="px-3 py-2 kb-item-in">
              <button onClick={() => setManage(null)} className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
                <ArrowLeft size={12} /> 返回列表
              </button>
              <div className="mt-1.5 text-[12px] font-medium truncate">{manage.v.name}</div>
              <div className="text-[10px] text-[var(--text-muted)] truncate mb-2">{manage.v.path}</div>

              {manage.confirm === 'none' && (
                <>
                  {manage.v.rootId !== cur?.rootId && (
                    <MenuItem
                      icon={<MinusCircle size={13} />}
                      label="从列表移除（保留文件夹）"
                      onClick={() => setManage({ ...manage, confirm: 'forget' })}
                    />
                  )}
                  <MenuItem
                    icon={<Trash2 size={13} />}
                    label="删除仓库文件夹…"
                    danger
                    onClick={() => setManage({ ...manage, confirm: 'trash' })}
                  />
                  {manage.v.rootId === cur?.rootId && (
                    <p className="px-1 pt-1 text-[10px] leading-snug text-[var(--text-muted)]">当前仓库不能只从列表移除，可切换后再移除，或直接删除。</p>
                  )}
                </>
              )}

              {manage.confirm === 'forget' && (
                <div className="kb-item-in">
                  <p className="text-[11px] leading-snug text-[var(--text-secondary)]">只移除列表记录，磁盘上的文件夹不受影响；以后可从「打开其他文件夹」重新加入。</p>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <button onClick={() => setManage({ ...manage, confirm: 'none' })} className="px-2 py-1 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
                    <button onClick={() => void forgetVault()} disabled={busy} className="px-2 py-1 rounded-md text-[11px] text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40">移除</button>
                  </div>
                </div>
              )}

              {manage.confirm === 'trash' && (
                <div className="kb-item-in">
                  <p className="text-[11px] leading-snug text-[var(--danger)]">整个仓库文件夹将移入系统回收站（可还原）。</p>
                  <div className="mt-2 flex justify-end gap-1.5">
                    <button onClick={() => setManage({ ...manage, confirm: 'none' })} className="px-2 py-1 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors">取消</button>
                    <button onClick={() => void deleteVault()} disabled={busy} className="px-2 py-1 rounded-md text-[11px] text-white bg-[var(--danger)] hover:opacity-90 transition-opacity disabled:opacity-40">移入回收站</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {mode === 'list' && !manage && (
            <>
              <div className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">最近仓库</div>
              {recent.length === 0 && <div className="px-3 py-1.5 text-[11.5px] text-[var(--text-secondary)]">暂无记录</div>}
              {recent.map((v) => (
                <div key={v.rootId} className="group flex items-center">
                  <button
                    onClick={() => void switchTo(v)}
                    disabled={busy}
                    className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-[12px] text-left hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 ${v.rootId === cur?.rootId ? 'text-[var(--accent)]' : ''}`}
                  >
                    <span className="w-4 shrink-0">{v.rootId === cur?.rootId && <Check size={13} />}</span>
                    <span className="min-w-0">
                      <span className="block truncate">{v.name}</span>
                      <span className="block truncate text-[10px] text-[var(--text-muted)]">{v.path}</span>
                    </span>
                  </button>
                  <button
                    onClick={() => setManage({ v, confirm: 'none' })}
                    title="管理此仓库"
                    className="mr-1 shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <MoreHorizontal size={13} />
                  </button>
                </div>
              ))}
              <div className="my-1 border-t border-[var(--border-color)]" />
              <MenuItem icon={<FolderOpen size={13} />} label="打开其他文件夹…" onClick={() => void openOther()} />
              {cur && <MenuItem icon={<ExternalLink size={13} />} label="在文件管理器中打开仓库" onClick={() => void revealVault()} />}
              {cur && <MenuItem icon={<Pencil size={13} />} label="重命名当前仓库" onClick={() => { setMode('rename'); setInput(cur.name) }} />}
              <MenuItem icon={<FolderPlus size={13} />} label="新建仓库" onClick={() => { setMode('create'); setInput('') }} />
            </>
          )}

          {(mode === 'create' || mode === 'rename') && (
            <div className="px-3 py-2">
              <div className="text-[11.5px] font-medium mb-1.5">{mode === 'create' ? '新建仓库（创建在文档目录）' : '重命名当前仓库'}</div>
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitName(); if (e.key === 'Escape') setMode('list') }}
                  placeholder="仓库名称"
                  maxLength={60}
                  className="flex-1 min-w-0 px-2 py-1 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] outline-none focus:border-[var(--accent)]"
                />
                <button onClick={() => void submitName()} disabled={busy || !input.trim()} className="px-2 py-1 rounded-md text-[11.5px] bg-[var(--accent)] text-white hover:opacity-90 transition-colors disabled:opacity-40">
                  {mode === 'create' ? '创建' : '保存'}
                </button>
              </div>
              <button onClick={() => setMode('list')} className="mt-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">← 返回</button>
              {mode === 'rename' && <p className="mt-1 text-[10px] text-[var(--text-muted)] leading-snug">只改显示名称，不改磁盘上的文件夹名</p>}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors hover:bg-[var(--bg-hover)] ${danger ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'}`}
    >
      <span className={`w-4 shrink-0 ${danger ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'}`}>{icon}</span>
      {label}
    </button>
  )
}
