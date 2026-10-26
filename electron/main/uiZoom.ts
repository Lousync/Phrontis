import { BrowserWindow, screen } from 'electron'
import { SETTINGS } from '../../src/lib/settings'

/**
 * 界面缩放（v3.13.2）—— Chromium 页面缩放 + 最大化自动放大
 *
 * 为什么从「根字号」换成页面缩放：旧实现是 `documentElement.style.fontSize = zoom × 16px`，
 * 只影响 rem。全仓字号有 2700+ 处 `text-[Npx]` 绝对像素，**一个都不会变**，于是用户把缩放
 * 从 100% 调到 120% 看到的只是留白变大、字没变 —— 表象就是「最大化后字太小、画面很空」。
 * 页面缩放对绝对 px 同样生效：文字、控件、间距、图标、iframe 内容一起等比放大，
 * 而且以后新写的 `text-[12px]` 也自动跟着走，不需要每个组件记得用 rem。
 *
 * ★ 为什么还要「最大化自动放大」（2026-10-26 用户实测反馈）：
 *   窗口态与最大化态的逻辑宽度差 1.5 倍（1280 vs 1920 DIP）。同一个缩放系数在窗口态会显得
 *   过大（视口被压到 985 CSS px）、最大化又刚好 —— 单一系数不可能同时满足两态。
 *   用户实测舒服的两个点：窗口态 ~100%、最大化 ~130%。因此基础档存 100%，
 *   窗口「最大化 / 全屏」时再乘 1.3（设置里可关）。窗口态与最大化态各自回到舒服的比例。
 *
 * 两条实测约束（Electron 33，2026-10-26）：
 *  ① `setZoomFactor` 必须在 `dom-ready` 之后应用。窗口创建到导航完成之间设值会被本次导航覆盖，
 *     且不是原值（实测 1.5 掉成 1.25）；文档就绪后设值精确、且早于 React 挂载，不会闪一下。
 *  ② 页面缩放会把 `window.innerWidth` 按比例缩小 —— 布局看到的是更窄的视口（这正是要的效果），
 *     但**原生最小尺寸是 DIP**，必须按 zoom 折算，否则 150% 时 900 DIP 只剩 600 CSS px，三栏会挤坏。
 */

export const UI_ZOOM_MIN = 0.85
export const UI_ZOOM_MAX = 2.0
export const UI_ZOOM_DEFAULT = SETTINGS.zoom.default as number
/** 最大化 / 全屏时在基础档上再乘的倍数（用户实测：窗口 100% + 最大化 130% 两态都舒服） */
export const MAXIMIZED_ZOOM_BOOST = 1.3

/** 窗口态的基础档（用户在设置里调的就是它） */
let base = UI_ZOOM_DEFAULT
/** 由主进程注册：某个窗口当前是否处于「最大化 / 全屏」（决定是否乘放大倍数） */
let boostResolver: (win: BrowserWindow) => boolean = () => false

/** 窗口的设计最小尺寸（CSS px）；实际生效值 = 设计值 × 当前有效缩放 */
const minSizeBases = new WeakMap<BrowserWindow, { width: number; height: number }>()

export function normalizeUiZoom(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return UI_ZOOM_DEFAULT
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, Math.round(n * 100) / 100))
}

/**
 * 注册「是否乘最大化倍数」的判定。主进程在启动时一次性注入 ——
 * 判定要用到 isWinMaximized / isFullScreen / 设置开关，这些都不属于本模块。
 */
export function setUiZoomBoostResolver(fn: (win: BrowserWindow) => boolean): void {
  boostResolver = fn
}

/** 基础档（设置里的值）；CSS ↔ DIP 换算请优先用 getEffectiveUiZoom */
export function getUiZoom(): number {
  return base
}

/** 该窗口当前实际生效的缩放（基础档 × 最大化倍数），已 clamp */
export function getEffectiveUiZoom(win: BrowserWindow | null | undefined): number {
  const boosted = win && !win.isDestroyed() && boostResolver(win) ? MAXIMIZED_ZOOM_BOOST : 1
  return normalizeUiZoom(base * boosted)
}

/** 登记窗口的设计最小尺寸，并按当前有效缩放设置最小尺寸（不在此处设 zoomFactor —— 加载前设值会被导航覆盖） */
export function registerUiMinSize(win: BrowserWindow, width: number, height: number): void {
  minSizeBases.set(win, { width, height })
  try {
    const f = getEffectiveUiZoom(win)
    const wa = screen.getDisplayMatching(win.getBounds()).workArea
    win.setMinimumSize(
      Math.min(Math.round(width * f), wa.width),
      Math.min(Math.round(height * f), wa.height),
    )
  } catch { /* 窗口销毁竞态 */ }
}

export function applyUiZoomTo(win: BrowserWindow | null | undefined, factor?: number): void {
  if (!win || win.isDestroyed()) return
  const f = normalizeUiZoom(factor ?? getEffectiveUiZoom(win))
  try {
    win.webContents.setZoomFactor(f)
    const baseSize = minSizeBases.get(win)
    if (baseSize) {
      // 折算后再夹到工作区：130% 时 900×600 → 1170×780，在 1366×768 这类小屏上比屏幕还高，
      // 原生最小尺寸一旦超过工作区，窗口就再也缩不回来（用户看到的是「窗口卡住、下缘被截掉」）。
      const wa = screen.getDisplayMatching(win.getBounds()).workArea
      win.setMinimumSize(
        Math.min(Math.round(baseSize.width * f), wa.width),
        Math.min(Math.round(baseSize.height * f), wa.height),
      )
    }
  } catch {
    // 窗口正在销毁 / webContents 已释放：缩放失败不该影响其余窗口
  }
}

export function applyUiZoomToAll(): void {
  for (const w of BrowserWindow.getAllWindows()) applyUiZoomTo(w)
}

/** 设置基础档（clamp 后）并立刻应用到所有窗口；返回实际生效的基础值 */
export function setUiZoom(v: unknown): number {
  base = normalizeUiZoom(v)
  applyUiZoomToAll()
  return base
}
