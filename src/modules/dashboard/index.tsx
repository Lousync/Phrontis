import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, SlidersHorizontal, Check, Pencil, Puzzle } from 'lucide-react'
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
  Card, CardBody, RANGE_LABEL,
  type CardBg, type CardDef, type RangeKey,
} from './cards'

/**
 * 看板模块（2026-09-27）—— 左栏书签入口 + **整窗**。
 *
 * 落点：在 `WORKBENCH_TABBAR_EXCLUDED` 里，所以没有左右栏、没有页面条，
 * 中间栏整个归它，且不产生标签页。返回工作台的唯一出口是左上角那个箭头。
 *
 * 数据：主进程一次聚合（`dashboard:getSnapshot`）—— 见 database/repositories/dashboardRepo.ts。
 * 刷新：订阅相关 scope，任一域变化就整体重取（快照本身就是一次读，增量刷新没意义）。
 *
 * 视觉：中央轴构图（居中 hero + 单一重心主卡 + 3 列卫星卡）。
 * 动效一律用现有令牌（`.kb-view-in` / `.kb-item-in` / `.kb-pop`），不另造过渡。
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
 *  必须订阅事件 —— 与 knowledge/index.tsx:236 同款走法。 */
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
  const [range, setRange] = useState<RangeKey>('today')
  const [popOpen, setPopOpen] = useState(false)

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
  const shown = useMemo(() => {
    try {
      const v = JSON.parse(s.dashboardCards || '')
      if (Array.isArray(v)) return new Set(v.map(String))
    } catch { /* 坏数据走默认 */ }
    return new Set(DEFAULT_CARD_IDS)
  }, [s.dashboardCards])

  // 插件控件清单：全局 id = `<pluginId>:<wid>`（清单为空 = 无贡献，界面零侵入）
  const widgets = usePluginWidgets()
  const widgetIdOf = (w: PluginDashboardWidget) => `${w.pluginId}:${w.wid}`

  const toggleCard = (id: string) => {
    const wanted = new Set(shown)
    if (wanted.has(id)) wanted.delete(id); else wanted.add(id)
    // 存回时内置卡按注册表序归一；插件控件 id 不在 CARD_REGISTRY 里，原样保留
    //（不查 widgets 清单 —— 那是异步的，归一化依赖它会漏勾。卸载插件的残留 id 渲染侧过滤，无害）
    const builtinIds = new Set(CARD_REGISTRY.map((c) => c.id))
    const ordered = [
      ...CARD_REGISTRY.filter((c) => wanted.has(c.id)).map((c) => c.id),
      ...[...wanted].filter((v) => !builtinIds.has(v)),
    ]
    void update('dashboardCards', JSON.stringify(ordered))
  }

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

  if (!snap) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-[var(--text-muted)]">
        正在载入看板…
      </div>
    )
  }

  const d = new Date()
  const dateLine = `${d.getFullYear()} · ${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getDate()).padStart(2, '0')} 星期${WEEKDAY[d.getDay()]}`
  const openTodos = [...snap.todos.overdue.map((t) => ({ ...t, late: true })), ...snap.todos.today.map((t) => ({ ...t, late: false }))]
  // 紧凑档主卡待办限 4 条（两栏 2 行），超出收「去日程」（拍板①：原地展开会重新顶出滚动条）
  const shownTodos = compact ? openTodos.slice(0, 4) : openTodos
  const hiddenTodoCount = openTodos.length - shownTodos.length
  const usageHours = Math.round(Object.values(snap.usage.days).slice(-(range === 'today' ? 1 : range === 'week' ? 7 : 30)).reduce((a, b) => a + b, 0) / 60)
  const donePct = snap.todos.totalToday > 0 ? Math.round((snap.todos.doneToday / snap.todos.totalToday) * 100) : 0

  return (
    <div className="relative h-full">
      {/* 主题氛围特效：垫底画布（内容层 z-[1] 压在其上） */}
      <ThemeFxLayer />
      <div className="relative z-[1] h-full overflow-y-auto">
        <div className={`mx-auto max-w-[1200px] px-6 ${compact ? 'pb-5 pt-2.5' : 'pb-14 pt-5'}`}>

        {/* 顶栏：返回箭头在左，口径与编辑卡片在右 */}
        <div className="mb-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            title="返回工作台"
            className="rounded-[8px] border border-[var(--border-color)] px-2 py-1.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="flex-1" />
          <div className="flex rounded-[8px] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-0.5">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-md px-2.5 py-1 text-[11.5px] transition-colors ${range === r ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setPopOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-[8px] bg-[var(--accent)] px-3 py-1.5 text-xs text-white transition-colors hover:brightness-110"
            >
              <SlidersHorizontal size={12} />编辑卡片
            </button>
            {popOpen && (
              <>
                {/* 点空白关掉 */}
                <span className="fixed inset-0 z-20" onClick={() => setPopOpen(false)} />
                <div className="kb-pop absolute right-0 top-[calc(100%+7px)] z-30 w-[238px] rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2 shadow-2xl">
                  <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-[var(--text-muted)]">卡片背景</div>
                  <div className="mb-1 flex w-full rounded-[8px] border border-[var(--border-color)] bg-[var(--bg-primary)] p-0.5">
                    {CARD_BG_OPTIONS.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => void update('dashboardBg', o.id)}
                        className={`flex-1 rounded-md px-1 py-1 text-[11px] transition-colors ${bg === o.id ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-[var(--text-muted)]">显示哪些卡片</div>
                  {CARD_REGISTRY.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleCard(c.id)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)]"
                    >
                      <span
                        className="grid h-[15px] w-[15px] flex-none place-items-center rounded-[4px] border"
                        style={shown.has(c.id)
                          ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
                          : { borderColor: 'var(--text-muted)', color: 'transparent' }}
                      >
                        <Check size={10} />
                      </span>
                      <span>{c.label}</span>
                    </button>
                  ))}
                  {widgets.length > 0 && (
                    <>
                      <div className="px-2 pb-1 pt-1.5 text-[10.5px] text-[var(--text-muted)]">插件控件</div>
                      {widgets.map((w) => (
                        <button
                          key={widgetIdOf(w)}
                          type="button"
                          onClick={() => toggleCard(widgetIdOf(w))}
                          title={widgetIdOf(w)}
                          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)]"
                        >
                          <span
                            className="grid h-[15px] w-[15px] flex-none place-items-center rounded-[4px] border"
                            style={shown.has(widgetIdOf(w))
                              ? { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }
                              : { borderColor: 'var(--text-muted)', color: 'transparent' }}
                          >
                            <Check size={10} />
                          </span>
                          <span className="truncate">{w.title}</span>
                          <span className="ml-auto flex-none text-[10px] text-[var(--text-disabled)]">插件</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
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
              <b className="mr-0.5 font-semibold tabular-nums text-[var(--text-primary)]">{openTodos.length}</b>件待办
            </span>
            <span className="border-r border-[var(--border-color)] px-4 py-1 text-xs text-[var(--text-muted)]">
              <b className="mr-0.5 font-semibold tabular-nums text-[var(--text-primary)]">{usageHours}</b>小时使用
            </span>
            <span className="px-4 py-1 text-xs text-[var(--text-muted)]">
              <b className="mr-0.5 font-semibold tabular-nums text-[var(--text-primary)]">{snap.habit.streak}</b>天连续
            </span>
          </div>
        </header>

        {/* 主卡：全页唯一重心（强调描边 + 光晕 + 大号水印）。紧凑档 p-3 + 待办限 4 条（反馈 3） */}
        <section
          className={`kb-view-in relative overflow-hidden rounded-[14px] border ${compact ? 'p-3' : 'p-4'}`}
          style={{
            borderColor: 'color-mix(in srgb, var(--accent) 42%, var(--border-color))',
            backgroundImage: `linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, var(--card-bg)), var(--card-bg))`,
            boxShadow: '0 0 0 5px var(--accent-glow)',
            animationDelay: '170ms',
          }}
        >
          <span aria-hidden className="pointer-events-none absolute -bottom-14 -right-11 opacity-[0.08] [html.theme-light_&]:opacity-[0.05]" style={{ color: 'var(--accent)' }}>
            <Check size={168} />
          </span>
          <div className={`relative z-[1] flex items-center gap-2 ${compact ? 'mb-1.5' : 'mb-2'}`}>
            <b className="text-[13px] font-semibold text-[var(--text-primary)]">今天该做的</b>
            <span className="rounded-full px-2 py-px text-[10.5px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              {openTodos.length} 件待处理
            </span>
            <span className="text-[10.5px] text-[var(--text-muted)]">常驻主卡，不参与卡片勾选</span>
          </div>

          {openTodos.length === 0 ? (
            <div className="relative z-[1] py-3 text-[12.5px] text-[var(--text-muted)]">今天没有待办，清爽一天。</div>
          ) : (
            <>
              <div className="relative z-[1] gap-x-8 sm:columns-2">
                {shownTodos.map((t) => (
                  <div key={t.id} className="flex items-start gap-2.5 break-inside-avoid rounded-md py-1.5 hover:bg-[var(--bg-hover)]">
                    <button
                      type="button"
                      onClick={() => void markDone(t.id)}
                      title="标记完成"
                      className="mt-0.5 grid h-[15px] w-[15px] flex-none place-items-center rounded-[4px] border-[1.5px] border-[var(--text-muted)] text-transparent transition-colors hover:border-[var(--accent)]"
                    >
                      <Check size={10} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-[12.5px] ${t.late ? 'text-[var(--danger-ink)]' : 'text-[var(--text-primary)]'}`}>{t.title}</div>
                      <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                        {t.time && <span>{t.time}</span>}
                        {t.late && <span className="rounded-full px-1.5" style={{ background: 'var(--danger-bg)', color: 'var(--danger-ink)' }}>逾期</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {hiddenTodoCount > 0 && (
                <button
                  type="button"
                  onClick={onJumpSchedule}
                  title="去日程处理剩余待办"
                  className="relative z-[1] mt-1 rounded-md px-1 py-0.5 text-[11.5px] text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
                >
                  还有 {hiddenTodoCount} 件未处理 → 去日程
                </button>
              )}
            </>
          )}

          <div className={`relative z-[1] flex items-center gap-3 border-t border-[var(--border-color)] text-[11.5px] text-[var(--text-muted)] ${compact ? 'mt-2 pt-2' : 'mt-3 pt-3'}`}>
            <span>{snap.todos.doneToday}/{snap.todos.totalToday} 已完成</span>
            <span className="block h-1 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
              <i className="block h-full rounded-full bg-[var(--accent)] transition-[width] duration-300" style={{ width: `${donePct}%` }} />
            </span>
          </div>
        </section>

        {/* 其余卡片：3 列铺开，避免中央轴窄栏在宽屏下两侧留白过大。
            「其余」分隔行已随看板方案 §5 反馈 4③ 删除（2026-09-27）—— 主卡与卡片区直接相接。 */}
        <div className={`grid grid-cols-3 gap-3 ${compact ? 'mt-4' : 'mt-5'}`}>
          {CARD_REGISTRY.filter((c) => shown.has(c.id)).map((c) => (
            <Card key={c.id} def={c} bg={bg}>
              <CardBody def={c} snap={snap} range={range} compact={compact}
                onToggleHabit={toggleHabit} onOpenNote={openNote} onOpenBook={onOpenBook} />
            </Card>
          ))}
          {/* 插件控件卡（2026-09-28 底层基建）：沙箱 iframe 复用 PluginFrame（数据桥/主题变量白拿），
              正文固定 150px —— 比内置卡 min-h 92 高，宽卡（span>1）+ 固定高即「大卡」体感。
              显示条件 = 用户勾过（setting dashboardCards）∧ 清单在场（插件被卸载/停用即自然消失）。 */}
          {widgets.filter((w) => shown.has(widgetIdOf(w))).map((w) => {
            const def: CardDef = { id: widgetIdOf(w), label: w.title, group: 'plugin', Icon: Puzzle, defaultOn: false, span: w.span }
            return (
              <Card key={def.id} def={def} bg={bg} span={w.span}>
                <div className="h-[150px]">
                  <PluginFrame pluginId={w.pluginId} entry={w.entry} grantedCapabilities={w.granted} />
                </div>
              </Card>
            )
          })}
        </div>

      </div>
        </div>
      </div>
  )
}
