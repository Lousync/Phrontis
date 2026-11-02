import { ipcMain } from 'electron'
import {
  vaultVocabDayGet,
  vaultVocabRecordSession,
  vaultVocabReviewWords,
  type VocabReviewOptions,
  type VocabSessionInput,
} from 'phrontis-core/kbStore/vocabVaultRepo'
import { broadcastDataChanged } from '../../main/windowBus'

/**
 * 背单词 IPC 注册（v3.17.0 新模块）。
 *
 * 真相源在 phrontis-core/kbStore/vocabVaultRepo；这里只做转发 + 写操作后的跨窗口广播
 * （scope 对齐 src/lib/dataChanged.ts 的 'vocab'）。channel 命名对齐 `<模块>:<动作>`。
 * AI 工具（builtinTools）不经 IPC、直接调同一批 repo 业务函数。
 */
export function registerVocabHandlers(): void {
  ipcMain.handle('vocab:getDay', (_e, date: string) => vaultVocabDayGet(date))

  ipcMain.handle('vocab:recordSession', (_e, input: VocabSessionInput) => {
    const day = vaultVocabRecordSession(input)
    broadcastDataChanged('vocab')
    return day
  })

  ipcMain.handle('vocab:reviewWords', (_e, opts?: VocabReviewOptions) => vaultVocabReviewWords(opts))
}
