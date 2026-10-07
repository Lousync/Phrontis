import { ipcMain } from 'electron'
import * as term from '../../lib/terminalService'

/**
 * 终端模块 IPC 注册层（协议见 docs/terminal-module-design.md §3）。
 * 转发给 lib/terminalService —— 与 AI 工具共用同一实现（铁律 2 的同构约定）。
 * 写路径 term:write / term:resize 用 on（高频免回执），其余 handle。
 */
export function registerTerminalHandlers(deps: { getSettingValue: (key: string) => unknown }): void {
  ipcMain.handle('term:create', (_e, opts: { cols?: number; rows?: number; shellPref?: string } | undefined) =>
    term.createSession(opts ?? {}))

  ipcMain.handle('term:attach', (_e, id: string) => term.attach(String(id)))

  ipcMain.on('term:write', (_e, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') term.write(id, data)
  })

  ipcMain.on('term:resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    if (typeof id === 'string') term.resize(id, Number(cols), Number(rows))
  })

  ipcMain.handle('term:kill', (_e, id: string) => {
    term.kill(String(id))
    return { ok: true }
  })

  ipcMain.handle('term:list', () => ({ sessions: term.listSessions() }))

  ipcMain.handle('term:defaultShell', async () => {
    const pref = deps.getSettingValue('terminal.shell')
    const shell = term.resolveShell(typeof pref === 'string' ? pref : undefined)
    // 标签补实测版本（首次慢一拍；displayShellLabel 进程内去重缓存，之后即时）
    return { file: shell.file, label: await term.displayShellLabel(shell.file, shell.label), windowsBuildNumber: term.windowsBuildNumber() }
  })

  ipcMain.handle('term:aiRecords', () => ({ records: term.listAiRecords() }))

  ipcMain.handle('term:aiRespond', (_e, reqId: unknown, approved: unknown) => {
    if (typeof reqId === 'string') term.aiRespond(reqId, approved === true)
    return { ok: true }
  })
}
