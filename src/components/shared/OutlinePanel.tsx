import { useMemo, useState } from 'react'
import { FileText, ArrowLeft, Search, X } from 'lucide-react'

export interface HeadingNode {
  level: number       // 1-6
  text: string
  id: string          // anchor id derived from text
  line: number        // 1-indexed line number in source md
  children: HeadingNode[]
}

/** Parse markdown content into a heading tree */
export function parseHeadings(md: string): HeadingNode[] {
  const lines = md.split('\n')
  const root: HeadingNode[] = []
  const stack: { level: number; node: HeadingNode }[] = [] // parent chain

  let i = 0
  while (i < lines.length) {
    if (lines[i].startsWith('```') || lines[i].startsWith('~~~')) {
      // Skip fenced code blocks
      const fence = lines[i].match(/^(`{3,}|~{3,})/)![0]
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) i++
      i++
      continue
    }
    const m = lines[i].match(/^(#{1,6})\s+(.+)/)
    if (m) {
      const level = m[1].length
      const text = m[2].trim()
      const id = text
        .toLowerCase()
        .replace(/[^\w一-鿿\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      const line = i + 1  // 1-indexed
      const node: HeadingNode = { level, text, id, line, children: [] }

      // Pop stack to find the correct parent
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }
      if (stack.length === 0) {
        root.push(node)
      } else {
        stack[stack.length - 1].node.children.push(node)
      }
      stack.push({ level, node })
    }
    i++
  }
  return root
}

/** Case-insensitive title match */
function matchesQuery(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}

/** Count all nodes in a (possibly filtered) heading tree */
function countNodes(nodes: HeadingNode[]): number {
  let n = 0
  for (const node of nodes) n += 1 + countNodes(node.children)
  return n
}

/** Filter the tree: keep matches and their ancestors; keep children of matched parents */
function filterHeadings(nodes: HeadingNode[], query: string): HeadingNode[] {
  const result: HeadingNode[] = []
  for (const node of nodes) {
    const selfMatch = matchesQuery(node.text, query)
    const children = filterHeadings(node.children, query)
    if (selfMatch || children.length > 0) {
      result.push({ ...node, children: selfMatch ? node.children : children })
    }
  }
  return result
}

/** Navigate to a heading — dispatches custom event consumed by PageEditor (editor + preview) */
export function navigateToHeading(line: number, id: string) {
  window.dispatchEvent(new CustomEvent('outline:go-to-heading', { detail: { line, id } }))
}

// ---- render ----
interface OutlinePanelProps {
  pageTitle: string
  headings: HeadingNode[]
  onBackToFile: () => void
  /** Render inside an existing sidebar panel instead of as a standalone panel */
  embedded?: boolean
}

const LEVEL_STYLE: Record<number, string> = {
  1: 'text-[14px] font-bold text-[var(--text-primary)]',
  2: 'text-[13px] font-semibold text-[var(--text-primary)]',
  3: 'text-[12px] font-medium text-[var(--text-secondary)]',
  4: 'text-[12px] font-normal text-[var(--text-muted)]',
  5: 'text-[11px] font-normal text-[var(--text-disabled)]',
  6: 'text-[11px] font-normal text-[var(--text-disabled)] italic',
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-[var(--accent)]/20 text-[var(--text-primary)] rounded px-0.5">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}

function HeadingRow({ node, depth = 0, query = '' }: { node: HeadingNode; depth: number; query?: string }) {
  const levelClass = LEVEL_STYLE[node.level] ?? LEVEL_STYLE[3]

  return (
    <>
      <div
        className={`flex items-center gap-1.5 py-0.5 cursor-pointer hover:bg-[var(--bg-hover)] rounded transition-colors ${levelClass}`}
        style={{ paddingLeft: `${depth * 12 + 12}px`, paddingRight: '10px' }}
        onClick={() => navigateToHeading(node.line, node.id)}
      >
        <span className="truncate"><HighlightedText text={node.text} query={query} /></span>
      </div>
      {node.children.map(ch => (
        <HeadingRow key={ch.id + ':' + (depth + 1)} node={ch} depth={depth + 1} query={query} />
      ))}
    </>
  )
}

export function OutlinePanel({ pageTitle, headings, onBackToFile, embedded = false }: OutlinePanelProps) {
  const [query, setQuery] = useState('')
  const trimmedQuery = query.trim()
  const filtered = useMemo(
    () => (trimmedQuery ? filterHeadings(headings, trimmedQuery) : headings),
    [headings, trimmedQuery]
  )
  const matchCount = trimmedQuery ? countNodes(filtered) : headings.length

  return (
    <div className={`flex flex-col h-full ${embedded ? '' : 'w-[260px] shrink-0 border-r border-[var(--border-color)] kb-theme-surface'}`}>
      {/* Header — back to file view (only for the standalone panel) */}
      {!embedded && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)]">
          <button
            onClick={onBackToFile}
            className="p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
            title="返回文件视图"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <span className="text-[12px] font-medium text-[var(--text-primary)] truncate block">{pageTitle || '无标题'}</span>
            <span className="text-[10px] text-[var(--text-muted)]">{matchCount} 个{trimmedQuery ? '匹配' : '标题'}</span>
          </div>
        </div>
      )}

      {/* Title search */}
      <div className="px-2 pt-2 pb-1 shrink-0">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const first = filtered[0]
                if (first) navigateToHeading(first.line, first.id)
              } else if (e.key === 'Escape' && query) {
                e.preventDefault()
                setQuery('')
              }
            }}
            placeholder="搜索标题…"
            className="w-full pl-6 pr-6 py-1 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none focus:border-[var(--accent)] transition-colors"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
              title="清除"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Heading tree */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-1 py-1">
        {headings.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)]">
            <FileText size={28} className="mb-2 opacity-25" />
            <p className="text-[11px]">大纲内容为空</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--text-muted)]">
            <Search size={28} className="mb-2 opacity-25" />
            <p className="text-[11px]">未找到匹配标题</p>
            <p className="text-[10px] mt-1 text-[var(--text-disabled)]">换个关键词试试</p>
          </div>
        ) : (
          filtered.map(h => (
            <HeadingRow key={h.id} node={h} depth={0} query={trimmedQuery} />
          ))
        )}
      </div>
    </div>
  )
}
