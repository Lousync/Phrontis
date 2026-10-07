import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2, Sparkles, Square } from 'lucide-react'
import { MarkdownPreview } from '../MarkdownPreview'
import { useSettings } from '../../../lib/SettingsContext'
import type { ProcessItem, StreamDraft } from './useAgentStream'

/**
 * 流式过程气泡（docs/ai-streaming-design.md §5.3.4）。
 *
 * 三段合体，正好对应等待期的三段：
 *   T1 首 token 等待 → 折叠思考区（有 reasoning 才出现，自适应）
 *   T2 工具执行     → 过程时间线（进行中 spinner → ✓ + 耗时）
 *   T3 正文生成     → 正文流式 + 光标
 * 头部常驻「已等待 N 秒」——即便三段都无内容，也绝不会让人以为卡死。
 */

function lastRunning(items: ProcessItem[]): Extract<ProcessItem, { kind: 'tool' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'tool' && it.state === 'running') return it
  }
  return null
}

/** 折叠思考区：只在收到 reasoning 内容时渲染；正文一开始输出就自动收起一次 */
function ThinkingBlock({ text, active }: { text: string; active: boolean }) {
  const [open, setOpen] = useState(true)
  const [secs, setSecs] = useState(0)
  const prevActive = useRef(active)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (prevActive.current && !active) setOpen(false)
    prevActive.current = active
  }, [active])

  useEffect(() => {
    if (!active) return
    const t0 = Date.now()
    const id = window.setInterval(() => setSecs((Date.now() - t0) / 1000), 500)
    return () => window.clearInterval(id)
  }, [active])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div className="rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]/50 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
      >
        {active
          ? <span className="w-2.5 h-2.5 shrink-0 rounded-full border-[1.5px] border-[var(--border-color)] border-t-[var(--accent)] animate-spin" />
          : <Sparkles size={10} className="shrink-0" />}
        <span>{active ? '思考中…' : `已思考 ${Math.max(1, Math.round(secs))} 秒`}</span>
        <ChevronDown size={10} className={`ml-auto shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="px-2 pb-1.5 max-h-[72px] overflow-hidden whitespace-pre-wrap text-[11px] leading-[1.7] text-[var(--text-disabled)]"
        >
          {text}
        </div>
      )}
    </div>
  )
}

/** 过程时间线：旁白 + 工具行。工具行在调用「前」就出现（进行中），完成后原地转 ✓ */
function ProcessTimeline({ items }: { items: ProcessItem[] }) {
  return (
    <div className="space-y-0.5">
      {items.map(it => it.kind === 'narr' ? (
        <div
          key={it.key}
          className="my-1 pl-2 border-l-2 border-[var(--border-color)] text-[11.5px] text-[var(--text-secondary)] whitespace-pre-wrap"
        >
          {it.text}
        </div>
      ) : (
        <div key={it.key} className="flex items-center gap-1.5 text-[11.5px]">
          {it.state === 'running' ? (
            <span className="w-3 h-3 shrink-0 rounded-full border-[1.5px] border-[var(--border-color)] border-t-[var(--accent)] animate-spin" />
          ) : (
            <span className={`w-3 h-3 shrink-0 rounded-full grid place-items-center text-white text-[7px] leading-none ${it.state === 'done' ? 'bg-emerald-600' : 'bg-red-500'}`}>
              {it.state === 'done' ? '✓' : '✕'}
            </span>
          )}
          <span className={it.state === 'running' ? 'shrink-0' : 'shrink-0 text-[var(--text-muted)]'}>{it.label}</span>
          {it.target && (
            <code className="truncate text-[11px] text-[var(--text-secondary)] max-w-[45%]">{it.target}</code>
          )}
          {it.durationMs != null && (
            <span className="ml-auto shrink-0 tabular-nums text-[10.5px] text-[var(--text-disabled)]">
              {(it.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export function StreamBubble({
  draft, onAbort, textTransform,
}: {
  draft: StreamDraft
  onAbort?: () => void
  /** 正文展示前的变换（AI 教学用：剥掉流式期间未闭合的围栏，防半截 JSON 闪现） */
  textTransform?: (t: string) => string
}) {
  // 计时每秒刷新（气泡只在流式期间挂载，interval 生命周期即本次请求生命周期）
  const [, force] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => force(x => x + 1), 1000)
    return () => window.clearInterval(id)
  }, [])
  const { s } = useSettings()
  const showThinking = s.aiShowThinking !== false

  const elapsed = (Date.now() - draft.startedAt) / 1000
  const running = lastRunning(draft.items)
  const phase = running ? `正在${running.label}…`
    : draft.text ? '正在回答…'
    : draft.thinking ? '思考中…'
    : '正在等待模型响应…'
  const thinkingActive = draft.thinking.length > 0 && !draft.text && draft.items.length === 0
  const bodyText = textTransform ? textTransform(draft.text) : draft.text

  return (
    <div className="mr-6 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] text-[11.5px] text-[var(--text-muted)]">
        <Loader2 size={12} className="animate-spin shrink-0" />
        <span className="min-w-0 truncate">{phase}</span>
        <span className="ml-auto shrink-0 tabular-nums text-[var(--text-disabled)]">{elapsed.toFixed(1)}s</span>
        {onAbort && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 shrink-0 px-2 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-red-400 hover:border-red-400/50 transition-colors"
            title="中断当前请求与工具循环"
          >
            <Square size={9} className="fill-current" /> <span className="kb-l2">停止</span>
          </button>
        )}
      </div>

      {(draft.thinking || draft.items.length > 0 || draft.text) && (
        <div className="px-3 py-2 space-y-1.5">
          {showThinking && draft.thinking && <ThinkingBlock text={draft.thinking} active={thinkingActive} />}
          {draft.items.length > 0 && <ProcessTimeline items={draft.items} />}
          {bodyText && (
            <div className="text-[12px] leading-relaxed break-words select-text cursor-text [&_.prose-content>:first-child]:mt-0 [&_.prose-content>:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full">
              <MarkdownPreview content={bodyText} />
              <span className="inline-block w-[2px] h-[13px] align-[-2px] ml-0.5 bg-[var(--accent)] animate-pulse" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
