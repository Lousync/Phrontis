/**
 * 桌面外壳（自定义磁贴工作台）
 *
 * 与 Tab 外壳并存：它就是一个普通模块（TabName = 'desktop'），点磁贴等价于点活动栏图标，
 * 因此完全复用 App 现有的 `handleTabChange` / `mountedTabs` 保活机制，不动外壳架构。
 *
 * 三条硬约束（都踩过或已由铁律钉住）：
 *  1. 模块根节点必须是 `h-full`（铁律 11）：槽位容器是块级 div，`flex-1` 在其中不生效，
 *     根节点会随内容长高 → 内层 `overflow-y-auto` 拿不到可滚高度 → 「界面能显示但滚轮没反应」。
 *  2. 桌面控件 key 带 `content:` / `module:` 前缀，永不与 `TabName` 撞名（原型阶段的坑）。
 *  3. 编辑态的类挂在**桌面根节点**上，不挂在栅格上 —— 中心主题是栅格的兄弟节点，
 *     挂错层会让 `.xxx-editing .hero` 这类选择器静默失效（原型阶段实测）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { TabName, KnowledgePage } from '../../types'
import { LayoutGrid, Plus, RefreshCw, Check, ChevronDown, X, GripVertical, Search } from 'lucide-react'
import { useSettings } from '../../lib/SettingsContext'
import { useDataChanged } from '../../lib/dataChanged'
import { searchKnowledgePages } from '../../lib/ipc'
import {
  parsePresets, clonePresets, newPresetId, newTileId, swapTiles, nextSize,
  clampW, clampH, columnsFor, CELL_UNIT, CELL_GAP,
  type DesktopPreset, type TileLayout,
} from './layout'
import { defOf, isKnownKey, ALL_TILES, DESK_MODULES, type TileCtx, type TileDef } from './tiles'
import { useDesktopData, useDerived } from './useDesktopData'

interface Props {
  /** 桌面是否当前可见（保活层切走时仍挂载，用于跳过无谓的重算） */
  isActive?: boolean
  /** 打开某个模块 —— 由 App 传入，复用既有 Tab 切换（含侧栏等既有行为） */
  onOpenModule: (tab: TabName) => void
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/* ==================== 磁贴脸面 / 缩略图 ==================== */

/**
 * 磁贴的「脸」= 头部（图标 / 名称 / 尾注）+ 内容。
 * 栅格里的磁贴和添加面板里的缩略图共用这一份 —— 面板缩略图要回答的正是
 * 「加进去长什么样」，另写一份示意版的话，控件改了样子面板还停在旧图，比不做预览更误导。
 */
function TileFace({ def, ctx, w, h, onActivate }: {
  def: TileDef
  ctx: TileCtx
  w: number
  h: number
  /** 有值才可点：栅格给（模块入口点进模块），缩略图不给（它只是展示件） */
  onActivate?: () => void
}): ReactNode {
  const c: TileCtx = { ...ctx, w, h }
  return (
    <>
      <div className="desk-tile-head">
        <span className="desk-tile-ico">{def.icon(15)}</span>
        <span className="desk-tile-name">{def.label}</span>
        {def.tail && <span className="desk-tile-tail">{def.tail(c)}</span>}
      </div>
      <div className="desk-tile-body" onClick={onActivate}>{def.render(c)}</div>
    </>
  )
}

/** 缩略图盒子的**内边距盒**尺寸。必须与 `.desk-pick-thumb`（含 1px 边框）减完对得上：
 *  按外形尺寸 150 / 58 算缩放，会多出 2px 被 `overflow:hidden` 裁掉一条边。 */
const THUMB_BOX = { w: 148, h: 108, small: 56 } as const

/**
 * 缩略图：把控件**真身**按默认尺寸渲染一次，再等比缩放塞进固定盒子。
 * 尺寸用的是真机同一套格子常量（CELL_UNIT / CELL_GAP），所以面板里看到的
 * 宽高比例就是它落到栅格上的比例。
 */
