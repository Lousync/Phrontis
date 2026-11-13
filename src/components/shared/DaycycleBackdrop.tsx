/**
 * 昼夜动态主题 —— 整窗背景层（2026-11-11，方案 docs/daycycle-theme-plan.md）
 *
 * 挂载在 App 根部（PomodoroProvider 内，fixed inset-0 z-[-1]），把原先 36px 顶栏里的
 * 天空延伸成整窗场景：渐变天空 + 太阳/月亮弧线 + 云 + 星空 + 地平线暖光 + 光柱；
 * 沉浸层额外有极光 / 光尘 / 萤火 / 流星 / 越面板的月光 wash。
 *
 * 工程约束：
 * - 颜色全部来自 daycycleEngine 每分钟写下的 CSS 变量，组件自身零配色；
 * - 场景 pointer-events:none，绝不抢标题栏 drag-region / 内容点击；
 * - 天体位置用 transform + 60s linear 过渡（只动 transform，铁律 13）；
 * - 粒子数组用固定 seed 生成一次，分钟 tick 只改 CSS 变量，不重排 DOM；
 * - `prefers-reduced-motion` 下所有循环动画停，颜色仍随分钟更新；
 * - 专注模式（禅模式 Z2 / 番茄钟运行）由 Host 计算，只把 `is-focus` 交给场景，
 *   通过 --dc-fx-scale 降云 / 星 / 粒子，不关背景本身。
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DAYCYCLE_TICK_EVENT, type DaycycleTickDetail } from '../../lib/daycycleEngine'
import { celestialAt } from '../../lib/daycycleTheme'
import { useSettings } from '../../lib/SettingsContext'
import { usePomodoro } from '../../modules/toolbox/hooks/PomodoroContext'

interface StarSpec { left: number; top: number; size: number; dur: number; delay: number; bright: boolean }
interface CloudSpec { left: number; top: number; w: number; h: number; o: number; blur: number; dur: number; delay: number }
interface ParticleSpec { left: number; top: number; size: number; dur: number; delay: number; dx: number; dy: number }
interface ShootSpec { left: number; top: number; delay: number }

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 固定 seed：每次启动的星空 / 云 / 粒子分布一致，避免分钟 tick 抖动 */
function buildScene(): {
  stars: StarSpec[]
  clouds: CloudSpec[]
  motes: ParticleSpec[]
  fireflies: ParticleSpec[]
  shooting: ShootSpec[]
} {
  const rnd = mulberry32(20261111)

  const stars: StarSpec[] = []
  for (let i = 0; i < 92; i++) {
    const bright = rnd() > .86
    stars.push({
      left: rnd() * 100,
      top: rnd() * 72,
      size: bright ? 1.9 + rnd() * 1.4 : .9 + rnd() * 1.3,
      dur: 3.6 + rnd() * 5.4,
      delay: -rnd() * 8,
      bright,
    })
  }

  const clouds: CloudSpec[] = [
    { left: 2, top: 10, w: 230, h: 26, o: .23, blur: 18, dur: 58, delay: -11 },
    { left: 33, top: 19, w: 170, h: 20, o: .18, blur: 14, dur: 46, delay: -23 },
    { left: 61, top: 9, w: 250, h: 24, o: .20, blur: 20, dur: 64, delay: -7 },
    { left: 74, top: 31, w: 190, h: 22, o: .15, blur: 17, dur: 52, delay: -31 },
    { left: 8, top: 45, w: 280, h: 28, o: .13, blur: 24, dur: 72, delay: -18 },
    { left: 46, top: 58, w: 230, h: 24, o: .11, blur: 22, dur: 60, delay: -42 },
    { left: 69, top: 70, w: 310, h: 28, o: .08, blur: 28, dur: 80, delay: -26 },
  ]

  const motes: ParticleSpec[] = []
  for (let i = 0; i < 22; i++) {
    motes.push({
      left: 4 + rnd() * 92,
      top: 8 + rnd() * 78,
      size: 1 + rnd() * 2.2,
      dur: 12 + rnd() * 14,
      delay: -rnd() * 20,
      dx: rnd() * 70 - 35,
      dy: -50 - rnd() * 90,
    })
  }

  const fireflies: ParticleSpec[] = []
  for (let i = 0; i < 16; i++) {
    fireflies.push({
      left: 4 + rnd() * 92,
      top: 38 + rnd() * 50,
      size: 2 + rnd() * 2.6,
      dur: 10 + rnd() * 12,
      delay: -rnd() * 18,
      dx: rnd() * 70 - 35,
      dy: -20 - rnd() * 55,
    })
  }

  return {
    stars,
    clouds,
    motes,
    fireflies,
    shooting: [
      { left: 12, top: 8, delay: -2 },
      { left: 38, top: 4, delay: -7.5 },
      { left: 64, top: 14, delay: -11 },
    ],
  }
}

