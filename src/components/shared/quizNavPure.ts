/**
 * 题卡「答对自动跳下一题」的目标选择（纯函数，契约脚本可直测）。
 *
 * 为什么必须带 scope：AI 教学等界面会把同一份题单同时渲染在**左聊天栏**与**右教材/工件栏**，
 * 两栏各自是独立滚动容器。若全局找「视口里下一张题卡」，会把另一栏的题当成下一题并
 * 把那一栏滚走（2026-11-10 用户反馈：左侧答题，右侧教材自动翻到下一题）。
 *
 * 口径：只在同一个 scope（同一滚动容器）里，取当前卡片之后最近的一张。
 */

export interface QuizCardSpot {
  /** 视口纵坐标（getBoundingClientRect().top） */
  top: number
  /** 所在滚动容器标识：不同栏 / 不同滚动区必须是不同值 */
  scope: string
}

/**
 * @param cards 当前窗口内所有题卡的位置（含自己）
 * @param myIndex 自己在 cards 里的下标
 * @param slack 容差 px（当前卡上方 slack 内的卡片不算「下一题」）
 * @returns 下一张同 scope 题卡的下标；没有返回 -1
 */
export function pickNextQuizCardIndex(
  cards: ReadonlyArray<QuizCardSpot>,
  myIndex: number,
  slack = 4,
): number {
  const me = cards[myIndex]
  if (!me) return -1
  let best = -1
  let bestTop = Number.POSITIVE_INFINITY
  for (let i = 0; i < cards.length; i++) {
    if (i === myIndex) continue
    const c = cards[i]
    if (c.scope !== me.scope) continue // 另一栏的题卡不参与，绝不跨栏滚动
    if (c.top <= me.top - slack) continue
    if (c.top < bestTop) {
      best = i
      bestTop = c.top
    }
  }
  return best
}
