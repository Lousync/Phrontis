/**
 * 渲染进程内存采样的纯函数（v3.16.1 F-1）—— 零 electron 依赖，供契约脚本直接 import。
 *
 * 为什么要拆：崩溃后要拿 `renderer-mem.log` 与 `crash-log.txt` 对齐时间线，
 * 字段顺序 / 缺值表示一旦漂移，awk / 脚本就会静默切错列。这里把格式与轮转判据锁成纯函数，
 * 由 `.AGENT/scripts/desktop/verify-renderer-memory-probe.mjs` 跑真实实现，而不是断言源码字符串。
 */

export const MEMORY_LOG_MAX_BYTES = 1024 * 1024
/** 30 秒一次：长 agent 回合通常数分钟到十几分钟，足够看出斜率，又不会把日志写爆 */
export const MEMORY_SAMPLE_INTERVAL_MS = 30_000

export interface RendererMemorySample {
  at: string
  pid: number | null
  /** 渲染进程常驻内存（KB）= app.getAppMetrics().memory.workingSetSize（Linux/Windows 即 RSS 口径） */
  rssKb: number | null
  /** 本进程历史峰值（KB）—— 崩溃后 RSS 会归零，但 peak 仍能说明「涨到过多大」 */
  peakRssKb: number | null
  /** performance.memory.usedJSHeapSize（KB）；只作对照，已知长期平稳 */
  jsHeapUsedKb: number | null
}

/** 单行文本：固定字段顺序，方便 awk / 脚本直接切（缺值写 `-`，不写 0 以免误读） */
export function formatMemorySample(s: RendererMemorySample): string {
  const f = (v: number | null): string => (v == null || !Number.isFinite(v) ? '-' : String(Math.round(v)))
  return `${s.at} pid=${s.pid ?? '-'} rss=${f(s.rssKb)} peak=${f(s.peakRssKb)} jsHeap=${f(s.jsHeapUsedKb)}`
}

/** 崩溃时的全进程快照：一行一个进程，避免多窗口时只看到主窗口 */
export function formatMetricsSnapshot(
  metrics: Array<{
    type: string
    name?: string
    pid: number
    memory: { workingSetSize: number; peakWorkingSetSize: number }
  }>,
): string {
  return metrics
    .map((m) => `${m.type}${m.name ? `(${m.name})` : ''} pid=${m.pid} ws=${Math.round(m.memory.workingSetSize)} peak=${Math.round(m.memory.peakWorkingSetSize)}`)
    .join('; ')
}

/** 写日志前判断是否轮转（>= 上限就转 `.1`；只留一代） */
export function shouldRotateMemoryLog(sizeBytes: number): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes >= MEMORY_LOG_MAX_BYTES
}
