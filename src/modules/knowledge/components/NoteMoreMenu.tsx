/**
 * ⋮ 菜单的**弹层壳**（2026-10-13，批 1c-1；由「菜单太长，窗口一矮底部就被切掉」这条反馈引出）。
 *
 * 它只干一件事：**把菜单高度封在可用空间里，超出部分自己滚**。
 *   · 可用高度 = 视口底 − 菜单自己的顶 − 12px 留白（12 给圆角与阴影留呼吸）；
 *   · 下限 160px：窗口极矮时也留得下几条，不会退化成一条都看不见。
 *
 * ★ 为什么必须是 JS 实测，不能写死 `max-h-[calc(100vh-64px)]`：
 *   菜单顶并不在视口顶 —— 它上面还压着标题栏 + 页签条 + 笔记顶栏（40px），
 *   这段偏移随窗口布局变，任何写死的 vh 算式都会漏掉一截。
 * ★ 为什么用 useLayoutEffect：首帧先按自然高度布局，但在**绘制前**就量好并封顶
 *   ⇒ 不会闪一下"长菜单再把底切掉"。菜单是 `top-full` 锚定的，封顶不改它的 top
 *   ⇒ 不会出现「量了又变、变了又量」的抖动。
 * ★ 为什么这段不写在 `NoteTopBar.tsx` 里：顶栏组件有条硬不变量 —— **零 state**
 *   （`.AGENT/scripts/nonmd-topbar/verify-nonmd-topbar.mjs` A9：四态真源只能在 PageEditor）。
 *   本组件只被顶栏在 `moreOpen` 时挂载，所以 effect 无需依赖「开没开」；
 *   锚点仍留在顶栏那一层（`data-wb="noteTopMoreMenu"`），探针的 `[data-wb="noteTopMoreMenu"] button`
 *   查询照旧能命中（按钮都是本组件的后代）。
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export function NoteMoreMenu({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [maxH, setMaxH] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = (): void => {
      const next = Math.max(160, Math.round(window.innerHeight - el.getBoundingClientRect().top - 12))
      setMaxH((prev) => (prev === next ? prev : next))
    }
    fit()
    // 窗口尺寸变化后封顶值会过期（尤其在最大化 / 还原之间来回切时）
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  return (
    <div
      ref={ref}
      style={maxH === null ? undefined : { maxHeight: maxH }}
      /* `overscroll-contain`：滚到头不许把滚动传给正文 —— 否则「滚菜单」会顺手把文章滚走 */
      className="overflow-y-auto overscroll-contain rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-xl"
    >
      {children}
    </div>
  )
}
