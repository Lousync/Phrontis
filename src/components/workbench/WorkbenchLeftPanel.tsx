import { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, CalendarDays, BookOpen, FileText, FileQuestion, Folder, Lock,
  LockOpen, NotebookPen, Library, Trees,
} from 'lucide-react'
import { VaultSwitcher } from '../shared/VaultSwitcher'
import { useSettings } from '../../lib/SettingsContext'
import { workspaceGetCurrent, workspaceListDir } from '../../lib/ipc'
import { LOCATE_QUIZ_VIEW_EVENT, RAIL_FOLLOW_MAP, WORKBENCH_BOOKMARKS, type RailModule } from '../../lib/workbenchLayout'
import type { TabName } from '../../types'

/**
 * 左栏（v3.4.0 批次3，方案 §3.3 / 原型 v15）。
 *
 * 三态互斥（原型 showLp('loose' | 'mod' | 'tree')）：
 * - **tree**：文件树模式（`leftMode==='tree'`，用户显式选择并持久化）——仓库顶层目录（不含 .knowbase）+ 根散文件；
 * - **mod**：模块侧边栏态（`railModule` 非空）——书签对应模块的侧栏经 portal 挂进 slot（挂载点迁移而非复制渲染）；
 * - **overview**：总览态——书签 6 项（内置 + 插件注册）+ 零散文件快速打开。
 *
 * 跟随语义在 App 层（RAIL_FOLLOW_MAP + leftLocked），本组件纯受控展示。
 * 底部仓库切换恒驻（几何约定 vaultBar ⊂ 左栏）。
 */

const BOOKMARK_ICONS: Record<RailModule, (size: number) => React.ReactNode> = {
  editor: (s) => <FileText size={s} />,
  knowledge: (s) => <Library size={s} />,
  schedule: (s) => <CalendarDays size={s} />,
  bookshelf: (s) => <BookOpen size={s} />,
  blog: (s) => <NotebookPen size={s} />,
  quiz: (s) => <FileQuestion size={s} />,
}

/** 插件注册书签的钝解析：只收 tab 型 action，坏条目/坏 JSON 静默丢弃（插件数据不可信外壳） */
interface PluginBookmark {
  id: string
  label: string
  source: string
  action: { type: string; tab?: TabName }
}

function parsePluginBookmarks(raw: string | undefined | null): PluginBookmark[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(String(raw))
    if (!Array.isArray(v)) return []
    return v
      .map((x): PluginBookmark | null => {
        const o = x as Record<string, unknown>
        if (typeof o?.id !== 'string' || typeof o?.label !== 'string') return null
        const act = o?.action as Record<string, unknown> | undefined
        if (!act || act.type !== 'tab' || typeof act.tab !== 'string') return null
        return { id: o.id, label: o.label, source: String(o.source ?? ''), action: { type: 'tab', tab: act.tab as TabName } }
      })
      .filter((x): x is PluginBookmark => x !== null)
  } catch { return [] }
}

interface Props {
  activeTab: TabName
  /** 当前左栏模块态（null = 总览态）；树模式由 leftMode==='tree' 单独表达 */
  railModule: RailModule | null
  locked: boolean
  treeMode: boolean
  /** 模块态 slot 的 ref callback（App 收集 DOM 传给模块 sidebarEl 做 portal 目标） */
  modSlotRef: (node: HTMLDivElement | null) => void
  onBookmarkClick: (key: RailModule) => void
  /** 模块态「← 返回总览」（App 清 railModule，锁定态顺带解锁） */
  onBack: () => void
  onToggleLock: () => void
  onToggleTreeMode: () => void
  /** 总览/树模式的散文件点击 → 编辑区打开该文件 */
  onOpenLooseFile: (relPath: string) => void
  /** 插件书签点击（tab 型 action 直开标签） */
  onPluginBookmark: (tab: TabName) => void
}

