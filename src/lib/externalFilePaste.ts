import type { WorkspacePasteResult } from '../types'
import { readClipboardFilePaths, workspacePasteExternal } from './ipc'
import { isEditingInput } from './shortcuts'

/**
 * 文件树「粘贴系统剪贴板里的文件」的共享入口（2026-10-20 修）。
 *
 * 旧链路（v3.2.0）是「渲染层 paste 事件 + clipboardData.files + webUtils.getPathForFile」，
 * 在 Linux 上有两个断点（本机 X11 实测）：
 *   ① 焦点在文件树（div，非可编辑元素）时 Chromium **不派发 paste 事件** —— Ctrl+V 静默失效；
 *   ② 右键菜单点击是合成动作，没有事件；`webContents.paste()` 同样因 ① 落不到任何 handler。
 * 现在统一改成「主进程直接读剪贴板文件 URI 列表 → ws:pasteExternal」，键盘与菜单共用一条路。
 */

/** Ctrl/Cmd+V（排除 Shift/Alt 组合），且焦点不在可编辑元素里 —— 编辑器/输入框的粘贴不抢 */
export function isExternalPasteGesture(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false
  if (e.key !== 'v' && e.key !== 'V') return false
  return !isEditingInput(e)
}

/**
 * 元素当前是否真的可见。模块 Tab 首挂后靠 `display:none` 保活 —— 不可见的树不能抢 window
 * 级快捷键（知识库树与工作台树可能同时挂载，只有看得见的那棵该处理粘贴）。
 */
export function isElementVisible(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && el.offsetParent !== null
}

/**
 * 读系统剪贴板里的文件并贴到 relDir。
 * 返回 null = 剪贴板里没有文件（调用方据此决定是否提示）；落盘结果原样返回。
 */
export async function pasteClipboardFiles(rootId: string, relDir: string): Promise<WorkspacePasteResult | null> {
  const paths = await readClipboardFilePaths().catch(() => [] as string[])
  if (paths.length === 0) return null
  return workspacePasteExternal(rootId, relDir, paths).catch((): WorkspacePasteResult => ({
    ok: false,
    reason: 'error',
    error: '无法读取剪贴板',
    pasted: [],
    skipped: [],
  }))
}

/** 把落盘结果翻成一条 Toast（成功 / 部分跳过 / 全失败都带得动具体原因） */
export function describePasteResult(res: WorkspacePasteResult): {
  type: 'success' | 'warning' | 'error'
  message: string
} {
  if (res.pasted.length === 0) {
    return {
      type: res.reason === 'empty' ? 'warning' : 'error',
      message: res.reason === 'empty'
        ? '剪贴板里没有可粘贴的文件'
        : `粘贴失败：${res.error || res.skipped[0]?.reason || '未知原因'}`,
    }
  }
  const skippedNote = res.skipped.length > 0 ? `，已跳过 ${res.skipped.length} 项` : ''
  const subject = res.pasted.length === 1 ? `「${res.pasted[0]}」` : `${res.pasted.length} 项`
  return {
    type: res.skipped.length > 0 ? 'warning' : 'success',
    message: `已粘贴${subject}${skippedNote}`,
  }
}
