/**
 * 聊天斜杠指令（最小可扩展框架）—— docs/conversation-compaction-design.md §9
 *
 * 聊天面发送入口共用：输入以 '/' 开头时先走 handleChatCommand——命中即拦截执行
 * （toast 反馈、不进对话），未命中提示可用指令；其余输入不受影响。
 * 弹层候选单一真源 = CHAT_COMMANDS（本地执行）+ PASSTHROUGH_COMMANDS（放行给模型）；输入框 `/`
 * 弹层与未来插件命令（plugin P3 commands slot）都从这两张表取。
 *
 * 执行态（v3.1.1 条目10）：/compress 是真实 LLM 调用（可能数十秒），静默执行曾让界面
 * 看起来「卡死」。ctx.onProgress 由调用面接线到本地占位 UI；running 守卫挡住重入
 * （命令执行期间再发指令直接拒绝，防连点）。
 *
 * 两条扩展（日程助手 P1）：
 *  - `surfaces`：命令只在列出的聊天面出现 / 生效（弹层过滤 + 命中过滤双重口径）；
 *  - `prompt`：「提示型」命令——命中不当场跑业务，而是把 prompt 作为一条 **user 消息**
 *    交给宿主发出去（由模型据 system 注入自行处理），用于 `/简报`、`/排这周` 这类
 *    「向助手提一句」的指令。宿主经 `ctx.onSend` 接线。
 */
import { agentCompressSession } from './ipc'
import { showToast } from './toast'

export type ChatSurface = 'assistant' | 'aiTeaching' | 'aiLearn' | 'schedule'

export interface ChatCommandCtx {
  /** 当前会话 id（空串 = 尚未建会话，由命令自行报错） */
  sessionId: string
  surface: ChatSurface
  /** 当前会话模型覆盖（'pid:mid' 串，压缩调用透传；缺省走主进程默认链） */
  modelId?: string
  effort?: 'off' | 'low' | 'medium' | 'high'
  /** 执行态回调：run 前后各一次（active=true/false）；调用面据此显示/收起「执行中」占位 */
  onProgress?: (p: { active: boolean }) => void
  /**
   * 提示型命令的发送出口：命中带 `prompt` 的命令时调用——宿主把它当作用户输入发出
   * （即走正常 `send` 流程）。缺省（未接线）= 该命令在此面不可用。
   */
  onSend?: (text: string) => void
}

export interface ChatCommand {
  name: string
  desc: string
  /** 返回 toast 文案（null = 静默成功） */
  run: (ctx: ChatCommandCtx) => Promise<string | null>
  /** 限定生效的聊天面（缺省 = 全部聊天面）；用于日程助手与通用助手的分化 */
  surfaces?: ChatSurface[]
  /** 提示型命令：命中即把此文本作为一条 user 消息发出（不进 run 本地执行） */
  prompt?: string
}

export const CHAT_COMMANDS: ChatCommand[] = [
  {
    name: 'compress',
    desc: '压缩对话历史：把较早的轮次折叠为持久化纪要，缩短上下文、降低费用',
    surfaces: ['assistant', 'aiTeaching', 'aiLearn'],
    run: async (ctx) => {
      if (!ctx.sessionId) return '当前没有会话，先发送一条消息后再压缩'
      const r = await agentCompressSession({ sessionId: ctx.sessionId, modelId: ctx.modelId, effort: ctx.effort })
      if (!r.ok) return `压缩失败：${r.error ?? '未知错误'}`
      if (r.skipped === 'nothing-to-compress') return '没有需要压缩的内容'
      return `已压缩 ${r.covered ?? 0} 条历史 → 纪要 ${r.digestChars ?? 0} 字（${r.slices ?? 1} 次调用）`
    },
  },
  // ===== 日程助手专属（surface: 'schedule'）：提示型，交给模型 + 日程人设/摘要处理 =====
  {
    name: '简报',
    desc: '今日简报：按你的今日待办 / 逾期 / 待安排给一份今日安排',
    surfaces: ['schedule'],
    prompt: '帮我生成今天的日程简报。',
    run: async () => null,
  },
  {
    name: '排这周',
    desc: '把「待安排」排进本周日程表：先给排期预览，确认后落盘',
    surfaces: ['schedule'],
    prompt: '帮我把本周「待安排」里的任务排进日程表；先给我一份排期预览，我确认后再落盘。',
    run: async () => null,
  },
  {
    name: '拆解',
    desc: '把一个大任务拆成子步骤，并建议截止时间',
    surfaces: ['schedule'],
    prompt: '我要把一个任务拆解成子步骤。请先问我是哪件事，再拆开并建议截止时间。',
    run: async () => null,
  },
  {
    name: '今天',
    desc: '今天该做什么：按 DDL 紧迫度与四象限给建议顺序',
    surfaces: ['schedule'],
    prompt: '今天该做什么？请按 DDL 紧迫度和四象限给我一份建议顺序。',
    run: async () => null,
  },
]

