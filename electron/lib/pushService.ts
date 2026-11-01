import { adaptPush, type SupervisePlatform, type SupervisePushConfig, type PushPayload } from './pushAdapters'
import { vaultRecordsAll, vaultHabitsAll } from 'phrontis-core/kbStore/habitVaultRepo'
import { readJson, writeJson } from 'phrontis-core/kbStore/jsonStore'
import { checkScheduleReminders } from './scheduleReminder'

/**
 * 远程监督推送服务 —— 配置读写、免打扰判断、带重试的 webhook 发送、
 * 打卡即时通知、每日汇总定时任务。由 superviseRepo 注册 IPC，
 * 由 checkinRepo 的打卡钩子触发即时推送。
 *
 * R6 去库化：配置/日志真相源 = .knowbase/modules/supervise/{config.json,log.json}
 * （行快照 schema 与迁移器 planTable 产物一致；sql.js 路径已移除，D9）
 */

// ===== 配置（KV 行数组存 config.json，避免与 settings 模块耦合） =====

export interface SuperviseConfig extends SupervisePushConfig {
  enabled: boolean
  instantPush: boolean
  dailyPush: boolean
  /** HH:mm */
  dailyTime: string
  /** 免打扰起止 HH:mm，空串 = 不启用；支持跨天区间（如 23:00~07:00） */
  quietStart: string
  quietEnd: string
}

const CONFIG_DEFAULTS: SuperviseConfig = {
  enabled: false,
  platform: 'serverchan' as SupervisePlatform,
  webhookUrl: '',
  secret: '',
  instantPush: true,
  dailyPush: false,
  dailyTime: '22:00',
  quietStart: '',
  quietEnd: '',
}

interface ConfigRow { key: string; value: string }

/** 对齐 sqlite datetime('now','localtime') 的本地时间串 */
function localNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function readConfigRows(): ConfigRow[] {
  return readJson<ConfigRow[]>('supervise', 'config.json', [])
}

export function getSuperviseConfig(): SuperviseConfig {
  const cfg = { ...CONFIG_DEFAULTS }
  for (const row of readConfigRows()) {
    if (row.key in cfg) {
      const v = row.value
      ;(cfg as unknown as Record<string, unknown>)[row.key] =
        v === 'true' ? true : v === 'false' ? false : v
    }
  }
  return cfg
}

export function saveSuperviseConfig(partial: Partial<SuperviseConfig>): SuperviseConfig {
  const merged = { ...getSuperviseConfig(), ...partial }
  writeJson(
    'supervise',
    'config.json',
    Object.entries(merged).map(([key, value]) => ({ key, value: String(value) }))
  )
  return getSuperviseConfig()
}

// ===== 日志（.knowbase/modules/supervise/log.json） =====

export interface LogRow {
  id: number; push_type: string; habit_id: string | null
  title: string; content: string; status: string
  retry_count: number; error_message: string | null
  created_at: string; pushed_at: string | null
}

export interface SuperviseLogDto {
  id: number
  pushType: 'instant' | 'daily'
  habitId: string | null
  title: string
  content: string
  status: 'success' | 'failed' | 'pending'
  retryCount: number
  errorMessage: string | null
  createdAt: string
  pushedAt: string | null
}

function rowToDto(r: LogRow): SuperviseLogDto {
  return {
    id: r.id,
    pushType: r.push_type as 'instant' | 'daily',
    habitId: r.habit_id,
    title: r.title,
    content: r.content,
    status: r.status as 'success' | 'failed' | 'pending',
    retryCount: r.retry_count,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
  }
}

function readLogRows(): LogRow[] {
  return readJson<LogRow[]>('supervise', 'log.json', [])
}

function writeLogRows(rows: LogRow[]): void {
  writeJson('supervise', 'log.json', rows)
}

function insertLog(pushType: 'instant' | 'daily', habitId: string | null, title: string, content: string): number {
  const rows = readLogRows()
  const id = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1
  rows.push({
    id, push_type: pushType, habit_id: habitId, title, content,
    status: 'pending', retry_count: 0, error_message: null,
    created_at: localNow(), pushed_at: null,
  })
  writeLogRows(rows)
  return id
}

function updateLogStatus(id: number, status: 'success' | 'failed' | 'pending', error?: string): void {
  const rows = readLogRows()
  const row = rows.find((r) => r.id === id)
  if (!row) return
  row.status = status
  row.retry_count += 1
  row.error_message = error ?? null
  if (status === 'success') row.pushed_at = localNow()
  writeLogRows(rows)
}

/** 推送历史（id 降序，limit 条） */
export function superviseHistory(limit: number): SuperviseLogDto[] {
  return readLogRows()
    .sort((a, b) => b.id - a.id)
    .slice(0, limit)
    .map(rowToDto)
}

