import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, RefreshCw, Check } from 'lucide-react'
import { genPassword } from '../../../lib/passwordGen'

/** 长度 → 强度档位（1 弱 / 2 中 / 3 强）：同一字符集下熵只由长度决定 */
function strengthOf(len: number): 1 | 2 | 3 {
  if (len >= 16) return 3
  if (len >= 12) return 2
  return 1
}

const STRENGTH_META = {
  1: { label: '较弱', color: 'var(--danger)' },
  2: { label: '中等', color: 'var(--warning)' },
  3: { label: '强', color: 'var(--success)' },
} as const

/**
 * 强密码生成器控件（v3.4.0 批次4 新写，原型 v15「wb-pwgen」形态）。
 * 生成框 + 长度滑条（8~32）+ 强度条；纯本地生成（lib/passwordGen 同款算法，
 * 与密码本 / 悬浮小密码本共用），不落盘、不进剪贴板除非用户点复制。
 */
export function PasswordWidget() {
  const [len, setLen] = useState(16)
  const [pwd, setPwd] = useState(() => genPassword(16))
  const [copied, setCopied] = useState(false)

  const regen = useCallback((n: number) => setPwd(genPassword(n)), [])
  const strength = useMemo(() => strengthOf(len), [len])
  const meta = STRENGTH_META[strength]

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pwd)
      setCopied(true)
    } catch { /* 剪贴板不可用时静默（密码仍在框内可手动复制） */ }
  }, [pwd])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2.5 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-relaxed text-[var(--text-primary)]" title="点击右侧按钮重新生成">{pwd}</code>
        <button
          onClick={() => regen(len)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          title="重新生成"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => void copy()}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors ${
            copied
              ? 'border-[var(--success)] bg-[var(--success)]/10 text-[var(--success)]'
              : 'border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
          }`}
          title={copied ? '已复制' : '复制到剪贴板'}
        >
          {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} />}
        </button>
      </div>

      <div className="flex items-center gap-2 px-0.5 text-[11px] text-[var(--text-muted)]">
        <span className="shrink-0">长度 {len}</span>
        <input
          type="range"
          min={8}
          max={32}
          value={len}
          onChange={(e) => {
            const n = Number(e.target.value)
            setLen(n)
            regen(n)
          }}
          className="min-w-0 flex-1 accent-[var(--accent)]"
          title="密码长度"
        />
        <span className="w-8 shrink-0 text-right tabular-nums" style={{ color: meta.color }}>{meta.label}</span>
      </div>

      <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${(strength / 3) * 100}%`, backgroundColor: meta.color }}
        />
      </div>
    </div>
  )
}
