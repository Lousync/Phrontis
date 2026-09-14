import { app, ipcMain, shell, net } from 'electron'
import { broadcast, BROADCAST_CHANNEL } from '../main/windowBus'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

/**
 * 应用更新检查/下载 —— 基于 GitHub Releases。
 * 检查:releases/latest API 对比本地 app.getVersion();
 * 下载:主进程流式下载安装包到系统"下载"目录,进度实时推送渲染层;
 *       优先走设置里的镜像前缀(updateMirror,ghproxy 协议 https://镜像/https://github.com/...),
 *       失效自动回退直连;安装:运行下载好的安装包。
 */

const REPO = 'Lousync/Phrontis'
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases`

/** 设置读取器(registerUpdateHandlers 注入) */
let getSettingValue: (key: string) => unknown = () => undefined

/**
 * 镜像默认值 — 与 src/lib/settings.ts 的 updateMirror 默认值保持一致。
 * 主进程读的是原始 settings.json 缓存,未写过该 key 时拿不到渲染层注册表的默认值,
 * 故此处兜底;用户显式置空字符串 = 强制直连。
 */
const DEFAULT_UPDATE_MIRROR = 'https://gh-proxy.com'

/** 规范化用户配置的镜像前缀:非法返回 null(空串视为直连) */
function resolveMirror(): string | null {
  const raw = getSettingValue('updateMirror')
  let s: string
  if (raw === undefined || raw === null) s = DEFAULT_UPDATE_MIRROR // 从未配置过 → 用默认镜像
  else { s = String(raw).trim().replace(/\/+$/, ''); if (!s) return null } // 显式空串 = 直连
  if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(s)) return null
  return s
}

/** 已知可用的 ghproxy 节点(下载速度与缓存健康度不定,作为用户镜像之后的兜底候选) */
const FALLBACK_MIRRORS = ['https://gh-proxy.com', 'https://gh.dpik.top', 'https://cdn.gh-proxy.com']

/**
 * 由已通过白名单校验的 GitHub URL 构造下载候选列表:
 * [用户镜像, 备用镜像..., 直连] —— 镜像在前保速度,直连兜底保可用;
 * 配合下载后的 sha512 校验,任何节点返回坏字节都会被识别并自动换下一候选。
 */
function downloadCandidates(url: string): string[] {
  const mirror = resolveMirror()
  const list: string[] = []
  if (mirror) list.push(`${mirror}/${url}`)
  for (const m of FALLBACK_MIRRORS) {
    if (m !== mirror) list.push(`${m}/${url}`)
  }
  list.push(url)
  return list
}

export interface UpdateAsset { name: string; url: string; size: number }

/**
 * 结构化失败原因 — UI 据此渲染差异化操作(重试/换镜像/稍后再试):
 * size-mismatch/sha512-mismatch → 服务器文件或镜像坏字节;network/channel-all-failed → 网络类;
 * cancelled/paused → 主动中止,不算错误。
 */
export type UpdateFailReason =
  | 'size-mismatch' | 'sha512-mismatch' | 'network' | 'channel-all-failed' | 'cancelled' | 'unknown'

/** 失败发生环节(download → verify → sha512),供 UI 文案精准定位 */
export type UpdateFailStep = 'download' | 'verify' | 'sha512'

/** 带结构化原因的错误,downloadOne/verify 链路统一抛出 */
class UpdateError extends Error {
  constructor(message: string, public reason: UpdateFailReason) { super(message) }
}

export interface UpdateCheckResult {
  ok: boolean
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  notes: string
  asset: UpdateAsset | null
  message?: string
}

function normalizeVersion(v: string): number[] {
  const cleaned = v.trim().replace(/^v/i, '').split('-')[0]
  return cleaned.split('.').map(n => parseInt(n, 10) || 0)
}

/** semver 比较:latest 是否比 current 新(供插件更新检查复用) */
export function isNewerVersion(latest: string, current: string): boolean {
  return isNewer(latest, current)
}

function isNewer(latest: string, current: string): boolean {
  const a = normalizeVersion(latest)
  const b = normalizeVersion(current)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false
  }
  return false
}

/** 从 release 资产里挑安装包:优先 Windows .exe 安装程序,其次 .zip,再次第一个资产 */
function pickAsset(assets: any[]): UpdateAsset | null {
  if (!Array.isArray(assets) || assets.length === 0) return null
  const byExt = (ext: string) => assets.find(a => typeof a?.name === 'string' && a.name.toLowerCase().endsWith(ext))
  const picked = byExt('.exe') || byExt('.zip') || assets[0]
  if (!picked?.browser_download_url) return null
  return { name: String(picked.name), url: String(picked.browser_download_url), size: Number(picked.size) || 0 }
}

function pushProgress(percent: number, receivedBytes: number, totalBytes: number): void {
  broadcast(BROADCAST_CHANNEL.updateDownloadProgress, { percent, receivedBytes, totalBytes })
}

/** 慢速保护:15s 内收到的字节不足 2MB(≈136KB/s)判定为慢通道,放弃换下一候选 */
const SLOW_WINDOW_MS = 15000
const SLOW_MIN_BYTES = 2 * 1024 * 1024

function partialSize(dest: string): number {
  try { return statSync(dest).size } catch { return 0 }
}

/** 候选 URL 使用的镜像前缀('' = 直连) — 供下载中镜像切换检测比对 */
function mirrorPrefixOf(candidate: string): string {
  const current = resolveMirror()
  if (current && candidate.startsWith(current + '/')) return current
  for (const m of FALLBACK_MIRRORS) {
    if (candidate.startsWith(m + '/')) return m
  }
  return ''
}

/** 从单通道下载到 dest,流式推送进度;支持断点续传(Range)、外部中断与镜像切换感知;失败抛出(由上层换通道) */
async function downloadOne(
  candidate: string,
  dest: string,
  expectedSize: number | undefined,
  signal: AbortSignal,
  startOffset: number,
  mirrorPrefix: string,
): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': 'Knowbase-App' }
  if (startOffset > 0) headers['Range'] = `bytes=${startOffset}-`
  const r = await net.fetch(candidate, { headers, redirect: 'follow', signal }).catch((e: any) => {
    throw new UpdateError(`${new URL(candidate).hostname} ${e?.message || '网络请求失败'}`, 'network')
  })
  const ctype = String(r.headers.get('content-type') || '')
  if (!r.ok || !r.body) throw new UpdateError(`${new URL(candidate).hostname} HTTP ${r.status}`, 'network')
  if (/text\/html/i.test(ctype)) throw new UpdateError(`${new URL(candidate).hostname} 返回的是网页而非文件`, 'network')

  // 服务器不支持 Range(应答 200 而非 206)→ 只能从头重下
  let offset = startOffset
  if (offset > 0 && r.status !== 206) offset = 0
  const segTotal = Number(r.headers.get('content-length') || 0)
  const totalFull = r.status === 206 ? offset + segTotal : segTotal
  // 大小前置校验:content-length 与期望不符 → 直接判坏字节,避免白下载整包
  if (expectedSize && totalFull > 0 && totalFull !== expectedSize) {
    throw new UpdateError(`文件大小不符(期望 ${expectedSize},实际 ${totalFull}),服务器文件可能未传完整`, 'size-mismatch')
  }
  const out = createWriteStream(dest, { flags: offset > 0 ? 'a' : 'w' })
  let received = 0
  let lastPct = -1
  let slowTimer: NodeJS.Timeout | null = null
  let mirrorTimer: NodeJS.Timeout | null = null
  const reader = Readable.fromWeb(r.body as import('stream/web').ReadableStream)

  // 镜像纠错:下载中用户更换代理源 → 2s 内感知,中止当前通道,由上层按新镜像重算候选断点续传
  mirrorTimer = setInterval(() => {
    if (resolveMirror() !== mirrorPrefix) reader.destroy(new Error('MIRROR_CHANGED'))
  }, 2000)
  mirrorTimer.unref?.()

  reader.on('data', (chunk: Buffer) => {
    received += chunk.length
    const done = offset + received
    const pct = totalFull > 0 ? Math.round((done / totalFull) * 100) : 0
    if (pct !== lastPct) {
      lastPct = pct
      pushProgress(pct, done, totalFull)
    }
  })
  try {
    await new Promise<void>((res, rej) => {
      const host = new URL(candidate).hostname
      const scheduleSlowCheck = () => {
        slowTimer = setTimeout(() => {
          if (received < SLOW_MIN_BYTES) {
            reader.destroy()
            rej(new UpdateError(`${host} 下载过慢(15s 内不足 2MB),已切换通道`, 'network'))
          } else {
            scheduleSlowCheck()
          }
        }, SLOW_WINDOW_MS)
      }
      scheduleSlowCheck()
      pipeline(reader, out).then(res, e => { if (slowTimer) clearTimeout(slowTimer); rej(e) })
      signal.addEventListener('abort', () => { try { reader.destroy() } catch { /* ignore */ } }, { once: true })
    })
  } finally {
    if (slowTimer) clearTimeout(slowTimer)
    if (mirrorTimer) clearInterval(mirrorTimer)
  }
  // 流结束后的兜底校验:chunked/无 content-length 时服务器提前断流也会被截获
  if (expectedSize && statSync(dest).size !== expectedSize) {
    throw new UpdateError(`文件大小不符(期望 ${expectedSize},实际 ${statSync(dest).size}),服务器文件可能未传完整`, 'size-mismatch')
  }
}

/** 下载文件完整性校验:size(若有) + latest.yml 的 sha512(若可取);任一不符即视为坏字节。
 *  metaFound=false 表示三件套中的 latest.yml 缺失(发布侧事故信号),仅剩 size 校验兜底。 */
async function verifyInstaller(dest: string, expectedSize: number | undefined, assetUrl: string): Promise<{ ok: boolean; message?: string; reason?: UpdateFailReason; step?: UpdateFailStep; metaFound: boolean }> {
  let metaFound = false
  try {
    if (expectedSize && statSync(dest).size !== expectedSize) {
      return { ok: false, message: '文件大小不符,疑似坏字节', reason: 'size-mismatch', step: 'verify', metaFound }
    }
    let sha512 = ''
    try {
      // latest.yml 与安装包同目录:镜像通道同样可用
      const ymlUrl = assetUrl.replace(/\/[^/]+$/, '/latest.yml')
      for (const candidate of downloadCandidates(ymlUrl)) {
        try {
          const r = await net.fetch(candidate, { headers: { 'User-Agent': 'Knowbase-App' }, redirect: 'follow' })
          if (!r.ok || !r.body || /text\/html/i.test(String(r.headers.get('content-type') || ''))) continue
          const txt = await r.text()
          const m = /sha512:\s*([A-Za-z0-9+/=]+)/.exec(txt)
          if (m) { sha512 = m[1]; metaFound = true; break }
        } catch { /* 换下一候选 */ }
      }
    } catch { /* 取不到 latest.yml → 退回仅 size 校验 */ }
    if (sha512) {
      const expected = Buffer.from(sha512, 'base64')
      const hash = createHash('sha512')
      const buf = await new Promise<Buffer>((res, rej) => {
        const s = require('fs').createReadStream(dest)
        s.on('data', (c: Buffer) => hash.update(c))
        s.on('end', () => res(hash.digest()))
        s.on('error', rej)
      })
      if (!buf.equals(expected)) {
        return { ok: false, message: '文件校验和(SHA512)不符,镜像可能返回了坏字节', reason: 'sha512-mismatch', step: 'sha512', metaFound }
      }
    }
    return { ok: true, metaFound }
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e), reason: 'unknown', step: 'verify', metaFound }
  }
}

/**
 * 安装包清理:install 触发时在 userData 记录 {安装包路径, 触发时版本}。
 * 下次启动若版本已变化(= 安装完成)则删除安装包;版本未变(安装被取消/失败)则保留供重试。
 */
function installerCleanupMarkerPath(): string {
  return join(app.getPath('userData'), 'pending-installer-cleanup.json')
}

function markInstallerForCleanup(filePath: string): void {
  try {
    writeFileSync(installerCleanupMarkerPath(), JSON.stringify({ filePath, fromVersion: app.getVersion() }), 'utf-8')
  } catch { /* 清理是尽力而为 */ }
}

function runInstallerStartupCleanup(): void {
  try {
    const p = installerCleanupMarkerPath()
    const { filePath, fromVersion } = JSON.parse(readFileSync(p, 'utf-8'))
    if (fromVersion !== app.getVersion() && existsSync(filePath)) unlinkSync(filePath)
    unlinkSync(p)
  } catch { /* 无标记或已清理 */ }
}

export function registerUpdateHandlers(deps?: { getSettingValue?: (key: string) => unknown }): void {
  if (deps?.getSettingValue) getSettingValue = deps.getSettingValue
  runInstallerStartupCleanup()
  ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
    const currentVersion = app.getVersion()
    try {
      const res = await net.fetch(API_LATEST, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Knowbase-App' }
      })
      if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`)
      const rel: any = await res.json()
      const latestVersion = String(rel.tag_name || '').replace(/^v/i, '')
      if (!latestVersion) throw new Error('未找到版本号')
      return {
        ok: true,
        hasUpdate: isNewer(latestVersion, currentVersion),
        currentVersion,
        latestVersion,
        releaseUrl: String(rel.html_url || RELEASES_PAGE),
        notes: String(rel.body || ''),
        asset: pickAsset(rel.assets),
      }
    } catch (e: any) {
      return { ok: false, hasUpdate: false, currentVersion, latestVersion: '', releaseUrl: RELEASES_PAGE, notes: '', asset: null, message: e?.message || String(e) }
    }
  })

