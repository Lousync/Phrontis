import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, Clock, FileText, Globe, PenLine, Search, Sparkles, Trash2, Wrench,
} from 'lucide-react'

/**
 * 过程事件流的共用行组件（生成态 `StreamBubble` 与完成态 `ProcessSummary` 共用）。
 *
 * 视觉口径（原型 `proto/ai-process-redesign/index.html`）：
 * - 一条左细线 + 小节点，不是表格、不是卡片；
 * - 工具耗时**跟在目标后面内联**，不做右对齐列、不用 tabular-nums；
 * - 运行中只让图标轻微呼吸（opacity），不用转圈；
 * - 思考行复用既有 `.kb-think__head/__body`，展开体是左细线不是二级盒子。
 */

/** 生成中默认只展示最近 N 个事件，避免 30+ 步把聊天区顶满；其余折成「查看前面 N 步」 */
export const LIVE_EVENT_CAP = 10

/** 工具名 → 小图标（只做视觉归类，不参与语义判断） */
function ToolIcon({ name }: { name?: string }) {
  const n = String(name ?? '')
  const Icon = n.includes('search') ? Search
    : n.includes('web') ? Globe
    : n.includes('trash') || n.includes('delete') ? Trash2
    : n.includes('write') || n.includes('edit') || n.includes('create') || n.includes('rename') ? PenLine
    : n.includes('schedule') || n.includes('pomodoro') ? Clock
    : n.includes('image') || n.includes('visual') || n.includes('mindmap') ? Sparkles
    : n.includes('read') || n.includes('list') || n.includes('knowledge') || n.includes('vault') ? FileText
    : Wrench
  return <Icon size={10} strokeWidth={1.8} aria-hidden />
}

/** 工具耗时：<1s 用 ms，≥1s 用一位小数秒 */
export function fmtToolDur(ms?: number): string {
  if (ms == null || ms <= 0) return ''
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 思考秒数：不足 1 秒也显示 1s（与既有「已思考 N 秒」口径一致） */
export function fmtThinkSec(ms?: number): string {
  return `${Math.max(1, Math.round((ms ?? 0) / 1000))}s`
}

export function ToolEvent({
  name, label, target, state, durationMs,
}: {
  name?: string
  label: string
  target?: string
  state: 'running' | 'done' | 'fail'
  durationMs?: number
}) {
  const dur = fmtToolDur(durationMs)
  return (
    <div className={`kb-ev kb-ev-tool kb-item-in${state === 'running' ? ' is-running' : ''}${state === 'fail' ? ' is-fail' : ''}`}>
      <ToolIcon name={name} />
      <span className="kb-ev-tool__label">{label}</span>
      {target && <code className="kb-ev-tool__target" title={target}>{target}</code>}
      {dur && <span className="kb-ev-tool__dur">· {dur}</span>}
    </div>
  )
}

/**
 * 思考事件。`text` 有值 = 生成态（可展开正文）；无值 = 完成态（只有时长，reasoning 不落库）。
 *
 * 展开/收起：active 为真时默认展开；active→done 自动收起；用户手动点开/收起仍然有效。
 * 头部**不写「思考中…」**——状态行已经有一条唯一的状态标签（R2）。
 */
export function ThinkEvent({
  text, active, startedAt, durationMs,
}: {
  text?: string
  active?: boolean
  startedAt?: number
  durationMs?: number
}) {
  const [open, setOpen] = useState(!!active && !!text)
  const [secs, setSecs] = useState(() => {
    if (active && startedAt) return Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    return Math.max(1, Math.round((durationMs ?? 0) / 1000))
  })
  const prevActive = useRef(!!active)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (active && !prevActive.current) setOpen(true)
    if (!active && prevActive.current) setOpen(false)
    prevActive.current = !!active
  }, [active])

  useEffect(() => {
    if (!active || !startedAt) return
    const tick = (): void => setSecs(Math.max(1, Math.round((Date.now() - startedAt) / 1000)))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [active, startedAt])

  // 尾部对齐：`.kb-think__body` 是 overflow:hidden + max-height 截断，程序化 scrollTop 仍有效
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  if (!text) {
    return (
      <div className="kb-ev kb-ev-think kb-item-in">
        <span className="kb-ev-static">
          <Sparkles size={10} aria-hidden />
          思考 · {fmtThinkSec(durationMs)}
        </span>
      </div>
    )
  }

  return (
    <div className={`kb-ev kb-ev-think kb-item-in${active ? ' is-active' : ''}`}>
      <button type="button" className="kb-think__head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Sparkles size={10} aria-hidden />
        <span>思考 · {active ? `${secs}s` : fmtThinkSec(durationMs)}</span>
        <ChevronDown size={10} className={`kb-chevron ${open ? '' : '-rotate-90'}`} aria-hidden />
      </button>
      <div className={`kb-collapse${open ? ' open' : ''}`}>
        <div>
          <div ref={bodyRef} className="kb-think__body">{text}</div>
        </div>
      </div>
    </div>
  )
}
