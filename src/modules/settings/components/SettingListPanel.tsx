import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { AnchoredLayer } from '../../../components/shared/AnchoredLayer'
import { HelpHint } from '../../../components/shared/HelpHint'
import { consumePendingAnchor, subscribePendingAnchor } from '../sections'

export interface SettingListTag {
  label: string
  /** default = 灰边框 / muted；success = 绿（只读）；warning = 橙（写入） */
  tone?: 'default' | 'success' | 'warning'
}

export interface SettingListItem {
  id: string
  label: string
  icon?: React.ReactNode
  /** 单行右侧的标签簇，水平排列、紧凑（只读 / 写入 / 模块等） */
  tags?: SettingListTag[]
  /** 选中/悬停某项时，底部详情区显示的说明 */
  desc?: string
}

interface Props {
  title?: string
  description?: string
  items: SettingListItem[]
  /** 初始选中项 id；不传则默认第一项 */
  defaultSelectedId?: string
  titleClassName?: string
  /** 容器最大宽度（默认 max-w-md） */
  maxWidthClassName?: string
  /** 列表最大高度（启用后内部可滚动），默认不限制 */
  maxListHeightClassName?: string
  /** 标题右侧条目数角标，如「内置工具 (13)」 */
  count?: number
  /** 标题行最右侧的附加控件（如刷新按钮） */
  titleRight?: React.ReactNode
  /**
   * inline（默认）= 列表常驻在文档流中展开，会占位把下方内容往下推；
   * popover = 触发器按钮 + 绝对定位悬浮层，展开时覆盖下方内容不推挤
   * （与"字体样式" SettingSelect 的下拉行为一致）。
   */
  display?: 'inline' | 'popover'
  /** display=popover 时触发器缺省文案（未提供则显示当前项 label） */
  triggerLabel?: string
  /** 搜索跳转的锚点 id；跳转到本组件时 popover 自动展开 */
  anchorId?: string
}

/**
 * 设置页的只读列表组件：与 SettingSelect 的 listbox 视觉一致，
 * 但语义上不接受 onChange —— 适合"内置工具 / MCP 工具 / Skill 提示词"等
 * 只想展示「每个条目 + 详情」的场合。
 *
 * - 标题 + 描述常驻在列表外（标题行可带 (count) 与右侧控件）
 * - 列表每行单行紧凑：图标 + label + 右侧 tags；row 间用 border-t 分隔
 * - 鼠标悬停或键盘 ↑/↓ 切换高亮项
 * - 底部详情区显示当前高亮项的 desc（无 desc 时不渲染，避免空态）
 *
 * display=popover 时：
 * - 触发器为 SettingSelect 同款下拉框（显示当前项 / triggerLabel + chevron）
 * - 点击弹出绝对定位悬浮面板，覆盖而非推挤页面下方内容
 * - Esc / 点击面板外 / 再次点击触发器收起
 */
