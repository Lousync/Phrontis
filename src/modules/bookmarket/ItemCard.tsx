import { Check, Loader2 } from 'lucide-react'
import type { BookDownloadTask, BookMarketItem } from '../../types'
import { extLabel, sourceLabel } from './shared'

/**
 * 书市条目卡（原型 `.card`）。
 *
 * ★ 为什么封面是**纯色书卡**而不是源给的封面图（`item.coverUrl`）——这是有意不做，不是漏了：
 *   渲染层 CSP 的 `img-src` 是白名单（'self' data: blob: file: attachment: plugin: + 三个 CDN），
 *   任意书源的 `https://…` 图**会被直接拦掉**，写了也只是在控制台报一串 CSP 违规。
 *   放宽成 `https:` 等于允许任何源把请求引向任意主机（暴露「本机装了本应用 + 公网 IP」），
 *   为一张缩略图不值得。真封面在下**载**时抓到 `.books/.covers/`，由书架显示（S4 拍板 ①）——
 *   那时它是本地文件，不受 CSP 影响。
 *   原型里的 `.cover` 本来就是纯色卡，这条与验收基线一致。
 */

/** 书卡色板（原型 `C`，8 组低饱和深色 —— 配白字在明暗两套主题下都够对比度） */
const PALETTE = ['#8a6d5b', '#5b6b8a', '#6b8a5b', '#8a5b6b', '#5b8a86', '#7a6a8a', '#8a7b5b', '#5b7a8a']

function paletteOf(seed: string): string {
  let sum = 0
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i)
  return PALETTE[sum % PALETTE.length]
}

/** 纯色书卡（网格与详情抽屉共用；不读文件、不发请求） */
export function MarketCover({ item, className = '' }: { item: BookMarketItem; className?: string }) {
  return (
    <div
      className={`flex aspect-[2/3] w-full flex-col justify-between overflow-hidden rounded-[7px] p-2.5 text-white select-none ${className}`}
      style={{ background: paletteOf(`${item.title}${item.author}`) }}
    >
      <div className="line-clamp-3 text-[13px] font-medium leading-[1.35]">{item.title}</div>
      <div>
        {item.author && <div className="truncate text-[11px] opacity-80">{item.author}</div>}
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* 不在 BOOK_EXTS 里 ⇒ 删除线（拍板 ②③ 的第二步：这里只标「不可读」，
              不再写「需二期引擎」——引擎早就有了，旧文案才是错的） */}
          <span className={`rounded-[3px] bg-white/25 px-1 py-[1px] text-[9px] tracking-[.3px] ${item.readable ? '' : 'line-through opacity-45'}`}>
            {extLabel(item.ext)}
          </span>
        </div>
      </div>
    </div>
  )
}

/** 卡片底部状态行：三者互斥，按优先级 下载中/排队/暂停 > 已上架 > 暂不支持 */
function StateLine({ task, installed, readable }: { task?: BookDownloadTask; installed: boolean; readable: boolean }) {
  if (task && (task.state === 'down' || task.state === 'queued' || task.state === 'paused')) {
    const label = task.state === 'down' ? '下载中' : task.state === 'queued' ? '排队中' : '已暂停'
    return (
      <div className="mt-1 flex items-center gap-1 text-[10.5px] text-[var(--accent)]">
        <Loader2 size={10} className="animate-spin" />
        {label}
      </div>
    )
  }
  if (installed) {
    return (
      <div className="mt-1 flex items-center gap-1 text-[10.5px] text-[var(--success)]">
        <Check size={11} strokeWidth={2.4} />
        已上架
      </div>
    )
  }
  if (!readable) {
    return <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">暂不支持</div>
  }
  return null
}

export function ItemCard({ item, selected, installed, task, onOpen }: {
  item: BookMarketItem
  selected: boolean
  /** 已上架（`.books/` 里已有同名文件 —— 判定在 index.tsx，用的是下载器同一套命名函数） */
  installed: boolean
  /** 队列里的对应任务（有则显示「下载中/排队中/已暂停」） */
  task?: BookDownloadTask
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={item.title}
      className={`kb-item-in group rounded-[10px] p-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] ${selected ? 'bg-[var(--bg-selected)]' : ''}`}
    >
      <MarketCover item={item} />
      <div className="px-0.5 pt-2">
        <div className="line-clamp-2 text-[12.5px] leading-[1.35] text-[var(--text-primary)]">{item.title}</div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
          {item.author ? `${item.author} · ` : ''}{sourceLabel(item)}
        </div>
        <StateLine task={task} installed={installed} readable={item.readable} />
      </div>
    </button>
  )
}
