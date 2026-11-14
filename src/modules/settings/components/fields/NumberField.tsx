import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'

/**
 * NumberField —— 数值混合输入（设计文档 §6.4 / D7）
 * 数字直输 + 步进 ± + 快捷预设 chips + 单位；输入即生效（~300ms 防抖）；
 * 越界红边提示、不写入、失焦回滚到最近合法值。
 */
export interface NumberFieldProps {
  value: number
  onCommit: (v: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  presets?: number[]
  /** 显示"还原默认"按钮并还原到该值（不传则不显示） */
  defaultValue?: number
  /** 预设 chips 是否显示（默认 true，可关掉只留纯数字输入） */
  showPresets?: boolean
  className?: string
}

export function NumberField({
  value, onCommit, min, max, step = 1, unit, presets, defaultValue, showPresets = true, className = '',
}: NumberFieldProps) {
  const [text, setText] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => { setText(String(value)); setInvalid(false) }, [value])
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const inRange = (n: number) =>
    Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)

  const commit = (n: number) => {
    if (inRange(n)) { onCommit(n); setInvalid(false) }
    else { setInvalid(true) }
  }
  const commitText = (raw: string) => {
    const n = Number(raw.trim())
    if (raw.trim() === '' || Number.isNaN(n)) { setInvalid(true); return }
    commit(n)
  }
  const queueCommit = (raw: string) => {
    if (timer.current) window.clearTimeout(timer.current)
    const n = Number(raw.trim())
    setInvalid(raw.trim() !== '' && !inRange(n))
    if (raw.trim() === '' || Number.isNaN(n)) return
    timer.current = window.setTimeout(() => commit(n), 300)
  }
  const bounce = (dir: 1 | -1) => {
    const next = value + dir * step
    const clamped = Math.min(max ?? next, Math.max(min ?? next, next))
    if (inRange(clamped)) onCommit(clamped)
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <div className={`flex items-center rounded border transition-colors ${
          invalid ? 'border-[var(--danger)] bg-[var(--danger)]/5' : 'border-[var(--border-color)] focus-within:border-[var(--accent)]'
        } bg-[var(--input-bg)]`}>
          <button
            type="button"
            onClick={() => bounce(-1)}
            className="px-1.5 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            data-tip="减小" aria-label="减小"
          >
            <Minus size={12} />
          </button>
          <input
            type="text"
            inputMode="decimal"
            value={text}
            onChange={e => { setText(e.target.value); queueCommit(e.target.value) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { commitText(text); (e.target as HTMLInputElement).blur() }
              else if (e.key === 'Escape') { setText(String(value)); setInvalid(false) }
            }}
            onBlur={() => {
              const n = Number(text.trim())
              if (text.trim() === '' || Number.isNaN(n) || !inRange(n)) { setText(String(value)); setInvalid(false) }
            }}
            onFocus={e => e.target.select()}
            spellCheck={false}
            className="kb-field-control w-14 px-1 py-1 text-center text-[13px] tabular-nums text-[var(--text-primary)]"
            aria-label="数值输入"
          />
          <button
            type="button"
            onClick={() => bounce(1)}
            className="px-1.5 py-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            data-tip="增大" aria-label="增大"
          >
            <Plus size={12} />
          </button>
          {unit && <span className="pr-1.5 text-[11px] text-[var(--text-muted)]">{unit}</span>}
        </div>
        {defaultValue !== undefined && value !== defaultValue && (
          <button
            type="button"
            onClick={() => onCommit(defaultValue)}
            className="px-1.5 py-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            data-tip={`还原默认 ${defaultValue}${unit ?? ''}`} aria-label={`还原默认 ${defaultValue}${unit ?? ''}`}
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>
      {showPresets && presets && presets.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {presets.map(p => (
            <button
              key={p}
              type="button"
              onClick={() => onCommit(p)}
              className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${
                value === p
                  ? 'border-[var(--accent)] bg-[var(--bg-selected)] text-[var(--text-primary)]'
                  : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {p}{unit ?? ''}
            </button>
          ))}
        </div>
      )}
      {invalid && (
        <p className="text-[11px] text-[var(--danger)] mt-1">
          请输入 {min ?? '−∞'} ~ {max ?? '∞'} 之间的数值
        </p>
      )}
    </div>
  )
}
