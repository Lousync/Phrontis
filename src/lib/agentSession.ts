import { agentNewSession, workspaceGetCurrent } from './ipc'
import { showToast } from './toast'
import type { AgentSessionInfo, AgentSessionSource } from '../types'

/**
 * 新建 AI 会话（会话随仓库走，2026-10-13）。
 *
 * 存在的理由：会话改为存在 `<仓库>/.knowbase/agent/` 后，**没有当前仓库就不能建会话**。
 * 而原来的 4 个调用点一律写成 `agentNewSession(...).catch(() => null)` ——
 * 主进程抛错被吞掉，用户看到的是「点了没反应」，无从判断是坏了还是缺前提。
 * 这里统一补一条 Toast。
 *
 * 判据用「先问一次当前仓库」而不是解析主进程的报错文案：IPC 的错误只剩一个字符串，
 * 拿中文文案做判据等于把提示语变成隐性协议 —— 改一次文案就静默失效（且不报错）。
 * 多一次 IPC 只发生在「新建会话」这条不敏感路径上，代价可忽略。
 */
export async function newAgentSession(
  title?: string,
  source?: AgentSessionSource,
): Promise<AgentSessionInfo | null> {
  const cur = await workspaceGetCurrent().catch(() => null)
  if (!cur) {
    showToast({
      type: 'warning',
      message: '请先打开仓库',
      detail: 'AI 对话随仓库保存，需要先选定一个仓库。',
    })
    return null
  }
  return agentNewSession(title, source).catch(() => null)
}
