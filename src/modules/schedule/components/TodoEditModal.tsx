import { useState, useEffect, useMemo } from 'react'
import type { ScheduleTag, ScheduleTodo } from '../../../types'
import { X, Plus, Trash2, Check } from 'lucide-react'
import { localToday } from '../../../lib/date'
import { isSummaryTagName } from '../../../lib/summary'
import { usePresence } from '../../../lib/usePresence'
import {
  orderedQuadrants, QuadrantIconGlyph, QUADRANT_TEXT_CLASS,
  type QuadrantIcon, type QuadrantOrder,
} from '../../../lib/scheduleQuadrant'

interface TodoForm {
  title: string; description: string; time: string
  quadrant: number; taskType: 'deadline' | 'plan' | 'daily'; tagId: string
  endCriteria: string
}

interface Props {
  open: boolean
  initial: TodoForm
  tags: ScheduleTag[]
  onSave: (data: TodoForm) => void
  onClose: () => void
  subtasks?: ScheduleTodo[]
  onToggleSubtask?: (id: string) => void
  onDeleteSubtask?: (id: string) => void
  /** 删除主任务（仅编辑已有任务时提供）。级联删子任务、无回收站，由调用方确认口径 */
  onDelete?: () => void
  onCreateSubtask?: (data: { title: string; date: string; taskType: 'daily' }) => void
  /** 四象限图标方案（设置项 scheduleQuadrantIcon） */
  quadrantIcon?: QuadrantIcon
  /** 四象限排序（设置项 scheduleQuadrantOrder） */
  quadrantOrder?: QuadrantOrder
  /** 是否显示象限文字（设置项 scheduleQuadrantText） */
  quadrantText?: 'show' | 'hide'
  /** 是否允许创建/切换为「琐碎」类型——按截止 / 按象限视图关闭（零碎任务当天创建当天完成，只在按日期与日程表提供） */
  allowDaily?: boolean
}