function TileThumb({ def, ctx, small }: { def: TileDef; ctx: TileCtx; small?: boolean }): ReactNode {
  const boxW = small ? THUMB_BOX.small : THUMB_BOX.w
  const boxH = small ? THUMB_BOX.small : THUMB_BOX.h
  const tw = def.defaultW * CELL_UNIT + (def.defaultW - 1) * CELL_GAP
  const th = def.defaultH * CELL_UNIT + (def.defaultH - 1) * CELL_GAP
  // 模块入口都是 1×1，小盒子反而比真身大 → 封顶 1，放大只会糊
  const s = Math.min(boxW / tw, boxH / th, small ? 1 : Number.POSITIVE_INFINITY)
  return (
    // aria-hidden：缩略图内部是磁贴真身（自带 button / 大量文本），对辅助技术只暴露外层条目即可
    <div className={`desk-pick-thumb${small ? ' is-small' : ''}`} aria-hidden="true">
      <div
        className="desk-pick-inner"
        style={{ width: tw, height: th, transform: `scale(${s})`, left: (boxW - tw * s) / 2, top: (boxH - th * s) / 2 }}
      >
        <div className={`desk-tile${def.kind === 'module' ? ' is-jump' : ''}`}>
          <TileFace def={def} ctx={ctx} w={def.defaultW} h={def.defaultH} />
        </div>
      </div>
    </div>
  )
}

/* ==================== hero 大时间 ==================== */

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * hero 正中那块大时间（原「今日主题语」的位置，2026-09-15 改）。
 *
 * 它自己持有 1 秒一跳的 interval，**不把时间放进 DesktopModule 的 state** ——
 * 否则每秒都会连锁重渲染整个桌面（13 个模块图标 + 全部磁贴 + 搜索框），
 * 而搜索框就在 hero 里，那种重渲染是纯浪费。这样父组件一次都不会因为走秒而重渲染。
 * （顺带：改前是父组件持 20s 的 clock，整块桌面每 20s 白重渲染一次，现在也没了。）
 */
function HeroClock(): ReactNode {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <>
      <div className="desk-hero-date">
        {now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日 · {WEEK[now.getDay()]}
      </div>
      <div className="desk-hero-clock">
        {pad2(now.getHours())}:{pad2(now.getMinutes())}:{pad2(now.getSeconds())}
      </div>
    </>
  )
}

