/**
 * AI助手（source='aiAssistant'）的作用域收敛与元数据清单（v3.9.0）。
 *
 * 与插件系统同源：复用 `kbStore/vaultScope` 的纯函数（`normalizeRelPath` / `isWithinVaultScope`），
 * 但本模块把约束扩到**读写两侧**——AI助手只能读取/修改用户圈定范围（scope）内的文件，
 * 例外是「一跳链接扩展」：scope 内页面的 `[[出链]]` 直接目标允许读取，仍不可写。
 *
 * scope 表示：归一化后的仓库相对前缀数组（目录前缀 + 单文件路径）；文件自身即其前缀。
 * 空数组视为「未限定」（本模块不允许空 —— 渲染层必须圈定范围或先让 AI 给建议范围）。
 */

import { isWithinVaultScope, normalizeRelPath } from './kbStore/vaultScope'
import { getKnowledgeIndex } from './kbStore/knowledgeIndex'
import type { ToolInvokeCtx } from './aiTools'

/** 从工具上下文取有效 scope（空数组 = undefined = 未限定） */
export function scopeOf(ctx?: ToolInvokeCtx): string[] | undefined {
  return ctx?.scope && ctx.scope.length > 0 ? ctx.scope : undefined
}

/**
 * 一跳链接扩展：scope 内页面的出链目标（标题 → 页面路径）里落在 scope 外的那些。
 * 索引未就绪 / 异常 → 空集合（宁可不放行，不误放）。
 */
export function oneHopReadPaths(scope: string[] | undefined): Set<string> {
  const out = new Set<string>()
  if (!scope || scope.length === 0) return out
  try {
    const idx = getKnowledgeIndex()
    const titleToPath = new Map<string, string>()
    for (const p of idx.pages) if (p.title) titleToPath.set(p.title, p.path)
    for (const p of idx.pages) {
      if (!isWithinVaultScope(p.path, scope)) continue
      for (const t of p.outgoingTitles ?? []) {
        const tp = titleToPath.get(t)
        if (!tp || isWithinVaultScope(tp, scope)) continue
        const norm = normalizeRelPath(tp)
        if (norm) out.add(norm)
      }
    }
  } catch { /* 索引未就绪：退化为无扩展 */ }
  return out
}

/** 读是否放行：scope 内，或 scope 内页面的一跳链接目标 */
export function canRead(rel: string, ctx?: ToolInvokeCtx): boolean {
  return readPredicate(ctx)(rel)
}

/**
 * 批量读过滤谓词：一次性算好一跳扩展集，供 list / search / resolve-ref 在循环里复用
 * （避免每个条目都重扫索引）。
 */
export function readPredicate(ctx?: ToolInvokeCtx): (rel: string) => boolean {
  const scope = scopeOf(ctx)
  if (!scope) return () => true
  const oneHop = oneHopReadPaths(scope)
  return (rel: string): boolean => {
    if (isWithinVaultScope(rel, scope)) return true
    const norm = normalizeRelPath(rel)
    return !!norm && oneHop.has(norm)
  }
}

/** 写是否放行：严格 scope 内（不享受一跳扩展） */
export function canWrite(rel: string, ctx?: ToolInvokeCtx): boolean {
  const scope = scopeOf(ctx)
  if (!scope) return true
  return isWithinVaultScope(rel, scope)
}

/** 读强制：越界抛 ESCOPE（调用方透传为工具错误，模型据此改用 scope 内路径） */
export function assertCanRead(rel: string, ctx?: ToolInvokeCtx): void {
  if (canRead(rel, ctx)) return
  throw Object.assign(
    new Error(`读取路径超出本次任务的作用域: ${rel}（可先读取作用域内的文件，或请用户扩大范围）`),
    { code: 'ESCOPE' },
  )
}

/** 写强制：越界抛 ESCOPE（写不享受一跳扩展） */
export function assertCanWrite(rel: string, ctx?: ToolInvokeCtx): void {
  if (canWrite(rel, ctx)) return
  throw Object.assign(
    new Error(`写入路径超出本次任务的作用域: ${rel}（只能修改用户圈定范围内的文件）`),
    { code: 'ESCOPE' },
  )
}

/** 元数据清单条数上限：清单只用于「让 AI 知道有什么」，正文靠 vault.read 按需取 */
const MANIFEST_MAX_PAGES = 300

/**
 * 构建作用域元数据清单（零正文成本）：标题 / 路径 / 标签 / 出链数 / 大小 / 更新时间。
 * 数据源 = 现有知识索引 + 图谱索引，不额外扫盘。
 */
export function buildScopeManifest(scope: string[] | undefined, taskBrief = ''): string {
  const lines: string[] = []
  lines.push('【本次作用域清单】你**只能读写以下范围内的内容**（越界调用会被拒绝）；范围外文件仅当它们是范围内页面的 [[出链]] 目标时才可读取。')
  if (scope && scope.length > 0) lines.push('范围：' + scope.join('、'))
  if (taskBrief.trim()) lines.push('任务：「' + taskBrief.trim().slice(0, 200) + '」')
  lines.push('')

  let pages: Array<{ title: string; path: string; tags: string[]; links: number; size?: number; updatedAt: string }> = []
  let dirs: string[] = []
  try {
    const idx = getKnowledgeIndex()
    pages = idx.pages
      .filter((p) => isWithinVaultScope(p.path, scope))
      .map((p) => ({
        title: p.title || '(无标题)',
        path: p.path,
        tags: p.tags ?? [],
        links: (p.outgoingTitles ?? []).length,
        size: p.sizeBytes,
        updatedAt: (p.updatedAt || '').slice(0, 10),
      }))
    const dirSet = new Set<string>()
    for (const p of pages) {
      const parts = p.path.replace(/\\/g, '/').split('/')
      parts.pop()
      if (parts.length) dirSet.add(parts.join('/'))
    }
    dirs = [...dirSet].sort()
  } catch { /* 索引未就绪 */ }

  if (dirs.length) {
    lines.push('目录：' + dirs.slice(0, 100).join('、') + (dirs.length > 100 ? ` 等 ${dirs.length} 个` : ''))
    lines.push('')
  }
  if (pages.length === 0) {
    lines.push('（范围内暂无已索引页面 —— 可能需要新建，或范围圈得不对）')
  } else {
    const shown = pages.slice(0, MANIFEST_MAX_PAGES)
    lines.push(`页面（${pages.length} 篇${pages.length > shown.length ? `，仅列前 ${shown.length}` : ''}）：`)
    for (const p of shown) {
      const tag = p.tags.length ? ` [${p.tags.slice(0, 4).join(',')}]` : ''
      const sz = typeof p.size === 'number' ? ` ${p.size}B` : ''
      lines.push(`- ${p.title} — ${p.path}${tag} 链接${p.links}${sz} ${p.updatedAt}`)
    }
  }
  return lines.join('\n')
}
