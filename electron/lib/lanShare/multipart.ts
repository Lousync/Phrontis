import { createWriteStream, unlinkSync, type WriteStream } from 'fs'
import { join } from 'path'
import type { IncomingMessage } from 'http'
import { randomUUID } from 'crypto'

/**
 * multipart/form-data 流式解析（零依赖实现）—— 设备传输（lanShare）与手机伴侣文件通道共用。
 *
 * 约束：
 *  - 文件内容流式写盘，不整块读进内存（内存占用 ≈ 一个 chunk 大小）
 *  - 只提取「文件类」part（带 filename 的），其余字段忽略
 *  - 失败 / 超限 / 客户端中断：已写的临时文件全部清理，不在目标目录留半成品
 *
 * 目标目录、单文件上限、落盘命名由调用方注入（手机伴侣写 `iPad 批注/`，lanShare 写收件箱）。
 */

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'HttpError'
  }
}

export interface UploadedFile {
  originalName: string
  savedName: string
  size: number
  path: string
}

export interface MultipartUploadOptions {
  /** 落盘目录（必须已存在；调用方负责创建） */
  targetDir: string
  /** 单文件上限；超限 → HttpError(413) */
  maxBytes?: number
  /** 临时文件名（缺省 `<时间戳>-<净化名>`）；返回非法文件名时回落缺省 */
  fileNameFor?: (originalName: string, sanitizedName: string) => string
}

/** 文件名合法性：非空、不含路径分隔符、不是 . / .. */
function isPlainFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 240) return false
  if (name === '.' || name === '..') return false
  if (/[\\/]/.test(name)) return false
  if (/[\x00-\x1f]/.test(name)) return false
  return true
}

function sanitizeFileName(raw: string): string {
  // 先取最后一个路径分隔符之后（Windows 客户端可能带反斜杠），再替换非法字符
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
  if (isPlainFileName(cleaned)) return cleaned
  return `file-${randomUUID().slice(0, 8)}`
}

const CRLFCRLF = Buffer.from('\r\n\r\n')

/** 从 part 头里取文件名（兼容 filename= 与 RFC 5987 filename*=） */
function parsePartFileName(headerRaw: string): string | null {
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;\r\n]+)/i.exec(headerRaw)
  if (star) {
    const raw = star[1].trim().replace(/^"(.*)"$/, '$1')
    try { return decodeURIComponent(raw) } catch { return raw }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(headerRaw)
    ?? /filename\s*=\s*([^;\r\n]+)/i.exec(headerRaw)
  if (!plain) return null
  const raw = plain[1].trim().replace(/^"(.*)"$/, '$1')
  return raw.replace(/\\(.)/g, '$1') || null
}

