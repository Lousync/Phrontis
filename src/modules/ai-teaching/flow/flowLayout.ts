/**
 * AI教学「学习流」画布 —— 几何 / 推进顺序纯函数（v2「折行泳道」）。
 *
 * 为什么单独一个文件（口径同 `electron/lib/profilePatch.ts`、`constraintsParse.ts`）：
 * 契约脚本要能 `stripTypeScriptTypes` 之后**直接 import 真实实现执行**，
 * 故本文件**零 import**（连 node 内建都不引），类型一律内联定义 —— 别改成从 `src/types` 引。
 *
 * 口径来自已验收原型 `E:\Projects\KnowledgeRecorder\tmp\aiteach-flow-proto-v2\index.html`
 * 与方案 `E:\Projects\KnowledgeRecorder\.AGENT\.claude\plans\ai-teaching-flow-v2-impl.md`：
 *   · **折行泳道**：每章内部按画布宽度折行，列数由画布宽度**反算**（`colsForWidth`）。
 *     固定阈值（「宽屏就 4 列」）在 1000px 中栏会算出 1196px 的章框 —— 等于没折行。
 *   · **顺序即真相源**：位置一律由「章顺序 + 章内顺序」派生（`layoutLanes`），
 *     不再有自由坐标、不再有 localStorage 坐标持久化（§17 已退役「整理」）。
 *   · **插入位语义 = 阅读顺序（先按行 y、再按列 x）**（§18）。
 *   · 章框 = 由派生坐标反算的矩形（不存坐标），折叠态收缩成一条 62px 高的条。
 *   · 章间主干锚在**章框**底中 → 下一章框顶中（锚卡片的话章一折叠连线就全没了）。
 */

/* ---------------------------------------------------------------- 几何常量 */

/** 卡片宽（容纳「信息两级」：标题+状态 / 要求·素材·产物 / 课时·最近） */
export const NODE_W = 240
/** 卡片高：标题行 17 + 进度条 11 + 两行元信息 34 + 行动按钮 26 + 上下内边距 19 + 边框 2 ≈ 109，取 110 */
export const NODE_H = 110
/** 列间距 */
export const GAP_X = 64
/** 行间距（章内换行） */
export const GAP_Y = 44
/** 章框左右留白 */
export const ZONE_PAD = 22
/** 章框顶部标题条高度 */
export const ZONE_HEAD = 40
/**
 * 章框底部注记带高度（放「N 个知识点 · 连线 = 推进顺序」那条注记）。
 *
 * 为什么不能只用 ZONE_PAD：注记是 `bottom-2`（内缩 8px）+ `text-[10.5px]`（继承 line-height 1.5
 * ⇒ 行盒 15.75px），需要 23.75px；而 ZONE_PAD 只有 22px —— 注记天生比带子高 1.75px，
 * 章内最下排卡片的底边会压进注记行盒，再加卡片边框与拖拽投影就是「字被卡片盖住」。
 * 口径 = 内缩 8 + 行盒 16（10.5 × 1.5 取整）+ 净空 12；改字号 / 内缩必须同步这里，
 * 契约脚本 `.AGENT/scripts/ai-teaching/verify-flow-layout.mjs` 会拦。
 */
export const ZONE_FOOT = 8 + 16 + 12
/** 章与章之间的间距 */
export const ROW_GAP = 54
/** 首列 / 首行的世界坐标原点 */
export const X0 = 44
export const Y0 = 64
/** 世界网格（编辑布局态吸附用；按住 Alt 临时自由） */
export const GRID = 20
/** 折行泳道最多几列（再宽就靠缩放看，不无限横铺） */
export const MAX_COLS = 4
/** 折叠章条 / 空章的最小宽度 */
export const COLLAPSED_MIN_W = 320

/* ---------------------------------------------------------------- 基础类型 */

export interface FlowUnitPos { id: string; x: number; y: number }
export interface FlowChapterShape { id: string; units: readonly FlowUnitPos[] }
/** 只关心「章 → 知识点 id」的最小形状：`AiTeachCourseChapter` 天然满足，`pickActiveChapter` / `wrapOrder` 用它 */
export interface FlowChapterRef { id: string; units: readonly { id: string }[] }
export interface FlowEdge { chapterId: string; fromId: string; toId: string }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }
export interface Viewport { x: number; y: number; k: number }

