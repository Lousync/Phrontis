export interface ToastMessage {
  id: string
  type: 'error' | 'warning' | 'info' | 'success'
  message: string
  detail?: string   // help section id: 'shortcuts' | 'editor' | etc.
  duration?: number // ms, default 5000
  /** 可选动作按钮（如「撤销」）；点击后自动关闭该 toast */
  action?: { label: string; onClick: () => void }
}

export function showToast(msg: Omit<ToastMessage, 'id'> & { id?: string }): string {
  const id = msg.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  window.dispatchEvent(new CustomEvent('toast:show', {
    detail: { ...msg, id } as ToastMessage,
  }))
  return id
}

