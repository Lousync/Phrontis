import { useSyncExternalStore } from 'react'
import {
  checkForUpdate, downloadUpdate, installUpdate, onUpdateDownloadProgress, onUpdateDownloadStage,
  updatePauseDownload, updateCancelDownload,
} from './ipc'

/**
 * 全局更新状态中枢 — 标题栏(TitleBar)与设置页(AdvancedView)的唯一数据源。
 * 所有更新动作(check/download/pause/cancel/install)统一走这里的异步方法,
 * 进度事件只由本模块订阅一次,UI 一律只读 store → 两处视图天然同步。
 */

export type UpdatePhase =
  | 'idle'        // 未检查
  | 'checking'    // 检查中
  | 'uptodate'    // 已是最新
  | 'available'   // 有新版本
  | 'downloading' // 下载中
  | 'paused'      // 暂停(断点保留)
  | 'downloaded'  // 下载完成,待安装
  | 'error'       // 检查/下载失败(见 reason)

export type UpdateFailReason =
  | 'size-mismatch' | 'sha512-mismatch' | 'network' | 'stalled' | 'channel-all-failed' | 'cancelled' | 'unknown'

/**
 * 下载子阶段(主进程 update:download-stage 推送) —— 专治「进度无变化时的无声空窗」:
 * verifying = 流已收完、正在算 sha512(133MB 要 1~3s);switching = 上一通道无响应,正在换镜像。
 * 正常收字节时为 downloading,UI 按常规进度渲染。
 */
export type UpdateDownloadStage = 'downloading' | 'verifying' | 'switching'

export interface UpdateCheckInfo {
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  notes: string
  asset: { name: string; url: string; size: number } | null
}

export interface UpdateSnapshot {
  phase: UpdatePhase
  check: UpdateCheckInfo | null
  progress: { percent: number; receivedBytes: number; totalBytes: number }
  /** 下载子阶段:progress 长时间不变时也有可读反馈(校验空窗 / 换镜像) */
  stage: UpdateDownloadStage
  error: string
  reason: UpdateFailReason
  /** latest.yml 缺失(发布侧三件套不全),仅剩 size 校验兜底 */
  metaMissing: boolean
  downloadedPath: string
}

// ---- 可变状态(仅本模块可写) ----
let phase: UpdatePhase = 'idle'
let check: UpdateCheckInfo | null = null
let progress = { percent: 0, receivedBytes: 0, totalBytes: 0 }
let stage: UpdateDownloadStage = 'downloading'
let error = ''
let reason: UpdateFailReason = 'unknown'
let metaMissing = false
let downloadedPath = ''

let snap: UpdateSnapshot = buildSnapshot()
const listeners = new Set<() => void>()

function buildSnapshot(): UpdateSnapshot {
  return { phase, check, progress, stage, error, reason, metaMissing, downloadedPath }
}

function emit(): void {
  snap = buildSnapshot()
  for (const l of listeners) l()
}

function set(patch: {
  phase?: UpdatePhase
  check?: UpdateCheckInfo | null
  progress?: typeof progress
  stage?: UpdateDownloadStage
  error?: string
  reason?: UpdateFailReason
  metaMissing?: boolean
  downloadedPath?: string
}): void {
  if (patch.phase !== undefined) phase = patch.phase
  if (patch.check !== undefined) check = patch.check
  if (patch.progress !== undefined) progress = patch.progress
  if (patch.stage !== undefined) stage = patch.stage
  if (patch.error !== undefined) error = patch.error
  if (patch.reason !== undefined) reason = patch.reason
  if (patch.metaMissing !== undefined) metaMissing = patch.metaMissing
  if (patch.downloadedPath !== undefined) downloadedPath = patch.downloadedPath
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): UpdateSnapshot {
  return snap
}

/** React 订阅入口:const upd = useUpdateStore() */
export function useUpdateStore(): UpdateSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** 失败分类:'integrity' → 换镜像/重新下载;'network' → 重试;其余展示原始 message */
export function updateFailKind(reason: UpdateFailReason): 'integrity' | 'network' | 'neutral' {
  if (reason === 'size-mismatch' || reason === 'sha512-mismatch') return 'integrity'
  if (reason === 'network' || reason === 'channel-all-failed' || reason === 'stalled') return 'network'
  return 'neutral'
}

/** 失败态展示文案(按 reason 结构化,不再让用户猜) */
export function updateFailMessage(s: UpdateSnapshot): string {
  switch (s.reason) {
    case 'size-mismatch': return '下载内容校验失败:文件大小不符,服务器文件可能未传完整'
    case 'sha512-mismatch': return '下载内容校验失败:SHA512 校验不符,镜像可能返回了坏字节'
    case 'network': return '网络连接失败,请检查网络或更换下载镜像'
    // stalled = 通道挂着不停也不回,15s 窗口内零新字节;已自动换过通道,全部失败才会走到这里
    case 'stalled': return '下载通道长时间无响应(可能被限速或中途静默),已尝试更换镜像;可重试或在设置里更换下载镜像'
    case 'channel-all-failed': return '所有下载通道均失败,请检查网络或更换下载镜像'
    default: return s.error || '下载失败'
  }
}

/**
 * 下载中「非进度类」提示文案 —— downloading 返回 null(此时按常规进度条渲染)。
 * 两处更新 UI(TitleBar / AboutView)共用,避免各写一份后措辞漂移。
 */
export function updateStageText(stage: UpdateDownloadStage): string | null {
  if (stage === 'verifying') return '校验中…'
  if (stage === 'switching') return '通道无响应,正在切换镜像…'
  return null
}

