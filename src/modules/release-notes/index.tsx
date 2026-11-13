import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ArrowUpRight, Check, ChevronRight, History, Sparkles,
  CalendarDays, GraduationCap, Zap, Megaphone, BookOpen,
} from 'lucide-react'
import { getReleaseNote, getReleaseNotesState, listReleaseNotes, markReleaseNotesShown } from '../../lib/ipc'
import type {
  ReleaseNote, ReleaseNoteHighlight, ReleaseNoteItem, ReleaseNoteListEntry, ReleaseNotesState,
  ReleaseHighlightDemo, ReleaseNoteGroup,
} from '../../types'

/**
 * 更新说明（VS Code 式）—— 主界面模块页。
 *
 * 载体：普通模块页（本应用没有全局文档 Tab 栏），启动时按版本判定自动切到它。
 * 2026-09-12 按 tmp/release-notes-proto/release-notes.html 原型改版：
 *   大版本头部（已更新 pill / 上一版 / 在线日志链接）
 *   → 摘要行（brief）
 *   → 分节亮点卡（左文案 + 可折叠「全部改动」，右可重播动效演示区）
 *   → 完整变更清单（折叠，保住「一条不漏」）
 *   → 更早的版本导航。详见 docs/release-notes-design.md。
 *
 * 根节点必须 h-full 而不是 flex-1：槽位容器是块级 div，flex-1 不生效 → 滚轮失灵
 * （docs/release-notes-design.md §4 有整节复盘，别改回去）。
 */

type View = { kind: 'current' } | { kind: 'all' } | { kind: 'v'; version: string }

/** 分节图标（原型：日程/AI 助手/错题本/界面/更新说明） */
const SECTION_ICONS: Record<string, typeof Sparkles> = {
  日程: CalendarDays,
  'AI 助手': Sparkles,
  错题本: GraduationCap,
  界面: Zap,
  更新说明: Megaphone,
}
const SECTION_FALLBACK_ICON = BookOpen

/** 行内 Markdown：反引号 code + **粗体**（亮点卡描述用；生成数据已剥粗体，此处只为亮点服务） */
function InlineText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g), [text])
  return (
    <>
      {parts.map((p, i) => {
        if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) {
          return <strong key={i} className="font-semibold text-[var(--text-primary)]">{p.slice(2, -2)}</strong>
        }
        if (p.length > 1 && p.startsWith('`') && p.endsWith('`')) {
          return <code key={i} className="kb-md-code">{p.slice(1, -1)}</code>
        }
        return <span key={i}>{p}</span>
      })}
    </>
  )
}

/* ===== 动效演示区（四种，可重播；动画类名见 styles/index.css rn- 段）===== */

