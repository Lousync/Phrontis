import { useState, useEffect, useMemo, useRef } from 'react'
import { Trash2, RotateCcw, X, AlertCircle, FileText, BookOpen, Folder, ChevronRight, ChevronDown, ArrowUpDown, Filter, Shield } from 'lucide-react'
import type { RecycleBinItem } from '../../types'
import { getRecycleBinItems, restoreRecycleBinItem, restoreRecycleBinPartial, trashRecycleBinItem, trashRecycleBinPartial, emptyRecycleBin } from '../../lib/ipc'
import { useSettings } from '../../lib/SettingsContext'
import { showToast } from '../../lib/toast'

const MODULE_INFO: Record<string, { label: string; icon: React.ReactNode; badgeClass: string }> = {
  blog:          { label: '博客',     icon: <FileText size={12} />,  badgeClass: 'bg-[var(--accent)]/20 text-[var(--accent)]' },
  knowledge:     { label: '知识页面', icon: <BookOpen size={12} />,  badgeClass: 'bg-[var(--success)]/20 text-[var(--success)]' },
  knowledge_category: { label: '知识目录', icon: <Folder size={12} />, badgeClass: 'bg-[var(--warning)]/20 text-[var(--warning)]' },
  passwordVault: { label: '密码本',   icon: <Shield size={12} />,    badgeClass: 'bg-[var(--danger)]/20 text-[var(--danger)]' },
  moments:       { label: '说说',     icon: <FileText size={12} />,  badgeClass: 'bg-[var(--accent)]/20 text-[var(--accent)]' },
}

