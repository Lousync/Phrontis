import { ipcMain } from 'electron'
import { vaultTodosAll } from '../../lib/kbStore/scheduleVaultRepo'
import { vaultRecordsAll, vaultHabitsAll } from '../../lib/kbStore/habitVaultRepo'
import { vaultListEntries } from '../../lib/kbStore/blogVaultRepo'
import { pomoSessionCreate, pomoSessionsAll } from '../../lib/kbStore/pomoVaultRepo'
import { getKnowledgeIndex } from '../../lib/kbStore/knowledgeIndex'
import { checkinTotalInWindow, habitPeriodStats } from '../../lib/kbStore/habitStats'

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
    // 知识库页面数：**按 frontmatter created 归窗口**（v3.2.0 条目 13 口径修复 ——
    // 原实现直接取 pages.length，显示的是全库页数，与窗口无关）。
    // 无 created 的页面（外部 md、早期文件）算不出归属 → 不计入任何窗口，
    // 宁可少算也不把「不知道哪天建的」摊进当期。
    const knowledgePages = getKnowledgeIndex().pages
      .filter((p) => { const d = localDay(p.createdAt); return d >= start && d <= end })
      .length
    // 番茄钟专注分钟数
    const pomodoroMinutes = pomoSessionsAll()
      .filter((r) => r.date >= start && r.date <= end)
      .reduce((sum, r) => sum + (Number(r.minutes) || 0), 0)
    // 打卡：总数与每习惯明细读同一份记录，避免两处各扫一次导致数字对不上
    const records = vaultRecordsAll()
    return {
      checkins: checkinTotalInWindow(records, start, end),
      blogEntries,
      knowledgePages,
      pomodoroMinutes,
      // 完成的日程任务数（按完成时间 updated_at 归日,转本地日期）
      scheduleDone: vaultTodosAll().filter((r) => r.status === 'done' && localDay(r.updated_at) >= start && localDay(r.updated_at) <= end && localDay(r.updated_at) !== '').length,
      // 每习惯明细：次数 / 完成率 / 最长连续（判定策略在 lib/kbStore/habitStats.ts，纯函数）
      habitDetails: habitPeriodStats(vaultHabitsAll(), records, start, end),
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