/** 章框（v2：几何由 `layoutLanes` 一次算出，不再由子节点包围盒反推） */
export interface FlowFrame {
  id: string
  rect: Rect
  closed: boolean
  /** 本章实际用到的列数（= min(cols, 知识点数)） */
  per: number
  /** 章内折行数 */
  rows: number
}

/** 布局结果：章形状（已带派生坐标）/ 章框 / 坐标表 */
export interface FlowLaneResult {
  chapters: FlowChapterShape[]
  frames: FlowFrame[]
  pos: Record<string, Point>
}

/** 状态推进顺序（用于「继续学」与章状态判定） */
export type FlowUnitStatus = 'todo' | 'learning' | 'check' | 'mastered' | 'review'

/* ---------------------------------------------------------------- 数学工具 */

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

/** 网格吸附：把坐标对齐到 GRID 的整数倍 */
export function snapValue(v: number, grid = GRID): number {
  return Math.round(v / grid) * grid
}

/* ---------------------------------------------------------------- 折行泳道 */

/**
 * 折行泳道的列数：**必须由画布宽度反算**。
 *
 * `W=1000` → floor((1000-96+64)/304) = 3 列（章框 892px，落在画布内）；
 * `W=640`  → 2 列（章框 588px）。
 * 用固定阈值（如「宽屏 4 列」）在 1000px 中栏会算出 4×240+3×64+44 = 1196px > 画布 —— 等于没折行，
 * 字号照样掉到 9px 以下（原型冒烟实测过）。
 */
export function colsForWidth(width: number): number {
  const w = Number.isFinite(width) ? width : 0
  return clamp(Math.floor((w - 96 + GAP_X) / (NODE_W + GAP_X)), 1, MAX_COLS)
}

export interface LaneLayoutInput {
  chapters: readonly FlowChapterShape[]
  /** 列数（`colsForWidth(canvasWidth)`） */
  cols: number
  /** 折叠成条的章 */
  closedIds: ReadonlySet<string>
}

/**
 * 折行泳道布局：章自上而下堆叠，章内按列数折行；**坐标全部由顺序派生**。
 *
 * 返回的 `chapters` 里每个知识点的 `x/y` 就是它该在的世界坐标 —— 卡片渲染直接用，
 * 不要再拿它去反算章框（章框已在 `frames` 里，两者口径一致）。
 */
export function layoutLanes(input: LaneLayoutInput): FlowLaneResult {
  const cols = clamp(Math.floor(input.cols) || 1, 1, MAX_COLS)
  const outChapters: FlowChapterShape[] = []
  const frames: FlowFrame[] = []
  const pos: Record<string, Point> = {}
  // 显式跟踪「下一章的框顶」：章框直接按 ROW_GAP 顺次下排，卡片再相对框顶内缩 ZONE_HEAD。
  // （不这么写就会绕成「卡片原点 += …」，章框之间的实际间距被 ZONE_HEAD 吃掉 40px，谁也读不懂。）
  let top = Y0 - ZONE_HEAD
  for (const ch of input.chapters) {
    const n = ch.units.length
    const closed = input.closedIds.has(ch.id) || n === 0
    const per = Math.max(1, Math.min(cols, n || cols))
    const usedCols = n ? Math.min(per, n) : 0
    const contentW = usedCols ? usedCols * NODE_W + (usedCols - 1) * GAP_X : COLLAPSED_MIN_W - ZONE_PAD * 2
    const rows = closed ? 0 : Math.ceil(n / per)
    const contentH = rows ? rows * NODE_H + (rows - 1) * GAP_Y : 0
    // 折叠 / 空章：只留标题条 + 一圈留白（≠ 展开态，展开态底部要留注记带）
    const foot = closed ? ZONE_PAD : ZONE_FOOT
    const rect: Rect = { x: X0 - ZONE_PAD, y: top, w: contentW + ZONE_PAD * 2, h: ZONE_HEAD + contentH + foot }
    frames.push({ id: ch.id, rect, closed, per, rows })
    const units: FlowUnitPos[] = ch.units.map((u, i) => {
      if (closed) return { id: u.id, x: 0, y: 0 }
      const r = Math.floor(i / per)
      const c = i % per
      const p = { x: X0 + c * (NODE_W + GAP_X), y: rect.y + ZONE_HEAD + r * (NODE_H + GAP_Y) }
      pos[u.id] = p
      return { id: u.id, x: p.x, y: p.y }
    })
    outChapters.push({ id: ch.id, units })
    top = rect.y + rect.h + ROW_GAP
  }
  return { chapters: outChapters, frames, pos }
}

