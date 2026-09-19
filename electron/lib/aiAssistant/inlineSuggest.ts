/**
 * B4 · 编辑器内联建议（DP 方案 §5）—— 编排区 + IPC 区
 *
 * 纯函数（prompt 组装 / 光标窗口 / 输出清洗）在 inlineSuggestCore.ts（零 import）。
 * 本文件负责：解析模型 → 调 invokeLlmStreamInternal → 聚合流式 delta 成单条建议。
 *
 * 为什么取消用「消息式」而非 AbortSignal：
 *   AbortSignal 不可经 IPC 结构化克隆传递（渲染层 → 主进程），
 *   故渲染层发 requestId，主进程侧持 Map<requestId, AbortController> 自行 abort。
 *
 * 为什么不复用 agentService 的对话历史：
 *   inline suggest 是**独立的一次性调用**（与 agentCompress 同型），
 *   不进对话历史、不碰 system/tools 前缀 → 不扰动 prompt cache。
 */

import { ipcMain } from 'electron'
import { invokeLlmStreamInternal } from '../llmService'
import { getSettingReader } from '../aiTools'
import {
  buildInlinePrompt,
  INLINE_SUGGEST_MAX_CHARS,
  INLINE_SUGGEST_TIMEOUT_MS,
  isValidSuggestion,
  normalizeInlineSuggestion,
  pickFrontmatterTitle,
} from './inlineSuggestCore'

export interface InlineSuggestRequest {
  /** 渲染层生成的请求 id，用于 cancel 配对 */
  requestId: string
  /** 文档全文 */
  text: string
  /** 光标字符偏移 */
  offset: number
  /** 当前文档 relPath（仅日志用，不参与 prompt） */
  relPath?: string
  /** 模型覆盖（'pid:mid'），缺省走默认链 */
  modelId?: string
  providerId?: string
  effort?: 'off' | 'low' | 'medium' | 'high'
}

export interface InlineSuggestResult {
  ok: boolean
  /** 单条建议文本（ok 且非空才有意义） */
  text?: string
  /** 被新请求取消 */
  aborted?: boolean
  error?: string
}

/** 在途请求表：requestId → AbortController（消息式取消的核心） */
const inflight = new Map<string, AbortController>()

/**
 * 生成一条内联建议。
 * - 同 requestId 重复调用会先取消前次（渲染层一般用新 id，这里是兜底）
 * - 流式 delta 全量聚合，**流结束后**才返回单条（ghost text 不做增量呈现）
 */
