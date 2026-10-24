import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 系统剪贴板「文件列表」的纯解析层（无 electron 依赖，契约脚本可直接 import）。
 *
 * 为什么需要它（2026-10-20 修「右键粘贴 / Ctrl+V 粘不进来文件」）：
 *   旧实现只认渲染层 `paste` 事件的 `clipboardData.files` + `webUtils.getPathForFile`。
 *   那条路在 Linux 上有两个断点：
 *     ① 焦点在文件树（非可编辑元素）时，Chromium **根本不派发 paste 事件**（本机 X11 实测：
 *        textarea 聚焦时有事件、div 聚焦时 window/元素都收不到），于是 Ctrl+V 静默失效；
 *     ② 即便有事件，路径也只能从 DOM 的 File 对象取 —— 菜单点击是合成动作，压根没有事件。
 *   改为由主进程直接读剪贴板里的文件 URI 列表（Linux 的 `text/uri-list` /
 *   `x-special/gnome-copied-files`、Windows 的 `FileNameW`），这里只做纯字符串解析。
 */

/** 去重且保持原顺序（同一路径重复出现只落一次） */
function uniq(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of list) {
    if (seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/**
 * 解析 `text/uri-list`（RFC 2483）与 GNOME 的 `x-special/gnome-copied-files`。
 *
 * 两者都是「每行一个 URI」，后者首行是 `copy` / `cut` 动作 —— 首行不是 file URI，
 * 解析失败即被丢弃，因此同一个函数可以吃两种格式。`file://host/path`（非本机 host）
 * 由 `fileURLToPath` 抛错拒绝，避免把网络共享路径当本地文件。
 */
export function parseUriList(raw: string): string[] {
  if (typeof raw !== 'string' || !raw) return []
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    // 空行与 RFC 2483 的注释行
    if (!text || text.startsWith('#')) continue
    if (/^file:/i.test(text)) {
      try {
        out.push(fileURLToPath(new URL(text)))
      } catch {
        // 非法 URI / 非本机 host：跳过这一条，不影响其余条目
      }
      continue
    }
    // 容忍个别文件管理器直接给绝对路径（不是标准 URI 列表，但语义明确）
    if (isAbsolute(text)) out.push(text)
  }
  return uniq(out)
}

/**
 * 解析 Windows 剪贴板 `FileNameW`（CF_HDROP 的宽字符路径列表）。
 *
 * 载荷有两种实测形态：标准 CF_HDROP（前 20 字节是 DROPFILES 头，偏移 0 处 `pFiles`
 * 指向路径列表）与裸的 UTF-16LE 双空结尾列表（Electron readBuffer 旧实现在部分版本
 * 上给的就是这种）。这里按「偏移是否落在缓冲区内」判别，两种都吃。
 */
export function parseFileNameWBuffer(buf: Buffer | Uint8Array | null | undefined): string[] {
  if (!buf || buf.length < 2) return []
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  let offset = 0
  if (bytes.length >= 20) {
    const pFiles = bytes.readUInt32LE(0)
    if (pFiles >= 20 && pFiles < bytes.length && pFiles % 2 === 0) offset = pFiles
  }
  const paths = bytes
    .subarray(offset)
    .toString('utf16le')
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isAbsolute(s))
  return uniq(paths)
}
