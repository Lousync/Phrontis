import { notifyCheckin } from './pushService'
import { vaultHabitRecordAddIfAbsent, vaultHabitRecordRemove, vaultRecordsAll } from './kbStore/habitVaultRepo'

/**
 * 打卡的**唯一写入实现**（IPC `habit:toggleCheck` 与桌面集成 `CheckIn` 共用）。
 *
 * 为什么单独抽出来：远程监督推送 `notifyCheckin` 挂在打卡成功之后。若 D-Bus 侧
 * 自己写 records.json，就会漏掉推送 —— 表象是「面板里打了卡，手机端没收到」，
 * 且不会有任何报错。
 *
 * @returns 是否真的改变了状态（已是目标状态 → false，调用方按幂等成功处理）
 */
export function setHabitChecked(habitId: string, date: string, checked: boolean): boolean {
  const has = vaultRecordsAll().some(r => r.habit_id === habitId && r.date === date)
  if (checked === has) return false
  if (checked) {
    vaultHabitRecordAddIfAbsent(habitId, date, 'manual')
    // 远程监督：打卡成功后异步推送（静默失败，不影响打卡本身）
    void notifyCheckin(habitId, date)
  } else {
    vaultHabitRecordRemove(habitId, date)
  }
  return true
}

/** 翻转某天打卡状态；返回翻转后的状态（托盘 / IPC 的「再点一下 = 取消打卡」） */
export function toggleHabitChecked(habitId: string, date: string): boolean {
  const has = vaultRecordsAll().some(r => r.habit_id === habitId && r.date === date)
  setHabitChecked(habitId, date, !has)
  return !has
}
