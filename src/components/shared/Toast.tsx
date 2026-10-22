import { useState, useEffect, useCallback, useRef } from 'react'
import { X, AlertCircle, AlertTriangle, Info, ExternalLink, CheckCircle2 } from 'lucide-react'
import type { ToastMessage } from '../../lib/toast'
import { navigateToHelp } from '../../modules/help'
import { prefersReducedMotion } from '../../lib/usePresence'

interface ActiveToast extends ToastMessage {
  progress: number   // 0..1, 1 = done
}

const EXIT_MS = 190

export function Toast() {
  const [toasts, setToasts] = useState<ActiveToast[]>([])
  // 正在播退场的 toast id（先播 kb-toast-out，再真正移除）
  const [leaving, setLeaving] = useState<string[]>([])
  // V-3：过期主驱动 = 每条 toast 一个独立 setTimeout（墙钟）。
  // 原实现靠 interval tick 累计 progress 判定过期——窗口最小化/被完全遮挡时渲染层定时器
  // 会被 Chromium intensive throttling 压到每分钟 1 tick，5s 的 toast 实际滞留数分钟。
  // setTimeout 被节流推迟后，窗口恢复可见会立即补触发，不会冻结。
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // 已进入退场的 id（ref 做幂等判定，state 只驱动渲染——
  //  放在 setState updater 里 setTimeout 会在 StrictMode 下被双调用）
  const leavingRef = useRef(new Set<string>())

  const remove = useCallback((id: string) => {
    const t = timers.current.get(id)
    if (t) { clearTimeout(t); timers.current.delete(id) }
    if (leavingRef.current.has(id)) return
    leavingRef.current.add(id)
    setLeaving(prev => [...prev, id])
    setTimeout(() => {
      leavingRef.current.delete(id)
      setLeaving(prev => prev.filter(x => x !== id))
      setToasts(prev => prev.filter(x => x.id !== id))
    }, prefersReducedMotion() ? 0 : EXIT_MS)
  }, [])

  // 登记过期闹钟（同 id 重复 show = 重置计时，与进度条重置语义一致）
  const arm = useCallback((msg: ToastMessage) => {
    const prev = timers.current.get(msg.id)
    if (prev) clearTimeout(prev)
    timers.current.set(msg.id, setTimeout(() => {
      timers.current.delete(msg.id)
      remove(msg.id)
    }, msg.duration ?? 5000))
  }, [remove])

  useEffect(() => () => {
    timers.current.forEach(t => clearTimeout(t))
    timers.current.clear()
  }, [])

  const onShow = useCallback((e: Event) => {
    const msg = (e as CustomEvent<ToastMessage>).detail
    // 同 id 再次出现（如显式传 id 的进度类提示）时取消退场，恢复到正常态
    if (leavingRef.current.has(msg.id)) {
      leavingRef.current.delete(msg.id)
      setLeaving(prev => prev.filter(x => x !== msg.id))
    }
    arm(msg)
    setToasts(prev => {
      // Same type+message: replace the existing toast, resetting its progress
      const existing = prev.find(t => t.type === msg.type && t.message === msg.message)
      if (existing) {
        return prev.map(t => t.id === existing.id ? { ...msg, progress: 0 } : t)
      }
      // Unique: add to stack
      return [...prev, { ...msg, progress: 0 }]
    })
  }, [arm])
  const onDismiss = useCallback((e: Event) => {
    const id = (e as CustomEvent<string>).detail
    remove(id)
  }, [remove])

  useEffect(() => {
    window.addEventListener('toast:show', onShow)
    window.addEventListener('toast:dismiss', onDismiss)
    return () => {
      window.removeEventListener('toast:show', onShow)
      window.removeEventListener('toast:dismiss', onDismiss)
    }
  }, [onShow, onDismiss])

  // Progress bar animation only（过期判定已由上方 setTimeout 主驱动）
  useEffect(() => {
    if (toasts.length === 0) return
    const tick = 50 // ms
    const timer = setInterval(() => {
      setToasts(prev =>
        prev.map(t => {
          const duration = t.duration ?? 5000
          const next = t.progress + tick / duration
          if (next >= 1) return t // 满格即停；移除由 setTimeout 负责
          return { ...t, progress: next }
        })
      )
    }, tick)
    return () => clearInterval(timer)
  }, [toasts.length, remove])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 z-[100] flex flex-col gap-3 pointer-events-none" style={{ right: 'calc(1rem + var(--kb-toast-right, 0px))' }}>
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} closing={leaving.includes(t.id)} onDismiss={remove} />
      ))}
    </div>
  )
}

function ToastItem({ toast: t, closing = false, onDismiss }: { toast: ActiveToast; closing?: boolean; onDismiss: (id: string) => void }) {
  const Icon = t.type === 'error' ? AlertCircle : t.type === 'warning' ? AlertTriangle : t.type === 'success' ? CheckCircle2 : Info
  const iconColor = t.type === 'error' ? 'text-[#f14c4c]' : t.type === 'warning' ? 'text-[#cca700]' : t.type === 'success' ? 'text-emerald-400' : 'text-[var(--accent)]'
  const borderColor = t.type === 'error' ? 'border-[#f14c4c]' : t.type === 'warning' ? 'border-[#cca700]' : t.type === 'success' ? 'border-emerald-400' : 'border-[var(--accent)]'

  const handleDetail = () => {
    if (t.detail) {
      navigateToHelp(t.detail)
    }
    onDismiss(t.id)
  }

  return (
    <div
      className={`pointer-events-auto bg-[var(--bg-secondary)] border ${borderColor} border-l-[3px] rounded-lg shadow-2xl w-[380px] overflow-hidden ${closing ? 'kb-toast-out' : 'kb-toast-in'}`}
    >
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <Icon size={16} className={`shrink-0 mt-0.5 ${iconColor}`} />

        <div className="flex-1 min-w-0">
          <p className="text-[13px] text-[var(--text-primary)] leading-relaxed">{t.message}</p>

          {(t.detail || t.type === 'error' || t.action) && (
            <div className="flex items-center gap-2 mt-2">
              {t.action && (
                <button
                  onClick={() => { t.action!.onClick(); onDismiss(t.id) }}
                  className="text-[11px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                >
                  {t.action.label}
                </button>
              )}
              {t.detail && (
                <button
                  onClick={handleDetail}
                  className="flex items-center gap-1 text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                >
                  <ExternalLink size={10} />
                  查看详情
                </button>
              )}
            </div>
          )}
        </div>

        <button
          onClick={() => onDismiss(t.id)}
          className="p-0.5 rounded hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-[3px] bg-[var(--bg-tertiary)]">
        <div
          className={`h-full transition-all ease-linear ${t.progress >= 1 ? 'bg-transparent' : 'bg-[var(--accent)]'}`}
          style={{ width: `${Math.min(t.progress * 100, 100)}%` }}
        />
      </div>
    </div>
  )
}
