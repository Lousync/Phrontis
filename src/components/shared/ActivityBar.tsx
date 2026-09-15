import { useState, useRef, useEffect, useMemo } from 'react'
import type { TabName } from '../../types'
import { Palette, ChevronRight, ChevronDown, Check, Download, FlaskConical, History, LifeBuoy, Trash2, LayoutGrid } from 'lucide-react'
import { useSettings } from '../../lib/SettingsContext'
import { applyThemeClass } from '../../lib/settings'
import { BAR_MODULE_IDS, labelOf, normalizeModuleId } from '../../lib/appModules'
import { useContextMenuPosition } from '../../lib/useContextMenuPosition'
import { BlogIcon, ScheduleIcon, KnowledgeIcon, MomentsIcon, ToolboxIcon, UserIcon, SettingsIcon, PluginIcon, EditorIcon, AiTeachingIcon } from './ModuleIcons'

/**
 * 活动栏图标位的**图标表**（成员与顺序不在图标表里）。
 * 哪些模块能进活动栏、能不能被隐藏，一律查 `lib/appModules` 的唯一真相源 ——
 * 这里只负责「这个 id 画成什么」。用户/设置/帮助不占图标位（在底部的设置菜单里）。
 */
const BAR_ICONS: Record<string, (size: number) => React.ReactNode> = {
  desktop: s => <LayoutGrid size={s} />,
  editor: s => <EditorIcon size={s} />,
  blog: s => <BlogIcon size={s} />,
  schedule: s => <ScheduleIcon size={s} />,
  knowledge: s => <KnowledgeIcon size={s} />,
  moments: s => <MomentsIcon size={s} />,
  aiTeaching: s => <AiTeachingIcon size={s} />,
  toolbox: s => <ToolboxIcon size={s} />,
  plugins: s => <PluginIcon size={s} />,
}

/** 可拖拽 / 可隐藏的模块（id 与名称来自唯一真相源，顺序由 settings 的 activityBarOrder 决定） */
const ALL_MODULES: { id: TabName; label: string; icon: (size: number) => React.ReactNode }[] =
  BAR_MODULE_IDS.map((id) => ({ id, label: labelOf(id), icon: BAR_ICONS[id] }))

const THEME_CHOICES = [
  { id: 'dark',  label: '深色主题' },
  { id: 'light', label: '浅色主题' },
]

function safeParse(json: string, fallback: string[]): string[] {
  try { const v = JSON.parse(json); if (Array.isArray(v)) return v } catch {}
  return fallback
}

interface Props {
  active: TabName
  onChange: (tab: TabName) => void
  onToggleSidebar?: () => void
  /** UI 优化条目1：最大化时活动栏卡去留白/圆角/边框阴影，贴满屏幕边缘 */
  flush?: boolean
}

