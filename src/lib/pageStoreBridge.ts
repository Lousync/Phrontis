import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { pageStoreRead, pageStoreWrite } from './ipc'
import { useDataChanged } from './dataChanged'
import { showToast } from './toast'

/**
 * 页面数据桥的**宿主侧**（docs/html-page-store.md）。
 *
 * 链路：沙箱页面 `window.KbStore` → postMessage → 本 hook → `pageStore:read/write` IPC →
 * 主进程 `lib/pageStore.ts`（路径/大小/JSON/冲突校验 + 原子写 + 广播）。
 *
 * 三个必须做对的细节：
 * 1. **只采信本 iframe 的消息**（`e.source === contentWindow`）—— 不透明源没有 origin 可比，
 *    来源校验只能靠 contentWindow 引用（与欢迎页 / 工件栏推主题同一口径）。
 * 2. **按 `nonce:id` 去重**：桥在宿主监听器挂上之前会重发同一条消息（否则首帧必然丢），
 *    这里必须把同一条请求的回复重放而不是重复执行——否则「自动保存」会写两次。
 *    nonce 是每次文档加载新生成的，`key={src}` 重挂 iframe 后 id 会从 1 重来，
 *    用 nonce 前缀才能区分「新文档的第 1 条」和「旧文档的第 1 条」。
 * 3. **写盘后广播会把变更推回给写入者自己**：这里只转发事件，页面侧比对 rev 自行忽略回声
 *    （见 kbVisualProtocol.ts 的 PAGE_STORE_SCRIPT）。
 */

interface PageStoreMessage {
  nonce?: unknown
  id?: unknown
  op?: unknown
  rel?: unknown
  data?: unknown
  expectedRev?: unknown
}

/** 一次会话里每对 (页面, 数据文件) 只提示一次，避免每次打开都弹 */
const NOTIFIED = new Set<string>()

export function usePageStoreBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  htmlRel?: string,
): void {
  /** 已处理过的请求（nonce:id → 回复），用于重发去重 */
  const replies = useRef(new Map<string, unknown>())

  useEffect(() => {
    replies.current.clear()

    const onMsg = (e: MessageEvent): void => {
      const win = frameRef.current?.contentWindow
      if (!win || e.source !== win) return
      const msg = (e.data as { __kbPageStore?: PageStoreMessage } | null)?.__kbPageStore
      if (!msg || typeof msg !== 'object') return

      const id = Number(msg.id) || 0
      const key = `${typeof msg.nonce === 'string' ? msg.nonce : ''}:${id}`
      const cached = replies.current.get(key)
      if (cached) { try { win.postMessage(cached, '*') } catch { /* 帧已卸载 */ } return }

      const rel = typeof msg.rel === 'string' ? msg.rel : ''
      const op = msg.op === 'write' ? 'write' : 'read'
      const expectedRev = typeof msg.expectedRev === 'string' ? msg.expectedRev : undefined

      const reply = (payload: unknown): void => {
        const wrapped = { __kbPageStoreReply: { id, ...(payload as object) } }
        replies.current.set(key, wrapped)
        if (replies.current.size > 64) {
          const oldest = replies.current.keys().next().value
          if (oldest !== undefined) replies.current.delete(oldest)
        }
        try { win.postMessage(wrapped, '*') } catch { /* 帧已卸载 */ }
      }

      const p = op === 'write'
        ? pageStoreWrite(rel, msg.data, expectedRev)
        : pageStoreRead(rel)

      void p.then(result => {
        reply(result)
        if (result.ok) {
          const noticeKey = `${htmlRel ?? ''}::${rel}`
          if (!NOTIFIED.has(noticeKey)) {
            NOTIFIED.add(noticeKey)
            showToast({
              type: 'info',
              message: '页面已连接数据文件',
              detail: rel,
            })
          }
        }
      }).catch((err: unknown) => {
        reply({ ok: false, error: String((err as Error)?.message ?? err) })
      })
    }

    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [frameRef, htmlRel])

  // AI 工具 / 另一个页面写完 → 主进程广播 → 通知帧内页面重读（页面比对 rev 忽略自己的回声）
  useDataChanged('pagesdata', () => {
    try {
      frameRef.current?.contentWindow?.postMessage({ __kbPageStoreChanged: { at: Date.now() } }, '*')
    } catch { /* 帧已卸载 */ }
  })
}
