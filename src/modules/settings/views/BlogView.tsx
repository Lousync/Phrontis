import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, PencilLine, Check, X, CalendarCheck2 } from 'lucide-react'
import type { BlogTemplate } from '../../../types'
import {
  getSetting, setSetting,
  listBlogTemplates, createBlogTemplate, updateBlogTemplate, deleteBlogTemplate,
} from '../../../lib/ipc'
import { NumberField } from '../components/fields/NumberField'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
type MonthlyMode = 'first' | 'last' | 'fixed'

/**
 * 设置 → 博客：周期总结日规则（从总结面板迁出）+ 博客模板管理。
 */
export function BlogView() {
  // ---- 总结日设置 ----
  const [weeklyDay, setWeeklyDay] = useState(0)
  const [monthlyMode, setMonthlyMode] = useState<MonthlyMode>('last')
  const [monthlyFixedDay, setMonthlyFixedDay] = useState(1)

  useEffect(() => {
    void Promise.all([
      getSetting('summaryWeeklyDay'),
      getSetting('summaryMonthlyMode'),
      getSetting('summaryMonthlyFixedDay'),
    ]).then(([w, m, f]) => {
      setWeeklyDay(Number(w ?? 0))
      setMonthlyMode((m as MonthlyMode) || 'last')
      setMonthlyFixedDay(Number(f ?? 1))
    }).catch(console.error)
  }, [])

  // ---- 模板管理 ----
  const [templates, setTemplates] = useState<BlogTemplate[]>([])
  const [editing, setEditing] = useState<{ id: string | null; name: string; contentMd: string } | null>(null)

  const loadTemplates = useCallback(() => {
    void listBlogTemplates().then(setTemplates).catch(console.error)
  }, [])

  useEffect(() => { loadTemplates() }, [loadTemplates])

  const startCreate = () => setEditing({ id: null, name: '', contentMd: '' })
  const startEdit = (t: BlogTemplate) => setEditing({ id: t.id, name: t.name, contentMd: t.contentMd })

  const saveEditing = async () => {
    if (!editing || !editing.name.trim()) return
    try {
      if (editing.id) await updateBlogTemplate(editing.id, { name: editing.name, contentMd: editing.contentMd })
      else await createBlogTemplate({ name: editing.name, contentMd: editing.contentMd })
      setEditing(null)
      loadTemplates()
    } catch (e) { console.error(e) }
  }

  const removeTemplate = async (id: string) => {
    try {
      await deleteBlogTemplate(id)
      loadTemplates()
    } catch (e) { console.error(e) }
  }

  return (
    <div className="space-y-10">
      <div>
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">周期总结</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          命中总结日的博文会在文末附上周/月统计与下期任务面板。同一天同时命中周、月总结时，优先显示月总结。
        </p>

        <div className="space-y-3 max-w-md">
          <label className="flex items-center gap-3 text-[13px]" data-setting-anchor="blog.summaryWeeklyDay">
            <span className="flex items-center gap-1.5 text-[var(--text-secondary)] w-28 shrink-0">
              <CalendarCheck2 size={14} /> 周总结日
            </span>
            <select
              value={weeklyDay}
              onChange={e => { const v = Number(e.target.value); setWeeklyDay(v); void setSetting('summaryWeeklyDay', v) }}
              className="flex-1 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              {WEEKDAY_LABELS.map((lbl, i) => <option key={i} value={i}>每周{lbl}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-3 text-[13px]" data-setting-anchor="blog.summaryMonthlyMode">
            <span className="text-[var(--text-secondary)] w-28 shrink-0">月总结日</span>
            <select
              value={monthlyMode}
              onChange={e => { const v = e.target.value as MonthlyMode; setMonthlyMode(v); void setSetting('summaryMonthlyMode', v) }}
              className="flex-1 px-2.5 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              <option value="first">每月第一天（总结上个自然月）</option>
              <option value="last">每月最后一天（总结当月）</option>
              <option value="fixed">每月固定日（统计近 30 天）</option>
            </select>
          </label>
          {monthlyMode === 'fixed' && (
            <div className="flex items-center gap-3 text-[13px]" data-setting-anchor="blog.summaryMonthlyFixedDay">
              <span className="text-[var(--text-secondary)] w-28 shrink-0">固定日期</span>
              <NumberField
                value={monthlyFixedDay}
                onCommit={(v) => { setMonthlyFixedDay(v); void setSetting('summaryMonthlyFixedDay', v) }}
                min={1}
                max={28}
                step={1}
                unit="号"
                presets={[1, 5, 10, 15, 20, 25, 28]}
                defaultValue={1}
              />
              <span className="text-[11px] text-[var(--text-muted)]">每月 {monthlyFixedDay} 号为月总结日（1-28）</span>
            </div>
          )}
        </div>
      </div>

      <div data-setting-anchor="blog.templates">
        <h2 className="text-[15px] font-medium text-[var(--text-primary)] mb-1">博客模板</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">
          写日记时点工具栏「模板」一键套用；当天没那么多可写时特别有用。
        </p>

        {/* 编辑 / 新建表单 */}
        {editing && (
          <div className="mb-4 p-4 rounded-lg border border-[var(--accent)]/40 bg-[var(--bg-secondary)] space-y-3">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={editing.name}
                onChange={e => setEditing(prev => prev ? { ...prev, name: e.target.value } : prev)}
                placeholder="模板名称，如：简单日记"
                maxLength={30}
                className="flex-1 px-3 py-2 rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
              />
              <button onClick={() => void saveEditing()} disabled={!editing.name.trim()} className="flex items-center gap-1 px-3 py-2 rounded-md bg-[var(--accent)] text-white text-[12px] hover:bg-[var(--accent-hover)] disabled:opacity-40 transition-colors">
                <Check size={13} /> 保存
              </button>
              <button onClick={() => setEditing(null)} className="p-2 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors">
                <X size={14} />
              </button>
            </div>
            <textarea
              value={editing.contentMd}
              onChange={e => setEditing(prev => prev ? { ...prev, contentMd: e.target.value } : prev)}
              placeholder={'模板内容（Markdown）…\n例如：\n## 今日完成\n- \n\n## 明日计划\n- '}
              rows={10}
              className="w-full resize-y rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] px-3 py-2.5 text-[13px] leading-6 font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-disabled)]"
            />
          </div>
        )}

        {/* 模板列表 */}
        <div className="space-y-1.5 max-w-xl">
          {!editing && (
            <button
              onClick={startCreate}
              className="flex items-center gap-1.5 mb-2 px-3 py-1.5 rounded-md border border-dashed border-[var(--border-color)] text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <Plus size={13} /> 新建模板
            </button>
          )}
          {templates.length === 0 && !editing ? (
            <p className="text-[12px] text-[var(--text-disabled)] py-2">还没有模板。</p>
          ) : (
            templates.map(t => (
              <div key={t.id} className="group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--text-primary)] truncate">{t.name}</div>
                  <div className="text-[10px] text-[var(--text-muted)] truncate">
                    {(t.contentMd || '').replace(/[#*`>\-\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '空模板'}
                  </div>
                </div>
                <button onClick={() => startEdit(t)} className="p-1.5 rounded text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all shrink-0" data-tip="编辑" aria-label="编辑">
                  <PencilLine size={14} />
                </button>
                <button onClick={() => void removeTemplate(t.id)} className="p-1.5 rounded text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--danger)] hover:bg-[#e8112320] transition-all shrink-0" data-tip="删除" aria-label="删除">
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
