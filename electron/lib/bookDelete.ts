import { bookCoverDelete, bookMetaGet, bookMetaRemove } from './kbStore/vaultBookMetaRepo'
import { readerStateRemoveBook } from './kbStore/readerStateVaultRepo'
import { pdfReaderCoverRemove, pdfReaderRemoveBook } from './kbStore/pdfReaderVaultRepo'
import { excerptDeleteBook } from './kbStore/excerptVaultRepo'
import { excerptExportRemove } from './kbStore/excerptExportVaultRepo'
import { trashWorkspacePath } from './workspaceManager'

/**
 * 「彻底删书」的业务核（书架右键入口）。
 *
 * ★ 为什么单独成文件、而不是留在 `bookMarketRepo.ts` 的 handler 里：
 *   ① 这是**破坏性**操作，必须有真跑 electron 的运行期探针（`.AGENT/scripts/book-market/probe-book-delete.cjs`）；
 *      而 handler 注册层 import `electron` 的 ipcMain，探针够不到 —— 抽成零 electron 依赖的核才能直接调。
 *   ② 与铁律 2 同一条纪律：**IPC handler 只是转发层，两边共用同一实现**（AI 工具那条路同理）。
 *   本文件**不广播**（广播归 handler 的转发层，保持核只有「文件 + JSON」两种副作用，探针才好断言）。
 *
 * 清理范围（用户 2026-09-23 拍板「彻底删」）：
 *   书文件 → 系统回收站；meta / `.covers` 封面 / 阅读进度 / 书签 / 摘录 / 导出映射全清；
 *   **保留**导出出的那篇「读书笔记」页面（正文归编辑器与知识库管，删书不该动用户的笔记）。
 *
 * 步骤顺序有硬约束：**先取 meta（拿封面引用）→ 再移走书文件 → 最后清元数据**。
 * 反过来会留下鬼影 —— 元数据已清（书架扫不到）但书文件还在 `.books/` 里（资源管理器里看得见）。
 */
export interface BookDeleteResult {
  ok: boolean
  errors: string[]
}

export async function deleteBookEverywhere(rootId: string, relPath: string): Promise<BookDeleteResult> {
  const errors: string[] = []
  /** 单步执行：把「返回 {ok,error}」与「抛异常」两种失败都收进 errors，**不中断**后续步骤 */
  const step = (label: string, fn: () => { ok: boolean; error?: string } | void): void => {
    try {
      const r = fn()
      if (r && !r.ok && r.error) errors.push(`${label}：${r.error}`)
    } catch (e) {
      errors.push(`${label}：${(e as Error).message}`)
    }
  }

  // ① 拿 meta（封面引用）—— 必须赶在文件被移走之前
  const meta = bookMetaGet(relPath)
  try {
    await trashWorkspacePath(rootId, relPath)
  } catch (e) {
    errors.push(`移入回收站：${(e as Error).message}`)
  }

  // ② 元数据 + `.books/.covers` 封面（fsWatcher 的 bookMetaPruneOrphans 也会兜，显式做求确定性）
  step('元数据', () => bookMetaRemove(relPath))
  if (meta?.coverRel) step('封面', () => { bookCoverDelete(meta.coverRel) })

  // ③ 进度 / 书签：txt·foliate 在 readerState，pdf 在 pdfReader —— 两边都清，命中哪个算哪个
  step('阅读进度', () => readerStateRemoveBook(rootId, relPath))
  step('PDF 进度', () => pdfReaderRemoveBook(rootId, relPath))
  step('PDF 封面缓存', () => pdfReaderCoverRemove(rootId, relPath))

  // ④ 摘录 + 导出映射（**保留**导出出的那篇「读书笔记」页面）
  step('摘录', () => excerptDeleteBook(rootId, relPath))
  step('导出映射', () => excerptExportRemove(rootId, relPath))

  return { ok: errors.length === 0, errors }
}