function DemoBox({ demo }: { demo: ReleaseHighlightDemo }) {
  const [playId, setPlayId] = useState(0)
  return (
    <div className="w-[218px] shrink-0 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          onClick={() => setPlayId(p => p + 1)}
          className="text-[10.5px] px-1.5 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          data-tip="重播演示" aria-label="重播演示"
        >
          ↻ 重播
        </button>
      </div>
      <div key={playId} className="min-h-[86px] flex flex-col justify-center gap-1.5">
        {demo.kind === 'notify' && (
          <div className="rn-demo-anim flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] p-2.5 shadow-sm">
            <span className="w-6 h-6 rounded-md bg-[var(--accent)]/12 text-[var(--accent)] grid place-items-center shrink-0">
              <CalendarDays size={12} />
            </span>
            <div className="min-w-0">
              <div className="text-[11.5px] font-medium text-[var(--text-primary)] truncate">{demo.title}</div>
              <div className="text-[10.5px] text-[var(--text-muted)] truncate">{demo.message}</div>
            </div>
          </div>
        )}
        {demo.kind === 'compare' && (
          <div className="flex flex-col gap-1.5">
            {demo.rows.map((r, i) => (
              <div key={r.label} className="flex items-center gap-1.5">
                <span className="w-7 shrink-0 text-[10.5px] text-[var(--text-muted)]">{r.label}</span>
                <span className={`rn-bar flex-1 h-[10px] rounded-full overflow-hidden ${r.after ? 'bg-[var(--accent)]/25' : 'bg-[var(--bg-tertiary)]'}`}>
                  <span
                    className={`fill block h-full rounded-full ${r.after ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]/60'}`}
                    style={{ width: `${Math.min(100, Math.max(4, r.width))}%`, animationDelay: `${i * 220}ms` }}
                  />
                </span>
                <span className="w-9 shrink-0 text-right text-[10.5px] tabular-nums text-[var(--text-secondary)]">{r.display}</span>
              </div>
            ))}
          </div>
        )}
        {demo.kind === 'dist' && (
          <div className="flex flex-col gap-1.5">
            {demo.rows.map((r, i) => (
              <div key={r.label} className="rn-row-anim flex items-center gap-1.5" style={{ animationDelay: `${i * 90}ms` }}>
                <span className="w-12 shrink-0 text-[10.5px] text-[var(--text-secondary)] truncate">{r.label}</span>
                <span className="rn-bar flex-1 h-[10px] rounded-full overflow-hidden bg-[var(--bg-tertiary)]">
                  <span
                    className="fill block h-full rounded-full bg-[var(--accent)]/70"
                    style={{ width: `${Math.min(100, Math.max(4, r.width))}%`, animationDelay: `${120 + i * 120}ms` }}
                  />
                </span>
                <span className="w-6 shrink-0 text-right text-[10.5px] tabular-nums text-[var(--text-secondary)]">{r.display}</span>
              </div>
            ))}
          </div>
        )}
        {demo.kind === 'mini-list' && (
          <div className="rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] px-2.5 py-1.5 flex flex-col">
            {demo.items.map((it, i) => (
              <div
                key={it.text}
                className={`rn-row-anim flex items-center gap-2 py-1 text-[11.5px] ${i > 0 ? 'border-t border-[var(--border-color)]/60' : ''}`}
                style={{ animationDelay: `${i * 110}ms` }}
              >
                <span
                  className={`w-3.5 h-3.5 rounded-full grid place-items-center shrink-0 ${
                    it.done ? 'rn-check-anim bg-[var(--success)]/15 text-[var(--success)]' : 'border border-[var(--border-color)]'
                  }`}
                  style={it.done ? { animationDelay: `${300 + i * 110}ms` } : undefined}
                >
                  {it.done && <Check size={9} />}
                </span>
                <span className={`truncate ${it.done ? 'text-[var(--text-muted)] line-through' : 'text-[var(--text-secondary)]'}`}>
                  {it.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {demo.caption && (
        <div className="text-[10px] text-[var(--text-disabled)] leading-snug">{demo.caption}</div>
      )}
    </div>
  )
}

/** 亮点卡：左文案（标题/标签/描述/链接/可折叠全部改动）+ 右演示区 */
function HighlightCardV2({ h }: { h: ReleaseNoteHighlight }) {
  const [changesOpen, setChangesOpen] = useState(false)
  return (
    <div className="kb-item-in rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-4 flex gap-4">
      <div className="flex-1 min-w-0">
        <h3 className="flex items-center gap-2 text-[13.5px] font-medium text-[var(--text-primary)]">
          {h.title}
          {h.tag && (
            <span className="text-[9px] px-1 py-px rounded bg-[var(--accent)]/12 text-[var(--accent)] shrink-0">{h.tag}</span>
          )}
        </h3>
        <p className="mt-1.5 text-[12.5px] leading-[1.75] text-[var(--text-secondary)]">
          <InlineText text={h.desc} />
        </p>
        {h.detail && (
          <p className="mt-1.5 text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
            <InlineText text={h.detail} />
          </p>
        )}
        {h.links && h.links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {h.links.map(l => (
              <span key={l.label} className="text-[11.5px] text-[var(--accent)]/85">{l.label}</span>
            ))}
          </div>
        )}
        {h.changes && h.changes.length > 0 && (
          <div className="mt-2.5">
            <button
              onClick={() => setChangesOpen(o => !o)}
              className="flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            >
              <ChevronRight size={11} className={`transition-transform ${changesOpen ? 'rotate-90' : ''}`} />
              全部改动（{h.changes.length} 条）
            </button>
            {changesOpen && (
              <ul className="mt-1.5 space-y-1 border-l border-[var(--border-color)] pl-3">
                {h.changes.map((c, i) => (
                  <li key={i} className="text-[11.5px] leading-[1.7] text-[var(--text-muted)]">
                    <InlineText text={c} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {h.demo && <DemoBox demo={h.demo} />}
    </div>
  )
}

/** 分节头：图标 + 标题 + 贯穿横线（原型 sec-head） */
function SectionHead({ section }: { section: string }) {
  const Icon = SECTION_ICONS[section] ?? SECTION_FALLBACK_ICON
  return (
    <div className="mb-3 mt-8 flex items-center gap-2 first:mt-0">
      <span className="w-6 h-6 rounded-md bg-[var(--accent)]/10 text-[var(--accent)] grid place-items-center shrink-0">
        <Icon size={13} />
      </span>
      <h2 className="text-[14px] font-medium text-[var(--text-primary)]">{section}</h2>
      <span className="h-px flex-1 bg-[var(--border-color)]" />
    </div>
  )
}

/** 日期差（天）；任一日期缺失返回 null */
function daysBetween(a: string, b: string): number | null {
  if (!a || !b) return null
  const da = new Date(a).getTime()
  const db = new Date(b).getTime()
  if (!Number.isFinite(da) || !Number.isFinite(db)) return null
  return Math.max(0, Math.round(Math.abs(da - db) / 86400000))
}

/** 版本页主体（current 与历史 v 共用）：头部 → 摘要 → 分节亮点 → 完整清单 → 更早版本 */
function VersionBody({ note, highlights, isCurrent, prev, totalVersions, onOpenAll, onOpenVersion }: {
  note: ReleaseNote
  highlights: ReleaseNoteHighlight[]
  isCurrent: boolean
  prev: ReleaseNoteListEntry | null
  totalVersions: number
  onOpenAll: () => void
  onOpenVersion: (v: string) => void
}) {
  // 分节聚类（保持首次出现顺序）
  const sections = useMemo(() => {
    const order: string[] = []
    const bySection = new Map<string, ReleaseNoteHighlight[]>()
    for (const h of highlights) {
      if (!bySection.has(h.section)) {
        bySection.set(h.section, [])
        order.push(h.section)
      }
      bySection.get(h.section)!.push(h)
    }
    return order.map(s => ({ section: s, items: bySection.get(s)! }))
  }, [highlights])

  const briefs = highlights.filter(h => h.briefLead)
  const hasHighlights = highlights.length > 0

  return (
    <div className="kb-view-in">
      {/* ---- 头部：面包屑 + 大版本标题 + meta pills ---- */}
      <div className="mb-1 text-[11.5px] text-[var(--text-muted)]">更新说明</div>
      <h1 className="text-[22px] font-medium leading-tight text-[var(--text-primary)]">
        v{note.version}
        {note.date && <span className="ml-2 text-[13px] font-normal text-[var(--text-muted)]">· {note.date}</span>}
      </h1>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {isCurrent && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success)]/12 px-2.5 py-0.5 text-[11px] text-[var(--success)]">
            <Check size={11} />
            已更新到最新版
          </span>
        )}
        {isCurrent && prev && (
          <span className="rounded-full border border-[var(--border-color)] px-2.5 py-0.5 text-[11px] text-[var(--text-muted)]">
            上一版 v{prev.version}
            {(() => {
              const d = daysBetween(note.date, prev.date)
              return d !== null ? ` · ${d} 天前` : ''
            })()}
          </span>
        )}
        <button
          onClick={() => { void window.api?.openExternal?.('https://github.com/Lousync/Phrontis/releases') }}
          className="inline-flex items-center gap-1 text-[11.5px] text-[var(--accent)]/90 transition-colors hover:text-[var(--accent)]"
          data-tip="在 GitHub Releases 查看完整更新日志" aria-label="在 GitHub Releases 查看完整更新日志"
        >
          在线查看完整更新日志
          <ArrowUpRight size={11} />
        </button>
      </div>

      {/* ---- 摘要行 ---- */}
      {briefs.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3.5 py-2.5">
          {briefs.map(h => (
            <span key={h.title} className="text-[12px] text-[var(--text-secondary)]">
              <b className="font-semibold text-[var(--text-primary)]">{h.briefLead}</b>
              <span className="ml-1">{h.briefRest}</span>
            </span>
          ))}
        </div>
      )}

      {note.summary && !hasHighlights && (
        <div className="mt-4 rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-4">
          <p className="text-[12.5px] leading-[1.8] text-[var(--text-secondary)]">
            <InlineText text={note.summary} />
          </p>
        </div>
      )}

      {/* ---- 分节亮点卡 ---- */}
      {sections.map(sec => (
        <section key={sec.section}>
          <SectionHead section={sec.section} />
          <div className="space-y-3">
            {sec.items.map(h => <HighlightCardV2 key={h.title} h={h} />)}
          </div>
        </section>
      ))}

      {/* ---- 完整变更清单（无亮点的老版本直接铺开；有亮点的折叠保「一条不漏」）---- */}
      {note.groups.length > 0 && <FullGroups groups={note.groups} defaultOpen={!hasHighlights} />}

      {/* ---- 更早的版本（仅本版视图）---- */}
      {isCurrent && totalVersions > 1 && (
        <div className="mt-10">
          <h2 className="mb-3 text-[13px] font-medium text-[var(--text-primary)]">更早的版本</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onOpenAll}
              className="rounded-full border border-[var(--border-color)] px-3 py-1 text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            >
              全部 {totalVersions} 个版本 →
            </button>
          </div>
        </div>
      )}

      <p className="mt-8 border-t border-[var(--border-color)] pt-4 text-[11.5px] leading-[1.8] text-[var(--text-muted)]">
        本页内容随应用版本发布，离线可读；阅读记录写在当前仓库的
        <span className="kb-md-code">.knowbase/modules/release-notes/</span>
        下，换电脑拷走仓库即一并带走。
      </p>
    </div>
  )
}

/** 完整变更清单：有亮点时默认折叠（亮点卡的「全部改动」已覆盖主要条目） */
function FullGroups({ groups, defaultOpen }: { groups: ReleaseNoteGroup[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const itemCount = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups])
  return (
    <section className="mt-8">
      <button
        onClick={() => setOpen(o => !o)}
        className="mb-3 flex w-full items-center gap-2 text-left"
      >
        <ChevronRight size={13} className={`text-[var(--text-muted)] transition-transform ${open ? 'rotate-90' : ''}`} />
        <h3 className="text-[13px] font-medium text-[var(--text-primary)]">完整变更清单</h3>
        <span className="h-px flex-1 bg-[var(--border-color)]" />
        <span className="text-[11.5px] text-[var(--text-muted)]">{itemCount} 条</span>
      </button>
      {open && (
        <div className="space-y-6">
          {groups.map((g, gi) => (
            <div key={`${g.title}-${gi}`}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[12.5px] font-medium text-[var(--text-primary)]">{g.title}</span>
                <span className="h-[1px] flex-1 bg-[var(--border-color)]" />
                <span className="text-[11.5px] text-[var(--text-muted)]">{g.items.length}</span>
              </div>
              <ul className="space-y-2.5">
                {g.items.map((it, ii) => (
                  <NoteItem key={ii} item={it} delay={Math.min(gi * 40 + ii * 22, 400)} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function NoteItem({ item, delay }: { item: ReleaseNoteItem; delay: number }) {
  return (
    <li className="kb-item-in" style={{ animationDelay: `${delay}ms` }}>
      <div className="text-[12.5px] leading-[1.8] text-[var(--text-secondary)]">
        {item.lead ? (
          <>
            <span className="font-medium text-[var(--text-primary)]">{item.lead}</span>
            <span className="text-[var(--text-muted)]">：</span>
          </>
        ) : null}
        <InlineText text={item.rest} />
      </div>
      {item.sub.length > 0 && (
        <ul className="mt-1 space-y-1 border-l border-[var(--border-color)] pl-3">
          {item.sub.map((s, i) => (
            <li key={i} className="text-[11.5px] leading-[1.75] text-[var(--text-muted)]">
              <InlineText text={s} />
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function ReleaseNotesModule({ onDismiss }: { onDismiss?: () => void }) {
  const [state, setState] = useState<ReleaseNotesState | null>(null)
  const [note, setNote] = useState<ReleaseNote | null>(null)
  const [highlights, setHighlights] = useState<ReleaseNoteHighlight[]>([])
  const [list, setList] = useState<ReleaseNoteListEntry[] | null>(null)
  const [view, setView] = useState<View>({ kind: 'current' })
  const [loadFailed, setLoadFailed] = useState(false)
  const markedRef = useRef(false)

  // 启动检测 + 全量版本列表（列表体积很小，一次拿完，供「全部版本」直接渲染）
  useEffect(() => {
    let alive = true
    Promise.all([getReleaseNotesState(), listReleaseNotes()])
      .then(([st, ls]) => {
        if (!alive) return
        setState(st)
        setList(ls ?? [])
      })
      .catch(() => { if (alive) setLoadFailed(true) })
    return () => { alive = false }
  }, [])

  // 当前视图要展示的版本
  const targetVersion = state
    ? view.kind === 'current'
      ? state.currentVersion
      : view.kind === 'v'
        ? view.version
        : ''
    : ''

  useEffect(() => {
    if (!targetVersion) return
    let alive = true
    getReleaseNote(targetVersion)
      .then((r) => {
        if (!alive) return
        setNote(r?.note ?? null)
        setHighlights(r?.highlights ?? [])
      })
      .catch(() => { if (alive) setNote(null) })
    return () => { alive = false }
  }, [targetVersion])

  // 本版说明成功渲染 → 回写基线（「首装不弹 / patch 不弹」的判定依据）。
  // 只在当前应用版本上写：翻看历史版本不该把基线拨回去（主进程侧也有同款守卫）。
  useEffect(() => {
    if (!state || !note || markedRef.current) return
    if (note.version !== state.currentVersion) return
    markedRef.current = true
    void markReleaseNotesShown(note.version)
  }, [state, note])

  const dismiss = (): void => {
    if (onDismiss) onDismiss()
  }

  const total = list?.length ?? 0
  const isCurrent = view.kind === 'current'

  // 当前展示版本在列表里的位置 → 上一版（更新的一侧不存在；prev = 列表中更老的一条）
  const currentIdx = note && list ? list.findIndex(v => v.version === note.version) : -1
  const prevEntry = note && list && currentIdx >= 0 ? list[currentIdx + 1] ?? null : null

  return (
    // 根节点必须 h-full 而不是 flex-1（教训见 docs/release-notes-design.md §4，别改回去）
    <div className="kb-theme-surface flex h-full flex-col overflow-hidden">
      {/* 页头：紧凑一条 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-color)] px-4 py-2.5">
        {!isCurrent && (
          <button
            onClick={() => setView({ kind: 'current' })}
            className="flex items-center gap-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            data-tip="返回本版更新说明" aria-label="返回本版更新说明"
          >
            <ArrowLeft size={13} />
            返回
          </button>
        )}
        <span className="text-[12.5px] text-[var(--text-primary)]">更新说明</span>
        {state && (
          <span className="text-[12px] text-[var(--text-muted)]">
            v{view.kind === 'v' ? view.version : state.currentVersion}
          </span>
        )}
        <div className="flex-1" />
        {isCurrent && total > 0 && (
          <button
            onClick={() => setView({ kind: 'all' })}
            className="flex items-center gap-1 rounded border border-[var(--border-color)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <History size={12} />
            全部 {total} 个版本
          </button>
        )}
        {onDismiss && (
          <button
            onClick={dismiss}
            className="flex items-center gap-1 rounded border border-[var(--border-color)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <Check size={12} />
            知道了
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-6 py-6">
          {loadFailed && (
            <p className="text-[12.5px] text-[var(--text-muted)]">更新说明读取失败（主进程未就绪或无当前仓库）。</p>
          )}

          {/* ---- 全部版本 ---- */}
          {view.kind === 'all' && (
            <div className="kb-view-in">
              <p className="mb-4 text-[12px] text-[var(--text-muted)]">
                共 {total} 个版本。内容来自仓库根 <span className="kb-md-code">CHANGELOG.md</span>，与文档站同源。
              </p>
              <ul className="space-y-1">
                {list?.map((v, i) => (
                  <li key={v.version} className="kb-item-in" style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }}>
                    <button
                      onClick={() => setView({ kind: 'v', version: v.version })}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    >
                      <span className="w-[68px] shrink-0 text-[12.5px] font-medium text-[var(--text-primary)]">
                        v{v.version}
                      </span>
                      <span className="w-[86px] shrink-0 text-[11.5px] text-[var(--text-muted)]">
                        {v.date || '—'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
                        {v.summary || '（无摘要）'}
                      </span>
                      <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{v.itemCount} 条</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- 单版本详情 ---- */}
          {view.kind !== 'all' && note && (
            <VersionBody
              note={note}
              highlights={highlights}
              isCurrent={isCurrent}
              prev={prevEntry}
              totalVersions={total}
              onOpenAll={() => setView({ kind: 'all' })}
              onOpenVersion={(v) => setView({ kind: 'v', version: v })}
            />
          )}

          {/* ---- 该版本无数据 ---- */}
          {view.kind !== 'all' && !note && !loadFailed && (
            <p className="text-[12.5px] text-[var(--text-muted)]">
              {targetVersion ? `这一版（v${targetVersion}）还没有更新说明。` : '正在读取…'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
