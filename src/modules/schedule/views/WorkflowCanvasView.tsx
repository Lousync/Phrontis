import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Crosshair, GitBranch, Minus, Plus } from 'lucide-react'
import type { ScheduleWorkflow } from '../../../types'
import { addScheduleWorkflowStage, reorderScheduleWorkflowStages, restoreScheduleWorkflow } from '../../../lib/ipc'
import { showToast } from '../../../lib/toast'
import { workflowProgress } from '../workflowPure'

const CARD_W = 220
const CARD_H = 132
const STAGE_GAP = 280
const ROOT_X = 60
const STAGE_X0 = 360
const STAGE_Y = 198
const CP_GAP = 44

interface Props {
  workflow: ScheduleWorkflow
  onBack: () => void
  onOpenPanel: (workflowId: string) => void
  onChanged: () => void
}

interface DragState {
  id: string
  startX: number
  dx: number
  target: number
}

function statusColor(status: string): string {
  if (status === 'done') return 'var(--success, #22c55e)'
  if (status === 'doing') return 'var(--accent)'
  return 'var(--text-disabled)'
}

export function WorkflowCanvasView({ workflow, onBack, onOpenPanel, onChanged }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [pan, setPan] = useState({ x: 20, y: 20 })
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const panRef = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null)
  const lastCount = useRef(workflow.stages.length)
  const progress = workflowProgress(workflow)
  const stageCount = workflow.stages.length
  const cpMax = useMemo(() => workflow.stages.reduce((m, s) => Math.max(m, s.checkpoints.length), 0), [workflow.stages])
  const contentW = STAGE_X0 + Math.max(1, stageCount) * STAGE_GAP + CARD_W + 80
  const contentH = STAGE_Y + CARD_H + cpMax * CP_GAP + 100

  const fit = useCallback(() => {
    const el = wrapRef.current
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w < 40 || h < 40) return
    const next = Math.max(0.55, Math.min(1, (w - 48) / contentW, (h - 48) / contentH))
    setScale(next)
    setPan({ x: 24, y: Math.max(16, (h - contentH * next) / 2) })
  }, [contentW, contentH])

  useEffect(() => {
    const raf = requestAnimationFrame(fit)
    const el = wrapRef.current
    if (!el) return () => cancelAnimationFrame(raf)
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [workflow.id, fit])

  useEffect(() => {
    if (stageCount > lastCount.current && stageCount > 0) {
      const el = wrapRef.current
      if (el) {
        const targetX = STAGE_X0 + (stageCount - 1) * STAGE_GAP
        setPan({ x: Math.max(24, el.clientWidth / 2 - targetX * scale), y: pan.y })
      }
    }
    lastCount.current = stageCount
  }, [stageCount, scale, pan.y])

  function zoom(delta: number) {
    setScale(prev => Math.max(0.35, Math.min(1.8, prev + delta)))
  }

  function stageX(index: number): number {
    return STAGE_X0 + index * STAGE_GAP
  }

  function onCardPointerDown(e: React.PointerEvent, id: string, index: number) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const next = { id, startX: e.clientX, dx: 0, target: index }
    dragRef.current = next
    setDrag(next)
  }

  function onCardPointerMove(e: React.PointerEvent, index: number) {
    const current = dragRef.current
    if (!current) return
    e.stopPropagation()
    const dx = e.clientX - current.startX
    const target = Math.max(0, Math.min(stageCount, Math.round((stageX(index) + dx / scale - STAGE_X0) / STAGE_GAP)))
    const next = { ...current, dx, target }
    dragRef.current = next
    setDrag(next)
  }

  async function onCardPointerUp(e: React.PointerEvent) {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!current) return
    e.stopPropagation()
    if (Math.abs(current.dx) < 8) {
      onOpenPanel(workflow.id)
      return
    }
    const originalIndex = workflow.stages.findIndex(s => s.id === current.id)
    if (current.target === originalIndex || current.target === originalIndex + 1) return
    const snapshot = workflow
    const ids = snapshot.stages.map(s => s.id).filter(id => id !== current.id)
    const insertAt = current.target > originalIndex ? current.target - 1 : current.target
    ids.splice(insertAt, 0, current.id)
    try {
      await reorderScheduleWorkflowStages(workflow.id, ids)
      showToast({
        type: 'success',
        message: '已调整顺序，日期已顺延',
        action: {
          label: '撤销',
          onClick: () => {
            void restoreScheduleWorkflow(snapshot).then(() => onChanged()).catch((e) => {
              showToast({ type: 'error', message: '撤销失败', detail: e instanceof Error ? e.message : String(e) })
            })
          },
        },
      })
      onChanged()
    } catch (err) {
      showToast({ type: 'error', message: '调整顺序失败', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    panRef.current = { startX: e.clientX, startY: e.clientY, x: pan.x, y: pan.y }
  }

  function onBackgroundPointerMove(e: React.PointerEvent) {
    const p = panRef.current
    if (!p) return
    setPan({ x: p.x + e.clientX - p.startX, y: p.y + e.clientY - p.startY })
  }

  function onBackgroundPointerUp() {
    panRef.current = null
  }

  async function addStage() {
    try {
      await addScheduleWorkflowStage(workflow.id, { title: `阶段 ${stageCount + 1}` })
      showToast({ type: 'success', message: '已添加阶段' })
      onChanged()
    } catch (e) {
      showToast({ type: 'error', message: '添加阶段失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const dragIndex = drag ? workflow.stages.findIndex(s => s.id === drag.id) : -1

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-color)] px-4 py-2">
        <button onClick={onBack} title="返回工作流列表" className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
          <ArrowLeft size={15} />
        </button>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: workflow.color }} />
          <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">{workflow.title}</span>
          <span className="shrink-0 text-[10.5px] text-[var(--text-muted)]">{workflow.start} → {workflow.end}</span>
        </div>
        <span className="rounded-full bg-[var(--bg-secondary)] px-2 py-0.5 text-[10.5px] text-[var(--text-muted)]">{progress.total === 0 ? '待规划' : `${progress.done}/${progress.total} · ${progress.pct}%`}</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={addStage} className="inline-flex items-center gap-1 rounded-md border border-[var(--border-color)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]">
            <Plus size={12} /> 添加阶段
          </button>
          <button onClick={fit} title="适应画布" className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"><Crosshair size={14} /></button>
          <button onClick={() => zoom(-0.1)} title="缩小" className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Minus size={14} /></button>
          <span className="w-10 text-center text-[10.5px] tabular-nums text-[var(--text-muted)]">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(0.1)} title="放大" className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><Plus size={14} /></button>
        </div>
      </div>

      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-[var(--bg-primary)] active:cursor-grabbing"
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onBackgroundPointerMove}
        onPointerUp={onBackgroundPointerUp}
        onPointerCancel={onBackgroundPointerUp}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return
          e.preventDefault()
          zoom(e.deltaY > 0 ? -0.08 : 0.08)
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: contentW, height: contentH, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        >
          <svg className="pointer-events-none absolute inset-0" width={contentW} height={contentH}>
            {workflow.stages[0] && (
              <path
                d={`M ${ROOT_X + CARD_W} ${STAGE_Y + CARD_H / 2} C ${ROOT_X + CARD_W + 50} ${STAGE_Y + CARD_H / 2}, ${stageX(0) - 50} ${STAGE_Y + CARD_H / 2}, ${stageX(0)} ${STAGE_Y + CARD_H / 2}`}
                fill="none" stroke="var(--border-color)" strokeWidth="2"
              />
            )}
            {workflow.stages.slice(0, -1).map((_, i) => (
              <path
                key={i}
                d={`M ${stageX(i) + CARD_W} ${STAGE_Y + CARD_H / 2} L ${stageX(i + 1)} ${STAGE_Y + CARD_H / 2}`}
                fill="none" stroke="var(--border-color)" strokeWidth="2"
              />
            ))}
            {workflow.stages.flatMap((s, i) => s.checkpoints.map((cp, ci) => (
              <path
                key={cp.id}
                d={`M ${stageX(i) + 30} ${STAGE_Y + CARD_H} L ${stageX(i) + 30} ${STAGE_Y + CARD_H + 28 + ci * CP_GAP + 17}`}
                fill="none" stroke="var(--border-color)" strokeWidth="1.5" strokeDasharray="4 4"
              />
            )))}
          </svg>

          <div
            className="absolute flex flex-col rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 shadow-sm"
            style={{ left: ROOT_X, top: STAGE_Y, width: CARD_W, height: CARD_H, borderLeft: `4px solid ${workflow.color}` }}
          >
            <div className="flex items-center gap-1.5">
              <GitBranch size={13} style={{ color: workflow.color }} />
              <span className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{workflow.title}</span>
            </div>
            <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">{workflow.start} → {workflow.end}</div>
            <div className="mt-auto">
              <div className="mb-1 flex justify-between text-[10px] text-[var(--text-muted)]"><span>进度</span><span>{progress.pct}%</span></div>
              <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                <div className="h-full rounded-full" style={{ width: `${progress.pct}%`, backgroundColor: workflow.color }} />
              </div>
            </div>
          </div>

          {workflow.stages.map((stage, i) => {
            const dragging = drag?.id === stage.id
            const x = stageX(i) + (dragging ? drag.dx / scale : 0)
            return (
              <div key={stage.id}>
                <div
                  onPointerDown={(e) => onCardPointerDown(e, stage.id, i)}
                  onPointerMove={(e) => onCardPointerMove(e, i)}
                  onPointerUp={(e) => { void onCardPointerUp(e) }}
                  onPointerCancel={() => { dragRef.current = null; setDrag(null) }}
                  className={`absolute flex touch-none select-none flex-col rounded-xl border bg-[var(--bg-secondary)] p-3 shadow-sm transition-colors hover:border-[var(--accent)]/60 ${dragging ? 'z-20 cursor-grabbing shadow-lg' : 'cursor-grab'} ${stage.status === 'done' ? 'opacity-75' : ''}`}
                  style={{
                    left: x,
                    top: STAGE_Y,
                    width: CARD_W,
                    height: CARD_H,
                    borderColor: dragging ? 'var(--accent)' : 'var(--border-color)',
                    borderLeft: `4px solid ${statusColor(stage.status)}`,
                  }}
                  title="拖动调整顺序，点击打开右栏"
                >
                  <div className="flex items-start gap-1.5">
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColor(stage.status) }} />
                    <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-[var(--text-primary)]">{stage.title}</span>
                    {stage.milestone && <Check size={12} className="mt-0.5 shrink-0 text-[var(--warning)]" />}
                  </div>
                  <div className="mt-1 text-[10.5px] text-[var(--text-muted)]">{stage.start} → {stage.end}</div>
                  <div className="mt-auto flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                    <span>{stage.status === 'done' ? '已完成' : stage.status === 'doing' ? '进行中' : '未开始'}</span>
                    <span>{stage.checkpoints.length > 0 ? `${stage.checkpoints.length} 检查点` : ''}</span>
                  </div>
                </div>

                {stage.checkpoints.map((cp, ci) => (
                  <button
                    key={cp.id}
                    onClick={() => onOpenPanel(workflow.id)}
                    className="absolute flex items-center gap-1.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 text-left text-[10.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]"
                    style={{ left: stageX(i) + 30, top: STAGE_Y + CARD_H + 28 + ci * CP_GAP, width: 180, height: 34 }}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor(cp.status) }} />
                    <span className="truncate">{cp.title}</span>
                  </button>
                ))}
              </div>
            )
          })}

          {drag && dragIndex >= 0 && (
            <div
              className="pointer-events-none absolute z-30 rounded-full bg-[var(--accent)]"
              style={{ left: drag.target >= stageCount ? stageX(stageCount - 1) + CARD_W + 18 : stageX(drag.target) - 12, top: STAGE_Y - 8, width: 3, height: CARD_H + 16 }}
            />
          )}
        </div>

        {stageCount === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-dashed border-[var(--border-color)] bg-[var(--bg-secondary)]/90 px-4 py-3 text-[11.5px] text-[var(--text-muted)]">
              还没有阶段
              <button onClick={addStage} className="text-[var(--accent)] hover:underline">添加第一个阶段</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
