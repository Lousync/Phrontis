import { app } from 'electron'
import { join } from 'path'

/**
 * 旧附件根（`<userData>/attachments`）。
 *
 * 3.9.2「附件入仓库」后附件文件落在 `<vault>/.attachments/`；本函数只用于**只读兜底**
 * （首次读取旧文件时由 `attachmentStore.ensureAttachmentInVault()` 原子复制进仓库）。
 * 新代码不要再往这里写。
 */
export function getLegacyAttachmentsDir(): string {
  return join(app.getPath('userData'), 'attachments')
}
