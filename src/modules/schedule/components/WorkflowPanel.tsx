import { useState } from 'react'
import { CalendarRange, Check, GitBranch, Plus, Trash2 } from 'lucide-react'
import type { ScheduleTag, ScheduleWorkflow } from '../../../types'
import {
  addScheduleWorkflowCheckpoint, addScheduleWorkflowStage, createScheduleWorkflow,
  deleteScheduleWorkflow, deleteScheduleWorkflowCheckpoint, deleteScheduleWorkflowStage,
  updateScheduleWorkflow, updateScheduleWorkflowCheckpoint, updateScheduleWorkflowStage,
} from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { useScheduleUi } from '../ScheduleUiContext'
import { addWorkflowDays, stageDuration, workflowProgress, workflowToday } from '../workflowPure'
import { requestScheduleAiPrefill, requestScheduleOpenCalendar, requestScheduleOpenCanvas } from '../shared'

interface Props {
  workflow: ScheduleWorkflow | null
  newWorkflow: boolean
  tags: ScheduleTag[]
  onChanged: () => void
  onDeleted: () => void
}

const FIELD = 'w-full rounded-md border border-[var(--border-color)] bg-[var(--input-bg)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]'

function nextStatus(status: string): 'planned' | 'doing' | 'done' {
  return status === 'planned' ? 'doing' : status === 'doing' ? 'done' : 'planned'
}

function statusLabel(status: string): string {
  return status === 'done' ? '已完成' : status === 'doing' ? '进行中' : '未开始'
}

export function WorkflowPanel({ workflow, newWorkflow, tags, onChanged, onDeleted }: Props) {
  if (newWorkflow || !workflow) {
    return <NewWorkflowForm tags={tags} onCreated={onChanged} />
  }
  return <ExistingWorkflow workflow={workflow} tags={tags} onChanged={onChanged} onDeleted={onDeleted} />
}

