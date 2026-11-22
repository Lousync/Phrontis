/**
 * 右侧活动栏 · 旁问页签（一个页签 = 一条旁问会话）
 *
 * 新模型（PLAN §8）：列表 / 历史已移到壳的 `+ → 旁问` 浮层（`AskHistoryMenu`），
 * 本 pane 只剩两种状态：
 *   · `laneId` 有值 → 已落库会话，直接挂既有 `SideLanePanel`（消息流、停止、浮出、逐条引用都不重写）；
 *   · `laneId` 为空 + `draft` → 草稿态（`AskDraftPane`）：首问前不落库，发出即建 lane 并交给上面那一态。
 *
 * 只读边界（C10）不变：本面**不提供**任何「写文件 / 出题 / 改大纲 / 升格为会话」入口；
 * 「引用到主线」只把文字塞进主线输入框，绝不自动发送。
 *
 * 传进来的 `sessionId` / `sessionTitle` 是**这条旁问所属的主对话**（壳按页签取值），
 * 不是「当前会话」——页签跨会话保活时写盘与标题都仍按来源走。
 */

import { useEffect } from 'react'
import { MessageCircle } from 'lucide-react'
import { agentMarkSideLaneRead } from '../../../lib/ipc'
import { SideLanePanel } from '../SideLanePanel'
import type { AskPaneProps } from './paneContracts'
import { AskDraftPane } from './AskDraftPane'

export function AskPane(props: AskPaneProps) {
  const {
    rootId, sessionId, sessionTitle, laneId, draft,
    onLaneReady, onQuote, onFloat, onRequestClose, onChanged,
  } = props

  // 打开已落库的旁问 = 已读（历史列表的未读点据此消失）
  useEffect(() => {
    if (!laneId) return
    void agentMarkSideLaneRead(laneId).then(() => onChanged?.()).catch(() => undefined)
    // 只在换 lane 时标一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId])

  // 没有仓库 / 没有来源对话：旁问依附于会话，出空态卡（不抛错、不空白）
  if (!rootId || !sessionId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4">
        <div className="max-w-[260px] rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-3 text-center">
          <div className="text-[12px] font-medium text-[var(--text-primary)]">先进入一个 AI 教学对话</div>
          <div className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
            旁问依附于当前对话；进来后可以问整段，也可以在任意回答下点「追问」。
          </div>
        </div>
      </div>
    )
  }

  if (laneId) {
    return (
      <div className="kb-view-fade flex h-full min-h-0 min-w-0 flex-col">
        <SideLanePanel
          key={laneId}
          parentSessionId={sessionId}
          parentTitle={sessionTitle}
          anchorMessageId=""
          openLaneId={laneId}
          hideTurns
          quotePerMessage
          onClose={() => onRequestClose?.()}
          onQuote={onQuote}
          onFloat={onFloat ? () => onFloat(laneId) : undefined}
        />
      </div>
    )
  }

  if (draft) {
    return (
      <div className="kb-view-fade flex h-full min-h-0 min-w-0 flex-col">
        <AskDraftPane
          rootId={rootId}
          parentSessionId={sessionId}
          parentTitle={sessionTitle}
          draft={draft}
          onLaneReady={(id, title) => onLaneReady?.(id, title)}
        />
      </div>
    )
  }

  // 既没有 lane 也没有草稿（理论上壳不会这么传）：安静地给一张空态卡
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4">
      <div className="flex max-w-[280px] flex-col items-center gap-2 rounded-[10px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-[18px] text-center">
        <MessageCircle size={24} strokeWidth={1.5} className="text-[var(--text-muted)]" />
        <div className="text-[12.5px] font-medium text-[var(--text-primary)]">这条旁问没有内容</div>
        <div className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          从 <span className="text-[var(--text-secondary)]">+ → 旁问</span> 打开历史，或在回答下点「追问」。
        </div>
      </div>
    </div>
  )
}
