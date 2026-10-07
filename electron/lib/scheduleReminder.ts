/**
 * 日程 DDL 提醒 —— 系统通知主通道（设计见 docs/prototypes/schedule-week-rework.html §4）。
 *
 * 调度：**复用 pushService 的 30s tick**（不新建调度器）；main 启动时 initScheduleReminders 接线。
 * 触发：提醒时刻 = DDL − 提前量（绝对时刻，所以「明早 08:00 截止 + 提前 12 小时」今晚 20:00 就会响）；
 *       已完成剔除；去重防连弹；免打扰时段不发且**不写去重键** → 出免打扰后下一次 tick 自然补发；
 *       启动首轮对「软件没开时错过」的提醒做汇总，不逐条轰炸。
 * 通道：系统通知为主；可选同时推外部通道（复用「远程监督」已配置的 webhook，默认关）。
 *
 * 依赖方向：pushService → 本模块（在 tick 里调用）；外部推送由 main 注入回调，
 * 避免本模块反向 import pushService 形成循环依赖。
 */
import { Notification, BrowserWindow } from 'electron'
import { vaultTodosAll, type TodoRow } from './kbStore/scheduleVaultRepo'
import { readJson, writeJson } from './kbStore/jsonStore'

const SCHEDULE_MOD = 'modules/schedule'
const REMINDED_FILE = 'reminders.json'


/** 去重表：todoId → 已通知过的「提醒时刻」标记 */
interface RemindedMap { [todoId: string]: string }

let getSetting: (key: string) => unknown = () => undefined
let pushExternal: ((title: string, contentMd: string) => Promise<unknown>) | null = null

/** 由 main 接线：设置读取器 +（可选）外部推送通道 */
export function initScheduleReminders(opts: {
  getSetting: (key: string) => unknown
  pushExternal?: (title: string, contentMd: string) => Promise<unknown>
}): void {
  getSetting = opts.getSetting
  pushExternal = opts.pushExternal ?? null
  // 启动首轮：把「软件没开时错过」的提醒做一次汇总
  void checkScheduleReminders({ startup: true })
}

// ===== 时间工具（与 ScheduleTodo.time / snoozeUntil 同口径 'YYYY-MM-DD HH:mm'） =====

function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function toMinutes(hhmm: string): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return null
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 免打扰判断（支持跨天区间，如 22:30~07:30） */
function inQuietHours(start: string, end: string, now: Date): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === null || e === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e
}

/** 距离截止的剩余/逾期口语化描述 */
function humanizeGap(ms: number): string {
  const min = Math.round(ms / 60000)
  if (min >= 0) {
    if (min < 1) return '不到 1 分钟'
    if (min < 60) return `还有 ${min} 分钟`
    if (min < 1440) return `还有 ${Math.round(min / 60)} 小时`
    return `还有 ${Math.round(min / 1440)} 天`
  }
  const over = -min
  if (over < 60) return `已逾期 ${over} 分钟`
  if (over < 1440) return `已逾期 ${Math.round(over / 60)} 小时`
  return `已逾期 ${Math.round(over / 1440)} 天`
}

/** 截止时刻 → 'HH:mm'（'YYYY-MM-DD HH:mm' 的第 11~16 位） */
function hhmm(time: string | null): string {
  return time && time.length >= 16 ? time.slice(11, 16) : ''
}

// ===== 去重（.knowbase/modules/schedule/reminders.json） =====

function readReminded(): RemindedMap {
  return readJson<RemindedMap>(SCHEDULE_MOD, REMINDED_FILE, {})
}

function writeReminded(m: RemindedMap): void {
  writeJson(SCHEDULE_MOD, REMINDED_FILE, m)
}

// ===== 候选收集 =====

interface Hit { todo: TodoRow; key: string; ddl: Date }

