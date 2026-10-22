import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ScheduleRecurring, ScheduleTag, ScheduleTodo, ScheduleWorkflow } from '../../types'
import { registerAssistantContext } from '../../lib/assistantContext'
import {
  createScheduleTag, deleteScheduleTag, deleteScheduleTodo, getAllScheduleTodos, getScheduleTags,
  getSetting, listScheduleWorkflows, scheduleRecurringList, scheduleRecurringSettle,
  scheduleRecurringUndoSettle, setSetting, updateScheduleTodo,
} from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'
import { showToast } from '../../lib/toast'
import { ResizablePanel } from '../../components/shared/ResizablePanel'
import { useScheduleUi } from './ScheduleUiContext'
import { ScheduleSidebar } from './components/ScheduleSidebar'
import { TagManageModal } from './components/TagManageModal'
import { TodayView } from './views/TodayView'
import { TaskListView } from './views/TaskListView'
import { WorkflowListView } from './views/WorkflowListView'
import { WorkflowCanvasView } from './views/WorkflowCanvasView'
import { CalendarView } from './views/CalendarView'
import type { CalendarMode, ScheduleView } from './types'
import {
  SCHEDULE_NEW_TASK_EVENT, SCHEDULE_OPEN_CALENDAR_EVENT, SCHEDULE_OPEN_CANVAS_EVENT,
  SCHEDULE_OPEN_WEEK_EVENT,
} from './shared'

interface Props {
  isActive?: boolean
  sidebarOpen?: boolean
  sidebarWidths?: Record<string, number>
  onSnapCloseSidebar?: () => void
  onSnapOpenSidebar?: () => void
  sidebarEl?: HTMLElement | null
  sidebarHosted?: boolean
}

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isView(value: unknown): value is ScheduleView {
  return value === 'today' || value === 'inbox' || value === 'upcoming' || value === 'calendar'
    || value === 'workflows' || value === 'done' || value === 'tag'
}

function isCalendarMode(value: unknown): value is CalendarMode {
  return value === 'day' || value === 'week' || value === 'month' || value === 'quarter'
}

