/**
 * 渲染进程原生内存采样（v3.16.1 F-1 取证基建）
 *
 * 背景：v3.16.0 的 OOM 崩溃是 `V8 process OOM (Oilpan: Normal allocation. Ran out of reservation)`，
 * 崩溃时 JS heap 只有 31.4 MB，而进程组峰值约 4.2 GB —— 增长发生在**渲染进程的原生堆**
 * （DOM / raster / canvas / 原生文本对象等），CDP 的 `JSHeapUsedSize` 与 `Nodes` 都看不到。
 *
 * 已有取证只能靠外部脚本定时抓 `ps`，重启后数据就断了。这里把采样做进主进程：
 *  - 每 30 秒把主窗口渲染进程的 RSS / peak / JS heap 追加到 `userData/renderer-mem.log`
 *    （1 MB 轮转一代）；
 *  - 崩溃时把最近一条样本 + 当前全进程 metrics 一并写进 `crash-log.txt`，
 *    这样下一次崩溃可以直接把「增长曲线 → 崩溃时刻」对齐，不必再守着终端抓。
 *
 * 纯函数（格式化 / 轮转判据）在 `rendererMemoryProbePure.ts`，契约脚本直接跑真实实现。
 *
 * 刻意不做：
 *  - 不自动 reload / 不主动 GC —— 那是崩溃兜底（main/index.ts），不是取证；
 *  - 不默认开启 `--enable-heap-profiling=native`（开销与运行形态都会变），
 *    只留 `KNOWBASE_NATIVE_HEAP_PROFILE=1` 显式开关，供专门复现时使用。
 */
import { app, type BrowserWindow } from 'electron'
import { appendFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MEMORY_SAMPLE_INTERVAL_MS, shouldRotateMemoryLog,
  formatMemorySample, type RendererMemorySample,
} from './rendererMemoryProbePure'

export { formatMemorySample, formatMetricsSnapshot } from './rendererMemoryProbePure'
export type { RendererMemorySample } from './rendererMemoryProbePure'

const readJsHeapKb = async (win: BrowserWindow): Promise<number | null> => {
  try {
    // 页面若尚未 ready 或已崩溃，executeJavaScript 会 reject；2s 超时避免卡住采样循环
    const value = await Promise.race([
      win.webContents.executeJavaScript(
        'typeof performance !== "undefined" && performance.memory ? performance.memory.usedJSHeapSize : null',
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ])
    return typeof value === 'number' && Number.isFinite(value) ? value / 1024 : null
  } catch {
    return null
  }
}

export async function sampleRendererMemory(win: BrowserWindow): Promise<RendererMemorySample> {
  const at = new Date().toISOString()
  let pid: number | null = null
  let rssKb: number | null = null
  let peakRssKb: number | null = null

  try {
    pid = win.webContents.getOSProcessId()
  } catch { /* 窗口已销毁 */ }

  try {
    const tabs = app.getAppMetrics().filter((m) => m.type === 'Tab')
    // 优先按 pid 精确匹配（多窗口 / 日程小窗时不会抓错渲染进程），退化到第一个 Tab
    const m = tabs.find((x) => x.pid === pid) ?? tabs[0]
    if (m) {
      rssKb = m.memory.workingSetSize
      peakRssKb = m.memory.peakWorkingSetSize
    }
  } catch { /* metrics 不可用不影响主流程 */ }

  const jsHeapUsedKb = win.isDestroyed() ? null : await readJsHeapKb(win)
  return { at, pid, rssKb, peakRssKb, jsHeapUsedKb }
}

/** 追加一行；超过上限就把当前文件转成 `.1`（只留一代，与 crash-log 同口径） */
export async function appendMemoryLog(file: string, line: string): Promise<void> {
  try {
    const st = await stat(file)
    if (shouldRotateMemoryLog(st.size)) {
      const prev = `${file}.1`
      await unlink(prev).catch(() => { /* 上一代不存在 */ })
      await rename(file, prev)
    }
  } catch { /* 文件不存在 = 首次写入 */ }
  await appendFile(file, line + '\n')
}

export interface RendererMemoryProbe {
  /** 停止定时采样；不删除已写日志 */
  stop: () => void
  /** 最近一条样本（崩溃时写进 crash-log） */
  latest: () => RendererMemorySample | null
  /** 立即采一次（人工诊断用） */
  sampleNow: () => Promise<RendererMemorySample | null>
}

/**
 * 启动采样。调用方保证 win 未被销毁；窗口关闭前先 stop()。
 * 文件默认 `userData/renderer-mem.log`（dev 环境在 `knowbase (dev)` 下）。
 */
export function startRendererMemoryProbe(
  win: BrowserWindow,
  logFile = join(app.getPath('userData'), 'renderer-mem.log'),
  intervalMs = MEMORY_SAMPLE_INTERVAL_MS,
): RendererMemoryProbe {
  let latest: RendererMemorySample | null = null
  let stopped = false
  let running = false

  const tick = async (): Promise<RendererMemorySample | null> => {
    if (stopped || win.isDestroyed() || running) return latest
    running = true
    try {
      const s = await sampleRendererMemory(win)
      latest = s
      // 页面还没 ready 时 pid=0 / 各项为 null：这种空样本只污染时间线，不写盘
      if (s.rssKb != null || s.jsHeapUsedKb != null) {
        await appendMemoryLog(logFile, formatMemorySample(s)).catch(() => { /* 留痕失败不影响主流程 */ })
      }
      return s
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  void tick()

  return {
    stop: () => { stopped = true; clearInterval(timer) },
    latest: () => latest,
    sampleNow: tick,
  }
}
