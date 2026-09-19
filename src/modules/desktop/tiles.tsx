/**
 * 桌面外壳 —— 控件（磁贴）注册表
 *
 * 控件分两类，key 前缀即类型，天然与 `TabName` 隔开：
 *   `content:*`  磁贴内就地办事（勾待办 / 打卡）或只读切片（最近文档 / 统计）
 *   `module:*`   点开进入模块（凡是要产生新文件、新正文的动作，一律走这里）
 *
 * 判断「就地」还是「跳模块」的判据 = **该动作是否产生新文件 / 新正文**。
 * 所以：勾待办可就地，打卡可就地；新建笔记、写说说、点文档看正文都要跳模块。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TabName, HabitRecord } from '../../types'
import {
  ListTodo, CalendarCheck, FileClock, PieChart, FolderTree, MessageSquare,
  BookOpen, Trash2, LifeBuoy, History, FlaskConical, LayoutGrid,
  Clock, CalendarDays, Activity, ChevronLeft, ChevronRight,
} from 'lucide-react'
import {
  EditorIcon, BlogIcon, ScheduleIcon, KnowledgeIcon, MomentsIcon,
  ToolboxIcon, PluginIcon, AiTeachingIcon, UserIcon, SettingsIcon,
} from '../../components/shared/ModuleIcons'
import type { DesktopData, DerivedStats } from './useDesktopData'
import { hasCheckOn, shiftDays } from './useDesktopData'
import { isoWeekNo, weekRangeOf, monthRangeOf, yearRangeOf, summaryWindowsAt } from '../../lib/summary'
import { TILE_MODULE_IDS, labelOf } from '../../lib/appModules'
import { Collapsible } from '../../components/shared/Collapsible'

export interface TileCtx {
  w: number
  h: number
  data: DesktopData
  stats: DerivedStats
  /** 打开某个模块（由 App 层传入，等价于点活动栏图标） */
  onOpen: (tab: TabName) => void
}

export interface TileDef {
  key: string
  label: string
  /** 添加控件面板里的一句话说明：说清「这块磁贴里会显示什么」，不是夸它好用 */
  desc: string
  /** 曾用名。重命名过的控件在面板里注一行「原「xx」」，免得用户找不到原来那个 */
  was?: string
  kind: 'content' | 'module'
  /** 添加控件面板里显示的图标 */
  icon: (size: number) => ReactNode
  defaultW: number
  defaultH: number
  /** 磁贴内右侧那行小字（可缺省） */
  tail?: (ctx: TileCtx) => string
  render: (ctx: TileCtx) => ReactNode
}

/* ==================== 展示小工具 ==================== */

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / YYYY-MM-DD */
export function relTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = Math.floor(diff / 86_400_000)
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  return iso.slice(0, 10)
}

/** 列表行数：磁贴越高显示越多（高度就是信息密度调节器） */
function rowsFor(h: number, perUnit: number, max: number): number {
  return Math.max(1, Math.min(max, h * perUnit))
}

function Empty({ text }: { text: string }): ReactNode {
  return <div className="desk-empty">{text}</div>
}

/* ==================== 卡片内部件 ==================== */

/*
 * 下面三个必须是**真的组件**（各自带内部状态：时钟要自己走、月历要翻月），
 * 且必须定义在模块作用域 —— 若写在 render 里内联，defOf() 每次返回新函数身份，
 * React 会把整棵子树当成新组件重挂（输入焦点、翻月状态全丢）。
 */

const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 问候语：按小时段，中文习惯不出现 AM/PM */
function greetingOf(hour: number): string {
  if (hour < 5) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 13) return '中午好'
  if (hour < 18) return '下午好'
  if (hour < 23) return '晚上好'
  return '夜深了'
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
const isoStr = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** 时钟卡：问候语 + 超大时间 + 日期（参照图的时钟卡布局） */
function ClockTile(): ReactNode {
  const [now, setNow] = useState(() => new Date())
  // 20s 一跳：分钟显示够准，又不至于每秒重渲染整块桌面
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 20_000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="desk-clock">
      <div className="desk-clock-hi">{greetingOf(now.getHours())}</div>
      <div className="desk-clock-time">{pad2(now.getHours())}:{pad2(now.getMinutes())}</div>
      <div className="desk-clock-date">{now.getMonth() + 1} 月 {now.getDate()} 日 · {WEEK_CN[now.getDay()]}</div>
    </div>
  )
}