function collect(now: Date, opts: { lead: number; overdueRepeat: boolean }): Hit[] {
  const hits: Hit[] = []
  for (const t of vaultTodosAll()) {
    if (t.status !== 'pending') continue        // 已完成剔除
    if (t.parent_id) continue                    // 子任务跟随父任务，不单独提醒
    const ddl = parseLocal(t.time)
    if (!ddl) continue
    // 打盹中 → 跳过；打盹已结束 → 以打盹目标时刻作为新的提醒时刻
    const snooze = parseLocal(t.snooze_until ?? null)
    let remindAt = new Date(ddl.getTime() - opts.lead * 60000)
    if (snooze) {
      if (snooze > now) continue
      remindAt = snooze
    }
    if (now < remindAt) continue                 // 还没到提醒时刻
    // 逾期补提醒（默认关）：开启时用独立 key，避免与「到点提醒」互相吞掉
    const key = now > ddl && opts.overdueRepeat ? `${fmt(remindAt)}|overdue` : fmt(remindAt)
    hits.push({ todo: t, key, ddl })
  }
  return hits.sort((a, b) => a.ddl.getTime() - b.ddl.getTime())
}

// ===== 通道 =====

/** Windows 需要 app.setAppUserModelId 才能在操作中心正常显示（main 已设） */
function showSystemNotification(title: string, body: string, onClick?: () => void): boolean {
  if (!Notification.isSupported()) return false
  try {
    const n = new Notification({ title, body })
    if (onClick) n.on('click', onClick)
    n.show()
    return true
  } catch (err) {
    console.warn('[scheduleReminder] 系统通知失败:', err)
    return false
  }
}

/** 点击通知 → 唤起并聚焦主窗口，并请渲染层切到日程 */
function onNotificationClick(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  try {
    win.webContents.send('schedule:reminderClick')
  } catch {
    /* ignore */
  }
}

// ===== 主检查（由 30s tick 与启动首轮调用） =====

export async function checkScheduleReminders(opts: { startup?: boolean } = {}): Promise<void> {
  try {
    if (getSetting('scheduleReminderEnabled') === false) return
    const leadRaw = Number(getSetting('scheduleReminderLead'))
    const lead = Number.isFinite(leadRaw) && leadRaw > 0 ? leadRaw : 30
    const overdueRepeat = getSetting('scheduleReminderOverdueRepeat') === true
    const quietStart = String(getSetting('scheduleReminderQuietStart') ?? '22:30')
    const quietEnd = String(getSetting('scheduleReminderQuietEnd') ?? '07:30')
    const external = getSetting('scheduleReminderExternalPush') === true

    const now = new Date()
    const hits = collect(now, { lead, overdueRepeat })
    if (hits.length === 0) return

    // 免打扰：整体不发，且不写去重键 → 出免打扰后自动补发，不丢
    if (inQuietHours(quietStart, quietEnd, now)) return

    const reminded = readReminded()
    const fresh = hits.filter((h) => reminded[h.todo.id] !== h.key)
    if (fresh.length === 0) return

    // 启动汇总：一次错过多条时合成一条，不逐条轰炸
    if (opts.startup && fresh.length > 1) {
      const body = [
        ...fresh.slice(0, 3).map((h) => `· ${h.todo.title}`),
        ...(fresh.length > 3 ? [`…另有 ${fresh.length - 3} 条`] : []),
      ].join('\n')
      showSystemNotification(`日程提醒 · ${fresh.length} 个任务需要处理`, body, onNotificationClick)
      for (const h of fresh) reminded[h.todo.id] = h.key
      writeReminded(reminded)
      return
    }

    for (const h of fresh) {
      const gap = humanizeGap(h.ddl.getTime() - now.getTime())
      const unscheduled = h.todo.scheduled_start === null && h.todo.scheduled_end === null
      const title = `日程提醒 · ${hhmm(h.todo.time)} 截止`
      const body = `${h.todo.title}\n${gap}。${unscheduled ? '这条任务还没排进日程表。' : ''}`
      showSystemNotification(title, body, onNotificationClick)
      if (external && pushExternal) {
        void pushExternal(title, `**${h.todo.title}**\n\n${gap}。${unscheduled ? '尚未排期。' : ''}`)
          .catch(() => { /* 外部通道失败不影响系统通知 */ })
      }
      reminded[h.todo.id] = h.key
    }
    writeReminded(reminded)
  } catch (err) {
    console.error('[scheduleReminder] 检查失败:', err)
  }
}
