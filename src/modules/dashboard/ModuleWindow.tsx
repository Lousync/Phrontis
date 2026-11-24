import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, GraduationCap } from 'lucide-react'
import type { DashboardSnapshot, ProviderQuotaView, TabName } from '../../types'
import { labelOf } from '../../lib/appModules'
import { exactTokens, fmtTokens } from '../../lib/numFormat'
import { QUOTA_FAIL_TEXT, fmtCountdown, windowLevel } from '../usage/usageModel'

/**
 * 看板右列的三个「模块窗口」（2026-11-14 首页重做；在读数 → AI 用量）。
 *
 * 为什么是「窗口」而不是入口条：首页上用户真正想做的是**回到刚才那一篇 / 那一段**，
 * 不是「进入工作台」这个动作。所以窗口里直接给出可点的内容（页签 / 当前课程 / 用量数字），
 * 底部再留一整行进入模块本身 —— 一个组件同时承担预览与入口，不额外造一个按钮。
 * 第三张卡（`grow`）吃掉右列的剩余高度，右列底边因此与左侧主体对齐（2026-11-14）。
 */

/* ==================== 共用外壳 ==================== */

function WindowShell({ name, meta, children, footer, grow = false, delay = 0 }: {
  name: string
  meta: string
  children: ReactNode
  footer?: ReactNode
  /** 吃掉父容器的剩余高度（右列最后一张卡；右列底边 = 左列底边） */
  grow?: boolean
  delay?: number
}) {
  return (
    <div
      className={`kb-item-in flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-[var(--border-color)] bg-[var(--card-bg)] shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent)_34%,var(--border-color))] hover:shadow-[0_8px_22px_rgba(20,35,25,0.08)] ${grow ? 'flex-1' : 'flex-none'}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-[11px] py-[7px]">
        <span aria-hidden className="flex gap-1">
          <i className="h-[7px] w-[7px] rounded-full bg-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" />
          <i className="h-[7px] w-[7px] rounded-full bg-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" />
          <i className="h-[7px] w-[7px] rounded-full bg-[color-mix(in_srgb,var(--text-primary)_16%,transparent)]" />
        </span>
        <span className="text-[9.5px] font-semibold tracking-[0.02em] text-[var(--text-secondary)]">{name}</span>
        <span className="ml-auto text-[8.5px] text-[var(--text-muted)]">{meta}</span>
      </div>
      {children}
      {footer}
    </div>
  )
}

/** 窗口底部整行入口（工作台 / 用量共用，避免两处各抄一遍样式） */
function WindowFooter({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/foot mt-auto flex flex-none items-center justify-between gap-2 border-t border-[var(--border-color)] px-[13px] py-[9px] text-[10px] font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
    >
      {label}
      <ArrowRight size={13} className="text-[var(--text-muted)] transition-colors group-hover/foot:text-[var(--accent)]" />
    </button>
  )
}

/* ==================== AI 教学窗口 ==================== */

export function AiCourseWindow({ course, onOpen, delay }: {
  course: DashboardSnapshot['course']
  onOpen: () => void
  delay?: number
}) {
  if (!course) {
    return (
      <WindowShell name="AI 教学" meta="未开始" delay={delay}>
        <div className="flex flex-col gap-2 px-[11px] pb-[11px] pt-2.5">
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">还没有课程大纲。建一门课，今天就能开始第一段。</p>
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex h-[25px] w-fit items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 text-[9.5px] font-semibold text-white transition-transform hover:-translate-y-px"
          >
            <GraduationCap size={12} /> 打开 AI 教学
          </button>
        </div>
      </WindowShell>
    )
  }

  return (
    <WindowShell name="AI 教学" meta={`第 ${course.chapterIndex}/${course.chapterCount} 章`} delay={delay}>
      <button type="button" onClick={onOpen} className="flex flex-col gap-2 px-[11px] pb-[11px] pt-2.5 text-left">
        <span
          className="flex flex-col gap-0.5 rounded-[9px] px-2.5 pb-2.5 pt-2 text-white"
          style={{ background: 'linear-gradient(140deg, var(--accent), var(--accent-hover))' }}
        >
          <span className="text-[7.5px] uppercase tracking-[0.1em] opacity-80">{course.wsName} · {course.chapterTitle}</span>
          <b className="text-[13.5px] font-bold leading-snug tracking-[-0.01em]">{course.unitTitle}</b>
          <span className="text-[8.5px] opacity-85">已完成 {course.pct}%</span>
        </span>
        {course.unitGoal && (
          <span className="line-clamp-2 text-[9px] leading-[1.55] text-[var(--text-muted)]">{course.unitGoal}</span>
        )}
        <span className="mt-0.5 inline-flex h-[25px] w-fit items-center rounded-full bg-[var(--accent)] px-3 text-[9.5px] font-semibold text-white">
          继续这一段
        </span>
      </button>
    </WindowShell>
  )
}

/* ==================== 工作台窗口 ==================== */

export function WorkbenchWindow({ tabs, lastTab, onOpenTab, onOpenWorkbench, delay }: {
  tabs: TabName[]
  lastTab: TabName | null
  onOpenTab: (tab: TabName) => void
  onOpenWorkbench: () => void
  delay?: number
}) {
  const shown = tabs.slice(0, 4)
  return (
    <WindowShell
      name="工作台"
      meta={tabs.length ? `${tabs.length} 个标签` : '空'}
      delay={delay}
      footer={<WindowFooter label="打开工作台" onClick={onOpenWorkbench} />}
    >
      <div className="flex flex-col gap-px p-1.5">
        {shown.length === 0 && (
          <span className="px-2 py-2 text-[10px] text-[var(--text-muted)]">还没有打开的标签。</span>
        )}
        {shown.map((tab) => {
          const isLast = lastTab ? tab === lastTab : tab === shown[0]
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onOpenTab(tab)}
              data-tip={`打开「${labelOf(tab)}」`} aria-label={`打开「${labelOf(tab)}」`}
              className={`flex w-full items-center gap-[7px] rounded-[7px] px-[7px] py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${isLast ? 'bg-[var(--bg-hover)]' : ''}`}
            >
              <i aria-hidden className={`h-[5px] w-[5px] flex-none rounded-full ${isLast ? 'bg-[var(--accent)]' : 'bg-[color-mix(in_srgb,var(--text-primary)_18%,transparent)]'}`} />
              <span className={`min-w-0 flex-1 truncate text-[10px] ${isLast ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                {labelOf(tab)}
              </span>
              {isLast && <span className="flex-none text-[8px] text-[var(--text-muted)]">上次</span>}
            </button>
          )
        })}
        {tabs.length > shown.length && (
          <span className="px-[7px] py-1 text-[8.5px] text-[var(--text-muted)]">还有 {tabs.length - shown.length} 个</span>
        )}
      </div>
    </WindowShell>
  )
}

