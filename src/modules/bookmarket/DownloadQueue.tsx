import { Check, Download, Pause, Play, RotateCw, X } from 'lucide-react'
import { usePresence } from '../../lib/usePresence'
import type { BookDownloadAction, BookDownloadState, BookDownloadTask } from '../../types'
import { extLabel } from './shared'

/**
 * 下载面板（原型 `#dlq` 浮动卡片）：右下角浮出，一次只跑一个（拍板 ⑬）。
 *
 * ★ 状态全部来自主进程的**整份快照**（`bookMarketListQueue` / `onBookMarketDownloadProgress`
 *   的载荷就是整个 tasks 数组）—— 渲染层不自己推演进度、不自己算下一个是谁，
 *   那些都在 downloader 里（真相源）。这里只画 + 发控制动作。
 * ★ 退场动画同样走 usePresence 的既有约定：`open` 下降沿不立刻卸载。
 */

const STATE_LABEL: Record<BookDownloadState, string> = {
  queued: '排队中', down: '下载中', paused: '已暂停', done: '已完成', fail: '失败',
}
const STATE_COLOR: Record<BookDownloadState, string> = {
  queued: 'var(--text-muted)',
  down: 'var(--accent)',
  paused: 'var(--warning)',
  done: 'var(--success)',
  fail: 'var(--danger)',
}

const ICON_BTN = 'grid h-[22px] w-[22px] place-items-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
const GHOST_BTN = 'h-6 rounded-[6px] border border-[var(--border-color)] px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'

/** 「另存副本」的落盘名带 ` (2)`（下载器 copyNameFor 的规则），据此给队列行标一个「副本」 */
function isCopy(task: BookDownloadTask): boolean {
  return /\s\(\d+\)(\.|$)/.test(task.relPath)
}

