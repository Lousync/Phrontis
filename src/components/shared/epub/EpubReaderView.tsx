import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowLeft, Bookmark, BookmarkPlus, ChevronLeft, ChevronRight, Contrast, Loader2, Maximize2, Minimize2, MousePointerClick, Trash2, Type, X } from 'lucide-react'
import { View, makeBook } from '../../../vendor/foliate/view.js'
import { Overlayer } from '../../../vendor/foliate/overlayer.js'
import type { FoliateBook, FoliateRelocateDetail } from '../../../vendor/foliate/view.js'
import { excerptCreate, excerptDelete, excerptList, readerStateGet, readerStatePatch, workspaceReadRangeBytes } from '../../../lib/ipc'
import { showGlobalConfirm } from '../../../lib/globalConfirm'
import { useDataChanged } from '../../../lib/dataChanged'
import { useSettings } from '../../../lib/SettingsContext'
import { showToast } from '../../../lib/toast'
import { KB_CBZ_THUMBS, KB_CBZ_THUMB_REQ, KB_EPUB_GOTO_CFI, KB_EPUB_STATE, KB_EPUB_STATE_REQ, KB_READER_STATE_CHANGED, type EpubTocItem } from '../pdf/pdfEvents'
// 真源（扩展名 / kind / MIME 三张表都在那里）。★ 本文件**不得**再出现 MIME 或书籍扩展名字面量：
// foliate 的 makeBook() 按 File 的 name/type 分派解码器（view.js:13-21，不看魔数），
// 自拼 MIME 会重演「所有书都叫 xxx.epub」→ 裸 fb2 当场 UnsupportedTypeError、fbz 被当 EPUB 解包炸掉。
import { bookExtOf, bookKindOf, bookMimeOf } from '../../../../electron/lib/kbStore/bookFormats'
// 书签条数上限：**唯一真源在 schema**（写盘侧会按它整单拒绝），渲染层只读来提前拦并给出提示
import { MAX_BOOKMARKS } from '../../../../electron/lib/kbStore/readerStateSchema'
// 大书体积分档（B-16）：阈值与**用户看到的文案**都在那个零依赖文件里，两边共用同一份（勿在此另写数字）
import { bookSizeTier, bigBookConfirmText, bigBookDeclinedText, tooBigText } from '../../../../electron/lib/kbStore/bookSizeGate'
import { ExcerptCaptureBar } from '../txt/ExcerptCaptureBar'
import type { SelectionRect } from '../pdf/TextSelectionBar'
import type { BookBookmark, ExcerptColor, ExcerptItem, ExcerptType, ReaderPaper } from '../../../types'

/**
 * foliate 系阅读器（B 段 · 二期六格式引擎）。
 *
 * ★ 组件名里的 EPUB 是**引擎系**命名，不是格式限定：本组件接管 `bookEngineOf() === 'foliate'`
 *   的全部格式 —— epub（阶段 1）/ fb2 + fbz（阶段 2a）/ cbz（阶段 2b，届时需另按「无文本层」退化）。
 *   故凡涉及格式的判据一律由 `relPath` 推导（kind / 扩展名 / MIME 都取自 bookFormats 真源），
 *   文件内**不写**格式字面量（契约有负向断言锁）。
 *
 * 引擎 = **vendored foliate-js**（`src/vendor/foliate/`，4 处 KB PATCH，见其 README）。
 * 与 PdfReaderView / TxtReaderView 同构：工具栏（最左「← 返回书架」）+ 内部渲染容器；
 * 进度落 `.knowbase/modules/readerState.json`（readerStatePatch，expectedUpdatedAt 冲突检测）。
 *
 * ★★ 安全面两条硬约束（改动本文件前必读，契约有负向断言锁）：
 *   ① 内容帧 sandbox **不含 `allow-scripts`**（foliate 补丁③已去掉，勿改回）；
 *   ② 应用 CSP `script-src` **不含 `'unsafe-inline'`**。
 *   foliate 上游**不做内容净化**，书里的内联 `<script>` / `onerror` 属性原样存活在 DOM 里 ——
 *   这两条是仅有的防线。本文件只需要「读 `contentDocument`」（同源 blob:），
 *   **不需要**任何降低隔离的改动（铁律 10 的电子书例外只放开同源，不放开脚本）。
 *
 * 定位模型（双轨，方案 §1.3）：`locator` = foliate CFI（读回主力，精确）+ `pct` = 全书进度
 * （角标/进度条显示；CFI 失效时的退路）。两者都在 readerState 白名单里；`kind` **不在**白名单
 * （kind 是 relPath 的纯函数，主进程按路径推导后覆盖写入）。
 *
 * Hook 纪律：所有 hook 声明在任何早退 return 之前。
 */

/** 分块读取步长。★ 别按「IPC 往返次数」来调：实测 8/16/32/64MB 分块拉完同一本书的总时长一样
 *  （吞吐 ~160MB/s，是 V8 结构化克隆的天花板，与分块大小无关，见 docs/pending-fixes.md 的 B-16 表）。
 *  这里 8MB 的取舍是**内存峰值**：分块越大，同一时刻多占的字节越多，而对总时长没有好处。 */
const READ_CHUNK = 8 * 1024 * 1024


/** 缩略图缓存的项数上限（每项约 5-8KB data URL ⇒ 240 项 ≈ 2MB）。
 *  ★ 按**插入序**裁剪（Map 保序），不是严格 LRU —— 往回滚会重新生成，代价可接受；
 *  真要改 LRU 请连「命中时重插」一起加，别只改裁剪方向。 */
const THUMB_CACHE_MAX = 240

/** 缩略图宽度（px）。页图解码后动辄 20-30MB（2000×3000），必须下采样后再进网格。 */
const THUMB_WIDTH = 96

/** 摘录色 → foliate 高亮填充（与 styles/index.css 的 .kb-exc-* 同源；透明度走 CSS 变量） */
const HL_FILL: Record<ExcerptColor, string> = {
  y: '#efb84c', g: '#7fb844', b: '#5d9bdc', p: '#e0709a', v: '#9188e8',
}

/** foliate 的 `Overlayer.highlight` 用 `--overlayer-highlight-opacity`（默认 .3）控透明度 */
const HL_OPACITY = '0.42'

/**
 * 侧边点击翻页热区（2026-09-21）：左右各一条，宽 = `min(EDGE_MAX, max(EDGE_MIN, 宿主阅读宽 × EDGE_RATIO))`。
 * 中间留白给划选 —— 热区里**不**拦 mousedown，所以从边缘起拖照样能选字（只有「按下到抬起几乎没动」
 * 才算点击，见 EDGE_DRAG_SLOP）。
 * ★ 判据用**宿主坐标**（帧自身矩形 + 帧内坐标换算），不用 `e.clientX` 直接比 —— 分页器按章铺多个
 *   iframe 并靠平移把当前章挪进可视区，于是帧内坐标既可能超出可见区（帧比宿主盒宽、右侧被裁），
 *   也可能整体偏掉一个帧宽（实测点宿主正中收到 `clientX=2767`）。详见 bindDoc 里的注释。
 */
const EDGE_MAX = 160
const EDGE_MIN = 48
const EDGE_RATIO = 0.15
/** 按下 → 抬起的位移超过它即判为划选拖动，不翻页（px） */
const EDGE_DRAG_SLOP = 6
/** 悬停热区时挂在内容文档 `<html>` 上的类（光标手型；样式在 buildStyles 的 after 槽） */
const EDGE_CLS = { l: 'kb-et-l', r: 'kb-et-r' } as const

/** 加载阶段（覆盖层文案用）：read = 正在读字节 / open = 正在解包排版 */
type LoadPhase = 'read' | 'open'

/** 宿主主题变量取值（内容帧是独立文档，CSS 变量不继承 —— 必须读出来再写进书页样式） */
function hostVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch { return fallback }
}

/** 纸色 → 书页配色（default = 跟随宿主主题） */
function themeOf(paper: ReaderPaper): { bg: string; fg: string; link: string } {
  if (paper === 'sepia') return { bg: '#f4ecd8', fg: '#4b3f2f', link: '#8a6d3b' }
  if (paper === 'green') return { bg: '#c9e7c4', fg: '#213021', link: '#2f5d2a' }
  if (paper === 'dark') return { bg: '#1c1c1e', fg: '#d8d8d8', link: '#7cb3ff' }
  return {
    bg: hostVar('--bg-primary', '#ffffff'),
    fg: hostVar('--text-primary', '#1f1f1f'),
    link: hostVar('--accent', '#3b82f6'),
  }
}

/**
 * 书页样式：`[before, after]` 两槽 —— before 会被书自身 CSS 覆盖，after 覆盖书自身 CSS。
 * 用户偏好（字号 / 纸色）必须走 after 槽，否则书的 `body { background: white }` 会赢。
 */
