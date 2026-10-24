import { clipboard } from 'electron'
import { parseFileNameWBuffer, parseUriList } from './clipboardFilesPure'

/**
 * 读系统剪贴板里的文件/目录绝对路径（主进程唯一入口）。
 *
 * 为什么不让渲染层继续用 `clipboardData.files`：焦点在非可编辑元素（文件树）时
 * Chromium 不派发 paste 事件，且右键菜单点击本身就是合成动作、没有事件可挂。
 * 解析细节与平台格式见 `clipboardFilesPure.ts` 头注释。
 *
 * 返回空数组 = 剪贴板里没有文件（纯文本 / 图片 / 空剪贴板都走这里）。
 * 路径**不做存在性校验** —— 落盘前由 `ws:pasteExternal` 逐条 lstat（不信任输入）。
 */
export function readClipboardFilePaths(): string[] {
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
