import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Folder, BookOpen, Layers, Sparkles, ChevronRight, House, Lock, LockOpen } from 'lucide-react'
import { Collapsible } from '../shared/Collapsible'
import { FileIcon } from '../shared/FileIcon'
import { getFileTypeInfo } from '../../lib/fileTypes'
import { searchKnowledgePages, getKnowledgePages, getKnowledgeCategories, getKnowledgeTags } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { isInternalKnowledgeTag } from '../../lib/knowledgeTags'
import type { KnowledgeCategory, KnowledgePage, KnowledgeTag } from '../../types'

/**
 * 左栏搜索态（v3.4.0 批次5 反馈轮，开发负责人简图拍板）：
 * 顶栏搜索框删除，全局搜索搬进工作台左栏——总览态头部 🔍 进入（头部 🔖/🔍/🌳 三钮居中，
 * 仿 Obsidian），本面板 = 搜索态：🏠 返回顶层 + 🔒 锁定头部、搜索框、结果列表。
 *
 * 检索逻辑自 QuickSearch 迁入（本地标题模糊 + 后端全文 220ms 防抖 + 命令/目录/标签聚合），
 * 结果选中后**留在搜索态**（可连续打开多个页面）；数据自拉 + useDataChanged 增量。
 */

interface Props {
  onOpenPage: (pageId: string) => void
  onLocateCategory: (categoryId: string) => void
  onRunCommand: (commandId: string) => void
  /** 🏠 返回顶层（退出搜索态回总览） */
  onExit: () => void
  locked: boolean
  onToggleLock: () => void
}

type ResultKind = 'page' | 'notebook' | 'folder' | 'space' | 'tag' | 'command'

interface ResultItem {
  kind: ResultKind
  id: string
  name: string
  subtitle?: string
  fileType?: string
  tagColor?: string
  tagPages?: KnowledgePage[]
  /** 全文命中摘录（含高亮标记） */
  excerpt?: string
}

function fuzzyMatch(query: string, target: string): boolean {
  if (!target) return false
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  return words.every(word => {
    let idx = 0
    for (const ch of word) {
      idx = target.toLowerCase().indexOf(ch, idx)
      if (idx === -1) return false
      idx++
    }
    return true
  })
}

/** 把文本按关键词切分并高亮（多词任一命中） */
function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(t => t.length > 0),
    [query]
  )
  const parts = useMemo(() => {
    if (terms.length === 0 || !text) return [{ t: text, hit: false }]
    const lower = text.toLowerCase()
    const ranges: [number, number][] = []
    for (const term of terms) {
      let i = 0
      while (term.length > 0) {
        const idx = lower.indexOf(term, i)
        if (idx === -1) break
        ranges.push([idx, idx + term.length])
        i = idx + term.length
      }
    }
    if (ranges.length === 0) return [{ t: text, hit: false }]
    ranges.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = [ranges[0]]
    for (const r of ranges.slice(1)) {
      const last = merged[merged.length - 1]
      if (r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
      else merged.push(r)
    }
    const out: { t: string; hit: boolean }[] = []
    let cursor = 0
    for (const [s, e] of merged) {
      if (s > cursor) out.push({ t: text.slice(cursor, s), hit: false })
      out.push({ t: text.slice(s, e), hit: true })
      cursor = e
    }
    if (cursor < text.length) out.push({ t: text.slice(cursor), hit: false })
    return out
  }, [text, terms])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-amber-400/30 px-px text-[var(--text-primary)]">{p.t}</mark>
        ) : (
          <span key={i}>{p.t}</span>
        )
      )}
    </>
  )
}

