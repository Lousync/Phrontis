import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { AiActivity } from '../../../lib/aiActivity'
import type { PluginMascotInfo } from '../../../types'

/**
 * 插件吉祥物播放器（.claude/plans/ai-composer-mascot.md §4.2）——宿主播放，插件只供素材。
 *
 * 动画表契约：**一个动画 = 一张 PNG 网格**，**每行固定 8 帧**（不足 8 帧也占 8 格），
 * 每帧格尺寸 = `box[2] × box[3]`（逻辑格）；宿主按 `grid.cell` 像素/格放大、逐帧平移（`frameMs`）。
 *
 * 演出逻辑（对齐 dsh-claude-style）：
 * - **状态**：`states[activity]`；`working` 若声明 `workingTiers` 则按并发忙数（1/2/≥3）分档。
 * - **空闲小节目**：空闲时每 16~28s 随机演一次 `idleExtras`（东张西望 / 挥手 / 掏电脑敲代码）。
 * - **入睡/惊醒**：空闲满 `sleepAfterMs`（缺省 60s）演 `sleeping`；有活动时先演 `waking` 再进状态。
 * - **点击反应**：点左半 / 右半播 `tapLeft`/`tapRight`，1.4s 内连点 ≥4 次播 `tapFlail`。
 * - `prefers-reduced-motion` 停在静止帧。`ink` 为可选墨色遮罩，以主题三级文字色填充。
 */

const COLS = 8 // 每行帧数（契约固定）
const SKIT_MIN_MS = 16000
const SKIT_SPAN_MS = 12000

