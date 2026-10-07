// 层级总结（周 / 月 / 年）的落盘通道 —— `.knowbase/blog/summaries/*.md`
//
// 与 entryRepo 的分工：日志是「每天一篇」的正文，这里是「一段窗口一份」的复盘。
// 窗口口径由渲染层 `src/lib/summary.ts` 决定（日历口径），主进程只负责按窗口读写文件，
// 不自己算窗口 —— 否则「磁贴点周号算出的窗口」与「落到哪个文件」会各算一套。
import { ipcMain } from 'electron'
import type { SummaryKind } from '../../../src/lib/summary'
import {
  vaultListSummaries, vaultGetSummaryById, vaultEnsureSummary, vaultUpdateSummary,
} from '../../lib/kbStore/blogVaultRepo'
import { broadcastDataChanged } from '../../main/windowBus'

export function registerBlogSummaryHandlers(): void {
  // 列表：只用得到窗口与时间戳。正文置空串单独取（getSummaryById），
  // 避免一次读过几十份正文（周+月+年累计一年约 60 份）。
  ipcMain.handle('blog:listSummaries', () => {
    return vaultListSummaries().map((s) => ({ ...s, contentMd: '' }))
  })

  ipcMain.handle('blog:getSummaryById', (_event, id: string) => {
    return vaultGetSummaryById(id)
  })

  // 按需生成：同窗口幂等（同窗口必同文件）——「点击入口时没有就先建再打开」
  ipcMain.handle('blog:ensureSummary', (_event, kind: SummaryKind, start: string, end: string) => {
    const s = vaultEnsureSummary(kind, start, end)
    broadcastDataChanged('blog')
    return s
  })

  ipcMain.handle('blog:saveSummary', (_event, id: string, contentMd: string) => {
    const s = vaultUpdateSummary(id, { contentMd })
    broadcastDataChanged('blog')
    return s
  })
}
