/**
 * 全局 AI 助手上下文注册器 —— 各模块注册「当前正在查看什么」的提供器，
 * AssistantPanel 发送消息时自动附带，实现"边看边问"。
 * 同一时刻只保留最后注册者（模块卸载时注销即可回退）。
 */

export interface AssistantContext {
  type: string
  label: string
  data?: Record<string, unknown>
}

type Provider = () => AssistantContext | null

let provider: Provider | null = null

export function registerAssistantContext(p: Provider): () => void {
  provider = p
  return () => { if (provider === p) provider = null }
}

export function getAssistantContext(): AssistantContext | null {
  try { return provider?.() ?? null } catch { return null }
}

/**
 * 划词问答宿主 —— 模块可声明「划词『问 AI』时由我接管」，
 * 把选中片段收进本模块自己的对话流（如 AI 教学：追加到当前教学对话往后答），
 * 而不是弹出全局侧边栏另开一个对话。
 *
 * 未注册、或 accept() 返回 false 时，回退到侧边栏原有行为（不阻断用户）。
 * 同一时刻**栈顶**生效（后注册者优先）。
 */
export interface SelectionAskHost {
  /** 是否接管本次划词提问（如：本模块处于激活态且已有当前对话） */
  accept: () => boolean
  /** 接管处理：把选中片段交给宿主（通常作为引用填入输入区） */
  ask: (text: string) => void
}

/**
 * 宿主**栈**（B-26，2026-09-23 由单槽改）：栈顶接管，注销时**弹出自己、露出下一个**。
 *
 * 为什么不保持单槽（`askHost = h` + 注销时 `askHost === h ? null : 略`）：那会让
 * 「常驻宿主被临时宿主顶掉」的场景**永久失联** —— 阅读器开着（右栏宿主常驻）时去 AI 教学
 * 划词一次，教学宿主入栈；离开教学时它把自己置 null，而右栏宿主**不会**自动回到槽里
 * ⇒ 此后在阅读器里划词一律回退悬浮侧栏（表象：功能时灵时不灵，且与操作顺序有关）。
 * 栈化之后这对组合的顺序无关：教学激活即接管，离开即还给右栏。
 */
const askHosts: SelectionAskHost[] = []

export function registerSelectionAskHost(h: SelectionAskHost): () => void {
  const dup = askHosts.indexOf(h)
  if (dup !== -1) askHosts.splice(dup, 1)
  askHosts.push(h)
  return () => {
    const i = askHosts.indexOf(h)
    if (i !== -1) askHosts.splice(i, 1)
  }
}

export function getSelectionAskHost(): SelectionAskHost | null {
  return askHosts.length ? askHosts[askHosts.length - 1] : null
}

/** 组装「选中片段」上下文对象（宿主与侧边栏共用同一 shape，保证主进程注入口径一致） */
export function selectionContext(text: string): AssistantContext {
  return {
    type: 'selection',
    label: `选中片段「${text.slice(0, 24)}${text.length > 24 ? '…' : ''}」`,
    data: { text },
  }
}
