/**
 * 文本文件编码 / 换行保真（纯函数）—— P0-A §3.2。
 *
 * 为什么必须做：`writeWorkspaceFile` 一律按 UTF-8 写，于是
 *  · 带 BOM 的 UTF-8 文件写一次就没 BOM；
 *  · Windows 的 `.bat` / `.cmd` 写一次变成 LF，cmd.exe 直接读串行；
 *  · UTF-16 文件被读成乱码再写回，等于静默毁文件。
 * 规则（拍板）：**只自动处理「严格 UTF-8」与「带 BOM 的 UTF-8 / UTF-16」**，
 * 其余编码（典型 GBK）必须由调用方显式给 `encoding`，检测不了就拒写、不猜。
 *
 * 契约脚本：`.AGENT/scripts/ai-harness/verify-text-codec.mjs`（零依赖，直接 import）。
 */

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk'

export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'unknown' | 'binary'

export type Eol = '\n' | '\r\n'

export interface DecodeOk {
  ok: true
  text: string
  /** 实际解码方式（写入时按它回写） */
  encoding: TextEncoding
  /** 原文是否带 BOM（UTF-16 恒为 true） */
  bom: boolean
  /** 主换行符；混合时取多数（没有换行时为 '\n'） */
  eol: Eol
  /** 换行符混用（写入时会统一成 eol） */
  mixedEol: boolean
}

export interface DecodeErr {
  ok: false
  error: string
  /** 探测到但未自动处理的编码（提示模型显式传 encoding） */
  detected?: DetectedEncoding
}

export type DecodeResult = DecodeOk | DecodeErr

const BOM_UTF8 = [0xef, 0xbb, 0xbf]
const BOM_UTF16LE = [0xff, 0xfe]
const BOM_UTF16BE = [0xfe, 0xff]

function startsWithBytes(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false
  return true
}

/** 前 512 字节含 NUL → 视为二进制（与 workspaceManager.detectBinary 同口径的简化版） */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 512)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 严格 UTF-8 校验：非法序列返回 false（不抛） */
export function isValidUtf8(buf: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/**
 * 编码探测（不做解码）。顺序：BOM → 严格 UTF-8 → 其它。
 * 注意：UTF-16 无 BOM 时在 UTF-8 视角里通常含 NUL → 判 binary，不猜。
 */
export function detectEncoding(buf: Uint8Array): DetectedEncoding {
  if (startsWithBytes(buf, BOM_UTF8)) return 'utf-8-bom'
  if (startsWithBytes(buf, BOM_UTF16LE)) return 'utf-16le'
  if (startsWithBytes(buf, BOM_UTF16BE)) return 'utf-16be'
  if (looksBinary(buf)) return 'binary'
  if (buf.length === 0) return 'utf-8'
  return isValidUtf8(buf) ? 'utf-8' : 'unknown'
}

/**
 * UTF-16BE → LE 的字节对调（Node 的 TextDecoder 支持 utf-16be 解码，
 * 但 Buffer 写入只有 utf16le；编码侧在这里换序）。
 */
export function swapBytes(buf: Uint8Array): Uint8Array {
  const out = new Uint8Array(buf.length - (buf.length % 2))
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1]
    out[i + 1] = buf[i]
  }
  return out
}

/** 主换行符判定（CRLF 数 ≥ LF 数的一半以上即视为 CRLF 文件） */
export function detectEol(text: string): { eol: Eol; mixed: boolean } {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  const eol: Eol = crlf > lf ? '\r\n' : '\n'
  return { eol, mixed: crlf > 0 && lf > 0 }
}

/** 统一换行符（先归一成 LF 再展开，避免 CRLF 变 CRCRLF） */
export function normalizeEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n')
}

export interface DecodeOptions {
  /** 显式编码（模型在非 UTF-8 文件上必须给） */
  encoding?: TextEncoding
  /** 已知 BOM 偏好（新建文件时用） */
  bom?: boolean
}

/**
 * 解码。`encoding` 显式给出时优先（GBK 读入会标记 `bom:false`，回写需再次显式给 encoding）。
 * 未给 encoding 时只自动处理 UTF-8 家族与带 BOM 的 UTF-16。
 */
