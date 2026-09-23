import { readJson, writeJsonOrThrow } from './jsonStore'
import {
  applyExportEntry,
  buildExcerptExportMarkdown,
  emptyExportStore,
  exportKey,
  type ExcerptExportEntry,
  type ExcerptExportStore,
} from './excerptExportSchema'
import { excerptList } from './excerptVaultRepo'
import { vaultCreatePage, vaultExportExcerptsNote } from './knowledgeVaultRepo'
import { getCurrentVault } from './vaultContext'
import { bookDisplayName, bookIdentityName } from './bookFormats'

/**
 * 摘录导出映射 vault 仓库（书架阅读器 · 摘录导出知识库闭环，方案 §C1）——`.knowbase/modules/excerptExports.json` **唯一写方**。
 *
 * - 键 `{rootId}/{relPath}`（与 excerptKey 同口径），值 = 一本书 ↔ 一篇「读书笔记」页的映射。
 * - 导出入口 `excerptExportToNote`：先取该书全部摘录 → 生成 md → 已导出过且页仍在则覆盖重写（保留 id），
 *   否则新建页（自愈落收件箱）并回写映射。
 * - 纯校验 / md 生成在 excerptExportSchema.ts（零依赖，契约脚本直接 import）。
 */

const MOD = 'modules'
const F_STORE = 'excerptExports.json'

function readStore(): ExcerptExportStore {
  const raw = readJson<ExcerptExportStore>(MOD, F_STORE, emptyExportStore())
  if (!raw || typeof raw !== 'object' || typeof raw.books !== 'object' || raw.books === null) return emptyExportStore()
  return raw
}

function requireCurrentRootId(rootId: string): void {
  const cur = getCurrentVault()
  if (!cur) throw new Error('当前没有打开的仓库')
  if (rootId !== cur.rootId) throw new Error('rootId 与当前仓库不一致')
}

/** 读取某书的导出映射条目（无则 null） */
export function getExportEntry(rootId: string, relPath: string): ExcerptExportEntry | null {
  const key = exportKey(rootId, relPath)
  if (!key) return null
  return readStore().books[key] ?? null
}

/**
 * 删掉某书的导出映射条目（彻底删书联动）。幂等：无映射即成功。
 * ★ **只删映射，不删那篇「读书笔记」页面**（2026-09-23 拍板）——页面是用户的笔记，不是书的附属；
 *   书没了笔记也该留着。代价：同名书重下再导出会新建一篇（映射已断），可接受。
 */
export function excerptExportRemove(rootId: string, relPath: string): { ok: boolean; error?: string } {
  const key = exportKey(rootId, relPath)
  if (!key) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }
  const store = readStore()
  if (!store.books[key]) return { ok: true }
  const books = { ...store.books }
  delete books[key]
  try {
    writeJsonOrThrow(MOD, F_STORE, { version: 1, books })
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  return { ok: true }
}

/**
 * 导出一本书的全部摘录为知识库「读书笔记」页（方案 C2/C3）。
 * 幂等：重复导出 = 覆盖重写同一篇（保留 id），不产生新页。
 * 自愈：映射指向的页面被用户删除 → 重新创建并回写新 id。
 */
export function excerptExportToNote(rootId: string, relPath: string): { ok: boolean; pageId?: string; pagePath?: string; created?: boolean; count?: number; error?: string } {
  const key = exportKey(rootId, relPath)
  if (!key) return { ok: false, error: '非法的书键' }
  try { requireCurrentRootId(rootId) } catch (e) { return { ok: false, error: (e as Error).message } }

  const excerpts = excerptList(rootId, relPath)
  if (excerpts.length === 0) return { ok: false, error: '该书还没有摘录，无可导出内容' }

  const now = new Date().toISOString()
  const md = buildExcerptExportMarkdown({ rootId, relPath, bookName: bookDisplayName(relPath), excerpts, exportedAt: now })
  const store = readStore()
  const existing = store.books[key]

  // 已导出过且页面仍在索引中 → 覆盖重写（保留 frontmatter id）
  if (existing && existing.pageId) {
    const updated = vaultExportExcerptsNote(existing.pageId, md)
    if (updated) {
      const next = applyExportEntry(store, key, { ...existing, pagePath: updated.path, exportedAt: now, count: excerpts.length })
      writeJsonOrThrow(MOD, F_STORE, next)
      return { ok: true, pageId: updated.id, pagePath: updated.path, created: false, count: excerpts.length }
    }
    // 页面已不在库（被删）→ 落到下方自愈分支
  }

  // 新建页（落默认收件箱）+ 回写映射。
  // ★ 页名用**身份名**（带扩展名，B-15）：`读书笔记 · 探针样书.fb2` —— 页名是身份不是展示，
  //   用 bookDisplayName 会让 a.epub / a.fb2 / a.cbz 输出同名页，只能靠 (1)(2) 后缀区分。
  //   md 内的 H1 仍用展示名（给人读），来源行已带 relPath，两者分工不重叠。
  const page = vaultCreatePage({ title: `读书笔记 · ${bookIdentityName(relPath)}`, contentMd: md })
  const entry: ExcerptExportEntry = { pageId: page.id, pagePath: page.path, exportedAt: now, count: excerpts.length }
  const next = applyExportEntry(readStore(), key, entry)
  writeJsonOrThrow(MOD, F_STORE, next)
  return { ok: true, pageId: page.id, pagePath: page.path, created: true, count: excerpts.length }
}