function prefersReduce(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 基础动画：工作档位优先，其余按 states 映射（回落 idle / 第一张） */
function resolveBase(mascot: PluginMascotInfo, activity: AiActivity, busy: number): string | null {
  if (activity === 'working' && mascot.workingTiers && mascot.workingTiers.length) {
    const i = Math.min(Math.max(1, Math.round(busy)), mascot.workingTiers.length) - 1
    const a = mascot.workingTiers[i]
    if (a && mascot.sheets[a]) return a
  }
  const want = mascot.states[activity] ?? activity
  if (mascot.sheets[want]) return want
  const idle = mascot.states.idle ?? 'idle'
  if (mascot.sheets[idle]) return idle
  return Object.keys(mascot.sheets)[0] ?? null
}

export const MascotPlayer = memo(function MascotPlayer({ mascot, activity, busy = 1 }: { mascot: PluginMascotInfo; activity: AiActivity; busy?: number }) {
  const cell = Math.max(1, mascot.grid.cell)
  const hasTap = !!(mascot.tapLeft || mascot.tapRight || mascot.tapFlail)
  const [override, setOverride] = useState<string | null>(null)
  const [sleeping, setSleeping] = useState(false)
  const overrideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sleepingRef = useRef(false)
  const wasSleepingRef = useRef(false)
  const clicksRef = useRef({ n: 0, t: 0 })

  const framesOf = useCallback((name: string): number => mascot.sheets[name]?.frames ?? 1, [mascot])

  /** 播一次性动画（点击反应 / 惊醒），时限 = 帧数 × frameMs，到点回常态 */
  const playOnce = useCallback((name: string | null | undefined): void => {
    if (!name || !mascot.sheets[name]) return
    setOverride(name)
    if (overrideTimer.current) clearTimeout(overrideTimer.current)
    overrideTimer.current = setTimeout(() => setOverride(null), framesOf(name) * mascot.frameMs)
  }, [mascot, framesOf])

  const baseAnim = useMemo(() => resolveBase(mascot, activity, busy), [mascot, activity, busy])
  const sleepAnim = mascot.sheets.sleeping ? 'sleeping' : null
  const wakeAnim = mascot.sheets.waking ? 'waking' : null

  // 空闲生命周期：随机小节目 + 久闲入睡；离开空闲先惊醒（若在睡）
  useEffect(() => {
    if (activity !== 'idle') {
      if (wasSleepingRef.current) {
        wasSleepingRef.current = false; sleepingRef.current = false; setSleeping(false)
        playOnce(wakeAnim)
      } else {
        sleepingRef.current = false; setSleeping(false)
      }
      setOverride(null)
      return
    }
    let skit: ReturnType<typeof setTimeout> | null = null
    const loop = (): void => {
      skit = setTimeout(() => {
        if (!sleepingRef.current) {
          const extras = mascot.idleExtras.filter(e => mascot.sheets[e])
          if (extras.length) playOnce(extras[Math.floor(Math.random() * extras.length)])
        }
        loop()
      }, SKIT_MIN_MS + Math.random() * SKIT_SPAN_MS)
    }
    loop()
    const sleep = setTimeout(() => {
      if (sleepAnim) { sleepingRef.current = true; wasSleepingRef.current = true; setSleeping(true) }
    }, mascot.sleepAfterMs ?? 60000)
    return () => { if (skit) clearTimeout(skit); clearTimeout(sleep) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, mascot])

  useEffect(() => () => { if (overrideTimer.current) clearTimeout(overrideTimer.current) }, [])

  const animName = override ?? (sleeping && activity === 'idle' && sleepAnim ? sleepAnim : baseAnim)
  const sheet = animName ? mascot.sheets[animName] : null
  const frames = Math.max(1, sheet?.frames ?? 1)
  const box = sheet?.box ?? [0, 0, 1, 1]
  const fw = Math.max(1, box[2]) * cell
  const fh = Math.max(1, box[3]) * cell
  const rows = Math.ceil(frames / COLS)
  const still = Math.min(Math.max(0, sheet?.still ?? 0), frames - 1)
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = stripRef.current
    if (!el || !sheet) return
    const place = (i: number): void => {
      const x = (i % COLS) * fw
      const y = Math.floor(i / COLS) * fh
      el.style.transform = `translate(${-x}px, ${-y}px)`
    }
    if (prefersReduce() || frames <= 1) { place(still); return }
    let i = 0
    place(0)
    const timer = setInterval(() => { i = (i + 1) % frames; place(i) }, Math.max(20, mascot.frameMs))
    return () => clearInterval(timer)
  }, [animName, fw, fh, frames, still, mascot.frameMs, sheet])

  const onTap = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const onRight = e.clientX - rect.left > rect.width / 2
    const now = Date.now()
    const c = clicksRef.current
    if (now - c.t > 1400) c.n = 1; else c.n += 1
    c.t = now
    const flail = c.n >= 4 && !!mascot.tapFlail && !!mascot.sheets[mascot.tapFlail]
    const name = flail
      ? mascot.tapFlail!
      : (onRight ? (mascot.tapRight ?? mascot.tapLeft) : (mascot.tapLeft ?? mascot.tapRight))
    if (!name || !mascot.sheets[name]) return
    if (flail) c.n = 0
    if (wasSleepingRef.current) { wasSleepingRef.current = false; sleepingRef.current = false; setSleeping(false) }
    playOnce(name)
  }

  if (!sheet) return null
  return (
    <div
      className="kb-mascot"
      role={hasTap ? 'button' : undefined}
      aria-label={hasTap ? `${mascot.name}（点一下）` : undefined}
      onPointerDown={hasTap ? onTap : undefined}
      style={{ width: fw, height: fh, overflow: 'hidden', pointerEvents: hasTap ? 'auto' : 'none', cursor: hasTap ? 'pointer' : 'default' }}
    >
      <div ref={stripRef} style={{ position: 'relative', width: COLS * fw, height: rows * fh, willChange: 'transform' }}>
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: `url("${sheet.body}")`, backgroundRepeat: 'no-repeat', backgroundSize: '100% 100%',
          imageRendering: 'pixelated',
        }} />
        {sheet.ink && (
          <div style={{
            position: 'absolute', inset: 0, background: 'var(--text-muted)',
            WebkitMaskImage: `url("${sheet.ink}")`, maskImage: `url("${sheet.ink}")`,
            WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
            WebkitMaskSize: '100% 100%', maskSize: '100% 100%',
            imageRendering: 'pixelated',
          }} />
        )}
      </div>
    </div>
  )
})
