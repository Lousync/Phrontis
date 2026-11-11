/**
 * 昼夜动态主题 —— 运行时引擎（单例，方案 docs/daycycle-theme-plan.md）
 *
 * 职责：主题为 daycycle 时按本地时间**分钟对齐**驱动插值——
 * 每分钟把 daycycleAt() 算出的整套 CSS 变量写到 <html> 内联 style，并广播 tick 事件。
 * 没有 rAF 循环、没有 canvas；每分钟一次 35 支 setProperty + 一次纯函数计算。
 *
 * 硬约束：
 * - stop 必须按记录清单**精确清除**所写变量。内联 style 优先级高于一切 html.theme-* class
 *   规则，切走不清 = 后续所有主题被残留变量污染（表象：换深色主题还是纸感色）。
 * - 首次应用同步执行（applyNow 不进 rAF）：后台节流的标签页 rAF 不跑，首帧会空白
 *   （2026-11-07 原型实测教训）。
 * - visibilitychange 回前台立即对齐一次：后台分钟 timer 可能被节流合并，回来先追帧。
 */

import { daycycleAt } from './daycycleTheme'
import { applyCodeTone } from './themeTone'

export const DAYCYCLE_TICK_EVENT = 'kb-daycycle-tick'

export interface DaycycleTickDetail {
  minute: number
  phase: string
  isNight: boolean
  celX: number
  celY: number
  /** 天体高度 0..1（全窗背景纵向弧线用；顶栏仍用 celY） */
  celAlt: number
}

let running = false
let timer: number | null = null
let appliedKeys: string[] = []

function currentMinute(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function applyNow(): void {
  const snap = daycycleAt(currentMinute())
  const style = document.documentElement.style
  appliedKeys = Object.keys(snap.vars)
  for (const k of appliedKeys) style.setProperty(k, snap.vars[k])
  // 昼夜主题在 06:06 / 19:12 左右跨明暗极性；代码块色板必须跟着 --bg-primary 切亮/暗，
  // 不能停在 applyThemeClass 那一刻的静态兜底（正午浅色）。每分钟读一次 computed style，
  // 与 35 支 setProperty 同一量级，可接受。
  applyCodeTone(document.documentElement)
  window.dispatchEvent(new CustomEvent<DaycycleTickDetail>(DAYCYCLE_TICK_EVENT, {
    detail: { minute: snap.minute, phase: snap.phase, isNight: snap.isNight, celX: snap.celX, celY: snap.celY, celAlt: snap.celAlt },
  }))
}

function msToNextMinute(): number {
  return 60_000 - (Date.now() % 60_000) + 50
}

function arm(): void {
  timer = window.setTimeout(() => {
    applyNow()
    arm()
  }, msToNextMinute())
}

function onVisibilityChange(): void {
  if (running && document.visibilityState === 'visible') applyNow()
}

export function startDaycycleEngine(): void {
  if (running) return
  running = true
  applyNow()
  arm()
  document.addEventListener('visibilitychange', onVisibilityChange)
}

export function stopDaycycleEngine(): void {
  if (!running) return
  running = false
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  const style = document.documentElement.style
  for (const k of appliedKeys) style.removeProperty(k)
  appliedKeys = []
  // 切走时重算一次：如果新主题的 applyThemeClass 先跑（或后跑），这里都把 tone 拉回
  // 当前主题类的实际 --bg-primary，避免残留 daycycle 日间/夜间的代码色板。
  applyCodeTone(document.documentElement)
}
