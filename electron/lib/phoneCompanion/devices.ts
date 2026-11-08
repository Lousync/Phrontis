import { globalReadJson, globalWriteJson } from 'phrontis-core/globalJsonStore'
import type { CompanionDevice } from './server'

/**
 * 手机伴侣：已配对设备表持久化（应用全局，与 vault 无关）。
 * 存 %APPDATA%/knowbase/data/phone-companion.json —— 换电脑不跟 vault 走，
 * 每台电脑各自配对一次（与「vault 才是真相源」不冲突：令牌只是连接凭证）。
 *
 * v1.6 笔记 U 盘模式：notesStates[deviceId] 记每台设备的笔记同步现场
 * （游标 + 设备文件夹内已知条目镜像），handoff-notes-usb-desktop.md §4.3。
 */

const FILE = 'phone-companion.json'

/** 设备文件夹内一条已知笔记的镜像（pull 扫描的比对基线，§4.3） */
export interface DeviceNoteItemState {
  /** 仓库相对路径（移动端/<设备名>/<标题>.md） */
  path: string
  /** 该条当前内容的 LWW 时钟 = frontmatter `updated` */
  updatedAt: string
  /** 上次扫描时的文件 mtime（外部编辑器直改的检测线索） */
  mtimeMs: number
}

export interface DeviceNotesState {
  /** 单调递增（Date.now() 时刻）；0 = 从未同步 */
  cursor: number
  /** noteId → 条目镜像；删除 = 从本表移除（配合全域墓碑） */
  items: Record<string, DeviceNoteItemState>
}

interface StoredShape {
  devices: CompanionDevice[]
  notesStates?: Record<string, DeviceNotesState>
}

export function loadPairedDevices(): CompanionDevice[] {
  const data = globalReadJson<StoredShape>(FILE, { devices: [] })
  return Array.isArray(data.devices) ? data.devices : []
}

/** 读整份存储（含 notesStates），避免 savePairedDevices 覆写丢状态 */
function readAll(): StoredShape {
  const data = globalReadJson<StoredShape>(FILE, { devices: [] })
  return {
    devices: Array.isArray(data.devices) ? data.devices : [],
    notesStates: data.notesStates && typeof data.notesStates === 'object' ? data.notesStates : {},
  }
}

export function savePairedDevices(list: CompanionDevice[]): void {
  const all = readAll()
  globalWriteJson<StoredShape>(FILE, { ...all, devices: list })
}

export function loadNotesState(deviceId: string): DeviceNotesState {
  return readAll().notesStates?.[deviceId] ?? { cursor: 0, items: {} }
}

export function saveNotesState(deviceId: string, state: DeviceNotesState): void {
  const all = readAll()
  const map = all.notesStates ?? {}
  map[deviceId] = state
  globalWriteJson<StoredShape>(FILE, { ...all, notesStates: map })
}
