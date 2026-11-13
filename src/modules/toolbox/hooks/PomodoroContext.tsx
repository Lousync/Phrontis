import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { usePomodoroState, BASE_PRESETS, type PomodoroState, type PomodoroPresetDef } from './usePomodoroState'
import { getPluginPomodoroPresets } from '../../../lib/pluginService'

type Ctx = ReturnType<typeof usePomodoroState>

const C = createContext<Ctx | null>(null)

/** popout 端的占位 value：被动模式不持有计时器/状态，仅让 usePomodoro() 在被动 Provider 内不 throw */
function createPassivePlaceholder(): Ctx {
  const noopSetState: React.Dispatch<React.SetStateAction<PomodoroState>> = () => {}
  return {
    state: {
      visible: false, running: false, phase: 'work', done: false, expanded: false,
      presetIdx: 0, seconds: 0, topic: '', lastTopic: '', recentTopics: [],
      startedAt: null, deadlineAt: null, pendingSession: null, finishing: false,
    },
    setState: noopSetState,
    mode: 'idle',
    presets: BASE_PRESETS,
    preset: BASE_PRESETS[0],
    totalSeconds: BASE_PRESETS[0].work * 60,
    startTimer: () => false,
    pauseTimer: () => {},
    resetTimer: () => {},
    setPresetIdx: () => {},
    setTopic: () => {},
    finishWork: async () => 'ignored',
    saveRating: async () => false,
    skipRating: () => {},
    startBreak: () => {},
    skipBreak: () => {},
    startNextRound: () => false,
    activate: () => {},
    expand: () => {},
    collapse: () => {},
    hide: () => {},
    isActive: false,
    display: '00:00',
    progress: 0,
  } as unknown as Ctx
}

export function PomodoroProvider({ children, passive = false }: { children: ReactNode; passive?: boolean }) {
  // 被动模式（popout 独立窗口用）：不持有计时器，状态从 IPC 接收通过 prop 注入到子组件
  if (passive) {
    return <C.Provider value={createPassivePlaceholder()}>{children}</C.Provider>
  }

  // 主动模式（主窗口工具箱用）：权威状态机 + 同步给主进程（让 popout 也能看到倒计时）
  const [presets, setPresets] = useState<PomodoroPresetDef[]>(BASE_PRESETS)
  const loadPresets = useCallback(() => {
    getPluginPomodoroPresets()
      .then(pluginPresets => { if (pluginPresets.length > 0) setPresets([...BASE_PRESETS, ...pluginPresets]); else setPresets(BASE_PRESETS) })
      .catch(() => { /* 忽略,保持内置 */ })
  }, [])
  useEffect(() => { loadPresets() }, [loadPresets])
  // 插件模块安装/启禁/卸载后同步刷新
  useEffect(() => {
    window.addEventListener('plugins-changed', loadPresets)
    return () => window.removeEventListener('plugins-changed', loadPresets)
  }, [loadPresets])
  const pom = usePomodoroState(presets)

  // 全局激活入口：工具箱等处 dispatch 'pomodoro:activate' 启动/展开番茄钟。
  // 原由 StatusBar 监听，状态栏移除后下沉到 Provider，保证任何页面都能响应。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { preset?: number } | undefined
      if (pom.state.visible) {
        // 已激活 — 仅展开，不重置计时
        pom.setState(s => ({ ...s, expanded: true }))
      } else {
        pom.activate(detail?.preset)
      }
    }
    window.addEventListener('pomodoro:activate', handler)
    return () => window.removeEventListener('pomodoro:activate', handler)
  }, [pom])

  // 状态变化 → 同步到主进程（主进程再广播给所有窗口，让 popout 也能看到倒计时）。
  // 关键：popout 端的 PomodoroProvider 是 passive，不会走这个 useEffect → 无循环。
  useEffect(() => {
    if (!window.api?.pomodoroUpdateState) return
    const t = setTimeout(() => {
      window.api?.pomodoroUpdateState?.({
        visible: pom.state.visible,
        display: pom.display,
        running: pom.state.running,
        phase: pom.state.phase,
        done: pom.state.done,
        expanded: pom.state.expanded,
        progress: pom.progress,
      })
    }, 200)
    return () => clearTimeout(t)
  }, [pom.state.visible, pom.display, pom.state.running, pom.state.phase, pom.state.done, pom.state.expanded, pom.progress])

  return <C.Provider value={pom}>{children}</C.Provider>
}

export function usePomodoro(): Ctx {
  const ctx = useContext(C)
  if (!ctx) throw new Error('usePomodoro must be inside PomodoroProvider')
  return ctx
}

/** Re-export for convenience */
export type { PomodoroState }
