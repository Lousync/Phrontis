import type { Dispatch, SetStateAction } from 'react'
import type { AgentSessionInfo, AiChangePlan, ResumeInfo } from '../../types'
import { useAssistantChat } from '../../components/shared/AssistantPanel/useAssistantChat'
import type { UiMessage } from '../../components/shared/AssistantPanel/MessageList'

/**
 * 工作区「AI助手」模块的兼容壳（v3.11.0）。
 *
 * 统一后真正的状态机只有一份：`useAssistantChat`（右侧栏 / 工作区 / AI Chat 页共用）。
 * 本文件只把它的字段映射成模块原有 API，避免模块视图一次性大改。
 */
export type Effort = 'off' | 'low' | 'medium' | 'high'

export interface AiAssistantApi {
  sessions: AgentSessionInfo[]
  activeId: string | null
  active: AgentSessionInfo | null
  messages: UiMessage[]
  pending: boolean
  draft: ReturnType<typeof useAssistantChat>['draft']
  liveSteps: ReturnType<typeof useAssistantChat>['liveSteps']
  runMark: 'running' | 'failed' | 'unread' | null
  plan: AiChangePlan | null
  pendingCount: number
  appliedCount: number
  usage: { in: number; out: number }
  modelId: string
  effort: Effort
  setModelId: (v: string) => void
  setEffort: (v: Effort) => void
  editing: { id: string; draft: string } | null
  setEditing: Dispatch<SetStateAction<{ id: string; draft: string } | null>>
  copiedIdx: number | null
  setCopiedIdx: Dispatch<SetStateAction<number | null>>
  resumeInfo: ResumeInfo | null
  scope: string[]
  scopeAll: boolean
  setScope: (next: string[]) => void
  setScopeAll: (all: boolean) => void
  writeMode: 'direct' | 'confirm'
  setWriteMode: (mode: 'direct' | 'confirm') => void
  setActiveId: (id: string | null) => void
  newSession: () => Promise<AgentSessionInfo | null>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  send: (message: string) => Promise<void>
  stop: () => Promise<void>
  reloadSessions: () => Promise<void>
  refreshPlan: () => Promise<void>
  applyAccepted: (ids: string[]) => Promise<void>
  rejectPlan: () => Promise<void>
  rollbackTask: () => Promise<void>
  onEditSubmit: (id: string, content: string) => Promise<void>
  onRegenerate: () => Promise<void>
  onDeleteMessage: (id: string) => Promise<void>
  onResume: () => Promise<void>
}

export function useAiAssistant(isActive: boolean): AiAssistantApi {
  const chat = useAssistantChat({ active: isActive, unified: true })

  return {
    sessions: chat.sessions,
    activeId: chat.activeId,
    active: chat.active,
    messages: chat.messages,
    pending: chat.pending,
    draft: chat.draft,
    liveSteps: chat.liveSteps,
    runMark: chat.runMark,
    plan: chat.plan,
    pendingCount: chat.pendingCount,
    appliedCount: chat.appliedCount,
    usage: chat.usage,
    modelId: chat.modelId,
    effort: chat.effort,
    setModelId: chat.setModelId,
    setEffort: chat.setEffort,
    editing: chat.editing,
    setEditing: chat.setEditing,
    copiedIdx: chat.copiedIdx,
    setCopiedIdx: chat.setCopiedIdx,
    resumeInfo: chat.resumeInfo,
    scope: chat.scope,
    scopeAll: chat.scopeAll,
    setScope: chat.setScope,
    setScopeAll: chat.setScopeAll,
    writeMode: chat.writeMode,
    setWriteMode: chat.setWriteMode,
    setActiveId: chat.setActiveId,
    newSession: () => chat.newSession('新会话'),
    deleteSession: chat.deleteSessionNow,
    renameSession: chat.renameSession,
    send: async (message: string) => { await chat.send(message) },
    stop: chat.abort,
    reloadSessions: async () => { await chat.refreshSessions() },
    refreshPlan: chat.refreshPlan,
    applyAccepted: chat.applyPlan,
    rejectPlan: chat.rejectPlan,
    rollbackTask: chat.rollbackTask,
    onEditSubmit: chat.editSubmit,
    onRegenerate: chat.regenerate,
    onDeleteMessage: chat.deleteMessage,
    onResume: chat.resume,
  }
}