function NewWorkflowForm({ tags, onCreated }: { tags: ScheduleTag[]; onCreated: () => void }) {
  const { openWorkflow, openAi } = useScheduleUi()
  const [title, setTitle] = useState('')
  const [tagId, setTagId] = useState('')
  const [start, setStart] = useState(workflowToday())
  const [end, setEnd] = useState(addWorkflowDays(workflowToday(), 27))
  const [busy, setBusy] = useState(false)

  async function create(useAi: boolean) {
    const clean = title.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      const tag = tags.find(t => t.id === tagId) ?? null
      const flow = await createScheduleWorkflow({
        title: clean,
        tagId: tagId || null,
        color: tag?.color,
        start,
        end,
      })
      onCreated()
      openWorkflow(flow.id)
      requestScheduleOpenCanvas(flow.id)
      if (useAi) {
        openAi()
        window.setTimeout(() => {
          requestScheduleAiPrefill(`请帮我拆解工作流「${clean}」（id=${flow.id}）：从 ${start} 到 ${end}，拆成阶段和检查点，并直接调用工具落盘。`)
        }, 160)
      }
    } catch (e) {
      showToast({ type: 'error', message: '创建工作流失败', detail: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)]"><GitBranch size={13} /> 新建工作流</div>
        <label className="mt-3 block">
          <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">标题</span>
          <input value={title} onChange={e => setTitle(e.target.value)} className={FIELD} placeholder="例如：准备线性代数期末" autoFocus />
        </label>
        <label className="mt-2 block">
          <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">标签</span>
          <select value={tagId} onChange={e => setTagId(e.target.value)} className={FIELD}>
            <option value="">无</option>
            {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </label>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">开始</span>
            <input type="date" value={start} onChange={e => setStart(e.target.value)} className={FIELD} />
          </label>
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">结束</span>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)} className={FIELD} />
          </label>
        </div>
        <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">空白创建会得到一个 0 阶段工作流；AI 拆解会创建后打开助手并预填提示词，不自动发送。</p>
      </div>
      <div className="shrink-0 space-y-1.5 border-t border-[var(--border-color)] p-2.5">
        <button onClick={() => void create(false)} disabled={!title.trim() || busy} className="w-full rounded-md bg-[var(--accent)] px-2 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-40">创建空白</button>
        <button onClick={() => void create(true)} disabled={!title.trim() || busy} className="w-full rounded-md border border-[var(--border-color)] px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40">AI 拆解</button>
      </div>
    </div>
  )
}

function ExistingWorkflow({ workflow, tags, onChanged, onDeleted }: { workflow: ScheduleWorkflow; tags: ScheduleTag[]; onChanged: () => void; onDeleted: () => void }) {
  const { openWorkflow } = useScheduleUi()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const progress = workflowProgress(workflow)

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action()
      showToast({ type: 'success', message })
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '操作失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  function updateStage(stageId: string, patch: Parameters<typeof updateScheduleWorkflowStage>[2], toast?: string) {
    void run(() => updateScheduleWorkflowStage(workflow.id, stageId, patch), toast || '阶段已更新')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <input
          key={`title:${workflow.id}:${workflow.updatedAt}`}
          defaultValue={workflow.title}
          onBlur={e => {
            const title = e.target.value.trim()
            if (title && title !== workflow.title) void run(() => updateScheduleWorkflow(workflow.id, { title }), '标题已更新')
          }}
          className="w-full bg-transparent text-[15px] font-medium text-[var(--text-primary)] outline-none"
        />
        <div className="mt-1 flex items-center gap-2 text-[10.5px] text-[var(--text-muted)]">
          <span>{workflow.start} → {workflow.end}</span>
          <span>·</span>
          <span>{progress.total === 0 ? '待规划' : `${progress.done}/${progress.total}`}</span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">开始</span>
            <input type="date" value={workflow.start} onChange={e => { if (e.target.value) void run(() => updateScheduleWorkflow(workflow.id, { start: e.target.value }), '范围已更新') }} className={FIELD} />
          </label>
          <label>
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">结束</span>
            <input type="date" value={workflow.end} onChange={e => { if (e.target.value) void run(() => updateScheduleWorkflow(workflow.id, { end: e.target.value }), '范围已更新') }} className={FIELD} />
          </label>
          <label className="col-span-2">
            <span className="mb-1 block text-[10.5px] text-[var(--text-muted)]">标签</span>
            <select
              value={workflow.tagId || ''}
              onChange={e => {
                const tag = tags.find(t => t.id === e.target.value) ?? null
                void run(() => updateScheduleWorkflow(workflow.id, { tagId: tag?.id || null, color: tag?.color }), '标签已更新')
              }}
              className={FIELD}
            >
              <option value="">无</option>
              {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10.5px] font-medium text-[var(--text-muted)]">阶段 · {workflow.stages.length}</span>
            <span className="text-[10px] text-[var(--text-disabled)]">日期自动顺延</span>
          </div>
          <div className="space-y-1.5">
            {workflow.stages.map((stage, index) => (
              <div key={stage.id} className="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-2">
                <div className="flex items-start gap-1.5">
                  <button
                    onClick={() => updateStage(stage.id, { status: nextStatus(stage.status) }, '阶段状态已更新')}
                    title={statusLabel(stage.status)}
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${stage.status === 'done' ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : stage.status === 'doing' ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-[var(--text-disabled)] text-transparent'}`}
                  >
                    <Check size={10} strokeWidth={3} />
                  </button>
                  <input
                    key={`${stage.id}:${stage.title}`}
                    defaultValue={stage.title}
                    onBlur={e => {
                      const title = e.target.value.trim()
                      if (title && title !== stage.title) updateStage(stage.id, { title }, '阶段标题已更新')
                    }}
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none"
                  />
                  <button onClick={() => void run(() => deleteScheduleWorkflowStage(workflow.id, stage.id), '阶段已删除')} className="text-[var(--text-disabled)] hover:text-[var(--danger)]"><Trash2 size={11} /></button>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <input type="date" value={stage.start} onChange={e => { if (e.target.value) updateStage(stage.id, { start: e.target.value }, '阶段日期已更新，后续阶段已顺延') }} className={FIELD} />
                  <input type="date" value={stage.end} onChange={e => { if (e.target.value) updateStage(stage.id, { end: e.target.value }, '阶段日期已更新，后续阶段已顺延') }} className={FIELD} />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                  <span>第 {index + 1} 段 · {stageDuration(stage)} 天</span>
                  <label className="inline-flex items-center gap-1"><input type="checkbox" checked={stage.milestone} onChange={e => updateStage(stage.id, { milestone: e.target.checked }, '里程碑已更新')} />里程碑</label>
                </div>
                <div className="mt-1 space-y-1 border-l border-[var(--border-color)] pl-2">
                  {stage.checkpoints.map(cp => (
                    <div key={cp.id} className="flex items-center gap-1">
                      <button onClick={() => void run(() => updateScheduleWorkflowCheckpoint(workflow.id, stage.id, cp.id, { status: nextStatus(cp.status) }), '检查点已更新')} className={`h-1.5 w-1.5 shrink-0 rounded-full ${cp.status === 'done' ? 'bg-[var(--accent)]' : cp.status === 'doing' ? 'bg-[var(--warning)]' : 'bg-[var(--text-disabled)]'}`} />
                      <input
                        key={`${cp.id}:${cp.title}`}
                        defaultValue={cp.title}
                        onBlur={e => {
                          const title = e.target.value.trim()
                          if (title && title !== cp.title) void run(() => updateScheduleWorkflowCheckpoint(workflow.id, stage.id, cp.id, { title }), '检查点已更新')
                        }}
                        className="min-w-0 flex-1 bg-transparent text-[10.5px] text-[var(--text-secondary)] outline-none"
                      />
                      <span className="text-[9.5px] text-[var(--text-disabled)]">{cp.start.slice(5)}</span>
                      <button onClick={() => void run(() => deleteScheduleWorkflowCheckpoint(workflow.id, stage.id, cp.id), '检查点已删除')} className="text-[var(--text-disabled)] hover:text-[var(--danger)]"><Trash2 size={9} /></button>
                    </div>
                  ))}
                  <button onClick={() => void run(() => addScheduleWorkflowCheckpoint(workflow.id, stage.id, { title: '检查点' }), '已添加检查点')} className="inline-flex items-center gap-0.5 text-[10px] text-[var(--text-disabled)] hover:text-[var(--accent)]"><Plus size={9} />检查点</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-[var(--border-color)] p-2.5">
        <button onClick={() => void run(() => addScheduleWorkflowStage(workflow.id, {}), '已添加阶段')} className="w-full rounded-md border border-[var(--border-color)] px-2 py-1.5 text-[11.5px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">添加阶段</button>
        <div className="grid grid-cols-2 gap-1.5">
          <button onClick={() => { openWorkflow(workflow.id); requestScheduleOpenCanvas(workflow.id) }} className="inline-flex items-center justify-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"><GitBranch size={11} />画布</button>
          <button onClick={requestScheduleOpenCalendar} className="inline-flex items-center justify-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1.5 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"><CalendarRange size={11} />日历</button>
        </div>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 text-[10.5px] text-[var(--danger)]">删除工作流？任务会保留。</span>
            <button onClick={() => setConfirmDelete(false)} className="rounded px-1.5 py-1 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]">取消</button>
            <button onClick={() => void run(async () => { await deleteScheduleWorkflow(workflow.id); onDeleted() }, '工作流已删除')} className="rounded bg-[var(--danger)] px-1.5 py-1 text-[10.5px] text-white">删除</button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] hover:text-[var(--danger)]"><Trash2 size={11} />删除工作流</button>
        )}
      </div>
    </div>
  )
}
