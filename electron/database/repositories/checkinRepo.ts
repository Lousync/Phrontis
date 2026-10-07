import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { notifyCheckin } from '../../lib/pushService'
import {
  vaultHabitsAll,
  vaultHabitsSave,
  vaultRecordsAll,
  vaultRecordsSave,
  vaultHabitRecordAddIfAbsent,
  vaultHabitRecordRemove,
  type HabitRow,
} from '../../lib/kbStore/habitVaultRepo'

/**
 * R6 去库化：真相源 = .knowbase/modules/（sql.js 路径已移除，D9）
 *
 * 打卡模块：习惯 CRUD/归档/排序 + 单日打卡 toggle + 记录查询。
 * habits / habit_records 读写 `.knowbase/modules/checkin/{habits.json, records.json}`
 * （见 habitVaultRepo）。行结构=表行 snake_case 原样，SQL 语义（ORDER BY sort_order,
 * created_at、删习惯连带记录、UNIQUE(habit_id,date) 的 INSERT OR IGNORE、排序批量 UPDATE）
 * 在内存复刻。
 *
 * v3.2.0 条目 14：「习惯跨模块联动自动打卡」整条拔线（2026-09-15 开发负责人拍板
 * 「联动打卡这个功能根本就没有用，没有数据牵连放心删」）—— 联动服务 habitLinkService、
 * `habitLink:save` / `habitLink:remove` 两个 IPC、getAll 里的 link 映射全部移除。
 * 磁盘上遗留的 links.json 不再读取、不做迁移；历史自动打卡记录（records 里 source='auto'）
 * 原样保留，只是界面不再区分来源。**手动打卡与远程监督推送（habit:toggleCheck 里的
 * notifyCheckin）不受影响。**
 */

export interface HabitDto {
  id: string; name: string; color: string
  ruleType: 'daily' | 'weekdays' | 'flexible'
  ruleDays: number[]; weeklyTarget: number
  sortOrder: number; archived: boolean; createdAt: string
}

function parseDays(json: string): number[] {
  try { const v = JSON.parse(json); if (Array.isArray(v)) return v.map(Number) } catch { /* ignore */ }
  return [1, 2, 3, 4, 5]
}

function rowToHabit(row: HabitRow): HabitDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    ruleType: (row.rule_type as HabitDto['ruleType']) || 'daily',
    ruleDays: parseDays(row.rule_days),
    weeklyTarget: row.weekly_target ?? 3,
    sortOrder: row.sort_order ?? 0,
    archived: !!row.archived,
    createdAt: row.created_at,
  }
}

/** 对标 sqlite datetime('now')：UTC 'YYYY-MM-DD HH:MM:SS' */
function sqlNow(): string {
  const s = new Date().toISOString()
  return `${s.slice(0, 10)} ${s.slice(11, 19)}`
}

/** vault 行序：ORDER BY sort_order ASC, created_at ASC（created_at 按 BINARY 比较，与 sqlite 一致） */
function vaultHabitsOrdered(): HabitRow[] {
  return vaultHabitsAll().sort((a, b) =>
    ((a.sort_order ?? 0) - (b.sort_order ?? 0))
    || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
}

export function registerCheckinHandlers(): void {

  ipcMain.handle('habit:getAll', () => {
    const habits = vaultHabitsOrdered().map(rowToHabit)
    const records = vaultRecordsAll().map(r => ({
      id: r.id, habitId: r.habit_id, date: r.date, source: r.source,
    }))
    return { habits, records }
  })

  ipcMain.handle('habit:create', (_e, data: {
    name: string; color?: string; ruleType?: 'daily' | 'weekdays' | 'flexible'
    ruleDays?: number[]; weeklyTarget?: number; sortOrder?: number
  }) => {
    const id = randomUUID()
    const now = sqlNow()
    const row: HabitRow = {
      id,
      name: data.name,
      color: data.color || '#3B82F6',
      icon: 'check',
      rule_type: data.ruleType || 'daily',
      rule_days: JSON.stringify(data.ruleDays && data.ruleDays.length > 0 ? data.ruleDays : [1, 2, 3, 4, 5]),
      weekly_target: Math.min(7, Math.max(1, data.weeklyTarget ?? 3)),
      sort_order: data.sortOrder ?? Date.now(),
      archived: 0,
      created_at: now,
      updated_at: now,
    }
    vaultHabitsSave([...vaultHabitsAll(), row])
    return rowToHabit(row)
  })

  ipcMain.handle('habit:update', (_e, id: string, data: {
    name?: string; color?: string
    ruleType?: 'daily' | 'weekdays' | 'flexible'
    ruleDays?: number[]; weeklyTarget?: number
    sortOrder?: number; archived?: boolean
  }) => {
    const rows = vaultHabitsAll()
    const i = rows.findIndex(r => r.id === id)
    if (i >= 0) {
      const cur = rows[i]
      rows[i] = {
        ...cur,
        name: data.name !== undefined ? data.name : cur.name,
        color: data.color !== undefined ? data.color : cur.color,
        rule_type: data.ruleType !== undefined ? data.ruleType : cur.rule_type,
        rule_days: data.ruleDays !== undefined ? JSON.stringify(data.ruleDays) : cur.rule_days,
        weekly_target: data.weeklyTarget !== undefined ? Math.min(7, Math.max(1, data.weeklyTarget)) : cur.weekly_target,
        sort_order: data.sortOrder !== undefined ? data.sortOrder : cur.sort_order,
        archived: data.archived !== undefined ? (data.archived ? 1 : 0) : cur.archived,
        updated_at: sqlNow(),
      }
      vaultHabitsSave(rows)
    }
    // 无此习惯 → UPDATE 0 行，回读为空（rowToHabit 抛出 → ipc 拒绝）
    return rowToHabit(vaultHabitsAll().find(r => r.id === id) as HabitRow)
  })

  ipcMain.handle('habit:delete', (_e, id: string) => {
    // 删除习惯连带其打卡记录（links.json 的联动规则已随条目 14 整条拔线，不再维护）
    vaultRecordsSave(vaultRecordsAll().filter(r => r.habit_id !== id))
    vaultHabitsSave(vaultHabitsAll().filter(h => h.id !== id))
    return
  })

  ipcMain.handle('habit:toggleCheck', (_e, habitId: string, date: string) => {
    const has = vaultRecordsAll().some(r => r.habit_id === habitId && r.date === date)
    if (has) {
      vaultHabitRecordRemove(habitId, date)
      return { checked: false }
    }
    vaultHabitRecordAddIfAbsent(habitId, date, 'manual')
    // 远程监督：打卡成功后异步推送（静默失败，不影响打卡本身）
    void notifyCheckin(habitId, date)
    return { checked: true }
  })

  ipcMain.handle('habit:reorder', (_e, orderedIds: string[]) => {
    // 仅命中的 id 批量更新 sort_order（i + now - len），其余保持
    const now = Date.now()
    const rank = new Map(orderedIds.map((id, i) => [id, i]))
    const rows = vaultHabitsAll()
    for (const r of rows) {
      const i = rank.get(r.id)
      if (i !== undefined) r.sort_order = i + now - orderedIds.length
    }
    vaultHabitsSave(rows)
    return
  })
}
