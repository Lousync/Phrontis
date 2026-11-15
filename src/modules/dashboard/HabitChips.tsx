import { useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { AnchoredLayer } from '../../components/shared/AnchoredLayer'
import { orderHabits } from './summary'

/**
 * 看板 · 今日打卡芯片（2026-11-15）。
 *
 * 为什么需要折叠：旧实现把当天所有习惯一次性铺在时间线下 / 右侧窄列里，
 * 打卡一多就会把时间线压扁、甚至顶出卡片（右侧竖列通常 8–10 枚就超过可用高度）。
 *
 * 现在只铺 `VISIBLE_MAX` 枚，其余收进「+N」浮层；浮层内可滚动、可继续勾选。
 * 排序走 `orderHabits`：**未打卡在前、已完成自动后移**，组内保持习惯模块的原序。
 * 浮层用 `AnchoredLayer` 挂 body —— 卡片 / 页面有滚动容器，就地 absolute 会被裁掉。
 */

const VISIBLE_MAX = 6

export interface HabitChipItem {
  id: string
  name: string
  done: boolean
  color: string
}

interface Props {
  items: HabitChipItem[]
  /** 勾选：取消勾选不炸彩纸，所以位置参数可选 */
  onToggle: (id: string, pos?: { x: number; y: number }) => void
}

export function HabitChips({ items, onToggle }: Props) {
  // 排序依赖 items 的引用：快照重取后才重算，勾选后的新序会在广播刷新后落位
  const ordered = useMemo(() => orderHabits(items), [items])
  const visible = ordered.slice(0, VISIBLE_MAX)
  const rest = ordered.length - visible.length
  const [open, setOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement | null>(null)

  const toggle = (h: HabitChipItem, e: React.MouseEvent<HTMLElement>) => {
    if (h.done) { onToggle(h.id); return }
    const r = e.currentTarget.getBoundingClientRect()
    onToggle(h.id, { x: r.left + 12, y: r.top + r.height / 2 })
  }

  return (
    <>
      {visible.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={(e) => toggle(h, e)}
          className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px] transition-colors min-[2000px]:px-3 min-[2000px]:py-1.5 min-[2000px]:text-[10.5px] ${chipTone(h.done)}`}
        >
          <i aria-hidden className="h-[5px] w-[5px] flex-none rounded-[2px]" style={{ background: h.color }} />
          <span className="min-w-0 truncate">{h.name}</span>
        </button>
      ))}

      {rest > 0 && (
        <button
          ref={moreRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-tip={`展开全部打卡项（还有 ${rest} 个）`}
          aria-label={`展开全部打卡项（还有 ${rest} 个）`}
          className="inline-flex flex-none items-center justify-center rounded-full border border-dashed border-[color-mix(in_srgb,var(--text-primary)_18%,transparent)] px-2.5 py-1 text-[9.5px] tabular-nums text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] min-[2000px]:px-3 min-[2000px]:py-1.5 min-[2000px]:text-[10.5px]"
        >
          +{rest}
        </button>
      )}

      <AnchoredLayer
        anchorRef={moreRef}
        open={open}
        onClose={() => setOpen(false)}
        prefer="bottom"
        align="start"
        maxWidth={300}
        className="w-[264px]"
      >
        <div
          role="dialog"
          aria-label="今日打卡"
          className="rounded-[12px] border border-[var(--border-color)] bg-[var(--card-bg)] p-1.5 shadow-[0_12px_34px_rgba(20,35,25,0.16)]"
        >
          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
            <span>今日打卡</span>
            <span className="tabular-nums">{ordered.filter((h) => h.done).length}/{ordered.length}</span>
          </div>
          <div className="flex max-h-[min(56vh,380px)] flex-col gap-0.5 overflow-y-auto pr-0.5">
            {ordered.map((h, i) => (
              <button
                key={h.id}
                type="button"
                onClick={(e) => toggle(h, e)}
                className="kb-item-in flex w-full items-center gap-2 rounded-[7px] px-1.5 py-[6px] text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ animationDelay: `${Math.min(i, 12) * 14}ms` }}
              >
                <span
                  aria-hidden
                  className={`grid h-[14px] w-[14px] flex-none place-items-center rounded-[4px] border transition-colors ${
                    h.done
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[color-mix(in_srgb,var(--text-primary)_20%,transparent)]'
                  }`}
                >
                  {h.done && <Check size={9} strokeWidth={3} />}
                </span>
                <i aria-hidden className="h-[5px] w-[5px] flex-none rounded-[2px]" style={{ background: h.color }} />
                <span className={`min-w-0 flex-1 truncate ${h.done ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>
                  {h.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      </AnchoredLayer>
    </>
  )
}

function chipTone(done: boolean): string {
  return done
    ? 'border-[color-mix(in_srgb,var(--accent)_34%,var(--border-color))] bg-[color-mix(in_srgb,var(--accent)_8%,var(--card-bg))] text-[var(--text-primary)]'
    : 'border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[color-mix(in_srgb,var(--text-primary)_18%,transparent)]'
}
