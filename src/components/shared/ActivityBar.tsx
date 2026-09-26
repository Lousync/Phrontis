import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TabName } from '../../types'
import { Trash2, FlaskConical, LayoutPanelLeft, GraduationCap, Check } from 'lucide-react'
import { MomentsIcon, SettingsIcon, PluginIcon, BookMarketIcon } from './ModuleIcons'
import { WORKBENCH_TABBAR_EXCLUDED } from '../../lib/workbenchLayout'
import { railHiddenIds, railOrder, railVisibleOrder } from '../../lib/appModules'
import { useSettings } from '../../lib/SettingsContext'
import { useContextMenuPosition } from '../../lib/useContextMenuPosition'

/**
 * 图标条（v3.4.0 工作台三栏外壳，方案 §3.4 / §10；2026-09-17 拍板变化：工具箱按钮撤掉，5 → 4；
 * 同日 bug 修复轮：顶部补「工作台」按钮；批次5 反馈轮（21:xx 拍板）：**AI 教学入口回归图标条**
 * （用户侧边 tab 上没有 AI 教学区入口）——排在工作台之下第一位，整窗独占语义不变）。
 *
 * - **顶部工作台按钮**：工作台态（activeTab 为空或非整窗模块）高亮且点击无操作（入口幂等）；
 *   整窗模块态点击 = 回工作台（目标标签由 App 决定：openTabs 最后文档标签 ?? editor）；
 * - **AI 教学**：整窗独占模块（EXCLUDED 内），激活时中间栏 + 标签条整体让位；
 * - **工具箱入口移除**：原「🧰 打开为中间标签页」的入口语义由右栏上部「工具箱工具入口区」
 *   承接（方案 §10，ToolLauncherZone），工具箱模块本身保留（命令面板/深链仍可达）；
 * - **入口幂等哲学**：标签只能由入口产生，重复点击已激活的按钮 = 无操作；
 * - 底部弹出菜单整条删除：设置按钮直接打开「设置」标签页（主题切换等在设置页内），
 *   帮助入口改在设置页（批次7）、回收站直接从本图标条进入；
 * - user 账户按钮删除（账户并入设置「账户」分组，批次7）；
 * - devtools 保留 dev-only 老位置（打包构建时静态消除）。
 *
 * **2026-09-25（F-1 恢复）：拖拽排序 + 右键显隐回归。** 顺序写 `railOrder`、显隐写 `railHidden`
 * —— 与 2026-09-26 已删除的旧活动栏键 `activityBarOrder` / `activityBarHidden`（那套八模块
 * 图标条随 v3.4.0 三栏外壳退役）无关。成员与顺序归一化在 `appModules.RAIL_MODULE_IDS` /
 * `railOrder`；顶部工作台 + 底部设置两钮不参与。
 * **排序走 pointer events，不用 HTML5 拖放**（铁律 9：图标条在 `-webkit-user-drag: none` 的
 * 继承链上，HTML5 拖放在此静默失败 —— 2026-09-25 实机确认拖不动后改的；同日程拖拽手法）。
 */

/** 手势结束后浏览器会补发一次 click，用它挡掉「拖完顺手切了模块」（与日程 dragGuard 同口径） */
const railDragGuard = { lastEnd: 0 }

/** 拖拽与点击的分界位移（px）：小于它算点击，不算拖 */
const DRAG_THRESHOLD = 4

/** 图标条可排序 / 可隐藏的按钮。**成员真源是 `appModules.RAIL_MODULE_IDS`**，本表只补图标与名称
 *  （契约 `verify-workbench-shell` 双向断言两侧 id 集一致，防漂移）。
 *
 *  2026-09-17：插件市场由「拼图块」改为「包裹箱」—— 22px 下箱子的轮廓比多块拼图更清楚，
 *  语义也更贴「插件市场里取件」。但**没有放弃跟随**：这枚仍走 PluginIcon（StyleAware），
 *  选「手绘」包 = ModuleIcons 的手绘箱子，选「经典细线」包 = lucide Package，
 *  两包形状同构、画法有别 —— 切设置时看得出来变了，又不会认成另一个模块。
 *  同源的还有桌面磁贴的「插件」卡片与设置→外观的图标预览（都经 moduleId 'plugins'）。 */
