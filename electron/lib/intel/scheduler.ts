import { intelRefresh } from './intelStore'
import { intelIntervalMs, type IntelGetSetting } from './intelSettings'

/**
 * 情报自动抓取（docs/intel-module-plan.md §4.4）：照 pushService 的 supervisor scheduler 同型。
 * 每 5min tick：设置 intel.interval='off' 不跑；无仓库跳过；距 lastFetchAt 不足间隔跳过。
 * 抓取失败只 console.warn —— 后台定时动作不惊扰用户（手动刷新才有 Toast）。
 */

let timer: ReturnType<typeof setInterval> | null = null
let running = false

async function tick(get: IntelGetSetting): Promise<void> {
  if (running) return // 上一轮还没抓完（arXiv 慢），本轮跳过
  running = true
  try {
    const interval = intelIntervalMs(get)
    if (!interval) return // 'off'：仅手动刷新
    const { intelReadMeta } = await import('./intelStore')
    const last = intelReadMeta().lastFetchAt
    if (last && Date.now() - Date.parse(last) < interval) return
    await intelRefresh(get)
  } catch (err) {
    console.warn('[intel] scheduler tick failed:', String((err as Error)?.message ?? err).slice(0, 160))
  } finally {
    running = false
  }
}

export function startIntelScheduler(get: IntelGetSetting): void {
  if (timer) clearInterval(timer)
  // 启动先试一轮：距上轮不足间隔时 tick 内部自行跳过
  void tick(get)
  timer = setInterval(() => void tick(get), 5 * 60000)
}

export function stopIntelScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
