/**
 * 文档读取 IPC（界面阅读用，非 AI 工具）：
 * - docs:pptxPages —— 当前仓库内 .pptx 按页返回文字（沉浸工作台逐页阅读）
 * AI 侧读取复用 builtin.vault.read（2026-09-09 P1 收编，docsReader 同源解析）
 */

import { ipcMain } from 'electron'
import { statSync } from 'fs'
import { extname } from 'path'
import { resolveSafe } from './workspaceManager'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { extractPptxPages } from './docsReader'

export function registerDocsReadHandlers(): void {
  ipcMain.handle('docs:pptxPages', (_e, relPath: string) => {
    try {
      const rel = String(relPath ?? '').trim()
      if (!rel) return { ok: false, error: '缺少文件路径' }
      const cur = getCurrentVault()
      if (!cur?.rootPath) return { ok: false, error: '当前没有打开的仓库' }
      const abs = resolveSafe(cur.rootPath, rel)
      if (!abs) return { ok: false, error: '路径越界或非法' }
      if (!statSync(abs).isFile() || extname(abs).toLowerCase() !== '.pptx') {
        return { ok: false, error: '仅支持仓库内 .pptx 文件' }
      }
      const pages = extractPptxPages(abs).map(p => ({ n: p.n, text: p.text }))
      return { ok: true, pages, total: pages.length }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) }
    }
  })
}