const RAIL_BUTTONS: { id: TabName; label: string; icon: (size: number) => React.ReactNode }[] = [
  { id: 'aiTeaching', label: 'AI 教学', icon: (s) => <GraduationCap size={s} /> },
  { id: 'recycle', label: '回收站', icon: (s) => <Trash2 size={s} /> },
  { id: 'plugins', label: '插件市场', icon: (s) => <PluginIcon size={s} /> },
  { id: 'moments', label: '动态', icon: (s) => <MomentsIcon size={s} /> },
  // 2026-09-22 书市（方案 §1.2 第 5 条 / 拍板 ⑤）：左栏独立整窗模块，与工具箱 / 插件平级。
  // **追加在末尾**（不动现四项的位置）：这排是固定清单，位置本身没有语义，
  // 追加的 diff 最小、也最好核对。图标走 BookMarketIcon（StyleAware）——
  // 手绘包 = 店招，经典细线包 = lucide Store，两包形状同构、画法有别。
  { id: 'bookMarket', label: '书市', icon: (s) => <BookMarketIcon size={s} /> },
]

const RAIL_BY_ID = new Map(RAIL_BUTTONS.map((b) => [b.id, b]))

interface Props {
  /** 当前激活模块；null = 全部标签已关闭的空态（无高亮项） */
  active: TabName | null
  onChange: (tab: TabName) => void
  /** 点「工作台」按钮时回调（仅整窗模块态触发；工作台态按钮幂等无操作）。
      目标标签由 App 决定——与被删除的右上角浮动按钮同一份语义（openTabs 最后文档标签 ?? editor） */
  onWorkbench?: () => void
  /** UI 优化条目1：最大化时图标条卡去留白/圆角/边框阴影，贴满屏幕边缘 */
  flush?: boolean
}