const FILE_TYPE_OPTIONS = ['md', 'txt', 'cpp', 'c', 'h', 'hpp', 'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'java', 'rs', 'go', 'sh', 'sql', 'xml', 'yaml', 'pdf', 'pwd', 'mom']

function getItemFileType(item: RecycleBinItem): string {
  if (item.module === 'blog') return 'md'
  if (item.module === 'knowledge') return item.data?.fileType || 'md'
  if (item.module === 'passwordVault') return 'pwd'
  if (item.module === 'moments') return 'mom'
  return 'dir' // knowledge_category
}

export function RecycleBinModule({ isActive = true }: { isActive?: boolean }) {
  const { s } = useSettings()
  const retentionDays = Math.max(1, Math.round(Number(s.recycleBinRetentionDays) || 30))
  const [items, setItems] = useState<RecycleBinItem[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [typeFilter, setTypeFilter] = useState('') // '' = all
  /** 「全部移入系统回收站」的两段式确认（第一次点只上膛，3 秒内再点才执行） */
  const [emptyArmed, setEmptyArmed] = useState(false)
  const [emptying, setEmptying] = useState(false)
  const emptyTimerRef = useRef<number | null>(null)

  // Filtered + sorted items
  const displayItems = useMemo(() => {
    let result = [...items]
    // Filter by type
    if (typeFilter) {
      result = result.filter(item => getItemFileType(item) === typeFilter)
    }
    // Sort by deletedAt
    result.sort((a, b) => {
      const da = a.deletedAt || ''
      const db = b.deletedAt || ''
      return sortOrder === 'desc' ? db.localeCompare(da) : da.localeCompare(db)
    })
    return result
  }, [items, sortOrder, typeFilter])

  // Count of items per file type
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      const ft = getItemFileType(item)
      counts[ft] = (counts[ft] || 0) + 1
    }
    return counts
  }, [items])

  const loadItems = async () => {
    setLoading(true)
    try {
      setItems(await getRecycleBinItems())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadItems() }, [])

  // 每次切换到回收站标签时重新加载，避免删除后数据未刷新
  const prevActive = useRef(isActive)
  useEffect(() => {
    if (isActive && !prevActive.current) {
      loadItems()
    }
    prevActive.current = isActive
  }, [isActive])

  useEffect(() => {
    const handler = () => { loadItems() }
    window.addEventListener('data-imported', handler)
    return () => window.removeEventListener('data-imported', handler)
  }, [])

  useEffect(() => () => {
    if (emptyTimerRef.current !== null) window.clearTimeout(emptyTimerRef.current)
  }, [])

  const toggleExpand = (id: string) => {
    setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  const handleRestore = async (id: string, module: string) => {
    try {
      const r = await restoreRecycleBinItem(id)
      if (r && !r.success) {
        showToast({ type: 'error', message: r.message || '恢复失败' })
        return
      }
      await loadItems()
      showToast({ type: 'info', message: '已恢复到原模块' })
      window.dispatchEvent(new CustomEvent('recycle-restored', { detail: { module } }))
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '恢复失败' })
    }
  }

  const handleRestorePartial = async (binId: string, path: string, module: string) => {
    try {
      await restoreRecycleBinPartial(binId, path)
      await loadItems()
      showToast({ type: 'info', message: '已恢复所选内容' })
      window.dispatchEvent(new CustomEvent('recycle-restored', { detail: { module } }))
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '恢复失败' })
    }
  }

  const handleTrashToOS = async (id: string) => {
    try {
      await trashRecycleBinItem(id)
      await loadItems()
      showToast({ type: 'info', message: '已移入系统回收站' })
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '移入系统回收站失败' })
    }
  }

  const handleTrashPartialToOS = async (binId: string, path: string) => {
    try {
      await trashRecycleBinPartial(binId, path)
      await loadItems()
      showToast({ type: 'info', message: '已移入系统回收站' })
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '移入系统回收站失败' })
    }
  }

  const handleEmptyAll = async () => {
    if (emptying) return
    // 两段式确认：第一次只上膛（3 秒后自动收回），第二次才真的移走
    if (!emptyArmed) {
      setEmptyArmed(true)
      if (emptyTimerRef.current !== null) window.clearTimeout(emptyTimerRef.current)
      emptyTimerRef.current = window.setTimeout(() => {
        setEmptyArmed(false)
        emptyTimerRef.current = null
      }, 3000)
      return
    }
    if (emptyTimerRef.current !== null) {
      window.clearTimeout(emptyTimerRef.current)
      emptyTimerRef.current = null
    }
    setEmptyArmed(false)
    setEmptying(true)
    try {
      await emptyRecycleBin()
      await loadItems()
      showToast({ type: 'info', message: '已全部移入系统回收站' })
    } catch (e) {
      console.error(e)
      showToast({ type: 'error', message: '清空失败，回收站内容未变' })
    } finally {
      setEmptying(false)
    }
  }

  const renderTreeNode = (item: RecycleBinItem) => {
    if (item.module !== 'knowledge_category') return null
    const data = item.data
    const cat = data?.category
    if (!cat) return null

    const isExpanded = expanded.has(item.id)
    const totalItems = (data.pages?.length || 0) + (data.children?.length || 0)

    return (
      <div className="ml-6 border-l border-[var(--border-color)]">
        {/* Category header */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]">
          <button onClick={() => toggleExpand(item.id)} className="shrink-0">
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <Folder size={12} className="text-[var(--warning)]" />
          <span className="truncate flex-1">{cat.name}</span>
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">{totalItems} 项</span>
          <button
            onClick={() => handleRestorePartial(item.id, 'category', item.module)}
            className="p-0.5 rounded text-[var(--accent)] hover:bg-[var(--bg-hover)] shrink-0"
            title="恢复此目录">
            <RotateCcw size={12} />
          </button>
          <button
            onClick={() => handleTrashPartialToOS(item.id, 'category')}
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] shrink-0"
            title="移入系统回收站">
            <X size={12} />
          </button>
        </div>

        {/* Expanded children */}
        {isExpanded && (
          <div>
            {/* Sub-directories */}
            {(data.children || []).map((ch: any, ci: number) => {
              const c = ch.category
              return (
                <div key={`${c.id}`} className="ml-3 border-l border-[var(--border-color)]">
                  <div className="flex items-center gap-1.5 px-3 py-1 text-[11px] text-[var(--text-secondary)] bg-[var(--bg-secondary)]">
                    <span className="w-3" />
                    <Folder size={11} className="text-[var(--text-muted)]" />
                    <span className="truncate flex-1">{c.name}</span>
                    <button
                      onClick={() => handleRestorePartial(item.id, `children.${ci}`, item.module)}
                      className="p-0.5 rounded text-[var(--accent)] hover:bg-[var(--bg-hover)] shrink-0"
                      title="恢复此子目录">
                      <RotateCcw size={11} />
                    </button>
                    <button
                      onClick={() => handleTrashPartialToOS(item.id, `children.${ci}`)}
                      className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] shrink-0"
                      title="移入系统回收站">
                      <X size={11} />
                    </button>
                  </div>
                  {/* Pages in this child */}
                  {(ch.pages || []).map((p: any, pi: number) => (
                    <div key={p.id} className="flex items-center gap-1.5 px-3 py-0.5 ml-6 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                      <FileText size={10} className="text-[var(--text-muted)] shrink-0" />
                      <span className="truncate flex-1">{p.title || '无标题'}</span>
                      <button
                        onClick={() => handleRestorePartial(item.id, `children.${ci}.pages.${pi}`, item.module)}
                        className="p-0.5 rounded text-[var(--accent)] hover:bg-[var(--bg-hover)] shrink-0"
                        title="恢复此页面">
                        <RotateCcw size={11} />
                      </button>
                      <button
                        onClick={() => handleTrashPartialToOS(item.id, `children.${ci}.pages.${pi}`)}
                        className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] shrink-0"
                        title="移入系统回收站">
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )
            })}

            {/* Direct pages */}
            {(data.pages || []).map((p: any, pi: number) => (
              <div key={p.id} className="flex items-center gap-1.5 px-3 py-0.5 ml-3 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
                <FileText size={10} className="text-[var(--text-muted)] shrink-0" />
                <span className="truncate flex-1">{p.title || '无标题'}</span>
                <button
                  onClick={() => handleRestorePartial(item.id, `pages.${pi}`, item.module)}
                  className="p-0.5 rounded text-[var(--accent)] hover:bg-[var(--bg-hover)] shrink-0"
                  title="恢复此页面">
                  <RotateCcw size={11} />
                </button>
                <button
                  onClick={() => handleTrashPartialToOS(item.id, `pages.${pi}`)}
                  className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] shrink-0"
                  title="移入系统回收站">
                  <X size={11} />
                </button>
              </div>
            ))}

            {(data.pages?.length || 0) === 0 && (data.children?.length || 0) === 0 && (
              <p className="px-3 py-2 text-[10px] text-[var(--text-disabled)] italic ml-3">空目录</p>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="kb-theme-surface flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-1 border-b border-[var(--border-color)] px-2 py-1 text-[11.5px] text-[var(--text-muted)] shrink-0 select-none">
        <Trash2 size={12} />
        回收站
        <span>· {displayItems.length}/{items.length} 项</span>
        {items.length > 0 && (
          <button
            onClick={handleEmptyAll}
            disabled={emptying}
            title="全部移入系统回收站（可在系统回收站找回）"
            className={`ml-auto px-1.5 py-0.5 rounded-md text-[11.5px] transition-colors disabled:opacity-50 ${emptyArmed ? 'text-white bg-[var(--danger)] hover:opacity-90' : 'text-[var(--danger)] hover:bg-[var(--bg-hover)]'}`}
          >
            {emptying ? '正在移入…' : emptyArmed ? '确认全部移入？' : '全部移入系统回收站'}
          </button>
        )}
      </div>

      {/* 范围说明：这个模块不是全量文件回收站，避免「删了文件却在这里找不到」的误解 */}
      <div className="px-3 py-1.5 border-b border-[var(--border-color)] shrink-0 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
        这里只收博客 / 密码本 / 动态等模块删除的数据；笔记和文件删除在系统回收站。
      </div>

      {/* Sort + Filter bar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border-color)] shrink-0">
        {/* Sort toggle */}
        <button
          onClick={() => setSortOrder(o => o === 'desc' ? 'asc' : 'desc')}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          title={`按删除时间${sortOrder === 'desc' ? '正序' : '倒序'}`}
        >
          <ArrowUpDown size={12} />
          {sortOrder === 'desc' ? '最近删除' : '最早删除'}
        </button>

        {/* Type filter */}
        <div className="flex items-center gap-1">
          <Filter size={12} className="text-[var(--text-muted)]" />
          <button
            onClick={() => setTypeFilter('')}
            className={`px-2 py-0.5 rounded-md text-[11.5px] transition-colors ${typeFilter === '' ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
          >全部</button>
          {FILE_TYPE_OPTIONS.filter(ft => typeCounts[ft] > 0).map(ft => (
            <button
              key={ft}
              onClick={() => setTypeFilter(typeFilter === ft ? '' : ft)}
              className={`px-2 py-0.5 rounded-md text-[11.5px] transition-colors ${typeFilter === ft ? 'bg-[var(--bg-hover)] text-[var(--text-primary)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'}`}
              title={`${ft} (${typeCounts[ft]})`}
            >
              {ft.toUpperCase()}
              <span className="ml-0.5 opacity-60">{typeCounts[ft]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 30-day notice */}
      {items.length > 0 && (
        <div className="px-5 py-2 flex items-start gap-1.5 text-[11px] text-[var(--warning)] bg-[var(--warning-bg)] border-b border-[var(--border-color)] shrink-0">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>删除的内容将在 {retentionDays} 天后自动清空</span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="border-2 border-[var(--border-color)] border-t-[var(--accent)] rounded-full w-6 h-6 animate-spin" />
          </div>
        ) : displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-20 text-[12px] text-[var(--text-muted)]">
            <span>{typeFilter ? `无 ${typeFilter.toUpperCase()} 类型数据` : '这里还没有模块删除的数据'}</span>
            <span className="text-[10.5px] text-[var(--text-disabled)]">笔记 / 文件删除在系统回收站</span>
          </div>
        ) : (
          <div>
            {displayItems.map(item => {
              const info = MODULE_INFO[item.module] || { label: item.module, icon: null, badgeClass: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' }
              const isCategory = item.module === 'knowledge_category'

              return (
                <div key={item.id} className="kb-item-in border-b border-[var(--border-color)]">
                  {/* Item row */}
                  <div className="flex items-center justify-between px-3 py-2 hover:bg-[var(--bg-hover)] transition-colors">
                    <div className="min-w-0 flex-1 flex items-center gap-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium shrink-0 ${info.badgeClass}`}>
                        {info.icon}
                        {info.label}
                      </span>
                      {getItemFileType(item) !== 'dir' && (
                        <span className="inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-muted)] shrink-0">
                          {getItemFileType(item).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-[13px] text-[var(--text-primary)] truncate">{item.title || '无标题'}</p>
                        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                          删除于 {item.deletedAt?.slice(0, 16)?.replace('T', ' ')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      <button
                        onClick={() => handleRestore(item.id, item.module)}
                        className="p-1.5 rounded text-[var(--accent)] hover:bg-[var(--bg-hover)] transition-colors"
                        title={isCategory ? '恢复整个目录树' : '恢复'}
                      >
                        <RotateCcw size={15} />
                      </button>
                      <button
                        onClick={() => handleTrashToOS(item.id)}
                        className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] transition-colors"
                        title="移入系统回收站"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  </div>

                  {/* Expandable tree for category items */}
                  {isCategory && renderTreeNode(item)}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