export function TodoEditModal({
  open, initial, tags, onSave, onClose, subtasks, onToggleSubtask, onDeleteSubtask, onCreateSubtask, onDelete,
  quadrantIcon = 'bars', quadrantOrder = 'ladder', quadrantText = 'show', allowDaily = true,
}: Props) {
  const [form, setForm] = useState<TodoForm>(initial)
  const [timeWarning, setTimeWarning] = useState('')
  // 进出场动效（docs/ui-animation-plan.md B 类）：关闭时延迟卸载以播完退场
  const { mounted, closing } = usePresence(open, 180)

  /** 象限选项展示顺序（默认按紧迫度从左到右递增） */
  const quadrants = useMemo(() => orderedQuadrants(quadrantOrder), [quadrantOrder])

  // Sub-task inline form
  const [subtaskTitle, setSubtaskTitle] = useState('')
  const [subtaskOpen, setSubtaskOpen] = useState(false)

  function handleAddSubtask() {
    if (!subtaskTitle.trim() || !onCreateSubtask) return
    onCreateSubtask({
      title: subtaskTitle.trim(),
      date: localToday(),
      taskType: 'daily',
    })
    setSubtaskTitle('')
    setSubtaskOpen(false)
  }

  // Raw string state for each deadline part (independent of form.time parsing)
  const dp0 = parseDeadline(form.time)
  const [dStr, setDStr] = useState({
    year: String(dp0.year),
    month: String(dp0.month),
    day: String(dp0.day),
    hour: String(dp0.hour),
    minute: String(dp0.minute),
  })

  useEffect(() => { setForm(initial); const dp = parseDeadline(initial.time); setDStr({ year: String(dp.year), month: String(dp.month), day: String(dp.day), hour: String(dp.hour), minute: String(dp.minute) }); setTimeWarning('') }, [initial])

  // Escape key closes modal
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!mounted) return null

  const canSave = form.title.trim().length > 0

  function buildDeadlineTime(p: typeof dStr): string {
    const y = String(parseInt(p.year, 10) || new Date().getFullYear()).padStart(4, '0')
    const mo = String(Math.max(1, Math.min(12, parseInt(p.month, 10) || 1))).padStart(2, '0')
    const d = String(Math.max(1, Math.min(31, parseInt(p.day, 10) || 1))).padStart(2, '0')
    const h = String(Math.max(0, Math.min(23, parseInt(p.hour, 10) || 0))).padStart(2, '0')
    const mi = String(Math.max(0, Math.min(59, parseInt(p.minute, 10) || 0))).padStart(2, '0')
    return `${y}-${mo}-${d} ${h}:${mi}`
  }

  function syncDeadline(p: typeof dStr) {
    setDStr(p)
    setForm(f => ({ ...f, time: buildDeadlineTime(p) }))
  }

  function fixInput(val: string, maxLen: number): string {
    return val.replace(/\D/g, '').slice(0, maxLen)
  }

  /** 规范化 + 验证截止时间 */
  function validateAndCorrect(): { corrected: string; warning: string } {
    const parts = { ...dStr }
    // clamp values
    let y = parseInt(parts.year, 10) || new Date().getFullYear()
    let mo = Math.max(1, Math.min(12, parseInt(parts.month, 10) || 1))
    const dim = new Date(y, mo, 0).getDate()
    let d = Math.max(1, Math.min(dim, parseInt(parts.day, 10) || 1))
    const h = Math.max(0, Math.min(23, parseInt(parts.hour, 10) || 0))
    const mi = Math.max(0, Math.min(59, parseInt(parts.minute, 10) || 0))

    const corrected = `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')} ${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`

    // Check: deadline must not be before today
    const targetDate = `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    const td = localToday()
    if (targetDate < td) {
      return { corrected, warning: '截止日期不能早于今天' }
    }

    if (corrected !== form.time) {
      return { corrected, warning: '截止日期无效，已修正' }
    }
    return { corrected, warning: '' }
  }

  function handleSave() {
    if (!canSave) return
    const { corrected, warning } = validateAndCorrect()
    const updated = { ...form, time: corrected }
    setForm(updated)
    // update dStr to match corrected
    const dp = parseDeadline(corrected)
    setDStr({ year: String(dp.year), month: String(dp.month), day: String(dp.day), hour: String(dp.hour), minute: String(dp.minute) })
    if (warning) {
      setTimeWarning(warning)
      if (warning.includes('早于')) return // block save for past dates
      setTimeout(() => setTimeWarning(''), 2500)
    }
    onSave(updated)
  }

  function onDeadlinePartChange(field: keyof typeof dStr, raw: string) {
    const clean = fixInput(raw, field === 'year' ? 4 : 2)
    const next = { ...dStr, [field]: clean }
    syncDeadline(next)
  }

  return (
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/50 ${closing ? 'kb-overlay-out' : 'kb-overlay'}`}>
      <div className={`bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg w-[500px] shadow-2xl ${closing ? 'kb-modal-out' : 'kb-modal-in'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-[14px] font-medium text-[var(--text-primary)]">{initial.title ? '编辑任务' : '新建任务'}</h3>
          <button onClick={onClose} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={16} /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <Field label="标题">
            <input autoFocus value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="任务标题"
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[14px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
            />
          </Field>

          <Field label="描述">
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="可选描述" rows={2}
              className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none resize-none"
            />
          </Field>

          <Field label="任务类型">
            <div className="flex gap-2">
              {allowDaily && (
                <button onClick={() => setForm(f => ({ ...f, taskType: 'daily' }))}
                  className={`flex-1 py-2 text-[13px] rounded border transition-colors ${form.taskType === 'daily' ? 'border-[var(--warning)] bg-[var(--warning-bg)] text-[var(--text-primary)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-color)]'}`}
                >⚡ 零碎</button>
              )}
              <button onClick={() => setForm(f => ({ ...f, taskType: 'plan' }))}
                className={`flex-1 py-2 text-[13px] rounded border transition-colors ${form.taskType === 'plan' ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-color)]'}`}
              >📋 计划类</button>
              <button onClick={() => {
                const n = new Date()
                const t = `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')} ${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`
                const dp = parseDeadline(t)
                setDStr({ year: String(dp.year), month: String(dp.month), day: String(dp.day), hour: String(dp.hour), minute: String(dp.minute) })
                setForm(f => ({ ...f, taskType: 'deadline', time: t }))
              }}
                className={`flex-1 py-2 text-[13px] rounded border transition-colors ${form.taskType === 'deadline' ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-color)]'}`}
              >⏰ 截止类</button>
            </div>
          </Field>

          {/* 截止时间 */}
          {form.taskType === 'deadline' && (
            <Field label="截止时间">
              <div className="bg-[var(--bg-tertiary)] rounded-lg p-4 border border-[var(--border-color)] space-y-3">
                {/* 日期 */}
                <div className="flex items-center gap-1.5">
                  <input type="text" inputMode="numeric" value={dStr.year}
                    onChange={e => onDeadlinePartChange('year', e.target.value)}
                    className="w-[72px] px-2 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-center text-[14px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none" />
                  <span className="text-[var(--text-muted)] text-[13px] shrink-0">年</span>
                  <input type="text" inputMode="numeric" value={dStr.month}
                    onChange={e => onDeadlinePartChange('month', e.target.value)}
                    className="w-[48px] px-2 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-center text-[14px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none" />
                  <span className="text-[var(--text-muted)] text-[13px] shrink-0">月</span>
                  <input type="text" inputMode="numeric" value={dStr.day}
                    onChange={e => onDeadlinePartChange('day', e.target.value)}
                    className="w-[48px] px-2 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-center text-[14px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none" />
                  <span className="text-[var(--text-muted)] text-[13px] shrink-0">日</span>
                  <span className="text-[var(--text-disabled)] text-[14px] shrink-0 ml-2 mr-1">·</span>
                  <input type="text" inputMode="numeric" value={dStr.hour}
                    onChange={e => onDeadlinePartChange('hour', e.target.value)}
                    className="w-[48px] px-2 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-center text-[14px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none" />
                  <span className="text-[var(--text-muted)] text-[13px] shrink-0">时</span>
                  <input type="text" inputMode="numeric" value={dStr.minute}
                    onChange={e => onDeadlinePartChange('minute', e.target.value)}
                    className="w-[48px] px-2 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-center text-[14px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none" />
                  <span className="text-[var(--text-muted)] text-[13px] shrink-0">分</span>
                </div>
              </div>
              {timeWarning && (
                <p className={`text-[11px] mt-1 ${timeWarning.includes('早于') ? 'text-[var(--danger)]' : 'text-[var(--warning)]'}`}>⚠ {timeWarning}</p>
              )}
            </Field>
          )}

          {form.taskType === 'plan' && (
            <Field label="结束标准">
              <textarea value={form.endCriteria} onChange={e => setForm(f => ({ ...f, endCriteria: e.target.value }))}
                placeholder="如：完成3个项目、读完5本书..." rows={2}
                className="w-full px-3 py-2 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[13px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none resize-none"
              />
            </Field>
          )}

          {/* Sub-tasks (plan & deadline tasks only, when editing existing task) */}
          {form.taskType !== 'daily' && initial.title && (
            <Field label={`子任务${subtasks ? ` (${subtasks.length})` : ''}`}>
              <div className="bg-[var(--bg-tertiary)] rounded-lg p-3 border border-[var(--border-color)] space-y-1.5 max-h-[200px] overflow-y-auto">
                {subtasks && subtasks.length > 0 ? (
                  subtasks.map(st => {
                    const isDone = st.status === 'done'
                    return (
                      <div key={st.id} className={`flex items-center gap-2 px-2 py-1.5 rounded text-[12px] group ${isDone ? 'opacity-50' : ''}`}>
                        <button
                          onClick={() => onToggleSubtask?.(st.id)}
                          className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isDone ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--border-color)] hover:border-[var(--accent)]'}`}
                          title="切换完成状态"
                        >
                          {isDone && <Check size={10} strokeWidth={3} className="text-white" />}
                        </button>
                        <span className={`flex-1 truncate ${isDone ? 'line-through text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{st.title}</span>
                        <button
                          onClick={() => onDeleteSubtask?.(st.id)}
                          className="p-0.5 text-[var(--text-muted)] hover:text-[var(--danger)] opacity-0 group-hover:opacity-100 transition-all"
                          title="删除子任务"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )
                  })
                ) : (
                  <p className="text-[11px] text-[var(--text-disabled)] italic text-center py-1">暂无子任务</p>
                )}

                {/* Add subtask inline — simple title-only, like daily tasks */}
                {subtaskOpen ? (
                  <div className="flex items-center gap-1.5 pt-1.5 border-t border-[var(--border-color)]">
                    <input
                      autoFocus
                      value={subtaskTitle}
                      onChange={e => setSubtaskTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddSubtask(); if (e.key === 'Escape') { setSubtaskOpen(false); setSubtaskTitle('') } }}
                      placeholder="子任务标题..."
                      className="flex-1 px-2 py-1.5 bg-[var(--input-bg)] border border-[var(--border-color)] rounded text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
                    />
                    <button onClick={handleAddSubtask} disabled={!subtaskTitle.trim()}
                      className="px-3 py-1.5 text-[11px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors"
                    >确认</button>
                    <button onClick={() => { setSubtaskOpen(false); setSubtaskTitle('') }}
                      className="px-2 py-1.5 text-[11px] border border-[var(--border-color)] rounded hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] transition-colors"
                    >取消</button>
                  </div>
                ) : (
                  onCreateSubtask && (
                    <button onClick={() => setSubtaskOpen(true)}
                      className="flex items-center gap-1 w-full py-1.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded transition-colors justify-center"
                    >
                      <Plus size={12} />添加子任务
                    </button>
                  )
                )}
              </div>
            </Field>
          )}

          {form.taskType !== 'daily' && (
            <Field label="四象限">
              <div className="flex gap-2">
                {quadrants.map(q => {
                  const active = form.quadrant === q.value
                  return (
                    <button key={q.value} onClick={() => setForm(f => ({ ...f, quadrant: q.value }))}
                      title={quadrantText === 'hide' ? `${q.label}（紧迫度 ${q.level}/4）` : undefined}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-[12px] rounded border transition-colors ${active ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-color)]'}`}
                    >
                      <span className={`inline-flex ${QUADRANT_TEXT_CLASS[q.value] ?? ''}`}>
                        <QuadrantIconGlyph icon={quadrantIcon} meta={q} size={17} />
                      </span>
                      {quadrantText === 'show' && <span>{q.label}</span>}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}

          <Field label="标签">
            {/* 来源标签（周任务/月任务）不进选择器：它们表达任务来源而非用户分类 */}
            {(() => {
              const selectable = tags.filter(t => !isSummaryTagName(t.name))
              if (selectable.length === 0) {
                return <p className="text-[12px] text-[var(--text-disabled)] italic">暂无标签，使用右侧按钮创建</p>
              }
              return (
                <div className="flex flex-wrap gap-2">
                  {selectable.map(t => {
                    // 选中态 = 实心填充 + 白字 + 对勾；未选中 = 描边风格。
                    // 旧实现两种状态都是彩色填充、只差一个 ring —— 浅色主题下 ring 不可见，
                    // 于是"所有标签都像已添加，且点了没反应"（2026-09-10 修）
                    const active = form.tagId === t.id
                    return (
                      <button key={t.id}
                        onClick={() => setForm(f => ({ ...f, tagId: active ? '' : t.id }))}
                        title={active ? '点击取消这个标签' : '点击为任务选择这个标签'}
                        className={`flex items-center gap-1 px-2.5 py-1 rounded text-[12px] transition-colors ${active ? 'text-white' : 'hover:bg-[var(--bg-hover)]'}`}
                        style={active
                          ? { backgroundColor: t.color, border: `1px solid ${t.color}` }
                          : { backgroundColor: 'transparent', color: t.color, border: `1px solid ${t.color}66` }}
                      >
                        {active && <Check size={11} strokeWidth={3} />}
                        {t.name}
                      </button>
                    )
                  })}
                </div>
              )
            })()}
          </Field>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--border-color)]">
          {/* 删除主任务：仅编辑已有任务时出现（新建时 initial.title 为空）。
              红字弱化、常态透明 —— 与「删除子任务」同源口径，避免误点 */}
          {onDelete && initial.title && (
            <button
              onClick={() => { onClose(); onDelete() }}
              title="删除这个任务（含其全部子任务，不可恢复）"
              className="flex items-center gap-1 px-2 py-1.5 rounded text-[12.5px] text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
            >
              <Trash2 size={13} /> 删除任务
            </button>
          )}
          <button onClick={onClose} className="ml-auto px-4 py-1.5 text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
          <button onClick={handleSave} disabled={!canSave}
            className="px-4 py-1.5 text-[13px] bg-[var(--accent)] text-white rounded hover:bg-[var(--accent-hover)] disabled:opacity-40"
          >保存</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] text-[var(--text-muted)] mb-1">{label}</label>
      {children}
    </div>
  )
}

function parseDeadline(time: string | null | undefined) {
  const now = new Date()
  const d = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), hour: 18, minute: 0 }
  if (!time) return d
  const m = time.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/)
  if (!m) return d
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) }
}
