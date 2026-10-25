import { invokeLlmInternal, resolveInlineSuggestFallback, firstEnabledModelSpec } from '../llmService'
import { allTranslationCache, upsertTranslationCache } from '../../database/repositories/translationRepo'
import { intelTextHash, isEnglishText, parseTranslateArray } from '../../../src/lib/intelPure'
import type { IntelGetSetting } from './intelSettings'
import type { IntelItem } from '../../../src/types'

/**
 * 卡片英文自动翻译（docs/intel-translate-plan.md §3）：批量 LLM 管线 + 会话内状态。
 * 纯函数（isEnglishText / parseTranslateArray / intelTextHash）在 src/lib/intelPure.ts，契约脚本直跑同一实现。
 * 译文缓存复用 translationRepo（.knowbase/modules/translation/cache.json，mode 'plain'，sha256 内容寻址）——
 * 同一文本跨条目 / 跨刷新 / 跨会话零 token 复用，与划词翻译共用一张缓存表。
 */

export const PLAIN_MODE = 'plain'
/** 批大小（方案 §3.2）：标题批 24（极便宜，也是预热单批的量），摘要批 ≤4（长文控制单次输出） */
export const TITLE_BATCH = 24
export const SUMMARY_BATCH = 4
/** 预热：刷新完成后 idle 补 top-N 英文条目的标题（方案 §4.1，N = 一个标题批） */
export const PREHEAT_TITLES = TITLE_BATCH

const TITLE_SYSTEM = '你是信息流卡片的标题翻译引擎。输入一个 JSON 字符串数组(英文科技/新闻标题),输出等长的简体中文翻译 JSON 数组。规则:产品名、公司名、人名、型号、协议与库名保留英文原文(如 GitHub、GPT-5、LangChain);数字与单位不变;用简洁的新闻标题体,不添油加醋。只输出 JSON 数组,不要任何其他文字。'
const SUMMARY_SYSTEM = '你是信息流卡片的摘要翻译引擎。输入一个 JSON 字符串数组(英文科技/新闻摘要),输出等长的简体中文翻译 JSON 数组。规则:一段连贯中文,信息量不超过原文,不添加原文没有的内容;产品名、公司名、人名、型号、协议与库名保留英文原文;数字与单位不变。只输出 JSON 数组,不要任何其他文字。'

// ===== 缓存 =====

export function plainKeyOf(text: string): string {
  return `${PLAIN_MODE}:${intelTextHash(text)}`
}

/** 已有译文键集（编排时去重用，避免重复送 LLM） */
export function existingPlainKeys(): Set<string> {
  const s = new Set<string>()
  for (const r of allTranslationCache()) {
    if (r.cache_key.startsWith(`${PLAIN_MODE}:`)) s.add(r.cache_key)
  }
  return s
}

/** 读取侧合并：一次读全表建 map，把 titleZh/summaryZh 挂到 items（只改运行时字段，不落 intel.json） */
export function mergeItemZh(items: IntelItem[]): IntelItem[] {
  if (!items.length) return items
  const rows = allTranslationCache()
  if (!rows.length) return items
  const zh = new Map<string, string>()
  for (const r of rows) {
    if (r.cache_key.startsWith(`${PLAIN_MODE}:`) && r.result_md) zh.set(r.cache_key, r.result_md)
  }
  if (!zh.size) return items
  return items.map((it) => {
    const titleZh = zh.get(plainKeyOf(it.title))
    const summaryZh = it.summary ? zh.get(plainKeyOf(it.summary)) : undefined
    return titleZh || summaryZh
      ? { ...it, ...(titleZh ? { titleZh } : {}), ...(summaryZh ? { summaryZh } : {}) }
      : it
  })
}

// ===== 会话内状态（随 app 生命周期，不落盘；方案 §3.3/§3.4）=====