/** 单条失败重推：置 pending → 投递 → 返回最新状态 */
export async function superviseRetryOne(id: number): Promise<SuperviseLogDto | null> {
  const rows = readLogRows()
  const row = rows.find((r) => r.id === id)
  if (!row) return null
  if (row.status === 'failed') {
    row.status = 'pending'
    row.error_message = null
    writeLogRows(rows)
  }
  await deliverLog(id)
  const after = readLogRows().find((r) => r.id === id)
  return after ? rowToDto(after) : null
}

/** 全部失败重推：先统一置 pending 再逐条投递 */
export async function superviseRetryAllFailed(): Promise<{ total: number; ok: number }> {
  const failed = readLogRows().filter((r) => r.status === 'failed').sort((a, b) => a.id - b.id)
  if (failed.length > 0) {
    const rows = readLogRows()
    for (const row of rows) {
      if (row.status === 'failed') {
        row.status = 'pending'
        row.error_message = null
      }
    }
    writeLogRows(rows)
  }
  let okCount = 0
  for (const row of failed) {
    const res = await deliverLog(row.id)
    if (res.ok) okCount++
  }
  return { total: failed.length, ok: okCount }
}

/** 清空推送历史 */
export function superviseClearHistory(): void {
  writeLogRows([])
}

// ===== 免打扰 =====

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function isInQuietHours(cfg: SuperviseConfig, now = new Date()): boolean {
  if (!cfg.quietStart || !cfg.quietEnd) return false
  if (!/^\d{1,2}:\d{2}$/.test(cfg.quietStart) || !/^\d{1,2}:\d{2}$/.test(cfg.quietEnd)) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = toMinutes(cfg.quietStart)
  const end = toMinutes(cfg.quietEnd)
  // 跨天区间（23:00~07:00）与非跨天统一判断
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

// ===== 发送（带重试：1s / 5s / 15s） =====

const RETRY_DELAYS_MS = [1000, 5000, 15000]
const FETCH_TIMEOUT_MS = 10000

async function postOnce(url: string, body: string, contentType?: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: contentType ? { 'Content-Type': contentType } : undefined,
      body,
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // 各平台失败也返回 200，错误信息在响应体里
    const text = await res.text()
    if (text.includes('"errcode"') && !text.includes('"errcode":0')) {
      throw new Error(text.slice(0, 300))
    }
    if (text.includes('"code"') && text.includes('"message":"error"')) {
      throw new Error(text.slice(0, 300))
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 投递一条日志：内部重试，最终状态写回日志文件 */
export async function deliverLog(id: number): Promise<{ ok: boolean; error?: string }> {
  const row = readLogRows().find((r) => r.id === id) ?? null
  if (!row) return { ok: false, error: '日志不存在' }

  const cfg = getSuperviseConfig()
  const payload: PushPayload = { title: row.title, contentMd: row.content }
  let lastError = ''
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const req = adaptPush(payload, cfg)
      await postOnce(req.url, req.body, req.contentType)
      updateLogStatus(id, 'success')
      return { ok: true }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn(`[supervise] Push failed (attempt ${attempt + 1}):`, lastError)
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
      }
    }
  }
  updateLogStatus(id, 'failed', lastError.slice(0, 500))
  return { ok: false, error: lastError }
}

