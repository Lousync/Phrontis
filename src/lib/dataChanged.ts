import { useEffect, useRef } from 'react'

/**
 * 跨窗口数据同步（轻量事件总线）
 *
 * - 写操作完成后的窗口调用 notifyDataChanged(scope)
 *   → 本窗口派发 window 事件 + 经主进程 data:notify 转发给其它窗口
 * - 任意窗口用 useDataChanged(scope, cb) 监听并重新拉取数据
 *
 * 主进程侧（dayPanelWindow.ts）：data:notify → 向除发送方外的所有窗口
 * webContents.send('kb:data-changed', payload)，preload 转为本地 window 事件。
 */

export type DataChangeScope = 'schedule' | 'habit' | 'settings' | 'bookmark' | 'passwords' | 'blog' | 'knowledge' | 'quiz' | 'pdfReader' | 'readerState' | 'excerpt'

/** 本窗口数据变更后调用：本地广播 + 通知主进程转发给其它窗口 */
export function notifyDataChanged(scope: DataChangeScope): void {
  try { window.dispatchEvent(new CustomEvent('kb:data-changed', { detail: { scope } })) } catch { /* ignore */ }
  try { window.api?.dataNotify?.({ scope }) } catch { /* ignore */ }
}

/** 监听跨窗口数据变更（含本窗口 notifyDataChanged 的本地广播），scope 匹配才触发 cb */
export function useDataChanged(scope: DataChangeScope, cb: () => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const handle = (detail?: { scope?: string }) => {
      if (!detail || !detail.scope || detail.scope === scope) ref.current()
    }
    const offPush = window.api?.onDataChanged?.((p) => handle(p))
    const local = (e: Event) => handle((e as CustomEvent).detail as { scope?: string } | undefined)
    window.addEventListener('kb:data-changed', local)
    return () => {
      window.removeEventListener('kb:data-changed', local)
      offPush?.()
    }
  }, [scope])
}
