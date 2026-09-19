import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bookmark, CalendarDays, BookOpen, Check, FileText, FileQuestion, Folder, House, Lock,
  LockOpen, NotebookPen, Library, Trees, Bot, Search,
} from 'lucide-react'
import { VaultSwitcher } from '../shared/VaultSwitcher'
import { useSettings } from '../../lib/SettingsContext'
import { workspaceGetCurrent, workspaceListDir } from '../../lib/ipc'
import { WorkbenchSearchPanel } from './WorkbenchSearchPanel'
import { BOOKMARK_COLORS, LOCATE_QUIZ_VIEW_EVENT, RAIL_FOLLOW_MAP, WORKBENCH_BOOKMARKS, type RailModule } from '../../lib/workbenchLayout'
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
  knowledge: (s) => <Library size={s} />,
  schedule: (s) => <CalendarDays size={s} />,
  bookshelf: (s) => <BookOpen size={s} />,
  blog: (s) => <NotebookPen size={s} />,
  quiz: (s) => <FileQuestion size={s} />,
  // aiChat 不是书签，此条目仅满足 Record 全量约束，不被书签区渲染消费
  aiChat: (s) => <Bot size={s} />,
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
  /** 当前激活模块；null = 全部标签已关闭的空态（书签高亮只看 railModule） */
  activeTab: TabName | null
  /** 当前左栏模块态（null = 总览态）；树模式由 leftMode==='tree' 单独表达 */
  railModule: RailModule | null
  /** 工具侧栏态（2026-09-17 右栏优化轮）：激活工具属于 TOOLS_WITH_SIDEBAR 时的 toolId。
      与 railModule 互斥共用模块态 slot（瞬态跟随，不进书签/持久化体系）；仅影响模块态判定与 data-wb-mod */
  railTool?: string | null
  locked: boolean
  treeMode: boolean
  /** 模块态 slot 的 ref callback（App 收集 DOM 传给模块 sidebarEl 做 portal 目标） */
  modSlotRef: (node: HTMLDivElement | null) => void
  onBookmarkClick: (key: RailModule) => void
  /** 🔖 书签选显菜单：切换某书签显隐（内置 key 或 plugin:<id>），App 持久化并处理「隐藏当前激活书签 → 退出模块态」 */
  onBookmarkVisibility: (key: string) => void
  /** 隐藏中的书签（内置 RailModule key / plugin:<id>），书签区与 🔖 菜单据此过滤 */
  bookmarksHidden: string[]
  /** 模块态「← 返回总览」（App 清 railModule，锁定态顺带解锁） */
  onBack: () => void
  onToggleLock: () => void
  onToggleTreeMode: () => void
  /** 总览/树模式的散文件点击 → 编辑区打开该文件 */
  onOpenLooseFile: (relPath: string) => void
  /** 插件书签点击（tab 型 action 直开标签） */
  onPluginBookmark: (tab: TabName) => void
  /** 搜索态（v3.4.0 反馈轮：顶栏搜索框删除，全局搜索搬进左栏；瞬态不持久化） */
  searchMode?: boolean
  /** 总览态头部 🔍 进入搜索态 */
  onEnterSearch?: () => void
  /** 搜索态 🏠 返回顶层 */
  onExitSearch?: () => void
  /** 搜索结果动作（App 层处理器：页面打开 / 目录定位 / 命令） */
  onSearchOpenPage?: (pageId: string) => void
  onSearchLocateCategory?: (categoryId: string) => void
  onSearchRunCommand?: (commandId: string) => void
}