export function WorkbenchSearchPanel({ onOpenPage, onLocateCategory, onRunCommand, onExit, locked, onToggleLock }: Props) {
  const [pages, setPages] = useState<KnowledgePage[]>([])
  const [categories, setCategories] = useState<KnowledgeCategory[]>([])
  const [tags, setTags] = useState<KnowledgeTag[]>([])
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [expandedTagId, setExpandedTagId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 后端全文搜索结果（带摘录），防抖接入
  const [ftsPages, setFtsPages] = useState<KnowledgePage[]>([])
  const ftsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 数据自拉：进搜索态拉一次 + knowledge 变化增量
  const refresh = useCallback(async () => {
    try {
      const [p, c, t] = await Promise.all([getKnowledgePages(), getKnowledgeCategories(), getKnowledgeTags()])
      setPages(p ?? []); setCategories(c ?? []); setTags(t ?? [])
    } catch { /* 索引未就绪保持旧数据 */ }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useDataChanged('knowledge', refresh)

  useEffect(() => {
    const q = query.trim()
    if (!q) { setFtsPages([]); return }
    if (ftsTimer.current) clearTimeout(ftsTimer.current)
    ftsTimer.current = setTimeout(() => {
      searchKnowledgePages(q)
        .then(setFtsPages)
        .catch(() => setFtsPages([]))
    }, 220)
    return () => { if (ftsTimer.current) clearTimeout(ftsTimer.current) }
  }, [query])

  // 挂载即聚焦（点 🔍 / 快捷键进入后可直接输入）
  useEffect(() => { inputRef.current?.focus() }, [])

  const results = useMemo((): ResultItem[] => {
    if (!query.trim()) return []
    const res: ResultItem[] = []
    const ftsMap = new Map(ftsPages.map(p => [p.id, p]))

    // 功能命令项（搜「AI」/「教学」等命中时置顶）
    if (fuzzyMatch(query, 'AI教学')) {
      res.push({ kind: 'command', id: 'aiTeaching', name: '打开 AI教学', subtitle: '讲义 / 研读 / 出题' })
    }

    // Pages by title（本地即时）+ 全文命中（后端，含仅正文命中的页面）
    const titleHit = new Set<string>()
    for (const p of pages) {
      if (fuzzyMatch(query, p.title)) {
        titleHit.add(p.id)
        const cat = p.categoryId ? categories.find(c => c.id === p.categoryId) : null
        res.push({
          kind: 'page', id: p.id, name: p.title || '无标题',
          subtitle: cat ? cat.name : '零散文件',
          fileType: p.fileType || '',
          excerpt: ftsMap.get(p.id)?.excerpt,
        })
      }
    }
    for (const fp of ftsPages) {
      if (titleHit.has(fp.id)) continue
      if (!pages.some(p => p.id === fp.id)) continue // 防御：以当前列表为准
      const cat = fp.categoryId ? categories.find(c => c.id === fp.categoryId) : null
      res.push({
        kind: 'page', id: fp.id, name: fp.title || '无标题',
        subtitle: (cat ? cat.name : '零散文件') + ' · 正文命中',
        fileType: fp.fileType || '',
        excerpt: fp.excerpt,
      })
    }

    // Categories by name
    for (const c of categories) {
      if (fuzzyMatch(query, c.name)) {
        res.push({
          kind: c.categoryType === 'space' ? 'space' : c.categoryType === 'notebook' ? 'notebook' : 'folder',
          id: c.id, name: c.name,
          subtitle: c.categoryType === 'space' ? '空间' : c.categoryType === 'notebook' ? '笔记本' : '目录'
        })
      }
    }

    // Tags by name（知识包机器标签 kb-* 隐藏）
    for (const t of tags) {
      if (isInternalKnowledgeTag(t.name)) continue
      if (fuzzyMatch(query, t.name)) {
        const tagPages = pages.filter(p => (p.tags || []).some(pt => pt.id === t.id))
        res.push({
          kind: 'tag', id: t.id, name: t.name,
          tagColor: t.color,
          tagPages,
          subtitle: tagPages.length > 0 ? `${tagPages.length} 个页面` : '暂无页面使用此标签',
        })
      }
    }

    return res
  }, [query, pages, categories, tags, ftsPages])

  useEffect(() => { setSelectedIdx(0) }, [results.length])

  const handleSelect = useCallback((item: ResultItem) => {
    switch (item.kind) {
      case 'page':
        onOpenPage(item.id); break
      case 'notebook':
      case 'folder':
      case 'space':
        onLocateCategory(item.id); break
      case 'command':
        onRunCommand?.(item.id); break
      case 'tag':
        if (item.tagPages && item.tagPages.length > 0) {
          setExpandedTagId(prev => prev === item.id ? null : item.id)
          return
        }
        break
    }
    // 选中后留在搜索态（连续打开多个页面），只清展开标签
    setExpandedTagId(null)
  }, [onOpenPage, onLocateCategory, onRunCommand])

  const handleSelectTagPage = useCallback((pageId: string) => {
    onOpenPage(pageId)
    setExpandedTagId(null)
  }, [onOpenPage])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(prev => Math.min(prev + 1, Math.max(results.length - 1, 0)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(prev => Math.max(prev - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (results.length > 0) handleSelect(results[Math.min(selectedIdx, results.length - 1)])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) { setQuery(''); setExpandedTagId(null) }
      else onExit()
    }
  }, [results, selectedIdx, query, onExit, handleSelect])

  const itemCls = 'w-full flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors'

  return (
    <div data-wb="leftSearch" className="flex min-h-0 flex-1 flex-col">
      {/* 头部：🏠 返回顶层 + 🔒 锁定（简图右图排版；模块态同款高度） */}
      <div className="flex h-8 shrink-0 items-center justify-between px-1.5">
        <button onClick={onExit} title="返回总览" className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <House size={13} />
        </button>
        <button
          onClick={onToggleLock}
          title={locked ? '已锁定：主界面切换不改变左栏（点击解锁）' : '锁定侧边栏：主界面切换不改变左栏'}
          className={`rounded p-1 transition-colors ${locked ? 'bg-[var(--bg-hover)] text-[var(--accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
        >
          {locked ? <Lock size={13} /> : <LockOpen size={13} />}
        </button>
      </div>

      {/* 搜索框（头部下方，简图右图） */}
      <div className="shrink-0 px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 transition-colors focus-within:border-[var(--accent)]/60">
          <Search size={13} className="shrink-0 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索页面 / 目录 / 标签…"
            spellCheck={false}
            className="min-w-0 flex-1 border-none bg-transparent py-0.5 text-[12.5px] text-[var(--text-primary)] outline-none placeholder-[var(--text-disabled)]"
          />
        </div>
      </div>

      {/* 结果列表（侧栏窄版条目） */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {!query.trim() ? (
          <div className="px-2 py-6 text-center text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            搜索知识库页面、目录与标签<br />支持正文全文匹配
          </div>
        ) : results.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11.5px] text-[var(--text-muted)]">未找到匹配结果</div>
        ) : (
          <div className="space-y-0.5">
            {results.map((item, idx) => (
              <div key={item.kind + item.id} className="kb-cv-sm">
                <button
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                  className={`${itemCls} ${idx === selectedIdx ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'}`}
                >
                  {item.kind === 'page' && <span className="mt-px shrink-0"><FileIcon ext={item.fileType || ''} size={14} /></span>}
                  {item.kind === 'command' && <Sparkles size={14} className="mt-px shrink-0 text-[var(--accent)]" />}
                  {item.kind === 'notebook' && <BookOpen size={14} className="mt-px shrink-0 text-[var(--text-muted)]" />}
                  {item.kind === 'folder' && <Folder size={14} className="mt-px shrink-0 text-[var(--warning)]" />}
                  {item.kind === 'space' && <Layers size={14} className="mt-px shrink-0 text-[var(--info)]" />}
                  {item.kind === 'tag' && (
                    <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: item.tagColor || '#6b7280' }} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12px] text-[var(--text-primary)]">
                        {item.kind === 'page' ? <Highlighted text={item.name} query={query} /> : item.name}
                      </span>
                      {item.subtitle && <span className="shrink-0 truncate text-[9.5px] text-[var(--text-muted)]">{item.subtitle}</span>}
                      {item.kind === 'tag' && item.tagPages && item.tagPages.length > 0 && (
                        <ChevronRight size={10} className={`kb-chevron ml-auto shrink-0 text-[var(--text-muted)] ${expandedTagId === item.id ? 'rotate-90' : ''}`} />
                      )}
                    </span>
                    {item.excerpt && (
                      <span className="mt-0.5 line-clamp-2 block text-[10.5px] leading-snug text-[var(--text-muted)]">
                        <Highlighted text={item.excerpt} query={query} />
                      </span>
                    )}
                  </span>
                </button>

                {/* 标签展开（页内嵌套列表） */}
                {item.kind === 'tag' && item.tagPages && item.tagPages.length > 0 && (
                  <Collapsible open={expandedTagId === item.id} innerClassName="">{() => (
                    <div className="mb-1 ml-4 space-y-0.5 border-l border-[var(--border-color)] pl-1.5">
                      {(item.tagPages ?? []).map(p => (
                        <button key={p.id} onClick={() => handleSelectTagPage(p.id)}
                          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11.5px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        >
                          <FileIcon ext={p.fileType || ''} size={12} />
                          <span className="min-w-0 flex-1 truncate">{p.title || '无标题'}</span>
                        </button>
                      ))}
                    </div>
                  )}</Collapsible>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部快捷键提示（有结果时） */}
      {query.trim() && results.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-color)] px-2.5 py-1 text-[9.5px] text-[var(--text-muted)]">
          <span>{results.length} 个结果</span>
          <span className="flex gap-2"><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 清空</span></span>
        </div>
      )}
    </div>
  )
}
