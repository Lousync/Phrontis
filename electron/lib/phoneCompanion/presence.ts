import { loadPairedDevices } from './devices'
import { deviceFolderName, isMobileNotesRel } from './notesUsb'
import { getCurrentVault } from 'phrontis-core/kbStore/vaultContext'
import { relative } from 'path'

/**
 * 手机伴侣 · 设备在线判定（v1.6 §4.4 文件树可见性的数据源）。
 * 刻意只依赖 devices + notesUsb 两个零 electron 模块 —— workspaceManager 的
 * ws:listDir 过滤直接 import 本文件，不引入 companion 服务本体（避免环）。
 *
 * 在线 = token 有效且最近 ping 通过：lastSeenAt 在窗口内（服务端每个带令牌请求
 * 都会刷 lastSeenAt，ping 由手机同步引擎周期发起）。
 */

export const DEVICE_ONLINE_WINDOW_MS = 90_000

/** 当前在线设备的文件夹名集合（`移动端/<名>` 的一层；重名设备已按 deviceId 前 4 位消歧） */
export function onlineDeviceFolderNames(now = Date.now()): string[] {
  const devices = loadPairedDevices()
  const online = devices.filter(d => now - d.lastSeenAt < DEVICE_ONLINE_WINDOW_MS)
  // 消歧按**全部配对设备**判重（不是在线集合）——文件夹名必须离线稳定
  const allNames = devices.map(d => d.name)
  return online.map(d => deviceFolderName(d.name, d.deviceId, allNames))
}

/** 绝对路径是否落在当前 vault 的移动端子树内（workspaceManager 写钩子用） */
export function isMobileNoteAbsPath(absPath: string): boolean {
  const root = getCurrentVault()?.rootPath
  if (!root) return false
  const rel = relative(root, absPath).replace(/\\/g, '/')
  return !!rel && !rel.startsWith('..') && isMobileNotesRel(rel)
}
