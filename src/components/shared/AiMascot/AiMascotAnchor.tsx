import { memo, useEffect, useState } from 'react'
import { useSettings } from '../../../lib/SettingsContext'
import { useAiActivity, useAiBusy } from '../../../lib/aiActivity'
import { pluginListMascots } from '../../../lib/ipc'
import { PlaceholderMascot } from './PlaceholderMascot'
import { MascotPlayer } from './MascotPlayer'
import type { PluginMascotInfo } from '../../../types'

/**
 * AI 输入区吉祥物挂载壳（.claude/plans/ai-composer-mascot.md §4.3）。
 *
 * 挂在输入卡（`position: relative`）**内部**：在卡上沿右缘渲染当前启用的吉祥物
 * （`.kb-mascot-anchor` 绝对定位于 `bottom: 100%`，脚踩卡边）。
 * - 设置 `aiMascot` 关 → 零渲染（宿主界面零侵入）。
 * - 有启用插件贡献吉祥物 → `MascotPlayer` 播放其动画表；否则回落内置占位角色。
 */
export const AiMascotAnchor = memo(function AiMascotAnchor() {
  const { s } = useSettings()
  const activity = useAiActivity()
  const busy = useAiBusy()
  const [mascot, setMascot] = useState<PluginMascotInfo | null>(null)

  useEffect(() => {
    let alive = true
    pluginListMascots()
      .then(list => { if (alive) setMascot(list[0] ?? null) })
      .catch(() => { /* 插件线不可用视为无贡献 → 用占位 */ })
    return () => { alive = false }
  }, [])

  if (s.aiMascot === false) return null
  return (
    <div className="kb-mascot-anchor" aria-hidden>
      {mascot ? <MascotPlayer mascot={mascot} activity={activity} busy={busy} /> : <PlaceholderMascot activity={activity} />}
    </div>
  )
})
