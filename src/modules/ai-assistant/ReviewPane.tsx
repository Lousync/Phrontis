import { useEffect, useMemo, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { Check, X, Undo2, FileText, FilePlus2, MoveRight, Trash2 } from 'lucide-react'
import type { AiChangePlan, AiPlanOp } from '../../types'
import { bindEditorTheme } from '../../lib/editorTheme'
// Monaco 运行时装配与共享宿主同源（worker 注册 + loader 本地化），monaco 仍单独分包
import '../../lib/monaco-setup'
import { MonacoErrorBoundary } from '../../components/shared/MonacoErrorBoundary'

/**
 * 变更审阅面板（v3.9.0，M3）。
 *
 * 左栏 = 逐条变更清单（可勾选采纳）；右栏 = Monaco 并排 diff（改动前 / 改动后）。
 * 「先预览、后确认」：这里只是把 ChangePlan 展示出来，真正落盘由 onApply → 主进程 applyPlan。
 */
interface Props {
  plan: AiChangePlan
  busy?: boolean
  onApply: (ids: string[]) => void
  onReject: () => void
  onRollback: () => void
}

function langOf(rel?: string): string {
  const p = (rel ?? '').toLowerCase()
  if (p.endsWith('.md') || p.endsWith('.markdown')) return 'markdown'
  if (p.endsWith('.json')) return 'json'
  if (p.endsWith('.html')) return 'html'
  if (p.endsWith('.css')) return 'css'
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'javascript'
  if (p.endsWith('.ts')) return 'typescript'
  if (p.endsWith('.py')) return 'python'
  return 'plaintext'
}

function isDiffable(op: AiPlanOp): boolean {
  return op.kind === 'write' || op.kind === 'edit' || op.kind === 'trash'
}

function KindIcon({ kind }: { kind: AiPlanOp['kind'] }) {
  const p = { size: 13, className: 'shrink-0 text-[var(--text-muted)]' }
  if (kind === 'write') return <FilePlus2 {...p} />
  if (kind === 'edit') return <FileText {...p} />
  if (kind === 'rename') return <MoveRight {...p} />
  if (kind === 'trash') return <Trash2 {...p} />
  return <FileText {...p} />
}

export function ReviewPane({ plan, busy = false, onApply, onReject, onRollback }: Props) {
  const pending = useMemo(() => plan.ops.filter((o) => o.status === 'pending'), [plan])
  const applied = useMemo(() => plan.ops.filter((o) => o.status === 'applied'), [plan])
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    setAccepted(new Set(pending.map((o) => o.id)))
    setSelectedId((prev) => {
      if (prev && plan.ops.some((o) => o.id === prev)) return prev
      return pending[0]?.id ?? applied[0]?.id ?? plan.ops[0]?.id ?? null
    })
  }, [plan]) // eslint-disable-line react-hooks/exhaustive-deps

  const selected = plan.ops.find((o) => o.id === selectedId) ?? null

  const toggle = (id: string): void => {
    setAccepted((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="kb-view-in flex h-full min-w-0 flex-col bg-[var(--bg-primary)]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-color)] px-3">
        <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
          变更方案 · 待确认 {pending.length} 项{applied.length ? ` · 已应用 ${applied.length} 项` : ''}
        </span>
        <div className="flex items-center gap-1.5">
          {applied.length > 0 && (
            <button
              type="button"
              onClick={onRollback}
              disabled={busy}
              className="kb-micro-pop flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--danger)] disabled:opacity-40"
              title="回滚本任务已应用的全部改动"
            >
              <Undo2 size={13} /> 回滚整任务
            </button>
          )}
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="kb-micro-pop flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
            title="丢弃未应用的变更"
          >
            <X size={13} /> 丢弃
          </button>
          <button
            type="button"
            onClick={() => onApply(Array.from(accepted))}
            disabled={busy || accepted.size === 0}
            className="kb-micro-pop flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] text-white disabled:opacity-40"
            title="把勾选的变更落盘"
          >
            <Check size={13} /> 应用 {accepted.size}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ul className="w-[236px] shrink-0 overflow-y-auto border-r border-[var(--border-color)] p-1.5">
          {plan.ops.length === 0 ? (
            <p className="px-2 py-4 text-center text-[12px] text-[var(--text-muted)]">暂无变更</p>
          ) : plan.ops.map((op) => {
            const isPending = op.status === 'pending'
            const on = isPending && accepted.has(op.id)
            return (
              <li key={op.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(op.id)}
                  className={`kb-item-in flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] ${
                    selectedId === op.id ? 'bg-[var(--bg-selected)]' : 'hover:bg-[var(--bg-hover)]'
                  } ${op.status === 'rejected' ? 'opacity-50' : ''}`}
                >
                  {isPending ? (
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(op.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="kb-draggable h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
                    />
                  ) : (
                    <span className={`shrink-0 text-[10px] ${op.status === 'applied' ? 'text-emerald-500' : 'text-[var(--text-muted)]'}`}>
                      {op.status === 'applied' ? '●' : '○'}
                    </span>
                  )}
                  <KindIcon kind={op.kind} />
                  <span className="truncate text-[var(--text-secondary)]">{op.relPath ?? op.to ?? '(未知)'}</span>
                </button>
              </li>
            )
          })}
        </ul>

        <div className="min-w-0 flex-1">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">选择一条变更查看</div>
          ) : isDiffable(selected) ? (
            <MonacoErrorBoundary>
              <DiffEditor
                height="100%"
                theme="knowbase-auto"
                beforeMount={bindEditorTheme}
                original={selected.prev ?? ''}
                modified={selected.next ?? ''}
                language={langOf(selected.relPath)}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: 'on',
                  scrollBeyondLastLine: false,
                  renderSideBySide: true,
                  automaticLayout: true,
                }}
              />
            </MonacoErrorBoundary>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]">
              <KindIcon kind={selected.kind} />
              <p>
                {selected.kind === 'rename'
                  ? `${selected.relPath} → ${selected.to}`
                  : selected.kind === 'mkdir'
                    ? `新建目录 ${selected.relPath}`
                    : `标签变更 ${selected.relPath ?? ''}`}
              </p>
              <p className="text-[12px] text-[var(--text-muted)]">此变更无文本差异预览</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
