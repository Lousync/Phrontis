import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { parseWorkbenchLayout } from '../../lib/workbenchLayout'
import { useSettings } from '../../lib/SettingsContext'

export type SchedulePanelTab = 'task' | 'workflow' | 'ai'

interface ScheduleUiState {
  panelTab: SchedulePanelTab
  taskId: string | null
  workflowId: string | null
  newWorkflow: boolean
}

interface ScheduleUiApi {
  state: ScheduleUiState
  setPanelTab: (tab: SchedulePanelTab) => void
  openTask: (taskId: string) => void
  openWorkflow: (workflowId: string) => void
  openNewWorkflow: () => void
  openAi: () => void
  clearSelection: () => void
}

const ScheduleUiContext = createContext<ScheduleUiApi | null>(null)

export function ScheduleUiProvider({ children }: { children: ReactNode }) {
  const { s, update } = useSettings()
  const [state, setState] = useState<ScheduleUiState>({
    panelTab: 'task',
    taskId: null,
    workflowId: null,
    newWorkflow: false,
  })

  const revealPanel = useCallback(() => {
    const layout = parseWorkbenchLayout(s.workbenchLayout)
    if (layout.rightTab === 'schedule' && !layout.rightCollapsed) return
    update('workbenchLayout', JSON.stringify({ ...layout, rightTab: 'schedule', rightCollapsed: false }))
  }, [s.workbenchLayout, update])

  const openTask = useCallback((taskId: string) => {
    setState({ panelTab: 'task', taskId, workflowId: null, newWorkflow: false })
    revealPanel()
  }, [revealPanel])

  const openWorkflow = useCallback((workflowId: string) => {
    setState({ panelTab: 'workflow', taskId: null, workflowId, newWorkflow: false })
    revealPanel()
  }, [revealPanel])

  const openNewWorkflow = useCallback(() => {
    setState({ panelTab: 'workflow', taskId: null, workflowId: null, newWorkflow: true })
    revealPanel()
  }, [revealPanel])

  const openAi = useCallback(() => {
    setState(prev => ({ ...prev, panelTab: 'ai', newWorkflow: false }))
    revealPanel()
  }, [revealPanel])

  const setPanelTab = useCallback((panelTab: SchedulePanelTab) => {
    setState(prev => ({ ...prev, panelTab, newWorkflow: false }))
  }, [])

  const clearSelection = useCallback(() => {
    setState(prev => ({ ...prev, taskId: null, workflowId: null, newWorkflow: false }))
  }, [])

  const api = useMemo<ScheduleUiApi>(() => ({
    state,
    setPanelTab,
    openTask,
    openWorkflow,
    openNewWorkflow,
    openAi,
    clearSelection,
  }), [state, setPanelTab, openTask, openWorkflow, openNewWorkflow, openAi, clearSelection])

  return <ScheduleUiContext.Provider value={api}>{children}</ScheduleUiContext.Provider>
}

export function useScheduleUi(): ScheduleUiApi {
  const ctx = useContext(ScheduleUiContext)
  if (!ctx) throw new Error('useScheduleUi must be used inside ScheduleUiProvider')
  return ctx
}
