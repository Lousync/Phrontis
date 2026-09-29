import { ipcMain } from 'electron'
import { vaultPetGet, vaultPetFeed, vaultPetPetTouch, vaultPetRename, vaultPetReset, vaultPetSwitchSpecies } from '../../lib/kbStore/petVaultRepo'
import { broadcastDataChanged } from '../../main/windowBus'

/**
 * 桌宠 IPC 注册（2026-09-28，docs/pet-design.md）。
 *
 * 状态真相源在 petVaultRepo（衰减/活跃度/成长都在主进程结算），
 * 这里只做转发 + 写操作后的跨窗口广播（scope 对齐 src/lib/dataChanged.ts）。
 * channel 命名对齐 `<模块>:<动作>` 规范（bookmarkRepo 样板）。
 */
export function registerPetHandlers(): void {
  ipcMain.handle('pet:get', () => vaultPetGet())
  ipcMain.handle('pet:feed', () => {
    const snap = vaultPetFeed()
    broadcastDataChanged('pet')
    return snap
  })
  ipcMain.handle('pet:petTouch', () => {
    const snap = vaultPetPetTouch()
    broadcastDataChanged('pet')
    return snap
  })
  ipcMain.handle('pet:rename', (_e, data: { name: string }) => {
    const snap = vaultPetRename(data.name)
    broadcastDataChanged('pet')
    return snap
  })
  ipcMain.handle('pet:switchSpecies', (_e, data: { species: string }) => {
    const snap = vaultPetSwitchSpecies(data.species)
    broadcastDataChanged('pet')
    return snap
  })
  ipcMain.handle('pet:reset', (_e, data: { species: string }) => {
    const snap = vaultPetReset(data.species)
    broadcastDataChanged('pet')
    return snap
  })
}