export function DesktopModule({ isActive, onOpenModule }: Props) {
  const { s, update, ready } = useSettings()
  const data = useDesktopData()
  const stats = useDerived(data)

  /* ---------------- 预设（全局，存 settings） ---------------- */

  const presets = useMemo<DesktopPreset[]>(() => parsePresets(s.desktopPresets), [s.desktopPresets])
  const activeId = useMemo(() => {
    const want = String(s.desktopActivePreset ?? '')
    return presets.some((p) => p.id === want) ? want : presets[0].id
  }, [s.desktopActivePreset, presets])
  const preset = useMemo(() => presets.find((p) => p.id === activeId) ?? presets[0], [presets, activeId])

  /** 写回预设：settings 是唯一真相源，组件内不留副本（两份状态必然漂移） */
  const commit = useCallback((next: DesktopPreset[]): void => {
    update('desktopPresets', JSON.stringify(next))
  }, [update])

  const patchPreset = useCallback((mutate: (p: DesktopPreset) => DesktopPreset): void => {
    commit(presets.map((p) => (p.id === preset.id ? mutate(clonePresets(p)) : p)))
  }, [commit, presets, preset.id])

  /** 首次进入：settings 里还没有布局 → 种下默认三套（只做一次，之后完全尊重用户） */
  const seeded = useRef(false)
  useEffect(() => {
    if (!ready || seeded.current) return
    if (!String(s.desktopPresets ?? '')) {
      seeded.current = true
      update('desktopPresets', JSON.stringify(clonePresets(parsePresets(null))))
      update('desktopActivePreset', 'study')
    }
  }, [ready, s.desktopPresets, update])

  /* ---------------- 顶部搜索 ---------------- */

  // 与标题栏那个全局搜索（Ctrl+P）同一个后端：searchKnowledgePages = 仓库全文搜索。
  // 这里只做「桌面自带的入口」：给最相关的几条，点开即走，不复刻结果分组。
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<KnowledgePage[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<number | null>(null)

  useEffect(() => {
    const word = q.trim()
    if (!word) { setHits([]); setSearching(false); return }
    setSearching(true)
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(() => {
      searchKnowledgePages(word)
        .then((r) => { setHits(Array.isArray(r) ? r.slice(0, 8) : []); setSearching(false) })
        .catch(() => { setHits([]); setSearching(false) })
    }, 220)
    return () => { if (searchTimer.current) window.clearTimeout(searchTimer.current) }
  }, [q])

  /** 打开一条结果：有仓库相对路径 → 编辑器看真身；否则跳知识库按 id 打开（同「最近文档」通道） */
  const openHit = useCallback((p: KnowledgePage): void => {
    setQ('')
    if (p.path) {
      window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: p.path, from: 'desktop' } }))
      return
    }
    onOpenModule('knowledge')
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('kb-open-knowledge-page', { detail: { pageId: p.id } })), 100)
  }, [onOpenModule])

  /**
   * 「新建」= 去编辑器里建页，不在桌面就地弹输入框。
   * 读写分工铁律：知识库/桌面都只是**入口**，建页的写入动作只发生在编辑器。
   * 直接复用知识库 Ctrl+N 的同一条通道（先切 Tab、再触发内联命名行），不另造一套跳转逻辑；
   * 180ms 是留给编辑器 Tab 挂载 + 注册 `kb-editor-new-page` 监听的余量（与 Ctrl+N 同值）。
   */
  const onNewPage = useCallback((): void => {
    window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { from: 'desktop' } }))
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('kb-editor-new-page')), 180)
  }, [])

  /* ---------------- 编辑态 ---------------- */

  const [editing, setEditing] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)

  /* ---------------- 栅格尺寸 ---------------- */

  const gridRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(6)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = (): void => { setCols(columnsFor(el.clientWidth)) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 保活层切走时容器宽度为 0、ResizeObserver 不触发；切回来必须重算一次
  useEffect(() => { if (isActive) { const el = gridRef.current; if (el) setCols(columnsFor(el.clientWidth)) } }, [isActive])

  /* ---------------- 拖拽换位 / 拖角改尺寸 ---------------- */
  // 走 pointer events 而非 HTML5 拖放：格内自由移动用 HTML5 拖放会静默失败（铁律 9）。
  // 指针捕获挂在被操作的元素上，松开前的事件都归它，不会漏到别的格子。
  //
  // 手感（iPad 编辑桌面参考；原型 `outputs/desk-edit-feel-prototype.html` 已拍板）：
  //   抬起 = 放大 + 大投影   （不再靠降透明度 —— 那读起来像「被删掉」，不是「被拿起」）
  //   让位 = 拖动中把命中的那块用 transform 挪进你腾出的格子（真正落库仍等松手）
  //   落位 = 松手从跟手位置滑回格位（FLIP），不再瞬间跳
  //
  // 两条硬约束（原型阶段实测出来，别当「实现细节」顺手优化掉）：
  //   ① 拖动块不能改成 position:fixed —— 一旦脱离栅格流，其它磁贴会立刻左移把这个洞填掉，
  //      「留个空位等让位」的前提就没了。留在流里、只改 transform，洞才留得住。
  //   ② 让位不能靠拖动中真重排 DOM —— 栅格是 grid-auto-flow: row dense，任何重排都会被
  //      回填到最早的那个洞（恰好就是被拖块腾出的原位），渲染出来等于没动。
  //      transform 不参与布局，才躲得开。

  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** 换位目标（权威副本）：pointerup 可能与最后一次 pointermove 同帧到达，
   *  只读 state 会拿到上一帧的旧值（「拖了半天没换位」就是这个原因） */
  const overIdRef = useRef<string | null>(null)
  /** 拖动中「被让位的那块」：只走 ref + 直接写 style，避免每次 move 都触发 React 渲染 */
  const previewElRef = useRef<HTMLElement | null>(null)
  /** 抬起瞬间的布局快照（各磁贴**未位移**的矩形，坐标相对栅格左上角）。
   *  命中判定必须用它，不能用 elementFromPoint：拖动块抬了 z-index 会盖住指针，
   *  而被让位的那块自己也被 translate 走了，transform 会带着命中区一起走
   *  —— 拿会动的元素判命中会来回抖（移位 → 失配 → 弹回 → 又命中）。
   *  存相对坐标，是为了拖动中滚动栅格后仍然对得上。 */
  const hitSnapRef = useRef<{ id: string; el: HTMLElement; l: number; t: number; r: number; b: number }[]>([])

  const dragRef = useRef<{ id: string; x: number; y: number; tx: number; ty: number; moved: boolean; el: HTMLElement; originRect: DOMRect | null } | null>(null)
  const resizeRef = useRef<{ id: string; x: number; y: number; moved: boolean; w0: number; h0: number } | null>(null)
  /** 拖动中的尺寸预览：只进 ref、不入 settings，松手才落盘（避免拖动时每帧写设置） */
  const sizePreview = useRef<{ w: number; h: number } | null>(null)
  const [, bumpPreview] = useState(0)

  /** 刚拖过一次尺寸 → 抑制紧随其后的 click。
   *  pointer 手势结束浏览器会补发 click，不拦的话「拖大」会立刻又被当成「单击换档」。 */
  const suppressSizeClick = useRef(false)

  /** 抬起倍数：给「拿起来」的体积感 */
  const LIFT_SCALE = 1.06
  /** 让位 / 落位用的缓动。尊重系统「减少动态效果」：时长归零（位移照做，只是不再滑过去） */
  const shiftEase = (ms: number): string =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'none'
      : `transform ${ms}ms cubic-bezier(.2, .9, .3, 1)`

  /** 抬起：量一份「谁在哪」的快照。必须在给任何块加 transform 之前取。 */
  const captureHitSnapshot = (grid: HTMLElement, skipId: string): void => {
    const g = grid.getBoundingClientRect()
    const list: typeof hitSnapRef.current = []
    for (const child of Array.from(grid.children)) {
      const el = child as HTMLElement
      const id = el.dataset.deskId
      if (!id || id === skipId) continue
      const r = el.getBoundingClientRect()
      list.push({ id, el, l: r.left - g.left, t: r.top - g.top, r: r.right - g.left, b: r.bottom - g.top })
    }
    hitSnapRef.current = list
  }

  /** 命中：指针落在哪块磁贴（按抬起瞬间的布局算，不受拖动中的视觉位移影响） */
  const hitTest = (px: number, py: number): { id: string; el: HTMLElement } | null => {
    const grid = gridRef.current
    if (!grid) return null
    const g = grid.getBoundingClientRect()
    const x = px - g.left
    const y = py - g.top
    for (const s of hitSnapRef.current) {
      if (x >= s.l && x < s.r && y >= s.t && y < s.b) return { id: s.id, el: s.el }
    }
    return null
  }

  /** 让位预告：把命中的那块用 transform 挪到被拖块腾出的格子上（不动 DOM，见硬约束 ②）。
   *  注意**先清干净再量** —— 否则量到的是上一轮预告之后的 rect，偏移会累加。 */
  const previewShift = (target: HTMLElement | null, originRect: DOMRect | null): void => {
    const prev = previewElRef.current
    if (prev === target) return
    if (prev) { prev.style.transition = shiftEase(170); prev.style.transform = '' }
    previewElRef.current = target
    if (!target || !originRect) return
    target.style.transition = 'none'
    target.style.transform = ''
    const r = target.getBoundingClientRect()
    const dx = originRect.left - r.left
    const dy = originRect.top - r.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    void target.offsetHeight
    target.style.transition = shiftEase(170)
    target.style.transform = `translate(${dx}px, ${dy}px)`
  }
  const onTilePointerDown = (e: React.PointerEvent, tile: TileLayout): void => {
    if (!editing) return
    const target = e.target as HTMLElement
    if (target.closest('[data-desk-resize]') || target.closest('[data-desk-del]')) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture?.(e.pointerId)
    dragRef.current = { id: tile.id, x: e.clientX, y: e.clientY, tx: 0, ty: 0, moved: false, el, originRect: null }
  }

  const onTilePointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 5) return
      d.moved = true
      // 顺序不能反：originRect 与命中快照都必须是「还没加 transform」时的几何
      d.originRect = d.el.getBoundingClientRect()
      const grid = gridRef.current
      if (grid) captureHitSnapshot(grid, d.id)
      // 跟手必须先关掉过渡：`.is-dragging` 那份 `transition: none` 要等 React 渲染才生效，
      // 而下面写 transform 是同步的 —— 不在这里先关，第一次移动会被 `.desk-tile` 的
      // transform 过渡拖成「果冻延迟」。
      d.el.style.transition = 'none'
      setDraggingId(d.id)
    }
    d.tx = dx
    d.ty = dy
    d.el.style.transform = `translate(${dx}px, ${dy}px) scale(${LIFT_SCALE})`
    const hit = hitTest(e.clientX, e.clientY)
    overIdRef.current = hit?.id ?? null
    previewShift(hit?.el ?? null, d.originRect)
  }

  const onTilePointerUp = (): void => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    const el = d.el
    const preview = previewElRef.current
    previewElRef.current = null
    const target = overIdRef.current
    overIdRef.current = null
    setDraggingId(null)

    if (!d.moved) { el.style.transform = ''; return }

    // 1) 先落数据。用 flushSync 是因为下面要量「终态位置」，DOM 必须已经重排完
    const swapped = !!target && target !== d.id
    if (swapped) {
      flushSync(() => { patchPreset((p) => ({ ...p, tiles: swapTiles(p.tiles, d.id, target) })) })
    }

    // 2) 摘掉抬起态与内联位移，量出落点（同一帧内完成，视觉上不会闪）
    el.classList.remove('is-dragging')
    el.style.transition = 'none'
    el.style.transform = ''
    void el.offsetHeight
    // 被让位的那块：
    //   换过位 → 它的新格位**就是**它现在的视觉位置（两者都是被拖块腾出的那格），
    //            所以必须**瞬时**清掉位移；带过渡反而会从错位处滑回来（计算属性变了、布局也变了）。
    //   没换位 → 格位没变，带过渡正好是从腾出的位置滑回自己家。
    if (preview) {
      preview.style.transition = swapped ? 'none' : shiftEase(170)
      preview.style.transform = ''
    }

    // 3) FLIP：从「松手时的视觉位置」滑回格位。
    //    起点必须用 originRect + 当前位移 —— 只拿 originRect 会让磁贴先瞬移回原位再滑，
    //    看起来就是「松手回跳」（scale 带来的半格偏移在两端一致，正好抵消）。
    const origin = d.originRect
    const after = origin ? el.getBoundingClientRect() : null
    const mx = origin && after ? origin.left + d.tx - after.left : 0
    const my = origin && after ? origin.top + d.ty - after.top : 0
    if (origin && after && (Math.abs(mx) > 0.5 || Math.abs(my) > 0.5)) {
      el.style.transform = `translate(${mx}px, ${my}px) scale(${LIFT_SCALE})`
      void el.offsetHeight
      el.style.transition = shiftEase(200)
      el.style.transform = 'translate(0px, 0px) scale(1)'
      window.setTimeout(() => { el.style.transition = ''; el.style.transform = '' }, 260)
    } else {
      el.style.transition = ''
    }
    if (preview) window.setTimeout(() => { preview.style.transition = '' }, 260)
  }

  const onSizePointerDown = (e: React.PointerEvent, tile: TileLayout): void => {
    if (!editing) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    resizeRef.current = { id: tile.id, x: e.clientX, y: e.clientY, moved: false, w0: tile.w, h0: tile.h }
  }

  const onSizePointerMove = (e: React.PointerEvent): void => {
    const r = resizeRef.current
    if (!r) return
    const dx = e.clientX - r.x
    const dy = e.clientY - r.y
    if (!r.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    r.moved = true
    // 必须从**按下时的基准尺寸**推，不能累加预览值（累加会指数放大）
    const step = CELL_UNIT + CELL_GAP
    const w = clampW(r.w0 + dx / step)
    const h = clampH(r.h0 + dy / step)
    if (sizePreview.current && sizePreview.current.w === w && sizePreview.current.h === h) return
    sizePreview.current = { w, h }
    bumpPreview((n) => n + 1)
  }

  const onSizePointerUp = (): void => {
    const r = resizeRef.current
    const pv = sizePreview.current
    resizeRef.current = null
    sizePreview.current = null
    if (!r) return
    suppressSizeClick.current = r.moved
    if (r.moved && pv) {
      patchPreset((p) => ({ ...p, tiles: p.tiles.map((t) => (t.id === r.id ? { ...t, w: pv.w, h: pv.h } : t)) }))
    }
  }

  /** 单击尺寸标签 = 按档轮换（与拖动改尺寸共用同一个按钮） */
  const onSizeClick = (tile: TileLayout): void => {
    if (suppressSizeClick.current) { suppressSizeClick.current = false; return }
    cycleTileSize(tile)
  }

  /* ---------------- 控件增删 ---------------- */

  const usedKeys = useMemo(() => new Set(preset.tiles.map((t) => t.key)), [preset.tiles])
  const addable = useMemo(() => ALL_TILES.filter((t) => !usedKeys.has(t.key)), [usedKeys])
  /** 面板分两组：「内容控件」磁贴里直接显示内容、「模块入口」点一下进模块（分组标题按组非空才显示） */
  const addableContent = useMemo(() => addable.filter((t) => t.kind === 'content'), [addable])
  const addableModule = useMemo(() => addable.filter((t) => t.kind === 'module'), [addable])

  const addTile = (key: string): void => {
    const d = defOf(key)
    patchPreset((p) => ({ ...p, tiles: [...p.tiles, { id: newTileId(), key, w: d.defaultW, h: d.defaultH }] }))
    setAddOpen(false)
  }

  /** 面板条目是 `role="button"` 的 div（见下方注释），Enter / 空格要自己补上点击语义 */
  const onPickKey = (e: ReactKeyboardEvent, key: string): void => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addTile(key) }
  }
  const removeTile = (id: string): void => {
    patchPreset((p) => ({ ...p, tiles: p.tiles.filter((t) => t.id !== id) }))
  }
  const cycleTileSize = (tile: TileLayout): void => {
    const [w, h] = nextSize(tile.w, tile.h)
    patchPreset((p) => ({ ...p, tiles: p.tiles.map((t) => (t.id === tile.id ? { ...t, w, h } : t)) }))
  }

  /** 清掉预设里已经不存在的控件（版本升级删过控件时会留下死格子） */
  const staleCount = useMemo(() => preset.tiles.filter((t) => !isKnownKey(t.key)).length, [preset.tiles])
  const cleanStale = (): void => {
    patchPreset((p) => ({ ...p, tiles: p.tiles.filter((t) => isKnownKey(t.key)) }))
  }

  /* ---------------- 预设操作 ---------------- */

  const switchPreset = (id: string): void => { update('desktopActivePreset', id); setPresetOpen(false) }
  const duplicatePreset = (): void => {
    const copy: DesktopPreset = { ...clonePresets(preset), id: newPresetId(), name: `${preset.name} 副本` }
    commit([...presets, copy])
    update('desktopActivePreset', copy.id)
  }
  const renamePreset = (): void => {
    const name = window.prompt('重命名桌面预设', preset.name)
    if (!name) return
    commit(presets.map((p) => (p.id === preset.id ? { ...p, name } : p)))
  }
  const addPreset = (): void => {
    const name = window.prompt('新桌面预设名称', '新桌面')
    if (!name) return
    const p: DesktopPreset = { id: newPresetId(), name, tiles: [] }
    commit([...presets, p])
    update('desktopActivePreset', p.id)
  }
  const deletePreset = (): void => {
    if (presets.length <= 1) return
    const rest = presets.filter((p) => p.id !== preset.id)
    commit(rest)
    update('desktopActivePreset', rest[0].id)
  }

  /* ---------------- 数据变更时给「外部变更」留个回声 ---------------- */

  useDataChanged('settings', () => { /* theme 等设置变更由 useSettings 自行推送 */ })

  const ctx: TileCtx = { w: 1, h: 1, data, stats, onOpen: onOpenModule }

  if (!ready) return <div className="h-full" />

  return (
    <div className={`desk h-full flex flex-col${editing ? ' is-editing' : ''}`}>
      {/* 顶栏：刷新（保底）+ 编辑桌面 + 预设 */}
      <div className="desk-bar">
        <div className="desk-bar-right">
          <button className="desk-tool" onClick={() => data.refresh()} title="重新读取数据">
            <RefreshCw size={14} />
          </button>
          <div className="desk-preset-wrap">
            <button className="desk-tool desk-tool-wide" onClick={() => setPresetOpen((v) => !v)}>
              {preset.name}
              <ChevronDown size={13} className={`desk-chev${presetOpen ? ' is-open' : ''}`} />
            </button>
            {presetOpen && (
              <div className="desk-menu kb-pop" onMouseLeave={() => setPresetOpen(false)}>
                {presets.map((p) => (
                  <button key={p.id} className="desk-menu-item" onClick={() => switchPreset(p.id)}>
                    <span className="desk-menu-tick">{p.id === preset.id && <Check size={12} />}</span>
                    {p.name}
                  </button>
                ))}
                <div className="desk-menu-sep" />
                <button className="desk-menu-item" onClick={addPreset}><span className="desk-menu-tick" />新建预设…</button>
                <button className="desk-menu-item" onClick={duplicatePreset}><span className="desk-menu-tick" />复制当前预设</button>
                <button className="desk-menu-item" onClick={renamePreset}><span className="desk-menu-tick" />重命名…</button>
                <button className="desk-menu-item" onClick={deletePreset} disabled={presets.length <= 1}><span className="desk-menu-tick" />删除当前预设</button>
              </div>
            )}
          </div>
          <button
            className={`desk-tool desk-tool-wide${editing ? ' is-on' : ''}`}
            onClick={() => setEditing((v) => !v)}
            title="编辑桌面布局（Esc 退出）"
          >
            {editing ? <Check size={14} /> : <LayoutGrid size={14} />}
            {editing ? '完成' : '编辑桌面'}
          </button>
        </div>
      </div>

      {/* 中心：一行小日期 + 大时钟。原「今日主题语」可编辑标题已删（2026-09-15 拍板，settings 键 desktopTopic 一并移除）。 */}
      <div className="desk-hero">
        <HeroClock />

        {/* 搜索 + 新建。「新建」走知识库：按既定边界，凡产生新文件的动作都不在桌面就地做 */}
        <div className="desk-hero-tools">
          <div className="desk-search">
            <Search size={15} className="desk-search-ico" />
            <input
              className="desk-search-in"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setQ('') }
                else if (e.key === 'Enter' && hits[0]) openHit(hits[0])
              }}
              placeholder="搜索页面 / 目录 / 标签…"
            />
            {q.trim() !== '' && (
              <div className="desk-search-pop kb-pop">
                {hits.length === 0 ? (
                  <div className="desk-search-none">{searching ? '搜索中…' : '没有匹配的页面'}</div>
                ) : hits.map((p) => (
                  <button key={p.id} className="desk-search-row" onClick={() => openHit(p)} title={p.path ?? p.title}>
                    <span className="desk-search-txt">{p.title || '(未命名)'}</span>
                    {p.excerpt !== undefined && p.excerpt !== '' && (
                      <span className="desk-search-exc">{p.excerpt.slice(0, 40)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="desk-newbtn" onClick={onNewPage} title="新建知识页（在编辑器中）">
            <Plus size={15} />新建
          </button>
        </div>

        {/* 图标快捷行：常驻模块入口（与左侧活动栏同源；桌面形态下不必再回到最左边） */}
        <div className="desk-dock">
          {DESK_MODULES.map((m) => (
            <button key={m.tab} className="desk-dock-btn" title={m.label} onClick={() => onOpenModule(m.tab)}>
              {m.icon(18)}
            </button>
          ))}
        </div>
      </div>

      {/* 栅格 */}
      <div className="desk-scroll">
        <div
          ref={gridRef}
          className="desk-grid"
          style={{ ['--desk-cols' as string]: String(cols) }}
          onPointerMove={onTilePointerMove}
          onPointerUp={onTilePointerUp}
          onPointerCancel={onTilePointerUp}
        >
          {preset.tiles.map((tile) => {
            const d = defOf(tile.key)
            const pv = resizeRef.current?.id === tile.id ? sizePreview.current : null
            const w = pv?.w ?? tile.w
            const h = pv?.h ?? tile.h
            return (
              <div
                key={tile.id}
                data-desk-id={tile.id}
                className={`desk-tile${draggingId === tile.id ? ' is-dragging' : ''}${d.kind === 'module' ? ' is-jump' : ''}`}
                style={{ gridColumn: `span ${w}`, gridRow: `span ${h}` }}
                onPointerDown={(e) => onTilePointerDown(e, tile)}
              >
                <TileFace
                  def={d}
                  ctx={ctx}
                  w={w}
                  h={h}
                  onActivate={() => { if (d.kind === 'module' && !editing) onOpenModule(d.key.slice(7) as TabName) }}
                />
                {editing && (
                  <>
                    <button className="desk-del" data-desk-del title="移除控件" onClick={() => removeTile(tile.id)}>
                      <X size={11} />
                    </button>
                    <button
                      className="desk-size"
                      data-desk-resize
                      title="拖动改尺寸（单击按档轮换）"
                      onPointerDown={(e) => onSizePointerDown(e, tile)}
                      onPointerMove={onSizePointerMove}
                      onPointerUp={onSizePointerUp}
                      onPointerCancel={onSizePointerUp}
                      onClick={() => onSizeClick(tile)}
                    >
                      <span className="desk-size-lbl">{w}×{h}</span>
                      <GripVertical size={10} />
                    </button>
                  </>
                )}
              </div>
            )
          })}

          {editing && (
            <button className="desk-tile desk-add" onClick={() => setAddOpen(true)}>
              <Plus size={18} />
              <span>添加控件</span>
            </button>
          )}
        </div>

        {/* 编辑态提示条 */}
        {editing && (
          <div className="desk-hint-bar">
            <span>拖动磁贴换位 · 拖右下角改尺寸 · 点 × 移除</span>
            {staleCount > 0 && (
              <button className="desk-hint-btn" onClick={cleanStale}>清理 {staleCount} 个失效控件</button>
            )}
          </div>
        )}

        {!editing && preset.tiles.length === 0 && (
          <div className="desk-blank">
            <p>这块桌面还是空的</p>
            <button className="desk-blank-btn" onClick={() => setEditing(true)}>编辑桌面，添加控件</button>
          </div>
        )}
      </div>

      {/* 添加控件面板 */}
      {addOpen && (
        <div className="desk-overlay kb-overlay" onClick={() => setAddOpen(false)}>
          <div className="desk-panel" onClick={(e) => e.stopPropagation()}>
            <div className="desk-panel-head">
              添加控件
              <button className="desk-panel-x" onClick={() => setAddOpen(false)}><X size={13} /></button>
            </div>
            {addable.length === 0 ? (
              <div className="desk-panel-empty">全部控件都已在这套预设里</div>
            ) : (
              <div className="desk-panel-list">
                {/*
                 * 条目**不能**用 <button>：缩略图里渲染的是磁贴真身，真身自带 <button>
                 * （勾待办 / 翻月 / 目录项），按钮套按钮是非法结构。
                 * 故用 role="button" + 自己补 Enter / 空格（onPickKey），并给缩略图挂 aria-hidden。
                 * 面板只列「还没加进这套预设」的控件，所以不存在「已添加」置灰态 —— 点一条即关闭。
                 */}
                {addableContent.length > 0 && (
                  <>
                    <div className="desk-pick-group">内容控件 · 磁贴里直接显示内容</div>
                    {addableContent.map((t) => (
                      <div
                        key={t.key}
                        className="desk-panel-item desk-pick-item"
                        role="button"
                        tabIndex={0}
                        title={`添加「${t.label}」`}
                        onClick={() => addTile(t.key)}
                        onKeyDown={(e) => onPickKey(e, t.key)}
                      >
                        <TileThumb def={t} ctx={ctx} />
                        <div className="desk-pick-main">
                          <div className="desk-pick-line">
                            <span className="desk-pick-name">{t.label}</span>
                            <span className="desk-pick-size">{t.defaultW}×{t.defaultH}</span>
                            <span className="desk-pick-add">＋ 添加</span>
                          </div>
                          {t.was && <div className="desk-pick-was">原「{t.was}」</div>}
                          <div className="desk-pick-desc">{t.desc}</div>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {addableModule.length > 0 && (
                  <>
                    <div className="desk-pick-group">模块入口 · 点一下进入该模块</div>
                    <div className="desk-pick-grid">
                      {addableModule.map((t) => (
                        <div
                          key={t.key}
                          className="desk-pick-cell"
                          role="button"
                          tabIndex={0}
                          title={`添加「${t.label}」`}
                          onClick={() => addTile(t.key)}
                          onKeyDown={(e) => onPickKey(e, t.key)}
                        >
                          <TileThumb def={t} ctx={ctx} small />
                          <div className="desk-pick-cell-txt">
                            <div className="desk-pick-line">
                              <span className="n">{t.label}</span>
                              <span className="desk-pick-size">{t.defaultW}×{t.defaultH}</span>
                            </div>
                            <div className="d">{t.desc}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default DesktopModule