function buildStyles(fontScale: number, paper: ReaderPaper): [string, string] {
  const t = themeOf(paper)
  const px = Math.round(19 * fontScale)
  const before = `html { color-scheme: ${paper === 'dark' ? 'dark' : 'light'}; }`
  const after = [
    `html { font-size: ${px}px !important; background: ${t.bg} !important; }`,
    `body { font-size: ${px}px !important; line-height: 1.95 !important; background: ${t.bg} !important; color: ${t.fg} !important; }`,
    'p, li, dd, dt, blockquote, td { line-height: inherit; }',
    `a, a:visited { color: ${t.link} !important; }`,
    'img, svg, video { max-width: 100% !important; height: auto !important; }',
    `:root { --overlayer-highlight-opacity: ${HL_OPACITY}; }`,
    `::selection { background: ${t.link}44; }`,
    // 侧边热区悬停给手型（热区没有别的可见线索）；两个类由 mousemove 切换
    `html.${EDGE_CLS.l}, html.${EDGE_CLS.r} { cursor: pointer !important; }`,
  ].join('\n')
  return [before, after]
}

/** 边缘提示的四档形态（设置 `edgePageHint`；非法值一律回落默认 B） */
type EdgeHintStyle = 'A' | 'B' | 'C' | 'D'
const EDGE_HINT_DEFAULT: EdgeHintStyle = 'B'
function coerceEdgeHint(v: unknown): EdgeHintStyle {
  const s = String(v ?? '').trim().toUpperCase()
  return s === 'A' || s === 'B' || s === 'C' || s === 'D' ? s : EDGE_HINT_DEFAULT
}
/** 工具栏 title 里的中文档名（点一下换一档，用户要看得懂现在在哪一档） */
const EDGE_HINT_LABEL: Record<EdgeHintStyle, string> = { A: '纯渐变', B: '渐变 + 箭头', C: '书口 + 箭头', D: '胶囊按钮' }

/**
 * 边缘提示的配色：按**书页实际底色**取（亮底压暗 / 深底提亮）。
 * ★ 判据是纸张而不是应用主题 —— 纸色（米黄 / 浅绿 / 暗）与应用明暗主题相互独立，
 *   用主题决定会让「米黄纸 + 暗色主题」拿到白色渐变（在浅底上几乎看不见）。
 */
function edgeHintVars(paper: ReaderPaper): CSSProperties {
  const bg = themeOf(paper).bg
  let dark = false
  const hex = bg.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  const rgb = bg.match(/rgba?\(([^)]+)\)/i)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    dark = lum(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)) < 128
  } else if (rgb) {
    const [r, g, b] = rgb[1].split(',').map(Number)
    dark = lum(r || 0, g || 0, b || 0) < 128
  }
  const v = dark
    ? { veil: 'rgba(255,255,255,.075)', chip: 'rgba(255,255,255,.06)', edge: 'rgba(255,255,255,.18)', fg: 'rgba(255,255,255,.55)' }
    : { veil: 'rgba(0,0,0,.085)', chip: 'rgba(0,0,0,.055)', edge: 'rgba(0,0,0,.16)', fg: 'rgba(0,0,0,.42)' }
  return {
    '--kb-veil': v.veil, '--kb-veil-chip': v.chip, '--kb-veil-edge': v.edge, '--kb-chip-fg': v.fg,
  } as CSSProperties
}
function lum(r: number, g: number, b: number): number { return 0.2126 * r + 0.7152 * g + 0.0722 * b }

/**
 * 整本读入（foliate 需要完整字节；分块过 IPC）。
 *
 * 返回 ArrayBuffer 而非 Uint8Array：`new File([u8])` 在 TS 5.7 的 `Uint8Array<ArrayBufferLike>`
 * 泛型下不满足 `BlobPart`（SharedArrayBuffer 分支），所以出口给 `.buffer`（本函数自己分配、
 * 长度恰好等于文件长度，故 `.buffer` 不会有富余 —— 这也是它不需要再拷一次的原因）。
 *
 * ★ B-16（2026-09-22）改造了两点，都是实测驱动的（数字见 docs/pending-fixes.md 的 B-16 表）：
 *   ① 走 `ws:readRangeBytes`（字节通道）而不是 base64 通道 —— 省掉渲染侧 `atob` + 逐字节解码，
 *      96MB 省 ~660ms；IPC 传输本身不变（实测两种载荷同为 ~160MB/s，那是结构化克隆的天花板）。
 *   ② **预分配一块就地写入**，不再「每块重新分配 + 全量拷贝」（那段 O(n²) 在 96MB 上 ~110ms，
 *      且峰值内存从 3 份降到 1 份）。
 *
 * `onProgress(loaded, total)` 每块回调一次，用来喂加载进度（调用方拿它 setState）。
 */
async function readWholeBook(
  rootId: string,
  relPath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const first = await workspaceReadRangeBytes(rootId, relPath, 0, READ_CHUNK)
  if (!first) throw new Error('读取失败')
  if ('error' in first) throw new Error(first.error || '读取失败')
  const total = first.size
  // ★ 体积闸门不在这里：三档判定（静默 / 确认 / 拒绝）由调用方在读完首块后走 bookSizeGate ——
  //   放这里就没法「先问一句再继续」，因为那时字节已经在内存里了。
  const out = new Uint8Array(total)
  out.set(first.bytes, 0)
  let off = first.bytes.length
  onProgress?.(off, total)
  while (off < total) {
    const r = await workspaceReadRangeBytes(rootId, relPath, off, READ_CHUNK)
    if (!r) throw new Error('读取失败')
    if ('error' in r) throw new Error(r.error || '读取失败')
    if (r.bytes.length === 0) break // 文件在读取途中被改短了：就此收手（后续解包会自行报错）
    out.set(r.bytes, off)
    off += r.bytes.length
    onProgress?.(off, total)
  }
  return out.buffer
}

interface Props {
  rootId: string
  relPath: string
  name: string
  /** 工具栏最左的返回入口（书架阅读态用） */
  backLabel?: string
  onBack?: () => void
}