function Row({ task, onControl, onOpenShelf }: {
  task: BookDownloadTask
  onControl: (id: string, action: BookDownloadAction) => void
  onOpenShelf: () => void
}) {
  const st = task.state
  const known = task.total > 0
  const pct = known ? Math.min(100, Math.round((task.received / task.total) * 100)) : 0
  const sub = st === 'down'
    ? (known ? '' : '体积未知')
    : st === 'queued' ? '等待前面的下载完成'
      : st === 'paused' ? '已暂停'
        : st === 'done' ? '已写入 .books/'
          : (task.error || '下载失败')

  return (
    <div className={`flex items-start gap-2 rounded-lg px-2 py-2.5 hover:bg-[var(--bg-hover)] ${st === 'done' ? 'opacity-70' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[12px] text-[var(--text-primary)]">
          <span className="truncate">{task.title}</span>
          {isCopy(task) && <span className="flex-none rounded-[3px] bg-[var(--bg-tertiary)] px-1 text-[10px] text-[var(--text-muted)]">副本</span>}
          <span className="flex-none text-[10px] text-[var(--text-muted)]">· {extLabel(task.relPath.slice(task.relPath.lastIndexOf('.')))}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]">
          <span className="flex-none rounded-[3px] bg-[var(--bg-tertiary)] px-1 py-[1px]" style={{ color: STATE_COLOR[st] }}>{STATE_LABEL[st]}</span>
          {task.retry > 0 && st !== 'done' && <span className="flex-none">已重试 {task.retry}</span>}
          {sub && <span className={`truncate ${st === 'fail' ? 'text-[var(--danger)]' : ''}`}>{sub}</span>}
          {st !== 'done' && st !== 'fail' && (
            <span className="ml-auto flex-none tabular-nums">{known ? `${pct}%` : ''}</span>
          )}
        </div>
        {st !== 'fail' && (
          <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            {known ? (
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-linear"
                style={{ width: `${pct}%`, background: st === 'done' ? 'var(--success)' : st === 'paused' ? 'var(--text-disabled)' : 'var(--accent)' }}
              />
            ) : (
              /* 服务端没给 Content-Length（分块传输）⇒ 进度无从算起，条改成脉冲提示「在动」 */
              <div className={`h-full rounded-full ${st === 'down' ? 'animate-pulse bg-[var(--accent)]' : 'bg-[var(--bg-hover)]'}`} />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-none gap-[2px] pt-[1px]">
        {st === 'done' && (
          <button type="button" onClick={onOpenShelf} className={GHOST_BTN}>去书架</button>
        )}
        {st === 'down' && (
          <button type="button" title="暂停" className={ICON_BTN} onClick={() => onControl(task.id, 'pause')}><Pause size={11} strokeWidth={2.4} /></button>
        )}
        {st === 'paused' && (
          <button type="button" title="继续" className={ICON_BTN} onClick={() => onControl(task.id, 'resume')}><Play size={11} /></button>
        )}
        {st === 'fail' && (
          <button type="button" title="重试" className={ICON_BTN} onClick={() => onControl(task.id, 'retry')}><RotateCw size={11} strokeWidth={2.2} /></button>
        )}
        {st !== 'done' && (
          <button type="button" title={st === 'fail' ? '从列表移除' : '取消下载'} className={ICON_BTN} onClick={() => onControl(task.id, 'cancel')}>
            <X size={11} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  )
}

export function DownloadQueue({ open, tasks, onClose, onControl, onOpenShelf }: {
  open: boolean
  tasks: BookDownloadTask[]
  onClose: () => void
  onControl: (id: string, action: BookDownloadAction) => void
  onOpenShelf: () => void
}) {
  // 进出场：进场用 .kb-view-in（淡入 + 上移 8px），退场**就近借** .kb-toast-out
  //（同一个右下角、同一种浮出卡片，淡出 + 右移 18px + 微缩）——不为了这一处再补一对 keyframes（铁律 13）。
  const { mounted, closing } = usePresence(open, 150)
  if (!mounted) return null

  const active = tasks.filter((t) => t.state === 'queued' || t.state === 'down' || t.state === 'paused')
  const count = (s: BookDownloadState) => tasks.filter((t) => t.state === s).length
  const parts: string[] = []
  if (count('down')) parts.push(`${count('down')} 个下载中`)
  if (count('queued')) parts.push(`${count('queued')} 个排队`)
  if (count('paused')) parts.push(`${count('paused')} 个已暂停`)
  if (count('fail')) parts.push(`${count('fail')} 个失败`)
  const agg = parts.length ? parts.join(' · ') : (tasks.length ? '已全部完成' : '')
  const canPause = count('down') + count('queued') > 0

  return (
    <div
      data-wb="bookMarketQueue"
      className={`${closing ? 'kb-toast-out' : 'kb-view-in'} fixed bottom-[18px] right-[18px] z-30 w-[382px] max-w-[92vw] rounded-xl border border-[var(--border-color)] bg-[var(--bg-primary)] shadow-[0_8px_28px_rgba(0,0,0,0.2)]`}
    >
      <div className="flex items-center gap-2 border-b border-[var(--border-color)] px-3 py-2.5 text-[12px]">
        <Download size={13} strokeWidth={1.8} />
        <span>下载</span>
        <span className="text-[11.5px] text-[var(--text-muted)]">{agg}</span>
        <span className="ml-auto flex items-center gap-1">
          {active.length > 0 && (
            <button
              type="button"
              title={canPause ? '全部暂停' : '全部开始'}
              className={ICON_BTN}
              onClick={() => onControl('', canPause ? 'pause-all' : 'resume-all')}
            >
              {canPause ? <Pause size={11} strokeWidth={2.4} /> : <Play size={11} />}
            </button>
          )}
          {count('done') > 0 && (
            <button type="button" title="清除已完成" className={ICON_BTN} onClick={() => onControl('', 'clear-done')}>
              <Check size={12} strokeWidth={2.4} />
            </button>
          )}
          <button type="button" title="收起" className={ICON_BTN} onClick={onClose}>
            <X size={12} strokeWidth={2} />
          </button>
        </span>
      </div>
      <div className="max-h-[330px] overflow-y-auto p-2">
        {tasks.length === 0
          ? <div className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">暂无下载</div>
          : tasks.map((t) => <Row key={t.id} task={t} onControl={onControl} onOpenShelf={onOpenShelf} />)}
      </div>
    </div>
  )
}
