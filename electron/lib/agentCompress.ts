/**
 * 会话压缩编排（docs/conversation-compaction-design.md §7）
 *
 * 切分/分片/装配等纯逻辑在 agentCompressCore.ts；本模块负责：
 * 读会话 → 切分 → 分片调 LLM 折叠纪要 → 原子写回（任一片失败不写）。
 * 纪要生成复用 invokeLlmStreamInternal（无 tools + 收集 text delta），自带审计与用量。
 */

import { ipcMain } from 'electron'
import { getAgentMessages, getAgentSession, nowLocal, updateSessionDigest } from './agentSessionRepo'
import { invokeLlmStreamInternal } from './llmService'
import { getSettingReader } from './aiTools'
import {
  buildDigestPrompt,
  MAX_SLICES,
  normalizeDigestOutput,
  partitionSlices,
  splitForCompression,
  type CompressionRow,
} from './agentCompressCore'

export interface AgentCompressRequest {
  sessionId: string
  /** 会话当前模型覆盖（'pid:mid' 串，与 agentChat 的 modelId 同格式） */
  modelId?: string
  providerId?: string
  effort?: 'off' | 'low' | 'medium' | 'high'
}

export interface AgentCompressResult {
  ok: boolean
  /** 可压段为空时不调 LLM 直接返回 */
  skipped?: 'nothing-to-compress'
  /** 本次新折叠的消息条数 */
  covered?: number
  /** 纪要正文字符数 */
  digestChars?: number
  /** 实际执行的分片数 */
  slices?: number
  error?: string
}

/**
 * 压缩一个会话：把「检查点之后 − 保留尾段」的消息折叠进纪要并推进检查点。
 * 幂等：无新可压消息时 skipped；失败不写回（自动路径回退裁剪，行为不劣于压缩前）。
 */
export async function compressSession(req: AgentCompressRequest): Promise<AgentCompressResult> {
  const sessionId = String(req?.sessionId ?? '')
  const session = sessionId ? getAgentSession(sessionId) : undefined
  if (!session) return { ok: false, error: '会话不存在' }

  const rows: CompressionRow[] = getAgentMessages(sessionId)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ id: m.id, role: m.role, content: m.content }))
  const split = splitForCompression(rows, session.digest?.upto_id ?? null)
  if (split.compressible.length === 0) return { ok: true, skipped: 'nothing-to-compress' }

  // 模型解析：设置 agentCompressModelId（'pid:mid'）> 请求透传 > invokeLlmStreamInternal 默认链
  let providerId = req.providerId
  let modelId = req.modelId
  const configured = String(getSettingReader()('agentCompressModelId') ?? '').trim()
  if (configured) {
    const ci = configured.indexOf(':')
    providerId = ci > 0 ? configured.slice(0, ci) : undefined
    modelId = ci > 0 ? configured.slice(ci + 1) : configured
  }

  let digestText = session.digest?.text ?? ''
  let covered = 0
  let uptoId = session.digest?.upto_id ?? ''
  let slicesDone = 0
  for (const slice of partitionSlices(split.compressible).slice(0, MAX_SLICES)) {
    const { system, user } = buildDigestPrompt(digestText || null, slice)
    let out = ''
    const r = await invokeLlmStreamInternal(
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        providerId,
        modelId,
        effort: req.effort,
        // 纪要生成属于该会话的延伸请求：沿用会话 ID，提示缓存前缀与主对话一致
        sessionId,
      },
      (e) => {
        if (e.type === 'text') out += e.delta
      },
    )
    if (!r.ok) return { ok: false, error: r.error ?? '纪要生成失败', covered, digestChars: digestText.length, slices: slicesDone }
    const text = normalizeDigestOutput(out)
    if (!text) return { ok: false, error: '纪要生成为空', covered, digestChars: digestText.length, slices: slicesDone }
    digestText = text
    uptoId = slice[slice.length - 1].id
    covered += slice.length
    slicesDone++
  }

  // 原子写回：全部片成功才落盘（MAX_SLICES 截断时检查点停在已覆盖处，下次续压）
  updateSessionDigest(sessionId, { text: digestText, upto_id: uptoId, covered: (session.digest?.covered ?? 0) + covered, updated_at: nowLocal() })
  return { ok: true, covered, digestChars: digestText.length, slices: slicesDone }
}

export function registerAgentCompressHandlers(): void {
  ipcMain.handle('agent:compressSession', (_e, req: AgentCompressRequest | undefined) => compressSession(req ?? { sessionId: '' }))
}
