/**
 * 统一 AI 助手会话字段迁移（v3.11.0）—— 零依赖纯函数。
 *
 * 从 agentSessionRepo 抽出，供契约脚本直接 import（node --experimental-strip-types）。
 * 只改字段，不读写磁盘；调用方决定是否落盘。
 */

// 'intel'（📡 情报助手，v3.12.0）同为专属助手来源，与 aiTeaching / schedule 同样「不动」
export type NormalizableSessionSource = 'assistant' | 'aiTeaching' | 'schedule' | 'aiAssistant' | 'intel'
export type NormalizableWriteMode = 'direct' | 'confirm'

export interface NormalizableSessionFields {
  source?: NormalizableSessionSource
  scope?: string[]
  scopeAll?: boolean
  writeMode?: NormalizableWriteMode
}

/**
 * @returns 是否产生了需要落盘的字段变化。
 *
 * 规则：
 * - 旧 `aiAssistant` → `assistant`，保留路径作用域，写模式 = confirm；
 * - 旧通用助手 → scopeAll=true / scope=[] / writeMode=direct；
 * - aiTeaching / schedule 不动。
 */
export function normalizeSessionFields<T extends NormalizableSessionFields>(row: T): boolean {
  let dirty = false
  const legacyAiAssistant = row.source === 'aiAssistant'
  if (legacyAiAssistant) {
    row.source = 'assistant'
    dirty = true
  }
  if (row.source === 'assistant' || row.source === undefined) {
    if (row.scopeAll === undefined) {
      // 旧 aiAssistant 的空 scope 必须保留「严格」语义，不能扩大成全仓
      row.scopeAll = legacyAiAssistant ? false : !(row.scope && row.scope.length > 0)
      dirty = true
    }
    if (row.scopeAll === true) {
      if (row.scope && row.scope.length > 0) {
        row.scope = []
        dirty = true
      }
    } else if (row.writeMode === undefined) {
      row.writeMode = legacyAiAssistant ? 'confirm' : (row.scope && row.scope.length > 0 ? 'confirm' : 'direct')
      dirty = true
    }
    if (row.writeMode === undefined) {
      row.writeMode = 'direct'
      dirty = true
    }
  }
  return dirty
}
