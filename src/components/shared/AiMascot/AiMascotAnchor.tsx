import { memo, useEffect, useState } from 'react'
import { useSettings } from '../../../lib/SettingsContext'
import { useAiActivity, useAiBusy } from '../../../lib/aiActivity'
import { pluginListMascots, onPluginInstalledChanged } from '../../../lib/ipc'
import { PlaceholderMascot } from './PlaceholderMascot'
import { MascotPlayer } from './MascotPlayer'
import type { PluginMascotInfo } from '../../../types'

/**
 * AI 输入区吉祥物挂载壳（.claude/plans/ai-composer-mascot.md §4.3；插件化后支持多角色选择）。
 *
 * 挂在输入卡（`position: relative`）**内部**：在卡上沿右缘渲染当前选中的吉祥物
 * （`.kb-mascot-anchor` 绝对定位于 `bottom: 100%`，脚踩卡边）。
 * 设置 `aiMascot`（string）：
 * - `off` → 零渲染（宿主界面零侵入）；
 * - `placeholder` → 内置占位角色；
 * - `auto`（缺省）→ 第一只已安装插件吉祥物，没有则占位；
 * - `<mascotId>` → 命中该角色，没有则回落 auto。
 * 插件安装 / 启停 / 卸载后经 `onPluginInstalledChanged` 重新解析可用角色。
 */
export const AiMascotAnchor = memo(function AiMascotAnchor() {
  const { s } = useSettings()
  const activity = useAiActivity()
  const busy = useAiBusy()
  const [list, setList] = useState<PluginMascotInfo[]>([])

  useEffect(() => {
    let alive = true
    const load = (): void => {
      pluginListMascots()
        .then(l => { if (alive) setList(l) })
        .catch(() => { if (alive) setList([]) }) // 插件线不可用视为无贡献 → 用占位
    }
    load()
    const off = onPluginInstalledChanged(load)
    return () => { alive = false; off() }
  }, [])

  const sel = typeof s.aiMascot === 'string' ? s.aiMascot : 'auto'
  if (sel === 'off') return null
  const mascot = sel === 'placeholder'
    ? null
    : (sel === 'auto' ? (list[0] ?? null) : (list.find(m => m.id === sel) ?? list[0] ?? null))

  return (
    <div className="kb-mascot-anchor" aria-hidden>
      {mascot ? <MascotPlayer mascot={mascot} activity={activity} busy={busy} /> : <PlaceholderMascot activity={activity} />}
    </div>
  )
})