const SCENE = buildScene()

function localTick(): DaycycleTickDetail {
  const d = new Date()
  const minute = d.getHours() * 60 + d.getMinutes()
  const cel = celestialAt(minute)
  return { minute, phase: '', isNight: cel.night, celX: cel.x, celY: cel.y, celAlt: cel.alt }
}

interface BackdropProps { focus: boolean }

const DaycycleBackdrop = memo(function DaycycleBackdrop({ focus }: BackdropProps) {
  const [tick, setTick] = useState<DaycycleTickDetail>(localTick)
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const prevMinute = useRef(tick.minute)

  useEffect(() => {
    const onTick = (e: Event): void => {
      const detail = (e as CustomEvent<DaycycleTickDetail>).detail
      if (detail) setTick(detail)
    }
    window.addEventListener(DAYCYCLE_TICK_EVENT, onTick)
    return () => window.removeEventListener(DAYCYCLE_TICK_EVENT, onTick)
  }, [])

  // 提交后再推进「上一分钟」：渲染阶段只读 ref，避免并发渲染下被中途改写
  useEffect(() => { prevMinute.current = tick.minute }, [tick.minute])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const isNight = tick.isNight
  const fx = isNight ? .9 : .5
  const rayO = isNight ? 0 : Math.max(0, 1 - tick.celAlt / .34) * .9
  const horizonO = isNight ? .1 : Math.max(0, 1 - tick.celAlt / .56) * .95
  const glowX = (0.08 + tick.celX * 0.78) * 100
  const arcY = 0.54 - 0.40 * tick.celAlt
  const xPx = size.w * (0.08 + tick.celX * 0.78)
  const yPx = size.h * arcY
  // 只有「分钟 tick」才挂 60s 过渡；窗口 resize 时位置应立即到位，不能慢慢漂一分钟
  const minuteChanged = prevMinute.current !== tick.minute

  const style = {
    '--dc-glow-x': `${glowX.toFixed(2)}%`,
    '--dc-glow-y': `${(arcY * 100).toFixed(2)}%`,
    '--dc-ray-o': rayO.toFixed(3),
    '--dc-horizon-o': horizonO.toFixed(3),
    '--dc-light-o': (isNight ? .46 : .55).toFixed(2),
    '--dc-mote-o': (!isNight ? fx : 0).toFixed(2),
    '--dc-firefly-o': (isNight ? fx : 0).toFixed(2),
    '--dc-shooting-o': isNight ? '1' : '0',
  } as CSSProperties

  return (
    <div
      ref={ref}
      className={`kb-dc-backdrop${focus ? ' is-focus' : ''}`}
      style={style}
      aria-hidden="true"
    >
      <div className="kb-dc-bd-horizon" />
      <div className="kb-dc-bd-milkyway" />
      <div className="kb-dc-bd-aurora">
        <span className="kb-dc-bd-aurora-band kb-dc-bd-aurora-a" />
        <span className="kb-dc-bd-aurora-band kb-dc-bd-aurora-b" />
        <span className="kb-dc-bd-aurora-band kb-dc-bd-aurora-c" />
      </div>

      <div className="kb-dc-bd-stars">
        {SCENE.stars.map((s, i) => (
          <span
            key={i}
            className={`kb-dc-bd-star${s.bright ? ' is-bright' : ''}`}
            style={{
              left: `${s.left.toFixed(2)}%`,
              top: `${s.top.toFixed(2)}%`,
              width: `${s.size.toFixed(2)}px`,
              height: `${s.size.toFixed(2)}px`,
              animationDuration: `${s.dur.toFixed(2)}s`,
              animationDelay: `${s.delay.toFixed(2)}s`,
            }}
          />
        ))}
      </div>

      <div className="kb-dc-bd-rays" />

      <div className="kb-dc-bd-clouds">
        {SCENE.clouds.map((c, i) => (
          <span
            key={i}
            className="kb-dc-bd-cloud"
            style={{
              left: `${c.left}%`,
              top: `${c.top}%`,
              width: `${c.w}px`,
              height: `${c.h}px`,
              opacity: c.o,
              filter: `blur(${c.blur}px)`,
              animationDuration: `${c.dur}s`,
              animationDelay: `${c.delay}s`,
            }}
          />
        ))}
      </div>

      {size.w > 0 && (
        <div
          className={`kb-dc-bd-celestial${minuteChanged && !tick.instant ? ' is-moving' : ''}`}
          style={{ transform: `translate3d(${xPx.toFixed(2)}px, ${yPx.toFixed(2)}px, 0)` }}
        >
          {isNight ? <div className="kb-dc-bd-moon" /> : <div className="kb-dc-bd-sun" />}
        </div>
      )}

      <div className="kb-dc-bd-motes">
        {SCENE.motes.map((m, i) => (
          <span
            key={i}
            className="kb-dc-bd-mote"
            style={{
              left: `${m.left.toFixed(2)}%`,
              top: `${m.top.toFixed(2)}%`,
              width: `${m.size.toFixed(2)}px`,
              height: `${m.size.toFixed(2)}px`,
              animationDuration: `${m.dur.toFixed(2)}s`,
              animationDelay: `${m.delay.toFixed(2)}s`,
              ['--dc-dx' as string]: `${m.dx.toFixed(1)}px`,
              ['--dc-dy' as string]: `${m.dy.toFixed(1)}px`,
            } as CSSProperties}
          />
        ))}
      </div>

      <div className="kb-dc-bd-fireflies">
        {SCENE.fireflies.map((f, i) => (
          <span
            key={i}
            className="kb-dc-bd-firefly"
            style={{
              left: `${f.left.toFixed(2)}%`,
              top: `${f.top.toFixed(2)}%`,
              width: `${f.size.toFixed(2)}px`,
              height: `${f.size.toFixed(2)}px`,
              animationDuration: `${f.dur.toFixed(2)}s`,
              animationDelay: `${f.delay.toFixed(2)}s`,
              ['--dc-dx' as string]: `${f.dx.toFixed(1)}px`,
              ['--dc-dy' as string]: `${f.dy.toFixed(1)}px`,
            } as CSSProperties}
          />
        ))}
      </div>

      <div className="kb-dc-bd-shooting">
        {SCENE.shooting.map((s, i) => (
          <span
            key={i}
            className="kb-dc-bd-shoot"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              animationDelay: `${s.delay}s`,
            }}
          />
        ))}
      </div>

      <div className="kb-dc-bd-light" />
      <div className="kb-dc-bd-vignette" />
    </div>
  )
})

/**
 * Host：负责「主题开关 + 专注模式判定」，把稳定的 boolean 交给 memo 后的场景，
 * 避免番茄钟每秒的剩余时间更新把 92 颗星一起重渲染。
 */
export function DaycycleBackdropHost({ zenLevel }: { zenLevel: number }) {
  const { s } = useSettings()
  const pom = usePomodoro()
  if (s.theme !== 'daycycle') return null
  const focus = s.daycycleFocusDim !== false && (zenLevel >= 1 || (pom.state.running && pom.state.phase === 'work'))
  return <DaycycleBackdrop focus={focus} />
}
