import { Search } from 'lucide-react'
import type { BookDownloadTask, BookMarketItem, BookSearchFailure, BookSourceInfo } from '../../types'
import { ItemCard } from './ItemCard'
import { itemKey } from './shared'

/**
 * 书市 · 发现页（原型 `#discoverPane`）：搜索框是主体，结果是网格。
 *
 * 数据全部由 index.tsx 持有（检索状态与滚动容器都在那边：切「书源」页时不能把结果丢掉，
 * 切回来要还在 —— 与原型 `render(keepScroll)` 的语义一致）。
 * 这里只负责画：骨架 / 灰条（部分源未返回）/ 空态 / 网格 / 加载更多。
 */

function Skeleton() {
  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
        检索中…
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-4">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="p-1.5">
            <div className="aspect-[2/3] w-full animate-pulse rounded-[7px] bg-[var(--bg-hover)]" />
            <div className="mt-2 h-[11px] w-[82%] animate-pulse rounded bg-[var(--bg-hover)]" />
            <div className="mt-1.5 h-[9px] w-[52%] animate-pulse rounded bg-[var(--bg-hover)]" />
          </div>
        ))}
      </div>
    </>
  )
}

/** 「部分源未返回结果」灰条（拍板 ⑦：不整页报错、不醒目、可重试） */
function FailureBar({ failed, onRetry, onGoSources }: {
  failed: BookSearchFailure[]
  onRetry: () => void
  onGoSources: () => void
}) {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-[8px] bg-[var(--bg-tertiary)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
      <span className="min-w-0 flex-1">
        <b className="font-medium text-[var(--text-secondary)]">{failed.length} 个源未返回结果</b>：
        {failed.map((f) => `${f.name}（${f.reason}）`).join('、')}
        —— 以下结果来自其余已启用的源
      </span>
      <span className="flex flex-none gap-1.5">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-[var(--border-color)] px-2 py-[2px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          重试
        </button>
        <button
          type="button"
          onClick={onGoSources}
          className="rounded-md border border-[var(--border-color)] px-2 py-[2px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          去书源
        </button>
      </span>
    </div>
  )
}

export function DiscoverView({ q, setQ, srcFilter, setSrcFilter, sources, loading, searched, items, failed, searchErr,
  hasMore, stuck, selKey, onSearch, onLoadMore, onSelect, onGoSources, installedOf, taskOf }: {
  q: string
  setQ: (v: string) => void
  srcFilter: string
  setSrcFilter: (v: string) => void
  sources: BookSourceInfo[]
  loading: boolean
  /** 是否已经检索过（区分「还没搜」与「搜了没结果」—— 不搜不给结果，与原型「默认全列」不同） */
  searched: boolean
  items: BookMarketItem[]
  failed: BookSearchFailure[]
  searchErr: string
  hasMore: boolean
  /** 滚过 4px 后搜索条吸顶加分隔线（原型 `.barwrap.stuck`） */
  stuck: boolean
  selKey: string | null
  onSearch: () => void
  onLoadMore: () => void
  onSelect: (key: string) => void
  onGoSources: () => void
  installedOf: (it: BookMarketItem) => boolean
  taskOf: (it: BookMarketItem) => BookDownloadTask | undefined
}) {
  const enabled = sources.filter((s) => s.enabled)
  const srcName = srcFilter === 'all' ? '全部书源' : (sources.find((s) => s.id === srcFilter)?.name ?? '所选书源')
  const title = q.trim() ? `「${q.trim()}」· ${items.length} 条结果` : `${srcName} · 共 ${items.length} 本`

  return (
    <>
      <div className="px-4 pb-5 pt-8 text-center">
        <h1 className="m-0 text-[22px] font-medium tracking-[.6px]">书市</h1>
        <p className="mx-auto mt-2.5 max-w-[520px] text-[12.5px] leading-[1.75] text-[var(--text-muted)]">
          从书源里找到一本书，直接下载到书架。预置的只有公版与公共目录。
        </p>
      </div>

      <div className={`sticky top-0 z-[5] border-b px-4 pb-3 pt-1.5 transition-colors ${stuck ? 'border-[var(--border-color)]' : 'border-transparent'} bg-[var(--bg-primary)]`}>
        <div className="mx-auto flex h-[50px] max-w-[640px] items-center gap-2.5 rounded-[13px] border border-[var(--border-color)] bg-[var(--input-bg)] pl-3.5 pr-2 transition-colors focus-within:border-[var(--accent)]">
          <Search size={17} className="flex-none text-[var(--text-muted)]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSearch() }}
            placeholder="搜书名或作者"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 select-text bg-transparent text-[14.5px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <select
            value={srcFilter}
            onChange={(e) => setSrcFilter(e.target.value)}
            title="限定检索哪个书源"
            className="h-8 max-w-[168px] rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] px-1.5 text-[12px] text-[var(--text-secondary)] outline-none"
          >
            <option value="all">全部书源（{enabled.length}）</option>
            {enabled.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button
            type="button"
            onClick={onSearch}
            disabled={loading}
            className="h-[34px] flex-none rounded-[8px] bg-[var(--accent)] px-4 text-[12.5px] text-white transition-colors hover:bg-[var(--accent-hover)] disabled:bg-[var(--bg-tertiary)] disabled:text-[var(--text-disabled)]"
          >
            检索
          </button>
        </div>
      </div>

      <div className="px-4 pb-5 pt-1.5">
        {searchErr && (
          <div className="mb-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] text-[var(--warning)]">
            检索失败：{searchErr}
          </div>
        )}

        {loading ? <Skeleton /> : (
          <>
            {failed.length > 0 && <FailureBar failed={failed} onRetry={onSearch} onGoSources={onGoSources} />}

            {!searched && (
              /* 初始态：真实检索**必须有关键词**（原型默认把演示数据全列出来，实机没有这种「列全部」的语义） */
              <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-20 text-center text-[var(--text-muted)]">
                <Search size={34} strokeWidth={1.3} />
                <div className="text-[14px] font-medium text-[var(--text-secondary)]">输入书名或作者开始检索</div>
                <p className="m-0 max-w-[340px] text-[12.5px] leading-[1.7]">
                  {enabled.length === 0
                    ? '当前没有启用的书源 —— 去「书源」里启用一个，或添加你自己的 OPDS 源。'
                    : `将从 ${enabled.length} 个已启用的书源里检索；预置的只有公版与公共目录。`}
                </p>
              </div>
            )}

            {searched && items.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2.5 px-5 py-20 text-center text-[var(--text-muted)]">
                <Search size={34} strokeWidth={1.3} />
                <div className="text-[14px] font-medium text-[var(--text-secondary)]">没有匹配的结果</div>
                <p className="m-0 max-w-[340px] text-[12.5px] leading-[1.7]">
                  换个关键词，或在「书源」里添加你自己的 OPDS 源 —— 自建 Calibre-Web、Komga 都支持。
                </p>
              </div>
            )}

            {items.length > 0 && (
              <>
                <div className="mb-3 mt-0.5 flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
                  {title}
                  <span className="h-px flex-1 bg-[var(--border-color)]" />
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-4">
                  {items.map((it) => {
                    const key = itemKey(it)
                    return (
                      <ItemCard
                        key={key}
                        item={it}
                        selected={selKey === key}
                        installed={installedOf(it)}
                        task={taskOf(it)}
                        onOpen={() => onSelect(key)}
                      />
                    )
                  })}
                </div>
                {hasMore && (
                  <div className="flex justify-center pb-2 pt-5">
                    <button
                      type="button"
                      onClick={onLoadMore}
                      className="h-[30px] rounded-lg border border-[var(--border-color)] px-4 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                    >
                      加载更多
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