/** 章内阅读顺序：**先按行 y、再按列 x**（§18 插入位语义，与 `课程.md` 一维数组一一对应） */
export function sortReadingOrder(units: readonly FlowUnitPos[]): FlowUnitPos[] {
  return [...units].sort((a, b) => (a.y - b.y) || (a.x - b.x))
}

/** 全部卡片在阅读顺序下的一维 id 序列（跨章：章序 × 章内行优先） */
export function wrapOrder(chapters: readonly FlowChapterRef[]): string[] {
  const out: string[] = []
  for (const c of chapters) for (const u of c.units) out.push(u.id)
  return out
}

/* ---------------------------------------------------------------- 落点解析 */

export interface DropResolveInput {
  /** 已提交几何（拖拽中的实时位置**不**参与落点判定） */
  chapters: readonly FlowChapterShape[]
  cols: number
  closedIds: ReadonlySet<string>
  dragId: string
  /** 拖拽卡片中心的世界坐标 */
  cx: number
  cy: number
}

export interface DropResolve {
  chapterId: string
  /** 章内插入序号（对「该章其它卡片」按阅读顺序排完之后的下标） */
  index: number
  beforeUnitId: string | null
  /** 顺序 / 所属章是否真的变了 —— 没变就不写盘 */
  changed: boolean
}

/**
 * 落点解析：目标章 + 章内插入序号（纯函数，可契约化）。
 *
 * 两步：
 *   ① 目标章 = 拖拽卡片**中心**命中的章框；一个都不命中 → 回落源章。
 *   ② 插入序号 = 落点相对目标章内容区左上角的（行, 列）→ `row * per + col`，
 *      夹到 `[0, 其它卡片数]`。**先按行再按列**：这是「阅读顺序」而不是「欧氏最近」。
 */
export function resolveDropIndex(input: DropResolveInput): DropResolve | null {
  const { chapters, cols, closedIds, dragId, cx, cy } = input
  const src = chapters.find((c) => c.units.some((u) => u.id === dragId))
  if (!src) return null
  const lay = layoutLanes({ chapters, cols, closedIds })
  const hit = lay.frames.find((f) => cx > f.rect.x && cx < f.rect.x + f.rect.w && cy > f.rect.y && cy < f.rect.y + f.rect.h)
  const targetId = hit?.id ?? src.id
  const targetFrame = lay.frames.find((f) => f.id === targetId)
  const target = chapters.find((c) => c.id === targetId)
  if (!target) return null
  const per = Math.max(1, Math.min(cols, target.units.filter((u) => u.id !== dragId).length || cols))
  const others = sortReadingOrder(target.units.filter((u) => u.id !== dragId))
  let index = others.length
  if (targetFrame) {
    const relX = cx - (targetFrame.rect.x + ZONE_PAD)
    const relY = cy - (targetFrame.rect.y + ZONE_HEAD)
    const col = clamp(Math.floor((relX + GAP_X / 2) / (NODE_W + GAP_X)), 0, per - 1)
    const row = Math.max(0, Math.floor((relY + GAP_Y / 2) / (NODE_H + GAP_Y)))
    index = clamp(row * per + col, 0, others.length)
  }
  const nextOrder = others.map((u) => u.id)
  nextOrder.splice(index, 0, dragId)
  const changed = targetId !== src.id || nextOrder.join(',') !== src.units.map((u) => u.id).join(',')
  return { chapterId: targetId, index, beforeUnitId: others[index]?.id ?? null, changed }
}

