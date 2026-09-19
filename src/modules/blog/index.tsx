import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { Star, ListTree, ChevronLeft, ChevronRight, X, Edit3, List } from 'lucide-react'
import { Entry, Tag, type SummaryRecord } from '../../types'
import { getEntries, createEntry, deleteEntry, getEntryById, toggleEntryStar, getSetting, setSetting, openExternal, getTags, workspaceGetCurrent, ensureSummary } from '../../lib/ipc'
import { useSettings } from '../../lib/SettingsContext'
import { ConfirmDialog } from '../../components/shared'
import { PluginSlotEntry } from '../../components/shared/PluginSlotEntry'
import { registerAssistantContext } from '../../lib/assistantContext'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { isEditingInput } from '../../lib/shortcuts'
import { getGlobalActiveTab } from '../../lib/activeTab'
import { localToday } from '../../lib/date'
import { useDataChanged } from '../../lib/dataChanged'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { OutlinePanel, parseHeadings } from '../../components/shared/OutlinePanel'
import { Sidebar } from './components/Sidebar'
import { EntryList } from './views/EntryList'
// 惰性化（性能 2026-09-10）：MarkdownEditor 是 Monaco 宿主，静态引入会把 monaco 主包拖进
// blog chunk——而 blog 又是默认 Tab，等于首屏照旧加载编辑器。改为进入编辑视图时才加载。
const MarkdownEditor = lazy(() => import('./components/MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })))
import { SummaryPanel } from './components/SummaryPanel'
import { SummaryDoc } from './views/SummaryDoc'
import type { SummaryKind } from '../../lib/summary'

type BlogView = 'list' | 'editor' | 'detail' | 'summary'

/**
 * 外部跳转意图（桌面磁贴的日历 / 总结入口、日志尾部的总结入口都走这里）。
 *
 * 传递方式照 `kb-open-note` 的成熟范式：**事件只负责把意图送到 App，
 * 真实 payload 走 state + props**（`pendingOpenRel` 的教训：保活层里靠 window 变量
 * 会丢事件）。所以这里是一个由 App 下传、消费后回调清空的 prop。
 */
export type BlogJump =
  | { kind: 'date'; date: string }
  | { kind: 'summary'; summaryKind: SummaryKind; start: string; end: string }

export function BlogModule({ showLineNumbers = false, sidebarOpen = true, zoom = 1, sidebarWidths = {} as Record<string, number>, onSnapCloseSidebar, onSnapOpenSidebar, blogJump = null, onBlogJumpConsumed, sidebarEl = null, sidebarHosted = false, modActionsEl = null }: {
  showLineNumbers?: boolean; sidebarOpen?: boolean; zoom?: number; sidebarWidths?: Record<string, number>; onSnapCloseSidebar?: () => void; onSnapOpenSidebar?: () => void; blogJump?: BlogJump | null; onBlogJumpConsumed?: () => void; sidebarEl?: HTMLElement | null; sidebarHosted?: boolean; modActionsEl?: HTMLElement | null
}) {
  const { s } = useSettings()
  const [view, setView] = useState<BlogView>('list')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showOutline, setShowOutline] = useState(false)
  const [liveContent, setLiveContent] = useState('')
  const [allTags, setAllTags] = useState<Tag[]>([])
  /** 正在查看的周/月/年总结（view === 'summary' 时有效） */
  const [activeSummary, setActiveSummary] = useState<SummaryRecord | null>(null)

  const viewRef = useRef(view)
  const selectedIdRef = useRef(selectedId)
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

  // Month & tag filter
  const today = localToday()
  const thisMonth = today.slice(0, 7)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)   // null = thisMonth only; string = YYYY-MM filter; 'showAll' = everything
  const [filterTagId, setFilterTagId] = useState<string | null>(null)        // null = all tags

  // AI 助手上下文：正在编辑/查看的日记
  useEffect(() => {
    return registerAssistantContext(() => {
      if (!selectedId) return null
      const e = entries.find(x => x.id === selectedId)
      if (!e) return null
      const content = (liveContent && liveContent.length > 0 ? liveContent : e.contentMd) || ''
      return {
        type: 'blog.entry',
        label: `正在编辑的日记「${e.title || e.date}」`,
        data: { id: e.id, date: e.date, title: e.title, contentMd: content.slice(0, 8000) },
      }
    })
  }, [selectedId, entries, liveContent])

  const loadEntries = useCallback(async () => {
    try {
      // blog 随 App 启动即挂载（mountedTabs），首启/选库阶段可能尚无当前仓库——
      // 无仓库时静默跳过，避免主进程 requireRoot 抛错刷屏；选定仓库后由 vault:changed 补拉
      if (!(await workspaceGetCurrent())) { setLoading(false); return }
      const [es, ts] = await Promise.all([getEntries(), getTags()])
      setEntries(es)
      setAllTags(ts)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  // VaultPicker（无当前仓库形态）选定仓库后广播 vault:changed → 补拉一次
  useEffect(() => {
    const onChange = () => { void loadEntries() }
    window.addEventListener('vault:changed', onChange)
    return () => window.removeEventListener('vault:changed', onChange)
  }, [loadEntries])

  // 回到列表：清除选中态，显示当月文章
  const goToList = useCallback(() => {
    setView('list')
    setActiveSummary(null)
    setSelectedId(null)
    setSelectedDate(null)
    setShowOutline(false)
    setSelectedMonth(null)
    setFilterTagId(null)
    onSnapOpenSidebar?.()
    loadEntries()
  }, [loadEntries, onSnapOpenSidebar])

  useEffect(() => { loadEntries() }, [loadEntries])

  // 监听数据导入事件
  useEffect(() => {
    const handler = () => { loadEntries() }
    window.addEventListener('data-imported', handler)
    return () => window.removeEventListener('data-imported', handler)
  }, [loadEntries])

  // 主进程侧写操作（AI 工具写日记等）→ 广播后重取列表（2026-09-10 修）：
  // 博客模块随 App 启动即挂载并保活，不通知就只在重启后才看得到新日记
  useDataChanged('blog', loadEntries)

  // Toggle star on an entry
  const handleToggleStar = useCallback(async (id: string) => {
    const updated = await toggleEntryStar(id)
    if (updated) {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, isStarred: updated.isStarred } : e))
    }
  }, [])

  const handleTodayEntry = async () => {
    const todayEntry = entries.find(e => e.date === today)
    if (todayEntry) {
      setSelectedId(todayEntry.id)
      setSelectedDate(today)
      setView('editor')
    } else {
      try {
        const entry = await createEntry({ date: today, title: today })
        setSelectedId(entry.id)
        setSelectedDate(today)
        setView('editor')
        loadEntries()
      } catch (e) { console.error(e) }
    }
  }

  const handleShowAll = useCallback(() => {
    setView('list')
    setSelectedId(null)
    setSelectedDate(null)
    setSelectedMonth('showAll')
    setFilterTagId(null)
    setShowOutline(false)
    onSnapOpenSidebar?.()
    loadEntries()
  }, [loadEntries, onSnapOpenSidebar])

  const handleSelectDate = async (date: string | null) => {
    setSelectedDate(date)
    if (!date) {
      setView('list')
      setSelectedMonth(null)
      setFilterTagId(null)
      return
    }
    const entry = entries.find(e => e.date === date)
    if (entry) {
      setSelectedId(entry.id)
      setView(date === today ? 'editor' : 'detail')
      if (date !== today) setLiveContent(entry.contentMd || '')
    } else {
      try {
        const e = await createEntry({ date, title: date })
        setSelectedId(e.id)
        setView('editor')
        loadEntries()
      } catch (err) { console.error(err) }
    }
  }

  /** handleSelectDate 每次渲染都是新函数身份（闭包 entries），供跳转 effect 取最新一份 */
  const selectDateRef = useRef(handleSelectDate)
  selectDateRef.current = handleSelectDate

  /**
   * 打开某一段窗口的总结 —— **按需生成**：没有文件就先建再打开（DP v3.2.0 第 12 项拍板②）。
   * 桌面磁贴、日志尾部入口、外部跳转三条来路都落到这里，保证「同一窗口永远打开同一份文件」。
   */
  const openSummary = useCallback(async (kind: SummaryKind, start: string, end: string) => {
    try {
      const rec = await ensureSummary(kind, start, end)
      setActiveSummary(rec)
      setSelectedId(null)
      setSelectedDate(null)
      setShowOutline(false)
      setView('summary')
    } catch (err) {
      console.error('[blog] 打开总结失败', err)
    }
  }, [])

  // 消费外部跳转意图（App 下传的 blogJump）：桌面日历点日期 / 点周号月份年份、日志尾部「本期总结」
  // 入口卡片都从这里进 —— 事件只负责让 App 切 Tab 并把意图存成 state，**消费只此一处**
  // （blog 不再自己监听同一事件，否则同一次点击会走两遍 ensureSummary）。
  // 用 ref 取最新回调，意图只在 blogJump 变化时消费一次，消费完立刻让 App 清空（免得切走再切回又跳一次）。
  useEffect(() => {
    if (!blogJump) return
    if (blogJump.kind === 'date') void selectDateRef.current(blogJump.date)
    else void openSummary(blogJump.summaryKind, blogJump.start, blogJump.end)
    onBlogJumpConsumed?.()
  }, [blogJump, openSummary, onBlogJumpConsumed])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'blog') return
      if (isEditingInput(e)) return

      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault()
        handleTodayEntry()
        return
      }

      if (e.key === 'Delete') {
        if (viewRef.current !== 'list' && selectedIdRef.current) {
          e.preventDefault()
          deleteEntry(selectedIdRef.current).then(() => goToList()).catch(console.error)
        }
        return
      }

      if (e.key === 'Escape') {
        if (viewRef.current !== 'list') {
          e.preventDefault()
          goToList()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleTodayEntry, goToList, loadEntries])

  const starredEntries = entries.filter(e => e.isStarred)

  // ---- month navigation ----
  const effectiveMonth = selectedMonth === 'showAll' ? null : (selectedMonth || thisMonth)
  const MONTH_NAMES = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月']

  const monthLabel = effectiveMonth
    ? `${effectiveMonth.slice(0, 4)}年${MONTH_NAMES[parseInt(effectiveMonth.slice(5, 7)) - 1]}`
    : '全部文章'

  const navigateMonth = (dir: -1 | 1) => {
    if (!effectiveMonth) return
    const [y, m] = effectiveMonth.split('-').map(Number)
    const d = new Date(y, m - 1 + dir, 1)
    setSelectedMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    setFilterTagId(null)
    setSelectedDate(null)
  }

  // Build tag list from entries in current view
  const displayedTagCounts = useMemo(() => {
    const map: Record<string, { tag: Tag; count: number }> = {}
    for (const t of allTags) map[t.id] = { tag: t, count: 0 }
    const viewEntries = selectedDate
      ? entries.filter(e => e.date === selectedDate)
      : effectiveMonth
        ? entries.filter(e => e.date.startsWith(effectiveMonth))
        : entries
    for (const e of viewEntries) {
      for (const t of e.tags || []) {
        if (map[t.id]) map[t.id].count++
      }
    }
    return Object.values(map).filter(x => x.count > 0).sort((a, b) => b.count - a.count)
  }, [allTags, entries, effectiveMonth, selectedDate])

  // Final filtered entries for display
  const displayEntries = useMemo(() => {
    let result = selectedDate
      ? entries.filter(e => e.date === selectedDate)
      : effectiveMonth
        ? entries.filter(e => e.date.startsWith(effectiveMonth))
        : entries
    if (filterTagId) {
      result = result.filter(e => (e.tags || []).some(t => t.id === filterTagId))
    }
    return result
  }, [entries, effectiveMonth, selectedDate, filterTagId])

  // Reset liveContent when switching entries
  useEffect(() => { setLiveContent('') }, [selectedId])

  // Outline headings from live content
  const outlineHeadings = useMemo(() => parseHeadings(liveContent), [liveContent])

  const handleToggleOutline = useCallback(() => {
    setShowOutline(v => {
      const next = !v
      if (next) {
        onSnapCloseSidebar?.()
      } else {
        onSnapOpenSidebar?.()
      }
      return next
    })
  }, [onSnapCloseSidebar, onSnapOpenSidebar])

  // Ctrl+O toggle outline
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (getGlobalActiveTab() !== 'blog') return
      if (isEditingInput(e)) return
      if (e.ctrlKey && e.key === 'o' && (view === 'editor' || view === 'detail')) {
        e.preventDefault()
        handleToggleOutline()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, handleToggleOutline])

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      {/* 顶部贯通行（图二骨架）已删除（2026-09-18）：与左栏 Sidebar 的「博客」标题重复，
          中栏内容直接顶到页面条下方。快捷动作仍在侧栏搜索框上方。 */}
      <div className="flex min-h-0 flex-1">
      {/* 侧栏头部动作（2026-09-19 反馈）：原 Sidebar「文章」标题行删除，写作/全部文章两钮
          portal 到左栏模块态头部（🏠 🔒）最右；与侧栏同显隐（收起/大纲态不渲染） */}
      {modActionsEl && createPortal(
        <>
          <button
            onClick={handleTodayEntry}
            title={entries.some(e => e.date === localToday()) ? '继续编写今日文章' : '新建今日文章'}
            className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <Edit3 size={13} />
          </button>
          <button
            onClick={handleShowAll}
            title="全部文章"
            className="p-1 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <List size={13} />
          </button>
        </>,
        modActionsEl,
      )}
      {/* v3.4.0 批次3：左栏模块态（sidebarEl）时侧栏内容 portal 进左栏 slot（挂载点迁移），
          否则回落原位 ResizablePanel；大纲模式的显隐条件在两形态下保持一致 */}
      {(() => {
        const sidebarInner = (
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-hidden">
            <Sidebar
              entries={entries}
              starredEntries={starredEntries}
              selectedDate={selectedDate}
              onSelectDate={handleSelectDate}
              allTags={allTags}
            />
          </div>
          <PluginSlotEntry slot="blog.sidebar" />
        </div>
        )
        // 大纲内嵌形态（2026-09-19 反馈修复）：大纲面板也进左栏槽（embedded + 返回钮头部），
        // 而不是渲染在模块主区——此前托管形态下 OutlinePanel 落在模块 flex 行里、
        // 左栏槽 portal null，看起来「大纲跑到中间、左栏空了」
        const outlineVisible = showOutline && (view === 'editor' || view === 'detail')
        const outlineInner = (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-color)] px-2 py-1.5">
              <button
                onClick={handleToggleOutline}
                title="返回文章列表"
                className="rounded p-0.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                {view === 'editor' ? (entries.find(e => e.id === selectedId)?.title || '无标题') : (entries.find(e => e.id === selectedId)?.date || '')}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <OutlinePanel
                pageTitle={view === 'editor' ? (entries.find(e => e.id === selectedId)?.title || '') : (entries.find(e => e.id === selectedId)?.date || '')}
                headings={outlineHeadings}
                onBackToFile={handleToggleOutline}
                embedded
              />
            </div>
          </div>
        )
        return sidebarEl
          ? createPortal(outlineVisible ? outlineInner : (sidebarOpen ? sidebarInner : null), sidebarEl)
          : sidebarHosted
            ? null // Workbench 托管但槽未就绪（左栏收起/翻转瞬间）：渲染 null 等槽重挂后 portal，绝不回落内嵌列（同 editor 口径）
            : (
              <ResizablePanel storageKey="sidebarWidth_blog" defaultWidth={256} minWidth={200} maxWidth={320} visible={sidebarOpen && !showOutline} initialWidth={sidebarWidths.sidebarWidth_blog} onSnapClose={onSnapCloseSidebar} onSnapOpen={onSnapOpenSidebar}>
                {sidebarInner}
              </ResizablePanel>
            )
      })()}

      {/* Outline panel — 非托管回落形态：原位独立面板（托管形态已 portal 进左栏槽，见上） */}
      {!sidebarEl && showOutline && (view === 'editor' || view === 'detail') && (
        <OutlinePanel
          pageTitle={view === 'editor' ? (entries.find(e => e.id === selectedId)?.title || '') : (entries.find(e => e.id === selectedId)?.date || '')}
          headings={outlineHeadings}
          onBackToFile={handleToggleOutline}
        />
      )}

      <main className="flex-1 flex flex-col overflow-hidden">
        {/* 视图切换淡入（key=view 触发重挂载 → 动画重播；列表/编辑器/详情三态共用一套） */}
        <div key={view} className="kb-view-in flex min-h-0 flex-1 flex-col">
        {view === 'list' && (
          <>
            {/* Month switcher + tag filter bar */}
            <div className="flex items-center justify-center px-4 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] shrink-0">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => navigateMonth(-1)}
                  disabled={!effectiveMonth}
                  className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="上个月"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-[13px] font-medium text-[var(--text-primary)] min-w-[120px] text-center select-none">{monthLabel}</span>
                <button
                  onClick={() => navigateMonth(1)}
                  disabled={!effectiveMonth}
                  className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="下个月"
                >
                  <ChevronRight size={16} />
                </button>
                {effectiveMonth && (
                  <button
                    onClick={() => { setSelectedMonth('showAll'); setSelectedDate(null); setFilterTagId(null) }}
                    className="ml-2 px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors"
                  >
                    全部
                  </button>
                )}
                {selectedMonth === 'showAll' && (
                  <button
                    onClick={() => setSelectedMonth(null)}
                    className="ml-2 px-2 py-0.5 text-[11px] text-[var(--accent)] hover:bg-[var(--bg-hover)] rounded transition-colors"
                  >
                    回到本月
                  </button>
                )}
                {filterTagId && (
                  <button
                    onClick={() => setFilterTagId(null)}
                    className="ml-2 flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded hover:bg-[var(--accent)]/20 transition-colors"
                  >
                    <X size={10} />清除筛选
                  </button>
                )}
              </div>
            </div>

            {/* Tag filter chips */}
            {displayedTagCounts.length > 0 && (
              <div className="flex items-center gap-1 px-4 py-1.5 border-b border-[var(--border-color)] bg-[var(--bg-primary)] overflow-x-auto shrink-0">
                {displayedTagCounts.map(({ tag, count }) => (
                  <button
                    key={tag.id}
                    onClick={() => setFilterTagId(prev => prev === tag.id ? null : tag.id)}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] shrink-0 transition-colors border ${
                      filterTagId === tag.id
                        ? 'border-current'
                        : 'border-transparent hover:border-current/30'
                    }`}
                    style={{
                      backgroundColor: tag.color + (filterTagId === tag.id ? '30' : '15'),
                      color: tag.color
                    }}
                  >
                    {tag.name}
                    <span className="opacity-60">{count}</span>
                  </button>
                ))}
              </div>
            )}

            <EntryList
              entries={displayEntries}
              loading={loading}
              onEntryClick={entry => { setSelectedId(entry.id); setSelectedDate(entry.date); setView(entry.date === today ? 'editor' : 'detail'); if (entry.date !== today) setLiveContent(entry.contentMd || '') }}
              onToggleStar={handleToggleStar}
              onNewEntry={handleTodayEntry}
              cardSize={(['s', 'm', 'l'] as const).includes(s.blogCardSize as 's' | 'm' | 'l') ? s.blogCardSize as 's' | 'm' | 'l' : 'm'}
            />
          </>
        )}
        {view === 'editor' && selectedId && (
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-muted)]">正在加载编辑器…</div>}>
            <MarkdownEditor
              key={selectedId}
              entryId={selectedId}
              showLineNumbers={showLineNumbers}
              zoom={zoom}
              onSave={goToList}
              onCancel={goToList}
              onContentChange={setLiveContent}
              onToggleOutline={handleToggleOutline}
            />
          </Suspense>
        )}
        {view === 'summary' && activeSummary && (
          <SummaryDoc
            summary={activeSummary}
            onBack={goToList}
            onSaved={(saved) => setActiveSummary(saved)}
          />
        )}
        {view === 'detail' && selectedId && (
          <EntryDetail
            entryId={selectedId}
            onEdit={() => setView('editor')}
            onDelete={async () => { await deleteEntry(selectedId); goToList() }}
            onBack={goToList}
            onToggleOutline={handleToggleOutline}
          />
        )}
        </div>
      </main>
      </div>
    </div>
  )
}

// 博文详情阅读
function EntryDetail({ entryId, onEdit, onDelete, onBack, onToggleOutline }: {
  entryId: string; onEdit: () => void; onDelete: () => void; onBack: () => void; onToggleOutline?: () => void
}) {
  const [entry, setEntry] = useState<(Entry & { tags: Tag[] }) | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState(false)

  useEffect(() => { getEntryById(entryId).then(setEntry) }, [entryId])

  useEffect(() => {
    getSetting('skipDeleteConfirm_blog').then(v => {
      if (v === true) setSkipDeleteConfirm(true)
    })
  }, [])

  const handleToggleStar = async () => {
    const updated = await toggleEntryStar(entryId)
    if (updated) setEntry(prev => prev ? { ...prev, isStarred: updated.isStarred, tags: prev.tags } : null)
  }

  if (!entry) return <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">加载中...</div>

  const handleDeleteClick = () => {
    if (skipDeleteConfirm) { onDelete() } else { setShowDeleteConfirm(true) }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border-color)]">
            <button onClick={onBack} className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">← 返回列表</button>
            <div className="flex gap-2">
              {onToggleOutline && (
                <button onClick={onToggleOutline} className="p-1.5 rounded hover:bg-[var(--bg-hover)] transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="大纲 (Ctrl+O)">
                  <ListTree size={16} />
                </button>
              )}
              <button onClick={handleToggleStar} className="p-1.5 rounded hover:bg-[var(--bg-hover)] transition-colors" title={entry.isStarred ? '取消收藏' : '收藏'}>
                <Star key={entry.isStarred ? 'on' : 'off'} size={16} className={`kb-micro-pop ${entry.isStarred ? 'text-[var(--warning)] fill-[var(--warning)]' : 'text-[var(--text-muted)]'}`} />
              </button>
              <button onClick={onEdit} className="px-3 py-1.5 text-sm bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)]">编辑</button>
              <button onClick={handleDeleteClick} className="px-3 py-1.5 text-sm text-[var(--danger)] hover:bg-[var(--danger)]/10 rounded">删除</button>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-1">{entry.date}</h1>
          <p className="text-[11px] text-[var(--text-muted)] mb-4">最近修改：{fmtRelative(entry.updatedAt)}</p>
          <MarkdownPreview content={entry.contentMd || ''} onLinkClick={href => openExternal(href)} />
          <SummaryPanel date={entry.date} />
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除"
        message="删除这篇博文？可在回收站恢复。"
        onConfirm={(skipNext) => {
          if (skipNext) { setSetting('skipDeleteConfirm_blog', true); setSkipDeleteConfirm(true) }
          setShowDeleteConfirm(false)
          onDelete()
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </>
  )
}

function fmtRelative(dateStr: string): string {
  const d = new Date(dateStr)
  const now = Date.now()
  const diff = now - d.getTime()
  if (isNaN(diff)) return dateStr
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return d.toLocaleDateString('zh-CN')
}
