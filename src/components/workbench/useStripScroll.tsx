import { useCallback, useEffect, useRef, useState } from 'react'
import { stripEdges, stripReveal, stripWheelDelta } from './stripScrollPure'

/**
 * 页面条横向溢出：DOM 侧接线（台账 F-16，2026-10-13）。
 *
 * 修的是什么（`docs/v3.4.0-feedback.md` 的 F-16 条）：整条页面条是单行不换行、行容器
 * `overflow-x-clip`（禁止滚动），三个区又各自为政 —— 模块条目 `shrink-0` 无上限，
 * 一多就把后面的知识库页签槽整块顶出可视区**直接消失**（截图现象），而知识库槽虽然
 * 自己 `overflow-x-auto`，却因为 `.kb-edge-strip` 把滚动条藏了**看不出能滚**。
 *
 * 三条一起给：① 溢出区自己滚（宽度让得出去，不再把别人顶出行）；② 边沿渐隐提示「还能滚」；
 * ③ 激活条目自动滚进视野 + 滚轮横滚（鼠标用户唯一的够到手段）。判据全是算术，
 * 锁在 `stripScrollPure.ts` 的行为契约里，本文件只做取值 / 写回 / 监听。
 *
 * 用法（容器必须是 flex 项，且外面有一层 `relative` 供渐隐定位）：
 *   const { setNode, edges } = useStripScroll(active)
 *   <div className="relative flex min-w-0 items-end">
 *     <div ref={setNode} className="kb-edge-strip flex min-w-0 items-end gap-1 overflow-x-auto">…</div>
 *     <StripEdges edges={edges} />
 *   </div>
 */

/** 激活条目：页面条两个渲染器（模块条目 / PageTabStrip）给的是同一个属性契约 */
const ACTIVE_SEL = '[data-wb-active="1"]'

export interface StripScrollApi {
  /** 挂到**滚动容器**上（不是外层 relative 包裹层） */
  setNode: (node: HTMLDivElement | null) => void
  edges: { left: boolean; right: boolean }
  /** 手动把激活条目滚进视野（一般不用调：激活/条目数变化会自动跑一次） */
  reveal: () => void
}

function metricsOf(el: HTMLElement) {
  return { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }
}

export function useStripScroll(revealKey?: unknown, pad = 10): StripScrollApi {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [edges, setEdges] = useState<{ left: boolean; right: boolean }>({ left: false, right: false })
  // pad 走 ref：调用方一般写字面量，但没必要让它进 effect 依赖数组
  const padRef = useRef(pad)
  padRef.current = pad

  const sync = useCallback(() => {
    if (!node) return
    const next = stripEdges(metricsOf(node))
    setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next))
  }, [node])

  const reveal = useCallback(() => {
    if (!node) return
    const item = node.querySelector<HTMLElement>(ACTIVE_SEL)
    if (!item) return
    // 条目边界换算到**滚动内容坐标系**：视口 left − 容器 left + 当前 scrollLeft
    const cr = node.getBoundingClientRect()
    const ir = item.getBoundingClientRect()
    const start = ir.left - cr.left + node.scrollLeft
    const target = stripReveal(metricsOf(node), { start, end: start + ir.width }, padRef.current)
    if (target === null) return
    const reduce = typeof window !== 'undefined' && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollTo({ left: target, behavior: reduce ? 'auto' : 'smooth' })
  }, [node])

  // 溢出状态：滚动 / 容器尺寸 / 内容增删都要重算 —— 知识库页签是**从别的模块 portal 进来**的，
  // 它的增删不会让本组件重渲染，只有 MutationObserver 察觉得到。
  useEffect(() => {
    if (!node) return
    sync()
    node.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    const ro = new ResizeObserver(sync)
    ro.observe(node)
    const mo = new MutationObserver(sync)
    mo.observe(node, { childList: true, subtree: true })
    return () => {
      node.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
      ro.disconnect()
      mo.disconnect()
    }
  }, [node, sync])

  // 滚轮 → 横向：必须非 passive 才能 preventDefault（React 的 onWheel 是 passive 代理，吞不掉）
  useEffect(() => {
    if (!node) return
    const onWheel = (e: WheelEvent) => {
      const delta = stripWheelDelta(e, metricsOf(node))
      if (!delta) return
      e.preventDefault()
      node.scrollLeft += delta
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [node])

  // 激活条目滚进视野：激活变化 / 条目数变化后一帧再量（同帧 DOM 属性刚改、portal 内容可能还没落位）。
  // 已在视野内时 stripReveal 返回 null = 不动，所以这里多跑几次不会抖。
  useEffect(() => {
    if (!node) return
    const raf = requestAnimationFrame(() => { reveal(); sync() })
    return () => cancelAnimationFrame(raf)
  }, [node, reveal, sync, revealKey])

  return { setNode, edges, reveal }
}

/**
 * 溢出渐隐：**真有藏起来的条目那一侧**才亮起 —— 由页面条底色到透明的渐变。
 *
 * 为什么不用滚动条当提示：横向滚动条会占掉盒高（4px），把激活条目从行底顶起来 ——
 * 那正是 `.kb-edge-strip` 当初把滚动条藏掉的原因（index.css:1527-1530）。渐隐不动布局。
 *
 * 两片**常驻 DOM、只切 `data-on`**（而不是按需挂载）：一来出现/消失能走 opacity 过渡
 * （iron rule 13：状态变更提示要有动效），二来探针能按 `data-pb-fade` 稳定取到节点。
 */
export function StripEdges({ edges }: { edges: { left: boolean; right: boolean } }) {
  return (
    <>
      <div className="kb-strip-fade kb-strip-fade-l" data-pb-fade="left" data-on={edges.left ? '1' : '0'} aria-hidden />
      <div className="kb-strip-fade kb-strip-fade-r" data-pb-fade="right" data-on={edges.right ? '1' : '0'} aria-hidden />
    </>
  )
}
