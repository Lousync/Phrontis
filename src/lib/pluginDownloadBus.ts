/**
 * 插件后台下载总线 —— 模块级单例,组件卸载/切换页面不影响下载任务。
 * 生产者:插件页 doInstall;消费者:插件页内联进度 + StatusBar 全局指示。
 * 进度事件由 preload 的 onPluginDownloadProgress 推送(key = downloadUrl)。
 */

export type BgDownloadStatus = 'downloading' | 'finishing' | 'done' | 'error'

export interface BgDownload {
  key: string
  name: string
  pct: number
  receivedMb: number
  host?: string
  status: BgDownloadStatus
  message?: string
  finishedAt?: number
}

const store = new Map<string, BgDownload>()
const listeners = new Set<() => void>()
// useSyncExternalStore 要求 getSnapshot 返回稳定引用:仅在数据变化时重建缓存数组
let cachedSnapshot: BgDownload[] = []
let progressBound = false

function notify(): void {
  cachedSnapshot = [...store.values()].sort((a, b) => (a.finishedAt ?? Infinity) - (b.finishedAt ?? Infinity))
  for (const fn of listeners) { try { fn() } catch { /* ignore */ } }
}


export function getPluginDownloads(): BgDownload[] {
  return cachedSnapshot
}

function setEntry(key: string, patch: Partial<BgDownload> & Pick<BgDownload, 'name'>): void {
  const prev = store.get(key)
  store.set(key, { pct: 0, receivedMb: 0, status: 'downloading', ...prev, ...patch, key })
  notify()
}

function removeEntryLater(key: string, delayMs = 6000): void {
  window.setTimeout(() => {
    if (store.delete(key)) notify()
  }, delayMs)
}

let ipcInstalled = false
/** 绑定主进程下载进度推送(幂等,仅绑一次) */
function ensureIpcBinding(): void {
  if (ipcInstalled || typeof window === 'undefined' || !window.api?.onPluginDownloadProgress) return
  ipcInstalled = true
  window.api.onPluginDownloadProgress(p => {
    const cur = store.get(p.key)
    if (!cur || cur.status !== 'downloading') return
    const pct = p.total > 0 ? Math.max(0, Math.min(100, Math.round(p.percent))) : 0
    setEntry(p.key, { name: cur.name, pct, receivedMb: Math.round((p.received / 1048576) * 10) / 10, host: p.host || undefined })
  })
}

/**
 * 发起后台安装:立即返回(不阻塞 UI/导航),进度与结果经总线分发。
 * 由调用方传入完成后刷新已安装列表等收尾动作。
 */
export function startBackgroundPluginInstall(opts: {
  url: string
  name: string
  granted?: string[]
  invoke: (url: string, granted?: string[]) => Promise<{ success: boolean; message?: string }>
  onSettled?: (r: { success: boolean; message?: string }) => void
}): void {
  ensureIpcBinding()
  const existing = store.get(opts.url)
  if (existing && (existing.status === 'downloading' || existing.status === 'finishing')) return // 防重复点击
  setEntry(opts.url, { name: opts.name, pct: 0, status: 'downloading' })
  ;(async () => {
    try {
      const r = await opts.invoke(opts.url, opts.granted)
      if (r.success) {
        setEntry(opts.url, { name: opts.name, pct: 100, status: 'done', finishedAt: Date.now() })
        removeEntryLater(opts.url)
      } else {
        setEntry(opts.url, { name: opts.name, status: 'error', message: r.message || '安装失败', finishedAt: Date.now() })
        removeEntryLater(opts.url, 10000)
      }
      opts.onSettled?.(r)
    } catch (e: unknown) {
      setEntry(opts.url, { name: opts.name, status: 'error', message: String(e).slice(0, 120), finishedAt: Date.now() })
      removeEntryLater(opts.url, 10000)
      opts.onSettled?.({ success: false, message: String(e) })
    }
  })()
}

/** 调试/自动化入口:任意页面可直接发起后台安装(如控制台、诊断脚本) */
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__kbPluginDL = {
    start: startBackgroundPluginInstall,
    snapshot: getPluginDownloads,
  }
}