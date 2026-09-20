import { ipcMain } from 'electron'
import { broadcastDataChanged } from '../../main/windowBus'
import { getCurrentVault } from '../../lib/kbStore/vaultContext'
import { scanVaultBooks } from '../../lib/kbStore/knowledgeIndex'
import { readerStateListProgress } from '../../lib/kbStore/readerStateVaultRepo'
import { bookDisplayName } from '../../lib/kbStore/bookFormats'
import {
  pdfReaderCoverGet, pdfReaderCoverList, pdfReaderCoverSave, pdfReaderGetBook,
  pdfReaderListProgress, pdfReaderPatchBook,
} from '../../lib/kbStore/pdfReaderVaultRepo'

/**
 * PDF 阅读数据 IPC 注册转发层（v3.4.0 PDF 阅读体验整包，方案 §4）。
 * handler 只做转发 + 广播，逻辑全在 lib/kbStore/pdfReaderVaultRepo.ts（真相源）。
 *
 * 通道清单：
 *   pdfReader:listBooks  扫 vault 书籍（scanVaultBooks 出口，pdf+txt）join 进度 → 书架清单（不落盘）
 *   pdfReader:get        读单本书状态
 *   pdfReader:patch      局部写回（expectedUpdatedAt 冲突检测）→ broadcastDataChanged
 *   pdfReader:coverList  封面缓存索引 { 书键: { mtimeMs, file } }
 *   pdfReader:coverSave  写封面（png dataUrl + mtime 校验）→ broadcastDataChanged
 *
 * 原 ws:importPdf（dialog 选外部 PDF 拷入仓库根）已整条退役（2026-09-19 拍板）：
 * 书架是自动库，放 .pdf 进仓库任意目录即被扫描扫到，导入入口冗余。
 *
 * 书架升级全格式阅读器一期（2026-09-20）：listBooks 按 kind 分流 join ——
 *   pdf  → pdfReaderListProgress（页码/书签口径不变）
 *   txt  → readerStateListProgress（pct 进度口径），映射 lastPage=0/totalPages=0
 */

export interface BookListItem {
  relPath: string
  name: string
  size: number
  mtime: number
  kind: 'pdf' | 'txt'
  lastPage: number
  /** 总页数（0 = 尚未读过/未登记）——书架侧栏进度条分母；txt 恒 0（进度用 pct） */
  totalPages: number
  /** txt 阅读进度 0..100（仅 kind==='txt' 有值） */
  pct?: number
  hasProgress: boolean
  updatedAt: string | null
}

export function registerPdfReaderHandlers(): void {
  ipcMain.handle('pdfReader:listBooks', (): { ok: boolean; books?: BookListItem[]; error?: string } => {
    const cur = getCurrentVault()
    if (!cur) return { ok: false, error: '当前没有打开的仓库' }
    try {
      const scanned = scanVaultBooks()
      const progress = pdfReaderListProgress(cur.rootId)
      const readerProgress = readerStateListProgress(cur.rootId)
      const books: BookListItem[] = scanned.map((f) => {
        const name = bookDisplayName(f.relPath)
        if (f.kind === 'txt') {
          const st = readerProgress[f.relPath]
          const pct = st?.pct ?? 0
          return {
            relPath: f.relPath,
            name,
            size: f.size,
            mtime: f.mtimeMs,
            kind: 'txt',
            lastPage: 0,
            totalPages: 0,
            pct,
            hasProgress: pct > 0,
            updatedAt: st?.updatedAt ?? null,
          }
        }
        const st = progress[f.relPath]
        return {
          relPath: f.relPath,
          name,
          size: f.size,
          mtime: f.mtimeMs,
          kind: 'pdf',
          lastPage: st?.lastPage ?? 1,
          totalPages: st?.totalPages ?? 0,
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

  // 封面字节读取（缓存命中后渲染 <img> 用；未命中返回 null 由渲染层懒渲染补种）
  ipcMain.handle('pdfReader:coverGet', (_e, rootId: string, relPath: string) => {
    try {
      return { ok: true, dataUrl: pdfReaderCoverGet(String(rootId), String(relPath)) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('pdfReader:coverSave', (_e, rootId: string, relPath: string, dataUrl: string, expectedMtimeMs: number) => {
    const r = pdfReaderCoverSave(String(rootId), String(relPath), typeof dataUrl === 'string' ? dataUrl : '', typeof expectedMtimeMs === 'number' ? expectedMtimeMs : 0)
    if (r.ok) broadcastDataChanged('pdfReader')
    return r
  })
}