/**
 * 月历 / 日历卡（可点，四类跳转）：周一起表头 + 首列周号（ISO 周号，如 W34）。
 * 「月历」磁贴与「日程面板」的日历段共用同一份实现。
 * 四类点击（全部派发事件，由 blog 侧按窗口打开 / 生成总结文件）：
 *   点日期 → blog-open-date       点周号 → blog-open-summary(kind:week)
 *   点标题里的月 → blog-open-summary(kind:month)  点标题里的年 → blog-open-summary(kind:year)
 * 注：磁贴拖拽只在编辑态（onPointerDown 命中 `.desk-tile` 且 editing 为真）触发，
 * 非编辑态点是安全的；编辑态下 `.desk-tile-body` 已是 pointer-events:none，按钮本身也点不到。
 * 沿用 content:checkin 行按钮的先例：不在按钮上写 stopPropagation。
 */
function MiniCalendar({ today, records }: { today: string; records: HabitRecord[] }): ReactNode {
  const [off, setOff] = useState(0)
  const [ty, tm, td] = today.split('-').map(Number)
  const view = new Date(ty, (tm || 1) - 1 + off, 1)
  const y = view.getFullYear()
  const m = view.getMonth()

  const leading = (new Date(y, m, 1).getDay() + 6) % 7 // 周一起：1 号前的占位天数
  const total = new Date(y, m + 1, 0).getDate()
  const cells: number[] = []
  for (let i = 0; i < leading; i++) cells.push(0)
  for (let d = 1; d <= total; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(0)

  // 按周切片：每周取周一算 ISO 周号与周窗口
  const startMonday = new Date(y, m, 1 - leading)
  const weeks: Array<{
    key: number
    wno: number
    start: string
    end: string
    days: Array<{ d: number; ds: string; isToday: boolean; marked: boolean }>
  }> = []
  for (let w = 0; w < cells.length / 7; w++) {
    const monday = new Date(startMonday.getFullYear(), startMonday.getMonth(), startMonday.getDate() + w * 7)
    const mondayStr = isoStr(monday)
    const wr = weekRangeOf(mondayStr)
    const days = cells.slice(w * 7, w * 7 + 7).map((d) => {
      if (d === 0) return { d: 0, ds: '', isToday: false, marked: false }
      const ds = `${y}-${pad2(m + 1)}-${pad2(d)}`
      return { d, ds, isToday: off === 0 && d === td, marked: hasCheckOn(records, ds) }
    })
    weeks.push({ key: w, wno: isoWeekNo(mondayStr), start: wr.start, end: wr.end, days })
  }

  const openSummary = (kind: 'week' | 'month' | 'year', start: string, end: string): void => {
    window.dispatchEvent(new CustomEvent('blog-open-summary', { detail: { kind, start, end } }))
  }

  const grid: ReactNode[] = []
  grid.push(<span key="wk-head" className="desk-cal-wk-head" />)
  for (const w of ['一', '二', '三', '四', '五', '六', '日']) {
    grid.push(<span key={`wd-${w}`} className="desk-cal-wd">{w}</span>)
  }
  for (const week of weeks) {
    grid.push(
      <button
        key={`wk-${week.key}`}
        className="desk-cal-wk"
        title={`第 ${week.wno} 周总结`}
        onClick={() => openSummary('week', week.start, week.end)}
      >
        W{week.wno}
      </button>,
    )
    week.days.forEach((c, i) => {
      if (c.d === 0) {
        grid.push(<span key={`b-${week.key}-${i}`} className="desk-cal-cell is-blank" />)
        return
      }
      grid.push(
        <span
          key={`c-${week.key}-${c.d}`}
          className={`desk-cal-cell${c.isToday ? ' is-today' : ''}${c.marked ? ' is-marked' : ''}`}
          title={c.marked ? `${c.ds} · 有打卡` : c.ds}
          onClick={() => window.dispatchEvent(new CustomEvent('blog-open-date', { detail: { date: c.ds } }))}
        >
          {c.d}
        </span>,
      )
    })
  }

  return (
    <div className="desk-cal">
      <div className="desk-cal-head">
        <button className="desk-cal-nav" onClick={() => setOff((v) => v - 1)} title="上个月"><ChevronLeft size={13} /></button>
        <div className="desk-cal-title">
          <button className="desk-cal-lk" title="查看年度总结" onClick={() => { const r = yearRangeOf(y); openSummary('year', r.start, r.end) }}>{y} 年</button>
          <button className="desk-cal-lk" title="查看月度总结" onClick={() => { const r = monthRangeOf(y, m + 1); openSummary('month', r.start, r.end) }}>{m + 1} 月</button>
        </div>
        <button className="desk-cal-nav" onClick={() => setOff((v) => v + 1)} title="下个月"><ChevronRight size={13} /></button>
        {off !== 0 && (
          <button className="desk-cal-back" onClick={() => setOff(0)} title="回到本月">今天</button>
        )}
      </div>
      <div className="desk-cal-grid desk-cal-grid-wk">{grid}</div>
    </div>
  )
}

const DAYBOOK_COLLAPSE_KEY = 'desk.daybook.collapsed'

function readDaybookCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(DAYBOOK_COLLAPSE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch { return {} }
}
function writeDaybookCollapsed(v: Record<string, boolean>): void {
  try { localStorage.setItem(DAYBOOK_COLLAPSE_KEY, JSON.stringify(v)) } catch { /* 忽略写入异常 */ }
}

/**
 * 日程面板：① 日历 ② 打卡记录 ③ 总结入口 ④ 最近编辑，四段各自可折叠，
 * 折叠态持久化到 localStorage（键 desk.daybook.collapsed，JSON 对象，缺省全展开）。
 */
function DaybookTile({ w, h, data, onOpen }: { w: number; h: number; data: DesktopData; onOpen: (t: TabName) => void }): ReactNode {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readDaybookCollapsed)

  const toggle = (key: string): void => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      writeDaybookCollapsed(next)
      return next
    })
  }
  const isOpen = (key: string): boolean => !collapsed[key]

  const recentList = [...data.pages]
    .filter((p) => p.status !== 'draft')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, rowsFor(h, 2, 6))

  const wins = summaryWindowsAt(data.today)
  const hasSummary = (kind: string, start: string, end: string): boolean =>
    data.summaries.some((s) => s.kind === kind && s.start === start && s.end === end)
  const winText = (kind: string, start: string, end: string): string => {
    if (kind === 'week') return `${start.slice(5).replace('-', '.')} ~ ${end.slice(5).replace('-', '.')}`
    if (kind === 'month') return `${start.slice(0, 4)} 年 ${start.slice(5, 7)} 月`
    return `${start.slice(0, 4)} 年`
  }
  const badge = (kind: string): string => (kind === 'week' ? '周' : kind === 'month' ? '月' : '年')

  const dotN = w >= 4 ? 7 : w >= 3 ? 5 : 4
  const dotDays = Array.from({ length: dotN }, (_, i) => shiftDays(data.today, -(dotN - 1 - i)))

  return (
    <div className="desk-db-scroll">
      {/* ① 日历 */}
      <div className="desk-db-sec">
        <DaybookSectionHead open={isOpen('calendar')} onToggle={() => toggle('calendar')} icon={<CalendarDays size={13} className="desk-db-sec-ico" />} title="日历" />
        <Collapsible open={isOpen('calendar')}>
          {() => <MiniCalendar today={data.today} records={data.records} />}
        </Collapsible>
      </div>

      {/* ② 打卡记录：每个习惯一行，最近 N 天圆点可点切换那天打卡 */}
      <div className="desk-db-sec">
        <DaybookSectionHead open={isOpen('checkin')} onToggle={() => toggle('checkin')} icon={<CalendarCheck size={13} className="desk-db-sec-ico" />} title="打卡记录" />
        <Collapsible open={isOpen('checkin')}>
          {() => (
            data.habits.length === 0
              ? <Empty text="还没有习惯，去日程里建一个" />
              : (
                <div className="desk-db-habits">
                  {data.habits.slice(0, rowsFor(h, 3, 8)).map((hb) => {
                    const onCount = dotDays.filter((d) => data.records.some((r) => r.habitId === hb.id && r.date === d)).length
                    return (
                      <div key={hb.id} className="desk-db-habit">
                        <span className="desk-db-habit-name" title={hb.name}>{hb.name}</span>
                        <span className="desk-db-dots">
                          {dotDays.map((d) => {
                            const on = data.records.some((r) => r.habitId === hb.id && r.date === d)
                            const isToday = d === data.today
                            return (
                              <button
                                key={d}
                                className={`desk-db-dot${on ? ' is-on' : ''}${isToday ? ' is-today' : ''}`}
                                title={`${d}${on ? ' · 已打卡' : ' · 未打卡'}`}
                                onClick={() => { void data.toggleHabitOn(hb.id, d) }}
                              />
                            )
                          })}
                        </span>
                        <span className="desk-db-habit-cnt">{onCount}/{dotN}</span>
                      </div>
                    )
                  })}
                </div>
              )
          )}
        </Collapsible>
      </div>

      {/* ③ 总结入口：周 / 月 / 年 三档，已有总结→打开，否则→生成 */}
      <div className="desk-db-sec">
        <DaybookSectionHead open={isOpen('summary')} onToggle={() => toggle('summary')} icon={<History size={13} className="desk-db-sec-ico" />} title="总结入口" />
        <Collapsible open={isOpen('summary')}>
          {() => (
            <div className="desk-db-sums">
              {wins.map((wn) => {
                const exists = hasSummary(wn.kind, wn.start, wn.end)
                return (
                  <div key={wn.kind} className="desk-db-sum-row">
                    <span className="desk-db-badge">{badge(wn.kind)}</span>
                    <span className="desk-db-win">{winText(wn.kind, wn.start, wn.end)}</span>
                    <button
                      className="desk-db-act"
                      onClick={() => window.dispatchEvent(new CustomEvent('blog-open-summary', { detail: { kind: wn.kind, start: wn.start, end: wn.end } }))}
                    >
                      {exists ? '打开' : '生成'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </Collapsible>
      </div>

      {/* ④ 最近编辑：照 content:recent 的写法 */}
      <div className="desk-db-sec">
        <DaybookSectionHead open={isOpen('recent')} onToggle={() => toggle('recent')} icon={<FileClock size={13} className="desk-db-sec-ico" />} title="最近编辑" />
        <Collapsible open={isOpen('recent')}>
          {() => (
            recentList.length === 0
              ? <Empty text="仓库里还没有页面" />
              : (
                <div className="desk-rows">
                  {recentList.map((p) => (
                    <button
                      key={p.id}
                      className="desk-row desk-row-btn"
                      title={p.path ?? p.title}
                      onClick={() => {
                        if (p.path) window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: p.path, from: 'desktop' } }))
                        else onOpen('knowledge')
                      }}
                    >
                      <span className="desk-row-txt">{p.title || p.path || '(未命名)'}</span>
                      <span className="desk-row-meta">{relTime(p.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              )
          )}
        </Collapsible>
      </div>
    </div>
  )
}

/** 日程面板段标题行（图标 + 文字 + 右侧 chevron）。模块作用域，避免每次渲染重挂子树。 */
function DaybookSectionHead({ open, onToggle, icon, title }: { open: boolean; onToggle: () => void; icon: ReactNode; title: string }): ReactNode {
  return (
    <button className="desk-db-sec-head" onClick={onToggle}>
      {icon}
      <span className="desk-db-sec-txt">{title}</span>
      <ChevronRight size={13} className={`kb-chevron${open ? ' is-open' : ''}`} />
    </button>
  )
}

/** 打卡轨迹：GitHub 贡献图风格的长周期热力图（列 = 自然周，行 = 周一…周日） */
function ActivityTile({ today, records, weeks }: { today: string; records: HabitRecord[]; weeks: number }): ReactNode {
  const cells = useMemo(() => {
    const [y, m, d] = today.split('-').map(Number)
    const dow = new Date(y, (m || 1) - 1, d || 1).getDay()
    // 补齐到本周六 → 每一列恰好是「周日…周六」一个自然周
    const start = shiftDays(today, -((weeks * 7 - 1) - (6 - dow)))
    const counts = new Map<string, number>()
    for (const r of records) counts.set(r.date, (counts.get(r.date) ?? 0) + 1)
    const out: Array<{ date: string; lv: number }> = []
    for (let i = 0; i < weeks * 7; i++) {
      const date = shiftDays(start, i)
      const n = counts.get(date) ?? 0
      out.push({ date, lv: n === 0 ? 0 : Math.min(4, n) })
    }
    return out
  }, [today, records, weeks])

  const activeDays = cells.filter((c) => c.lv > 0).length
  return (
    <div className="desk-stack desk-stack-fill">
      <div className="desk-act">
        {cells.map((c) => (
          <i key={c.date} className={c.lv ? `lv${c.lv}` : ''} title={`${c.date}${c.lv ? ` · ${c.lv} 项打卡` : ' · 未打卡'}`} />
        ))}
      </div>
      <div className="desk-act-foot">
        <span>{activeDays} 天有打卡</span>
        <span className="desk-act-legend">
          Less
          <i /><i className="lv1" /><i className="lv2" /><i className="lv3" /><i className="lv4" />
          More
        </span>
      </div>
    </div>
  )
}

/* ==================== 内容控件 ==================== */

const CONTENT_TILES: TileDef[] = [
  {
    key: 'content:clock',
    label: '时钟',
    kind: 'content',
    desc: '当前时间与问候语，跟系统时间走',
    icon: (s) => <Clock size={s} />,
    defaultW: 2,
    defaultH: 2,
    render: () => <ClockTile />,
  },
  {
    key: 'content:calendar',
    label: '月历',
    kind: 'content',
    desc: '本月日历（周一起、带周号）；点日期/周号/月份/年份直达对应日志或总结',
    icon: (s) => <CalendarDays size={s} />,
    defaultW: 2,
    defaultH: 2,
    tail: ({ stats }) => (stats.streak ? `连续 ${stats.streak} 天` : ''),
    render: ({ data }) => <MiniCalendar today={data.today} records={data.records} />,
  },
  {
    key: 'content:daybook',
    label: '日程面板',
    kind: 'content',
    desc: '日历 / 打卡 / 总结 / 最近编辑，可点跳转的一屏日程总览',
    icon: (s) => <CalendarDays size={s} />,
    defaultW: 2,
    defaultH: 5,
    tail: ({ stats }) => (stats.streak ? `连续 ${stats.streak} 天` : ''),
    render: ({ w, h, data, onOpen }) => <DaybookTile w={w} h={h} data={data} onOpen={onOpen} />,
  },
  {
    key: 'content:activity',
    label: '打卡轨迹',
    kind: 'content',
    desc: '近 20 周打卡热力图，磁贴越宽显示的周数越多',
    icon: (s) => <Activity size={s} />,
    defaultW: 3,
    defaultH: 2,
    tail: ({ stats }) => (stats.streak ? `连续 ${stats.streak} 天` : '还没开始'),
    /* 列数跟着宽度走：窄了只放得下 12 周，宽了给到 26 周（半年） */
    render: ({ w, data }) => (
      <ActivityTile today={data.today} records={data.records} weeks={w >= 4 ? 26 : w >= 3 ? 20 : 12} />
    ),
  },
  {
    key: 'content:todo',
    label: '今日待办',
    kind: 'content',
    desc: '今天的任务清单，可以直接在磁贴里勾掉',
    icon: (s) => <ListTodo size={s} />,
    defaultW: 2,
    defaultH: 2,
    tail: ({ stats }) => (stats.todoTotal ? `${stats.todoLeft} 项待完成` : '暂无任务'),
    render: ({ h, data, stats }) => {
      const list = data.todos.filter((t) => t.status !== 'done')
      const done = data.todos.filter((t) => t.status === 'done')
      const rest = [...list, ...done].slice(0, rowsFor(h, 3, 9))
      if (!stats.todoTotal) return <Empty text="今天还没有任务，去日程里加一条" />
      return (
        <div className="desk-rows">
          {rest.map((t) => (
            <button
              key={t.id}
              className={`desk-row desk-row-btn${t.status === 'done' ? ' is-done' : ''}`}
              onClick={() => { void data.toggleTodo(t.id, t.status !== 'done') }}
              title={t.title}
            >
              <span className="desk-check" />
              <span className="desk-row-txt">{t.title}</span>
              {t.time && <span className="desk-row-meta">{t.time}</span>}
            </button>
          ))}
        </div>
      )
    },
  },
  {
    key: 'content:checkin',
    label: '打卡',
    kind: 'content',
    desc: '今天每个习惯打没打，点一下即完成',
    icon: (s) => <CalendarCheck size={s} />,
    defaultW: 2,
    defaultH: 2,
    tail: ({ stats }) => (stats.streak ? `连续 ${stats.streak} 天` : '今天还没打卡'),
    render: ({ h, data, stats }) => {
      if (!stats.habitTotal) return <Empty text="还没有习惯，去日程里建一个" />
      const rows = data.habits.slice(0, rowsFor(h, 3, 8))
      // 这里只管「今天打没打」；本月看月历卡、长周期看打卡轨迹卡 —— 三张卡各管一个时间尺度，不重复
      return (
        <div className="desk-stack">
          <div className="desk-rows">
            {rows.map((hb) => {
              const on = data.records.some((r) => r.habitId === hb.id && r.date === data.today)
              return (
                <button
                  key={hb.id}
                  className={`desk-row desk-row-btn${on ? ' is-done' : ''}`}
                  onClick={() => { void data.toggleHabit(hb.id) }}
                  title={`今天：${on ? '已打卡（点击取消）' : '未打卡（点击完成）'}`}
                >
                  <span className="desk-check" style={on ? { background: hb.color, borderColor: hb.color } : undefined} />
                  <span className="desk-row-txt">{hb.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      )
    },
  },
  {
    key: 'content:recent',
    label: '最近文档',
    kind: 'content',
    desc: '最近改动的文档，点开进编辑器',
    icon: (s) => <FileClock size={s} />,
    defaultW: 2,
    defaultH: 1,
    tail: ({ stats }) => `${stats.pageCount} 篇`,
    render: ({ h, data, onOpen }) => {
      const list = [...data.pages]
        .filter((p) => p.status !== 'draft')
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, rowsFor(h, 2, 6))
      if (!list.length) return <Empty text="仓库里还没有页面" />
      return (
        <div className="desk-rows">
          {list.map((p) => (
            <button
              key={p.id}
              className="desk-row desk-row-btn"
              title={p.path ?? p.title}
              onClick={() => {
                // 有仓库相对路径 → 交给编辑器打开真身；没有（合成的知识页）→ 退回知识库
                if (p.path) window.dispatchEvent(new CustomEvent('kb-open-note', { detail: { relPath: p.path, from: 'desktop' } }))
                else onOpen('knowledge')
              }}
            >
              <span className="desk-row-txt">{p.title || p.path || '(未命名)'}</span>
              <span className="desk-row-meta">{relTime(p.updatedAt)}</span>
            </button>
          ))}
        </div>
      )
    },
  },
  {
    key: 'content:kbstat',
    label: '知识库统计',
    kind: 'content',
    desc: '笔记 / 附件 / 目录 / 标签 四个数字',
    icon: (s) => <PieChart size={s} />,
    defaultW: 2,
    defaultH: 1,
    /* 四个数字横排（笔记 / 附件 / 目录 / 标签）—— 2 格宽才排得下，故 defaultW 从 1 提到 2 */
    render: ({ stats }) => (
      <div className="desk-figs">
        <div className="desk-fig"><b>{stats.pageCount}</b><span>笔记</span></div>
        <div className="desk-fig"><b>{stats.attachCount}</b><span>附件</span></div>
        <div className="desk-fig"><b>{stats.dirCount}</b><span>目录</span></div>
        <div className="desk-fig"><b>{stats.tagCount}</b><span>标签</span></div>
      </div>
    ),
  },
  {
    key: 'content:dirs',
    label: '知识库目录',
    kind: 'content',
    desc: '顶层目录，点一下跳到知识库对应位置',
    icon: (s) => <FolderTree size={s} />,
    defaultW: 2,
    defaultH: 1,
    tail: ({ stats }) => `${stats.dirCount} 个`,
    render: ({ h, data, onOpen }) => {
      const list = data.categories.filter((c) => !c.parentId).slice(0, rowsFor(h, 2, 6))
      if (!list.length) return <Empty text="还没有目录" />
      return (
        <div className="desk-rows">
          {list.map((c) => (
            <button
              key={c.id}
              className="desk-row desk-row-btn"
              onClick={() => {
                onOpen('knowledge')
                window.setTimeout(() => window.dispatchEvent(new CustomEvent('kb-locate-knowledge-category', { detail: { categoryId: c.id } })), 100)
              }}
            >
              <span className="desk-dot" />
              <span className="desk-row-txt">{c.name}</span>
            </button>
          ))}
        </div>
      )
    },
  },
  {
    key: 'content:feed',
    label: '说说速记',
    kind: 'content',
    desc: '最近几条说说，点开进说说模块',
    was: '说说',
    icon: (s) => <MessageSquare size={s} />,
    defaultW: 2,
    defaultH: 1,
    tail: ({ data }) => `${data.moments.length} 条`,
    render: ({ h, data, onOpen }) => {
      const list = [...data.moments]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, rowsFor(h, 1, 3))
      return (
        <div className="desk-stack">
          {list.length === 0 && <Empty text="还没有说说" />}
          {list.map((m) => (
            <button key={m.id} className="desk-quote" onClick={() => onOpen('moments')} title="打开说说">
              <span className="desk-quote-txt">{m.contentMd.replace(/[#*`>[\]]/g, '').slice(0, 60) || '(空)'}</span>
              <span className="desk-row-meta">{relTime(m.createdAt)}</span>
            </button>
          ))}
          <button className="desk-quote desk-quote-new" onClick={() => onOpen('moments')}>
            记一句…
          </button>
        </div>
      )
    },
  },
]

/* ==================== 模块控件 ==================== */

interface ModuleDef {
  tab: TabName
  label: string
  /** 面板里那句话说明：这个模块是干什么的（磁贴本身只是入口） */
  desc: string
  icon: (size: number) => ReactNode
}

/** 每个模块磁贴「画什么图标 + 一句话说明」（成员与顺序看 appModules 的 `tile` 标记） */
const TILE_META: Record<string, { desc: string; icon: (size: number) => ReactNode }> = {
  editor: { desc: '仓库文件树', icon: (s) => <EditorIcon size={s} /> },
  knowledge: { desc: '页面 / 目录 / 标签', icon: (s) => <KnowledgeIcon size={s} /> },
  blog: { desc: '写与整理博客', icon: (s) => <BlogIcon size={s} /> },
  schedule: { desc: '任务与日历', icon: (s) => <ScheduleIcon size={s} /> },
  moments: { desc: '发布与回顾', icon: (s) => <MomentsIcon size={s} /> },
  aiTeaching: { desc: '讲义 / 研读 / 出题', icon: (s) => <AiTeachingIcon size={s} /> },
  toolbox: { desc: '零散小工具', icon: (s) => <ToolboxIcon size={s} /> },
  plugins: { desc: '已装插件管理', icon: (s) => <PluginIcon size={s} /> },
  recycle: { desc: '找回删掉的内容', icon: (s) => <Trash2 size={s} /> },
  help: { desc: '使用说明与快捷键', icon: (s) => <LifeBuoy size={s} /> },
  user: { desc: '个人信息', icon: (s) => <UserIcon size={s} /> },
  releaseNotes: { desc: '每个版本改了什么', icon: (s) => <History size={s} /> },
  settings: { desc: '全部设置项', icon: (s) => <SettingsIcon size={s} /> },
}

/**
 * 桌面「添加控件」面板里的模块磁贴清单。
 *
 * 旧实现在这里独立声明了一份 13 项的字面量，注释还写着「新增模块时三处都要补」——
 * 那份注释描述的正是问题本身。现在**只保留图标与说明**，成员与顺序一律来自
 * `lib/appModules` 的唯一真相源（`tile` 标记），新增模块只需在真相源里标一个 `tile: true`。
 */
export const DESK_MODULES: ModuleDef[] = TILE_MODULE_IDS.map((tab) => ({
  tab,
  label: labelOf(tab),
  ...TILE_META[tab],
}))

/** 模块磁贴右侧小字：只给「有真实数字可说」的几个模块，其余留白（不编造占位） */
function moduleTail(tab: TabName, stats: DerivedStats, data: DesktopData): string {
  switch (tab) {
    case 'schedule': return stats.todoTotal ? `${stats.todoLeft} 项今日` : '今日无任务'
    case 'knowledge': return `${stats.pageCount} 页 · ${stats.dirCount} 目录`
    case 'moments': return `${data.moments.length} 条`
    case 'editor': return 'Vault 文件'
    case 'aiTeaching': return '讲义 / 研读 / 出题'
    default: return ''
  }
}

const MODULE_TILES: TileDef[] = DESK_MODULES.map((m) => ({
  key: `module:${m.tab}`,
  label: m.label,
  desc: m.desc,
  kind: 'module' as const,
  icon: m.icon,
  defaultW: 1,
  defaultH: 1,
  tail: (ctx) => moduleTail(m.tab, ctx.stats, ctx.data),
  render: ({ w, h, stats, data, onOpen }) => {
    // 1×1：只放图标 + 名字（对齐原型里的「入口感」）
    if (w === 1 && h === 1) {
      return (
        <div className="desk-center">
          <span className="desk-center-ico">{m.icon(22)}</span>
          <span className="desk-center-txt">{m.label}</span>
        </div>
      )
    }
    const tail = moduleTail(m.tab, stats, data)
    return (
      <div className="desk-stack">
        {tail && <div className="desk-hint">{tail}</div>}
        <div className="desk-offer">
          <span className="desk-offer-txt">点击进入 {m.label}</span>
          <span className="desk-offer-arrow">→</span>
        </div>
      </div>
    )
  },
}))

/* ==================== 查表 ==================== */

export const ALL_TILES: TileDef[] = [...CONTENT_TILES, ...MODULE_TILES]

/** 未知 key 退回「模块」样貌：宁可显示一个打不开的格子，也不要整块桌面崩掉 */
const FALLBACK: TileDef = {
  key: 'unknown',
  label: '未知控件',
  desc: '这个控件在本版本里已经不存在了',
  kind: 'module',
  icon: (s) => <LayoutGrid size={s} />,
  defaultW: 1,
  defaultH: 1,
  render: () => <Empty text="该控件已不存在" />,
}

export function defOf(key: string): TileDef {
  return ALL_TILES.find((t) => t.key === key) ?? FALLBACK
}

/** 默认预设里出现、但当前版本已没有的 key —— 用于「清理失效控件」 */
export function isKnownKey(key: string): boolean {
  return ALL_TILES.some((t) => t.key === key)
}