export function ActivityBar({ active, onChange, onWorkbench, flush }: Props) {
  const { s, update } = useSettings()
  const [dragId, setDragId] = useState<TabName | null>(null)
  const [dropIdx, setDropIdx] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const { menuRef: ctxMenuRef, style: ctxStyle } = useContextMenuPosition(ctxMenu)
  const railRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ id: TabName; startY: number; moved: boolean } | null>(null)
  const dropIdxRef = useRef<number | null>(null)

  /** 全量顺序（含被隐藏项）—— 重排后在它上面回填，隐藏项的相对位置才不会丢 */
  const order = railOrder(s.railOrder)
  const visible = railVisibleOrder(s.railOrder, s.railHidden)
  const hidden = railHiddenIds(s.railHidden)

  // 工作台态 = 激活标签为空（全关空态）或非整窗平级模块（EXCLUDED 之外）
  const inWorkbench = active === null || !WORKBENCH_TABBAR_EXCLUDED.includes(active)
  // 尺寸对齐原型 v15（2026-09-16 第二轮 UI 反馈「图标条还是太粗」）：容器 44px、按钮 34×34、
  // 圆角 7px、图标 22px；激活指示条 3×18px，left -5px 贴容器左缘（(44-34)/2 = 5px）。
  const railCls = (isActive: boolean) => `
    w-[34px] h-[34px] flex items-center justify-center relative rounded-[7px] transition-all duration-150
    ${isActive
      ? 'text-[var(--accent)] bg-[var(--bg-hover)]/80 shadow-[inset_0_0_0_1px_var(--border-color)]'
      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]/50'}
  `
  const railMark = (
    <div className="absolute -left-[5px] top-1/2 -translate-y-1/2 w-[3px] h-[18px] bg-[var(--accent)] rounded-r-full" />
  )

  // 右键菜单：Esc 关闭（外部点击由浮层遮罩处理，同左栏零散文件菜单模式）
  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ctxMenu])

  const toggleHidden = (id: TabName) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]
    update('railHidden', JSON.stringify(next))
  }

  // ----- 拖拽重排（pointer events）-----
  /** 指针 Y 落在第几个可见按钮的**上半个**里 ⇒ 就插到这个下标 */
  const indexAtY = (y: number): number => {
    const btns = railRef.current?.querySelectorAll<HTMLElement>('[data-rail-btn]')
    if (!btns || btns.length === 0) return 0
    for (let i = 0; i < btns.length; i++) {
      const r = btns[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) return i
    }
    return btns.length - 1
  }

  const commitReorder = (id: TabName, to: number) => {
    const vis = visible.slice()
    const from = vis.indexOf(id)
    if (from === -1) return
    const at = Math.max(0, Math.min(to, vis.length - 1))
    if (at === from) return
    vis.splice(from, 1)
    vis.splice(at, 0, id)
    // 只重排可见项，隐藏项留在原槽位（否则隐藏项会被甩到队尾）
    const queue = vis.slice()
    const next = order.map((x) => (hidden.includes(x) ? x : queue.shift()!))
    update('railOrder', JSON.stringify(next))
  }

  const onBtnPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: TabName) => {
    if (e.button !== 0) return   // 右键留给显隐菜单
    dragRef.current = { id, startY: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onBtnPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    if (!d) return
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.moved = true
      setDragId(d.id)
    }
    const i = indexAtY(e.clientY)
    dropIdxRef.current = i
    setDropIdx(i)
  }

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current
    dragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 指针已释放 */ }
    setDragId(null)
    if (!d?.moved) { dropIdxRef.current = null; setDropIdx(null); return }
    railDragGuard.lastEnd = Date.now()
    const to = dropIdxRef.current
    dropIdxRef.current = null
    setDropIdx(null)
    if (to !== null) commitReorder(d.id, to)
  }

  return (
    <div
      ref={railRef}
      className={`w-11 flex flex-col items-center py-2 gap-0.5 shrink-0 select-none transition-all duration-300 ease-out bg-[color-mix(in_srgb,var(--activitybar-bg)_85%,transparent)] ${flush ? 'rounded-none' : 'mx-1.5 my-1.5 rounded-xl border border-[var(--border-color)] shadow-[inset_0_1px_0_var(--glass-edge),0_6px_24px_rgba(0,0,0,0.16)]'}`}
      onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }) }}
    >
      {/* 工作台 —— 顶部第一按钮（VS Code 惯例：主视图入口在最上）。
          工作台态高亮 + 点击无操作（入口幂等）；整窗模块态 = 唯一的「回工作台」入口 */}
      <button
        onClick={() => { if (!inWorkbench) onWorkbench?.() }}
        title="工作台"
        className={railCls(inWorkbench)}
      >
        {inWorkbench && railMark}
        <LayoutPanelLeft size={22} />
      </button>

      {visible.map((id, i) => {
        const b = RAIL_BY_ID.get(id)
        if (!b) return null
        return (
          <button
            key={id}
            data-rail-btn={id}
            onPointerDown={(e) => onBtnPointerDown(e, id)}
            onPointerMove={onBtnPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={() => {
              if (Date.now() - railDragGuard.lastEnd < 250) return   // 拖完补发的 click
              onChange(id)
            }}
            title={b.label}
            className={`${railCls(active === id)} ${dragId === id ? 'opacity-40' : ''}`}
          >
            {active === id && railMark}
            {b.icon(22)}
            {/* 插入位指示：拖到某个按钮的上半 ⇒ 插在它前面 */}
            {dragId && dragId !== id && dropIdx === i && (
              <div className="absolute -top-[3px] left-1/2 h-[3px] w-6 -translate-x-1/2 rounded-full bg-[var(--accent)]" />
            )}
          </button>
        )
      })}

      <div className="mt-auto flex flex-col items-center">
        {/* 设置 —— 直接打开设置标签页（拍板：设置=中间标签页；原底部弹出菜单删除） */}
        <button onClick={() => onChange('settings')} title="设置" className={railCls(active === 'settings')}>
          {active === 'settings' && railMark}
          <SettingsIcon size={22} />
        </button>

        {/* 开发者工具 — 仅 DEV 渲染,打包构建时该分支被静态消除 */}
        {import.meta.env.DEV && (
          <button onClick={() => onChange('devtools')} title="开发者工具 (DEV)" className={railCls(active === 'devtools')}>
            {active === 'devtools' && railMark}
            <FlaskConical size={22} />
          </button>
        )}
      </div>

      {/* 右键菜单：显示 / 隐藏图标。浮层一律 portal 到 body —— 图标条的祖先链在禅模式等
          场景会带变换，`fixed` 的包含块会变成窄栏，菜单被压成竖条（同左栏菜单的坑）。 */}
      {ctxMenu && createPortal(
        <div
          className="fixed inset-0 z-[70]"
          onMouseDown={() => setCtxMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}
        >
          <div
            ref={ctxMenuRef}
            className="absolute min-w-[150px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg kb-pop"
            style={ctxStyle}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">显示 / 隐藏图标</div>
            <div className="my-0.5 border-t border-[var(--border-color)]" />
            {order.map((id) => {
              const b = RAIL_BY_ID.get(id)
              if (!b) return null
              return (
                <button
                  key={id}
                  onClick={() => toggleHidden(id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                >
                  <span className="flex w-4 shrink-0 items-center justify-center">
                    {!hidden.includes(id) && <Check size={12} className="text-[var(--accent)]" />}
                  </span>
                  <span className="flex items-center gap-1.5">{b.icon(14)}{b.label}</span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
