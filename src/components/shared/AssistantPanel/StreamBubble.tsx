import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { MarkdownPreview } from '../MarkdownPreview'
import { useSettings } from '../../../lib/SettingsContext'
import type { ProcessItem, StreamDraft } from './useAgentStream'

/**
 * 流式过程（生成态）—— docs/ai-reply-loading-plan.md §3「C 极简光标」。
 *
 * AI 教学中栏 / 支线面板 / 全局面板**三面共用**这一个组件，所以改一处三面生效。
 * 从对 Claude Code / ChatGPT / Claude.ai / Cursor / Cline / Copilot 的观感里提炼出的
 * 共性（§2 的 R1–R8）落在这里就是三句话：
 *   ① **状态是一条线，不是一个盒子**（R1）：不画外框、思考内容也不再套内框；
 *   ② **滑动指示优先于转圈**（R3）：状态行下面一条 2px 轨道 + accent 短条来回滑（纯 transform），
 *      状态行里也不放转圈 —— 滑动本身就是指示器；
 *   ③ **同一时刻只有一个状态标签**（R2），且 **生成中完全不显示工具行**（R8）：工具展示对
 *      体验价值不大（有意为之），完成后才由 `ToolSummary` 收成一行。
 *
 * 耗时是安静的（R5）：**>3 秒才出现**、弱色、每秒一次 —— 不是旧版那种 100ms 跳的秒表。
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

/**
 * 思考行（R6）：一行「已思考 N 秒」+ 左细线展开体，**不做二级盒子**。
 * 只在收到 reasoning 内容时渲染；正文一开始输出就自动收起一次。
 *
 * ★ 这一行的文案**始终是「已思考 N 秒」**（进行中就是活的计数器）—— 不写「思考中…」。
 *   因为状态行此刻正好也在说「正在思考…」，两处都写就是把「同一时刻只有一个状态标签」
 *   （R2 / 现状毛病 2）原样搬回来。
 */
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
    const id = window.setInterval(() => setSecs((Date.now() - t0) / 1000), 1000)
    return () => window.clearInterval(id)
  }, [active])

  // 尾部对齐：`.kb-think__body` 是 overflow:hidden + max-height 截断，程序化 scrollTop 仍有效
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div className="kb-think">
      <button type="button" className="kb-think__head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Sparkles size={10} />
        <span>已思考 {Math.max(1, Math.round(secs))} 秒</span>
        <ChevronDown size={10} className={`kb-chevron ${open ? '' : '-rotate-90'}`} />
      </button>
      <div className={`kb-collapse${open ? ' open' : ''}`}>
        <div>
          <div ref={bodyRef} className="kb-think__body">{text}</div>
        </div>
      </div>
    </div>
  )
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
    : draft.thinking ? '思考中…'
    : '正在等待模型响应…'
  const thinkingActive = draft.thinking.length > 0 && !draft.text && draft.items.length === 0
  const bodyText = textTransform ? textTransform(draft.text) : draft.text

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

      {showThinking && draft.thinking && <ThinkingBlock text={draft.thinking} active={thinkingActive} />}

      {bodyText && (
        <div className="text-[12px] leading-relaxed break-words select-text cursor-text [&_.prose-content>:first-child]:mt-0 [&_.prose-content>:last-child]:mb-0 [&_pre]:overflow-x-auto [&_pre]:max-w-full">
          <MarkdownPreview content={bodyText} codeBlockChrome="card" streaming />
          <span className="inline-block w-[2px] h-[13px] align-[-2px] ml-0.5 bg-[var(--accent)] animate-pulse" />
        </div>
      )}
    </>
  )
}
