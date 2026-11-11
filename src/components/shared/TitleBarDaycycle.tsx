/**
 * 昼夜动态主题的顶栏时间胶囊（方案 docs/daycycle-theme-plan.md）
 *
 * 背景天空已升级为整窗层（DaycycleBackdrop，App 根部挂载）——这里只保留右侧
 * `HH:MM · 阶段` 胶囊；颜色全部来自引擎每分钟下发的 CSS 变量，组件自身零配色。
 *
 * 胶囊是 no-drag，不挡标题栏拖拽；天空层 pointer-events:none，见 DaycycleBackdrop。
 */

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { DAYCYCLE_TICK_EVENT, type DaycycleTickDetail } from '../../lib/daycycleEngine'
import { celestialAt, formatMinute } from '../../lib/daycycleTheme'

function localTick(): DaycycleTickDetail {
  const d = new Date()
  const minute = d.getHours() * 60 + d.getMinutes()
  const cel = celestialAt(minute)
  return { minute, phase: '', isNight: cel.night, celX: cel.x, celY: cel.y, celAlt: cel.alt }
}

export function TitleBarDaycycle() {
  const [tick, setTick] = useState<DaycycleTickDetail>(localTick)

  useEffect(() => {
    const onTick = (e: Event): void => {
      const detail = (e as CustomEvent<DaycycleTickDetail>).detail
      if (detail) setTick(detail)
    }
    window.addEventListener(DAYCYCLE_TICK_EVENT, onTick)
    return () => window.removeEventListener(DAYCYCLE_TICK_EVENT, onTick)
  }, [])

  return (
    <div className="kb-dc-chip no-drag relative z-10 ml-auto mr-3" title="随一天时间变化的动态主题（设置 → 外观 可更换）">
      <span className="kb-dc-chip-icon">{tick.isNight ? <Moon size={12} /> : <Sun size={12} />}</span>
      <span className="kb-dc-chip-time">{formatMinute(tick.minute)}</span>
      <span className="kb-dc-chip-phase">{tick.phase}</span>
    </div>
  )
}
