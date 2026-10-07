/**
 * N-3 会话运行态标记（会话列表项右侧，docs/assistant-parallel-design.md §四）：
 * running = `.kb-spin` 转圈示忙 / failed = 红「!」/ unread = 蓝点（完成未读）。
 * 动效走既有令牌（.kb-spin / .kb-micro-pop，铁律 13）；单独成文件避免
 * ChatBody ↔ AiChatSidebar 循环导入（两处列表共用）。
 */
export function SessionRunMark({ mark }: { mark: 'running' | 'failed' | 'unread' | null }) {
  if (mark === 'running') return <span className="kb-spin" title="正在回复" />
  if (mark === 'failed') {
    return (
      <span
        className="kb-micro-pop flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold leading-none text-white"
        title="上次回复失败"
      >!</span>
    )
  }
  if (mark === 'unread') {
    return <span className="kb-micro-pop h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" title="有新回复" />
  }
  return null
}
