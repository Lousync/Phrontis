import { useCallback, useEffect, useState } from 'react'
import type { ShareCardData } from '../../types'
import { shareCardGet } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'

/**
 * 分享卡片的数字（`shareCard:get` 一次取全）。
 *
 * 订阅 `habit` 数据变化：在别处打卡后切回右栏，卡片数字立刻跟上。
 * 番茄钟没有独立的 data-changed scope（`DataChangeScope` 里没有 pomodoro），
 * 所以「今日专注」靠**进入分享态时重新取一次**刷新 —— 右栏 Tab 切换会挂载/卸载本面板，
 * 这个时机足够（不会出现「刚做完番茄钟切过来还是旧数字」的常见路径）。
 */
export function useShareCardData() {
  const [data, setData] = useState<ShareCardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await shareCardGet()
      setData(d)
      setError(null)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useDataChanged('habit', load)

  return { data, error, reload: load }
}