/** 适用当前聊天面的指令清单（供弹层过滤 + 未知指令提示共用） */
export function commandsForSurface(surface?: ChatSurface): ChatCommand[] {
  if (!surface) return CHAT_COMMANDS
  return CHAT_COMMANDS.filter((c) => !c.surfaces || c.surfaces.includes(surface))
}

/**
 * 「放行给模型」的斜杠指令（v3.6.0 收口，docs/ai-image-gen-plan.md §5.1）。
 *
 * 与 CHAT_COMMANDS 的分界是**谁执行**：
 *  · CHAT_COMMANDS = 本地执行（拦下来跑业务、toast 反馈、不进对话）；
 *  · 本表 = 只声明"有这么个指令"，命中即放行 —— 斜杠原文照发，由模型据 system 注入的规则
 *    去调对应工具（`/mindmap` → mindmap 工具，`/生图` → image 工具）。
 *
 * 为什么要成表：`/mindmap` 此前是 handleChatCommand 里的一行硬编码判断，弹层候选又在
 * AI 教学模块里另写一份 MINDMAP_SLASH_ITEM —— 一个指令两处维护，加第二个就是三处。
 * 现在「放行判定」与「弹层候选」读同一张表。
 */
export interface PassthroughCommand {
  name: string
  desc: string
  /** 出现并生效的聊天面（必填：放行指令都有明确归属面，没有"全都有"这一档） */
  surfaces: ChatSurface[]
}

export const PASSTHROUGH_COMMANDS: PassthroughCommand[] = [
  { name: 'mindmap', desc: '把当前对话 / 指定笔记整理成思维导图', surfaces: ['aiTeaching'] },
  { name: '生图', desc: '按描述生成一张图（后面跟要画什么；再补一句可改图）', surfaces: ['assistant', 'aiTeaching'] },
]

/** 当前面的放行指令（弹层候选与 handleChatCommand 放行判定共用这一处） */
export function passthroughCommandsForSurface(surface?: ChatSurface): PassthroughCommand[] {
  if (!surface) return PASSTHROUGH_COMMANDS
  return PASSTHROUGH_COMMANDS.filter((c) => c.surfaces.includes(surface))
}

function chatCommandHint(surface?: ChatSurface): string {
  // 提示里**同时**列放行指令：它们在弹层里出现，用户敲错别的名字时看到完整清单才找得到
  return [
    ...commandsForSurface(surface).map((c) => `/${c.name} —— ${c.desc}`),
    ...passthroughCommandsForSurface(surface).map((c) => `/${c.name} —— ${c.desc}`),
  ].join('；')
}

let running = false

/**
 * 斜杠指令拦截：'/' 开头返回 true（调用方不再发送该输入）——命中执行命令并 toast；
 * 未命中 toast 可用指令清单。非 '/' 输入恒返回 false，不改变任何行为。
 * 执行期间 running 守卫：再发指令直接拒绝（占位 UI 还在，不产生并发 LLM 调用）。
 * `surfaces` 不匹配的命令视为「本面未知」；`prompt` 型命令改由 `ctx.onSend` 发出。
 */
export async function handleChatCommand(raw: string, ctx: ChatCommandCtx): Promise<boolean> {
  const text = raw.trim()
  if (!text.startsWith('/')) return false
  const name = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  // 「放行给模型」的指令：不拦截、不 toast，斜杠原文照发（由模型据 system 规则调工具）。
  // 查 PASSTHROUGH_COMMANDS 表 —— 收口前这里是针对 /mindmap 的一行按面硬编码判断。
  const pt = passthroughCommandsForSurface(ctx.surface).find((c) => c.name.toLowerCase() === name)
  if (pt) return false
  const cmd = CHAT_COMMANDS.find(
    (c) => c.name === name && (!c.surfaces || c.surfaces.includes(ctx.surface)),
  )
  if (!cmd) {
    showToast({ type: 'info', message: `未知指令 ${text.split(/\s+/)[0]}。可用指令：${chatCommandHint(ctx.surface)}` })
    return true
  }
  // 提示型命令：不进本地执行，转交宿主当作用户消息发出
  if (cmd.prompt) {
    if (!ctx.onSend) {
      showToast({ type: 'info', message: `/${cmd.name} 在当前聊天面不可用` })
      return true
    }
    ctx.onSend(cmd.prompt)
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
