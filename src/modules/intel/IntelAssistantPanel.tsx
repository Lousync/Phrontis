import { useCallback, useEffect } from 'react'
import { Radar, Search, Sparkles } from 'lucide-react'
import { ChatBody } from '../../components/shared/AssistantPanel/ChatBody'
import { useAssistantChat } from '../../components/shared/AssistantPanel/useAssistantChat'

/**
 * 情报助手面板（v3.12.0 D5/D6，docs/intel-module-plan.md §7.1）——
 * 工作台右栏「📡 情报助手」条件页签的内容。
 *
 * 独立会话种类（source='intel'）：与通用助手 / 日程助手**物理隔离**（列表互不可见）。
 * 复用 ChatBody 会话基建；`unified: false`（情报助手不碰仓库文件 —— 无文件作用域 / 无写入模式 UI）。
 * 会话策略：普通会话列表，**不**用日程的一天一会话 autoResumeToday。
 * 后端：主进程按 source 注入情报人设 + 每轮池快照，工具面收窄到 INTEL_TOOL_NAMES（只读池 + 两个写回动作）。
 */
export function IntelAssistantPanel() {
  const chat = useAssistantChat({
    active: true,
    sessionSource: 'intel',
    unified: false,
  })

  // 打开面板即聚焦输入（顶栏 🤖 与点 Tab 进入都受益；同 ScheduleAssistantPanel 口径）
  useEffect(() => {
    const t = window.setTimeout(() => chat.inputRef.current?.focus(), 80)
    return () => window.clearTimeout(t)
  }, [chat.inputRef])

  const quickSend = useCallback((text: string) => { void chat.send(text) }, [chat])

  const quickChips: Array<{ label: string; text: string; Icon: typeof Sparkles }> = [
    { label: '推荐', text: '推荐几篇值得读的', Icon: Sparkles },
    { label: '找资料', text: '找 RAG 相关的资料', Icon: Search },
    { label: '只看论文', text: '只看论文', Icon: Radar },
    { label: '只看中文', text: '只看中文', Icon: Radar },
  ]

  return (
    <ChatBody
      chat={chat}
      variant="docked"
      active
      headerTitle="情报助手"
      emptyHint={
        <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
          <Radar size={22} strokeWidth={1.5} className="text-[var(--text-disabled)]" />
          <span className="text-[12.5px] text-[var(--text-secondary)]">情报助手</span>
          <span className="px-3 text-[11px] leading-[1.8] text-[var(--text-muted)]">
            只管情报池：推荐 / 查找 / 筛选。<br />结果会收进左栏「✨ AI 推荐」，随时回看。
          </span>
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
              <c.Icon size={11} />
              {c.label}
            </button>
          ))}
        </div>
      }
    />
  )
}
