import { useRef } from 'react'
import { X } from 'lucide-react'
import { usePresence } from '../../lib/usePresence'
import type { BookDownloadTask, BookMarketItem } from '../../types'
import { MarketCover } from './ItemCard'
import { bookRelPathFor, extLabel, fmtBytes, sourceLabel } from './shared'

/**
 * 条目详情抽屉（原型 `aside#detail`）：右缘通高面板，选中卡片时滑入。
 *
 * ★ 弹出项的取值：`item` 变 null 时抽屉正在播退场动画，还要能把内容画完 ——
 *   所以用 ref 记住最后一项（`shown`）。这正是 `usePresence` 的用法约定（延迟卸载）。
 * ★ 复用的是既有动效令牌 `.kb-drawer-in` / `.kb-drawer-out`（2026-09-22 随本模块补进
 *   index.css 的全局基建，同时登记进了 docs/ui-animation-plan.md）—— 不在这里另造过渡。
 */
export function DetailDrawer({ item, task, installed, onClose, onDownload, onRetry, onShowQueue, onOpenShelf }: {
  item: BookMarketItem | null
  task?: BookDownloadTask
  installed: boolean
  onClose: () => void
  onDownload: () => void
  /** 队列里那条是 fail 态时 → 重试（重新入队） */
  onRetry: () => void
  onShowQueue: () => void
  onOpenShelf: () => void
}) {
  const last = useRef<BookMarketItem | null>(null)
  if (item) last.current = item
  const shown = item ?? last.current
  const { mounted, closing } = usePresence(!!item, 180)
  if (!mounted || !shown) return null

  const st = task?.state
  const busy = st === 'down' || st === 'queued' || st === 'paused'
  const rel = bookRelPathFor(shown)
  const size = fmtBytes(shown.sizeBytes)

  return (
    <aside
      data-wb="bookMarketDetail"
      className={`absolute inset-y-0 right-0 z-[6] flex w-[372px] max-w-[86vw] flex-col border-l border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-[0_8px_28px_rgba(0,0,0,0.18)] ${closing ? 'kb-drawer-out' : 'kb-drawer-in'}`}
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--border-color)] px-3 py-2.5">
        <span className="text-[11px] tracking-[.4px] text-[var(--text-muted)]">书目详情</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="ml-auto grid h-6 w-6 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex gap-3.5">
          <div className="w-24 flex-none">
            <MarketCover item={shown} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 mb-1.5 text-[15px] font-medium leading-[1.4] text-[var(--text-primary)]">{shown.title}</h2>
            {shown.author && <div className="mb-2 text-[12.5px] text-[var(--text-secondary)]">{shown.author}</div>}
            <div className="flex gap-2 text-[12px] text-[var(--text-muted)]">
              <span className="w-11 flex-none">来源</span>
              <span className="min-w-0 break-words text-[var(--text-secondary)]">{sourceLabel(shown)}</span>
            </div>
            <div className="mt-1 flex gap-2 text-[12px] text-[var(--text-muted)]">
              <span className="w-11 flex-none">格式</span>
              <span className="text-[var(--text-secondary)]">{extLabel(shown.ext)}</span>
            </div>
            <div className="mt-1 flex gap-2 text-[12px] text-[var(--text-muted)]">
              <span className="w-11 flex-none">体积</span>
              <span className="text-[var(--text-secondary)]">{size || '未知'}</span>
            </div>
          </div>
        </div>

        <div className="mt-[18px]">
          <div className="mb-2.5 flex items-center gap-2 text-[11px] tracking-[.4px] text-[var(--text-muted)]">
            可获取
            <span className="h-px flex-1 bg-[var(--border-color)]" />
          </div>

          <div className="mb-2 flex items-center gap-2.5 rounded-[8px] border border-[var(--border-color)] bg-[var(--card-bg)] p-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium tracking-[.3px] text-[var(--text-primary)]">
                {extLabel(shown.ext)}
                {/* 格式不可读（不在 BOOK_EXTS 里）—— 标「暂不支持」并禁用下载。
                    语境见原型提示条的订正（§九 ④）：旧文案「需二期引擎」是错的，引擎已具备。 */}
                {!shown.readable && (
                  <span className="rounded-[4px] border border-[var(--warning)] bg-[var(--warning-bg)] px-1.5 py-[1px] text-[10px] font-normal text-[var(--warning)]">暂不支持</span>
                )}
              </div>
              <div className="mt-0.5 break-all text-[11px] leading-[1.55] text-[var(--text-muted)]">
                {size ? `${size} · ` : ''}保存为 <span className="font-mono text-[10.5px]">{rel}</span>
              </div>
            </div>
            <div className="flex flex-none items-center gap-1.5">
              {installed && !busy ? (
                <>
                  <button type="button" onClick={onDownload} className="h-[26px] rounded-[7px] border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                    重新下载
                  </button>
                  <button type="button" onClick={onOpenShelf} className="h-[26px] rounded-[7px] border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                    去书架
                  </button>
                </>
              ) : busy ? (
                <button type="button" onClick={onShowQueue} className="h-[26px] rounded-[7px] border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                  {st === 'down' ? '下载中' : st === 'queued' ? '排队中' : '已暂停'} · 查看队列
                </button>
              ) : st === 'fail' ? (
                <button type="button" onClick={onRetry} className="h-[26px] rounded-[7px] border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                  失败 · 重试
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onDownload}
                  disabled={!shown.readable}
                  title={shown.readable ? '下载到 .books/' : '该格式书架打不开，已禁用下载'}
                  className={`h-[26px] rounded-[7px] px-3 text-[12px] transition-colors ${shown.readable
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                    : 'cursor-not-allowed border border-[var(--border-color)] text-[var(--text-disabled)]'}`}
                >
                  下载
                </button>
              )}
            </div>
          </div>

          {task?.error && (
            <div className="mb-2 text-[11px] leading-relaxed text-[var(--danger)]">{task.error}</div>
          )}
        </div>

        {shown.summary && (
          <div className="mt-[18px]">
            <div className="mb-2.5 flex items-center gap-2 text-[11px] tracking-[.4px] text-[var(--text-muted)]">
              简介
              <span className="h-px flex-1 bg-[var(--border-color)]" />
            </div>
            <div className="whitespace-pre-wrap text-[12.5px] leading-[1.78] text-[var(--text-secondary)]">{shown.summary}</div>
          </div>
        )}
      </div>
    </aside>
  )
}