// ---- 进度事件:全局只订阅一次 ----
let progressBound = false
function bindProgressOnce(): void {
  if (progressBound || typeof window === 'undefined' || !window.api) return
  progressBound = true
  onUpdateDownloadProgress(p => {
    progress = { percent: p.percent, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes }
    if (phase === 'downloading') emit()
  })
  // 阶段事件与进度同源、只订阅一次;相同阶段直接丢弃(主进程每次候选都会重发 downloading)
  onUpdateDownloadStage(s => {
    if (s.stage === stage) return
    stage = s.stage
    if (phase === 'downloading') emit()
  })
}

// ---- 动作 ----

/** 手动检查(设置页/标题栏) */
export async function updateCheck(): Promise<void> {
  bindProgressOnce()
  if (!window.api) return
  set({ phase: 'checking', error: '', reason: 'unknown' })
  try {
    const r = await checkForUpdate()
    if (!r.ok) {
      set({ phase: 'error', error: r.message || '检查失败,请检查网络', reason: 'network', check: null })
      return
    }
    if (r.hasUpdate && r.asset) {
      set({
        phase: 'available',
        check: { currentVersion: r.currentVersion, latestVersion: r.latestVersion, releaseUrl: r.releaseUrl, notes: r.notes, asset: r.asset },
        error: '', metaMissing: false, progress: { percent: 0, receivedBytes: 0, totalBytes: r.asset.size },
      })
    } else {
      set({ phase: 'uptodate', error: '' })
    }
  } catch (e: any) {
    set({ phase: 'error', error: e?.message || '检查失败,请检查网络', reason: 'network' })
  }
}

/** 下载(available/paused → downloading;断点续传由主进程负责) */
export async function updateDownload(): Promise<void> {
  bindProgressOnce()
  if (!window.api || !check?.asset || phase === 'downloading') return
  set({ phase: 'downloading', stage: 'downloading', error: '', reason: 'unknown', metaMissing: false })
  try {
    const r = await downloadUpdate(check.asset.url, check.asset.name, check.asset.size)
    if (r.success && r.filePath) {
      set({
        phase: 'downloaded', stage: 'downloading', downloadedPath: r.filePath,
        metaMissing: !!r.metaMissing,
        progress: { percent: 100, receivedBytes: r.receivedBytes ?? check.asset.size, totalBytes: check.asset.size },
      })
    } else if (r.paused) {
      set({ phase: 'paused' }) // 进度与阶段保留在暂停时的值(继续下载时由主进程重新推 downloading)
    } else if (r.cancelled) {
      set({ phase: 'available', stage: 'downloading', progress: { percent: 0, receivedBytes: 0, totalBytes: check.asset.size } })
    } else {
      set({ phase: 'error', stage: 'downloading', error: r.message || '下载失败', reason: r.reason || 'unknown', progress: { percent: 0, receivedBytes: 0, totalBytes: check.asset.size } })
    }
  } catch (e: any) {
    set({ phase: 'error', stage: 'downloading', error: e?.message || '下载失败', reason: 'network' })
  }
}

/** 暂停(下载 promise 将以 paused 结束,由 updateDownload 收尾) */
export async function updatePause(): Promise<void> {
  if (!window.api) return
  await updatePauseDownload().catch(() => {})
}

/** 取消(清除断点,回到 available) */
export async function updateCancel(): Promise<void> {
  if (!window.api) return
  await updateCancelDownload().catch(() => {})
  // phase 修正由 updateDownload 的 cancelled 分支完成;无进行中下载时在此兜底
  if (phase === 'downloading' || phase === 'paused') {
    set({ phase: 'available', stage: 'downloading', progress: { percent: 0, receivedBytes: 0, totalBytes: check?.asset?.size || 0 } })
  }
}

/** 运行安装程序 */
export async function updateInstall(): Promise<void> {
  if (!window.api || !downloadedPath) return
  try {
    const r = await installUpdate(downloadedPath)
    if (!r.success) set({ phase: 'error', error: r.message || '启动安装程序失败', reason: 'unknown' })
    // 成功 → 安装程序接管,应用即将退出重启,无需变更状态
  } catch (e: any) {
    set({ phase: 'error', error: e?.message || '启动安装程序失败', reason: 'unknown' })
  }
}

/**
 * 启动静默检查(仅标题栏调用):延迟 6s 不与启动初始化抢网络/IO,
 * 失败按 10s 间隔重试 3 次后彻底静默(不进 error 态,避免网络抖动打扰用户)。
 * 全局只执行一次,重复调用是幂等 no-op。
 */
let startupStarted = false
export function updateStartupCheck(): void {
  if (startupStarted) return
  startupStarted = true
  let attempt = 0
  const run = async (): Promise<void> => {
    bindProgressOnce()
    if (!window.api) return
    // 用户已手动触发下载/安装 → 不再静默检查,避免覆盖进行中的状态
    if (phase === 'downloading' || phase === 'paused' || phase === 'downloaded') return
    set({ phase: 'checking', error: '' })
    try {
      const r = await checkForUpdate()
      if (r.ok && r.hasUpdate && r.asset) {
        set({
          phase: 'available',
          check: { currentVersion: r.currentVersion, latestVersion: r.latestVersion, releaseUrl: r.releaseUrl, notes: r.notes, asset: r.asset },
          progress: { percent: 0, receivedBytes: 0, totalBytes: r.asset.size },
        })
        return
      }
      if (r.ok) { set({ phase: 'uptodate' }); return }
    } catch { /* fallthrough */ }
    if (attempt < 3) {
      attempt++
      window.setTimeout(run, 10000)
    } else {
      set({ phase: 'idle' }) // 静默放弃
    }
  }
  window.setTimeout(run, 6000)
}
