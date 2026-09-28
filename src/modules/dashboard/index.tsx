import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ArrowLeft, Check, Pencil, Puzzle } from 'lucide-react'
import { dashboardGetSnapshot, updateScheduleTodo, toggleHabitCheck, pluginListDashboardWidgets } from '../../lib/ipc'
import { notifyDataChanged, useDataChanged } from '../../lib/dataChanged'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'
import { burstConfetti, ensureFeedbackStyles } from '../../lib/confetti'
import { ThemeFxLayer } from '../../components/shared/ThemeFxLayer'
import { PluginFrame } from '../../components/shared/PluginFrame'
import type { DashboardSnapshot, PluginDashboardWidget } from '../../types'
import {
  CARD_REGISTRY, DEFAULT_CARD_IDS, CARD_BG_OPTIONS,
  Card, CardBody, HUE,
  type CardBg, type CardDef,
} from './cards'
import {
  parseLayout, normalizeLayout, swapIds, insertId, withSize,
  GRID_COLS, type TileLayoutItem, type LayoutSource,
} from './tileGrid'

/**
 * 看板模块（2026-09-27；2026-09-28 栅格化）—— 左栏书签入口 + **整窗**。
 *
 * 落点：在 `WORKBENCH_TABBAR_EXCLUDED` 里，所以没有左右栏、没有页面条，
 * 中间栏整个归它，且不产生标签页。返回工作台的唯一出口是左上角那个箭头。
 *
 * 栅格化（docs/dashboard-tile-grid-design.md）：卫星卡区从 3 列 auto-row 改为
 * **6 列 × 固定行高磁贴栅格**（dense 流），每卡有格子比例。编辑态（顶栏 toggle）提供
 * 拖拽换位（对调）/ 拉角改尺寸 / × 隐藏进底部托盘 / 托盘点一下或拖入网格加回。
 * 顺序与尺寸存 `dashboardTileLayout`，显隐仍存 `dashboardCards`（语义不变）。
 * 拖拽引擎 = 状态机 + window 级收尾（硬约束见技能 css-grid-drag-reorder：
 * 拖动块留流内只改 transform、命中用布局快照、提交才重排、FLIP 落位）。
 *
 * 数据：主进程一次聚合（`dashboard:getSnapshot`）—— 见 database/repositories/dashboardRepo.ts。
 * 刷新：订阅相关 scope，任一域变化就整体重取（快照本身就是一次读，增量刷新没意义）。
 */

/** 一次取全量；任一相关域变化就重取 */
function useDashboardSnapshot(): DashboardSnapshot | null {
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null)
  const load = useCallback(() => {
    void dashboardGetSnapshot().then(setSnap).catch((e) => {
      console.error('[dashboard] 取快照失败', e)
      setSnap(null)
    })
  }, [])
  useEffect(() => { load() }, [load])
  // 打卡 / 待办 / 笔记 / 错题 / 阅读进度都会影响卡片数字
  useDataChanged('schedule', load)
  useDataChanged('habit', load)
  useDataChanged('knowledge', load)
  useDataChanged('quiz', load)
  useDataChanged('pdfReader', load)
  useDataChanged('readerState', load)
  return snap
}

