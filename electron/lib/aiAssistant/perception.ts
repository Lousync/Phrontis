/**
 * 感知模式**编排壳**（v3.4.0 批次 B2）—— 上游方案 §4.2。
 *
 * 设计原则：**编排薄、检索厚**。真正的检索编排早就在
 * `electron/lib/knowledgeSearch.ts` 的 `searchKnowledge()` 门面里了
 * （关键词路 `scoreKeywordPages` + 语义路 `ensureSemanticIndex`→`llmEmbed`→
 * `cosineTopK` + `rrfFuse` 融合 + `filters.excludePageIds/categoryId/tags`）——
 * 上游 §4.2 写于 2026-09-17，当时以为要「新增 semanticSearch 查询出口」，
 * 核对后确认**它早已存在**（门面头注释：「知识召回统一门面」）。
 *
 * 所以本文件只做三件事：
 * ① 门面调一次（query → hits，topK = PERCEPTION_TOPK）；
 * ② 逐篇读正文 → 复用 B1 的 `buildRefSkeleton` 得标题骨架；
 * ③ 交给 `perceptionBudget.ts` 做预算截断与素材段装配。
 *
 * 成本口径：纯本地检索 + **至多 1 次 embedding 调用**（`llmEmbed([query])`，
 * 由门面内部发起），**无 LLM 对话 token 成本**；embedding 增量管线已有
 * （mtime + contentHash diff），高频保存不产生多余嵌入请求。
 * 未配置 embedding 模型时门面自动降级纯关键词，**全链路不报错**（门面设计红线）。
 */

import { searchKnowledge } from '../knowledgeSearch'
import type { KnowledgeHit } from '../knowledgeSearch'
import { buildRefSkeleton } from './refSkeleton'
import { budgetMaterial, PERCEPTION_TOPK } from './perceptionBudget'
import type { MaterialItem, MaterialBudgetResult, PerceptionVia } from './perceptionBudget'
import { readVaultRefText } from './refText'

export type { PerceptionVia, MaterialItem, MaterialBudgetResult }

/** 一条感知素材（编排结果条目；`skeleton`/`excerpt` 已就绪，UI 与注入段共用） */
export interface PerceptionItem extends MaterialItem {}

export interface PerceptionResult {
  /** 预算内的素材（按相关度降序，最多 PERCEPTION_TOPK 篇） */
  items: PerceptionItem[]
  /** 语义路是否可用（false = 本次只走了关键词路，UI 据此显弱提示） */
  semantic: { enabled: boolean; reason?: string }
  /** 因预算被丢掉的篇数（B3 溯源与弱提示用） */
  dropped: number
}

/**
 * 执行一次感知检索。
 *
 * @param query 用户本轮消息（原始文本；空/纯空白 → 不检索）
 * @param opts.excludePageIds 已由 @ 引用进上下文的 pageId —— 排除掉，
 *        避免同一篇既出现在「附加笔记骨架」段又出现在「知识库素材」段（重复注入白花预算）
 *
 * @returns `null` = 不注入（空 query / 全路零命中）。调用方据此照常发请求，
 *          **不报错、不提示**（上游 §4.2 step 4）。
 */
export async function runPerception(
  query: string,
  opts?: { excludePageIds?: string[] },
): Promise<PerceptionResult | null> {
  const q = String(query ?? '').trim()
  if (!q) return null

  let r: Awaited<ReturnType<typeof searchKnowledge>>
  try {
    r = await searchKnowledge({
      query: q,
      topK: PERCEPTION_TOPK,
      filters: opts?.excludePageIds?.length ? { excludePageIds: opts.excludePageIds } : undefined,
    })
  } catch {
    // 门面自身设计为不抛（内部已降级），这里兜一道：感知失败绝不能炸整轮对话
    return null
  }

  const hits: KnowledgeHit[] = Array.isArray(r?.hits) ? r.hits : []
  if (hits.length === 0) return null

  const items: PerceptionItem[] = hits.map((h) => ({
    pageId: h.pageId,
    title: h.title,
    path: h.path,
    via: h.via,
    // 骨架读盘走 B1 的守卫版读取（resolveSafe + 逐篇容错）；
    // 门面算 excerpt 时用的是裸 readFileSync，两条路职责不同，不要合并
    skeleton: buildRefSkeleton({ title: h.title, path: h.path, raw: readVaultRefText(h.path) }).text,
    excerpt: String(h.excerpt ?? ''),
  }))

  const budgeted = budgetMaterial(items)
  if (budgeted.items.length === 0) return null

  return {
    items: budgeted.items,
    semantic: { enabled: r?.semantic?.enabled === true, ...(r?.semantic?.reason ? { reason: r.semantic.reason } : {}) },
    dropped: budgeted.dropped,
  }
}