export async function parseMultipartUpload(req: IncomingMessage, opts: MultipartUploadOptions): Promise<UploadedFile[]> {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES
  const contentType = req.headers['content-type'] || ''
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!bm) throw new HttpError(400, '缺少 multipart boundary')
  const boundary = (bm[1] || bm[2] || '').trim()
  if (!boundary) throw new HttpError(400, 'boundary 为空')
  const delim = Buffer.from(`--${boundary}`)

  const uploaded: UploadedFile[] = []
  /** 每个已创建的临时文件：成功路径留给调用方 rename，失败路径在这里删掉 */
  const temps: Array<{ path: string; stream: WriteStream; closed: boolean }> = []
  let fatal: HttpError | null = null
  let settled = false
  let ended = false

  const safeUnlink = (p: string): void => {
    try { unlinkSync(p) } catch { /* 已被删 / 尚未落盘 */ }
  }

  const discardTemp = (t: { path: string; stream: WriteStream; closed: boolean }): void => {
    if (t.closed) {
      safeUnlink(t.path)
      return
    }
    // Windows 上打开中的文件删不掉：等 close（fd 释放）后再删
    t.stream.once('close', () => safeUnlink(t.path))
    t.stream.destroy()
  }

  const cleanupTemps = (): void => {
    for (const t of temps) discardTemp(t)
    temps.length = 0
  }

  await new Promise<void>((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let state: 'preamble' | 'header' | 'body' = 'preamble'
    let current: {
      fileName: string | null
      savedName: string
      size: number
      stream: WriteStream | null
      path: string | null
      temp: { path: string; stream: WriteStream; closed: boolean } | null
    } | null = null
    let pendingStreams = 0

    const settle = (err: Error | null): void => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    /** 立即失败：销毁请求 + 清理临时文件（客户端已不可用 / 格式错误） */
    const failNow = (status: number, message: string): void => {
      if (!fatal) fatal = new HttpError(status, message)
      cleanupTemps()
      settle(fatal)
      if (!req.destroyed) req.destroy()
    }

    /** 可恢复失败：停止写盘但把请求体读完，让 413 / 415 能正常送达客户端 */
    const markOverLimit = (): void => {
      if (!fatal) fatal = new HttpError(413, '文件超过大小上限')
      const c = current
      current = null
      if (c?.temp) discardTemp(c.temp)
      else if (c?.stream) c.stream.destroy()
    }

    const tryFinish = (): void => {
      if (settled || !ended) return
      if (pendingStreams > 0) return
      if (fatal) {
        cleanupTemps()
        settle(fatal)
        return
      }
      settle(null)
    }

    const closeCurrent = (): void => {
      if (!current) return
      const c = current
      current = null
      if (c.fileName && c.path && c.stream) {
        uploaded.push({ originalName: c.fileName, savedName: c.savedName, size: c.size, path: c.path })
        pendingStreams += 1
        // 等 close（fd 真正释放）而不是 finish：Windows 上 open 中的文件 rename 会 EPERM
        c.stream.once('close', () => {
          pendingStreams -= 1
          tryFinish()
        })
        c.stream.end()
      } else if (c.stream) {
        c.stream.destroy()
      }
    }

    const writeChunk = (chunk: Buffer): void => {
      const c = current
      if (!c || !c.fileName) return
      c.size += chunk.length
      if (c.size > maxBytes) {
        markOverLimit()
        return
      }
      if (!c.stream) {
        c.savedName = sanitizeFileName(c.fileName)
        const preferred = opts.fileNameFor ? opts.fileNameFor(c.fileName, c.savedName) : ''
        const name = isPlainFileName(preferred) ? preferred : `${Date.now()}-${c.savedName}`
        c.path = join(opts.targetDir, name)
        c.stream = createWriteStream(c.path)
        // 建流即登记：中断 / 超限时还没走到 closeCurrent，也要能清理这个临时文件
        const t = { path: c.path, stream: c.stream, closed: false }
        c.temp = t
        temps.push(t)
        c.stream.once('close', () => { t.closed = true })
        c.stream.once('error', (e) => {
          console.error('[multipart] temp stream failed', e)
          failNow(500, '临时文件写入失败')
        })
      }
      c.stream.write(chunk)
    }

    const processBuf = (): void => {
      for (;;) {
        if (fatal) return
        if (state === 'preamble') {
          const idx = buf.indexOf(delim)
          if (idx === -1) {
            // 保留尾部：boundary 可能跨 chunk（旧实现直接清空会漏掉首个 boundary）
            buf = buf.length > delim.length + 4 ? buf.subarray(buf.length - (delim.length + 4)) : buf
            return
          }
          buf = buf.subarray(idx + delim.length)
          state = 'header'
          continue
        }
        if (state === 'header') {
          const idx = buf.indexOf(CRLFCRLF)
          if (idx === -1) {
            if (buf.length > 64 * 1024) { failNow(400, 'multipart header 过长'); return }
            return
          }
          const headerRaw = buf.subarray(0, idx).toString('utf-8')
          buf = buf.subarray(idx + 4)
          current = {
            fileName: parsePartFileName(headerRaw),
            savedName: '',
            size: 0,
            stream: null,
            path: null,
            temp: null,
          }
          state = 'body'
          continue
        }
        // state === 'body'
        const idx = buf.indexOf(delim)
        if (idx === -1) {
          const keep = delim.length + 4
          if (buf.length > keep) {
            const writable = buf.length - keep
            writeChunk(buf.subarray(0, writable))
            if (fatal) return
            buf = buf.subarray(writable)
          }
          return
        }
        let bodyEnd = idx
        if (bodyEnd >= 2 && buf[bodyEnd - 2] === 0x0d && buf[bodyEnd - 1] === 0x0a) bodyEnd -= 2
        writeChunk(buf.subarray(0, bodyEnd))
        if (fatal) return
        closeCurrent()
        buf = buf.subarray(idx + delim.length)
        if (buf[0] === 0x2d && buf[1] === 0x2d) { // '--' 结束标记
          ended = true
          tryFinish()
          return
        }
        if (buf[0] === 0x0d && buf[1] === 0x0a) {
          buf = buf.subarray(2)
          state = 'header'
          continue
        }
        failNow(400, 'multipart 格式错误')
        return
      }
    }

    req.on('data', (chunk: Buffer) => {
      if (fatal) return // overLimit / 已失败：继续消费但不解析
      buf = Buffer.concat([buf, chunk])
      try {
        processBuf()
      } catch (e) {
        failNow(400, e instanceof Error ? e.message : 'multipart 解析失败')
      }
    })
    req.on('end', () => {
      ended = true
      if (!fatal) {
        try { processBuf() } catch (e) {
          if (!fatal) fatal = new HttpError(400, e instanceof Error ? e.message : 'multipart 解析失败')
        }
      }
      if (!fatal) closeCurrent()
      tryFinish()
    })
    req.on('error', () => failNow(400, '上传中断'))
    req.on('aborted', () => failNow(400, '上传中断'))
    // 客户端提前断开（未正常 end）：必须结算，否则 handler 永久挂起且临时文件残留
    req.on('close', () => {
      if (!ended && !settled) failNow(400, '上传中断')
    })
  })

  return uploaded
}
