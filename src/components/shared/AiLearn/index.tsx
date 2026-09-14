import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import {
  Sparkles, X, Plus, Trash2, Send, Check, ChevronLeft, ChevronRight, Minimize2,
  FileText, Wrench, BookOpen, MessageSquare, HelpCircle, Settings2, Loader2, Quote,
} from 'lucide-react'
import { MarkdownPreview } from '../MarkdownPreview'
import { ResizablePanel } from '../ResizablePanel'
import { MessageList, type UiMessage } from '../AssistantPanel/MessageList'
import type { StreamDraft } from '../AssistantPanel/useAgentStream'
import { loadHelpDocs, type HelpDoc } from '../../../modules/help/docsLoader'
import { LESSONS, LESSON_TOTAL, getLesson, type Lesson } from './lessons'
import type { LearnProgressApi } from './useLearnProgress'
import type { AgentChange, AgentSessionInfo, AgentTraceStep, TabName } from '../../../types'

/**
 * AI 学堂 · 全屏外壳
 *
 * 方案：docs/ai-learn-center-design.md
 * P0：三页签布局 + 扩张/回缩动画（骨架数据）
 * P1：接真实进度（落盘）与真实会话（与侧栏同一份）；「动手做」跳转；步骤随提问注入 AI
 *
 * 动画规范（§4，改动前先读）：
 *   · 尺寸用 width/left 过渡，禁止 transform: scale
 *   · 内容用 opacity 交叉淡入，禁止 display 切换
 *   · 三栏阶梯淡入，--d 由 Col 控制，做出「铺开」层次
 */

export type AiLearnTab = 'learn' | 'chat' | 'help'

const EASE = 'cubic-bezier(.22,.68,.32,1)'

/** 会话桥接：AssistantPanel 把侧栏那套会话状态与方法原样交过来，全屏因此与侧栏同源 */
export interface ChatBridge {
  messages: UiMessage[]
  pending: boolean
  liveSteps: AgentTraceStep[]
  /** 流式过程草稿（侧栏与全屏同源：扩张/回缩不丢流式内容） */
  draft: StreamDraft | null
  lastChanges: AgentChange[] | null
  sessions: AgentSessionInfo[]
  activeId: string | null
  /** 划词引用（会话引用形式）：随消息以可见引用块发出 */
  selQuotes: string[]
  editing: { id: string; draft: string } | null
  setEditing: (v: { id: string; draft: string } | null) => void
  copiedIdx: number | null
  setCopiedIdx: Dispatch<SetStateAction<number | null>>
  /** 直接送出一段文本（不经过侧栏输入框） */
  send: (text: string) => void
  newSession: () => void
  loadSession: (id: string) => void
  deleteSession: (id: string) => void
  onAbort: () => void
  onRegenerate: () => void
  onEditSubmit: (id: string, content: string) => void
  onDeleteMessage: (id: string) => void
  onDismissChanges: () => void
  /** 未配置任何模型供应商 → 全屏也走引导态 */
  providerMissing: boolean
  onGoSettings: () => void
}

/** 阶梯淡入列：d = 延迟毫秒 */
function Col({ d, active, className, children }: {
  d: number; active: boolean; className?: string; children: ReactNode
}) {
  return (
    <div
      className={className}
      style={{
        opacity: active ? 1 : 0,
        transform: active ? 'none' : 'translateY(5px)',
        transition: `opacity 180ms ${EASE} ${d}ms, transform 180ms ${EASE} ${d}ms`,
      }}
    >
      {children}
    </div>
  )
}

function TabButton({ id, active, onClick, icon, label }: {
  id: AiLearnTab; active: boolean; onClick: (t: AiLearnTab) => void; icon: ReactNode; label: string
}) {
  return (
    <button
      onClick={() => onClick(id)}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ${
        active
          ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] font-medium text-[var(--accent)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon}{label}
    </button>
  )
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  )
}