export function SettingListPanel({
  title, description, items, defaultSelectedId,
  titleClassName, maxWidthClassName = 'max-w-md', maxListHeightClassName,
  count, titleRight, display = 'inline', triggerLabel, anchorId,
}: Props) {
  const [activeId, setActiveId] = useState<string>(
    defaultSelectedId ?? items[0]?.id ?? '',
  )
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // 外部默认项变化时（如设置异步加载完成）重新对齐
  useEffect(() => {
    if (defaultSelectedId && items.some(i => i.id === defaultSelectedId)) {
      setActiveId(defaultSelectedId)
    } else if (!items.some(i => i.id === activeId) && items[0]) {
      setActiveId(items[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSelectedId, items])

  // popover：搜索锚点跳转命中时自动展开。**外点 / Esc 关闭交给 AnchoredLayer** ——
  // 浮层要挂到 body（折叠容器的 overflow:hidden 会裁掉就地 absolute 的面板），
  // 而挂出去之后「点外面算不算外面」的判定也跟着一起搬走了，这里不再各写一套。
  useEffect(() => {
    if (display !== 'popover') return
    if (anchorId && consumePendingAnchor(anchorId)) setOpen(true)
    return subscribePendingAnchor(id => {
      if (anchorId && id === anchorId) setOpen(true)
    })
  }, [display, anchorId])

  const move = (delta: number) => {
    if (items.length === 0) return
    const idx = items.findIndex(i => i.id === activeId)
    const next = items[(idx + delta + items.length) % items.length]
    if (next) setActiveId(next.id)
  }

  // popover 触发器键盘：收起态 ↓/Enter/空格 打开；展开态 ↑/↓ 移动、Enter 收起
  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Home') { e.preventDefault(); if (items[0]) setActiveId(items[0].id) }
    else if (e.key === 'End') { e.preventDefault(); const last = items[items.length - 1]; if (last) setActiveId(last.id) }
    else if (e.key === 'Enter') { e.preventDefault(); setOpen(false) }
  }

  // inline 列表键盘：焦点在列表内时 ↑/↓/Home/End 移动
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Home') { e.preventDefault(); if (items[0]) setActiveId(items[0].id) }
    else if (e.key === 'End') { e.preventDefault(); const last = items[items.length - 1]; if (last) setActiveId(last.id) }
  }

  const openList = () => {
    const cur = defaultSelectedId ?? items[0]?.id
    if (cur) setActiveId(cur)
    setOpen(true)
  }

  const active = items.find(i => i.id === activeId)
  const triggerText = triggerLabel ?? (active?.label || '—')

  const tagClass = (tone: SettingListTag['tone']) => {
    if (tone === 'success') return 'border-emerald-700/40 text-emerald-400'
    if (tone === 'warning') return 'border-orange-700/40 text-orange-400'
    return 'border-[var(--border-color)] text-[var(--text-muted)]'
  }

  const listBody = (
    <>
      <div
        ref={listRef}
        role="listbox"
        aria-label={title}
        tabIndex={0}
        onKeyDown={display === 'inline' ? onListKeyDown : undefined}
        className={`overflow-y-auto outline-none ${maxListHeightClassName ?? ''}`}
      >
        {items.map((it, i) => {
          const isActive = it.id === activeId
          return (
            <div
              key={it.id}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => setActiveId(it.id)}
              onFocus={() => setActiveId(it.id)}
              tabIndex={-1}
              className={`flex items-center gap-2 px-3.5 py-2 cursor-default outline-none transition-colors ${
                i > 0 ? 'border-t border-[var(--border-color)]' : ''
              } ${isActive ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'}`}
            >
              {it.icon && <span className="shrink-0 text-[var(--accent)]">{it.icon}</span>}
              <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{it.label}</span>
              {it.tags && it.tags.length > 0 && (
                <span className="flex items-center gap-1 shrink-0">
                  {it.tags.map((tg, k) => (
                    <span
                      key={k}
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${tagClass(tg.tone)}`}
                    >
                      {tg.label}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )
        })}
        {items.length === 0 && (
          <p className="text-[12px] text-[var(--text-muted)] px-3.5 py-3">暂无条目</p>
        )}
      </div>

      {active?.desc && (
        <div className="border-t border-[var(--border-color)] px-3.5 py-2 text-[11px] text-[var(--text-muted)] leading-relaxed">
          {active.desc}
        </div>
      )}
    </>
  )

  return (
    <div ref={rootRef}>
      {/* 标题行：title + (count) + ⓘ 说明 + 右侧控件。
          ★ 说明文字改走 ⓘ 悬停（2026-10-14）：原先它常驻在标题下面，
            在"点开才有"的新口径里是白占一行。文案一字不删，只是收起来。 */}
      {(title || count !== undefined || titleRight || description) && (
        <div className="flex items-center gap-1.5 mb-1">
          {title && (
            <h3 className={titleClassName ?? 'text-[13px] font-medium text-[var(--text-primary)]'}>{title}</h3>
          )}
          {typeof count === 'number' && (
            <span className="text-[10px] text-[var(--text-disabled)]">({count})</span>
          )}
          {description && <HelpHint text={description} />}
          {titleRight && <span className="ml-auto shrink-0">{titleRight}</span>}
        </div>
      )}

      {display === 'inline' ? (
        <div
          className={`relative mt-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-hidden ${maxWidthClassName}`}
        >
          {listBody}
        </div>
      ) : (
        <div className={`relative mt-2 ${maxWidthClassName}`}>
          {/* 触发器：SettingSelect 同款下拉框 */}
          <button
            ref={triggerRef}
            onClick={() => (open ? setOpen(false) : openList())}
            onKeyDown={onTriggerKeyDown}
            aria-haspopup="listbox"
            aria-expanded={open}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none hover:border-[var(--text-disabled)] focus:border-[var(--accent)] transition-colors"
          >
            <span className="flex items-center gap-2 truncate">
              {active?.icon && <span className="shrink-0 text-[var(--text-muted)]">{active.icon}</span>}
              <span className="truncate">{triggerText}</span>
            </span>
            <ChevronDown size={14} className={`shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>

          {/* 选项面板挂 body、宽度跟随触发器：折叠组里就地 absolute 会被裁掉半个 */}
          <AnchoredLayer
            anchorRef={triggerRef}
            open={open}
            onClose={() => setOpen(false)}
            matchWidth
            className="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-lg overflow-hidden"
          >
            {listBody}
          </AnchoredLayer>
        </div>
      )}
    </div>
  )
}
