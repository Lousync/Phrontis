import { copyFileSync } from 'fs'
import { dialog, ipcMain, BrowserWindow } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import { getCurrentVault } from '../../lib/kbStore/vaultContext'
import { scanVaultPdfs } from '../../lib/kbStore/knowledgeIndex'
import {
  pdfReaderCoverList, pdfReaderCoverSave, pdfReaderGetBook, pdfReaderImportPdf,
  pdfReaderListProgress, pdfReaderPatchBook,
} from '../../lib/kbStore/pdfReaderVaultRepo'

/**
 * PDF 阅读数据 IPC 注册转发层（v3.4.0 PDF 阅读体验整包，方案 §4）。
 * handler 只做转发 + 广播，逻辑全在 lib/kbStore/pdfReaderVaultRepo.ts（真相源）。
 *
 * 通道清单：
 *   pdfReader:listBooks  扫 vault .pdf（scanVaultPdfs 出口）join 进度 → 书架清单（不落盘）
 *   pdfReader:get        读单本书状态
 *   pdfReader:patch      局部写回（expectedUpdatedAt 冲突检测）→ broadcastDataChanged
 *   pdfReader:coverList  封面缓存索引 { 书键: { mtimeMs, file } }
 *   pdfReader:coverSave  写封面（png dataUrl + mtime 校验）→ broadcastDataChanged
 *   ws:importPdf         dialog 选外部 PDF → 拷入仓库根（重名自动后缀）→ broadcastDataChanged
 */

export interface PdfBookListItem {
  relPath: string
  name: string
  size: number
  mtime: number
  lastPage: number
  hasProgress: boolean
  updatedAt: string | null
}

export function registerPdfReaderHandlers(): void {
  ipcMain.handle('pdfReader:listBooks', (): { ok: boolean; books?: PdfBookListItem[]; error?: string } => {
    const cur = getCurrentVault()
    if (!cur) return { ok: false, error: '当前没有打开的仓库' }
    try {
      const scanned = scanVaultPdfs()
      const progress = pdfReaderListProgress(cur.rootId)
      const books: PdfBookListItem[] = scanned.map((f) => {
        const st = progress[f.relPath]
        return {
          relPath: f.relPath,
          name: f.relPath.split('/').pop() ?? f.relPath,
          size: f.size,
          mtime: f.mtimeMs,
          lastPage: st?.lastPage ?? 1,
          hasProgress: !!st && (st.lastPage > 1 || st.bookmarks.length > 0 || st.scrollRatio > 0),
          updatedAt: st?.updatedAt ?? null,
        }
      })
      return { ok: true, books }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('pdfReader:get', (_e, rootId: string, relPath: string) => {
    try {
      return { ok: true, state: pdfReaderGetBook(String(rootId), String(relPath)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('pdfReader:patch', (_e, rootId: string, relPath: string, patch: unknown, expectedUpdatedAt?: string) => {
    const r = pdfReaderPatchBook(String(rootId), String(relPath), patch, typeof expectedUpdatedAt === 'string' ? expectedUpdatedAt : undefined)
    if (r.ok) broadcastDataChanged('pdfReader')
    return r
  })

  ipcMain.handle('pdfReader:coverList', () => {
    try {
      return { ok: true, covers: pdfReaderCoverList() }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('pdfReader:coverSave', (_e, rootId: string, relPath: string, dataUrl: string, expectedMtimeMs: number) => {
    const r = pdfReaderCoverSave(String(rootId), String(relPath), typeof dataUrl === 'string' ? dataUrl : '', typeof expectedMtimeMs === 'number' ? expectedMtimeMs : 0)
    if (r.ok) broadcastDataChanged('pdfReader')
    return r
  })

  // 书架「＋导入」：dialog 选外部 PDF → 拷入仓库根（重名自动后缀）。
  // 拷入仓库 = 文件树可见变化，knowledge 侧由既有 fsWatcher 兜底；这里只播 pdfReader scope 供书架刷新。
  ipcMain.handle('ws:importPdf', async (_e, rootId: string) => {
    const cur = getCurrentVault()
    if (!cur) return { ok: false, error: '当前没有打开的仓库' }
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return { ok: false, error: '没有可用的窗口' }
    const r = await pdfReaderImportPdf(
      String(rootId),
      async () => {
        const res = await dialog.showOpenDialog(win, {
          title: '导入 PDF 到仓库',
          filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
          properties: ['openFile', 'multiSelections'],
        })
        return res.canceled ? null : res.filePaths
      },
      (src, dest) => copyFileSync(src, dest),
    )
    if (r.ok) broadcastDataChanged('pdfReader')
    return r
  })
}