let downloading = false
// 下载控制:暂停(保留断点续传)/取消(清除断点)/镜像切换纠错
let pauseRequested = false
let cancelRequested = false
let activeDownloadAbort: AbortController | null = null
let lastDownloadDest = ''

ipcMain.handle('update:download', async (_e, url: string, name: string, expectedSize?: number) => {
    if (downloading) return { success: false, message: '已有下载任务进行中' }
    try {
      const parsed = new URL(url)
      if (!/^https?:$/.test(parsed.protocol) || !/github\.com$/i.test(parsed.hostname)) {
        return { success: false, message: 'URL 不受信任' }
      }
    } catch {
      return { success: false, message: 'URL 非法' }
    }
    const safeName = String(name || 'Knowbase-setup.exe').split(/[\\/]/).pop() || 'Knowbase-setup.exe'
    downloading = true
    pauseRequested = false
    cancelRequested = false
    activeDownloadAbort = new AbortController()
    const dir = app.getPath('downloads')
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
    const dest = join(dir, safeName)
    lastDownloadDest = dest
    let lastErr = ''
    let lastReason: UpdateFailReason = 'channel-all-failed'
    let lastStep: UpdateFailStep = 'download'
    let metaMissing = false
    try {
      // 逐个候选通道:下载 → 完整性校验 → 通过才返回;坏字节自动换下一通道。
      // 暂停=中止但保留断点(下次 download 从断点 Range 续传);取消=中止并清除断点;
      // 下载中更换镜像 → downloadOne 2s 内感知抛 MIRROR_CHANGED → 重算候选列表断点续传。
      let restarts = 0
      let restart = true
      while (restart && restarts < 5) {
        restart = false
        for (const candidate of downloadCandidates(url)) {
          if (pauseRequested || cancelRequested) break
          try {
            await downloadOne(candidate, dest, expectedSize, activeDownloadAbort.signal, partialSize(dest), mirrorPrefixOf(candidate))
            const check = await verifyInstaller(dest, expectedSize, url)
            if (check.ok) {
              pushProgress(100, statSync(dest).size, expectedSize || statSync(dest).size)
              // latest.yml 缺失 → 仅剩 size 校验兜底,提示发布侧三件套不全(安装时 NSIS 可能报 integrity check failed)
              return { success: true, filePath: dest, metaMissing: !check.metaFound }
            }
            lastErr = check.message || lastErr
            lastReason = check.reason || 'unknown'
            lastStep = check.step || 'verify'
            try { if (existsSync(dest)) unlinkSync(dest) } catch { /* ignore */ }
          } catch (e: any) {
            if (e?.name === 'AbortError' || pauseRequested || cancelRequested) {
              if (cancelRequested) break
              return { success: false, paused: true, receivedBytes: partialSize(dest), message: '下载已暂停,可随时继续' }
            }
            if (e?.message === 'MIRROR_CHANGED') {
              // 换镜像纠错:断点保留,重算候选列表(新镜像优先)继续下
              restart = true
              restarts++
              break
            }
            lastErr = e?.message || String(e)
            lastReason = e instanceof UpdateError ? e.reason : 'network'
            lastStep = 'download'
            try { if (existsSync(dest)) unlinkSync(dest) } catch { /* ignore */ }
          }
        }
      }
      if (pauseRequested) {
        return { success: false, paused: true, receivedBytes: partialSize(dest), message: '下载已暂停,可随时继续' }
      }
      if (cancelRequested) {
        try { if (existsSync(dest)) unlinkSync(dest) } catch { /* ignore */ }
        return { success: false, cancelled: true, reason: 'cancelled', message: '下载已取消' }
      }
      return { success: false, reason: lastReason, step: lastStep, message: lastErr || '所有下载通道均失败' }
    } finally {
      downloading = false
      activeDownloadAbort = null
    }
  })

  ipcMain.handle('update:pauseDownload', () => {
    if (!downloading) return { ok: false, message: '没有进行中的下载' }
    pauseRequested = true
    activeDownloadAbort?.abort()
    return { ok: true }
  })

  ipcMain.handle('update:cancelDownload', () => {
    if (downloading) {
      cancelRequested = true
      activeDownloadAbort?.abort()
      return { ok: true }
    }
    // 暂停态取消:清理断点文件
    if (lastDownloadDest && existsSync(lastDownloadDest)) {
      try { unlinkSync(lastDownloadDest) } catch { /* ignore */ }
      return { ok: true, removedPartial: true }
    }
    return { ok: false, message: '没有进行中的下载' }
  })

  ipcMain.handle('update:install', async (_e, filePath: string) => {
    // 仅允许运行系统"下载"目录内的安装包
    try {
      const downloads = resolve(app.getPath('downloads'))
      const resolved = resolve(filePath)
      if (!resolved.startsWith(downloads.endsWith('\\') ? downloads : downloads + '\\')) {
        return { success: false, message: '路径不受信任' }
      }
      if (!existsSync(resolved)) return { success: false, message: '安装包不存在' }
      const err = await shell.openPath(resolved)
      if (err) return { success: false, message: err }
      markInstallerForCleanup(resolved)
      return { success: true }
    } catch (e: any) {
      return { success: false, message: e?.message || String(e) }
    }
  })
}