/**
 * 插入位指示条的世界坐标矩形（3px 竖条，落在「松手会插进去」的那个槽位左侧空隙里）。
 *
 * 为什么要有：松手后位置由顺序派生，用户松手前必须看得见「会插到第几位」——
 * 否则拖拽等于盲操作（原生拖放的插入位提示在这里没有等价物）。
 */
export function dropBarRect(
  chapters: readonly FlowChapterShape[],
  frames: readonly FlowFrame[],
  cols: number,
  drop: DropResolve,
): Rect | null {
  const frame = frames.find((f) => f.id === drop.chapterId)
  const target = chapters.find((c) => c.id === drop.chapterId)
  if (!frame || !target) return null
  const per = Math.max(1, Math.min(frame.per || cols, cols))
  const row = Math.floor(drop.index / per)
  const col = drop.index % per
  const contentX0 = frame.rect.x + ZONE_PAD
  const contentY0 = frame.rect.y + ZONE_HEAD
  // 第 0 槽（含空章）没有「前一张卡」可借位：条子贴内容区左缘内侧放，别飘出章框
  const slotX = contentX0 + col * (NODE_W + GAP_X) - GAP_X / 2 - 1.5
  const x = Math.max(contentX0 - GAP_X / 2 + 10, slotX)
  return { x, y: contentY0 + row * (NODE_H + GAP_Y), w: 3, h: NODE_H }
}

/* ---------------------------------------------------------------- 连线 */

/** 章内相邻链（折叠的章不产生连线） */
export function chainEdges(chapters: readonly FlowChapterRef[], closedIds: ReadonlySet<string>): FlowEdge[] {
  const out: FlowEdge[] = []
  for (const c of chapters) {
    if (closedIds.has(c.id)) continue
    for (let i = 0; i < c.units.length - 1; i++) {
      out.push({ chapterId: c.id, fromId: c.units[i].id, toId: c.units[i + 1].id })
    }
  }
  return out
}

export interface SpineEdge { chapterId: string; from: Point; to: Point }

/**
 * 章间主干：上一章框**底边中点** → 下一章框**顶边中点**。
 *
 * 必须锚章框而不是卡片：章折叠时卡片坐标不存在（折叠章不产出 pos），
 * 锚卡片等于「最需要看全局推进的时候连线全没了」。
 */
export function spineEdges(frames: readonly FlowFrame[]): SpineEdge[] {
  const out: SpineEdge[] = []
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1]
    out.push({
      chapterId: a.id,
      from: { x: a.rect.x + a.rect.w / 2, y: a.rect.y + a.rect.h },
      to: { x: b.rect.x + b.rect.w / 2, y: b.rect.y },
    })
  }
  return out
}