export function ActivityBar({ active, onChange, onToggleSidebar, flush }: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [themeExpanded, setThemeExpanded] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const { menuRef: ctxMenuRef, style: ctxMenuStyle } = useContextMenuPosition(ctxMenu)
  const [dragId, setDragId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const { s, update } = useSettings()

  // UI 打磨点4（修订）：editor 默认居首改为**一次性迁移**——旧实现在 useMemo 里每次渲染都强制归一，
  // 用户拖拽 editor 写回的新顺序下一帧即被拉回首位（拖拽永远无效，等于焊死第一位）。
  // 旧版本下 editor 拖拽从未生效过（同一段归一代码），故「跑一次归一 + 标记」安全：
  // 标记落位后 allOrder 完全尊重 settings 存储，拖拽写回即所见即所得；缺失模块仍由下方 append 兜底。
  // AI教学 P0：activityBarOrder 内 immersive → aiTeaching（模块 id 改名，位置原地替换不丢失）。
  // ⚠️ 这里**刻意不**换成 appModules.activityOrder()：那个函数会额外补 desktop、追加缺失模块，
  // 而 allOrder 会被原样写回 settings —— 换掉就等于给每个老用户的活动栏顺序做一次静默改写。
  // 真正的成员/顺序口径由下方 `order`（基于唯一真相源）承担，这里只管存量数据归一。
  const allOrder = useMemo(
    () => safeParse(String(s.activityBarOrder ?? ''), BAR_MODULE_IDS).map(normalizeModuleId),
    [s.activityBarOrder],
  )
  useEffect(() => {
    const raw = String(s.activityBarOrder ?? '')
    const migratedKey = 'kb.activitybar.editorDefaultMigrated'
    if (localStorage.getItem(migratedKey) === '1') {
      // 已迁移：仅在归一映射（immersive 改名等）产生差异时写回，不干预用户排序
      if (raw !== JSON.stringify(allOrder)) update('activityBarOrder', JSON.stringify(allOrder))
      return
    }
    localStorage.setItem(migratedKey, '1')
    const idx = allOrder.indexOf('editor')
    const next = idx === 0 ? allOrder : idx > 0 ? ['editor', ...allOrder.filter((x) => x !== 'editor')] : ['editor', ...allOrder]
    update('activityBarOrder', JSON.stringify(next))
  }, [allOrder]) // eslint-disable-line react-hooks/exhaustive-deps
  // AI教学 P0：activityBarHidden 同步一次性迁移 immersive → aiTeaching（隐藏的旧 Agent 迁移后仍隐藏）
  const hidden: string[] = useMemo(
    () => safeParse(s.activityBarHidden, []).map(normalizeModuleId),
    [s.activityBarHidden],
  )
  useEffect(() => {
    const raw = String(s.activityBarHidden ?? '')
    if (raw && raw !== JSON.stringify(hidden)) update('activityBarHidden', JSON.stringify(hidden))
  }, [hidden]) // eslint-disable-line react-hooks/exhaustive-deps

  // Compute ordered visible modules
  const order = allOrder.filter(id => ALL_MODULES.some(m => m.id === id))
  // 新模块（还没进过 activityBarOrder）默认插队首 = 入口位。
  // 一旦用户拖拽过一次、desktop 进了存储，这里就不再插手，完全尊重用户排序。
  if (!order.includes('desktop')) order.unshift('desktop')
  // Append any new modules not yet in the order
  for (const m of ALL_MODULES) {
    if (!order.includes(m.id)) order.push(m.id)
  }
  const visible = order.filter(id => !hidden.includes(id) && ALL_MODULES.some(m => m.id === id))

  // Dismiss menus on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  // Dismiss context menu (Escape only — backdrop onClick handles outside clicks)
  useEffect(() => {
    if (!ctxMenu) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('keydown', onEsc) }
  }, [ctxMenu])

  const handleChooseTheme = (id: string) => {
    update('theme', id)
    applyThemeClass(id)
  }

  const toggleHidden = (id: string) => {
    const next = hidden.includes(id) ? hidden.filter(h => h !== id) : [...hidden, id]
    update('activityBarHidden', JSON.stringify(next))
  }

  // ----- drag reorder (HTML5) -----
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLElement | null)?.style?.setProperty('opacity', '0.4')
    })
  }

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement | null)?.style?.setProperty('opacity', '1')
    setDragId(null)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const srcId = e.dataTransfer.getData('text/plain')
    if (!srcId || srcId === targetId) return

    const newOrder = [...order]
    const srcIdx = newOrder.indexOf(srcId)
    const dstIdx = newOrder.indexOf(targetId)
    if (srcIdx === -1 || dstIdx === -1) return

    newOrder.splice(srcIdx, 1)
    newOrder.splice(dstIdx, 0, srcId)
    update('activityBarOrder', JSON.stringify(newOrder))
  }

  return (
    <div ref={barRef}
      className={`w-14 flex flex-col items-center py-2 gap-1 shrink-0 select-none transition-all duration-300 ease-out bg-[color-mix(in_srgb,var(--activitybar-bg)_85%,transparent)] ${flush ? 'rounded-none' : 'mx-1.5 my-1.5 rounded-xl border border-[var(--border-color)] shadow-[inset_0_1px_0_var(--glass-edge),0_6px_24px_rgba(0,0,0,0.16)]'}`}
      onContextMenu={e => {
        e.preventDefault()
        setCtxMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* Module tabs — draggable */}
      {visible.map(tabId => {
        const mod = ALL_MODULES.find(m => m.id === tabId)!
        const isActive = active === tabId
        return (
          <button
            key={tabId}
            draggable
            onDragStart={e => handleDragStart(e, tabId)}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={e => handleDrop(e, tabId)}
            onClick={() => {
              if (isActive && onToggleSidebar) onToggleSidebar()
              else onChange(tabId as TabName)
            }}
            title={`${mod.label}${dragId && dragId !== tabId ? ' — 拖放到此处排序' : ''}`}
            className={`
              w-14 h-14 flex items-center justify-center relative rounded-2xl transition-all duration-150
              ${isActive
                ? 'text-[var(--accent)] bg-[var(--bg-hover)]/80 shadow-[inset_0_0_0_1px_var(--border-color)]'
                : dragId === tabId
                  ? 'text-[var(--accent)]/50'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'}
            `}
          >
            {isActive && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-9 bg-[var(--accent)] rounded-r-full" />
            )}
            {mod.icon(26)}
          </button>
        )
      })}

      {/* User button */}
      <div className="mt-auto">
        {/* 开发者工具 — 仅 DEV 渲染,打包构建时该分支被静态消除 */}
        {import.meta.env.DEV && (
          <button
            onClick={() => onChange('devtools')}
            className={`w-14 h-14 flex items-center justify-center relative rounded-2xl transition-all duration-150 ${
              active === 'devtools'
                ? 'text-[var(--accent)] bg-[var(--bg-hover)]/80 shadow-[inset_0_0_0_1px_var(--border-color)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'
            }`}
            title="开发者工具 (DEV)"
          >
            {active === 'devtools' && (
              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-9 bg-[var(--accent)] rounded-r-full" />
            )}
            <FlaskConical size={26} />
          </button>
        )}
        <button
          onClick={() => onChange('user')}
          className={`w-14 h-14 flex items-center justify-center relative rounded-2xl transition-all duration-150 ${
            active === 'user'
              ? 'text-[var(--accent)] bg-[var(--bg-hover)]/80 shadow-[inset_0_0_0_1px_var(--border-color)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'
          }`}
          title="用户"
        >
          {active === 'user' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-9 bg-[var(--accent)] rounded-r-full" />
          )}
          <UserIcon size={26} />
        </button>
      </div>

      {/* Settings button + popup menu */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => { setMenuOpen(v => !v); setThemeExpanded(false) }}
          className={`w-14 h-14 flex items-center justify-center relative rounded-2xl transition-all duration-150 ${
            active === 'settings' || menuOpen
              ? 'text-[var(--accent)] bg-[var(--bg-hover)]/80 shadow-[inset_0_0_0_1px_var(--border-color)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'
          }`}
          title="设置与主题"
        >
          <SettingsIcon size={26} />
        </button>

        {menuOpen && (
          <div className="absolute left-full bottom-0 ml-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl z-50 w-44 py-1">
            {/* 主题 */}
            <button
              onClick={() => setThemeExpanded(v => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <span className="flex items-center gap-2">
                <Palette size={15} className="text-[var(--text-muted)]" />
                主题
              </span>
              {themeExpanded ? <ChevronDown size={13} className="text-[var(--text-muted)]" /> : <ChevronRight size={13} className="text-[var(--text-muted)]" />}
            </button>

            {themeExpanded && (
              <div className="border-t border-[var(--bg-tertiary)]">
                {THEME_CHOICES.map(tc => (
                  <button key={tc.id} onClick={() => handleChooseTheme(tc.id)}
                    className="w-full flex items-center gap-2 px-5 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors">
                    <span className="w-4 flex items-center justify-center shrink-0">
                      {s.theme === tc.id && <Check size={12} className="text-[var(--accent)]" />}
                    </span>
                    {tc.label}
                  </button>
                ))}
              </div>
            )}

            <div className="border-t border-[var(--border-color)] my-0.5" />

            <button onClick={() => { onChange('settings'); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <SettingsIcon size={15} className="text-[var(--text-muted)]" />
              设置
            </button>

            <div className="border-t border-[var(--border-color)] my-0.5" />

            {/* 帮助 — 独立整页模块(仅文档侧栏,不嵌设置) */}
            <button onClick={() => { onChange('help'); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <LifeBuoy size={15} className="text-[var(--text-muted)]" />
              帮助
            </button>

            <div className="border-t border-[var(--border-color)] my-0.5" />

            {/* 更新说明（VS Code 式 tab）：与「帮助」同层——低频、只读、回头才看。
                不占活动栏图标位（该列只放高频模块）。 */}
            <button onClick={() => { window.dispatchEvent(new CustomEvent('release-notes:open')); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <History size={15} className="text-[var(--text-muted)]" />
              更新说明
            </button>

            <div className="border-t border-[var(--border-color)] my-0.5" />

            {/* 回收站：不作为侧栏 tab，从设置菜单进入应用内回收站模块（含恢复能力） */}
            <button onClick={() => { onChange('recycle'); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <Trash2 size={15} className="text-[var(--text-muted)]" />
              回收站
            </button>

            <div className="border-t border-[var(--border-color)] my-0.5" />

            <button onClick={() => { setMenuOpen(false); window.dispatchEvent(new CustomEvent('open-import-modal')) }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
              <Download size={15} className="text-[var(--text-muted)]" />
              导入数据
            </button>
          </div>
        )}
      </div>

      {/* Right-click context menu — toggle module visibility */}
      {ctxMenu && (
        <div className="fixed inset-0 z-[70]" onClick={() => setCtxMenu(null)}>
          <div
            className="absolute bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl py-0.5 min-w-[180px]"
            ref={ctxMenuRef}
            style={ctxMenuStyle}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
          >
            <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide px-3 py-1.5">显示/隐藏模块</div>
            <div className="border-t border-[var(--border-color)]" />
            {ALL_MODULES.map(m => (
              <button
                key={m.id}
                onClick={() => toggleHidden(m.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-left"
              >
                <span className="w-4 flex items-center justify-center shrink-0">
                  {!hidden.includes(m.id) && <Check size={12} className="text-[var(--accent)]" />}
                </span>
                <span className="flex items-center gap-1.5">
                  {m.icon(14)}
                  {m.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
