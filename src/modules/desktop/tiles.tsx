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

/** 月历卡：可翻月；今天圆角高亮；有打卡的日子带点 */
function CalendarTile({ today, records }: { today: string; records: HabitRecord[] }): ReactNode {
  const [off, setOff] = useState(0)
  const [ty, tm, td] = today.split('-').map(Number)
  const view = new Date(ty, (tm || 1) - 1 + off, 1)
  const y = view.getFullYear()
  const m = view.getMonth()

  const cells: Array<number | null> = []
  const firstDow = new Date(y, m, 1).getDay()
  const dayCount = new Date(y, m + 1, 0).getDate()
  for (let i = 0; i < firstDow; i++) cells.push(null)
  for (let d = 1; d <= dayCount; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const isToday = (d: number): boolean => off === 0 && y === ty && m === (tm || 1) - 1 && d === td
  const checkedOn = (d: number): boolean => hasCheckOn(records, `${y}-${pad2(m + 1)}-${pad2(d)}`)

  return (
    <div className="desk-cal">
      <div className="desk-cal-head">
        <button className="desk-cal-nav" onClick={() => setOff((v) => v - 1)} title="上个月"><ChevronLeft size={13} /></button>
        <span className="desk-cal-title">{y} 年 {m + 1} 月</span>
        <button className="desk-cal-nav" onClick={() => setOff((v) => v + 1)} title="下个月"><ChevronRight size={13} /></button>
        {off !== 0 && (
          <button className="desk-cal-back" onClick={() => setOff(0)} title="回到本月">今天</button>
        )}
      </div>
      <div className="desk-cal-grid">
        {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
          <span key={w} className="desk-cal-wd">{w}</span>
        ))}
        {cells.map((d, i) => (
          <span
            key={i}
            className={`desk-cal-cell${d === null ? ' is-blank' : ''}${d !== null && isToday(d) ? ' is-today' : ''}${d !== null && checkedOn(d) ? ' is-marked' : ''}`}
            title={d === null ? undefined : checkedOn(d) ? '这天有打卡' : undefined}
          >
            {d ?? ''}
          </span>
        ))}
      </div>
    </div>
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
    desc: '本月日历，今日高亮；可翻月、点「今天」回来',
    icon: (s) => <CalendarDays size={s} />,
    defaultW: 2,
    defaultH: 2,
    tail: ({ stats }) => (stats.streak ? `连续 ${stats.streak} 天` : ''),
    render: ({ data }) => <CalendarTile today={data.today} records={data.records} />,
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
                if (p.path) window.dispatchEvent(new CustomEvent('kb-open-in-editor', { detail: { relPath: p.path, from: 'desktop' } }))
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

/**
 * 模块清单（与 `ActivityBar` 的 ALL_MODULES / `App` 的 MODULE_TABS 同源，
 * 此处独立声明一份：那两处在 React 树的上游，从桌面模块反向 import 会形成循环依赖。
 * 新增模块时三处都要补 —— 已记进任务清单。）
 */
export const DESK_MODULES: ModuleDef[] = [
  { tab: 'editor', label: '编辑器', desc: '仓库文件树', icon: (s) => <EditorIcon size={s} /> },
  { tab: 'knowledge', label: '知识库', desc: '页面 / 目录 / 标签', icon: (s) => <KnowledgeIcon size={s} /> },
  { tab: 'blog', label: '博客', desc: '写与整理博客', icon: (s) => <BlogIcon size={s} /> },
  { tab: 'schedule', label: '日程', desc: '任务与日历', icon: (s) => <ScheduleIcon size={s} /> },
  { tab: 'moments', label: '说说', desc: '发布与回顾', icon: (s) => <MomentsIcon size={s} /> },
  { tab: 'aiTeaching', label: 'AI教学', desc: '讲义 / 研读 / 出题', icon: (s) => <AiTeachingIcon size={s} /> },
  { tab: 'toolbox', label: '工具箱', desc: '零散小工具', icon: (s) => <ToolboxIcon size={s} /> },
  { tab: 'plugins', label: '插件', desc: '已装插件管理', icon: (s) => <PluginIcon size={s} /> },
  { tab: 'recycle', label: '回收站', desc: '找回删掉的内容', icon: (s) => <Trash2 size={s} /> },
  { tab: 'help', label: '帮助', desc: '使用说明与快捷键', icon: (s) => <LifeBuoy size={s} /> },
  { tab: 'user', label: '账户', desc: '个人信息', icon: (s) => <UserIcon size={s} /> },
  { tab: 'releaseNotes', label: '更新说明', desc: '每个版本改了什么', icon: (s) => <History size={s} /> },
  { tab: 'settings', label: '设置', desc: '全部设置项', icon: (s) => <SettingsIcon size={s} /> },
]

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