/** 前 → 后 的三次贝塞尔（+2 箭头在渲染层加 marker） */
export function edgePath(from: Point, to: Point): string {
  const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2
  const x2 = to.x, y2 = to.y + NODE_H / 2
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.45)
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`
}

/** 竖向贝塞尔（章间主干：章框纵向堆叠，竖线读起来最顺） */
export function spinePath(from: Point, to: Point): string {
  const k = Math.max(26, Math.abs(to.y - from.y) * 0.42)
  return `M${from.x},${from.y} C${from.x},${from.y + k} ${to.x},${to.y - k} ${to.x},${to.y}`
}

/* ---------------------------------------------------------------- 包围盒 */

/** 全部章框的外包矩形（缩略图 / 适应视图用） */
export function bounds(frames: readonly FlowFrame[]): Rect {
  if (!frames.length) return { x: 0, y: 0, w: 800, h: 600 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const f of frames) {
    minX = Math.min(minX, f.rect.x)
    minY = Math.min(minY, f.rect.y)
    maxX = Math.max(maxX, f.rect.x + f.rect.w)
    maxY = Math.max(maxY, f.rect.y + f.rect.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** 世界坐标命中：落点在哪个章框里（自上而下取第一个命中） */
export function frameAt(frames: readonly FlowFrame[], wx: number, wy: number): string | null {
  for (const f of frames) {
    if (wx > f.rect.x && wx < f.rect.x + f.rect.w && wy > f.rect.y && wy < f.rect.y + f.rect.h) return f.id
  }
  return null
}

/* ---------------------------------------------------------------- 拖拽实时几何 */

/**
 * 拖拽中的实时几何：把被拖节点的坐标覆盖进章形状（**渲染专用**）。
 *
 * 为什么必须有这一步：卡片自身由拖拽 state 驱动，而连线 / 缩略图读的是布局派生的坐标，
 * 不覆盖就会出现「卡片在动、虚线不动」。落点判定**不**读这里（`resolveDropIndex` 用已提交几何，
 * 它本来就按 `dragId` 把被拖节点排除在外）。
 *
 * 未拖拽时**原样返回入参**（保持引用不变，避免下游 useMemo 白重算）。
 */
export function applyDragToChapters(
  chapters: readonly FlowChapterShape[],
  dragId: string | null,
  x: number,
  y: number,
): readonly FlowChapterShape[] {
  if (!dragId) return chapters
  return chapters.map((c) =>
    c.units.some((u) => u.id === dragId)
      ? { id: c.id, units: c.units.map((u) => (u.id === dragId ? { id: u.id, x, y } : u)) }
      : c,
  )
}

/* ---------------------------------------------------------------- 当前章 / 继续学 */

export type FlowProgressMap = Record<string, { status: FlowUnitStatus; mastery?: number } | undefined>

/**
 * 当前章（§19）：**记忆优先**（上次停留的章，且该章仍在大纲里）→ 有 `learning` 知识点的章
 * → 第一个还有未掌握知识点的章 → 第一章。
 */
export function pickActiveChapter(
  chapters: readonly FlowChapterRef[],
  progress: FlowProgressMap,
  rememberedId?: string | null,
): string | null {
  if (!chapters.length) return null
  if (rememberedId && chapters.some((c) => c.id === rememberedId)) return rememberedId
  for (const c of chapters) {
    if (c.units.some((u) => progress[u.id]?.status === 'learning')) return c.id
  }
  for (const c of chapters) {
    if (c.units.some((u) => (progress[u.id]?.status ?? 'todo') !== 'mastered')) return c.id
  }
  return chapters[0].id
}

/**
 * 「继续学」目标（§20）：**接着上次那节课**；无记忆 → 当前章第一个未掌握；再退到全课第一个未掌握。
 * 传入的 `lastUnitId` 若已掌握 / 已不在大纲，忽略。
 */
export function pickNextUnit(
  chapters: readonly FlowChapterRef[],
  progress: FlowProgressMap,
  activeChapterId: string | null,
  lastUnitId?: string | null,
): string | null {
  const all = chapters.flatMap((c) => c.units.map((u) => u.id))
  if (!all.length) return null
  if (lastUnitId && all.includes(lastUnitId) && (progress[lastUnitId]?.status ?? 'todo') !== 'mastered') return lastUnitId
  const cur = chapters.find((c) => c.id === activeChapterId)
  const inCur = cur?.units.find((u) => (progress[u.id]?.status ?? 'todo') !== 'mastered')
  if (inCur) return inCur.id
  return all.find((id) => (progress[id]?.status ?? 'todo') !== 'mastered') ?? null
}

/* ---------------------------------------------------------------- 视线 */

/** 屏幕坐标 → 世界坐标 */
export function screenToWorld(clientX: number, clientY: number, rectLeft: number, rectTop: number, view: Viewport): Point {
  return { x: (clientX - rectLeft - view.x) / view.k, y: (clientY - rectTop - view.y) / view.k }
}

/** 适应视图：让 `b` 完整落进 `cw × ch`（含 PAD），返回新的 viewport */
export function fitViewport(b: Rect, cw: number, ch: number, pad: number, minK = 0.18, maxK = 1.1): Viewport {
  const k = Math.max(minK, Math.min((cw - pad * 2) / b.w, (ch - pad * 2) / b.h, maxK))
  return { k, x: (cw - b.w * k) / 2 - b.x * k, y: (ch - b.h * k) / 2 - b.y * k }
}

/* ---------------------------------------------------------------- 作用域 */

/** 作用域层级（画布画前三层；课时不画，见方案 §九 L0/R6） */
export type ScopeLevel = 'global' | 'workspace' | 'chapter' | 'unit'
export interface FlowScope {
  level: ScopeLevel
  chapterId?: string
  unitId?: string
}
