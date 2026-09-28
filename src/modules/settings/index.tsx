import { useState, useMemo, useEffect, useRef } from 'react'
import { Info, Settings } from 'lucide-react'
import { getAppVersion } from '../../lib/ipc'
import { ThemeFxLayer } from '../../components/shared/ThemeFxLayer'
import { AppearanceView } from './views/AppearanceView'
import { EditorView } from './views/EditorView'
import { GeneralView } from './views/GeneralView'
import { DataView } from './views/DataView'
import { SecurityView } from './views/SecurityView'
import { AiToolsView } from './views/AiToolsView'
import { ShortcutsView } from './views/ShortcutsView'
import { ModulesView } from './views/ModulesView'
import { AboutView } from './views/AboutView'
import { SearchResultsView } from './views/SearchResultsView'
import { SettingsSearchBox } from './components/SettingsSearchBox'
import {
  SECTIONS, RECOMMENDED_ITEMS, searchSettings, countBySection, completionFor,
  setPendingAnchor, type SettingsSection, type SettingItem, type AiTab,
} from './sections'

export type { SettingsSection, AiTab }

// Module-level target for cross-component navigation (toast "查看详情" etc.)
let pendingSection: SettingsSection | null = null
// AI 工具页内部页签直达(如助手"去配置模型"→ models)
let pendingAiTab: AiTab | null = null

// 模块评估期即捕获事件:设置模块未挂载时 dispatch 的 detail 不会丢(组件内监听器来不及注册)
window.addEventListener('settings:open', (e: Event) => {
  const detail = (e as CustomEvent).detail as { section?: SettingsSection; aiTab?: AiTab } | undefined
  if (detail?.section) pendingSection = detail.section
  if (detail?.aiTab) pendingAiTab = detail.aiTab
})

export function navigateToSettingsSection(section: SettingsSection, aiTab?: AiTab) {
  pendingSection = section
  pendingAiTab = aiTab ?? null
  window.dispatchEvent(new CustomEvent('settings:open'))
}

