import { useEffect, useRef, useState } from 'react'
import { MarkdownPreview } from '../MarkdownPreview'
import { useSettings } from '../../../lib/SettingsContext'
import { LIVE_EVENT_CAP, ThinkEvent, ToolEvent } from './ProcessRail'
import type { ProcessItem, StreamDraft } from './useAgentStream'

/**
 * 流式过程（生成态）—— v3.10.0「事件流」。
 *
 * AI 教学中栏 / 支线面板 / 全局面板**三面共用**这一个组件，所以改一处三面生效。
 *
 * 与 3.5.0 的「生成中完全不显示工具行」相反，这里恢复过程可见，但**不回到旧表格**：
 *   ① 状态仍是一条线、一个标签（R1/R2）：状态行只负责「现在在做什么」；
 *   ② 事件流是左细线 + 小节点（`.kb-ev-rail`），无外框、无右对齐耗时列；
 *   ③ 思考按 LLM 轮次分段：当前轮展开，正文/工具开始时收起；上一轮保持收起可点开；
 *   ④ 工具运行中用图标 opacity 呼吸，不用转圈；耗时跟在目标后面内联。
 *
 * 耗时仍是安静的（R5）：**>3 秒才出现**、弱色、每秒一次 —— 不是旧版那种 100ms 跳的秒表。
 */

/** 耗时 >3 秒才在状态行右侧出现（短回复不闪、长回复有交代） */
const DUR_VISIBLE_AFTER_MS = 3000

function lastRunning(items: ProcessItem[]): Extract<ProcessItem, { kind: 'tool' }> | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'tool' && it.state === 'running') return it
  }
  return null
}

function hasActiveThink(items: ProcessItem[]): boolean {
  return items.some(it => it.kind === 'think' && it.state === 'active')
}

export function StreamBubble({
  draft, textTransform,
}: {
  draft: StreamDraft
  /** 正文展示前的变换（AI 教学用：剥掉流式期间未闭合的围栏，防半截 JSON 闪现） */
  textTransform?: (t: string) => string
}) {
  const { s } = useSettings()
  const showThinking = s.aiShowThinking !== false
  const [showAll, setShowAll] = useState(false)

  // 新一轮（startedAt 变化）重新按 10 步收起；同一轮内用户展开后保持展开
  useEffect(() => setShowAll(false), [draft.startedAt])

  const durRef = useRef<HTMLSpanElement>(null)
  const [showDur, setShowDur] = useState(false)

  /**
   * 计时：每秒一次，且**跨过 3 秒时只重绘一次**（为了插入那个元素）。
   * 这个组件在流式期间每 60ms 被 flush 重绘一次，所以耗时文本**绝不能在 render 里算** ——
   * 那等于把 100ms 跳的秒表换个地方做回来。插入之后一律直接改 DOM 文本。
   * （元素挂载那一帧由下面的 effect 补字，因为 interval 那一拍里 ref 还是 null。）
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      const sec = (Date.now() - draft.startedAt) / 1000
      if (sec * 1000 < DUR_VISIBLE_AFTER_MS) return
      setShowDur(true)
      if (durRef.current) durRef.current.textContent = `${sec.toFixed(1)}s`
    }, 1000)
    return () => window.clearInterval(id)
  }, [draft.startedAt])

  useEffect(() => {
    if (showDur && durRef.current) {
      durRef.current.textContent = `${((Date.now() - draft.startedAt) / 1000).toFixed(1)}s`
    }
  }, [showDur, draft.startedAt])

  // 状态文案沿用主进程给的 label（与旧版同源，不新增文案）；同一时刻只有这一个标签
  const running = lastRunning(draft.items)
  const phase = running ? `正在${running.label}…`
    : draft.text ? '正在回答…'
    : hasActiveThink(draft.items) ? '思考中…'
    : '正在等待模型响应…'
  const bodyText = textTransform ? textTransform(draft.text) : draft.text

  // 思考显示开关只影响渲染，不影响草稿内容（关掉再打开仍可看到已收到的段）
  const events = showThinking ? draft.items : draft.items.filter(it => it.kind !== 'think')
  const hidden = !showAll && events.length > LIVE_EVENT_CAP ? events.length - LIVE_EVENT_CAP : 0
  const visible = hidden > 0 ? events.slice(hidden) : events

  return (
    <>
      {/* 状态行：静态弱色文字 + 下滑条。无转圈、无停止按钮 —— 停止入口只在输入区（R7） */}
      <div className="kb-gen-row">
        <span className="kb-stage">
          <span className="stage-label">{phase}</span>
          <span className="kb-sweep" />
        </span>
        {showDur && <span ref={durRef} className="kb-stage-dur" />}
      </div>

      {visible.length > 0 && (
        <div className="kb-ev-rail">
          {hidden > 0 && (
            <button type="button" className="kb-ev-more" onClick={() => setShowAll(true)}>
              查看前面 {hidden} 步
            </button>
          )}
          {visible.map(it => {
            if (it.kind === 'think') {
              return (
                <ThinkEvent key={it.key} text={it.text} active={it.state === 'active'}
                  startedAt={it.startedAt} durationMs={it.durationMs} />
              )
            }
            if (it.kind === 'narr') {
              return <div key={it.key} className="kb-ev kb-ev-narr kb-item-in">{it.text}</div>
            }
            return (
              <ToolEvent key={it.key} name={it.name} label={it.label} target={it.target}
                state={it.state} durationMs={it.durationMs} />
            )
          })}
        </div>
      )}

      {bodyText && (
        <div className="text-[12px] leading-relaxed break-words select-text cursor-text [&_.prose-content>:first-child]:mt-0 [&_.prose-content>:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full">
          <MarkdownPreview content={bodyText} codeBlockChrome="card" streaming />
          <span className="inline-block w-[2px] h-[13px] align-[-2px] ml-0.5 bg-[var(--accent)] animate-pulse" />
        </div>
      )}
    </>
  )
}
