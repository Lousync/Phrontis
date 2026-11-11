import type { IncomingMessage } from 'http'
import { getInboxDir } from './paths'
import { MAX_UPLOAD_BYTES, parseMultipartUpload, type UploadedFile } from './multipart'

/**
 * 设备传输（lanShare）上行：流式 multipart → 收件箱。
 *
 * 解析核心已抽到 `./multipart.ts`（手机伴侣文件通道共用同一份实现）：
 * 这里只注入 lanShare 自己的目标目录与命名策略（`<时间戳>-<净化名>`），行为保持不变。
 */

export { MAX_UPLOAD_BYTES, HttpError, type UploadedFile } from './multipart'

export async function parseUpload(req: IncomingMessage, maxBytes = MAX_UPLOAD_BYTES): Promise<UploadedFile[]> {
  return parseMultipartUpload(req, { targetDir: getInboxDir(), maxBytes })
}
