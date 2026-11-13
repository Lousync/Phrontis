import { useCallback, useEffect, useState } from 'react'
import type { ShareCardData } from '../../types'
import { shareCardGet } from '../../lib/ipc'
import { useDataChanged } from '../../lib/dataChanged'

/**
 * 分享卡片的数字（`shareCard:get` 一次取全）。
 *
 * 订阅 `habit` / `pomodoro` 数据变化：在别处打卡或结束一场专注后切回右栏，
 * 卡片数字立刻跟上（v3.24.0 起番茄钟有独立 scope）。
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
  useDataChanged('pomodoro', load)

  return { data, error, reload: load }
}
