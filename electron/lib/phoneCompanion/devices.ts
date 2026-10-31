import { globalReadJson, globalWriteJson } from '../globalJsonStore'
import type { CompanionDevice } from './server'

/**
 * 手机伴侣：已配对设备表持久化（应用全局，与 vault 无关）。
 * 存 %APPDATA%/knowbase/data/phone-companion.json —— 换电脑不跟 vault 走，
 * 每台电脑各自配对一次（与「vault 才是真相源」不冲突：令牌只是连接凭证）。
 */

const FILE = 'phone-companion.json'

interface StoredShape {
  devices: CompanionDevice[]
}

export function loadPairedDevices(): CompanionDevice[] {
  const data = globalReadJson<StoredShape>(FILE, { devices: [] })
  return Array.isArray(data.devices) ? data.devices : []
}

export function savePairedDevices(list: CompanionDevice[]): void {
  globalWriteJson<StoredShape>(FILE, { devices: list })
}