/** 直接发送（测试用）：不写日志、不重试 */
export async function testPush(cfg: SuperviseConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const req = adaptPush(
      { title: 'Phrontis 测试消息', contentMd: '这是一条测试消息，收到说明远程监督推送配置成功 ✅' },
      cfg
    )
    await postOnce(req.url, req.body, req.contentType)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 供其他功能（如日程 DDL 提醒）复用「远程监督」已配置的外部通道推送 */
export async function enqueueExternalPush(
  title: string,
  contentMd: string
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const cfg = getSuperviseConfig()
  if (!cfg.enabled || !cfg.webhookUrl) return { ok: false, skipped: '未启用远程监督或未配置 webhook' }
  const id = insertLog('instant', null, title, contentMd)
  if (isInQuietHours(cfg)) return { ok: false, skipped: '免打扰时段，已挂起待补发' }
  return deliverLog(id)
}

// ===== 即时推送（打卡钩子） =====

function todayStr(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 简化连续天数：从今天（无记录则从昨天）向前数连续有记录的天数 */
function plainStreak(habitId: string): number {
  // 读 .knowbase/modules/checkin/records.json
  // （不反手 ensureSeed：checkinRepo→pushService 有向依赖，避免环；文件未生成时按无记录处理）
  const dates = new Set(vaultRecordsAll().filter((r) => r.habit_id === habitId).map((r) => r.date))
  let streak = 0
  const cursor = new Date()
  if (!dates.has(todayStr(cursor))) cursor.setDate(cursor.getDate() - 1)
  while (dates.has(todayStr(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** 打卡成功后的即时通知入口（checkinRepo 钩子调用）；静默失败，不影响打卡 */
export async function notifyCheckin(habitId: string, date: string): Promise<void> {
  try {
    const cfg = getSuperviseConfig()
    if (!cfg.enabled || !cfg.instantPush || !cfg.webhookUrl) return
    let name = ''
    name = vaultHabitsAll().find((h) => h.id === habitId)?.name ?? ''
    if (!name) return
    const streak = plainStreak(habitId)
    const title = `✅ 打卡「${name}」`
    const content = [
      `**${name}** 打卡成功`,
      `- 日期：${date}`,
      streak > 1 ? `- 连续打卡：${streak} 天` : '',
      '',
      `> 来自 Phrontis 远程监督`,
    ].filter(Boolean).join('\n')
    const id = insertLog('instant', habitId, title, content)
    if (isInQuietHours(cfg)) {
      console.log('[supervise] Quiet hours, push deferred:', id)
      return
    }
    await deliverLog(id)
  } catch (err) {
    console.error('[supervise] Immediate push error:', err)
  }
}

// ===== 每日汇总 =====

interface HabitNameRow { id: string; name: string }

async function buildDailySummary(date: string): Promise<PushPayload> {
  // 读 .knowbase/modules/checkin/{habits,records}.json（语义同 SQL：未归档、sort_order 升序）
  const habits: HabitNameRow[] = vaultHabitsAll()
    .filter((h) => !h.archived)
    .map((h) => ({ id: h.id, name: h.name }))
  const done = new Set(vaultRecordsAll().filter((r) => r.date === date).map((r) => r.habit_id))

  const lines = habits.map(h => `- ${done.has(h.id) ? '✅' : '⬜'} ${h.name}`)
  const count = habits.filter(h => done.has(h.id)).length
  return {
    title: `📋 每日汇总：${count}/${habits.length} 完成`,
    contentMd: [
      `**${date} 打卡情况：${count}/${habits.length} 完成**`,
      ...(lines.length > 0 ? lines : ['- （暂无习惯）']),
      '',
      `> 来自 Phrontis 远程监督`,
    ].join('\n'),
  }
}

function hasDailySentToday(date: string): boolean {
  // 含 failed：自动模式每天只尝试一次，失败靠历史页手动重推，避免调度器反复轰炸
  // created_at 已存本地时间（insertLog 显式 localtime），此处直接比较
  return readLogRows().some(
    (r) =>
      r.push_type === 'daily' &&
      (r.status === 'success' || r.status === 'pending' || r.status === 'failed') &&
      r.created_at.slice(0, 10) === date
  )
}

/** 发送每日汇总；force = 手动触发（跳过去重与开关） */
export async function sendDailySummary(force = false): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const cfg = getSuperviseConfig()
  if (!force && (!cfg.enabled || !cfg.dailyPush)) return { ok: false, skipped: '未启用每日汇总' }
  if (!cfg.webhookUrl) return { ok: false, skipped: '未配置 webhook' }
  const date = todayStr()
  if (!force && hasDailySentToday(date)) return { ok: false, skipped: '今日已发送过汇总' }
  const payload = await buildDailySummary(date)
  const id = insertLog('daily', null, payload.title, payload.contentMd)
  if (!force && isInQuietHours(cfg)) return { ok: false, skipped: '免打扰时段，已挂起待补发' }
  return deliverLog(id)
}

// ===== 定时调度 =====

let schedulerTimer: ReturnType<typeof setInterval> | null = null

/** 补发所有 pending 日志（免打扰结束后由调度器调用） */
async function flushPending(): Promise<void> {
  const cfg = getSuperviseConfig()
  if (!cfg.enabled || isInQuietHours(cfg) || !cfg.webhookUrl) return
  const ids = readLogRows().filter((r) => r.status === 'pending').map((r) => r.id)
  for (const id of ids) await deliverLog(id)
}

/** 启动调度器：每 30s 检查每日汇总时间点与待补发队列；启动时先跑一轮处理隔夜漏发 */
export function startSuperviseScheduler(): void {
  const tick = async (): Promise<void> => {
    try {
      // 日程 DDL 提醒：属独立功能域，**不受「远程监督」开关影响**，先跑
      await checkScheduleReminders()
      const cfg = getSuperviseConfig()
      if (!cfg.enabled) return
      // 每日汇总：已过配置时间且今天还没尝试过（启动晚于时间点也会补发一次）
      if (cfg.dailyPush && /^\d{1,2}:\d{2}$/.test(cfg.dailyTime)) {
        const now = new Date()
        const target = toMinutes(cfg.dailyTime)
        const nowMin = now.getHours() * 60 + now.getMinutes()
        if (nowMin >= target && !hasDailySentToday(todayStr(now))) {
          await sendDailySummary(false)
        }
      }
      await flushPending()
    } catch (err) {
      console.error('[supervise] Scheduler error:', err)
    }
  }
  void tick()
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = setInterval(() => void tick(), 30000)
}

export function stopSuperviseScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
}
