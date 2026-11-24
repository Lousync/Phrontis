/**
 * 右下角 Toast 的「右侧避让」登记表（2026-11-24）。
 *
 * 为什么需要：网页页签的内容是主进程 `WebContentsView`，**永远盖在 DOM 之上**
 * （不是 z-index 能解决的层级）。Toast 是 `position: fixed; right: 1rem`，
 * 只要右侧有原生视图或侧栏，它就会整块被吃掉 —— 用户看不到任何提示。
 * 普通面板（笔记 / 书架 / 日程右栏）本来就在 DOM 里，Toast 天然压在上面；
 * 只有「原生视图」这一档必须把 Toast 让开。
 *
 * 为什么是登记表而不是直接写 CSS 变量：可能同时有多个占用者（日程右栏 + 网页页签），
 * 各自挂载 / 卸载 / 被模块 Tab 隐藏。谁最后写谁赢会互相踩；这里按 key 登记、
 * 取最大值、**不是最大值就撤销**，任何一方离开都不会留下一个凭空偏左的 Toast。
 *
 * 值 = 需要让出的右侧像素宽度（CSS px，含气泡与边缘之间的呼吸位由使用方自己算）。
 */
const claims = new Map<string, number>()

/** 上一次真正写进 DOM 的值：避免每帧都 setProperty（拖宽 / 跟随循环里会高频调用） */
let applied = ''

function flush(): void {
  if (typeof document === 'undefined') return
  let max = 0
  for (const px of claims.values()) {
    if (px > max) max = px
  }
  const next = max > 0 ? `${Math.round(max)}px` : ''
  if (next === applied) return
  applied = next
  const root = document.documentElement
  if (next) root.style.setProperty('--kb-toast-right', next)
  else root.style.removeProperty('--kb-toast-right')
}

/**
 * 登记 / 撤销一处右侧避让。
 * @param key 占用者身份（同一占用者反复调用只覆盖自己的值）
 * @param px  需要让出的宽度；`null` / `0` / 非法值 = 撤销
 */
export function claimToastRight(key: string, px: number | null | undefined): void {
  if (typeof px === 'number' && Number.isFinite(px) && px > 0) claims.set(key, px)
  else claims.delete(key)
  flush()
}
