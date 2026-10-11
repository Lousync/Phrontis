import { useState } from 'react'
import { Repeat, Plus, Pencil, Trash2, Pause, Play } from 'lucide-react'
import type { ScheduleRecurring, CreateScheduleRecurringDTO } from '../../../types'
import { scheduleRecurringCreate, scheduleRecurringUpdate, scheduleRecurringDelete } from '../../../lib/ipc'
import { recurringFreqLabel, hmToMin, minToHm } from '../../../lib/scheduleRecurringPure'
import { showToast } from '../../../lib/toast'

/**
 * 固定日程（重复任务）——日程模块左栏的规则区（用户手动入口）。
 *
 * 规则存 `.knowbase/modules/schedule/recurring.json`；到点由 settle 生成普通待办（见 scheduleVaultRepo）。
 * 手动建/改/暂停/删除都走这里；日程助手（AI）走同一条 IPC，写的是同一份规则。
 * 表单**行内展开**（不弹模态，铁律 25）。
 */
interface Props {
  rules: ScheduleRecurring[]
  onReload: () => Promise<void>
}

interface FormState {
  id: string | null
  title: string
  freq: 'weekly' | 'monthly' | 'interval'
  weekdays: number[]
  day: number
  intervalDays: number
  start: string
  end: string
  endDate: string
}

const WEEKDAY_CN = ['一', '二', '三', '四', '五', '六', '日']

function emptyForm(): FormState {
  return { id: null, title: '', freq: 'weekly', weekdays: [5], day: 1, intervalDays: 7, start: '14:00', end: '15:00', endDate: '' }
}
function formOf(r: ScheduleRecurring): FormState {
  return {
    id: r.id, title: r.title, freq: r.freq, weekdays: [...(r.weekdays || [])],
    day: r.day ?? 1, intervalDays: r.intervalDays ?? 7,
    start: minToHm(r.startMin), end: minToHm(r.endMin), endDate: r.endDate || '',
  }
}