/** failCount ≥ 2 的文本键：本会话不再自动重试 */
const failedKeys = new Map<string, number>()
/** 中文条目（标题摘要都不是英文）：本会话不再对其发请求 */
const skippedIds = new Set<string>()
/** 会话预算计数 + 熔断原因（noModel 一旦置位不再自动恢复，重启 dev 才重试） */
export const translateSession = { translatedCount: 0, disabledReason: '' as '' | 'noModel' | 'budget' }

export function isKeyPoisoned(key: string): boolean {
  return (failedKeys.get(key) ?? 0) >= 2
}

export function markKeyFailed(key: string): void {
  failedKeys.set(key, (failedKeys.get(key) ?? 0) + 1)
}

export function markSkippedId(id: string): void {
  skippedIds.add(id)
}

export function isSkippedId(id: string): boolean {
  return skippedIds.has(id)
}

/** 预算解析（intelStore 与预热共用；非法值回落默认 300，上限 2000 对齐设置项） */
export function translateBudgetOf(get: IntelGetSetting): number {
  const raw = Number(get('intel.translateBudget'))
  if (!Number.isFinite(raw) || raw <= 0) return 300
  return Math.min(Math.floor(raw), 2000)
}

// ===== 单并发队列（渲染层防抖后仍可能并发 IPC；预热与会话请求共用一条队）=====

let chain: Promise<unknown> = Promise.resolve()

export function serializeTranslate<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

// ===== LLM 调用 =====

type BatchOutcome = { ok: true; out: string[]; model: string } | { ok: false; configFail?: boolean }

/** 单批：texts 已去重去缓存；configFail = 供应商/模型配置类失败（→ 会话熔断 noModel） */
export async function translateBatch(texts: string[], kind: 'title' | 'summary'): Promise<BatchOutcome> {
  // 模型解析（TD6）：默认链命中思考型自动降级（resolveInlineSuggestFallback 内置该判据），
  // 无 defaultChatModel 时兜底第一个启用供应商 —— 翻译不需要思考链
  const spec = resolveInlineSuggestFallback() ?? firstEnabledModelSpec()
  if (!spec) return { ok: false, configFail: true }
  const system = kind === 'title' ? TITLE_SYSTEM : SUMMARY_SYSTEM
  const attempt = async (extraNote?: string): Promise<BatchOutcome> => {
    const r = await invokeLlmInternal({
      providerId: spec.providerId,
      modelId: spec.modelId,
      effort: 'off',
      // 内部调用方专用早停通道（LlmInvokeRequest.maxTokens 注释）：标题批 40×n+120，摘要批 3200
      maxTokens: kind === 'title' ? 40 * texts.length + 120 : 3200,
      // 固定用途名（口径同 translateService.ts）：会话头稳定，不污染右栏「会话消耗 TOP」
      sessionId: 'intel-translate',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: extraNote ? `${extraNote}\n${JSON.stringify(texts)}` : JSON.stringify(texts) },
      ],
    })
    if (!r.ok) {
      const configFail = r.code === 'NO_DEFAULT_MODEL' || r.code === 'PROVIDER_NOT_FOUND' || r.code === 'PROVIDER_DISABLED'
      return { ok: false, configFail }
    }
    const parsed = parseTranslateArray(r.content, texts.length)
    return parsed ? { ok: true, out: parsed, model: r.model } : { ok: false }
  }
  const first = await attempt()
  if (first.ok || first.configFail) return first
  // JSON 解析失败：追加一条强约束重试一次，仍失败由调用方按整批失败处理
  return attempt('仅输出 JSON 数组,不要任何其他文字。')
}

/** 批成功后的落库（调用方负责广播） */
export function persistTranslations(kind: 'title' | 'summary', texts: string[], out: string[], model: string): number {
  let n = 0
  for (let i = 0; i < texts.length; i++) {
    const zh = out[i]?.trim()
    if (!zh) continue
    upsertTranslationCache(plainKeyOf(texts[i]), PLAIN_MODE, texts[i], zh, model)
    n++
  }
  translateSession.translatedCount += n
  return n
}
