/**
 * 主窗口全屏弹窗遮罩 → dock 小窗压暗同步（2026-09-28）
 *
 * 背景：dock（工具箱/番茄钟停靠窗）是**独立 OS 窗口**，主窗口页内的 bg-black/50
 * 遮罩照不到它 —— 表象是「弹窗打开时主窗全灰、dock 依旧亮白」（用户 2026-09-28 报）。
 *
 * 机制：MutationObserver 监听 body 子树，凡出现**视口级 fixed 全屏遮罩**
 * （.kb-overlay / .kb-overlay-out —— 全仓 30+ 弹层共用的令牌类）即经
 * `main:modal-dim` → 主进程 broadcast(`main:modal-dim-broadcast`) → dock 端
 * onMainModalDim 自绘压暗层。只在开合翻转时发一次 IPC，稳态零流量。
 *
 * 注意：模块内 absolute 遮罩（说说/错题本等只盖自己面板的）不算 —— 用
 * position:fixed + 视口覆盖率 ≥90% 两道判据排除。
 */

let started = false

/** 覆盖率阈值：fixed 遮罩宽高占视口 ≥90% 才认定为「整窗压暗态」 */
const COVER_RATIO = 0.9
/** 变更防抖：MutationObserver 批次后统一结算一次 */
const SETTLE_MS = 40

export function initModalDimSync(): void {
  if (started) return
  started = true

  let last: boolean | null = null
  let timer: number | null = null

  const compute = (): boolean => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    for (const el of document.querySelectorAll<HTMLElement>('.kb-overlay, .kb-overlay-out')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (cs.position !== 'fixed') continue
      const r = el.getBoundingClientRect()
      if (r.width >= vw * COVER_RATIO && r.height >= vh * COVER_RATIO) return true
    }
    return false
  }

  const flush = (): void => {
    timer = null
    const dim = compute()
    if (dim === last) return
    last = dim
    try { window.api?.mainModalDimNotify?.(dim) } catch { /* api 未就绪（理论不可达，App 挂载后才 init） */ }
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = window.setTimeout(flush, SETTLE_MS)
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
}