export function ScheduleModule({ isActive = true, sidebarOpen = true, sidebarWidths = {} as Record<string, number>, onSnapCloseSidebar, onSnapOpenSidebar, sidebarEl = null, sidebarHosted = false }: Props) {
  const { state, openTask, openWorkflow, openNewWorkflow, clearSelection } = useScheduleUi()
  const today = todayLocal()
  const [view, setView] = useState<ScheduleView>('today')
  const [calendarMode, setCalendarMode] = useState<CalendarMode>('week')
  const [calendarDate, setCalendarDate] = useState(today)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [canvasFlowId, setCanvasFlowId] = useState<string | null>(null)
  const [canvasReturnView, setCanvasReturnView] = useState<ScheduleView>('workflows')
  const [tasks, setTasks] = useState<ScheduleTodo[]>([])
  const [workflows, setWorkflows] = useState<ScheduleWorkflow[]>([])
  const [tags, setTags] = useState<ScheduleTag[]>([])
  const [recurring, setRecurring] = useState<ScheduleRecurring[]>([])
  const [focusSignal, setFocusSignal] = useState(0)
  const [dataLoaded, setDataLoaded] = useState(false)
  const [tagManageOpen, setTagManageOpen] = useState(false)
  const [settingsReady, setSettingsReady] = useState(false)
  const settledRef = useRef(false)

  const refreshRecurring = useCallback(async () => {
    try { setRecurring(await scheduleRecurringList()) } catch { /* ignore */ }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [nextTasks, nextWorkflows, nextTags] = await Promise.all([
        getAllScheduleTodos(), listScheduleWorkflows(), getScheduleTags(),
      ])
      setTasks(nextTasks)
      setWorkflows(nextWorkflows)
      setTags(nextTags)
      setDataLoaded(true)
    } catch (e) {
      console.error('[schedule] refresh failed', e)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [savedView, savedMode] = await Promise.all([getSetting('scheduleView'), getSetting('scheduleCalendarMode')])
        if (isView(savedView)) setView(savedView)
        if (isCalendarMode(savedMode)) setCalendarMode(savedMode)
      } catch { /* ignore */ }
      setSettingsReady(true)
      await Promise.all([refresh(), refreshRecurring()])
    })()
  }, [refresh, refreshRecurring])

  useDataChanged('schedule', () => { void refresh(); void refreshRecurring() })

  useEffect(() => {
    if (isActive) void refresh()
  }, [isActive, refresh])

  useEffect(() => {
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    if (settledRef.current) return
    settledRef.current = true
    void (async () => {
      try {
        const result = await scheduleRecurringSettle()
        if (result.added > 0) {
          const ids = result.items.map(i => i.id)
          showToast({
            type: 'success',
            duration: 9000,
            message: `已生成固定日程 ${result.added} 项`,
            action: {
              label: '撤销',
              onClick: () => { void (async () => { await scheduleRecurringUndoSettle(ids, result.restore).catch(() => {}); await refresh() })() },
            },
          })
          await refresh()
        }
      } catch { /* vault may not be open yet */ }
    })()
  }, [refresh])

  useEffect(() => {
    const openTaskView = () => {
      setView('today')
      setFocusSignal(v => v + 1)
    }
    const openWeek = () => {
      setView('calendar')
      setCalendarMode('week')
    }
    const openCanvas = (e: Event) => {
      const id = (e as CustomEvent<{ workflowId?: string }>).detail?.workflowId
      if (!id) return
      setCanvasReturnView('workflows')
      setCanvasFlowId(id)
      setView('canvas')
      openWorkflow(id)
    }
    const openCalendar = () => setView('calendar')
    window.addEventListener('schedule-new-task', openTaskView)
    window.addEventListener(SCHEDULE_NEW_TASK_EVENT, openTaskView)
    window.addEventListener(SCHEDULE_OPEN_WEEK_EVENT, openWeek)
    window.addEventListener(SCHEDULE_OPEN_CANVAS_EVENT, openCanvas)
    window.addEventListener(SCHEDULE_OPEN_CALENDAR_EVENT, openCalendar)
    return () => {
      window.removeEventListener('schedule-new-task', openTaskView)
      window.removeEventListener(SCHEDULE_NEW_TASK_EVENT, openTaskView)
      window.removeEventListener(SCHEDULE_OPEN_WEEK_EVENT, openWeek)
      window.removeEventListener(SCHEDULE_OPEN_CANVAS_EVENT, openCanvas)
      window.removeEventListener(SCHEDULE_OPEN_CALENDAR_EVENT, openCalendar)
    }
  }, [openWorkflow])

  useEffect(() => {
    if (dataLoaded && view === 'canvas' && canvasFlowId && !workflows.some(w => w.id === canvasFlowId)) {
      setView(canvasReturnView)
      setCanvasFlowId(null)
      clearSelection()
    }
  }, [dataLoaded, view, canvasFlowId, workflows, canvasReturnView, clearSelection])

  useEffect(() => {
    if (!settingsReady || view === 'canvas' || view === 'tag') return
    void setSetting('scheduleView', view).catch(() => {})
  }, [view, settingsReady])

  useEffect(() => {
    if (!settingsReady) return
    void setSetting('scheduleCalendarMode', calendarMode).catch(() => {})
  }, [calendarMode, settingsReady])

  useEffect(() => {
    return registerAssistantContext(() => {
      const selectedTask = state.taskId ? tasks.find(t => t.id === state.taskId) : null
      const selectedWorkflow = state.workflowId ? workflows.find(w => w.id === state.workflowId) : null
      if (selectedTask) {
        const flow = workflows.find(w => w.taskId === selectedTask.id)
        return {
          type: 'schedule.task',
          label: `任务：${selectedTask.title}`,
          data: {
            task: {
              id: selectedTask.id,
              title: selectedTask.title,
              date: selectedTask.date,
              status: selectedTask.status,
              workflowId: flow?.id ?? null,
            },
          },
        }
      }
      if (selectedWorkflow) {
        return {
          type: 'schedule.workflow',
          label: `工作流：${selectedWorkflow.title}`,
          data: {
            workflow: {
              id: selectedWorkflow.id,
              title: selectedWorkflow.title,
              stages: selectedWorkflow.stages.map(s => ({ id: s.id, title: s.title, status: s.status, start: s.start, end: s.end })),
              progress: selectedWorkflow.stages.length === 0 ? 0 : Math.round(selectedWorkflow.stages.filter(s => s.status === 'done').length / selectedWorkflow.stages.length * 100),
            },
          },
        }
      }
      return {
        type: 'schedule.day',
        label: `日程 ${today}（${tasks.filter(t => t.date === today).length} 条待办）`,
        data: {
          date: today,
          todos: tasks.filter(t => t.date === today).slice(0, 30).map(t => ({ id: t.id, title: t.title, status: t.status, time: t.time ?? null })),
        },
      }
    })
  }, [state.taskId, state.workflowId, tasks, workflows, today])

  const selectedWorkflow = useMemo(() => canvasFlowId ? workflows.find(w => w.id === canvasFlowId) ?? null : null, [canvasFlowId, workflows])

  const counts = useMemo(() => ({
    today: tasks.filter(t => t.status !== 'done' && t.date === today).length,
    inbox: tasks.filter(t => t.status !== 'done' && t.date === '').length,
    upcoming: tasks.filter(t => t.status !== 'done' && !!t.date && t.date > today).length,
    workflows: workflows.filter(w => w.stages.length === 0 || w.stages.some(s => s.status !== 'done')).length,
    done: tasks.filter(t => t.status === 'done').length,
  }), [tasks, workflows, today])

  const openWorkflowCanvas = useCallback((id: string) => {
    setCanvasReturnView(view === 'canvas' ? canvasReturnView : view)
    setCanvasFlowId(id)
    setView('canvas')
    openWorkflow(id)
  }, [view, canvasReturnView, openWorkflow])

  const handleToggle = useCallback(async (task: ScheduleTodo) => {
    try {
      await updateScheduleTodo(task.id, { status: task.status === 'done' ? 'pending' : 'done' })
    } catch (e) {
      showToast({ type: 'error', message: '更新任务失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  const handleDelete = useCallback(async (task: ScheduleTodo) => {
    try {
      await deleteScheduleTodo(task.id)
      if (state.taskId === task.id) clearSelection()
      showToast({ type: 'success', message: '任务已删除' })
    } catch (e) {
      showToast({ type: 'error', message: '删除任务失败', detail: e instanceof Error ? e.message : String(e) })
    }
  }, [state.taskId, clearSelection])

  const handleCreateTag = useCallback(async (name: string, color: string) => {
    const tag = await createScheduleTag(name, color)
    setTags(await getScheduleTags())
    return tag
  }, [])

  const handleDeleteTag = useCallback(async (id: string) => {
    await deleteScheduleTag(id)
    setTags(await getScheduleTags())
  }, [])

  const sidebarInner = (
    <ScheduleSidebar
      view={view}
      activeTag={activeTag}
      tags={tags}
      counts={counts}
      recurring={recurring}
      onSelect={(next) => {
        if (next === 'workflows') {
          setView('workflows')
          return
        }
        if (next === 'calendar') {
          setView('calendar')
          return
        }
        setView(next)
      }}
      onSelectTag={(tagId) => {
        setActiveTag(tagId)
        setView('tag')
      }}
      onNewTask={() => {
        setView('today')
        setFocusSignal(v => v + 1)
      }}
      onManageTags={() => setTagManageOpen(true)}
      onReloadRecurring={refreshRecurring}
    />
  )

  const sidebar = sidebarEl
    ? createPortal(sidebarOpen ? sidebarInner : null, sidebarEl)
    : sidebarHosted
      ? null
      : (
        <ResizablePanel storageKey="sidebarWidth_schedule" defaultWidth={240} minWidth={180} maxWidth={420} visible={sidebarOpen} initialWidth={sidebarWidths.sidebarWidth_schedule} onSnapClose={onSnapCloseSidebar} onSnapOpen={onSnapOpenSidebar}>
          {sidebarInner}
        </ResizablePanel>
      )

  return (
    <div className="kb-theme-surface flex h-full min-h-0">
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div key={`${view}:${canvasFlowId ?? ''}`} className="kb-view-in min-h-0 flex-1">
          {view === 'today' ? (
            <TodayView
              today={today}
              tasks={tasks}
              tags={tags}
              workflows={workflows}
              focusSignal={focusSignal}
              onOpenTask={task => openTask(task.id)}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onChanged={() => { void refresh() }}
            />
          ) : view === 'inbox' || view === 'upcoming' || view === 'done' || view === 'tag' ? (
            <TaskListView
              view={view}
              activeTag={activeTag}
              today={today}
              tasks={tasks}
              tags={tags}
              workflows={workflows}
              onOpenTask={task => openTask(task.id)}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onChanged={() => { void refresh() }}
            />
          ) : view === 'workflows' ? (
            <WorkflowListView workflows={workflows} tasks={tasks} tags={tags} today={today} onOpen={openWorkflowCanvas} />
          ) : view === 'canvas' ? (
            selectedWorkflow ? (
              <WorkflowCanvasView
                workflow={selectedWorkflow}
                onBack={() => { setView(canvasReturnView); setCanvasFlowId(null) }}
                onOpenPanel={openWorkflow}
                onChanged={() => { void refresh() }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">工作流不存在</div>
            )
          ) : (
            <CalendarView
              mode={calendarMode}
              date={calendarDate}
              tasks={tasks}
              workflows={workflows}
              tags={tags}
              onModeChange={setCalendarMode}
              onDateChange={setCalendarDate}
              onOpenTask={task => openTask(task.id)}
              onOpenWorkflow={openWorkflowCanvas}
              onNewWorkflow={openNewWorkflow}
              onChanged={() => { void refresh() }}
            />
          )}
        </div>
      </div>

      <TagManageModal
        open={tagManageOpen}
        tags={tags}
        onClose={() => setTagManageOpen(false)}
        onCreateTag={handleCreateTag}
        onDeleteTag={handleDeleteTag}
      />
    </div>
  )
}
