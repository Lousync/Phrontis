import { ipcMain } from 'electron'
import { broadcast, BROADCAST_CHANNEL } from './windowBus'

/**
 * 番茄钟状态跨窗口中转（轻量版）。
 *
 * 番茄钟的状态机仍由渲染层 `usePomodoroState` 维护（避免大改 PomodoroContext / PomodoroPanel），
 * 但状态会同步到主进程作为权威快照，主进程再广播给所有 BrowserWindow，让 popout（独立 BrowserWindow）
 * 也能看到倒计时与状态。popout 端的 PomodoroProvider 走被动模式（`passive`），不调 usePomodoroState
 * 避免多计时器，状态从 IPC 接收后通过 prop 注入 DayPanel。
 *
 * 权威仍在主窗口：主窗口的 PomodoroProvider 启动时拉取一次最新快照（兼容重启场景），
 * 之后 setState → 同步 → 广播；popout 端只接收不发送，避免循环。
 */

export interface PomodoroSnapshot {
  visible: boolean
  display: string
  running: boolean
  phase: 'work' | 'short-break' | 'long-break' | string
  done: boolean
  expanded: boolean
  /** 当前阶段已完成比例 0→1（usePomodoroState: 1 - seconds/totalSeconds），供进度条渲染 */
  progress: number
}

let snapshot: PomodoroSnapshot = {
  visible: false,
  display: '00:00',
  running: false,
  phase: 'work',
  done: false,
  expanded: false,
  progress: 0,
}

function broadcastToAll(payload: PomodoroSnapshot): void {
  broadcast(BROADCAST_CHANNEL.pomodoroStateBroadcast, payload)
}

export function registerPomodoroBroadcast(): void {
  // 渲染层（主窗口 PomodoroProvider）上报状态变化 → 主进程更新快照并广播给所有窗口
  ipcMain.on('pomodoro:state-update', (_e, payload: Partial<PomodoroSnapshot>) => {
    if (!payload || typeof payload !== 'object') return
    snapshot = { ...snapshot, ...payload }
    broadcastToAll(snapshot)
  })
  // 渲染层（popout 启动时）拉取最新快照，避免每次开窗都从默认值开始显示
  ipcMain.handle('pomodoro:get-state', () => snapshot)
}
