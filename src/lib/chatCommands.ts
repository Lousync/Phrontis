/**
 * 聊天斜杠指令（最小可扩展框架）—— docs/conversation-compaction-design.md §9
 *
 * 聊天面发送入口共用：输入以 '/' 开头时先走 handleChatCommand——命中即拦截执行
 * （toast 反馈、不进对话），未命中提示可用指令；其余输入不受影响。
 * 弹层候选单一真源 = CHAT_COMMANDS（name + desc）；输入框 `/` 弹层与未来插件
 * 命令（plugin P3 commands slot）都从这张表取。
 *
 * 执行态（v3.1.1 条目10）：/compress 是真实 LLM 调用（可能数十秒），静默执行曾让界面
 * 看起来「卡死」。ctx.onProgress 由调用面接线到本地占位 UI；running 守卫挡住重入
 * （命令执行期间再发指令直接拒绝，防连点）。
 */
import { agentCompressSession } from './ipc'
import { showToast } from './toast'

export type ChatSurface = 'assistant' | 'aiTeaching' | 'aiLearn'

export interface ChatCommandCtx {
  /** 当前会话 id（空串 = 尚未建会话，由命令自行报错） */
  sessionId: string
  surface: ChatSurface
  /** 当前会话模型覆盖（'pid:mid' 串，压缩调用透传；缺省走主进程默认链） */
  modelId?: string
  effort?: 'off' | 'low' | 'medium' | 'high'
  /** 执行态回调：run 前后各一次（active=true/false）；调用面据此显示/收起「执行中」占位 */
  onProgress?: (p: { active: boolean }) => void
}

export interface ChatCommand {
  name: string
  desc: string
  /** 返回 toast 文案（null = 静默成功） */
  run: (ctx: ChatCommandCtx) => Promise<string | null>
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: 'compress',
    desc: '压缩对话历史：把较早的轮次折叠为持久化纪要，缩短上下文、降低费用',
    run: async (ctx) => {
      if (!ctx.sessionId) return '当前没有会话，先发送一条消息后再压缩'
      const r = await agentCompressSession({ sessionId: ctx.sessionId, modelId: ctx.modelId, effort: ctx.effort })
      if (!r.ok) return `压缩失败：${r.error ?? '未知错误'}`
      if (r.skipped === 'nothing-to-compress') return '没有需要压缩的内容'
      return `已压缩 ${r.covered ?? 0} 条历史 → 纪要 ${r.digestChars ?? 0} 字（${r.slices ?? 1} 次调用）`
    },
  },
]

function chatCommandHint(): string {
  return CHAT_COMMANDS.map((c) => `/${c.name} —— ${c.desc}`).join('；')
}

let running = false

/**
 * 斜杠指令拦截：'/' 开头返回 true（调用方不再发送该输入）——命中执行命令并 toast；
 * 未命中 toast 可用指令清单。非 '/' 输入恒返回 false，不改变任何行为。
 * 执行期间 running 守卫：再发指令直接拒绝（占位 UI 还在，不产生并发 LLM 调用）。
 */
export async function handleChatCommand(raw: string, ctx: ChatCommandCtx): Promise<boolean> {
  const text = raw.trim()
  if (!text.startsWith('/')) return false
  const name = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const cmd = CHAT_COMMANDS.find((c) => c.name === name)
  if (!cmd) {
    showToast({ type: 'info', message: `未知指令 ${text.split(/\s+/)[0]}。可用指令：${chatCommandHint()}` })
    return true
  }
  if (running) {
    showToast({ type: 'warning', message: `上一条指令 /${name} 还在执行中，请等它完成` })
    return true
  }
  running = true
  ctx.onProgress?.({ active: true })
  try {
    const message = await cmd.run(ctx)
    if (message) showToast({ type: 'info', message })
  } catch (err) {
    showToast({ type: 'error', message: `指令执行失败：${err instanceof Error ? err.message : String(err)}` })
  } finally {
    running = false
    ctx.onProgress?.({ active: false })
  }
  return true
}