/* ==================== AI 用量 ==================== */

/** 额度档配色与用量模块同一套（ok / warn / hot），不另造色彩口径 */
const QUOTA_LEVEL_COLOR: Record<'ok' | 'warn' | 'hot', string> = {
  ok: 'var(--accent)',
  warn: 'var(--warning)',
  hot: 'var(--danger)',
}

/** 迷你柱图横轴标签（`Date.getDay()` 序） */
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/**
 * AI 用量窗口（2026-11-14 替换「在读」）。
 *
 * 三段：今天的 token 与调用次数（快照给，跟页面一起到）→ 近 7 天迷你柱图（柱子随卡片
 * 剩余高度伸缩）→ **套餐额度条**（`llm:quota:get` 单独拉 —— 额度要联网，不能拖慢首屏；
 * 主进程有 5 分钟缓存）。余额类（没有分母）只写一行金额，不画进度条 —— 画了也是假的进度。
 */
export function AiUsageWindow({ aiUsage, quota, onOpenUsage, delay }: {
  aiUsage: DashboardSnapshot['aiUsage']
  /** 激活账户的额度视图；null = 还在查 */
  quota: ProviderQuotaView[] | null
  onOpenUsage: () => void
  delay?: number
}) {
  const windows = (quota ?? []).flatMap((v) =>
    v.ok && v.kind === 'windows'
      ? v.windows.map((w) => ({ ...w, key: `${v.accountId}:${w.key}`, name: v.providerName }))
      : [],
  )
  const balances = (quota ?? []).flatMap((v) =>
    v.ok && v.kind === 'money'
      ? v.balances.map((b, i) => ({ key: `${v.accountId}:${i}`, name: v.providerName, ...b }))
      : [],
  )
  const failed = (quota ?? []).find((v) => !v.ok)
  const emptyText = quota === null
    ? '查询额度…'
    : failed && !failed.ok
      ? QUOTA_FAIL_TEXT[failed.reason]
      : '未配置额度接口'
  const peak = Math.max(1, ...aiUsage.last7.map((d) => d.tokens))
  const hasTrend = aiUsage.last7.some((d) => d.tokens > 0)
  // 柱高用**实测像素**而不是百分比：柱区高度是 flex 分配出来的，`height: %` 在这里
  // 解析不出确定高度（实测整排柱高 0、只剩星期字），所以量一次再算像素。
  const [trackH, setTrackH] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)
  const setTrack = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const read = () => setTrackH(el.clientHeight)
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    roRef.current = ro
  }, [])

  return (
    <WindowShell
      name="AI 用量"
      meta="今日"
      grow
      delay={delay}
      footer={<WindowFooter label="打开用量" onClick={onOpenUsage} />}
    >
      {/* 容器查询宿主：窄 / 矮时整块隐去「近 7 天」（细则与阈值见 index.css §⑨） */}
      <div className="kb-aiusage flex min-h-0 flex-1 flex-col gap-2.5 px-[11px] pb-[11px] pt-2.5">
        <div className="flex-none">
          <div className="flex items-baseline gap-1.5">
            <b
              data-tip={exactTokens(aiUsage.todayTokens)} aria-label={exactTokens(aiUsage.todayTokens)}
              className="text-[20px] font-bold leading-none tracking-[-0.02em] tabular-nums text-[var(--text-primary)]"
            >
              {fmtTokens(aiUsage.todayTokens)}
            </b>
            <span className="text-[9px] text-[var(--text-muted)]">tokens</span>
          </div>
          <div className="mt-1 text-[8.5px] text-[var(--text-muted)]">{aiUsage.todayCalls} 次调用</div>
        </div>

        {/* 近 7 天：柱高按峰值归一，最后一根 = 今天（强调色）。柱子随卡片余高伸缩，
            高窗口下第三卡不会只剩一大块空白；全 0 时退化成一句空态，不画一排看不见的柱。
            ⚠️ 窄 / 矮态整块隐去（标签 + 柱 + 星期 + 悬停提示一起走），阈值见 index.css §⑨：
            7 根柱挤到不足 ~13px 一根、或柱区连「标签 + 柱 + 星期」都放不下时，画出来只是噪声。 */}
        <div className="kb-aiusage-trend flex min-h-[44px] flex-1 flex-col gap-1">
          <span className="flex-none text-[8px] text-[var(--text-muted)]">近 7 天</span>
          {hasTrend ? (
            <>
              <div ref={setTrack} className="flex min-h-0 flex-1 items-end gap-[5px]">
                {aiUsage.last7.map((d, i) => {
                  const isToday = i === aiUsage.last7.length - 1
                  const px = trackH > 0 && d.tokens > 0 ? Math.max(3, Math.round((d.tokens / peak) * trackH)) : 0
                  return (
                    <div
                      key={d.date}
                      data-tip={`${d.date} · ${exactTokens(d.tokens)} tokens`}
                      className="min-w-0 flex-1 rounded-t-[3px]"
                      style={{
                        height: `${px || 2}px`,
                        background: px
                          ? (isToday ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 34%, var(--bg-hover))')
                          : 'var(--bg-hover)',
                      }}
                    />
                  )
                })}
              </div>
              <div className="flex flex-none gap-[5px]">
                {aiUsage.last7.map((d, i) => {
                  const isToday = i === aiUsage.last7.length - 1
                  return (
                    <span
                      key={d.date}
                      className={`min-w-0 flex-1 text-center text-[7.5px] leading-none ${isToday ? 'font-semibold text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                    >
                      {WEEKDAY[new Date(`${d.date}T00:00:00`).getDay()]}
                    </span>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center text-[8.5px] text-[var(--text-muted)]">近 7 天还没有用量</div>
          )}
        </div>

        {/* 额度：只画有上限的套餐窗口；余额没有分母，一行金额即可。
            ⚠️ 只做**纵向**滚动：`overflow-y-auto` 会把 `overflow-x: visible` 计算成 `auto`
            （CSS Overflow 3 §3.3），那个盒子里一旦有 1px 横向富余就会画出一条横向滑动手柄
            —— 显式 `overflow-x: clip` 把 x 轴彻底从滚动容器里摘掉（内容本身已可收缩，见下面
            两处 `min-w-0`），不是拿遮罩盖滚动条。 */}
        <div className="kb-aiusage-quota flex min-h-0 shrink flex-col gap-2 overflow-x-clip overflow-y-auto border-t border-[var(--border-color)] pt-2">
          {windows.map((w) => {
            const lv = windowLevel(w)
            const cd = fmtCountdown(w.resetsAt)
            return (
              <div key={w.key}>
                <div className="flex items-baseline justify-between gap-2 text-[8.5px]">
                  <span className="min-w-0 truncate text-[var(--text-secondary)]">{w.name} · {w.label}</span>
                  <span className="flex-none tabular-nums" style={{ color: lv === 'ok' ? 'var(--text-secondary)' : QUOTA_LEVEL_COLOR[lv] }}>
                    {w.percent}%{lv === 'hot' ? ' · 限速中' : ''}
                  </span>
                </div>
                <div className="mt-[3px] h-[4px] overflow-hidden rounded-full bg-[var(--bg-hover)]">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(100, w.percent)}%`, background: QUOTA_LEVEL_COLOR[lv] }} />
                </div>
                {cd && <div className="mt-[2px] text-[8px] text-[var(--text-muted)]">{cd}后重置</div>}
              </div>
            )
          })}
          {balances.map((b) => (
            <div key={b.key} className="flex items-baseline justify-between gap-2 text-[8.5px]">
              <span className="min-w-0 truncate text-[var(--text-secondary)]">{b.name} 余额</span>
              <span className="flex-none tabular-nums text-[var(--text-primary)]">{b.total} {b.currency}</span>
            </div>
          ))}
          {windows.length === 0 && balances.length === 0 && (
            <span className="text-[8.5px] leading-relaxed text-[var(--text-muted)]">{emptyText}</span>
          )}
        </div>
      </div>
    </WindowShell>
  )
}
