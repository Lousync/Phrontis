import type { AgentSessionInfo } from '../../../types'

export interface SessionSections {
  pinned: AgentSessionInfo[]
  rest: AgentSessionInfo[]
}

export function splitPinnedSessions(sessions: AgentSessionInfo[]): SessionSections {
  const pinned: AgentSessionInfo[] = []
  const rest: AgentSessionInfo[] = []
  for (const session of sessions) {
    if (session.pinnedAt) pinned.push(session)
    else rest.push(session)
  }
  pinned.sort((a, b) => (b.pinnedAt || '').localeCompare(a.pinnedAt || ''))
  return { pinned, rest }
}