export async function runInlineSuggest(req: InlineSuggestRequest): Promise<InlineSuggestResult> {
  const requestId = String(req?.requestId ?? '').trim()
  if (!requestId) return { ok: false, error: '缺少 requestId' }

  // 同 id 重复 → 取消旧的
  inflight.get(requestId)?.abort()

  const text = String(req?.text ?? '')
  if (!text.trim()) return { ok: false, error: '文档为空' }

  const ctrl = new AbortController()
  inflight.set(requestId, ctrl)
  // 硬超时：模型不可达 / 迟迟不出字时不让请求悬挂（否则渲染层忙态永久转圈）
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, INLINE_SUGGEST_TIMEOUT_MS)

  try {
    const { system, user } = buildInlinePrompt({
      text,
      offset: Number(req?.offset ?? 0),
      title: pickFrontmatterTitle(text),
    })

    // 模型解析：设置 aiAssistantInlineSuggestModelId（'pid:mid'）> 请求透传 > 默认链
    //   ★ 内联建议建议单独指定便宜/快的模型（设置 → 编辑器 → AI 内联建议）：
    //     它的调用频次远高于对话，别跟对话主模型共用贵模型。
    let providerId = req.providerId
    let modelId = req.modelId
    const configured = String(getSettingReader()('aiAssistantInlineSuggestModelId') ?? '').trim()
    if (configured) {
      const ci = configured.indexOf(':')
      providerId = ci > 0 ? configured.slice(0, ci) : undefined
      modelId = ci > 0 ? configured.slice(ci + 1) : configured
    }

    let out = ''
    // 早停（感知延迟的主修法）：max_tokens 走全局默认 4096，且思考型模型默认会先思考一大段 ——
    // 都会让「续写一句」等到天荒地老。流式聚合中一旦内容足够就主动掐断：
    //   - 正文超过建议上限（+余量）：已有的 out 直接作为建议返回，不等模型收尾；
    //   - 思考链超过 1500 字符还没出正文：这个时段它不适合作续写，立刻放弃，别让用户干等。
    //   思考走独立的 reasoning 事件（网关已归一化），不会混进 out，截断安全。
    let earlyStop = false
    let thinkingLen = 0
    const r = await invokeLlmStreamInternal(
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        providerId,
        modelId,
        // 内联建议不透传 effort：reasoning_effort 只影响「是否发参数」，思考型模型默认照样思考；
        // 真正的延迟控制靠下面的 reasoning 早停 + 建议用户在设置里给续写单独选非思考模型。
        signal: ctrl.signal,
      },
      (e) => {
        if (e.type === 'text') {
          out += e.delta
          if (!earlyStop && out.length >= INLINE_SUGGEST_MAX_CHARS + 200) {
            earlyStop = true
            ctrl.abort()
          }
        } else if (e.type === 'reasoning') {
          thinkingLen += e.delta.length
          if (!earlyStop && thinkingLen > 1500) {
            earlyStop = true
            ctrl.abort()
          }
        }
      },
    )

    if (ctrl.signal.aborted) {
      // 早停 ≠ 失败：正文已经够一条建议了，直接用（这是「变快」的关键路径）
      if (earlyStop) {
        const suggestion = normalizeInlineSuggestion(out)
        if (isValidSuggestion(suggestion)) return { ok: true, text: suggestion }
        return { ok: false, aborted: true, error: thinkingLen > 0 ? '该模型思考过久，已放弃本次续写' : '已取消' }
      }
      return { ok: false, aborted: true, error: timedOut ? '生成超时' : '已取消' }
    }
    if (!r.ok) return { ok: false, error: r.error ?? '生成失败' }

    const suggestion = normalizeInlineSuggestion(out)
    if (!isValidSuggestion(suggestion)) return { ok: false, error: '生成为空' }
    return { ok: true, text: suggestion }
  } catch (err) {
    if (ctrl.signal.aborted) return { ok: false, aborted: true }
    if (ctrl.signal.aborted) return { ok: false, aborted: true, error: timedOut ? '生成超时' : '已取消' }
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) }
  } finally {
    clearTimeout(timer)
    // 只清自己那格（期间可能已被新请求替换）
    if (inflight.get(requestId) === ctrl) inflight.delete(requestId)
  }
}

/** 取消一个在途请求（渲染层切文档 / 编辑器 dispose / 新请求顶替时调用） */
export function cancelInlineSuggest(requestId: string): boolean {
  const id = String(requestId ?? '').trim()
  if (!id) return false
  const ctrl = inflight.get(id)
  if (!ctrl) return false
  ctrl.abort()
  inflight.delete(id)
  return true
}

/** 清空全部在途请求（换仓库 / 退出时兜底） */
export function cancelAllInlineSuggest(): void {
  for (const ctrl of inflight.values()) ctrl.abort()
  inflight.clear()
}

/** 在途请求数（探针 / 调试用） */
export function inflightInlineSuggestCount(): number {
  return inflight.size
}

// ===== IPC 区（范式同 agentCompress.ts:103） =====

export function registerInlineSuggestHandlers(): void {
  ipcMain.handle('ai:inlineSuggest:run', (_e, req: InlineSuggestRequest | undefined) =>
    runInlineSuggest(req ?? ({} as InlineSuggestRequest)))
  ipcMain.handle('ai:inlineSuggest:cancel', (_e, requestId: string | undefined) =>
    ({ ok: cancelInlineSuggest(String(requestId ?? '')) }))
}