/** 共用输入区：自带草稿 state，送出后清空 */
function Composer({ placeholder, onSend, disabled, compact }: {
  placeholder: string; onSend: (text: string) => void; disabled?: boolean; compact?: boolean
}) {
  const [draft, setDraft] = useState('')
  const push = () => {
    const v = draft.trim()
    if (!v || disabled) return
    onSend(v)
    setDraft('')
  }
  return (
    <div className={`flex shrink-0 items-end gap-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] ${compact ? 'px-3 py-2.5' : 'px-4 py-2.5'}`}>
      <textarea
        rows={2}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); push() } }}
        placeholder={placeholder}
        className={`flex-1 resize-none rounded-lg border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] ${
          compact ? 'px-2.5 py-2 text-[12px]' : 'px-3 py-2 text-[12.5px]'
        }`}
      />
      <button
        onClick={push}
        disabled={disabled || !draft.trim()}
        className={`flex shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-white transition-opacity hover:opacity-90 disabled:opacity-40 ${compact ? 'h-9 w-9' : 'h-9 w-9'}`}
      >
        {disabled ? <Loader2 size={13} className="animate-spin" /> : <Send size={compact ? 13 : 14} />}
      </button>
    </div>
  )
}

function NoProvider({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="text-center">
        <Sparkles size={26} className="mx-auto text-[var(--text-disabled)]" />
        <p className="mt-3 text-[13px] text-[var(--text-primary)]">还没有可用的模型供应商</p>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          配置好之后，学堂里的对话与侧栏是同一份记录。
        </p>
        <button onClick={onGoSettings}
          className="mt-4 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] text-white transition-opacity hover:opacity-90">
          去配置模型
        </button>
      </div>
    </div>
  )
}

/** 随行对话（学 steps 右栏 / 帮助页右栏共用）：真实会话 + 当前步骤感知 */
function FollowChat({ chat, lesson, docMode = false, docTitle }: {
  chat: ChatBridge; lesson: Lesson; docMode?: boolean; docTitle?: string
}) {
  if (chat.providerMissing) return <NoProvider onGoSettings={chat.onGoSettings} />
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-[11.5px] text-[var(--text-muted)]">
        <Sparkles size={12} className="text-[var(--accent)]" />
        {docMode ? '就这篇提问' : '随行助手'}
        <span className="ml-auto rounded-full bg-[color-mix(in_srgb,var(--accent)_11%,transparent)] px-2 py-0.5 text-[10px] text-[var(--accent)]">
          {docMode ? (docTitle ? `已附带《${docTitle}》` : '已附带手册') : `已跟随第 ${lesson.n} 步`}
        </span>
      </div>

      <MessageList
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3 space-y-2"
        messages={chat.messages}
        pending={chat.pending}
        liveSteps={chat.liveSteps}
        draft={chat.draft}
        editing={chat.editing}
        setEditing={chat.setEditing}
        copiedIdx={chat.copiedIdx}
        setCopiedIdx={chat.setCopiedIdx}
        onRegenerate={chat.onRegenerate}
        onEditSubmit={chat.onEditSubmit}
        onDeleteMessage={chat.onDeleteMessage}
        onAbort={chat.onAbort}
        emptyHint={(
          <div className="px-3 pt-8 text-center text-[12px] leading-relaxed text-[var(--text-muted)]">
            {docMode
              ? '左侧是帮助文档。读到不懂的地方，直接在下面问 —— 提问会带上当前这篇。'
              : <>这一步卡在哪都可以直接问。<br />提问会带上「第 {lesson.n} 步」与它的目标，AI 知道你在哪。</>}
          </div>
        )}
      />

      {!docMode && lesson.ask && lesson.ask.length > 0 && chat.messages.length === 0 && (
        <div className="flex shrink-0 flex-wrap gap-1.5 px-3 pb-1">
          {lesson.ask.map(a => (
            <button
              key={a}
              onClick={() => chat.send(a)}
              disabled={chat.pending}
              className="rounded-full border border-[var(--border-color)] px-2.5 py-1 text-[10.5px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40"
            >
              {a}
            </button>
          ))}
        </div>
      )}

      <Composer
        compact
        disabled={chat.pending}
        placeholder={docMode ? '就这篇文档提问…（Enter 发送）' : '就这一步提问…（Enter 发送）'}
        onSend={chat.send}
      />
    </div>
  )
}

