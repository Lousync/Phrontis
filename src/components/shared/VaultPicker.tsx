import { useEffect, useState } from 'react'
import { ArrowLeft, CornerDownLeft, FolderOpen, Plus } from 'lucide-react'
import { getAppVersion, openDirDialog, workspaceCreateVault, workspaceGetCurrent, workspaceGetRecent, workspaceOpenById } from '../../lib/ipc'
import { openVaultWithGuide } from '../../lib/vaultOpen'
import { showToast } from '../../lib/toast'
import appIcon from '../../assets/app-icon.png'
import type { WorkspaceRecent } from '../../types'

type VaultResult = { rootId: string; name: string; path: string; error?: string } | null

/** updatedAt（sqlite localtime 字符串 / ISO）→ 人话相对时间 */
function relTime(iso: string): string {
  try {
    const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'))
    const ms = Date.now() - d.getTime()
    if (Number.isNaN(ms)) return ''
    const days = Math.floor(ms / 86_400_000)
    if (days <= 0) return '今天'
    if (days === 1) return '昨天'
    if (days < 30) return `${days} 天前`
    return d.toLocaleDateString()
  } catch {
    return ''
  }
}

/**
 * 仓库选择页（Obsidian 式）：双形态复用。
 * - 首启形态（默认）：新手引导前置步骤——已有仓库列表快速进入 / 快速开始 / 新建仓库 / 打开本地文件夹。
 * - 启动形态（startup=true，设置 startupVaultPicker）：每次进入应用先选仓库——
 *   已有仓库列表为主入口（点行即进，切换则整窗重载），新建/打开放底部；底部「直接进入」可跳过。
 * 完成后广播 vault:changed——编辑器挂载早于本流程，需据此自动挂载新仓库。
 */