export function WorkbenchLeftPanel({ activeTab, railModule, railTool = null, locked, treeMode, modSlotRef, onBookmarkClick, onBookmarkVisibility, bookmarksHidden, onBack, onToggleLock, onToggleTreeMode, onOpenLooseFile, onPluginBookmark, searchMode = false, onEnterSearch, onExitSearch, onSearchOpenPage, onSearchLocateCategory, onSearchRunCommand }: Props) {
  const { s } = useSettings()
  const pluginBookmarks = useMemo(() => parsePluginBookmarks(s.workbenchBookmarks), [s.workbenchBookmarks])
  // 🔖 书签选显菜单开关（v10 拍板：逐个勾选显示哪些书签 + 插件可注册书签）。
  // 浮层走 portal + fixed + document pointerdown 外部关闭（照 VaultSwitcher 模式——
  // 头部行内嵌 backdrop 兄弟结构下 React 对菜单项的 click 分发实测不稳定，不重蹈）。
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false)
  const [bmMenuPos, setBmMenuPos] = useState<{ left: number; top: number } | null>(null)
  const bmBtnRef = useRef<HTMLButtonElement | null>(null)
  const bmMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!bookmarkMenuOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if ((bmBtnRef.current && bmBtnRef.current.contains(t)) || (bmMenuRef.current && bmMenuRef.current.contains(t))) return
      setBookmarkMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBookmarkMenuOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [bookmarkMenuOpen])

  // 菜单项点击用 **原生事件委托**（menu 容器上 addEventListener），不依赖 React 合成事件——
  // 实测（2026-09-17）：portal 到 body 的首个菜单在本会话内对 React 合成 click 分发不稳定
  // （事件到达委托节点但 handler 不触发，无报错；同结构先挂过另一 portal 后则正常）。
  // 原生委托对所有派发方式免疫；项目内 menu-item 不依赖受控 input，无需合成事件的额外能力。
  useEffect(() => {
    if (!bookmarkMenuOpen) return
    const menu = bmMenuRef.current
    if (!menu) return
    const onClick = (e: MouseEvent) => {
      const t = (e.target as HTMLElement | null)?.closest?.('[data-wb-menu-item]') as HTMLElement | null
      if (t?.dataset.wbMenuItem) onBookmarkVisibility(t.dataset.wbMenuItem)
    }
    menu.addEventListener('click', onClick)
    return () => menu.removeEventListener('click', onClick)
  }, [bookmarkMenuOpen, onBookmarkVisibility])

  const toggleBookmarkMenu = () => {
    if (!bookmarkMenuOpen) {
      const r = bmBtnRef.current?.getBoundingClientRect()
      if (r) setBmMenuPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 190)), top: r.bottom + 6 })
    }
    setBookmarkMenuOpen(v => !v)
  }

  // 仓库根层一次读取：树模式（文件夹+散文件）与总览态散文件区共用
  const [dirs, setDirs] = useState<string[]>([])
  const [loose, setLoose] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cur = await workspaceGetCurrent()
        if (!cur?.rootId || !alive) return
        const res = await workspaceListDir(cur.rootId, '')
        if (!alive || res.error) return
        const soft = new Set(res.softNames ?? [])
        setDirs((res.entries ?? []).filter((e) => e.type === 'dir' && !soft.has(e.name)).map((e) => e.name))
        setLoose((res.entries ?? []).filter((e) => e.type === 'file' && !soft.has(e.name)).map((e) => e.name))
      } catch { /* 无仓库/未就绪：区留空 */ }
    })()
    return () => { alive = false }
  }, [])

  const itemCls = 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors'

  return (
    <div data-wb="leftPanel" className="flex h-full flex-col bg-[var(--bg-secondary)]">
      {/* ---- 树模式：仓库顶层目录（不含 .knowbase）+ 根散文件 ----
           2026-09-16 第二轮 UI 反馈：头部只留 ‹ 返回钮（文字装饰与横线删除） */}
      {/* ---- 搜索态（反馈轮新增第四态，优先级最高）：🏠 返回 + 🔒 锁定 + 搜索框 + 结果 ---- */}
      {searchMode ? (
        onSearchOpenPage && onSearchLocateCategory && onSearchRunCommand && onExitSearch ? (
          <WorkbenchSearchPanel
            onOpenPage={onSearchOpenPage}
            onLocateCategory={onSearchLocateCategory}
            onRunCommand={onSearchRunCommand}
            onExit={onExitSearch}
            locked={locked}
            onToggleLock={onToggleLock}
          />
        ) : null
      ) : treeMode ? (
        <>
          <div className="flex h-8 shrink-0 items-center justify-center px-1.5">
            <button onClick={onToggleTreeMode} title="返回总览" className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <House size={13} />
            </button>
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
      ) : railModule || railTool ? (
        /* ---- 模块侧边栏态：书签对应模块（或工具侧栏，data-wb-mod=toolId）portal 进 slot ----
             2026-09-16 第二轮 UI 反馈：头部只留 ‹ 返回 + 锁定（文字描述与横线删除）；
             data-wb-mod 记录当前模块 key（工具侧栏态 = tool id），供探针/脚本断言（不渲染可见文字） */
        <>
          <div data-wb="mod" data-wb-mod={railModule ?? railTool ?? ''} className="flex h-8 shrink-0 items-center justify-center gap-1 px-1.5">
            {/* 返回顶层统一 🏠（2026-09-17 反馈轮：‹ 换 House，钮组与搜索态头部同一居中语言） */}
            <button onClick={onBack} title="返回总览（自动解锁）" className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <House size={13} />
            </button>
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
          <div className="relative flex h-8 shrink-0 items-center justify-center gap-1 px-1.5">
            {/* 头部三钮居中（2026-09-17 反馈轮拍板，仿 Obsidian 侧栏头）：🔖 书签选显 / 🔍 搜索 / 🌳 树模式 */}
            <button
              ref={bmBtnRef}
              onClick={toggleBookmarkMenu}
              title="书签显示管理"
              data-wb="bookmarkMenuBtn"
              className={`rounded p-1 transition-colors ${bookmarkMenuOpen ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
            >
              <Bookmark size={13} />
            </button>
            <button
              onClick={onEnterSearch}
              title="全局搜索（Ctrl+P）"
              data-wb="leftSearchBtn"
              className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Search size={13} />
            </button>
            <button
              onClick={onToggleTreeMode}
              title="切换为文件树模式（仓库顶层目录）"
              className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              <Trees size={13} />
            </button>
            {bookmarkMenuOpen && bmMenuPos && createPortal(
              <div
                ref={bmMenuRef}
                data-wb="bookmarkMenu"
                className="fixed w-44 max-h-[min(420px,70vh)] overflow-y-auto rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] p-1 shadow-xl z-[130]"
                style={{ left: bmMenuPos.left, top: bmMenuPos.top }}
              >
                <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-[var(--text-muted)]">显示的书签</div>
                {WORKBENCH_BOOKMARKS.map((b) => {
                  const shown = !bookmarksHidden.includes(b.key)
                  return (
                    <button
                      key={b.key}
                      data-wb-menu-item={b.key}
                      /* 点击走 menu 容器的原生事件委托（见上方 useEffect），不挂 React onClick */
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${shown ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border-color)]'}`}>
                        {shown && <Check size={10} />}
                      </span>
                      <span style={{ color: BOOKMARK_COLORS[b.key].fg }}>{b.label}</span>
                    </button>
                  )
                })}
                {pluginBookmarks.length > 0 && (
                  <div className="mt-1 border-t border-[var(--border-color)] pt-1">
                    {pluginBookmarks.map((p) => {
                      const pid = `plugin:${p.id}`
                      const shown = !bookmarksHidden.includes(pid)
                      return (
                        <button
                          key={pid}
                          data-wb-menu-item={pid}
                          /* 同上：原生事件委托 */
                          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)]"
                        >
                          <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${shown ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--border-color)]'}`}>
                            {shown && <Check size={10} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{p.label}</span>
                          <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">插件</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>,
              document.body,
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div data-wb="bookmarks" className="flex flex-col gap-0.5 p-1.5">
              {WORKBENCH_BOOKMARKS.filter((b) => !bookmarksHidden.includes(b.key)).map((b) => {
                const isActive = railModule === b.key || (railModule === null && !!activeTab && RAIL_FOLLOW_MAP[activeTab] === b.key && activeTab === b.tab)
                const c = BOOKMARK_COLORS[b.key]
                return (
                  <button
                    key={b.key}
                    data-wb-bookmark={b.key}
                    data-wb-active={isActive ? '1' : '0'}
                    onClick={() => onBookmarkClick(b.key)}
                    className={`${itemCls} ${isActive ? 'bg-[var(--bg-hover)] font-medium' : 'hover:bg-[var(--bg-hover)]'}`}
                  >
                    {/* 图标底块 + 同色文字（原型 v15 c-* 配色） */}
                    <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md" style={{ background: c.bg, color: c.fg }}>
                      {BOOKMARK_ICONS[b.key](13)}
                    </span>
                    <span style={{ color: c.fg }}>{b.label}</span>
                  </button>
                )
              })}
              {pluginBookmarks.filter((p) => !bookmarksHidden.includes(`plugin:${p.id}`)).map((p) => (
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
          {/* 仓库切换只在总览态（顶层）显示——2026-09-17 第四轮反馈拍板④；模块态/树模式不混入 */}
          <div data-wb="vaultBar" className="shrink-0 border-t border-[var(--border-color)] p-1.5">
            <VaultSwitcher />
          </div>
        </>
      )}
    </div>
  )
}

/** quiz 书签点击时 App 派发的定位事件见 workbenchLayout.ts 的 LOCATE_QUIZ_VIEW_EVENT */