function greetingOf(hour: number): string {
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

/**
 * 紧凑档（看板方案 §5 反馈 3，2026-09-27）：默认窗口 1280×820（标题栏 36px → 可视 ≈784px）下
 * 看板内容必须**无滚动条**。舒展形态满数据 ≈ 970px，只有视口 ≥ ~1000px 才放得下；
 * 紧凑形态满数据 ≈ 760px。阈值取 1000 —— 两档各自的自洽区间 [784, 968] 与 [968, ∞) 不重叠。
 * resize 只翻转一个布尔，React 同值即 bail out，无节流必要。
 */
function useCompactTier(): boolean {
  const [compact, setCompact] = useState(() => window.innerHeight < 1000)
  useEffect(() => {
    const onResize = () => setCompact(window.innerHeight < 1000)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return compact
}

/** 插件看板控件清单（2026-09-28 底层基建）：mount 拉 + plugins-changed 重拉。
 *  看板与知识库侧栏同属保活面（Tab 首挂后不卸载），插件安装/启停不会自然触发重挂，
 *  必须订阅事件 —— 与 knowledge/index.tsx 同款走法。 */
function usePluginWidgets(): PluginDashboardWidget[] {
  const [ws, setWs] = useState<PluginDashboardWidget[]>([])
  const load = useCallback(() => {
    void pluginListDashboardWidgets().then(setWs).catch(() => { /* 插件线不可用视为无贡献 */ })
  }, [])
  useEffect(() => {
    load()
    window.addEventListener('plugins-changed', load)
    return () => window.removeEventListener('plugins-changed', load)
  }, [load])
  return ws
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/* ==================== 磁贴拖拽：常量与纯 DOM 工具 ==================== */

const ROW_H = 76
const GAP = 12
const MINI_CELL_W = 176 // 托盘缩略预览的基准格宽（≈1200 容器下的真实格宽，预览允许近似）

interface TileSnap {
  id: string
  el: HTMLElement
  l: number
  t: number
  r: number
  b: number
}

/** 抬起瞬间的布局快照（相对栅格原点、排除自身）—— 拖动全程的命中依据。
 *  z-index 抬起后 elementFromPoint 恒命中自己，不可用（css-grid-drag-reorder 反模式）。 */
function snapshotTiles(gridEl: HTMLDivElement, exclude: HTMLElement | null): { g: DOMRect; snap: TileSnap[] } {
  const g = gridEl.getBoundingClientRect()
  const snap: TileSnap[] = [...gridEl.querySelectorAll<HTMLElement>('[data-id]')]
    .filter((x) => x !== exclude)
    .map((x) => {
      const r = x.getBoundingClientRect()
      return { id: x.dataset.id ?? '', el: x, l: r.left - g.left, t: r.top - g.top, r: r.right - g.left, b: r.bottom - g.top }
    })
  return { g, snap }
}

function hitIn(snap: TileSnap[], g: DOMRect, px: number, py: number): TileSnap | null {
  const x = px - g.left
  const y = py - g.top
  return snap.find((s) => x >= s.l && x < s.r && y >= s.t && y < s.b) ?? null
}

/** 防御性清扫：任何时刻不留残 transform / 拖拽态（散架问题的釜底抽薪） */
function sweepTileInline(root: HTMLElement | null): void {
  if (!root) return
  root.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
    el.style.transform = ''
    el.style.transition = ''
    el.style.zIndex = ''
    el.style.boxShadow = ''
    el.style.cursor = ''
    el.style.outline = ''
  })
}

function applySpan(el: HTMLElement, w: number, h: number): void {
  el.style.gridColumn = `span ${w} / span ${w}`
  el.style.gridRow = `span ${h} / span ${h}`
}

/* ==================== 托盘缩略预览 ==================== */

/** 按真实格子比例等比缩小的卡面（内容照实渲染，pointer-events 关死 —— 预览不可交互） */
function MiniFace({ def, w, h, width, body }: {
  def: CardDef
  w: number
  h: number
  width: number
  body: React.ReactNode
}) {
  const fullW = w * MINI_CELL_W + (w - 1) * GAP
  const fullH = h * ROW_H + (h - 1) * GAP
  const scale = width / fullW
  const ph = Math.max(36, Math.round(fullH * scale))
  return (
    <span
      className="relative block overflow-hidden rounded-[6px] border border-[var(--border-color)] bg-[var(--bg-primary)]"
      style={{ width, height: ph }}
    >
      <span
        className="pointer-events-none absolute left-0 top-0 block origin-top-left overflow-hidden rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)]"
        style={{ width: fullW, height: fullH, transform: `scale(${scale})` }}
      >
        <span className="flex items-center gap-[5px] px-[9px] pb-0.5 pt-[7px]">
          <span className="h-2 w-2 flex-none rounded-[3px]" style={{ background: HUE[def.group] }} />
          <b className="truncate text-[12px] font-semibold text-[var(--text-primary)]">{def.label}</b>
        </span>
        <span className="block px-[9px] pb-2">{body}</span>
      </span>
    </span>
  )
}

export function DashboardModule({ onBack, onOpenBook, onJumpSchedule }: {
  onBack: () => void
  onOpenBook?: (relPath: string) => void
  onJumpSchedule?: () => void
}) {
  const { s, update } = useSettings()
  const snap = useDashboardSnapshot()
  const compact = useCompactTier()
  // ck-pop 圈体弹跳的样式由 confetti.ts 懒注入 —— 挂载即注入一次，不依赖「先炸彩纸才注入」的时序
  useEffect(() => { ensureFeedbackStyles() }, [])
  // 区间切换器已撤（2026-09-28 拍板：它只影响使用时长一张卡，语义不成立）—— 使用卡固定「今日」
  const [editing, setEditing] = useState(false)

  const bg = (s.dashboardBg as CardBg) || 'mark'
  // 称呼（看板方案 §5 反馈 2）：存 dashboardUserName；空 = 问候语不带称呼。
  // 入口只有 hero 行内编辑一处（拍板），不进设置页/编辑弹层。
  const userName = s.dashboardUserName || ''
  const [nameEdit, setNameEdit] = useState<{ draft: string } | null>(null)
  const commitUserName = () => {
    if (!nameEdit) return
    const v = nameEdit.draft.trim()
    setNameEdit(null)
    if (v !== userName) void update('dashboardUserName', v)
  }

  /* ---------------- 插件控件 + 布局状态 ---------------- */

  const widgets = usePluginWidgets()
  const widgetIdOf = useCallback((w: PluginDashboardWidget) => `${w.pluginId}:${w.wid}`, [])

  // 显隐（语义不变，setting dashboardCards）
  const shown = useMemo(() => {
    try {
      const v = JSON.parse(s.dashboardCards || '')
      if (Array.isArray(v)) return new Set(v.map(String))
    } catch { /* 坏数据走默认 */ }
    return new Set(DEFAULT_CARD_IDS)
  }, [s.dashboardCards])
  const shownRef = useRef(shown)
  shownRef.current = shown

  // 布局 known 来源：内置注册表 + 在场插件 + **存量布局里的 id**（含已停用插件的残留 —— 槽位保留，
  // 渲染侧按 defOf 是否在场过滤，插件回来还在原位置；见 design §2）
  const knownSources = useMemo<LayoutSource[]>(() => {
    const map = new Map<string, LayoutSource>()
    for (const c of CARD_REGISTRY) map.set(c.id, { id: c.id, w: c.w, h: c.h })
    for (const w of widgets) {
      const id = widgetIdOf(w)
      map.set(id, { id, w: w.w, h: w.h })
    }
    for (const p of parseLayout(s.dashboardTileLayout)) {
      if (!map.has(p.id)) map.set(p.id, p)
    }
    return [...map.values()]
  }, [widgets, s.dashboardTileLayout, widgetIdOf])

  const [layout, setLayout] = useState<TileLayoutItem[]>(() => normalizeLayout(parseLayout(s.dashboardTileLayout), knownSources))
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // 插件清单 / 设置异步到位后重归一化（幂等：同输入同输出，序与内容一致就不换引用）
  useEffect(() => {
    setLayout((prev) => {
      const next = normalizeLayout(parseLayout(s.dashboardTileLayout), knownSources)
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
    })
  }, [knownSources, s.dashboardTileLayout])

  /** 布局提交：setState + 落库。flush = 拖拽换位（同步重排 DOM 后才量得到 FLIP 终态） */
  const applyLayout = (next: TileLayoutItem[], flush = false) => {
    layoutRef.current = next
    if (flush) flushSync(() => setLayout(next))
    else setLayout(next)
    void update('dashboardTileLayout', JSON.stringify(next))
  }
  const applyLayoutRef = useRef(applyLayout)
  applyLayoutRef.current = applyLayout

  /** 显隐落库：内置卡按注册表序归一，插件/未知 id 原样保留（不依赖异步清单，防漏勾） */
  const persistShown = (wanted: Set<string>) => {
    const builtinIds = new Set(CARD_REGISTRY.map((c) => c.id))
    const ordered = [
      ...CARD_REGISTRY.filter((c) => wanted.has(c.id)).map((c) => c.id),
      ...[...wanted].filter((v) => !builtinIds.has(v)),
    ]
    void update('dashboardCards', JSON.stringify(ordered))
  }
  const hideTile = (id: string) => {
    const wanted = new Set(shownRef.current)
    wanted.delete(id)
    persistShown(wanted)
  }
  const addTile = (id: string) => {
    const wanted = new Set(shownRef.current)
    wanted.add(id)
    persistShown(wanted)
  }
  const addTileRef = useRef(addTile)
  addTileRef.current = addTile

  /** id → 卡定义（内置注册表，其次在场插件控件；都不在 = null，渲染侧跳过） */
  const defOf = (id: string): CardDef | null => {
    const b = CARD_REGISTRY.find((c) => c.id === id)
    if (b) return b
    const w = widgets.find((x) => widgetIdOf(x) === id)
    if (w) return { id: widgetIdOf(w), label: w.title, group: 'plugin', Icon: Puzzle, defaultOn: false, w: w.w, h: w.h }
    return null
  }

  /* ---------------- 数据动作（与栅格无关，口径不变） ---------------- */

  const markDone = async (id: string) => {
    try {
      await updateScheduleTodo(id, { status: 'done' })
      // 沿用全仓既有约定：写完广播，别的窗口 + 本窗口一起刷新
      notifyDataChanged('schedule')
    } catch (e) {
      showToast({ type: 'error', message: '勾选失败', detail: (e as Error).message })
    }
  }

  /** 打卡项直接勾选（看板方案 §5 反馈 4②，2026-09-27 拍板）：写路径复用 habit:toggleCheck，
   *  写完 notifyDataChanged('habit') —— hero 统计 pill 与各卡片同批刷新（既有约定，同 markDone）。
   *  反馈 7：pos 在场 = 本次是「勾上」（取消勾调用方不传）→ 与打卡列表同款，在勾选圈位置炸彩纸。 */
  const toggleHabit = async (habitId: string, pos?: { x: number; y: number }) => {
    if (!snap) return
    try {
      await toggleHabitCheck(habitId, snap.today)
      if (pos) burstConfetti(pos.x, pos.y)
      notifyDataChanged('habit')
    } catch (e) {
      showToast({ type: 'error', message: '打卡失败', detail: (e as Error).message })
    }
  }

  /** 最近编辑 → 笔记区（看板方案 §5 反馈 5①）：走 kb-open-note 统一通道；
   *  from:'dashboard' 让 App 记跳转来源 → 知识库页条出「← 返回看板」chip（N-4 机制，零新基建）。 */
  const openNote = (relPath: string) => {
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath, from: 'dashboard' } }))
  }

  /* ---------------- 拖拽状态机（refs；收尾只有一个口） ---------------- */

  const gridRef = useRef<HTMLDivElement | null>(null)
  const trayListRef = useRef<HTMLDivElement | null>(null)

  interface TileDragState {
    id: string
    el: HTMLElement
    startX: number
    startY: number
    tx: number
    ty: number
    moved: boolean
    originRect: DOMRect
    g: DOMRect
    snap: TileSnap[]
  }
  interface TrayDragState {
    id: string
    clone: HTMLElement
    startX: number
    startY: number
    moved: boolean
    g: DOMRect
    snap: TileSnap[]
  }
  interface ResizeState {
    id: string
    el: HTMLElement
    g: DOMRect
    w: number
    h: number
  }

  const tileDrag = useRef<TileDragState | null>(null)
  const trayDrag = useRef<TrayDragState | null>(null)
  const resize = useRef<ResizeState | null>(null)
  const prevTarget = useRef<HTMLElement | null>(null)
  const settling = useRef(false) // FLIP 落位动画期间禁止开新拖拽（快照会量到半路位置）

  const clearDropHint = () => {
    if (prevTarget.current) {
      prevTarget.current.style.outline = ''
      prevTarget.current = null
    }
  }

  const startTileDrag = (e: React.PointerEvent, id: string) => {
    if (!editing || e.button !== 0 || tileDrag.current || trayDrag.current || resize.current || settling.current) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    const gridEl = gridRef.current
    if (!gridEl) return
    const el = gridEl.querySelector<HTMLElement>(`[data-id="${id}"]`)
    if (!el) return
    sweepTileInline(gridEl)
    const { g, snap } = snapshotTiles(gridEl, el)
    tileDrag.current = { id, el, startX: e.clientX, startY: e.clientY, tx: 0, ty: 0, moved: false, originRect: el.getBoundingClientRect(), g, snap }
    e.preventDefault()
  }

  const startTrayDrag = (e: React.PointerEvent, id: string) => {
    if (!editing || e.button !== 0 || tileDrag.current || trayDrag.current || resize.current || settling.current) return
    const gridEl = gridRef.current
    const itemEl = trayListRef.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)
    if (!gridEl || !itemEl) return
    sweepTileInline(gridEl)
    const { g, snap } = snapshotTiles(gridEl, null)
    const clone = itemEl.cloneNode(true) as HTMLElement
    clone.style.position = 'fixed'
    clone.style.zIndex = '300'
    clone.style.pointerEvents = 'none'
    clone.style.filter = 'drop-shadow(0 14px 28px rgba(20,32,55,.35))'
    document.body.appendChild(clone)
    trayDrag.current = { id, clone, startX: e.clientX, startY: e.clientY, moved: false, g, snap }
    clone.style.left = `${e.clientX}px`
    clone.style.top = `${e.clientY}px`
    clone.style.transform = 'translate(-50%, -60%)'
    e.preventDefault()
  }

  const startResize = (e: React.PointerEvent, id: string) => {
    if (!editing || e.button !== 0 || tileDrag.current || trayDrag.current || resize.current || settling.current) return
    const gridEl = gridRef.current
    const el = gridEl?.querySelector<HTMLElement>(`[data-id="${id}"]`)
    if (!gridEl || !el) return
    const it = layoutRef.current.find((t) => t.id === id)
    if (!it) return
    resize.current = { id, el, g: gridEl.getBoundingClientRect(), w: it.w, h: it.h }
    e.stopPropagation()
    e.preventDefault()
  }

  const onGlobalPointerMove = (e: PointerEvent) => {
    const rd = resize.current
    if (rd) {
      // 拉角改尺寸：拖到哪格吸到哪格（宽 2-6 × 高 1-4），实时写内联 span
      const pitch = (rd.g.width + GAP) / GRID_COLS
      const rowPitch = ROW_H + GAP
      rd.w = Math.max(2, Math.min(GRID_COLS, Math.round((e.clientX - rd.g.left) / pitch)))
      rd.h = Math.max(1, Math.min(4, Math.round((e.clientY - rd.g.top) / rowPitch)))
      applySpan(rd.el, rd.w, rd.h)
      const badge = rd.el.querySelector<HTMLElement>('[data-size-badge]')
      if (badge) badge.textContent = `${rd.w}×${rd.h}`
      return
    }

    const td = tileDrag.current
    if (td) {
      const dx = e.clientX - td.startX
      const dy = e.clientY - td.startY
      if (!td.moved && Math.hypot(dx, dy) < 4) return
      if (!td.moved) {
        td.moved = true
        // 首帧内联关过渡（跟手零延迟）；抬起 = 放大 + 大投影 + 最上层
        td.el.style.transition = 'none'
        td.el.style.zIndex = '10'
        td.el.style.boxShadow = '0 18px 40px rgba(20,32,55,.30)'
        td.el.style.cursor = 'grabbing'
      }
      td.tx = dx
      td.ty = dy
      td.el.style.transform = `translate(${dx}px, ${dy}px) scale(1.05)`
      const hit = hitIn(td.snap, td.g, e.clientX, e.clientY)
      if (prevTarget.current && (!hit || hit.el !== prevTarget.current)) {
        prevTarget.current.style.transition = ''
        prevTarget.current.style.transform = ''
        prevTarget.current = null
      }
      if (hit && hit.el !== prevTarget.current) {
        const from = td.el.getBoundingClientRect()
        const to = hit.el.getBoundingClientRect()
        // 让位预览：目标块 transform 平移进被拖块腾出的格位（不重排 DOM —— dense 回填会让重排看着没动）
        hit.el.style.transition = 'none'
        hit.el.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`
        prevTarget.current = hit.el
      }
      return
    }

    const yd = trayDrag.current
    if (yd) {
      if (!yd.moved && Math.hypot(e.clientX - yd.startX, e.clientY - yd.startY) < 5) return
      yd.moved = true
      yd.clone.style.left = `${e.clientX}px`
      yd.clone.style.top = `${e.clientY}px`
      const hit = hitIn(yd.snap, yd.g, e.clientX, e.clientY)
      if (prevTarget.current && (!hit || hit.el !== prevTarget.current)) clearDropHint()
      if (hit && hit.el !== prevTarget.current) {
        hit.el.style.outline = '2px solid var(--accent)'
        hit.el.style.outlineOffset = '2px'
        prevTarget.current = hit.el
      }
    }
  }

  const onGlobalPointerFinish = (e: PointerEvent | null, cancelled: boolean) => {
    const rd = resize.current
    if (rd) {
      resize.current = null
      applyLayout(withSize(layoutRef.current, rd.id, rd.w, rd.h))
      return
    }

    const td = tileDrag.current
    if (td) {
      tileDrag.current = null
      if (!td.moved || cancelled || !e) {
        sweepTileInline(gridRef.current)
        return
      }
      td.el.style.zIndex = ''
      td.el.style.boxShadow = ''
      td.el.style.cursor = ''
      const hit = hitIn(td.snap, td.g, e.clientX, e.clientY)
      const swapped = hit ? swapIds(layoutRef.current, td.id, hit.id) : null
      if (swapped) {
        // 提交才重排：flushSync 后 DOM 已按新序归位（key 稳定 → 节点复用），随后 FLIP 滑落
        applyLayout(swapped, true)
      }
      // FLIP：起点 = originRect + 当前位移（不是裸 originRect，否则松手先瞬移回原位）
      td.el.style.transform = ''
      const after = td.el.getBoundingClientRect()
      const mx = td.originRect.left + td.tx - after.left
      const my = td.originRect.top + td.ty - after.top
      settling.current = true
      td.el.style.transition = 'none'
      td.el.style.transform = `translate(${mx}px, ${my}px) scale(1.05)`
      void td.el.offsetHeight // 强制回流，否则起点赋值被吞
      td.el.style.transition = 'transform 220ms cubic-bezier(.2,.9,.3,1)'
      td.el.style.transform = 'translate(0px, 0px) scale(1)'
      window.setTimeout(() => {
        td.el.style.transition = ''
        td.el.style.transform = ''
        settling.current = false
      }, 240)
      if (prevTarget.current) {
        // 被让位的那块：换过位 = 视觉已在新格位，瞬时清；没换位 = 滑回自己家
        prevTarget.current.style.transition = swapped ? 'none' : 'transform 170ms cubic-bezier(.2,.9,.3,1)'
        prevTarget.current.style.transform = ''
        prevTarget.current = null
      }
      return
    }

    const yd = trayDrag.current
    if (yd) {
      trayDrag.current = null
      yd.clone.remove()
      clearDropHint()
      if (cancelled || !e) return
      if (!yd.moved) {
        addTileRef.current(yd.id) // 点一下 = 加入（保持原布局槽位）
        return
      }
      const hit = hitIn(yd.snap, yd.g, e.clientX, e.clientY)
      if (!hit) return // 拖了但没落进网格 = 放回托盘
      const r = hit.el.getBoundingClientRect()
      const afterFlag = e.clientX > r.left + r.width / 2
      applyLayout(insertId(layoutRef.current, yd.id, hit.id, afterFlag))
      addTileRef.current(yd.id)
    }
  }

  // move/up/pointercancel/blur 全挂 window，收尾事件无论指针在哪都送达（嵌入环境捕获会丢）
  const moveRef = useRef(onGlobalPointerMove)
  moveRef.current = onGlobalPointerMove
  const finishRef = useRef(onGlobalPointerFinish)
  finishRef.current = onGlobalPointerFinish
  useEffect(() => {
    const onMove = (e: PointerEvent) => moveRef.current(e)
    const onUp = (e: PointerEvent) => finishRef.current(e, false)
    const onCancel = (e: PointerEvent) => finishRef.current(e, true)
    const onBlur = () => finishRef.current(null, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 退出编辑态时清扫残留（防御性）
  useEffect(() => {
    if (!editing) sweepTileInline(gridRef.current)
  }, [editing])

  // ⛔ 早退必须在全部 hook 之后（React #310：hook 数量前后渲染不一致 = 直接崩树）
  if (!snap) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">
        正在载入看板…
      </div>
    )
  }

  const d = new Date()
  const dateLine = `${d.getFullYear()} · ${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getDate()).padStart(2, '0')} 星期${WEEKDAY[d.getDay()]}`
  const openTodoCount = snap.todos.overdue.length + snap.todos.today.length
  const usageHours = Math.round((snap.usage.days[snap.today] ?? 0) / 60)

  // 「今天该做的」= 常驻磁贴（2026-09-28 主卡降维）：强制在场，不进 dashboardCards 勾选清单
  const shownTiles = layout.filter((it) => (shown.has(it.id) || it.id === 'todos') && defOf(it.id) !== null)
  const hiddenTiles = layout.filter((it) => !shown.has(it.id) && it.id !== 'todos' && defOf(it.id) !== null)

  return (
    <div className="relative h-full">
      {/* 主题氛围特效：垫底画布（内容层 z-[1] 压在其上） */}
      <ThemeFxLayer />
      <div className="relative z-[1] h-full overflow-y-auto">
        <div className={`mx-auto max-w-[1200px] px-6 ${compact ? 'pb-5 pt-2.5' : 'pb-14 pt-5'}`}>

        {/* 顶栏：返回在左；编辑态时背景档位内联，编辑开关在右（旧「编辑卡片」弹层已废） */}
        <div className="mb-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            title="返回工作台"
            className="rounded-[8px] border border-[var(--border-color)] px-2 py-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft size={15} />
          </button>
          {editing && <span className="text-[11px] text-[var(--text-muted)]">拖动换位 · ⌟ 拉角改尺寸 · × 隐藏进托盘 · 托盘点一下或拖入看板</span>}
          <span className="flex-1" />
          {editing && (
            <div className="flex rounded-[8px] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
              {CARD_BG_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => void update('dashboardBg', o.id)}
                  className={`rounded-md px-2 py-1 text-[11px] transition-colors ${bg === o.id ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {/* 区间切换器已撤（2026-09-28 拍板）—— 顶栏非编辑态只剩返回 */}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className={`flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs transition-colors ${editing ? 'text-white hover:brightness-110' : 'border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
            style={editing ? { background: 'var(--accent)' } : undefined}
          >
            {editing ? <><Check size={12} />完成</> : <><Pencil size={12} />编辑</>}
          </button>
        </div>

        {/* Hero：视觉起点，居中。入场延迟 130ms —— 让「两侧侧栏先收」看得见 */}
        <header className={`kb-view-in text-center ${compact ? 'pb-2.5 pt-1' : 'pb-6 pt-3.5'}`} style={{ animationDelay: '130ms' }}>
          <div className="text-[10.5px] tracking-[0.2em] text-[var(--text-muted)]">{dateLine}</div>
          <h1 className={`${compact ? 'my-1.5 text-[24px]' : 'my-3 text-[33px]'} font-medium leading-tight tracking-[0.015em]`} style={{ fontFamily: 'Georgia, "STZhongsong", SimSun, serif' }}>
            {nameEdit ? (
              /* 行内编辑（看板方案 §5 反馈 2，2026-09-27 拍板）：Enter / 失焦提交，Esc 放弃；空值 = 不带称呼 */
              <input
                autoFocus
                value={nameEdit.draft}
                onChange={(e) => setNameEdit({ draft: e.target.value })}
                onBlur={commitUserName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitUserName()
                  else if (e.key === 'Escape') setNameEdit(null)
                }}
                placeholder="称呼（留空则不显示）"
                spellCheck={false}
                className="mx-auto block w-[300px] rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-1 text-center text-[24px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[13px] placeholder:font-normal placeholder:tracking-normal placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
            ) : (
              <span
                className="group inline-flex cursor-pointer items-baseline gap-1.5"
                onClick={() => setNameEdit({ draft: userName })}
                title="点击修改称呼"
              >
                <span>{userName ? `${greetingOf(d.getHours())}，${userName}` : greetingOf(d.getHours())}</span>
                <Pencil size={16} className="self-center opacity-0 transition-opacity duration-150 group-hover:opacity-40" />
              </span>
            )}
          </h1>
          <div className="inline-flex overflow-hidden rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <span className="border-r border-[var(--border-color)] px-4 py-1 text-xs text-[var(--text-muted)]">
              <b className="mr-0.5 font-semibold tabular-nums text-[var(--text-primary)]">{openTodoCount}</b>件待办
            </span>
            <span className="border-r border-[var(--border-color)] px-4 py-1 text-xs text-[var(--text-muted)]">
              <b className="mr-0.5 font-semibold tabular-nums text-[var(--text-primary)]">{usageHours}</b>小时使用
            </span>
            <span className="px-4 py-1 text-xs text-[var(--text-muted)]">
              <b className="mr-0.5 font-semibold tabular-nums text-[var(--text-primary)]">{snap.habit.streak}</b>天连续
            </span>
          </div>
        </header>

        {/* 「今天该做的」主卡已降维成常驻磁贴进栅格（2026-09-28 拍板：全宽横幅空态太空旷）—— TodoCard 见 cards.tsx */}

        {/* 磁贴栅格（2026-09-28 栅格化）：6 列 × 固定行高 76px，dense 流自动填洞。
            顺序与比例存 dashboardTileLayout，显隐存 dashboardCards（语义不变）。
            编辑态可视化：外圈描边 + × 隐藏 + ⌟ 拉角 + 比例 badge；插件 iframe 上盖遮罩（否则吞 pointerdown 拖不动）。 */}
        <div
          ref={gridRef}
          className={`grid gap-3 ${compact ? 'mt-4' : 'mt-5'}`}
          style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridAutoRows: `${ROW_H}px`, gridAutoFlow: 'row dense' }}
        >
          {shownTiles.map((it) => {
            const def = defOf(it.id)!
            const widget = def.group === 'plugin' ? widgets.find((x) => widgetIdOf(x) === it.id) : undefined
            return (
              <div
                key={it.id}
                data-id={it.id}
                className={`relative min-h-0 [&>section]:h-full ${editing ? 'cursor-grab' : ''}`}
                style={{ gridColumn: `span ${it.w} / span ${it.w}`, gridRow: `span ${it.h} / span ${it.h}` }}
                onPointerDown={(e) => startTileDrag(e, it.id)}
              >
                <Card def={def} bg={bg} w={it.w} h={it.h}>
                  {widget ? (
                    <div className="relative h-full">
                      <PluginFrame pluginId={widget.pluginId} entry={widget.entry} grantedCapabilities={widget.granted} />
                    </div>
                  ) : (
                    <CardBody def={def} snap={snap} compact={compact}
                      onMarkDone={markDone} onToggleHabit={toggleHabit} onOpenNote={openNote} onOpenBook={onOpenBook} onJumpSchedule={onJumpSchedule} />
                  )}
                </Card>
                {/* 编辑态全卡遮罩：卡内一切交互停用（防拖拽时误触勾选/跳转，iframe 同理吞 pointerdown）；
                    × / ⌟ / badge 在 z-20 更高层，不受影响。拖拽从遮罩上起手（冒泡到 wrapper）。 */}
                {editing && <div className="absolute inset-0 z-10" />}
                {editing && (
                  <>
                    <span data-size-badge className="absolute left-2 top-1.5 z-20 rounded-full px-1.5 py-px text-[10px] tabular-nums" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                      {it.w}×{it.h}
                    </span>
                    {/* 常驻主磁贴（todos）没有 × —— 不参与显隐（与 hero 口径一致） */}
                    {def.id !== 'todos' && (
                      <button
                        type="button"
                        data-no-drag
                        title={`隐藏「${def.label}」`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => hideTile(it.id)}
                        className="absolute right-1.5 top-1.5 z-20 grid h-[22px] w-[22px] place-items-center rounded-[6px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[11px] leading-none text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--danger-ink)]"
                      >
                        ✕
                      </button>
                    )}
                    <button
                      type="button"
                      data-no-drag
                      title="拖角改尺寸"
                      onPointerDown={(e) => startResize(e, it.id)}
                      className="absolute bottom-0.5 right-0.5 z-20 h-[18px] w-[18px] cursor-nwse-resize border-0 bg-transparent p-0 text-[12px] leading-none text-[var(--text-disabled)] transition-colors hover:text-[var(--accent)]"
                    >
                      ⌟
                    </button>
                  </>
                )}
              </div>
            )
          })}
          {!editing && shownTiles.length === 0 && (
            <div className="col-span-full flex min-h-[160px] flex-col items-center justify-center gap-2 text-[12.5px] text-[var(--text-disabled)]">
              <span>看板空空如也</span>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-[8px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                去添加卡片
              </button>
            </div>
          )}
        </div>

        {/* 控件托盘（编辑态）：隐藏的控件躺在这里（真实比例缩略预览），点一下加回原槽位，
            或拖进网格 —— 插入语义（指针在目标中线左/右决定插前/插后），落点卡高亮框 */}
        {editing && (
          <div className={compact ? 'mt-4' : 'mt-5'}>
            <div className="pb-1.5 text-[10.5px] text-[var(--text-muted)]">隐藏的控件 —— 点击加入看板，或直接拖进网格</div>
            <div ref={trayListRef} className="kb-thin-scroll flex gap-2.5 overflow-x-auto border-t border-dashed border-[var(--border-color)] pt-3">
              {hiddenTiles.length === 0 ? (
                <div className="py-1 text-[11.5px] text-[var(--text-disabled)]">所有控件都在看板上了</div>
              ) : hiddenTiles.map((it) => {
                const def = defOf(it.id)!
                return (
                  <button
                    key={it.id}
                    type="button"
                    data-id={it.id}
                    title="点击加入看板，或拖进网格"
                    onPointerDown={(e) => startTrayDrag(e, it.id)}
                    className="flex w-[136px] flex-none cursor-grab touch-none flex-col gap-1 rounded-[8px] border-0 bg-transparent p-1 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <MiniFace
                      def={def}
                      w={it.w}
                      h={it.h}
                      width={120}
                      body={def.group === 'plugin'
                        ? (
                          <span className="mt-1 flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                            <Puzzle size={12} />插件控件
                          </span>
                        )
                        : (
                          <CardBody def={def} snap={snap} compact
                            onMarkDone={markDone} onToggleHabit={toggleHabit} onOpenNote={openNote} onOpenBook={onOpenBook} onJumpSchedule={onJumpSchedule} />
                        )}
                    />
                    <span className="flex items-center gap-1 overflow-hidden whitespace-nowrap text-[11px] text-[var(--text-secondary)]">
                      <span className="h-[7px] w-[7px] flex-none rounded-[2px]" style={{ background: HUE[def.group] }} />
                      <span className="truncate">{def.label}</span>
                      <span className="ml-auto flex-none text-[10px] tabular-nums text-[var(--text-disabled)]">{it.w}×{it.h}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

      </div>
        </div>
      </div>
  )
}
