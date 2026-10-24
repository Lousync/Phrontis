import { readJson, writeJson } from '../../lib/kbStore/jsonStore'

// R6 去库化：真相源 = .knowbase/modules/translation/cache.json（无迁移存量，新建存储；
// 行快照 schema 与迁移器 planTable 产物约定一致，sql.js 路径已移除，D9）

/** 划词翻译缓存：LLM 结果按 cache_key 幂等复用（原迁移 050 语义） */

export interface TranslationCacheRow {
  cache_key: string
  mode: string
  source_text: string
  result_md: string
  model: string
  created_at: string
  updated_at: string
}

function readRows(): TranslationCacheRow[] {
  return readJson<TranslationCacheRow[]>('translation', 'cache.json', [])
}

function writeRows(rows: TranslationCacheRow[]): void {
  writeJson('translation', 'cache.json', rows)
}

/** 对齐 sqlite datetime('now','localtime') 的本地时间串 */
function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function getTranslationCache(key: string): TranslationCacheRow | null {
  return readRows().find((r) => r.cache_key === key) ?? null
}

/** 全表读取（情报卡片翻译的读取侧合并用：一次进内存建 map，避免逐 key 读盘） */
export function allTranslationCache(): TranslationCacheRow[] {
  return readRows()
}

export function upsertTranslationCache(key: string, mode: string, sourceText: string, resultMd: string, model: string): void {
  const rows = readRows()
  const now = localNow()
  const i = rows.findIndex((r) => r.cache_key === key)
  if (i >= 0) {
    rows[i] = { ...rows[i], mode, source_text: sourceText, result_md: resultMd, model, updated_at: now }
  } else {
    rows.push({
      cache_key: key, mode, source_text: sourceText, result_md: resultMd,
      model, created_at: now, updated_at: now,
    })
  }
  writeRows(rows)
}
