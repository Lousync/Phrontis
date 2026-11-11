import { clipboard } from 'electron'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildFileNameWBuffer,
  buildNSFilenamesPlist,
  buildUriList,
  parseFileNameWBuffer,
  parseUriList,
} from './clipboardFilesPure'

/**
 * 系统剪贴板 + 应用内文件剪贴板（主进程唯一入口）。
 *
 * 为什么不让渲染层继续用 `clipboardData.files`：焦点在非可编辑元素（文件树）时
 * Chromium 不派发 paste 事件，且右键菜单点击本身就是合成动作、没有事件可挂。
 * 解析细节与平台格式见 `clipboardFilesPure.ts` 头注释。
 *
 * 2026-11-09（B-51）：新增**应用内文件剪贴板**。此前 AI 教学树的「复制」只写组件
 * 本地 state，工作台/笔记区粘贴读系统剪贴板 → 永远读不到。现在复制时主进程同时：
 *   ① 把绝对路径记在应用内（渲染层仍只传 { rootId, relPath }，不接触绝对路径）；
 *   ② 尽力写系统剪贴板（`_writeFilesForTesting` 是 Electron 33 内部 API，写真正的
 *      CF_HDROP / NSFilenamesPboardType / text/uri-list，外部程序可直接粘贴）。
 * 粘贴优先用应用内那份（跨平台、跨模块稳定），再用系统剪贴板做失效判定与外部来源兜底。
 */

/**
 * 应用内文件剪贴板：只存**绝对路径**，且只在主进程内存里。
 * 渲染层不知道这些路径 —— 复制走 `ws:copyPathsToClipboard`，粘贴仍走
 * `clipboard:readFilePaths` → `ws:pasteExternal` 的既有链路。
 */
let appFileClipboard: string[] | null = null

/** 两个路径列表是否指向同一组文件（顺序无关；粘贴语义不关心顺序） */
function samePathSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((p, i) => p === sb[i])
}

/** 当前系统剪贴板是否仍是「文件」类格式（用于判断应用内那份有没有被外部覆盖） */
function hasOsFileFormat(): boolean {
  try {
    return clipboard.availableFormats().some((f) => /text\/uri-list|nsfilenamespboardtype|public\.file-url/i.test(f))
  } catch {
    return false
  }
}

/** 只读系统剪贴板里的文件/目录绝对路径（空数组 = 不是文件剪贴板） */
function readOsClipboardFilePaths(): string[] {
  // ① URI 列表：Linux 的 Nautilus / Dolphin / Thunar 都提供 text/uri-list；
  //    GNOME 另有一套 x-special/gnome-copied-files（首行 copy/cut）。macOS 的 Finder
  //    在 Electron 里偶尔也能经 text/uri-list 读到，Windows 某些复制源同理 —— 放最前试。
  for (const format of ['text/uri-list', 'x-special/gnome-copied-files']) {
    try {
      const raw = clipboard.readBuffer(format)
      if (!raw || raw.length === 0) continue
      const paths = parseUriList(raw.toString('utf8'))
      if (paths.length > 0) return paths
    } catch {
      // 该格式不存在 / 剪贴板所有者已退出：继续试下一种
    }
  }

  // ② Windows：资源管理器复制文件 = CF_HDROP（FileNameW 宽字符双空列表）
  if (process.platform === 'win32') {
    try {
      const paths = parseFileNameWBuffer(clipboard.readBuffer('FileNameW'))
      if (paths.length > 0) return paths
    } catch { /* 剪贴板不是文件 */ }
  }

  // ③ macOS：Finder 的文件 URL 单值格式
  if (process.platform === 'darwin') {
    try {
      const text = clipboard.read('public.file-url')
      const paths = parseUriList(text)
      if (paths.length > 0) return paths
    } catch { /* 剪贴板不是文件 */ }
  }

  return []
}

/**
 * 写应用内 + 系统文件剪贴板。返回 true 表示**应用内**复制成功（跨模块粘贴必成）；
 * 系统剪贴板写入是尽力而为，失败不影响应用内粘贴。
 *
 * 优先用 Electron 的 `_writeFilesForTesting`（内部 API，但写的是各平台原生文件格式：
 * Windows CF_HDROP / macOS NSFilenamesPboardType / Linux text/uri-list）。它不可用时按平台
 * 回落到 `writeBuffer` —— Windows 的 `FileNameW` 兼容格式至少保证本应用能读回。
 */
export function writeClipboardFilePaths(paths: string[]): boolean {
  const unique = Array.from(new Set(
    paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && isAbsolute(p)),
  ))
  if (unique.length === 0) return false

  appFileClipboard = unique

  try {
    const writer = clipboard as typeof clipboard & { _writeFilesForTesting?: (files: string[]) => void }
    if (typeof writer._writeFilesForTesting === 'function') {
      writer._writeFilesForTesting(unique)
      return true
    }

    if (process.platform === 'win32') {
      clipboard.writeBuffer('FileNameW', buildFileNameWBuffer(unique))
      return true
    }
    if (process.platform === 'darwin') {
      if (unique.length === 1) {
        clipboard.writeBuffer('public.file-url', Buffer.from(pathToFileURL(unique[0]).href, 'utf8'))
      } else {
        clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(buildNSFilenamesPlist(unique), 'utf8'))
      }
      return true
    }
    clipboard.writeBuffer('text/uri-list', Buffer.from(buildUriList(unique), 'utf8'))
    return true
  } catch {
    // 应用内已记下，系统剪贴板写失败只影响「复制到其它程序」
    return true
  }
}

/**
 * 读「可粘贴的文件路径」：应用内文件剪贴板优先，系统剪贴板做失效判定与外部来源兜底。
 *
 * 失效判定（防止应用内那份压过用户后来在资源管理器里复制的新文件）：
 * - 系统剪贴板能读到文件列表且与应用内不同 → 用户后来复制了别的，丢弃应用内那份；
 * - 系统剪贴板已不是文件格式（复制了文本/图片/清空）→ 同样丢弃；
 * - 读到的是同一组文件，或系统剪贴板有文件格式但本应用读不回（Windows CF_HDROP 的
 *   内部 API 写入形态）→ 继续用应用内那份。
 */
export function readClipboardFilePaths(): string[] {
  const osPaths = readOsClipboardFilePaths()

  if (appFileClipboard && appFileClipboard.length > 0) {
    if (osPaths.length > 0) {
      if (samePathSet(osPaths, appFileClipboard)) return appFileClipboard
      appFileClipboard = null
      return osPaths
    }

    let osText = ''
    try { osText = clipboard.readText() } catch { /* 剪贴板忙：按仍是文件处理 */ }
    if (hasOsFileFormat() && !osText) return appFileClipboard

    appFileClipboard = null
    return []
  }

  return osPaths
}