export function EpubReaderView({ rootId, relPath, name, backLabel, onBack }: Props) {
  /** 格式三件套（唯一来源 = bookFormats 真源；本组件被引擎选中，故三者理论恒非空，仍按可空处理） */
  const bookKind = bookKindOf(relPath)
  const bookExt = bookExtOf(relPath)
  const bookMime = bookMimeOf(relPath)
  /** 摘录落库 / 进度广播用的 kind。本组件只在 `bookEngineOf(relPath) === 'foliate'` 时被挂载
   *  （`App.tsx` / 书架按引擎分发），故 `bookKind` 恒非空；`?? 'epub'` 只是类型收窄兜底，
   *  **不是第二个格式判断分支点** —— 不要在这里写任何格式映射。 */
  const kind = bookKind ?? 'epub'
  /** 固定版式（pre-paginated）—— 当今只有 cbz 走这条路（`comic-book.js` 设 rendition.layout）。
   *  ★ 判据用**真相源推导的 kind**、不用运行时 `view.isFixedLayout`：工具栏要在 `open()` **之前**
   *  就渲染对（否则先出字号按钮、open 后才换成缩放按钮，视觉上闪一下）。将来若出现第二个固定版式
   *  格式，这里改成按引擎能力集合判断 —— **别**在这里加 `||` 堆格式字面量。 */
  const isFixedLayoutBook = bookKind === 'cbz'

  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  /** 加载阶段（覆盖层文案的判据）：read = 正在读字节（带进度）/ open = 正在解包排版 */
  const [phase, setPhase] = useState<LoadPhase>('read')
  /** 读字节进度 0..100 —— 只对 `phase === 'read'` 有意义（拿到总大小后才开始有意义地增长） */
  const [readPct, setReadPct] = useState(0)
  /**
   * 阶段文字是否已该显示：**延迟 250ms 才亮**（见装载 effect 里的定时器）。
   * 小书（几 MB 的 epub/fb2）~300ms 就开完了，立刻显示会闪一下「正在读取 100%」再消失 ——
   * 宁可这类书上一次都不显示，也不要闪。
   */
  const [showPhase, setShowPhase] = useState(false)
  /**
   * 用户在大书确认框里点了取消时的体积（> 0 = error 态要多给一个「仍要打开」入口）。
   * ★ 取消不是死路：停在 error 态 + 重试按钮，比踢回书架更可逆（不产生意外跳转）。
   */
  const [declinedBytes, setDeclinedBytes] = useState(0)
  /**
   * 已就「大书确认」放行过的书键（`${rootId}/${relPath}`）。
   * 用**书键**而不是布尔量：换一本书要重新问一次，而同一本书点「仍要打开」重试时**不能再问**
   * （否则确认框会连弹两次）。故此处不清空、只比对。
   */
  const bigOkKeyRef = useRef('')
  /** 装载流程复跑开关：点「仍要打开」→ 递增 → 装载 effect 重跑（不另写一条装载路径） */
  const [reloadKey, setReloadKey] = useState(0)
  const [pct, setPct] = useState(0)
  const [chapter, setChapter] = useState('')
  const [fontScale, setFontScale] = useState(1)
  const [paper, setPaper] = useState<ReaderPaper>('default')
  /** 缩放档（仅固定版式用；`fixed-layout.js:118-131` 认 'fit-page' / 'fit-width'） */
  const [zoomMode, setZoomMode] = useState<'fit-page' | 'fit-width'>('fit-page')
  const [excerpts, setExcerpts] = useState<ExcerptItem[]>([])
  /** 书签（2026-09-22 起 foliate 系共用 readerState.json 的 bookmarks 字段，定位键 = CFI） */
  const [bookmarks, setBookmarks] = useState<BookBookmark[]>([])
  /**
   * 当前视口的 CFI（**镜面** state，只为让书签按钮的图标随翻页变化）。
   * `cfiRef.current` 在 relocate 回调里就被更新，但 ref 变更不触发渲染 —— 单独存一份 state，
   * 与 `pct` 写在同一处。★ 别改成「渲染时读 ref」：那样图标会慢一拍且行为依赖别处 setState。
   */
  const [pageCfi, setPageCfi] = useState('')
  const [capture, setCapture] = useState<{ rect: SelectionRect; cfi: string; text: string } | null>(null)
  const [notePop, setNotePop] = useState<{ rect: SelectionRect; excerpt: ExcerptItem } | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  /** 边缘翻页提示的宿主侧 overlay（形态由设置决定；用 ref 直接切类，见 paintEdgeHint） */
  const hintLRef = useRef<HTMLDivElement | null>(null)
  const hintRRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<View | null>(null)
  const expectedUpdatedAtRef = useRef<string | undefined>(undefined)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 恢复位置期间禁止落盘（否则 init 的 relocate 会把旧位置写花） */
  const restoringRef = useRef(true)
  const readyRef = useRef(false)
  const fontScaleRef = useRef(1)
  const paperRef = useRef<ReaderPaper>('default')
  const chapterRef = useRef('')
  const cfiRef = useRef('')
  /** 书签快照（与 excerptsRef 同款：foliate 回调注册在 effect 里，闭包拿不到最新 state） */
  const bkmRef = useRef<BookBookmark[]>([])
  const pctRef = useRef(0)
  /**
   * 首/末页兜底判据。**只有渲染器答不了的时候才被读到** —— `foliate-fxl` 没实现
   * `atStart`/`atEnd`（全 vendor 只有 `paginator.js:1102` 有这两个 getter），
   * 判据开关就是 `paintEdgeHint` 里的 `typeof r.atStart === 'boolean'`，所以这里可以
   * **无条件**按 section 序号算，不必先判断「是不是固定版式」（也就避免了在组件里读
   * 运行时 `view.isFixedLayout` —— 那是 `isFixedLayoutBook` 的专属判据，见 verify-epub-formats ④）。
   * ★ 重排书**不要**拿它当判据 —— section 在一章之内不变，会把「章内第二页」误判成书首。
   */
  const fxlEdgeRef = useRef({ atStart: true, atEnd: false })
  /** 摘录快照（foliate 回调注册在 effect 里，闭包拿不到最新 state） */
  const excerptsRef = useRef<ExcerptItem[]>([])
  /** cfi → 色（高亮重绘查表） */
  const annColorRef = useRef(new Map<string, ExcerptColor>())
  /** 已挂过监听的内容文档（同 section 重渲染会复用 doc，避免重复挂） */
  const boundDocsRef = useRef(new WeakSet<Document>())

  // ===== 缩略图（仅固定版式 / cbz 的左栏网格用；机制见 .claude/plans/b-stage2b-cbz.md §四）=====
  /** index → data URL；`null` = 该页解码失败，**记下来不再重试**（否则滚一次重试一次） */
  const thumbCacheRef = useRef(new Map<number, string | null>())
  /** 待处理页号（去重靠 cache 命中判定，这里只保证顺序） */
  const thumbQueueRef = useRef<number[]>([])
  /** 串行闸门：一次只处理一页，页间让出主线程（zip 解包也在主线程，见 view.js 的 useWebWorkers:false） */
  const thumbBusyRef = useRef(false)
  /** 关书即取消（与 `alive` 同思路，但缩略图队列可能活在 effect 之外） */
  const thumbGenRef = useRef(0)
  /** 缩放档的 ref 镜像：open effect 里要用当前值，又不能把 state 塞进依赖数组 */
  const zoomModeRef = useRef<'fit-page' | 'fit-width'>('fit-page')

  // ===== 边缘翻页提示（形态由全局设置 `edgePageHint` 决定；入口 = 工具栏那个按钮）=====
  const { s: settings, update: updateSetting } = useSettings()
  const hintStyle = coerceEdgeHint(settings.edgePageHint)
  /** 提示配色按**书页底色**算（纸色可独立于应用明暗主题，见 edgeHintVars 头注） */
  const edgeHintStyle = useMemo(() => edgeHintVars(paper), [paper])
  /**
   * 点亮/收起宿主侧提示层。
   * ★ 这里用 ref 直接切类，**不走 React state** —— mousemove 频率极高，setState 会让整个
   *   阅读器每帧重渲染（本组件一重渲染就要动 foliate 宿主与摘录重绘，代价远大于一次 classList）。
   * ★ 首/末页不提示：翻不动的那一侧不给线索，避免「提示能点、点了没反应」。
   * ★ 判据问**引擎**（`paginator.atStart`/`atEnd` 认得跨章与书末的虚拟页），**不要**拿 `pct`
   *   当代理：`pct` 是 `fraction` 四舍五入到整数的产物，① 一页占全书 <0.5% 的大书里首/末屏
   *   的取整结果正好把「还有上一页」压成 0 → 左提示整段不亮；② `fraction` 缺失的会话
   *   （`view.js:317` 的 `#sectionProgress` 未就绪时 `progress` 为 `{}`）pct 恒 0 → 同样整段不亮，
   *   而点击路径不查判据，于是表象是「点得动、提示不亮、右边还正常」。
   */
  const paintEdgeHint = useCallback((side: '' | 'l' | 'r', zone: number) => {
    const r = viewRef.current?.renderer as { atStart?: boolean; atEnd?: boolean } | undefined
    const atStart = typeof r?.atStart === 'boolean' ? r.atStart : fxlEdgeRef.current.atStart
    const atEnd = typeof r?.atEnd === 'boolean' ? r.atEnd : fxlEdgeRef.current.atEnd
    for (const k of ['l', 'r'] as const) {
      const node = k === 'l' ? hintLRef.current : hintRRef.current
      if (!node) continue
      node.style.setProperty('--kb-zw', `${zone}px`)
      node.classList.toggle('on', side === k && (k === 'l' ? !atStart : !atEnd))
    }
  }, [])
  const hideEdgeHints = useCallback(() => paintEdgeHint('', 0), [paintEdgeHint])
  /** 工具栏循环切档（与 `cyclePaper` 同款交互：点一下换一档，title 显示当前档） */
  const cycleEdgeHint = useCallback(() => {
    const order: EdgeHintStyle[] = ['A', 'B', 'C', 'D']
    const next = order[(order.indexOf(hintStyle) + 1) % order.length]
    updateSetting('edgePageHint', next)
  }, [hintStyle, updateSetting])

  // ===== 写回 readerState（冲突以服务端为基底、本地意图覆盖后重试一次）=====
  const patchReader = useCallback(async (patch: Parameters<typeof readerStatePatch>[2]) => {
    try {
      const r = await readerStatePatch(rootId, relPath, patch, expectedUpdatedAtRef.current)
      if (r.ok && r.state) {
        expectedUpdatedAtRef.current = r.state.updatedAt
      } else if (r.conflict && r.state) {
        expectedUpdatedAtRef.current = r.state.updatedAt
        const r2 = await readerStatePatch(rootId, relPath, patch, r.state.updatedAt)
        if (r2.ok && r2.state) expectedUpdatedAtRef.current = r2.state.updatedAt
      }
    } catch { /* 写回失败静默：进度属可再生数据 */ }
  }, [rootId, relPath])

  /** 进度落盘（防抖 400ms；locator 与 pct 同一次写入，避免两次 patch 互相打架） */
  const persist = useCallback((p: number, locator: string) => {
    if (restoringRef.current) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      void patchReader(locator ? { pct: p, locator } : { pct: p })
    }, 400)
  }, [patchReader])

  // 卸载时把最后一次防抖落盘立即冲掉（避免关书丢尾部进度）
  useEffect(() => () => {
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null }
  }, [])

  /**
   * 书签切换（2026-09-22）：当前视口 = 当前 relocate 的 CFI，同一处再点一次即移除。
   *
   * - **定位键 = 整条 CFI 字符串**（与 txt 用 paraIndex 同理，只是 foliate 系的"位置"就是 CFI）。
   *   判定用全等、不做任何截断：folio 的 range CFI 形如 `epubcfi(/6/6!/4/2,/2,/14/1:54)`
   *   （公共父路径 + 逗号分隔的两个子路径），"取第一个逗号之前"会退化成整章 —— 比不判还糟。
   * - **已知限制**：换字号 / 改窗口宽度会重新分页 → 同一屏的 CFI 与存储值不同 → 再点会加出第二条。
   *   两条都跳同一处且可各自删，故不为此发明 CFI 归一化（口径与摘录 / 进度一致：存原样）。
   * - 与 txt 一致：不写摘录、不进「导出为笔记」（书签只供快速跳转）。
   */
  const toggleBookmark = useCallback(() => {
    const cfi = cfiRef.current
    if (!cfi) return
    const exists = bkmRef.current.find((b) => b.cfi === cfi)
    let next: BookBookmark[]
    if (exists) {
      next = bkmRef.current.filter((b) => b.id !== exists.id)
    } else {
      // 上限与 schema 侧同一个常量：超了直接说，别让写回在下面静默失败（书签会"加上又消失"）
      if (bkmRef.current.length >= MAX_BOOKMARKS) {
        showToast({ type: 'warning', message: `书签已达上限（${MAX_BOOKMARKS} 条），请先删掉一些` })
        return
      }
      const ch = chapterRef.current.trim()
      next = [...bkmRef.current, {
        id: crypto.randomUUID(),
        cfi,
        // 章节名只作展示兜底（左栏优先显示 chapter）；有些书目录项为空，故给个「正文」兜底
        ...(ch ? { chapter: ch } : {}),
        label: `${ch || '正文'} · ${pctRef.current}%`,
        at: new Date().toISOString(),
      }]
    }
    bkmRef.current = next
    setBookmarks(next)
    void patchReader({ bookmarks: next })
  }, [patchReader])

  /** 应用书页样式（字号/纸色）。每个 section 加载后都要重挂一次 —— style 槽随文档走 */
  const applyStyles = useCallback(() => {
    const view = viewRef.current
    if (!view?.renderer) return
    try { view.renderer.setStyles(buildStyles(fontScaleRef.current, paperRef.current)) } catch { /* 样式失败不影响阅读 */ }
  }, [])

  /** 状态广播（toc 整棵树只在首次/被请求时带 —— 每翻页重发是纯浪费） */
  const sendState = useCallback((withToc: boolean) => {
    const view = viewRef.current
    if (!view) return
    try {
      window.dispatchEvent(new CustomEvent(KB_EPUB_STATE, {
        detail: {
          relPath,
          cfi: cfiRef.current,
          chapterLabel: chapterRef.current,
          chapterHref: '',
          ...(withToc ? { toc: (view.book?.toc ?? []) as EpubTocItem[] } : {}),
        },
      }))
    } catch { /* 广播失败不影响阅读 */ }
  }, [relPath])

  // ===== 缩放（仅固定版式 / cbz）=====
  /** 把当前缩放档写到 renderer 元素上。
   *  ★ 只在 `view.open()` 之后调才有意义 —— renderer 是 open 里才建的（`view.js:243`）。
   *  元素若尚未升级成 custom element，属性会留在元素上、升级时补发回调，故无需额外等待。 */
  const applyZoom = useCallback((view: View) => {
    try { view.renderer?.setAttribute('zoom', zoomModeRef.current) } catch { /* 元素未就绪：忽略 */ }
  }, [])

  const cycleZoom = useCallback(() => {
    const next: 'fit-page' | 'fit-width' = zoomModeRef.current === 'fit-page' ? 'fit-width' : 'fit-page'
    zoomModeRef.current = next
    setZoomMode(next)
    const view = viewRef.current
    if (view) applyZoom(view)
  }, [applyZoom])

  // ===== 缩略图（cbz 左栏网格按需生成；机制见 .claude/plans/b-stage2b-cbz.md §四）=====
  /** 一页 → 缩略图 data URL（失败回 null）。
   *  ★ 必须下采样：原图解码后动辄 20-30MB（2000×3000），直接把原图塞进 96px 的格子
   *  = 每格一份全尺寸位图，一屏几百 MB，且每次滚动都重解码。画完立刻 close 位图、丢掉源 blob。 */
  const makeThumb = useCallback(async (index: number): Promise<string | null> => {
    const view = viewRef.current
    const section = view?.book?.sections?.[index]
    const getBlob = view?.book?.getPageBlob
    if (!getBlob || !section?.id) return null
    try {
      const blob = await getBlob(section.id)
      if (!blob) return null
      const bmp = await createImageBitmap(blob)
      try {
        const w = THUMB_WIDTH
        const h = Math.max(1, Math.round((bmp.height / Math.max(1, bmp.width)) * w))
        const cv = new OffscreenCanvas(w, h)
        const ctx = cv.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(bmp, 0, 0, w, h)
        const out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.72 })
        return await new Promise<string>((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result))
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(out)
        })
      } finally { bmp.close() }
    } catch {
      // 解码器不认的格式（zip 允许 .jxl 等，见 comic-book.js 的 exts）→ null，网格留占位
      return null
    }
  }, [])

  /** 排空队列：串行 + 页间让出（zip 解包与图片解码都在主线程，长任务会把翻页卡住） */
  const drainThumbs = useCallback(async () => {
    if (thumbBusyRef.current) return
    thumbBusyRef.current = true
    const gen = thumbGenRef.current
    try {
      while (thumbQueueRef.current.length) {
        if (gen !== thumbGenRef.current) return          // 换书 / 关书 → 立即停
        const index = thumbQueueRef.current.shift() as number
        const cache = thumbCacheRef.current
        if (cache.has(index)) continue                   // 已被前一批请求生成过
        const url = await makeThumb(index)
        if (gen !== thumbGenRef.current) return
        cache.set(index, url)
        while (cache.size > THUMB_CACHE_MAX) {           // 按插入序裁剪，见常量注释
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        try {
          window.dispatchEvent(new CustomEvent(KB_CBZ_THUMBS, { detail: { relPath, from: index, items: [url] } }))
        } catch { /* 广播失败不影响阅读 */ }
        await new Promise((r) => { setTimeout(r, 0) })   // 让出主线程
      }
    } finally { thumbBusyRef.current = false }
  }, [makeThumb, relPath])

  /** 左栏网格的要图请求（只对固定版式生效；文本系没有「页图」这个概念） */
  useEffect(() => {
    if (!isFixedLayoutBook) return
    const onReq = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; from?: number; to?: number } | undefined
      if (!d || d.relPath !== relPath) return
      const total = viewRef.current?.book?.sections?.length ?? 0
      const from = Math.max(0, Math.floor(Number(d.from) || 0))
      const to = Math.min(total - 1, Math.max(from, Math.floor(Number(d.to ?? d.from) || 0)))
      if (to < from) return
      const cache = thumbCacheRef.current
      const items: (string | null | undefined)[] = []
      for (let i = from; i <= to; i++) {
        if (cache.has(i)) items.push(cache.get(i) ?? null)
        else { items.push(undefined); thumbQueueRef.current.push(i) }   // undefined = 还在队列里
      }
      // 先把已缓存的回掉（不等生成）；未命中的排队，产出后逐条补发同 index 的回广播
      try {
        window.dispatchEvent(new CustomEvent(KB_CBZ_THUMBS, { detail: { relPath, from, items } }))
      } catch { /* 同上 */ }
      void drainThumbs()
    }
    window.addEventListener(KB_CBZ_THUMB_REQ, onReq)
    return () => window.removeEventListener(KB_CBZ_THUMB_REQ, onReq)
  }, [relPath, isFixedLayoutBook, drainThumbs])

  // ===== 打开书：读字节 → foliate 打开 → 恢复位置 → 发首帧状态 =====
  useEffect(() => {
    let alive = true
    const host = hostRef.current
    if (!host) return

    setLoading(true)
    setLoadErr('')
    setPct(0)
    setChapter('')
    setDeclinedBytes(0)
    chapterRef.current = ''
    cfiRef.current = ''
    pctRef.current = 0
    restoringRef.current = true
    readyRef.current = false
    setCapture(null)
    setNotePop(null)

    // 加载阶段文字：延迟 250ms 才亮（小书转眼就好，立刻显示会闪一下；见 showPhase 的声明处）
    setPhase('read')
    setReadPct(0)
    setShowPhase(false)
    const phaseTimer = setTimeout(() => setShowPhase(true), 250)

    const view = new View()
    viewRef.current = view
    view.style.display = 'block'
    view.style.width = '100%'
    view.style.height = '100%'

    /** 重新应用全部 foliate 系摘录高亮（section 重建 / 摘录增删后都要重画） */
    const applyAnnotations = async () => {
      const v = viewRef.current
      if (!v) return
      for (const cfi of annColorRef.current.keys()) {
        try { await v.addAnnotation({ value: cfi }) } catch { /* CFI 失效（换书/换版本）忽略 */ }
      }
    }

    /** 键盘翻页（内容帧与宿主各挂一次：帧内事件不冒泡到宿主 document） */
    const handleKey = (e: KeyboardEvent): boolean => {
      const v = viewRef.current
      if (!v || e.ctrlKey || e.metaKey || e.altKey) return false
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { void v.prev(); return true }
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { void v.next(); return true }
      return false
    }

    /**
     * 内容帧里挂监听。doc 是同源 blob:，`getSelection` / keydown 都能直接挂 ——
     * 这正是「电子书内容帧只能同源」的由来（引擎分页必须读 contentDocument，铁律 10 唯一例外）。
     */
    const bindDoc = (doc: Document, index: number) => {
      if (boundDocsRef.current.has(doc)) return
      boundDocsRef.current.add(doc)
      const onUp = () => {
        setTimeout(() => {
          const sel = doc.getSelection()
          if (!sel || sel.isCollapsed || sel.rangeCount !== 1) { setCapture(null); return }
          const range = sel.getRangeAt(0)
          const text = sel.toString()
          if (!text.trim()) { setCapture(null); return }
          const v = viewRef.current
          if (!v) return
          let cfi = ''
          try { cfi = v.getCFI(index, range) } catch { cfi = '' }
          if (!cfi) { setCapture(null); return }
          // 选区矩形在**帧内坐标系**：帧元素偏移由 frameElement 补上（同源才拿得到）
          const fr = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
          const r = range.getBoundingClientRect()
          setNotePop(null)
          setCapture({
            rect: { left: r.left + (fr?.left ?? 0), top: r.top + (fr?.top ?? 0), width: r.width, height: r.height },
            cfi, text,
          })
        }, 0)
      }
      const onKeyDown = (e: KeyboardEvent) => { if (handleKey(e)) e.preventDefault() }

      /**
       * 侧边点击翻页（与工具栏 / 键盘同一对 prev/next）。
       * 三条「不翻页」的排除 ——
       *   ① 拖过：划选（含从边缘起拖选整段）不能变成翻页 → 比较按下/抬起位移；
       *   ② 书内链接 / 控件：上游 `#handleLinks` 已 `preventDefault`，读 `defaultPrevented` 即可；
       *   ③ 命中已有高亮：左键点高亮要出回看卡。高亮 SVG 是 `pointer-events:none`，
       *      `e.target` 永远是被盖住的正文元素，故只能按坐标问 overlayer.hitTest。
       * RTL 书（`<html dir="rtl">`，由上游 `#onLoad` 依语言设置）左右语义相反：点左边 = 下一页。
       */
      let downAt: { x: number; y: number } | null = null
      /**
       * ★ 热区一律用**宿主坐标**判，不用 `e.clientX`（帧内坐标）。
       *  为什么：分页器按「跨章连续」的方式铺内容帧 —— 每章一个 iframe，在宿主里横向排开，
       *  靠平移/滚动把当前章挪进可视区。于是 ① 帧比宿主盒子宽（实测 1830 vs 656），右边一大截
       *  被宿主 `overflow:hidden` 裁掉、根本点不到；② **派给哪个帧不由点击位置决定**，
       *  实测点宿主正中时收到的 `e.clientX` 是 2767（= 327 + 上一章宽度 2440）——
       *  那是另一个帧的坐标系，按它算热区会把「点正中」判成「点右边缘」而翻页。
       *  换算回宿主坐标（帧自身矩形 + 帧内坐标）后，无论哪个帧收事件、无论帧怎么偏移，
       *  都还原成「用户实际点在阅读区哪个位置」，热区也就可以直接对着宿主阅读盒量。
       */
      const frameRect = () => {
        try { return (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect() ?? null } catch { return null }
      }
      const hostPoint = (e: MouseEvent) => {
        const fr = frameRect()
        return { x: (fr?.left ?? 0) + e.clientX, y: (fr?.top ?? 0) + e.clientY }
      }
      /** 宿主阅读盒（`data-wb="epubHost"` = 分页器挂载点）的水平范围；取不到就退回本帧矩形 */
      const hostArea = () => {
        const fr = frameRect()
        const fallback = { left: fr?.left ?? 0, right: (fr?.left ?? 0) + (doc.documentElement.clientWidth || 0) }
        try {
          const r = (doc.defaultView?.parent?.document?.querySelector('[data-wb="epubHost"]') as HTMLElement | null)?.getBoundingClientRect()
          if (r && r.width > 0) return { left: r.left, right: r.right }
        } catch { /* 取不到父文档 → 退回本帧 */ }
        return fallback
      }
      const edgeZone = () => {
        const a = hostArea()
        return Math.min(EDGE_MAX, Math.max(EDGE_MIN, Math.round((a.right - a.left) * EDGE_RATIO)))
      }
      const onMouseDown = (e: MouseEvent) => { downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null }
      /**
       * 排障钩子：探针置 `window.__kbEdgeDiag = true` 时才把事件写进宿主 `<html data-kb-edge>`
       * （生产默认零开销 —— 每帧收到的事件坐标是这一块的「唯一真相」，出问题先开它）。
       */
      const diag = (where: string, e: MouseEvent) => {
        try {
          const pw = doc.defaultView?.parent as (Window & { __kbEdgeDiag?: boolean }) | null
          const el = pw?.document?.documentElement
          if (!el || !pw?.__kbEdgeDiag) return
          const area = hostArea()
          const zone = edgeZone()
          const hit = viewRef.current?.renderer.getContents().find((x) => x.index === index)?.overlayer?.hitTest({ x: e.clientX, y: e.clientY })
          const p = hostPoint(e)
          const prev = JSON.parse(el.getAttribute('data-kb-edge') || '[]') as unknown[]
          prev.push({
            where, frameX: Math.round(e.clientX), hostX: Math.round(p.x),
            area: [Math.round(area.left), Math.round(area.right)], zone,
            branch: p.x <= area.left + zone ? 'L' : p.x >= area.right - zone ? 'R' : '-',
            prevented: e.defaultPrevented, down: !!downAt, hit: !!hit?.[0],
          })
          el.setAttribute('data-kb-edge', JSON.stringify(prev.slice(-8)))
        } catch { /* 诊断失败不影响功能 */ }
      }
      const onClick = (e: MouseEvent) => {
        diag('click', e)
        const at = downAt
        downAt = null
        const v = viewRef.current
        if (!v || !at || e.defaultPrevented) return
        if (Math.abs(e.clientX - at.x) > EDGE_DRAG_SLOP || Math.abs(e.clientY - at.y) > EDGE_DRAG_SLOP) return
        const sel = doc.getSelection()
        if (sel && !sel.isCollapsed) return
        // ★ 内容列表在 **renderer** 上（`view.js:390` 自己的 `#getOverlayer` 也是这么取的）；
        //   `View` 本身没有 getContents —— 写成 `v.getContents()` 会在每次点击抛 TypeError。
        const hit = v.renderer.getContents().find((x) => x.index === index)?.overlayer?.hitTest({ x: e.clientX, y: e.clientY })
        if (hit?.[0]) return
        const area = hostArea()
        const zone = edgeZone()
        const x = hostPoint(e).x
        const rtl = doc.documentElement.dir === 'rtl'
        if (x <= area.left + zone) { void (rtl ? v.next() : v.prev()); return }
        if (x >= area.right - zone) void (rtl ? v.prev() : v.next())
      }
      /** 悬停热区给手型光标（样式在 buildStyles 的 after 槽，类在这里切换）+ 点亮宿主侧提示层 */
      const onMouseMove = (e: MouseEvent) => {
        diag('move', e)
        const area = hostArea()
        const zone = edgeZone()
        const x = hostPoint(e).x
        const want = x <= area.left + zone ? EDGE_CLS.l : x >= area.right - zone ? EDGE_CLS.r : ''
        const cl = doc.documentElement.classList
        for (const c of [EDGE_CLS.l, EDGE_CLS.r]) if (c !== want) cl.remove(c)
        if (want && !cl.contains(want)) cl.add(want)
        // 提示层与热区同源同宽（zone 已在宿主坐标里，overlay 与 hostArea 同一盒子）
        paintEdgeHint(want === EDGE_CLS.l ? 'l' : want === EDGE_CLS.r ? 'r' : '', zone)
      }

      doc.addEventListener('mouseup', onUp)
      doc.addEventListener('keydown', onKeyDown)
      doc.addEventListener('mousedown', onMouseDown)
      doc.addEventListener('click', onClick)
      doc.addEventListener('mousemove', onMouseMove)
    }

    const onRelocate = (e: Event) => {
      const d = (e as CustomEvent).detail as FoliateRelocateDetail
      if (!d) return
      const nextPct = Number.isFinite(d.fraction) ? Math.min(100, Math.max(0, Math.round(d.fraction * 100))) : 0
      // 固定版式（cbz）的 `tocItem.label` 是**文件名**（`page_07.png` —— `comic-book.js` 的
      // toc 就是页表），直接摆到工具栏是噪音 ⇒ 换成「第 N / M 页」。页号取 `section.current`
      // （`view.js:317` 的 SectionProgress 口径），**不是** relocate detail 顶层 —— 那里没有 index。
      // `href` 保持文件名不动：左栏网格靠它与 toc 项比对来高亮当前页。
      const label = isFixedLayoutBook && d.section?.total
        ? `第 ${(d.section.current ?? 0) + 1} / ${d.section.total} 页`
        : (typeof d.tocItem?.label === 'string' ? d.tocItem.label : '')
      const href = typeof d.tocItem?.href === 'string' ? d.tocItem.href : ''
      // 首/末页兜底：`foliate-fxl` 没有 atStart/atEnd（见 fxlEdgeRef），改由 section 序号提供 ——
      // 与上面的页码标签同源，故「第 1 / 60 页」时左提示必不亮、第 60 页时右提示必不亮。
      // ★ 无条件算是**故意**的：它只在该书渲染器答不了时被读到（开关在 paintEdgeHint），
      //   先判「是不是固定版式」反而要多读一次运行时状态、且多一处可能判错的分支。
      const cur = d.section?.current ?? 0
      fxlEdgeRef.current = { atStart: cur <= 0, atEnd: cur >= (d.section?.total ?? 1) - 1 }
      cfiRef.current = typeof d.cfi === 'string' ? d.cfi : ''
      pctRef.current = nextPct
      chapterRef.current = label
      setPct(nextPct)
      setPageCfi(cfiRef.current)
      setChapter(label)
      try {
        window.dispatchEvent(new CustomEvent(KB_READER_STATE_CHANGED, { detail: { relPath, kind, pct: nextPct } }))
      } catch { /* 广播失败不影响阅读 */ }
      persist(nextPct, cfiRef.current)
      // 左栏目录面板靠这个高亮当前章节；label 兜底（有些书目录项没有 href）
      try {
        window.dispatchEvent(new CustomEvent(KB_EPUB_STATE, {
          detail: { relPath, cfi: cfiRef.current, chapterLabel: label, chapterHref: href },
        }))
      } catch { /* 同上 */ }
    }

    const onLoad = (e: Event) => {
      const d = (e as CustomEvent).detail as { doc?: Document; index?: number } | undefined
      if (!d?.doc || typeof d.index !== 'number') return
      applyStyles()
      bindDoc(d.doc, d.index)
    }

    const onDraw = (e: Event) => {
      const d = (e as CustomEvent).detail as { draw?: (f: unknown, o?: Record<string, unknown>) => void; annotation?: { value?: string } }
      const color = d?.annotation?.value ? annColorRef.current.get(d.annotation.value) : undefined
      if (!d?.draw || !color) return
      d.draw(Overlayer.highlight, { color: HL_FILL[color] })
    }

    const onCreateOverlay = () => { void applyAnnotations() }

    const onShowAnnotation = (e: Event) => {
      const d = (e as CustomEvent).detail as { value?: string; index?: number; range?: Range } | undefined
      if (!d?.value || !d.range) return
      const ex = excerptsRef.current.find((x) => x.kind === kind && x.cfi === d.value)
      if (!ex) return
      // ★ 同上：内容列表在 renderer 上。此前写 `view.getContents()` 会抛 TypeError，
      //   于是「点已有高亮 → 回看卡」这条路径整体失效（探针 5.5 步锁住）。
      const doc = view.renderer.getContents().find((x) => x.index === d.index)?.doc
      const fr = (doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
      const r = d.range.getBoundingClientRect()
      setCapture(null)
      setNotePop({
        rect: { left: r.left + (fr?.left ?? 0), top: r.top + (fr?.top ?? 0), width: r.width, height: r.height },
        excerpt: ex,
      })
    }

    const onHostKeyDown = (e: KeyboardEvent) => {
      const hostEl = hostRef.current
      const t = e.target as Node | null
      if (!hostEl || !t || !hostEl.contains(t)) return  // 焦点不在阅读器内 → 让给全局快捷键
      if (handleKey(e)) e.preventDefault()
    }

    const onStateReq = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string } | undefined
      if (d?.relPath === relPath) sendState(true)
    }

    view.addEventListener('relocate', onRelocate)
    view.addEventListener('load', onLoad)
    view.addEventListener('draw-annotation', onDraw)
    view.addEventListener('create-overlay', onCreateOverlay)
    view.addEventListener('show-annotation', onShowAnnotation)
    host.appendChild(view)
    window.addEventListener('keydown', onHostKeyDown)
    window.addEventListener(KB_EPUB_STATE_REQ, onStateReq)

    void (async () => {
      try {
        // 1) 书级记忆（进度 + 位置 + 字号 + 纸色）
        const st = await readerStateGet(rootId, relPath)
        if (!alive) return
        let savedLocator = ''
        let savedPct = 0
        if (st.ok && st.state) {
          expectedUpdatedAtRef.current = st.state.updatedAt
          savedPct = typeof st.state.pct === 'number' ? st.state.pct : 0
          savedLocator = typeof st.state.locator === 'string' ? st.state.locator : ''
          // 书签：只信带 cfi 的条目（schema 侧已按 kind 过滤过一轮，这里再挡一次脏数据 —— 老仓库
          // 里可能有遗留的 txt 形条目，它们在本书点了只会静默不动）
          const bk = Array.isArray(st.state.bookmarks) ? st.state.bookmarks.filter((b) => !!b && typeof b.cfi === 'string' && !!b.cfi) : []
          setBookmarks(bk); bkmRef.current = bk
          const fs = typeof st.state.fontScale === 'number' && st.state.fontScale >= 0.5 && st.state.fontScale <= 3 ? st.state.fontScale : 1
          fontScaleRef.current = fs
          setFontScale(fs)
          const pp: ReaderPaper = st.state.paper === 'sepia' || st.state.paper === 'green' || st.state.paper === 'dark' ? st.state.paper : 'default'
          paperRef.current = pp
          setPaper(pp)
        } else {
          expectedUpdatedAtRef.current = undefined
        }

        // 1.5) 体积闸门（B-16）：先读**1 字节**只为拿总大小（handler 恒回 stat 出来的 size，
        //   读多少字节都一样），据此三档处置。放在这里而不是 readWholeBook 里，是因为「先问一句」
        //   必须在**整本进内存之前** —— 进去了再问就已经付过内存与时间了。
        const sizeProbe = await workspaceReadRangeBytes(rootId, relPath, 0, 1)
        if (!alive) return
        if (!sizeProbe) throw new Error('读取失败')
        if ('error' in sizeProbe) throw new Error(sizeProbe.error || '读取失败')
        const totalBytes = sizeProbe.size
        const tier = bookSizeTier(totalBytes)
        if (tier === 'refuse') throw new Error(tooBigText(totalBytes))
        if (tier === 'confirm') {
          const key = `${rootId}/${relPath}`
          if (bigOkKeyRef.current !== key) {
            const ok = await showGlobalConfirm({
              title: '打开这本大书？',
              message: bigBookConfirmText(name, totalBytes),
              confirmLabel: '仍要打开',
              cancelLabel: '取消',
            })
            if (!alive) return
            if (!ok) {
              // 停在 error 态 + 「仍要打开」（比踢回书架可逆）；不复位 bigOkKeyRef —— 重试时不该再问一遍
              setDeclinedBytes(totalBytes)
              setLoadErr(bigBookDeclinedText(name, totalBytes))
              setLoading(false)
              return
            }
            bigOkKeyRef.current = key
          }
        }

        // 2) 整本字节 → File。★ name 与 type 决定 foliate 选哪个解码器（view.js:13-21 的
        //    isCBZ / isFB2 / isFBZ 全是 endsWith 判定，**不看魔数**），故必须按真实格式给：
        //    否则裸 fb2 落到 UnsupportedTypeError、fbz 被当 EPUB 解包（zip 里无 container.xml）而炸。
        const bytes = await readWholeBook(rootId, relPath, (loaded, total) => {
          if (total > 0) setReadPct(Math.min(100, Math.round((loaded / total) * 100)))
        })
        if (!alive) return
        setPhase('open') // 字节读完 → 进入解包/排版阶段（阶段文字随之切换）
        const fileName = `${name || 'book'}${bookExt ?? ''}`
        const file = new File([bytes], fileName, bookMime ? { type: bookMime } : undefined)

        // ★ 固定版式（cbz）默认**左右对开**（`fixed-layout.js:210-241` 的拼版），漫画要单页 ——
        //   只有 `rendition.spread === 'none'` 时它才一节一跨页（`fixed-layout.js:208-209`）。
        //   而 `view.open()` 只对 string / 有 `arrayBuffer()` 的入参自己 makeBook（`view.js:221-223`），
        //   故先自家 makeBook、改完 rendition 再传**普通对象**进去（它不会再包一层）。
        //   ⚠ 顺序反了（先 open 再改）就被 `fixed-layout.js:201` 读走默认值、静默成对开。
        let target: File | FoliateBook = file
        if (isFixedLayoutBook) {
          const bk = await makeBook(file)
          if (!alive) return
          bk.rendition = { ...(bk.rendition ?? {}), spread: 'none' }
          target = bk
        }

        await view.open(target)
        if (!alive) return
        // 缩放档只能设在 renderer 元素上：`fixed-layout.js:35/64-72` 认自身 `zoom` 属性，而
        // `view.js` 全程不转发它（全文无 zoom）。`view.renderer` 是**公开字段**（本文件另有三处
        // 直接用它调 getContents），故直接 setAttribute 即可，无需第 6 处 vendor patch。
        applyZoom(view)
        await view.init({ showTextStart: true })
        if (!alive) return
        readyRef.current = true
        setLoading(false)

        // 3) 恢复位置：locator（CFI）优先，失败退化到 pct。★ foliate 的 goTo 内部吞异常
        //    （resolveNavigation / renderer.goTo 各自 try-catch 后返回 undefined），
        //    所以**判据是返回值**，不是 try/catch。
        let restored = false
        if (savedLocator) restored = !!(await view.goTo(savedLocator))
        if (!alive) return
        if (!restored && savedPct > 0) {
          try { await view.goToFraction(savedPct / 100); restored = true } catch { /* 停在首屏 */ }
        }
        if (!alive) return
        if (!restored && pctRef.current === 0 && savedPct > 0) { pctRef.current = savedPct; setPct(savedPct) }
        applyStyles()
        // 首帧状态带目录（左栏面板可能比阅读器挂得晚，它也会用 KB_EPUB_STATE_REQ 主动要一次）
        sendState(true)
        // 恢复完成后才解锁落盘（否则恢复过程中的 relocate 会把位置写花）
        requestAnimationFrame(() => { restoringRef.current = false })
      } catch (e) {
        if (!alive) return
        setLoadErr(String((e as Error)?.message || e))
        setLoading(false)
      }
    })()

    return () => {
      alive = false
      window.removeEventListener('keydown', onHostKeyDown)
      window.removeEventListener(KB_EPUB_STATE_REQ, onStateReq)
      view.removeEventListener('relocate', onRelocate)
      view.removeEventListener('load', onLoad)
      view.removeEventListener('draw-annotation', onDraw)
      view.removeEventListener('create-overlay', onCreateOverlay)
      view.removeEventListener('show-annotation', onShowAnnotation)
      try { view.close() } catch { /* 已销毁 */ }
      try { view.remove() } catch { /* 已摘除 */ }
      viewRef.current = null
      readyRef.current = false
      // 缩略图队列随书作废：换书/关标签时正在跑的那一页要在产出后被丢弃（判 gen，不是判 alive ——
      // 队列可能跑在这个 effect 之外）。data URL 不需要 revoke，清掉 Map 即释放。
      thumbGenRef.current += 1
      thumbQueueRef.current.length = 0
      thumbCacheRef.current.clear()
      thumbBusyRef.current = false
      clearTimeout(phaseTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, relPath, reloadKey])

  // ===== 摘录列表：挂载/换书拉一次 + excerpt 广播刷新 =====
  useEffect(() => {
    let alive = true
    setExcerpts([])
    setCapture(null)
    if (!rootId) return
    void excerptList(rootId, relPath).then((r) => {
      if (alive && r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 摘录读取失败不阻塞阅读 */ })
    return () => { alive = false }
  }, [rootId, relPath])
  useDataChanged('excerpt', () => {
    if (!rootId) return
    void excerptList(rootId, relPath).then((r) => {
      if (r.ok) setExcerpts(r.excerpts ?? [])
    }).catch(() => { /* 忽略 */ })
  })

  /** foliate 系摘录（有 cfi 的）→ 高亮同步：写 cfi→色 表（供 foliate 回调查表）+ 重画 */
  const foliateExcerpts = useMemo(() => excerpts.filter((e) => e.kind === kind && !!e.cfi), [excerpts, kind])
  useEffect(() => {
    const m = new Map<string, ExcerptColor>()
    for (const e of foliateExcerpts) m.set(e.cfi as string, e.color)
    annColorRef.current = m
    excerptsRef.current = excerpts
    const view = viewRef.current
    if (!view || !readyRef.current) return
    // 先删再添：foliate 内部同 key 会自行替换，这里只需把表里已有的 cfi 都画一遍
    for (const cfi of m.keys()) {
      void view.addAnnotation({ value: cfi }).catch(() => { /* CFI 失效忽略 */ })
    }
  }, [foliateExcerpts, excerpts])

  // ===== 右栏摘录 / 左栏目录 → 跳 CFI =====
  useEffect(() => {
    const onGoto = (e: Event) => {
      const d = (e as CustomEvent).detail as { relPath?: string; cfi?: string } | undefined
      const view = viewRef.current
      if (!d?.cfi || d.relPath !== relPath || !view) return
      void (async () => {
        // 同 3) 的判据：goTo 失败返回 falsy（内部已吞异常）
        const ok = await view.goTo(d.cfi as string)
        // 文案对摘录与书签都成立（同一个通道两处在用，别写死"这条摘录"）
        if (!ok) showToast({ type: 'info', message: '该位置在当前书里已失效（书可能已改版）' })
      })()
    }
    window.addEventListener(KB_EPUB_GOTO_CFI, onGoto)
    return () => window.removeEventListener(KB_EPUB_GOTO_CFI, onGoto)
  }, [relPath])

  // ===== 字号 / 纸色（书级记忆）=====
  const changeFont = useCallback((delta: number) => {
    const next = Math.min(3, Math.max(0.5, Math.round((fontScaleRef.current + delta) * 10) / 10))
    if (next === fontScaleRef.current) return
    fontScaleRef.current = next
    setFontScale(next)
    applyStyles()
    void patchReader({ fontScale: next })
  }, [applyStyles, patchReader])

  const cyclePaper = useCallback(() => {
    const order: ReaderPaper[] = ['default', 'sepia', 'green', 'dark']
    const next = order[(order.indexOf(paperRef.current) + 1) % order.length]
    paperRef.current = next
    setPaper(next)
    applyStyles()
    void patchReader({ paper: next })
  }, [applyStyles, patchReader])

  const turn = useCallback((dir: -1 | 1) => {
    const view = viewRef.current
    if (!view) return
    void (dir < 0 ? view.prev() : view.next())
  }, [])

  // ===== 划选 → 建摘录 =====
  const handleCreateExcerpt = useCallback((text: string, color: ExcerptColor, type: ExcerptType, note?: string) => {
    if (!capture || !rootId) return
    const cfi = capture.cfi
    const chapter = chapterRef.current
    // 乐观上色：先画上，写盘失败再撤（摘录广播回来时会被同值覆盖，不会闪）
    annColorRef.current.set(cfi, color)
    void excerptCreate(rootId, relPath, {
      kind,
      text,
      cfi,
      ...(chapter ? { chapter: chapter.slice(0, 200) } : {}),
      color,
      type,
      note,
    }).then((r) => {
      if (!r.ok) {
        annColorRef.current.delete(cfi)
        showToast({ type: 'error', message: r.error || '摘录创建失败' })
      }
    }).catch((e) => {
      annColorRef.current.delete(cfi)
      showToast({ type: 'error', message: String((e as Error)?.message || e) })
    })
    setCapture(null)
  }, [capture, rootId, relPath, kind])

  const handleAsk = useCallback((t: string) => {
    window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', { detail: { action: 'ask', text: t } }))
    setCapture(null)
  }, [])

  const handleTranslate = useCallback((t: string, r: SelectionRect) => {
    window.dispatchEvent(new CustomEvent('ai-assistant:selection-action', {
      detail: { action: 'translate', text: t, rect: { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height } },
    }))
    setCapture(null)
  }, [])

  const deleteExcerpt = useCallback((e: ExcerptItem) => {
    setNotePop(null)
    void excerptDelete(rootId, relPath, e.id).catch(() => { /* 忽略 */ })
  }, [rootId, relPath])

  const paperStyle: CSSProperties = paper === 'sepia'
    ? { filter: 'sepia(0.32) brightness(0.97) saturate(0.92)' }
    : paper === 'dark'
      ? { backgroundColor: '#1c1c1e' }
      : paper === 'green'
        ? { backgroundColor: '#c9e7c4' }
        : {}

  const paperLabel = paper === 'sepia' ? '护眼' : paper === 'green' ? '绿纸' : paper === 'dark' ? '暗色' : '默认'

  const toolbar = (
    <div className="kb-fit kb-fit-pdfread flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] text-[var(--text-secondary)]">
      {onBack && (
        <>
          <button onClick={onBack} title={backLabel ?? '返回书架'} data-wb="epubBack"
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ArrowLeft size={13} /><span className="kb-l1">{backLabel ?? '返回书架'}</span>
          </button>
          <div className="mx-1 h-4 w-px bg-[var(--border-color)]" />
        </>
      )}
      <span className="max-w-[220px] truncate text-[var(--text-primary)]">{name}</span>
      <span className="kb-l3 text-[var(--text-tertiary)]">{kind.toUpperCase()}</span>
      {/* data-wb 锚点：探针断言「目录跳转真的换了章」（无锚点时只能读整条 toolbar 文本） */}
      {chapter && <span data-wb="epubChapter" className="kb-l1 min-w-0 truncate text-[var(--text-tertiary)]">· {chapter}</span>}
      <div className="min-w-0 flex-1" />
      <button onClick={() => turn(-1)} title="上一页（←）" data-wb="epubPrev"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ChevronLeft size={15} /></button>
      <button onClick={() => turn(1)} title="下一页（→ / 空格）" data-wb="epubNext"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><ChevronRight size={15} /></button>
      {/* 字号只对文字书有意义：`changeFont` 改的是注入文本 CSS 的 `--kb-font-scale`，
          固定版式（cbz）整页是图片，改了毫无反应 —— 与其留两个无效按钮，不如换成缩放档。 */}
      {!isFixedLayoutBook && (
        <>
          {/* 书签：只对文字层书有意义（cbz 整页是图片，且 schema 侧 `FOLIATE_KINDS` 不收 cbz ——
              放在这个分支里，按钮可见性 = 可存性，不会出现"存了但从没出现过"的孤儿条目）。
              判定 = 当前 CFI 全等（见 toggleBookmark 的已知限制）。 */}
          <button onClick={toggleBookmark} data-wb="epubBookmark" data-wb-marked={bookmarks.some((b) => b.cfi === pageCfi) ? '1' : '0'}
            title={bookmarks.some((b) => b.cfi === pageCfi) ? '移除本页书签' : '收藏本页书签'}
            className={`flex items-center gap-1 rounded p-0.5 ${bookmarks.some((b) => b.cfi === pageCfi) ? 'text-[var(--accent)]' : 'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}>
            {bookmarks.some((b) => b.cfi === pageCfi) ? <Bookmark size={14} /> : <BookmarkPlus size={14} />}<span className="kb-l1">书签</span>
          </button>
          <button onClick={() => changeFont(-0.1)} title="缩小字号" data-wb="epubFontDec"
            className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Type size={13} /><span className="text-[10px]">−</span></button>
          <button onClick={() => changeFont(0.1)} title="放大字号" data-wb="epubFontInc"
            className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Type size={13} /><span className="text-[10px]">＋</span></button>
        </>
      )}
      {/* 固定版式缩放两档（plan 拍板③）。写在 renderer 元素的 `zoom` 属性上 —— 见 view.d.ts 的注解。
          `data-wb-zoom` 是探针断言「点了真的换档」的锚（比读图标可靠）。 */}
      {isFixedLayoutBook && (
        <button onClick={cycleZoom} data-wb="epubZoom" data-wb-zoom={zoomMode}
          title={zoomMode === 'fit-page' ? '适应整页（点击切换为适应宽度）' : '适应宽度（点击切换为适应整页）'}
          className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          {zoomMode === 'fit-page' ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      )}
      <button onClick={cyclePaper} title={`纸色：${paperLabel}`} data-wb="epubPaper"
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Contrast size={14} /></button>
      {/* 边缘翻页提示形态（设置 edgePageHint；本阅读器 = foliate 系，恒有这对热区 → 恒显示。
          PDF / TXT 走各自的阅读器组件，那里没有这对热区，所以也不会出现这个按钮。） */}
      <button onClick={cycleEdgeHint} title={`边缘翻页提示：${EDGE_HINT_LABEL[hintStyle]}（点击切换形态）`}
        data-wb="epubHintStyle" data-wb-hint={hintStyle}
        className="flex items-center rounded p-0.5 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><MousePointerClick size={14} /></button>
      <span className="shrink-0 text-[var(--text-tertiary)]" data-wb="epubPct">{pct}%</span>
    </div>
  )

  return (
    <div data-wb="epubReader" data-wb-state={loadErr ? 'error' : loading ? 'loading' : 'ready'}
      className="relative flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
      {toolbar}
      {/* 渲染宿主**常驻 DOM，error 态也在**：foliate 要读宿主尺寸才能分页，加载态只做**覆盖层**而不是替换内容。
          ★ error 态同样不能卸载它 —— 装载 effect 第一步就是 `const host = hostRef.current; if (!host) return`，
            宿主不在 ⇒ 「取消」后点「仍要打开」会**静默失效**（reloadKey 递增了、但没有宿主可挂载，
            表象是按钮点了没反应；2026-09-22 由 probe-cbz-bigbook 的复跑断言抓到）。
          `data-wb="epubHost"` = 帧内热区计算的锚（内容帧读它的 clientWidth 当可见阅读宽，见 bindDoc） */}
      <div className="relative flex min-h-0 flex-1 flex-col" onMouseLeave={hideEdgeHints}>
        <div ref={hostRef} data-wb="epubHost" className="min-h-0 flex-1 overflow-hidden" style={paperStyle} />
        {/* 边缘翻页提示（宿主侧 overlay，`pointer-events:none` —— 热区不拦 mousedown，
            从边缘起拖照样能选字）：形态 = 设置 `edgePageHint`，默认 B。鼠标进入该侧热区才淡入；
            首/末页不提示（见 paintEdgeHint）。配色按书页底色注入，见 edgeHintVars。 */}
        <div ref={hintLRef} className="kb-edge-hint l" data-v={hintStyle} data-wb="edgeHintL" style={edgeHintStyle}>
          <div className="veil" />
          <div className="edge" />
          <div className="chip"><ChevronLeft size={15} /><span className="ct">上一页</span></div>
        </div>
        <div ref={hintRRef} className="kb-edge-hint r" data-v={hintStyle} data-wb="edgeHintR" style={edgeHintStyle}>
          <div className="veil" />
          <div className="edge" />
          <div className="chip"><ChevronRight size={15} /><span className="ct">下一页</span></div>
        </div>
      </div>
      {loadErr && (
        /* error 态覆盖层（覆盖宿主而非替换它，理由见上）：大书被用户取消时（declinedBytes > 0）
           多给一个「仍要打开」—— 它是**复跑装载流程**（reloadKey +1），不是另写一条装载路径。
           底色不透明：底下的宿主虽然空着（装载没走到 open），也不该让它透出来。 */
        <div className="absolute inset-x-0 bottom-0 top-[34px] z-10 flex flex-col items-center justify-center gap-3 bg-[var(--bg-primary)] px-6 text-center text-[12.5px] text-[var(--text-muted)]">
          <div data-wb="epubLoadErr">{loadErr}</div>
          {declinedBytes > 0 && (
            <button data-wb="epubBigBookRetry"
              onClick={() => {
                bigOkKeyRef.current = `${rootId}/${relPath}` // 已确认过 ⇒ 重跑时不再问第二遍
                setReloadKey((k) => k + 1)
              }}
              className="kb-micro-pop inline-flex items-center gap-1 rounded border border-[var(--border-color)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]">
              仍要打开
            </button>
          )}
        </div>
      )}
      {loading && !loadErr && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[34px] flex flex-col items-center justify-center gap-2">
          <Loader2 size={22} className="animate-spin text-[var(--accent)]" />
          {/* 阶段 + 进度：延迟 250ms 才亮（小书不闪），但**必须亮** —— 一本 96MB 的书要等 2 秒，
              没有文字时用户分不清「在加载」和「卡死了」。`data-wb=epubLoadPhase` 给探针做判据。 */}
          {showPhase && (
            <div data-wb="epubLoadPhase" className="text-[12px] text-[var(--text-muted)]">
              {phase === 'read'
                ? (readPct > 0 ? `正在读取 ${readPct}%` : '正在读取…')
                : '正在解包排版…'}
            </div>
          )}
        </div>
      )}

      {capture && (
        <ExcerptCaptureBar
          rect={capture.rect}
          text={capture.text}
          onCreate={handleCreateExcerpt}
          onAsk={handleAsk}
          onTranslate={handleTranslate}
          onClose={() => setCapture(null)}
        />
      )}

      {/* 点已有高亮 → 极简回看卡（正文 → 摘录的回路；完整编辑仍在右栏阅读侧栏） */}
      {notePop && (
        <div className="kb-pop fixed z-[60] w-[260px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]/97 p-2 shadow-lg backdrop-blur"
          style={{ left: Math.min(Math.max(8, notePop.rect.left), Math.max(8, window.innerWidth - 268)), top: notePop.rect.top + notePop.rect.height + 8 }}>
          <div className="mb-1 flex items-center gap-1.5">
            <span className={`kb-exc-dot kb-exc-${notePop.excerpt.color}`} />
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--text-tertiary)]">{notePop.excerpt.chapter || '正文'}</span>
            <button onClick={() => deleteExcerpt(notePop.excerpt)} title="删除这条摘录"
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-warning)]"><Trash2 size={11} /></button>
            <button onClick={() => setNotePop(null)} title="关闭"
              className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><X size={11} /></button>
          </div>
          <div className="line-clamp-3 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{notePop.excerpt.text}</div>
          {notePop.excerpt.note && (
            <div className="mt-1 rounded bg-[var(--bg-hover)]/60 px-1.5 py-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">{notePop.excerpt.note}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default EpubReaderView
