import { ipcMain, dialog, shell, app, BrowserWindow } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { vaultRecordsAll } from '../../lib/kbStore/habitVaultRepo'
import { checkinWeekCells, checkinHeatGrid } from '../../lib/kbStore/habitStats'
import { heatRate, SHARE_CARD_HEAT_WEEKS } from '../../lib/kbStore/shareCardStats'
import { PRODUCT_SITE } from '../../lib/productInfo'
import { toQrDataUrl } from '../../lib/lanShare/qr'

/**
 * 分享卡片（原「打卡图」）IPC —— 两个通道，都是**只读 + 一次性产物**：
 *
 * - `shareCard:get`      一次取全卡片数字（打卡 + 番茄钟）+ 二维码 dataURL + 官网地址。
 *   **聚合的理由是「二维码与网址同源」**：两者都在主进程产出，渲染层不写这个 URL
 *   （唯一真源 = lib/productInfo.ts）。
 * - `shareCard:savePng`  另存为 PNG（对话框 → 落盘 → 资源管理器定位）。
 *
 * 卡片正文由渲染层的 `renderShareCard.ts` 画在 canvas 上，本仓不参与绘制；
 * 数字口径各自在 habitStats / shareCardStats（纯函数，契约脚本直接装载）。
 */

export interface ShareCardData {
  /** 'YYYY-MM-DD'（本地时区） */
  date: string
  week: { done: number; total: number; cells: boolean[] }
  heat: { weeks: number; rate: number; grid: boolean[] }
  /** 官网地址（主进程单一来源，渲染层只消费） */
  siteUrl: string
  /** 官网二维码 PNG dataURL */
  qrDataUrl: string
}

/** 本地时区 'YYYY-MM-DD'（与 habitStats 的 UTC 天序号口径在「同一日历日」上一致） */
function localDateKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function registerShareCardHandlers(): void {
  ipcMain.handle('shareCard:get', async (): Promise<ShareCardData> => {
    const today = localDateKey()
    const records = vaultRecordsAll().map((r) => ({ date: r.date }))
    const week = checkinWeekCells(records, today)
    const grid = checkinHeatGrid(records, today, SHARE_CARD_HEAT_WEEKS)
    return {
      date: today,
      week: { done: week.done, total: 7, cells: week.cells },
      heat: { weeks: SHARE_CARD_HEAT_WEEKS, rate: heatRate(grid), grid },
      siteUrl: PRODUCT_SITE,
      qrDataUrl: await toQrDataUrl(PRODUCT_SITE, 512),
    }
  })

  ipcMain.handle('shareCard:savePng', (_e, payload: { data?: Uint8Array; defaultName?: string }) => {
    try {
      const { data, defaultName } = payload ?? {}
      if (!data || data.length === 0) return { ok: false, error: '图片内容为空' }
      const win = BrowserWindow.getFocusedWindow() ?? undefined
      const name = String(defaultName ?? '').trim() || `Phrontis打卡-${localDateKey().replace(/-/g, '')}.png`
      const r = dialog.showSaveDialogSync(win as BrowserWindow, {
        title: '另存为',
        defaultPath: join(app.getPath('pictures'), name.endsWith('.png') ? name : `${name}.png`),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      })
      if (!r) return { ok: false, cancelled: true }
      writeFileSync(r, Buffer.from(data))
      shell.showItemInFolder(r)
      return { ok: true, path: r }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) }
    }
  })
}