export function AiLearnShell({ tab, onTabChange, onCollapse, onClose, active, progress, chat, onGoto, onHelpDocChange }: {
  tab: AiLearnTab
  onTabChange: (t: AiLearnTab) => void
  onCollapse: () => void
  onClose: () => void
  /** 是否已进入全屏态（驱动阶梯淡入；扩张首帧为 false） */
  active: boolean
  progress: LearnProgressApi
  chat: ChatBridge
  /** 「动手做」跳模块（由 AssistantPanel 派发事件、App 承接） */
  onGoto: (tab: TabName) => void
  /** 当前阅读的手册变化 → 交给 AssistantPanel 作为提问上下文（帮助页提问应带这一篇，而不是「第几步」） */
  onHelpDocChange?: (doc: { title: string; md: string } | null) => void
}) {
  const curStep = progress.last
  const done = progress.done
  const lesson = getLesson(curStep)

  /** 帮助页签：读真实手册（与「帮助」模块同源，都是 resources/help/*.md 这一份） */
  const [helpDocs, setHelpDocs] = useState<HelpDoc[]>([])
  const [helpId, setHelpId] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadHelpDocs()
      .then(list => {
        if (!alive) return
        setHelpDocs(list)
        setHelpId(cur => cur ?? list[0]?.id ?? null)   // 默认打开排在最前的一篇（weight 最小的《快速上手》）
      })
      .catch(() => { /* 手册读取失败 → 保持空态，不炸整个学堂 */ })
    return () => { alive = false }
  }, [])
  const activeHelp = helpDocs.find(d => d.id === helpId) ?? null

  // 只在「帮助」页签时把手册作为提问上下文；切走即清空（避免残留影响别的页签）
  useEffect(() => {
    onHelpDocChange?.(tab === 'help' && activeHelp ? { title: activeHelp.title, md: activeHelp.md } : null)
  }, [tab, activeHelp, onHelpDocChange])
  const helpGroups = useMemo(() => {
    const m = new Map<string, HelpDoc[]>()
    for (const d of helpDocs) {
      const arr = m.get(d.category)
      if (arr) arr.push(d)
      else m.set(d.category, [d])
    }
    return [...m.entries()]
  }, [helpDocs])

  const stepList = (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="px-3 pb-1.5 pt-3 text-[10.5px] tracking-wide text-[var(--text-disabled)]">
        上手路径 · 约 13 分钟
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {LESSONS.map(l => {
          const isDone = done.includes(l.n)
          const on = l.n === curStep
          return (
            <button
              key={l.n}
              onClick={() => progress.setLast(l.n)}
              className={`mb-0.5 flex w-full gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                on ? 'bg-[color-mix(in_srgb,var(--accent)_11%,transparent)]' : 'hover:bg-[var(--bg-hover)]'
              }`}
            >
              <span className={`mt-px flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border text-[9.5px] ${
                isDone
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : on
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-[var(--border-color)] text-[var(--text-disabled)]'
              }`}>
                {isDone ? <Check size={9} strokeWidth={3} /> : l.n}
              </span>
              <span className="min-w-0">
                <span className={`block text-[12px] ${on ? 'font-medium text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                  {l.title}
                </span>
                <span className="mt-px block text-[10.5px] text-[var(--text-disabled)]">{l.minutes}</span>
              </span>
            </button>
          )
        })}
      </div>
      <button
        onClick={progress.reset}
        title="清空已完成标记并回到第 1 步"
        className="flex shrink-0 items-center gap-1.5 border-t border-[var(--border-color)] px-3 py-2 text-[10.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <BookOpen size={12} /> 重看首次启动引导
      </button>
    </div>
  )

  const lessonPane = (
    <div className="flex h-full min-h-0 flex-col">
      {/* 正文独立滚动；操作栏固定贴底 —— 内容短时按钮不会浮在中间、下面留一片空白 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[700px] px-7 pb-8 pt-6">
          <div className="mb-2 text-[11px] text-[var(--text-disabled)]">
            上手路径 / 第 {lesson.n} 步 · 共 {LESSON_TOTAL} 步
          </div>
          <h1 className="mb-2 text-[19px] font-semibold text-[var(--text-primary)]">{lesson.title}</h1>
          <div className="mb-4 inline-flex items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--accent)_11%,transparent)] px-2 py-0.5 text-[11.5px] text-[var(--accent)]">
            <Check size={12} />{lesson.goal}
          </div>

          {lesson.body}
        </div>
      </div>

      {/* 底部操作栏（方案 A · 单排）：动作靠左、导航靠右，中间用 flex-1 撑开。
          「上一步 / 下一步」必须同款描边、等高等内距、相邻成对 —— 它们是同一对导航。
          窄窗口下 flex-wrap 会换行、导航掉到第二行，属已知取舍 */}
      <div className="shrink-0 border-t border-[var(--border-color)] bg-[var(--bg-primary)]">
        <div className="mx-auto flex max-w-[700px] flex-wrap items-center gap-1.5 px-7 py-3">
          {lesson.action && (
            <>
              <button
                onClick={() => {
                  // 有目标模块 → 收起学堂跳过去；无目标（如「就在这里问一句」）→ 切到对话页签问
                  if (lesson.action?.goto) onGoto(lesson.action.goto)
                  else onTabChange('chat')
                }}
                className="flex h-8 items-center rounded-lg bg-[var(--accent)] px-3.5 text-[12px] text-white transition-opacity hover:opacity-90"
              >
                {lesson.action.label}
              </button>
              <button
                onClick={() => onTabChange('chat')}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
              >
                <Sparkles size={12} />问 AI 这一步
              </button>
            </>
          )}

          <span className="flex-1" />

          {done.includes(curStep) ? (
            <span className="flex h-8 items-center gap-1.5 px-2.5 text-[12px] text-emerald-500">
              <Check size={13} />这一步已完成
            </span>
          ) : (
            <button
              onClick={() => progress.markDone(curStep)}
              className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] text-emerald-500 transition-colors hover:bg-emerald-500/10"
            >
              <Check size={13} />标记为已完成
            </button>
          )}

          <button
            disabled={curStep === 1}
            onClick={() => progress.setLast(Math.max(1, curStep - 1))}
            className="flex h-8 items-center gap-1 rounded-lg border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            <ChevronLeft size={13} />上一步
          </button>
          <button
            disabled={curStep === LESSON_TOTAL}
            onClick={() => progress.setLast(Math.min(LESSON_TOTAL, curStep + 1))}
            className="flex h-8 items-center gap-1 rounded-lg border border-[var(--border-color)] px-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-40"
          >
            下一步<ChevronRight size={13} />
          </button>
        </div>
      </div>
    </div>
  )

  const sessionList = (
    <div className="flex flex-1 flex-col overflow-hidden">
      <button
        onClick={chat.newSession}
        className="m-2 flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12px] text-white transition-opacity hover:opacity-90"
      >
        <Plus size={12} />新会话
      </button>
      <div className="px-3 pb-1.5 text-[10.5px] tracking-wide text-[var(--text-disabled)]">最近会话</div>
      <div className="flex-1 overflow-y-auto px-2">
        {chat.sessions.map(sess => (
          <div
            key={sess.id}
            onClick={() => chat.loadSession(sess.id)}
            className={`group mb-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${
              chat.activeId === sess.id ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-[var(--text-primary)]">{sess.title}</span>
            </span>
            <button
              onClick={e => { e.stopPropagation(); chat.deleteSession(sess.id) }}
              title="删除会话"
              className="shrink-0 text-[var(--text-disabled)] opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        {chat.sessions.length === 0 && (
          <p className="pt-3 text-center text-[11px] text-[var(--text-muted)]">暂无历史会话</p>
        )}
      </div>
    </div>
  )

  const chatCenter = chat.providerMissing ? <NoProvider onGoSettings={chat.onGoSettings} /> : (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] pb-6 pt-5">
          <MessageList
            className="px-6 space-y-2"
            messages={chat.messages}
            pending={chat.pending}
            liveSteps={chat.liveSteps}
            draft={chat.draft}
            editing={chat.editing}
            setEditing={chat.setEditing}
            copiedIdx={chat.copiedIdx}
            setCopiedIdx={chat.setCopiedIdx}
            onRegenerate={chat.onRegenerate}
            onEditSubmit={chat.onEditSubmit}
            onDeleteMessage={chat.onDeleteMessage}
            onAbort={chat.onAbort}
            emptyHint={(
              <div className="px-4 pt-16 text-center text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                这里是完整对话区，与侧栏共用同一份记录。<br />
                切换到「上手路径」可以边看教程边问。
              </div>
            )}
          />
        </div>
      </div>
      <Composer disabled={chat.pending} placeholder="问问任何事…（Enter 发送，Ctrl+Shift+J 收回侧栏）" onSend={chat.send} />
    </div>
  )

  const chatInfo = (
    <div className="flex-1 overflow-y-auto p-3.5">
      <div className="mb-4">
        <div className="mb-1.5 text-[10.5px] tracking-wide text-[var(--text-disabled)]">当前附带上下文</div>
        {chat.selQuotes.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[10.5px] text-[var(--text-secondary)]">
            <Quote size={10} className="text-[var(--accent)]" />
            <b className="font-medium text-[var(--text-primary)]">{chat.selQuotes.length} 条对话引用</b>
            <span className="text-[var(--text-disabled)]">·发送时并入消息</span>
          </span>
        ) : (
          <span className="text-[11.5px] text-[var(--text-disabled)]">未附带页面（提问时按当前所在界面自动判断）</span>
        )}
      </div>

      <div className="mb-4">
        <div className="mb-1.5 text-[10.5px] tracking-wide text-[var(--text-disabled)]">本对话</div>
        <div className="flex items-center gap-1.5 py-1 text-[11.5px] text-[var(--text-muted)]">
          消息数<b className="ml-auto font-medium text-[var(--text-primary)]">{chat.messages.length}</b>
        </div>
        <div className="flex items-center gap-1.5 py-1 text-[11.5px] text-[var(--text-muted)]">
          状态<b className="ml-auto font-medium text-[var(--text-primary)]">{chat.pending ? '正在回复…' : '空闲'}</b>
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center text-[10.5px] tracking-wide text-[var(--text-disabled)]">
          <span>本次已改动</span>
          {chat.lastChanges && chat.lastChanges.length > 0 && (
            <button onClick={chat.onDismissChanges} className="ml-auto hover:text-[var(--text-primary)]">
              <X size={11} />
            </button>
          )}
        </div>
        {chat.lastChanges && chat.lastChanges.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-1.5 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
              <Wrench size={11} className="text-[var(--accent)]" />{chat.lastChanges.length} 项
            </div>
            {chat.lastChanges.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-[var(--text-primary)]">
                <span className="shrink-0 text-[var(--accent)]">{c.action}</span>
                <span className="truncate">{c.target}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11.5px] text-[var(--text-disabled)]">本次对话还没有写操作</p>
        )}
      </div>

      <button
        onClick={chat.onGoSettings}
        className="mt-4 flex items-center gap-1 text-[10.5px] text-[var(--text-disabled)] transition-colors hover:text-[var(--accent)]"
      >
        <Settings2 size={10} />去设置调整模型与权限
      </button>
    </div>
  )

  const helpCatalog = (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {helpGroups.map(([cat, items], gi) => (
        <div key={cat}>
          <div className={`px-2 pb-1 text-[10.5px] tracking-wide text-[var(--text-disabled)] ${gi === 0 ? 'pt-2' : 'pt-3'}`}>{cat}</div>
          {items.map(d => {
            const on = d.id === helpId
            return (
              <button
                key={d.id}
                onClick={() => setHelpId(d.id)}
                className={`mb-0.5 block w-full truncate rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                  on
                    ? 'bg-[var(--bg-selected)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                {d.title}
              </button>
            )
          })}
        </div>
      ))}
      {helpDocs.length === 0 && (
        <p className="px-2 pt-3 text-[11px] text-[var(--text-muted)]">手册加载中…</p>
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：标题 + 页签 + 进度 + 缩回/关闭 */}
      <div className="flex h-[42px] shrink-0 items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
        <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
          <Sparkles size={13} className="text-[var(--accent)]" />AI 学堂
        </span>
        <div className="ml-1 flex gap-0.5">
          <TabButton id="learn" active={tab === 'learn'} onClick={onTabChange} icon={<BookOpen size={12} />} label="上手路径" />
          <TabButton id="chat" active={tab === 'chat'} onClick={onTabChange} icon={<MessageSquare size={12} />} label="对话" />
          <TabButton id="help" active={tab === 'help'} onClick={onTabChange} icon={<HelpCircle size={12} />} label="帮助" />
        </div>
        <span className="flex-1" />
        {tab === 'learn' && (
          <span className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
            已完成 {done.length} / {LESSON_TOTAL}
            <span className="h-1 w-16 overflow-hidden rounded bg-[var(--border-color)]">
              <i
                className="block h-full rounded bg-[var(--accent)]"
                style={{ width: `${(done.length / LESSON_TOTAL) * 100}%`, transition: `width 300ms ${EASE}` }}
              />
            </span>
          </span>
        )}
        <span className="mx-1 h-[18px] w-px bg-[var(--border-color)]" />
        <IconBtn title="缩回侧栏 (Ctrl+Shift+J)" onClick={onCollapse}><Minimize2 size={14} /></IconBtn>
        <IconBtn title="关闭" onClick={onClose}><X size={14} /></IconBtn>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左栏（v3.1.2 条目4）：可拖拽调宽、不可收起——接既有 ResizablePanel，
            宽度持久化于 sidebarWidth_aiLearnLeft；不传 onSnapClose → 无收起态。
            Col 仅保留入场 stagger 动画，宽度/边框/底色交给 ResizablePanel */}
        <ResizablePanel
          storageKey="sidebarWidth_aiLearnLeft"
          defaultWidth={236}
          minWidth={180}
          maxWidth={360}
          visible
          side="left"
          className="border-r border-[var(--border-color)] bg-[var(--bg-secondary)]"
        >
          <Col d={50} active={active} className="flex min-h-0 flex-1 flex-col">
            {tab === 'learn' ? stepList : tab === 'chat' ? sessionList : helpCatalog}
          </Col>
        </ResizablePanel>

        {/* 中栏 */}
        <Col d={95} active={active} className="min-w-0 flex-1 overflow-hidden bg-[var(--bg-primary)]">
          {tab === 'learn' ? lessonPane : tab === 'chat' ? chatCenter : <HelpDocView doc={activeHelp} />}
        </Col>

        {/* 右栏（v3.1.2 条目4）：同上，持久化于 sidebarWidth_aiLearnRight。
            底色由内层 Col 的 bg-primary 撑满（ResizablePanel 内置 bg-secondary，
            不在 className 里覆盖以免同类名竞争顺序不确定） */}
        <ResizablePanel
          storageKey="sidebarWidth_aiLearnRight"
          defaultWidth={366}
          minWidth={240}
          maxWidth={480}
          visible
          side="right"
          className="border-l border-[var(--border-color)]"
        >
          <Col d={140} active={active} className="flex min-h-0 flex-1 flex-col bg-[var(--bg-primary)]">
            {tab === 'learn' ? <FollowChat chat={chat} lesson={lesson} />
              : tab === 'chat' ? chatInfo
                : <FollowChat chat={chat} lesson={lesson} docMode docTitle={activeHelp?.title} />}
          </Col>
        </ResizablePanel>
      </div>
    </div>
  )
}
/** 帮助页签中栏：渲染当前选中的手册（正文已由 docsLoader 去掉 frontmatter） */
function HelpDocView({ doc }: { doc: HelpDoc | null }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[700px] px-7 py-6">
        {doc ? (
          <>
            <div className="mb-2 text-[11px] text-[var(--text-disabled)]">帮助 / {doc.category}</div>
            <MarkdownPreview content={doc.md} />
          </>
        ) : (
          <div className="pt-16 text-center text-[12px] text-[var(--text-muted)]">正在加载手册…</div>
        )}
      </div>
    </div>
  )
}

