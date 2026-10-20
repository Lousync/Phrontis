import { emitPluginEvent } from './pluginEvents'
import { vaultFindTodo, vaultUpdateTodo } from './kbStore/scheduleVaultRepo'

/**
 * 待办勾选 / 取消的**唯一写入口**（桌面集成 `ToggleTodo` 与托盘菜单共用）。
 *
 * 与 IPC `schedule:updateTodo` 的分工：那条是通用编辑通道；这里是「只翻转完成态」，
 * 并补齐完成事件（插件 `schedule:todoCompleted`）—— 若绕开它直接写文件，
 * 插件侧收不到完成事件，且不会有任何报错。
 *
 * 调用方负责 `broadcastDataChanged('schedule')`（主进程侧没有「发送方窗口」，
 * 必须广播给所有窗口，否则界面看不到托盘/D-Bus 的改动）。
 *
 * @returns 是否找到并更新了该待办
 */
export function toggleTodoDone(id: string): boolean {
  const row = vaultFindTodo(id)
  if (!row) return false
  const next = row.status === 'done' ? 'pending' : 'done'
  const updated = vaultUpdateTodo(id, { status: next }, new Date().toISOString())
  if (!updated) return false
  if (next === 'done') emitPluginEvent('schedule:todoCompleted', { todoId: id, title: updated.title ?? '' })
  return true
}