export function VaultPicker({ onDone, startup = false }: { onDone: (created?: boolean) => void; startup?: boolean }) {
  const [mode, setMode] = useState<'home' | 'create'>('home')
  const [version, setVersion] = useState('')
  const [name, setName] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [recent, setRecent] = useState<WorkspaceRecent[]>([])
  const [curId, setCurId] = useState<string | null>(null)

  useEffect(() => { void getAppVersion().then(setVersion).catch(() => {}) }, [])

  // 仓库登记本就跨重启持久化：两种形态都列出已有仓库作为快速进入入口
  useEffect(() => {
    let alive = true
    void workspaceGetRecent().then((r) => { if (alive) setRecent(r) }).catch(() => {})
    if (startup) void workspaceGetCurrent().then((c) => { if (alive) setCurId(c?.rootId ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [startup])

  // 选定仓库后的收尾：启动形态可能切换了库，统一广播 + 整窗重载（数据激活重读约定）；
  // 首启形态保持原行为（广播 + 回调进入引导，不重载）。
  // created = 本流程新建/初始化了仓库（快速开始 / 新建 / 打开目录确认初始化）→
  // 首启完成后默认落在编辑区（2026-09-08 拍板）；进入已有仓库不带该标记
  const finish = (created = false) => {
    window.dispatchEvent(new Event('vault:changed'))
    if (startup) setTimeout(() => location.reload(), 350)
    else onDone(created)
  }

  const apply = (res: VaultResult, created = false): boolean => {
    if (!res) return false // 用户取消对话框
    if (res.error) { showToast({ type: 'error', message: res.error }); return false }
    finish(created)
    return true
  }

  const enterVault = async (v: WorkspaceRecent): Promise<void> => {
    if (busy) return
    if (v.rootId === curId) { onDone(); return } // 点的就是本次默认仓库：免切换直接进
    setBusy(true)
    try {
      const res = await workspaceOpenById(v.rootId)
      if (!res || (res as { error?: string }).error) { showToast({ type: 'error', message: (res as { error?: string })?.error || '打开仓库失败' }); return }
      if (startup) showToast({ type: 'info', message: `已进入仓库「${v.name}」` })
      finish()
    } finally { setBusy(false) }
  }

  const quickStart = async (): Promise<void> => {
    setBusy(true)
    try { apply(await workspaceCreateVault('我的仓库', '__default__'), true) } finally { setBusy(false) }
  }

  const openExisting = async (): Promise<void> => {
    setBusy(true)
    try {
      // D7：非仓库目录在 openVaultWithGuide 内弹「初始化为仓库？」确认，取消则不建
      const opened = await openVaultWithGuide()
      if (opened) finish(true)
    } finally { setBusy(false) }
  }

  const browse = async (): Promise<void> => {
    const dir = await openDirDialog()
    if (dir) setParentPath(dir)
  }

  const doCreate = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) { showToast({ type: 'warning', message: '请先给仓库起一个名字' }); return }
    setBusy(true)
    try { apply(await workspaceCreateVault(trimmed, parentPath ?? '__default__'), true) } finally { setBusy(false) }
  }

  const hasRecent = recent.length > 0

  return (
    <div className="fixed inset-0 z-[95] bg-[var(--bg-primary)] flex items-center justify-center select-none">
      <div className="w-full max-w-[620px] mx-6 kb-picker-shell">
        {/* 品牌区（Obsidian 式：图标 + 名称 + 版本）—— 不参与滚动，滚动只发生在其下的中段 */}
        <div className="text-center mb-9 shrink-0">
          <img
            src={appIcon}
            alt="Phrontis"
            draggable={false}
            className="w-16 h-16 rounded-2xl mx-auto mb-4 shadow-sm"
          />
          <h1 className="text-[24px] font-semibold text-[var(--text-primary)]">Phrontis</h1>
          {version && <p className="text-[12px] text-[var(--text-muted)] mt-1">版本 {version}</p>}
        </div>

        {mode === 'home' ? (
          <div className="vault-picker-step">
            <div className="kb-picker-scroll text-center">
              {startup && (
                <h2 className="text-[15px] font-semibold text-[var(--text-primary)] mb-4">选择要进入的仓库</h2>
              )}
              {/* 快速开始仅在没有任何已有仓库时出现（首次使用的主路径） */}
              {!startup && !hasRecent && (
                <button
                  onClick={() => void quickStart()}
                  disabled={busy}
                  className="w-full py-2.5 text-[13px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors mb-7 disabled:opacity-60"
                >
                  快速开始
                </button>
              )}
              {startup && !hasRecent && (
                <p className="text-[12px] text-[var(--text-muted)] mb-4">还没有登记过仓库——用下面的方式创建一个。</p>
              )}
              {hasRecent && (
                <>
                  <div className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5 px-1">
                    {startup ? '已有仓库' : '快速进入'}
                  </div>
                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] divide-y divide-[var(--border-color)] mb-7 overflow-hidden">
                    {recent.map((v, i) => (
                      <button
                        key={v.rootId}
                        autoFocus={startup && i === 0}
                        onClick={() => void enterVault(v)}
                        disabled={busy}
                        title={v.path}
                        className={`w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50 ${startup && i === 0 ? 'bg-[var(--accent)]/5' : ''}`}
                      >
                        <span className={`w-4 shrink-0 text-[var(--accent)] ${startup && i === 0 ? '' : 'opacity-50'}`}>
                          <CornerDownLeft size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-[var(--text-primary)] truncate">
                            {v.name}
                            {v.rootId === curId && (
                              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-normal text-[var(--accent)] bg-[var(--accent)]/10 align-middle">上次使用</span>
                            )}
                          </span>
                          <span className="block text-[11px] text-[var(--text-muted)] truncate mt-0.5">{v.path}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{relTime(v.updatedAt)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 divide-y divide-[var(--border-color)]">
                <VaultRow
                  icon={<Plus size={15} />}
                  title="新建仓库"
                  desc="在指定文件夹下创建一个新的仓库。"
                  actionLabel="创建"
                  onAction={() => setMode('create')}
                />
                <VaultRow
                  icon={<FolderOpen size={15} />}
                  title="打开本地仓库"
                  desc="将一个本地文件夹作为仓库在 Phrontis 中打开。"
                  actionLabel="打开"
                  secondary
                  onAction={() => void openExisting()}
                />
              </div>
            </div>
            {/* 底部链接固定在滚动区之外：中段滚到底也不会把它推走 */}
            <div className="text-center mt-7 shrink-0">
              {startup ? (
                <button
                  onClick={() => onDone()}
                  className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  跳过，直接进入上次使用的仓库
                </button>
              ) : (
                <button
                  onClick={() => onDone()}
                  className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  暂不设置，稍后在编辑区打开仓库
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="vault-picker-step kb-picker-scroll">
            <button
              onClick={() => setMode('home')}
              className="flex items-center gap-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-1"
            >
              <ArrowLeft size={13} />返回
            </button>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)] mb-5">创建本地仓库</h2>
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] px-5 divide-y divide-[var(--border-color)]">
              <div className="flex items-center justify-between gap-4 py-4">
                <div>
                  <div className="text-[13px] font-medium text-[var(--text-primary)]">仓库名称</div>
                  <div className="text-[11.5px] text-[var(--text-muted)] mt-0.5">给新仓库起一个名字</div>
                </div>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void doCreate() }}
                  placeholder="仓库名称"
                  maxLength={60}
                  className="w-[220px] px-2.5 py-1.5 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[var(--text-primary)]">仓库位置</div>
                  <div className="text-[11.5px] text-[var(--text-muted)] mt-0.5 truncate" title={parentPath ?? undefined}>
                    {parentPath ?? '默认（文档目录）'}
                  </div>
                </div>
                <button
                  onClick={() => void browse()}
                  className="shrink-0 px-4 py-1.5 text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
                >
                  浏览
                </button>
              </div>
            </div>
            <div className="text-center mt-7">
              <button
                onClick={() => void doCreate()}
                disabled={busy || !name.trim()}
                className="px-7 py-2 text-[13px] font-medium text-white bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
              >
                创建
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function VaultRow({ icon, title, desc, actionLabel, onAction, secondary = false }: {
  icon: React.ReactNode
  title: string
  desc: string
  actionLabel: string
  onAction: () => void
  secondary?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="flex items-start gap-3 min-w-0">
        <span className="shrink-0 mt-0.5 text-[var(--accent)]">{icon}</span>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
          <div className="text-[11.5px] text-[var(--text-muted)] mt-0.5">{desc}</div>
        </div>
      </div>
      <button
        onClick={onAction}
        className={`shrink-0 px-5 py-1.5 text-[12px] font-medium rounded-md transition-colors ${
          secondary
            ? 'text-[var(--text-secondary)] border border-[var(--border-color)] hover:bg-[var(--bg-hover)]'
            : 'text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)]'
        }`}
      >
        {actionLabel}
      </button>
    </div>
  )
}
