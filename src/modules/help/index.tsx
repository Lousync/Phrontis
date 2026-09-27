import { useState, useEffect, useCallback } from 'react'
import { CircleHelp, LifeBuoy } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { loadHelpDocs, type HelpDoc } from './docsLoader'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'
import { openExternal } from '../../lib/ipc'

const ISSUES_URL = 'https://github.com/Lousync/Phrontis/issues'

// Module-level target for cross-component navigation (toast "查看详情" etc.)
let pendingDocId: string | null = null

export function navigateToHelp(docId: string) {
  pendingDocId = docId
  window.dispatchEvent(new CustomEvent('help:open'))
}

/** Group docs by category, preserving order */
function groupByCategory(docs: HelpDoc[]): Map<string, HelpDoc[]> {
  const map = new Map<string, HelpDoc[]>()
  for (const d of docs) {
    if (!map.has(d.category)) map.set(d.category, [])
    map.get(d.category)!.push(d)
  }
  return map
}

/** Resolve lucide icon by name string */
function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const icons = LucideIcons as unknown as Record<string, React.ComponentType<{ size?: number }>>
  const C = icons[name]
  return C ? <C size={size} /> : null
}

export function HelpModule() {
  const [docs, setDocs] = useState<HelpDoc[]>([])
  const [activeDoc, setActiveDoc] = useState<string>('键盘快捷键')

  const loadDocs = useCallback(() => {
    loadHelpDocs().then(docs => {
      setDocs(docs)
      const target = pendingDocId
      if (target && docs.some(d => d.id === target)) {
        setActiveDoc(target)
      }
      pendingDocId = null
    })
  }, [])

  useEffect(() => { loadDocs() }, [loadDocs])

  // 帮助已并入设置列表:已在帮助节时再次深链(如 Toast「查看详情」)直接切换文档
  useEffect(() => {
    const onOpen = () => {
      const target = pendingDocId
      if (target) { setActiveDoc(target); pendingDocId = null }
    }
    window.addEventListener('help:open', onOpen)
    return () => window.removeEventListener('help:open', onOpen)
  }, [])

  // 插件模块安装/启禁/卸载帮助文档类插件后同步刷新
  useEffect(() => {
    window.addEventListener('plugins-changed', loadDocs)
    return () => window.removeEventListener('plugins-changed', loadDocs)
  }, [loadDocs])

  const categories = groupByCategory(docs)
  const activeEntry = docs.find(d => d.id === activeDoc)

  return (
    <div className="kb-theme-surface flex h-full">
      {/* Left nav */}
      <div className="w-48 shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex flex-col">
        <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
          <CircleHelp size={12} />
          帮助
        </div>

        <div className="py-1">
        {[...categories.entries()].map(([cat, catDocs]) => (
          <div key={cat} className="mb-2">
            <div className="text-[10px] text-[var(--text-muted)] px-2 mb-1">
              {cat}
            </div>
            {catDocs.map(d => (
              <button
                key={d.id}
                onClick={() => setActiveDoc(d.id)}
                className={`w-full flex items-center gap-2 px-2 py-1 text-[12px] transition-colors border-l-2 ${
                  activeDoc === d.id
                    ? 'bg-[var(--bg-hover)] text-[var(--text-primary)] border-l-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] border-l-transparent'
                }`}
              >
                <span className={activeDoc === d.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>
                  <Icon name={d.icon} size={14} />
                </span>
                {d.title}
              </button>
            ))}
          </div>
        ))}
        </div>

        {/* 反馈入口 — 跳转 GitHub Issues */}
        <div className="mt-auto px-3 pt-3 border-t border-[var(--border-color)]">
          <button
            onClick={() => openExternal(ISSUES_URL).catch(() => {})}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] text-[var(--text-secondary)] border border-[var(--border-color)] rounded-md hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
            title="在 GitHub Issues 中反馈问题或建议"
          >
            <LifeBuoy size={13} />
            反馈问题
          </button>
        </div>
      </div>

      {/* Right content */}
      <div className="flex-1 overflow-y-auto py-8">
        <div className="max-w-2xl mx-auto px-8">
          {activeEntry && (
            <div key={activeEntry.id} className="kb-view-in">
              <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-6">
                {activeEntry.title}
              </h2>
              <MarkdownPreview content={activeEntry.md} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