export function SettingsModule() {
  const [section, setSection] = useState<SettingsSection>('appearance')
  const [aiTabOverride, setAiTabOverride] = useState<AiTab | undefined>(undefined)
  /** 每次跳转自增，用于强制重挂 AI 工具视图并重新触发滚动高亮 */
  const [jumpSeq, setJumpSeq] = useState(0)
  const [query, setQuery] = useState('')
  const [comboOpen, setComboOpen] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')

  const contentRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<number | null>(null)

  useEffect(() => { getAppVersion().then(setAppVersion).catch(() => {}) }, [])

  // Consume pending section on mount
  useEffect(() => {
    if (pendingSection) {
      setSection(pendingSection)
      pendingSection = null
      setAiTabOverride((pendingAiTab as AiTab | null) ?? undefined)
      pendingAiTab = null
    }
    // 模块常驻保活:后续跳转经事件 detail/pending 到达,这里同步消费
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { section?: SettingsSection; aiTab?: AiTab } | undefined
      const target = detail?.section ?? pendingSection
      if (!target) return
      pendingSection = null
      if (detail?.aiTab) pendingAiTab = detail.aiTab
      setQuery('')
      setComboOpen(false)
      setSection(target)
      setAiTabOverride(target === 'aiTools' ? ((pendingAiTab as AiTab | null) ?? undefined) : undefined)
      pendingAiTab = null
    }
    window.addEventListener('settings:open', onOpen)
    return () => window.removeEventListener('settings:open', onOpen)
  }, [])

  // ---- 搜索 ----
  const searching = query.trim().length > 0
  const hits = useMemo(() => searchSettings(query), [query])
  const counts = useMemo(() => countBySection(hits), [hits])
  const suggestions = useMemo<SettingItem[]>(
    () => (searching ? hits.map(h => h.item) : RECOMMENDED_ITEMS),
    [searching, hits],
  )
  const completion = comboOpen ? completionFor(query, suggestions) : ''

  // 跳转到具体设置项：切大项 → (必要时)切 AI 页签 → 滚动并高亮
  const jumpTo = (item: SettingItem) => {
    setSection(item.section)
    setAiTabOverride(item.section === 'aiTools' ? (item.aiTab ?? 'builtin') : undefined)
    setJumpSeq(n => n + 1)
    setQuery('')
    setComboOpen(false)
    // 先回到顶部：锚点可能条件渲染（如「固定日期」仅在月总结为固定日时出现），
    // 找不到时至少让用户落在目标大项的开头，而不是上一页的滚动位置
    contentRef.current?.scrollTo({ top: 0 })
    // 广播给各视图：目标若在默认收起的折叠分组内，视图自动展开
    setPendingAnchor(item.id)
    setAnchor(item.id)
  }

  // 目标锚点出现后再滚动 + 闪烁高亮（AI 页签需要等子视图渲染）
  useEffect(() => {
    if (!anchor) return
    let raf = 0
    let tries = 0
    let settled = false

    const tick = () => {
      const el = contentRef.current?.querySelector<HTMLElement>(`[data-setting-anchor="${anchor}"]`)
      if (el) {
        settled = true
        setPendingAnchor(null) // 滚动定位成功，清除待展开标记
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        el.classList.remove('setting-anchor-flash')
        void el.offsetWidth // 强制回流，保证连续跳转时动画能重放
        el.classList.add('setting-anchor-flash')
        if (flashTimer.current) window.clearTimeout(flashTimer.current)
        flashTimer.current = window.setTimeout(() => {
          el.classList.remove('setting-anchor-flash')
        }, 2000)
        return
      }
      if (tries++ < 180) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { if (!settled) cancelAnimationFrame(raf) }
  }, [anchor, jumpSeq])

  useEffect(() => () => { if (flashTimer.current) window.clearTimeout(flashTimer.current) }, [])

  return (
    <div className="kb-theme-surface relative flex h-full">
      {/* 主题氛围特效：垫底画布（左右两栏 z-[1] 压在其上） */}
      <ThemeFxLayer />
      {/* Left nav */}
      <div className="relative z-[1] w-48 shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
          <Settings size={12} />
          设置
        </div>

        <div className="py-1">
        {SECTIONS.map(s => {
          const hitCount = counts[s.id] ?? 0
          const hidden = searching && hitCount === 0
          if (hidden) return null
          return (
            <button
              key={s.id}
              onClick={() => { setSection(s.id); setQuery(''); setComboOpen(false) }}
              className={`w-full flex items-center gap-2 px-2 py-1 text-[12px] transition-colors border-l-2 ${
                section === s.id
                  ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-l-[var(--accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] border-l-transparent'
              }`}
            >
              <span className={section === s.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                {s.icon}
              </span>
              <span className="truncate">{s.label}</span>
              {searching && hitCount > 0 && (
                <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-hover)] text-[var(--text-muted)] tabular-nums">
                  {hitCount}
                </span>
              )}
            </button>
          )
        })}
        </div>

        <div className="mt-auto pt-2 border-t border-[var(--border-color)] px-4">
          <span className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <Info size={13} />
            Phrontis v{appVersion}
          </span>
        </div>
      </div>

      {/* Right content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Search bar */}
        <div className="px-6 pt-4 pb-2 shrink-0">
          <div className="max-w-2xl mx-auto">
            <SettingsSearchBox
              query={query}
              onQueryChange={setQuery}
              suggestions={suggestions}
              open={comboOpen}
              onOpenChange={setComboOpen}
              onPick={jumpTo}
              completion={completion}
              total={searching ? hits.length : suggestions.length}
            />
            {searching && hits.length === 0 && !comboOpen && (
              <p className="text-[12px] text-[var(--text-muted)] mt-3 text-center">
                未找到匹配的设置项
              </p>
            )}
          </div>
        </div>

        {/* Content */}
        <div ref={contentRef} className="relative z-[1] flex-1 overflow-y-auto py-6">
          <div className="max-w-2xl mx-auto px-6">
            {/* 切换大项时内容淡入上移（key 变化触发重挂载 → 动画重播；搜索态与结果视图共用固定 key，
                避免每次输入都重播） */}
            <div key={searching ? 'search-results' : section} className="kb-view-in">
            {searching ? (
              hits.length > 0
                ? <SearchResultsView query={query.trim()} hits={hits} onPick={jumpTo} />
                : null
            ) : (
              <>
                {section === 'appearance' && <AppearanceView />}
                {section === 'editor' && <EditorView />}
                {section === 'general' && <GeneralView />}
                {section === 'data' && <DataView />}
                {section === 'security' && <SecurityView />}
                {section === 'aiTools' && (
                  <AiToolsView
                    key={`${aiTabOverride ?? 'builtin'}-${jumpSeq}`}
                    initialTab={aiTabOverride}
                  />
                )}
                {section === 'shortcuts' && <ShortcutsView />}
                {section === 'modules' && <ModulesView />}
                {section === 'about' && <AboutView />}
              </>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