export function decodeTextFile(buf: Uint8Array, opts: DecodeOptions = {}): DecodeResult {
  const explicit = opts.encoding
  if (explicit) {
    try {
      if (explicit === 'utf-16be') {
        const body = startsWithBytes(buf, BOM_UTF16BE) ? buf.subarray(2) : buf
        const text = new TextDecoder('utf-16be', { fatal: false }).decode(body)
        const { eol, mixed } = detectEol(text)
        return { ok: true, text, encoding: 'utf-16be', bom: true, eol, mixedEol: mixed }
      }
      if (explicit === 'utf-16le') {
        const body = startsWithBytes(buf, BOM_UTF16LE) ? buf.subarray(2) : buf
        const text = new TextDecoder('utf-16le', { fatal: false }).decode(body)
        const { eol, mixed } = detectEol(text)
        return { ok: true, text, encoding: 'utf-16le', bom: true, eol, mixedEol: mixed }
      }
      const decoder = new TextDecoder(explicit === 'gbk' ? 'gbk' : 'utf-8', { fatal: explicit !== 'gbk' })
      const text = decoder.decode(buf)
      const { eol, mixed } = detectEol(text)
      return { ok: true, text, encoding: explicit, bom: false, eol, mixedEol: mixed }
    } catch {
      return { ok: false, error: `按 ${explicit} 解码失败（文件可能不是该编码）`, detected: detectEncoding(buf) }
    }
  }

  const detected = detectEncoding(buf)
  switch (detected) {
    case 'binary':
      return { ok: false, error: '检测到二进制内容（含 NUL 字节），AI 只处理文本文件', detected }
    case 'unknown':
      return {
        ok: false,
        error: '文件不是 UTF-8 编码（可能是 GBK / GB18030 等）：请在入参显式传 encoding（如 "gbk"）后再读写，工具不会猜编码',
        detected,
      }
    case 'utf-16le':
    case 'utf-16be': {
      const body = buf.subarray(2)
      const text = new TextDecoder(detected === 'utf-16be' ? 'utf-16be' : 'utf-16le').decode(body)
      const { eol, mixed } = detectEol(text)
      return { ok: true, text, encoding: detected, bom: true, eol, mixedEol: mixed }
    }
    case 'utf-8-bom': {
      const text = new TextDecoder('utf-8').decode(buf.subarray(3))
      const { eol, mixed } = detectEol(text)
      return { ok: true, text, encoding: 'utf-8', bom: true, eol, mixedEol: mixed }
    }
    default: {
      const text = new TextDecoder('utf-8').decode(buf)
      const { eol, mixed } = detectEol(text)
      return { ok: true, text, encoding: 'utf-8', bom: false, eol, mixedEol: mixed }
    }
  }
}

export interface EncodeOptions {
  encoding?: TextEncoding
  bom?: boolean
  /** 目标换行符；缺省 = 沿用文本自身（CRLF 文件不会被静默改成 LF） */
  eol?: Eol
  /** 强制 CRLF（.bat / .cmd 用：cmd.exe 对 LF 解析会读串行） */
  forceCrlf?: boolean
  /** 仓库相对路径（判 .bat/.cmd） */
  relPath?: string
}

export function isCrlfForcedPath(relPath: string): boolean {
  return /\.(bat|cmd)$/i.test(String(relPath ?? ''))
}

export interface EncodeErr { ok: false; error: string }
export interface EncodeOk { ok: true; buffer: Uint8Array; encoding: TextEncoding; bom: boolean; eol: Eol }
export type EncodeResult = EncodeOk | EncodeErr

/** 编码回写。GBK 无内置编码器 → 明确拒绝（读可以，写不行），不做有损转换 */
export function encodeTextFile(text: string, opts: EncodeOptions = {}): EncodeResult {
  const encoding: TextEncoding = opts.encoding ?? 'utf-8'
  if (encoding === 'gbk') {
    return { ok: false, error: 'GBK 文件可以读，但当前版本不支持写回 GBK；请先转换为 UTF-8 再修改（不会做有损转码）' }
  }
  const forceCrlf = opts.forceCrlf ?? isCrlfForcedPath(opts.relPath ?? '')
  // 缺省 eol：**沿用文本自身的换行**（编辑器保存 / 插件写入都走本函数，
  // 一律归成 LF 会把 CRLF 文件静默改坏；显式给 eol 时才统一）
  const eol: Eol = forceCrlf ? '\r\n' : (opts.eol ?? detectEol(text).eol)
  const normalized = normalizeEol(text, eol)
  const body = normalized

  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const le = new Uint8Array(body.length * 2)
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i)
      le[i * 2] = code & 0xff
      le[i * 2 + 1] = (code >> 8) & 0xff
    }
    const bomBytes = encoding === 'utf-16le' ? BOM_UTF16LE : BOM_UTF16BE
    const payload = encoding === 'utf-16le' ? le : swapBytes(le)
    const out = new Uint8Array(2 + payload.length)
    out[0] = bomBytes[0]
    out[1] = bomBytes[1]
    out.set(payload, 2)
    return { ok: true, buffer: out, encoding, bom: true, eol }
  }

  const utf8 = new TextEncoder().encode(body)
  const wantBom = opts.bom === true
  const out = new Uint8Array((wantBom ? 3 : 0) + utf8.length)
  if (wantBom) out.set(BOM_UTF8, 0)
  out.set(utf8, wantBom ? 3 : 0)
  return { ok: true, buffer: out, encoding: 'utf-8', bom: wantBom, eol }
}

/** 从解码结果派生「写回同一文件」的编码参数 */
export function codecOfDecoded(d: DecodeOk): { encoding: TextEncoding; bom: boolean; eol: Eol } {
  return { encoding: d.encoding, bom: d.bom, eol: d.eol }
}