export function WorkbenchLeftPanel({ activeTab, railModule, locked, treeMode, modSlotRef, onBookmarkClick, onBack, onToggleLock, onToggleTreeMode, onOpenLooseFile, onPluginBookmark }: Props) {
  const { s } = useSettings()
  const pluginBookmarks = useMemo(() => parsePluginBookmarks(s.workbenchBookmarks), [s.workbenchBookmarks])

  // 仓库根层一次读取：树模式（文件夹+散文件）与总览态散文件区共用
  const [vault, setVault] = useState<{ rootId: string; name: string } | null>(null)
  const [dirs, setDirs] = useState<string[]>([])
  const [loose, setLoose] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cur = await workspaceGetCurrent()
        if (!cur?.rootId || !alive) return
        setVault({ rootId: cur.rootId, name: cur.name })
        const res = await workspaceListDir(cur.rootId, '')
        if (!alive || res.error) return
        const soft = new Set(res.softNames ?? [])
        setDirs((res.entries ?? []).filter((e) => e.type === 'dir' && !soft.has(e.name)).map((e) => e.name))
        setLoose((res.entries ?? []).filter((e) => e.type === 'file' && !soft.has(e.name)).map((e) => e.name))
      } catch { /* 无仓库/未就绪：区留空 */ }
    })()
    return () => { alive = false }
  }, [])

  const modTitle = railModule ? WORKBENCH_BOOKMARKS.find((b) => b.key === railModule)?.label ?? '' : ''
  const itemCls = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors'

  return (
    <div data-wb="leftPanel" className="flex h-full flex-col bg-[var(--bg-secondary)]">
      {/* ---- 树模式：仓库顶层目录（不含 .knowbase）+ 根散文件 ---- */}
      {treeMode ? (
        <>
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2">
            <button onClick={onToggleTreeMode} title="返回总览" className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <ArrowLeft size={13} />
            </button>
            <span className="flex items-center gap-1 text-[12px] font-medium text-[var(--text-secondary)]">
              <Trees size={12} />
              {vault?.name || '仓库文件'}
            </span>
          </div>
          <div data-wb="treeMode" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
            {dirs.map((d) => (
              <div key={d} className={`${itemCls} cursor-default text-[var(--text-secondary)]`}>
                <Folder size={13} className="shrink-0 text-[var(--text-muted)]" />
                {d}
              </div>
            ))}
            {loose.length > 0 && (
              <div className="px-2.5 pb-0.5 pt-2 text-[10.5px] text-[var(--text-muted)]">根目录散文件</div>
            )}
            {loose.map((f) => (
              <button key={f} onClick={() => onOpenLooseFile(f)} className={`${itemCls} text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]`}>
                <FileText size={13} className="shrink-0 text-[var(--text-muted)]" />
                {f}
              </button>
            ))}
            {dirs.length === 0 && loose.length === 0 && (
              <div className="px-2.5 py-6 text-center text-[11.5px] text-[var(--text-muted)]">暂无文件</div>
            )}
          </div>
        </>
      ) : railModule ? (
        /* ---- 模块侧边栏态：书签对应模块的侧栏 portal 进 slot ---- */
        <>
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-[var(--border-color)] px-2">
            <button onClick={onBack} title="返回总览（自动解锁）" className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <ArrowLeft size={13} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text-secondary)]">{modTitle}</span>
            <button
              onClick={onToggleLock}
              title={locked ? '已锁定：主界面切换不改变左栏（点击解锁）' : '锁定侧边栏：主界面切换不改变左栏'}
              className={`rounded p-1 transition-colors ${locked ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
            >
              {locked ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
          </div>
          <div ref={modSlotRef} data-wb="modSlot" className="flex min-h-0 flex-1 flex-col overflow-hidden" />
        </>
      ) : (
        /* ---- 总览态：书签（内置 6 + 插件注册）+ 零散文件快速打开 ---- */
        <>
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-3">
            <span className="text-[12px] font-medium text-[var(--text-secondary)]">工作台</span>
            <button
              onClick={onToggleTreeMode}
              title="切换为文件树模式（仓库顶层目录）"
              className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Trees size={13} />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div data-wb="bookmarks" className="flex flex-col gap-0.5 p-1.5">
              {WORKBENCH_BOOKMARKS.map((b) => {
                const isActive = railModule === b.key || (railModule === null && RAIL_FOLLOW_MAP[activeTab] === b.key && activeTab === b.tab)
                return (
                  <button
                    key={b.key}
                    data-wb-bookmark={b.key}
                    data-wb-active={isActive ? '1' : '0'}
                    onClick={() => onBookmarkClick(b.key)}
                    className={`${itemCls} ${isActive ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
                  >
                    {BOOKMARK_ICONS[b.key](14)}
                    {b.label}
                  </button>
                )
              })}
              {pluginBookmarks.map((p) => (
                <button
                  key={`plugin:${p.id}`}
                  data-wb-bookmark={`plugin:${p.id}`}
                  onClick={() => onPluginBookmark(p.action.tab as TabName)}
                  className={`${itemCls} text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]`}
                >
                  <FileText size={14} />
                  {p.label}
                </button>
              ))}
            </div>
            {loose.length > 0 && (
              <div className="flex flex-col gap-0.5 border-t border-[var(--border-color)] p-1.5">
                <div className="px-2.5 pb-0.5 pt-1 text-[10.5px] text-[var(--text-muted)]">零散文件</div>
                {loose.map((f) => (
                  <button key={f} onClick={() => onOpenLooseFile(f)} className={`${itemCls} text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]`}>
                    <FileText size={13} className="shrink-0 text-[var(--text-muted)]" />
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ---- 底部：仓库切换恒驻（vaultBar ⊂ 左栏） ---- */}
      <div data-wb="vaultBar" className="shrink-0 border-t border-[var(--border-color)] p-1.5">
        <VaultSwitcher />
      </div>
    </div>
  )
}

/** quiz 书签点击时 App 派发的定位事件见 workbenchLayout.ts 的 LOCATE_QUIZ_VIEW_EVENT */
