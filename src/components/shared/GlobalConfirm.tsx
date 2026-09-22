import { useEffect, useState } from 'react'
import { setGlobalConfirmHandler, type GlobalConfirmOptions, type GlobalConfirmResult } from '../../lib/globalConfirm'
import { usePresence } from '../../lib/usePresence'

/**
 * 全局确认框宿主（App 根部唯一挂载）。showGlobalConfirm() 的渲染端：
 * 样式对齐 ConfirmDialog，无「不再提示」勾选（一次性决策场景）。
 * opts.extraLabel 提供时渲染第三个中性按钮，resolve('extra')（A2 三键语义）。
 */
export function GlobalConfirm() {
  const [req, setReq] = useState<{ opts: GlobalConfirmOptions; resolve: (result: GlobalConfirmResult) => void } | null>(null)
  // visible 与 req 分离：req 保留整个退场过程（否则关掉瞬间就没内容可渲染），
  // visible 只驱动存在性，由 usePresence 决定何时真正卸载。
  const [visible, setVisible] = useState(false)
  const { mounted, closing } = usePresence(visible, 170)

  useEffect(() => {
    setGlobalConfirmHandler((opts, resolve) => {
      setReq({ opts, resolve })
      setVisible(true)
    })
    return () => setGlobalConfirmHandler(null)
  }, [])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, req])

  if (!mounted || !req) return null
  const { opts, resolve } = req
  /** 立即结算（调用方的 promise 不等动画），视觉上继续播完退场 */
  const close = (ok: GlobalConfirmResult): void => {
    setVisible(false)
    resolve(ok)
  }
  return (
    <div
      data-wb="globalConfirm"
      className={`fixed inset-0 z-[300] flex items-center justify-center bg-black/50 ${closing ? 'kb-overlay-out' : 'kb-overlay'}`}
      onClick={() => close(false)}
    >
      <div
        className={`bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-[420px] shadow-2xl ${closing ? 'kb-modal-out' : 'kb-modal-in'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-color)]">
          <h3 data-wb="globalConfirmTitle" className="text-[14px] font-medium text-[var(--text-primary)]">{opts.title}</h3>
        </div>
        <div className="px-5 py-4">
          <p data-wb="globalConfirmMsg" className="text-[13px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap">{opts.message}</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--border-color)]">
          <button
            data-wb="globalConfirmCancel"
            onClick={() => close(false)}
            className="px-4 py-1.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            {opts.cancelLabel ?? '取消'}
          </button>
          {opts.extraLabel && (
            <button
              data-wb="globalConfirmExtra"
              onClick={() => close('extra')}
              className="px-4 py-1.5 text-[13px] text-[var(--text-primary)] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] transition-colors"
            >
              {opts.extraLabel}
            </button>
          )}
          <button
            data-wb="globalConfirmOk"
            autoFocus
            onClick={() => close(true)}
            className={
              opts.variant === 'danger'
                ? 'px-4 py-1.5 text-[13px] bg-[var(--danger)] text-white rounded hover:bg-[#d01020] transition-colors'
                : 'px-4 py-1.5 text-[13px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] transition-colors'
            }
          >
            {opts.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
