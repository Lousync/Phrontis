import { ipcMain } from 'electron'
import { vaultTodosAll } from '../../lib/kbStore/scheduleVaultRepo'
import { vaultRecordsAll } from '../../lib/kbStore/habitVaultRepo'
import { vaultListEntries } from '../../lib/kbStore/blogVaultRepo'
import { pomoSessionCreate, pomoSessionsAll } from '../../lib/kbStore/pomoVaultRepo'
import { getKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'

/**
 * 周期总结支持服务 ——
 * 1. 番茄钟专注场次落 .knowbase/modules/pomodoro/sessions.json（pomodoro:createSession）
 * 2. 每日博客"周/月总结"面板的区间统计（blog:periodStats）
 * R6 去库化：全部统计读 vault 数据源（sql.js 路径已移除，D9）
 */

export function registerSummaryHandlers(): void {

  // 番茄钟：记录一次完成的专注（fire-and-forget，失败不影响计时）
  ipcMain.handle('pomodoro:createSession', (_e, minutes: number) => {
    try {
      const mins = Math.max(1, Math.round(minutes || 0))
      pomoSessionCreate(mins)
      return true
    } catch (err) {
      console.error('[summary] Failed to record pomodoro:', err)
      return false
    }
  })

  // 区间统计：start/end 均为本地 YYYY-MM-DD（含端点）
  ipcMain.handle('blog:periodStats', (_e, start: string, end: string) => {
    // 博客篇数（entries.date 为 YYYY-MM-DD）
    const entries = vaultListEntries()
    const blogEntries = entries.filter((r) => r.date >= start && r.date <= end).length
    // 知识库页面数（含草稿，对齐原 DB 全表口径）
    const knowledgePages = getKnowledgeIndex().pages.length
    // 番茄钟专注分钟数
    const pomodoroMinutes = pomoSessionsAll()
      .filter((r) => r.date >= start && r.date <= end)
      .reduce((sum, r) => sum + (Number(r.minutes) || 0), 0)
    return {
      // 打卡次数（habit_records.date 即纯日期）
      checkins: vaultRecordsAll().filter((r) => typeof r.date === 'string' && r.date >= start && r.date <= end).length,
      blogEntries,
      knowledgePages,
      pomodoroMinutes,
      // 完成的日程任务数（按完成时间 updated_at 归日,转本地日期）
      scheduleDone: vaultTodosAll().filter((r) => r.status === 'done' && localDay(r.updated_at) >= start && localDay(r.updated_at) <= end && localDay(r.updated_at) !== '').length,
    }
  })
}

/** 存储时间戳（ISO 或 'YYYY-MM-DD HH:MM:SS'）→ 本地日期 YYYY-MM-DD（对标 sqlite date(x,'localtime')） */
function localDay(ts: unknown): string {
  if (typeof ts !== 'string' || !ts) return ''
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
