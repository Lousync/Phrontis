/**
 * 统一 AI 助手「先预览」可暂存工具白名单（v3.11.0）。
 *
 * 为什么需要白名单而不是黑名单：确认模式承诺「所有数据写入先预览」。
 * 只要某个写工具无法安全重放 / 无法给出可信摘要，就必须在模型视野里直接消失，
 * 不能靠提示词让模型自觉。新增写工具时先在这里登记，否则确认模式看不到它。
 *
 * 纯模块：给 aiTools / agentService / 契约脚本共用，不 import electron。
 */

/** 由各工具 handler 内部调用 commitOrStage 暂存的 vault 文件工具（通用层必须跳过，避免双重暂存） */
export const HANDLER_STAGED_TOOLS = new Set([
  'builtin.vault.write',
  'builtin.vault.edit',
  'builtin.vault.rename',
  'builtin.vault.trash',
])

/**
 * 通用暂存层可安全重放的数据写工具。
 * 只收「参数即完整意图、重复执行幂等或可重放」的工具；终端 / 外部副作用 / 生图落盘不收。
 */
export const STAGEABLE_WRITE_TOOLS = new Set([
  'builtin.knowledge.create-page',
  'builtin.blog.create-entry',
  'builtin.quiz.set-note',
  'builtin.quiz.tag',
  'builtin.quiz.collect',
  'builtin.quiz.favorite',
  'builtin.quiz.remove',
  'builtin.quiz.gen-paper',
  'builtin.checkin.check-habit',
  'builtin.accounting.import-json',
  'builtin.booksource.draft',
])

export function isHandlerStagedTool(name: string): boolean {
  return HANDLER_STAGED_TOOLS.has(name)
}

export function isStageableWriteTool(name: string): boolean {
  return HANDLER_STAGED_TOOLS.has(name) || STAGEABLE_WRITE_TOOLS.has(name)
}

/** 确认模式下应当从工具面隐藏的写工具（当前包含终端、插件外部副作用等） */
export function isConfirmModeHiddenTool(name: string, requires?: 'read' | 'write'): boolean {
  if (requires !== 'write') return false
  return !isStageableWriteTool(name)
}
