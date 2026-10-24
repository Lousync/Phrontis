import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, Heart, NotebookPen, RefreshCw } from 'lucide-react'
import type { IntelItem, IntelSourceKey } from '../../types'
import { intelGetArticle, intelGetItems, intelSaveAsNote, intelToggleFav, openExternal } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
import { SOURCE_META } from '../../lib/intelPure'
import { MarkdownPreview } from '../../components/shared/MarkdownPreview'

/**
 * 情报文章页（v3.12.0，docs/intel-module-plan.md §6.3，对照原型 art 页）。
 *
 * - 头部：源徽标 + 标题 + ♥ 收藏（乐观更新）+ 💾 存为笔记 + ↗ 打开原文（shell.openExternal 既有通道）
 * - 正文：intelGetArticle 拉取（惰性提取 + 缓存）→ MarkdownPreview（760px 阅读列）；
 *   失败模板（原因 + 重试 + 打开原文兜底）——原型 8 种源特有头部模板 v1 简化为统一头部。
 * - 条目被 prune 后渲染「该条情报已过期」空态卡（回情报页 / 关页签），不静默空白。
 */

interface Props {
  itemId: string
  onBack: () => void
  onClose: () => void
}

export function IntelArticleView({ itemId, onBack, onClose }: Props) {
  const [item, setItem] = useState<IntelItem | null>(null)
  const [itemLoaded, setItemLoaded] = useState(false)
  const [md, setMd] = useState<string | null>(null)
  const [articleError, setArticleError] = useState<string | null>(null)
  const [loadingArticle, setLoadingArticle] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  const [favPop, setFavPop] = useState(false)

  const loadItem = useCallback(async () => {
    try {
      const r = await intelGetItems()
      setItem(r.items.find((x) => x.id === itemId) ?? null)
    } catch { /* 保持 null → 过期空态 */ }
    setItemLoaded(true)
  }, [itemId])

  const loadArticle = useCallback(async () => {
    setLoadingArticle(true)
    setArticleError(null)
    try {
      const r = await intelGetArticle(itemId)
      if ('error' in r) setArticleError(r.error)
      else setMd(r.md)
    } catch (err) {
      setArticleError(String((err as Error)?.message ?? err).slice(0, 160))
    } finally {
      setLoadingArticle(false)
    }
  }, [itemId])

  useEffect(() => {
    setMd(null)
    setArticleError(null)
    void loadItem()
    void loadArticle()
  }, [loadItem, loadArticle])
  // 条目可能在本页签开着时被另一窗口刷新/prune —— 广播后对齐
  useDataChanged('intel', loadItem)

  const toggleFav = useCallback(async () => {
    if (!item) return
    const nextFav = !item.fav
    setItem({ ...item, fav: nextFav })
    if (nextFav) {
      setFavPop(true)
      window.setTimeout(() => setFavPop(false), 420)
      showToast({ type: 'success', message: '已收藏', detail: item.title })
    }
    try { await intelToggleFav(item.id) } catch { /* 广播后 loadItem 对齐 */ }
  }, [item])

  const saveNote = useCallback(async () => {
    if (!item || savingNote) return
    setSavingNote(true)
    try {
      const r = await intelSaveAsNote(item.id)
      if (r.ok) showToast({ type: 'success', message: '已存为笔记草稿', detail: r.relPath })
      else showToast({ type: 'error', message: r.error })
    } catch (err) {
      showToast({ type: 'error', message: String((err as Error)?.message ?? err).slice(0, 120) })
    } finally {
      setSavingNote(false)
    }
  }, [item, savingNote])

  if (!itemLoaded) {
    return <div className="h-full w-full animate-pulse bg-[var(--bg-tertiary)]/40" />
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="text-[30px]">🗂</span>
        <div className="text-[13px] text-[var(--text-secondary)]">该条情报已过期</div>
        <div className="text-[11.5px] leading-[1.8] text-[var(--text-muted)]">
          条目可能在自动清理中过期（收藏可豁免清理）
        </div>
        <div className="mt-3 flex gap-2">
          <button
            onClick={onBack}
            className="h-7 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 text-[12px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
          >
            回情报页
          </button>
          <button
            onClick={onClose}
            className="h-7 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]"
          >
            关闭本页签
          </button>
        </div>
      </div>
    )
  }

  const meta = SOURCE_META[item.source as IntelSourceKey]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部 */}
      <div className="flex min-h-[44px] shrink-0 flex-wrap items-center gap-2.5 border-b border-[var(--border-color)] px-4 py-1.5">
        <span
          className="inline-flex shrink-0 items-center rounded px-2 py-[1.5px] text-[10.5px] font-semibold text-white"
          style={{ background: meta?.fg ?? '#4f8f6a' }}
        >
          {!meta && '📰'}{meta?.label ?? item.source}
        </span>
        <span className="min-w-0 max-w-[40%] truncate text-[12.5px] font-semibold text-[var(--text-primary)]" title={item.title}>
          {item.title}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{item.author}</span>
        <span className="flex-1" />
        <button
          onClick={() => { void toggleFav() }}
          title={item.fav ? '取消收藏' : '收藏'}
          className={`flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 text-[11.5px] transition-colors hover:border-[var(--accent)] ${
            item.fav ? 'text-[var(--danger)]' : 'text-[var(--text-primary)]'
          }`}
        >
          <Heart size={12} className={favPop ? 'kb-micro-pop' : ''} fill={item.fav ? 'currentColor' : 'none'} />
          {item.fav ? '已收藏' : '收藏'}
        </button>
        <button
          onClick={() => { void saveNote() }}
          disabled={savingNote || loadingArticle || !!articleError}
          title={articleError ? '正文未提取成功，无法存为笔记（可打开原文手动整理）' : '存入 .knowbase/_draft/intel/ 草稿，编辑器打开'}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--accent)] bg-[var(--accent)] px-2.5 text-[11.5px] text-white transition-colors hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          <NotebookPen size={12} />存为笔记
        </button>
        <button
          onClick={() => { void openExternal(item.url) }}
          title="在系统浏览器打开原文"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 text-[11.5px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
        >
          <ExternalLink size={12} />打开原文
        </button>
      </div>

      {/* 正文 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {loadingArticle ? (
          <div className="mx-auto max-w-[760px] animate-pulse">
            <div className="mb-4 h-7 w-2/3 rounded bg-[var(--bg-tertiary)]" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="mb-3 h-4 rounded bg-[var(--bg-tertiary)]" style={{ width: `${92 - (i % 3) * 12}%` }} />
            ))}
          </div>
        ) : articleError ? (
          <div className="mx-auto mt-16 max-w-md text-center leading-[2.2] text-[var(--text-secondary)]">
            <span className="mb-2 block text-[32px]">🔒</span>
            {articleError}
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => { void loadArticle() }}
                className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-3 text-[12px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)]"
              >
                <RefreshCw size={12} />重试
              </button>
              <button
                onClick={() => { void openExternal(item.url) }}
                className="h-7 rounded-md bg-[var(--accent)] px-3 text-[12px] text-white transition-colors hover:opacity-90"
              >
                ↗ 在浏览器打开
              </button>
            </div>
          </div>
        ) : md !== null ? (
          <div className="kb-view-in mx-auto max-w-[760px] pb-10 text-[13.5px]">
            <MarkdownPreview content={md} />
          </div>
        ) : null}
        {!loadingArticle && !articleError && md === null && (
          <div className="mt-16 flex items-center justify-center gap-2 text-[12px] text-[var(--text-muted)]">
            <AlertTriangle size={13} />正文为空
          </div>
        )}
      </div>
    </div>
  )
}
