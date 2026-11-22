import { memo, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { usePresence } from '../../lib/usePresence'
import { dashActiveIndex, dashIndexes, moveSelection, type TurnItem } from './turnRailPure'

/**
 * AI 教学 · 右缘「轮次导航」（2026-11-21 重做，方案 `tmp/ai-teach-anchor-rail/PLAN.md`）。
 *
 * 形态（按 DeepSeek 实拍校正）：
 * - 收起态 = 右缘中部**一列短横**（≤11 条采样），绝不贯穿全高；
 * - 展开态 = 贴右缘的**浮动卡片**，行 = 用户提问首句（右对齐、行尾省略）+ 行尾短横；
 *   短横就是刻度，点行跳转并闪烁，超过高度在卡片内滚动。
 *
 * 组件边界：**只做导航本身**。数据（turns / 当前轮）与跳转（写 scrollTop + 挂闪烁层）
 * 都在 `index.tsx` —— 它才知道滚动容器和消息行；这里只管开合 / 选择 / 键盘 / 触摸钉住。
 */
export interface TurnRailProps {
  turns: TurnItem[]
  /** 当前轮下标（0 起） */
  active: number
  /** 跳到第 i 轮（index.tsx 写 scrollTop + 闪烁） */
  onJump: (turnIdx: number) => void
}

/** 指针离开后收起前的宽限（与方案 §六 一致：240ms） */
const CLOSE_DELAY = 240
/** 卡片退场时长（= --dur-std），用于「先播完退场再卸行」 */
const EXIT_MS = 220

export const TurnRail = memo(function TurnRail({ turns, active, onJump }: TurnRailProps) {
  const [open, setOpen] = useState(false)
  /** 触摸 / 笔点收起态 → 钉住（鼠标路径不可达：鼠标一靠近就展开、短横列被卡片盖住） */
  const [pinned, setPinned] = useState(false)
  /** 键盘聚焦后，「当前」高亮跟随 `sel` 而不是滚动位置 */
  const [focusMode, setFocusMode] = useState(false)
  const [sel, setSel] = useState(active)

  const railRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)

  /** 卡片退场期间行还要在（否则淡出的是个空盒子）；240ms 后真正卸载 */
  const { mounted } = usePresence(open, EXIT_MS)

  const clearClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const openRail = (pin: boolean): void => {
    clearClose()
    setOpen(true)
    if (pin) setPinned(true)
  }

  const closeRail = (unpin: boolean): void => {
    clearClose()
    setOpen(false)
    setFocusMode(false)
    if (unpin) setPinned(false)
  }

  const scheduleClose = (): void => {
    if (pinned) return
    clearClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, CLOSE_DELAY)
  }

  useEffect(() => () => clearClose(), [])

  /** 键盘选择变化 / 打开时：把那一行滚到卡片中部（`open` 专用，别跟着滚动位置跑） */
  const scrollRowIntoView = (turnIdx: number): void => {
    const list = listRef.current
    if (!list) return
    const row = list.children[turnIdx] as HTMLElement | undefined
    if (!row) return
    if (list.scrollHeight <= list.clientHeight) { list.scrollTop = 0; return }
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
    list.scrollTop = Math.max(0, top - list.clientHeight / 2 + row.offsetHeight / 2)
  }

  // 打开时把当前轮滚进视野：120 轮也一眼看到自己在哪。
  // 行在 `open` 的那一次提交就已挂上（见 rowsVisible），所以这里能直接读到子节点。
  useEffect(() => {
    if (!open) return
    scrollRowIntoView(focusMode ? sel : active)
    // 只在「刚打开」这一刻定位；之后跟随键盘选择由 keydown 里显式调用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 用户自己滚动对话后，键盘选中项过期 → 拉回当前轮（方案 §七-② 第 5 步）
  useEffect(() => {
    if (focusMode) setSel(active)
  }, [active, focusMode])

  // 展开状态下的「点外部 / Esc 关闭」。用 window 捕获阶段接 Esc：只接管这一次，
  // 不让它继续冒泡到模块既有的 Esc 链（index.tsx 的浮层逐个关闭 → 退禅）。
  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.PointerEvent): void => {
      const t = e.target as Node | null
      if (t && (railRef.current?.contains(t) || cardRef.current?.contains(t))) return
      closeRail(true)
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      closeRail(true)
    }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onRailEnter = (e: PointerEvent<HTMLDivElement>): void => {
    // 触摸 / 笔没有 hover 语义：一律等 tap（否则手指落下的瞬间卡片盖住手指，点到的就是行）
    if (e.pointerType !== 'mouse') return
    openRail(false)
  }

  const onRailLeave = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType !== 'mouse') return
    // 卡片展开后会盖住短横列，浏览器可能补发一次 leave：
    // 指针其实已经落在卡片矩形里，就别排关闭（否则刚展开就闪断）
    const r = cardRef.current?.getBoundingClientRect()
    if (open && r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return
    scheduleClose()
  }

  const onRailKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter') {
      if (turns.length === 0) return
      e.preventDefault()
      onJump(sel)
      closeRail(true)
      return
    }
    if (e.key === 'Escape') {
      // 焦点在轨道上时也要「按键即关」，且不落到模块 Esc 链
      e.preventDefault()
      e.stopPropagation()
      closeRail(true)
      railRef.current?.blur()
      return
    }
    const next = moveSelection(sel, e.key, turns.length)
    if (next === null) return
    e.preventDefault()
    setSel(next)
    setFocusMode(true)
    if (!open) openRail(pinned)
    scrollRowIntoView(next)
  }

  const onRailFocus = (): void => {
    setFocusMode(true)
    setSel(active)
    openRail(false)
  }

  const onRailBlur = (e: FocusEvent<HTMLDivElement>): void => {
    const to = e.relatedTarget as Node | null
    if (to && cardRef.current?.contains(to)) return
    setFocusMode(false)
    scheduleClose()
  }

  const dashes = dashIndexes(turns.length)
  const curDash = dashActiveIndex(dashes, active)
  /** 视觉上的「当前行」：键盘模式下跟随选择，否则跟随滚动位置 */
  const hl = focusMode ? sel : active
  /** 行：展开时立即挂（同一帧就能滚到当前轮），收起后延迟到淡出播完再卸 */
  const rowsVisible = open || mounted

  return (
    <>
      {/* 收起态：一列短横（命中区由 .kb-turn-rail::before 外扩，不影响布局） */}
      <div
        ref={railRef}
        tabIndex={0}
        role="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="turn-list"
        aria-label="轮次导航"
        className="kb-turn-rail"
        onPointerEnter={onRailEnter}
        onPointerLeave={onRailLeave}
        onClick={() => openRail(true)}
        onKeyDown={onRailKeyDown}
        onFocus={onRailFocus}
        onBlur={onRailBlur}
      >
        {dashes.map((d, i) => (
          <span key={d} className="kb-turn-dash" data-cur={i === curDash ? '1' : undefined} />
        ))}
      </div>

      {/* 展开态：满高 flex 容器负责垂直居中（免 JS 量高），卡片自己带 max-height 与内滚 */}
      <div
        className="pointer-events-none absolute inset-y-0 right-2 z-20 flex items-center justify-end pt-9"
        style={{ width: 'min(300px, calc(100% - 44px))' }}
      >
        <div
          ref={cardRef}
          id="turn-list"
          role="listbox"
          aria-label="轮次列表"
          onPointerEnter={e => { if (e.pointerType === 'mouse') clearClose() }}
          onPointerLeave={e => { if (e.pointerType === 'mouse') scheduleClose() }}
          className={`pointer-events-auto flex max-h-[min(300px,calc(100%_-_20px))] w-full flex-col overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--border-color)_78%,transparent)] bg-[var(--bg-tertiary)] shadow-[var(--tip-shadow)] transition-[opacity,transform,visibility] duration-[var(--dur-std)] ease-[var(--ease-kb)] motion-reduce:transition-none ${open ? 'visible translate-x-0 opacity-100' : 'invisible translate-x-2.5 opacity-0'}`}
        >
          <div ref={listRef} className="kb-hide-scrollbar min-h-0 flex-1 overflow-y-auto py-2">
            {rowsVisible && turns.map((t, i) => (
              <button
                key={t.no}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={i === hl}
                aria-label={`第 ${t.no} 轮${t.time ? ` · ${t.time}` : ''}：${t.title}`}
                onClick={() => { setSel(i); onJump(i); closeRail(true) }}
                className={`flex h-[30px] w-full items-center justify-end gap-2.5 px-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] ${i === hl ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
              >
                <span className="min-w-0 truncate text-[12px] leading-[1.4]">{t.title}</span>
                <span className={`h-0.5 w-3 shrink-0 rounded-[1px] ${i === hl ? 'bg-[var(--accent)]' : 'bg-[color-mix(in_srgb,var(--text-muted)_55%,transparent)]'}`} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
})
