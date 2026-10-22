import { useCallback, useEffect } from 'react'
import { CalendarDays, ListChecks, Sparkles } from 'lucide-react'
import { ChatBody } from '../../components/shared/AssistantPanel/ChatBody'
import { useAssistantChat } from '../../components/shared/AssistantPanel/useAssistantChat'
import { SCHEDULE_AI_PREFILL_EVENT, SCHEDULE_PREVIEW_ADJUST_EVENT, SCHEDULE_PREVIEW_CONFIRM_EVENT } from './shared'

/**
 * 日程助手面板（日程 AI 化 P1）——工作台右栏「🗓 日程助手」条件页签的内容。
 *
 * 独立会话种类（source='schedule'）：会话列表 / 新建 / 发送都带该来源，
 * 与通用助手**物理隔离**（列表互不可见）。复用 ChatBody 的会话基建，但经 `surface='schedule'`
 * 裁剪掉通用助手专属控件（@ 引用 / 附件 / 感知 / 模型选择 / 上下文占用 / Token 消耗 / Skill）；
 * `/` 弹层只出日程指令（`/简报` `/排这周` `/拆解` `/今天`）。
 *
 * 后端：主进程按 source 注入日程人设 + 每轮日程数据快照（今日/逾期/近 DDL/待安排），
 * 工具面收窄到 `builtin.schedule.*`。
 */
export function ScheduleAssistantPanel() {
  const chat = useAssistantChat({
    active: true,
    surfaceOf: () => 'schedule',
    sessionSource: 'schedule',
    // 一天一个会话：今天开的对话，下次打开日程助手仍在其中
    autoResumeToday: true,
  })

  // 打开面板即聚焦输入（中央「＋ 一句话加任务」与点 Tab 进入都受益）
  useEffect(() => {
    const t = window.setTimeout(() => chat.inputRef.current?.focus(), 80)
    return () => window.clearTimeout(t)
  }, [chat.inputRef])

  // 排期预览卡的「确认排入 / 调整」：卡片只派发事件，由面板代发消息（卡片与面板解耦）
  useEffect(() => {
    const onConfirm = () => { void chat.send('确认，请按上面的排期逐条落盘。') }
    const onAdjust = () => {
      chat.setInput('把上面的排期改成：')
      setTimeout(() => chat.inputRef.current?.focus(), 30)
    }
    window.addEventListener(SCHEDULE_PREVIEW_CONFIRM_EVENT, onConfirm)
    window.addEventListener(SCHEDULE_PREVIEW_ADJUST_EVENT, onAdjust)
    return () => {
      window.removeEventListener(SCHEDULE_PREVIEW_CONFIRM_EVENT, onConfirm)
      window.removeEventListener(SCHEDULE_PREVIEW_ADJUST_EVENT, onAdjust)
    }
  }, [chat])

  useEffect(() => {
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      chat.setInput(text)
      setTimeout(() => chat.inputRef.current?.focus(), 30)
    }
    window.addEventListener(SCHEDULE_AI_PREFILL_EVENT, onPrefill)
    return () => window.removeEventListener(SCHEDULE_AI_PREFILL_EVENT, onPrefill)
  }, [chat])

  const quickSend = useCallback((text: string) => { void chat.send(text) }, [chat])

  const quickChips: { label: string; text: string }[] = [
    { label: '/简报', text: '/简报' },
    { label: '/排这周', text: '/排这周' },
    { label: '/今天', text: '/今天' },
  ]

  return (
    <ChatBody
      chat={chat}
      variant="docked"
      active
      surface="schedule"
      headerTitle="日程助手"
      emptyHint={
        <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
          <CalendarDays size={22} strokeWidth={1.5} className="text-[var(--text-disabled)]" />
          <span className="text-[12.5px] text-[var(--text-secondary)]">日程助手</span>
        </div>
      }
      inputTop={
        <div className="mb-1 flex flex-wrap gap-1.5">
          {quickChips.map((c) => (
            <button
              key={c.text}
              onClick={() => quickSend(c.text)}
              className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              {c.text === '/排这周' ? <ListChecks size={11} /> : <Sparkles size={11} />}
              {c.label}
            </button>
          ))}
        </div>
      }
    />
  )
}
