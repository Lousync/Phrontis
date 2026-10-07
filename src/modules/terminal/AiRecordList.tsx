/**
 * AI 执行记录签页（docs/terminal-module-design.md §6）。
 *
 * 行内确认（铁律 25：常规确认不弹窗）：pending 卡上直接 [允许][拒绝]；
 * 高危（risky）的严重警告弹窗由模块层渲染（与所在签页无关）。
 * 「本会话内相同命令不再询问」是未拍板讨论项，MVP 不实现（拍板记录 §1.7）。
 */
import { useState } from 'react'
import type { TerminalAiRecord } from '../../types'

const STATUS_TEXT: Record<TerminalAiRecord['status'], string> = {
  pending: '待确认',
  running: '运行中',
  ok: '已执行',
  denied: '已拒绝',
  timeout: '确认超时',
  error: '出错',
}

const STATUS_COLOR: Record<TerminalAiRecord['status'], string> = {
  pending: 'var(--terminal-warn, #e5c07b)',
  running: 'var(--terminal-warn, #e5c07b)',
  ok: 'var(--terminal-ok, #4ec9b0)',
  denied: 'var(--terminal-err, #f48771)',
  timeout: 'var(--terminal-err, #f48771)',
  error: 'var(--terminal-err, #f48771)',
}

interface Props {
  records: TerminalAiRecord[]
  onRespond: (reqId: string, approved: boolean) => void
}

export default function AiRecordList({ records, onRespond }: Props) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())

  const toggle = (reqId: string) => {
    setOpenIds(prev => {
      const next = new Set(prev)
      if (next.has(reqId)) next.delete(reqId)
      else next.add(reqId)
      return next
    })
  }

  if (records.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center text-[12px] leading-6 text-[var(--text-secondary)]">
          <p>AI 发起的每条终端命令都会先出现在这里等你确认（行内卡，不弹窗）。</p>
          <p>开关在 设置 → AI 终端执行（默认关闭）。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 overflow-auto p-3">
      {records.map(r => {
        const expandable = r.status !== 'pending'
        const open = openIds.has(r.reqId)
        return (
          <div
            key={r.reqId}
            className={`kb-item-in mb-2 overflow-hidden rounded-lg border bg-[var(--card-bg)] ${
              r.status === 'pending' ? 'border-[var(--terminal-warn,#e5c07b)]' : 'border-[var(--border-color)]'
            }`}
          >
            <div
              className={`flex items-center gap-2 px-3 py-2 ${expandable ? 'cursor-pointer' : ''}`}
              onClick={() => { if (expandable) toggle(r.reqId) }}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${r.status === 'pending' || r.status === 'running' ? 'animate-pulse' : ''}`}
                style={{ background: STATUS_COLOR[r.status] }}
              />
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--text-primary)]">{r.cmd}</code>
              {r.risky && (
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[var(--terminal-err,#f48771)] ring-1 ring-[var(--terminal-err,#f48771)]">
                  高危
                </span>
              )}
              <span className="shrink-0 text-[11px] text-[var(--text-secondary)]">{STATUS_TEXT[r.status]} · {r.time}</span>
              {expandable && <span className={`shrink-0 text-[10px] text-[var(--text-secondary)] transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>}
            </div>
            {open && (
              <div className="border-t border-[var(--border-color)] px-3 py-2">
                <div className="mb-1 text-[10.5px] text-[var(--text-secondary)]">
                  输出 · cwd {r.cwd} · 退出码 {r.exitCode ?? '—'}{r.durationMs != null ? ` · ${r.durationMs}ms` : ''}
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px] text-[var(--text-secondary)]">{r.outputPreview || '（无输出）'}</pre>
              </div>
            )}
            {r.status === 'pending' && (
              <div className="flex items-center gap-2 border-t border-[var(--border-color)] px-3 py-2">
                <span className="flex-1 text-[11.5px] text-[var(--text-secondary)]">
                  {r.risky ? '高危命令 —— 确认窗口中放行后才会执行' : '允许后立即执行，输出返回给 AI 并留痕在此'}
                </span>
                <button
                  className="rounded-md bg-[var(--accent)] px-3 py-1 text-[12px] text-white transition-colors hover:bg-[var(--accent-hover)]"
                  onClick={() => onRespond(r.reqId, true)}
                >允许执行</button>
                <button
                  className="rounded-md border border-[var(--border-color)] px-3 py-1 text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
                  onClick={() => onRespond(r.reqId, false)}
                >拒绝</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