export function RecurringRulesPanel({ rules, onReload }: Props) {
  const [form, setForm] = useState<FormState | null>(null)
  const [open, setOpen] = useState(true)

  const save = async (): Promise<void> => {
    if (!form) return
    const title = form.title.trim()
    if (!title) { showToast({ type: 'warning', message: '请填事项' }); return }
    const startMin = hmToMin(form.start, 540)
    const endMin = hmToMin(form.end, startMin + 60)
    const payload: CreateScheduleRecurringDTO = {
      title,
      freq: form.freq,
      weekdays: form.freq === 'weekly' ? form.weekdays : [],
      day: form.freq === 'monthly' ? form.day : null,
      intervalDays: form.freq === 'interval' ? form.intervalDays : null,
      startMin, endMin, taskType: 'plan', quadrant: 1,
      endDate: form.endDate || '',
    }
    try {
      if (form.id) await scheduleRecurringUpdate(form.id, payload as Partial<ScheduleRecurring>)
      else await scheduleRecurringCreate(payload)
      setForm(null)
      await onReload()
      showToast({ type: 'success', message: '已保存固定日程' })
    } catch (e) {
      showToast({ type: 'error', message: '保存失败', detail: String(e) })
    }
  }

  const toggle = async (r: ScheduleRecurring): Promise<void> => {
    try { await scheduleRecurringUpdate(r.id, { enabled: !r.enabled }); await onReload() }
    catch (e) { showToast({ type: 'error', message: '操作失败', detail: String(e) }) }
  }
  const remove = async (r: ScheduleRecurring): Promise<void> => {
    try {
      const ok = await scheduleRecurringDelete(r.id)
      if (ok) { await onReload(); showToast({ type: 'info', message: '已删除固定日程（已生成的待办保留）' }) }
    } catch (e) { showToast({ type: 'error', message: '删除失败', detail: String(e) }) }
  }

  const f = form
  const wdChips = f ? WEEKDAY_CN.map((d, i) => (
    <button key={i} type="button"
      onClick={() => setForm({ ...f, weekdays: f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i] })}
      className={`flex-1 rounded-[5px] border py-[3px] text-[11px] transition-colors ${f.weekdays.includes(i)
        ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_22%,transparent)] text-[var(--text-primary)]'
        : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
    >{d}</button>
  )) : null

  return (
    <div className="shrink-0 border-b border-[var(--border-color)]">
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11.5px] text-[var(--text-muted)] select-none">
        <button onClick={() => setOpen((v) => !v)} title={open ? '收起' : '展开'}
          className="flex items-center gap-1.5 transition-colors hover:text-[var(--text-primary)]">
          <Repeat size={12} className="shrink-0" />
          <span className="font-medium text-[var(--text-secondary)]">固定日程</span>
          <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 leading-[15px] text-[10.5px] font-semibold text-[var(--text-secondary)]">{rules.length}</span>
        </button>
        <button onClick={() => { setOpen(true); setForm(emptyForm()) }} title="新增固定日程"
          className="ml-auto flex items-center gap-0.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]">
          <Plus size={11} /> 新增
        </button>
      </div>

      {open && (form !== null || rules.length > 0) && (
        <div className="px-2 pb-2">
          {form && (
            <div className="mb-2 flex flex-col gap-1.5 rounded-lg border p-2.5"
              style={{ borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' }}>
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                事项
                <input value={f!.title} onChange={(e) => setForm({ ...f!, title: e.target.value })}
                  placeholder="如 洗衣服洗袜子"
                  className="min-w-0 flex-1 rounded-[5px] border border-[var(--border-color)] bg-[var(--input-bg)] px-1.5 py-1 text-[12px] text-[var(--text-primary)] outline-none" />
              </label>
              <div className="flex overflow-hidden rounded-md border border-[var(--border-color)]">
                {(['weekly', 'monthly', 'interval'] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setForm({ ...f!, freq: k })}
                    className={`flex-1 py-1 text-[11px] transition-colors ${f!.freq === k ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'}`}>
                    {k === 'weekly' ? '每周' : k === 'monthly' ? '每月' : '每N天'}
                  </button>
                ))}
              </div>
              {f!.freq === 'weekly' && <div className="flex gap-[3px]">{wdChips}</div>}
              {f!.freq === 'monthly' && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  每月第
                  <input type="number" min={1} max={31} value={f!.day} onChange={(e) => setForm({ ...f!, day: Number(e.target.value) })}
                    className="w-[52px] rounded-[5px] border border-[var(--border-color)] bg-[var(--input-bg)] px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none" />
                  号
                </label>
              )}
              {f!.freq === 'interval' && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  每
                  <input type="number" min={1} max={365} value={f!.intervalDays} onChange={(e) => setForm({ ...f!, intervalDays: Number(e.target.value) })}
                    className="w-[52px] rounded-[5px] border border-[var(--border-color)] bg-[var(--input-bg)] px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none" />
                  天一次
                </label>
              )}
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                时段
                <input type="time" value={f!.start} onChange={(e) => setForm({ ...f!, start: e.target.value })}
                  className="rounded-[5px] border border-[var(--border-color)] bg-[var(--input-bg)] px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none" />
                –
                <input type="time" value={f!.end} onChange={(e) => setForm({ ...f!, end: e.target.value })}
                  className="rounded-[5px] border border-[var(--border-color)] bg-[var(--input-bg)] px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none" />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                结束（可选）
                <input type="date" value={f!.endDate} onChange={(e) => setForm({ ...f!, endDate: e.target.value })}
                  className="flex-1 rounded-[5px] border border-[var(--border-color)] bg-[var(--input-bg)] px-1 py-0.5 text-[11.5px] text-[var(--text-primary)] outline-none" />
              </label>
              <div className="mt-0.5 flex justify-end gap-1.5">
                <button type="button" onClick={() => setForm(null)}
                  className="rounded-md border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-2.5 py-1 text-[11.5px] text-[var(--text-secondary)]">取消</button>
                <button type="button" onClick={() => void save()}
                  className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11.5px] text-white">保存</button>
              </div>
            </div>
          )}

          <div className="max-h-[240px] overflow-y-auto">
            {rules.map((r) => (
              <div key={r.id} className={`mb-1.5 rounded-md border border-[var(--border-color)] border-l-[3px] bg-[var(--bg-primary)] px-2 py-1.5 ${r.enabled ? '' : 'opacity-50'}`}
                style={{ borderLeftColor: r.enabled ? 'var(--accent)' : 'var(--text-muted)' }}>
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--text-primary)]">{r.title}</span>
                  <button onClick={() => void toggle(r)} title={r.enabled ? '暂停' : '启用'}
                    className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                    {r.enabled ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                  <button onClick={() => setForm(formOf(r))} title="编辑"
                    className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Pencil size={11} /></button>
                  <button onClick={() => void remove(r)} title="删除"
                    className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"><Trash2 size={11} /></button>
                </div>
                <div className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                  🔁 {recurringFreqLabel(r)} · {minToHm(r.startMin)}–{minToHm(r.endMin)}{r.enabled ? '' : ' · 已暂停'}{r.endDate ? ` · 至 ${r.endDate}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
